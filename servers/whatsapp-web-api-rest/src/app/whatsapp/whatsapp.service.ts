import * as fs from 'node:fs';
import * as path from 'node:path';
import NodeCache from '@cacheable/node-cache';
import { Boom } from '@hapi/boom';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { delay, is, to } from '@src/tools';
import makeWASocket, { Browsers, CacheStore, Chat, ConnectionState, Contact, DisconnectReason, downloadMediaMessage, fetchLatestBaileysVersion, isJidBroadcast, isJidNewsletter, isJidStatusBroadcast, makeCacheableSignalKeyStore, useMultiFileAuthState, WACallEvent, WAMessageKey, WAPresence } from 'baileys';
import P from 'pino';
import { WebhookService } from '../webhook/webhook.service';
import { IMessage, IReadMessages } from './whatsapp.interface';
const qrcode = require('qrcode-terminal');

declare global {
  interface Window {
    WWebJS?: any;
  }
}

// File path for storing chats and contacts in JSON format

/**
 * Starting service for interacting with the WhatsApp Web API
 * Read @whiskeysockets
 * https://baileys.whiskeysockets.io/functions/makeWASocket.html
 */

@Injectable()
export class WhatsappService implements OnModuleInit, OnModuleDestroy {
  private client: any = null;
  private isConnected = false;
  private readonly filePath: string = path.join(__dirname, '..', 'whatsapp_data.json');
  private readonly credentialsFolderName = 'auth_info';
  private readonly maxWebhookMessageAgeMs = 60_000;
  private readonly logger = new Logger('Whatsapp');
  private messageQueue: Promise<void> = Promise.resolve();
  private readonly authorizedWhatsAppIds: Set<string>;

  constructor(
    private eventEmitter: EventEmitter2,
    private webhook: WebhookService,
  ) {
    this.authorizedWhatsAppIds = this.parseAuthorizedWhatsAppIds(process.env.AUTHORIZED_WHATSAPP_IDS || '');
  }

  async onModuleInit(): Promise<void> {
    if (!this.hasSavedSession()) return;

    this.logger.debug('Saved WhatsApp session found, starting automatically...');
    try {
      await this.start();
    } catch (e) {
      this.logger.error('Failed to auto start saved WhatsApp session', e);
    }

    if (this.autoRecoverEnabled && !this.autoRecoverTimer) {
      const intervalMs = this.autoRecoverIntervalMs;
      this.logger.log(`Auto-recover enabled interval=${intervalMs}ms`);
      this.autoRecoverTimer = setInterval(() => {
        void this.ensureConnected();
      }, intervalMs);
    }

    if (this.forcedRefreshEnabled && !this.refreshTimer) {
      this.logger.log(`Forced refresh enabled interval=${this.forcedRefreshIntervalMs}ms`);
      this.refreshTimer = setInterval(() => {
        void this.forceRefreshConnection();
      }, this.forcedRefreshIntervalMs);
    } else if (!this.forcedRefreshEnabled) {
      this.logger.log('Forced refresh disabled');
    }
  }

  onModuleDestroy(): void {
    if (this.autoRecoverTimer) {
      clearInterval(this.autoRecoverTimer);
      this.autoRecoverTimer = null;
    }
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  /**
   * Create connection to WA
   */
  private reconnectCount = 0;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private readonly reconnectBackoffMs = [1000, 2000, 2500, 3000, 4000];
  private maxConnectionAttemps = this.reconnectBackoffMs.length;
  private pino = P({ level: 'fatal' });
  private startPromise: Promise<void> | null = null;
  private suppressReconnect = false;
  private autoRecoverTimer: NodeJS.Timeout | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private refreshInProgress = false;
  private readonly clientIdPrefix = `wa-${Date.now().toString(36)}`;
  private clientCounter = 0;
  private currentClientId: string | null = null;
  private readonly autoRecoverEnabled = to.boolean(process.env.WHATSAPP_AUTO_RECOVER);
  private readonly autoRecoverIntervalMs = Math.max(5000, to.number(process.env.WHATSAPP_AUTO_RECOVER_INTERVAL_MS, 30000));
  private readonly forcedRefreshEnabled = process.env.WHATSAPP_FORCE_REFRESH_ENABLED === undefined ? true : to.boolean(process.env.WHATSAPP_FORCE_REFRESH_ENABLED);
  private readonly forcedRefreshIntervalMs = Math.max(60_000, to.number(process.env.WHATSAPP_FORCE_REFRESH_INTERVAL_MS, 10 * 60 * 1000));

  async start(): Promise<void> {
    if (this.refreshInProgress) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = (async () => {
      this.logger.debug('Start');
      this.logger.log(`Startup info connected=${this.isConnected} hasClient=${Boolean(this.client)} markOnlineOnConnect=true`);

      // Check if the client is already connected
      if (this.isConnected && this.client) {
        const text = 'WhatsApp is already connected!';
        this.logger.debug(text);
        await delay(1500);
        this.eventEmitter.emit('start.event', { qr: '', text });
        return;
      }

      // If we have a client but it isn't connected, close it before creating a new one.
      if (this.client && !this.isConnected) {
        await this.safeCloseClient('restart');
      }

      const { state, saveCreds } = await useMultiFileAuthState(this.credentialsFolderName);
      const { version } = await fetchLatestBaileysVersion();
      this.logger.log(`Using Baileys WA version ${version.join('.')}`);
      const msgRetryCounterCache = new NodeCache() as CacheStore;

      const clientId = `${this.clientIdPrefix}-${++this.clientCounter}`;
      const client = makeWASocket({
        version,
        logger: this.pino,
        auth: {
          creds: state.creds,
          /** caching makes the store faster to send/recv messages */
          keys: makeCacheableSignalKeyStore(state.keys, this.pino),
        },
        msgRetryCounterCache,
        generateHighQualityLinkPreview: true,
        // ignore all broadcast messages -- to receive the same
        // comment the line below out
        shouldIgnoreJid: (jid) => isJidBroadcast(jid),
        // implement to handle retries & poll updates
        // getMessage
        browser: Browsers.macOS('Desktop'),
        syncFullHistory: false,
        // Keep the session online so presence updates like "composing" are delivered.
        markOnlineOnConnect: true,
        printQRInTerminal: false,
        retryRequestDelayMs: 350,
        maxMsgRetryCount: 4,
        connectTimeoutMs: 20_000,
        keepAliveIntervalMs: 30_000,
      });

      this.currentClientId = clientId;
      this.client = client;
      this.client.ev.on('creds.update', saveCreds);
      this.client.ev.on('connection.update', (state: ConnectionState) => this.onConnectionUpdate(state, clientId));
      this.client.ev.on('messages.upsert', this.onMessageUpsert);
      this.client.ev.on('call', this.onCall);
      this.client.ev.on('messaging-history.set', this.onMessagingHistory);
    })();

    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  /**
   * Connection state has been updated -- WS closed, opened, connecting etc.
   */
  private onConnectionUpdate = async (connectionState: ConnectionState, clientId?: string) => {
    const { connection, lastDisconnect, qr } = connectionState;
    let text = '';

    // Ignore events from stale clients.
    if (clientId && this.currentClientId && clientId !== this.currentClientId) {
      return;
    }

    if (is.string(qr) && qr !== '') {
      qrcode.generate(qr, { small: true });
      this.eventEmitter.emit('start.event', { qr, text: '' });
    }

    // Handle connection close and reconnection logic
    if (connection === 'close') {
      const error = lastDisconnect?.error as Boom;
      const statusCode = error?.output?.statusCode;
      const message = error?.output?.payload?.message || error?.message;
      text = message;

      if (this.suppressReconnect) {
        this.isConnected = false;
        return;
      }

      const shouldReconnect = statusCode !== DisconnectReason.loggedOut && message !== 'QR refs attempts ended' && this.reconnectCount < this.maxConnectionAttemps;

      if (shouldReconnect) {
        ++this.reconnectCount;
        const delay = this.reconnectBackoffMs[this.reconnectCount - 1] ?? this.reconnectBackoffMs[this.reconnectBackoffMs.length - 1];

        text = `Reconnecting in ${delay}ms (attempt ${this.reconnectCount})`;

        this.reconnectTimeout = setTimeout(async () => {
          await this.start();
        }, delay);
        return;
      }

      // Reset on permanent failure
      this.reconnectCount = 0;
      this.isConnected = false;
    } else if (connection === 'open') {
      text = 'Connected to WhatsApp!';
      this.reconnectCount = 0;
      this.isConnected = true;
      if (this.reconnectTimeout) {
        clearTimeout(this.reconnectTimeout);
        this.reconnectTimeout = null;
      }
    }

    if (text !== '') {
      this.eventEmitter.emit('start.event', { qr: '', text });
      this.logger.debug(text);
    }
  };

  private async forceRefreshConnection(): Promise<void> {
    if (!this.client) return;
    if (this.refreshInProgress) return;

    try {
      this.refreshInProgress = true;
      this.suppressReconnect = true;
      if (this.reconnectTimeout) {
        clearTimeout(this.reconnectTimeout);
        this.reconnectTimeout = null;
      }
      this.logger.log('Forcing WhatsApp reconnect');
      await this.safeCloseClient('force-refresh');
    } catch (e) {
      this.logger.debug(`Force refresh close failed: ${to.string((e as any)?.message || e)}`);
    } finally {
      this.isConnected = false;
      this.reconnectCount = 0;
      await delay(1000);
      try {
        await this.start();
      } catch (e) {
        this.logger.error('Force refresh failed to restart WhatsApp', e);
      } finally {
        this.suppressReconnect = false;
        this.refreshInProgress = false;
      }
    }
  }

  // Listen for incoming historical chats and contacts
  private onMessagingHistory = (data: any) => {
    //this.logger.debug('Historical chats and contacts synced');

    const existingData = this.readDataFromFile();

    // Merge new chats and contacts with existing data
    const newChats = data.chats || [];
    const newContacts = data.contacts || [];

    // Append new chats and contacts to existing ones
    const updatedChats = [...existingData.chats, ...newChats];
    const updatedContacts = [...existingData.contacts, ...newContacts];

    // Save updated chats and contacts to the file
    this.saveDataToFile(updatedChats, updatedContacts);
    //this.logger.debug('Chats and contacts saved to whatsapp_data.json');
  };

  /**
   * add/update the given messages. If they were received while the connection was online,
   * the update will have type: "notify"
   */
  private onMessageUpsert = async (waMessage: any) => {
    const messages = waMessage?.messages;
    if (is.array(messages)) {
      this.messageQueue = this.messageQueue
        .then(async () => {
          const webhooks: any = this.webhook.get();
          if (is.array(webhooks)) {
            for (const item of messages) {
              if (item?.message) {
                //this.logger.log(item)
                const from = to.string(item?.key?.remoteJid);
                if (isJidStatusBroadcast(from) || isJidNewsletter(from) || isJidBroadcast(from)) return;
                const isMe = to.boolean(item?.key?.fromMe);
                if (isMe) continue;
                if (!this.isAuthorizedMessage(item)) continue;
                if (this.isMessageOlderThanMaxAge(item)) {
                  const messageId = to.string(item?.key?.id);
                  this.logger.debug(`Skipping stale message id=${messageId}`);
                  continue;
                }

                // Text
                let type = 'text';
                let message = to.string(item?.message?.conversation);
                if (message === '') message = to.string(item?.message?.extendedTextMessage?.text);

                // Media
                const mimeType = this.getMediaMimeType(item);
                const media = { mimeType, caption: '', base64: '' };
                if (mimeType !== '') {
                  type = this.getMediaType(item);
                  const mediaBuffer = await downloadMediaMessage(item, 'buffer', {});
                  media.caption = this.getMediaCaption(item);
                  media.base64 = mediaBuffer.toString('base64');
                }
                if (type !== 'text' && type !== 'audio') {
                  this.logger.debug(`Skipping unsupported inbound type=${type}`);
                  continue;
                }

                // Webhook
                const replyId = this.getReplyId(item);
                const webhookPayload: Record<string, any> =
                  type === 'audio'
                    ? {
                        from,
                        type: 'audio',
                        media: {
                          base64: media.base64,
                          mimeType: media.mimeType,
                          caption: media.caption,
                        },
                      }
                    : {
                        from,
                        message,
                      };
                if (replyId !== '') webhookPayload.replyId = replyId;
                const normalizedJid = this.normalizeJid(from);
                const webhookStart = Date.now();
                try {
                  await this.client.sendPresenceUpdate('composing', normalizedJid);
                  const responses = await this.webhook.sendWithResponse(webhooks, webhookPayload);
                  try {
                    await this.client.readMessages([
                      {
                        remoteJid: to.string(item?.key?.remoteJid),
                        id: to.string(item?.key?.id),
                        fromMe: false,
                        participant: to.undefined(item?.key?.participant),
                      },
                    ]);
                  } catch (readError) {
                    this.logger.debug(readError);
                  }
                  let replyMsg = '';
                  for (const response of responses) {
                    const candidate = to.string(response?.response?.msg);
                    if (candidate !== '') {
                      replyMsg = candidate;
                      break;
                    }
                  }

                  const elapsed = Date.now() - webhookStart;
                  if (elapsed < 1000) await delay(1000 - elapsed);
                  await this.client.sendPresenceUpdate('paused', normalizedJid);
                  await delay(250);

                  if (replyMsg !== '') {
                    await this.sendMessage({ chatId: from, text: replyMsg, options: {} });
                  }
                } catch (e) {
                  this.logger.debug(e);
                }
              }
            }
          }
        })
        .catch((e) => {
          this.logger.debug(e);
        });
    }
  };

  /**
   * Receive an update on a call, including when the call was received, rejected, accepted
   **/
  private onCall = async (call: WACallEvent) => {
    try {
      await this.client.rejectCall(call?.id, call?.from);
    } catch (_e) {}
    const list: any = this.webhook.get();
    if (is.array(list)) this.webhook.send(list, { call });
  };

  /**
   * Send a message to a specific chatId
   */
  async sendMessage(payload: IMessage): Promise<any | object> {
    try {
      const chatId = to.string(payload?.chatId);
      const { text, options, media, location, poll, contact } = payload;
      let content: any = { text };

      if (is.object(media)) {
        const typeFile = to.string(media?.type);
        const base64 = to.string(media?.data);
        if (typeFile !== '' && base64 !== '') {
          const buffer = Buffer.from(to.string(media?.data), 'base64');
          content = {
            [typeFile]: buffer,
            caption: to.undefined(media?.caption),
            mimetype: to.undefined(media?.mimetype),
            fileName: to.undefined(media?.filename),
            ptt: to.undefined(media?.ptt),
            gifPlayback: to.undefined(media?.gifPlayback),
          };
        }
      } else if (is.object(location)) {
        content = {
          location: {
            ...location,
            name: location?.name,
            url: location?.url,
            address: location?.address,
            degreesLatitude: location?.latitude,
            degreesLongitude: location?.longitude,
          },
        };
      } else if (is.object(poll)) {
        content = {
          poll: {
            name: poll?.name,
            values: poll.options,
            selectableCount: is.undefined(poll?.allowMultipleAnswers) ? 0 : poll?.allowMultipleAnswers,
          },
        };
      } else if (is.object(contact)) {
        const firstname = to.string(contact?.firstname);
        const lastname = to.string(contact?.lastname);
        const email = to.string(contact?.email);
        const phone = to.string(contact?.phone).replace(/ /g, '').replace(/\+/g, '');

        const displayName = `${firstname} ${lastname}`;

        const vcard =
          'BEGIN:VCARD\n' +
          'VERSION:3.0\n' +
          //`N:;${lastname};${firstname};;;\n` +
          `FN:${displayName}\n` +
          `EMAIL;TYPE=Work:${email}\n` +
          `TEL;type=CELL;type=VOICE;waid=${phone}:${phone}\n` +
          'END:VCARD';

        content = {
          contacts: {
            displayName,
            contacts: [{ vcard }],
          },
        };
      }

      if (chatId !== '' && is.object(content)) return this.client.sendMessage(chatId, content, options);
    } catch (e) {
      this.logger.debug(e);
    }
    return {};
  }

  /**
   * Simulate  'unavailable' | 'available' | 'composing' | 'recording' | 'paused';
   */
  async sendSimulate(chatId: string, action: WAPresence): Promise<{ chatId: string }> {
    try {
      const allowedActions: WAPresence[] = ['unavailable', 'available', 'composing', 'recording', 'paused'];
      if (!allowedActions.includes(action)) {
        this.logger.error(`presence.simulate.invalid-action chatId=${chatId} action=${to.string(action)}`);
        return { chatId };
      }

      const normalizedJid = this.normalizeJid(chatId);
      // Some clients only render typing/recording if we are marked available first.
      await this.client.sendPresenceUpdate('available', normalizedJid);
      await this.client.presenceSubscribe(normalizedJid);
      await this.client.sendPresenceUpdate(action, normalizedJid);
    } catch (e) {
      this.logger.error(`presence.simulate.error chatId=${chatId} action=${action} message=${to.string((e as any)?.message || e)}`);
      this.logger.debug(e);
    }
    return { chatId };
  }

  /**
   * Mark one or many messages as read.
   * Optionally updates presence for the provided/derived jid.
   */
  async readMessages(payload: IReadMessages): Promise<{ read: number; keys: WAMessageKey[] }> {
    const keys = is.array(payload?.keys) ? payload.keys : [];
    const parsedKeys = keys
      .map((key) => ({
        remoteJid: to.string(key?.remoteJid),
        id: to.string(key?.id),
        fromMe: to.boolean(key?.fromMe),
        participant: to.undefined(key?.participant),
      }))
      .filter((key) => key.remoteJid !== '' && key.id !== '') as WAMessageKey[];

    if (parsedKeys.length === 0) return { read: 0, keys: [] };

    try {
      await this.client.readMessages(parsedKeys);

      const presence = payload?.presence as WAPresence;
      const jid = this.normalizeJid(to.string(payload?.jid || parsedKeys[0]?.remoteJid));
      if (!is.undefined(presence) && jid !== '') {
        await this.client.sendPresenceUpdate('available', jid);
        await this.client.presenceSubscribe(jid);
        await this.client.sendPresenceUpdate(presence, jid);
      }
    } catch (e) {
      this.logger.error(`messages.read.error message=${to.string((e as any)?.message || e)}`);
      this.logger.debug(e);
    }

    return { read: parsedKeys.length, keys: parsedKeys };
  }

  /**
   * Return the status of a person/group
   */
  async getProfileStatus(chatId: string): Promise<object> {
    let status = {};
    try {
      status = await this.client.fetchStatus(chatId);
    } catch (_e) {}
    return { status };
  }

  /**
   * Return the profile url picture of a person/group
   */
  async getProfilePicture(chatId: string): Promise<object> {
    let url = '';
    try {
      url = await this.client.profilePictureUrl(chatId, 'image');
    } catch (_e) {}
    return { url };
  }

  /**
   * Get all current chat instances
   */
  getChats(): Chat[] {
    try {
      const { chats } = this.readDataFromFile();
      return chats;
    } catch (_e) {
      return [];
    }
  }

  /**
   * Get all current contact instances
   */
  getContacts(): Contact[] {
    try {
      const { contacts } = this.readDataFromFile();
      return contacts;
    } catch (_e) {
      return [];
    }
  }

  /**
   * Get the registered WhatsApp ID for a number.
   * Will return null if the number is not registered on WhatsApp.
   */
  async getNumberId(number: string): Promise<object> {
    let result = {};
    try {
      [result] = await this.client.onWhatsApp(number);
    } catch (_e) {}
    return result;
  }

  /*
   * Close actual session
   */
  async logout(): Promise<void> {
    try {
      await this.client.logout();
    } catch (e) {
      this.logger.debug(e);
    }
  }

  private async safeCloseClient(reason: string): Promise<void> {
    if (!this.client) return;
    try {
      this.logger.debug(`Closing WhatsApp client (${reason})`);
      if (this.client?.ws?.readyState === 1) {
        this.client.ws.close();
      } else if (typeof this.client?.end === 'function') {
        this.client.end();
      }
    } catch (e) {
      this.logger.debug(`Close client failed: ${to.string((e as any)?.message || e)}`);
    } finally {
      this.client = null;
      this.isConnected = false;
      this.currentClientId = null;
    }
  }

  getConnectionHealth(): {
    alive: boolean;
    connected: boolean;
    hasClient: boolean;
    reconnectScheduled: boolean;
    wsReadyState: number | null;
  } {
    const hasClient = Boolean(this.client);
    const wsReadyStateRaw = this.client?.ws?.readyState;
    const wsReadyState = is.number(wsReadyStateRaw) ? wsReadyStateRaw : null;
    const wsOpen = wsReadyState === null ? this.isConnected : wsReadyState === 1;
    const alive = this.isConnected && hasClient && wsOpen;

    return {
      alive,
      connected: this.isConnected,
      hasClient,
      reconnectScheduled: Boolean(this.reconnectTimeout),
      wsReadyState,
    };
  }

  async ensureConnected(): Promise<{
    alive: boolean;
    connected: boolean;
    hasClient: boolean;
    reconnectScheduled: boolean;
    wsReadyState: number | null;
    action: string;
  }> {
    const health = this.getConnectionHealth();
    if (health.alive) return { ...health, action: 'already_alive' };
    if (health.reconnectScheduled) return { ...health, action: 'reconnect_scheduled' };

    try {
      await this.start();
      return { ...this.getConnectionHealth(), action: 'start_called' };
    } catch (e) {
      this.logger.error('Failed to ensure WhatsApp connection', e);
      return { ...this.getConnectionHealth(), action: 'start_failed' };
    }
  }

  /**
   * Start html page for event emitter
   */
  html(): string {
    const color = 'rgba(50, 50, 50, 0.8)';
    return `<!DOCTYPE html>
      <html lang="en">
      <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>API</title>
          <script src="/public/easy.qrcode.min.js"></script>
          <script src="/public/script.js"></script>
          <style>
            body, #qr {
              display: flex;
              flex-direction: column;
              justify-content: center;
              align-items: center;
              color: ${color};
              font-size: 1.4em;
            }
            body{
              height: 90vh;
            }
            #text{
              padding: 6px;
              font-weight: bold;
              text-align: center;
            }
          </style>
      </head>
      <body>
        <div id="text"></div>
        <div id="qr">
          <div style="width: 80px; height: 80px;">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><radialGradient id="a12" cx=".66" fx=".66" cy=".3125" fy=".3125" gradientTransform="scale(1.5)"><stop offset="0" stop-color="${color}"></stop><stop offset=".3" stop-color="${color}" stop-opacity=".9"></stop><stop offset=".6" stop-color="${color}" stop-opacity=".6"></stop><stop offset=".8" stop-color="${color}" stop-opacity=".3"></stop><stop offset="1" stop-color="${color}" stop-opacity="0"></stop></radialGradient><circle transform-origin="center" fill="none" stroke="url(#a12)" stroke-width="15" stroke-linecap="round" stroke-dasharray="200 1000" stroke-dashoffset="0" cx="100" cy="100" r="70"><animateTransform type="rotate" attributeName="transform" calcMode="spline" dur="1" values="360;0" keyTimes="0;1" keySplines="0 0 1 1" repeatCount="indefinite"></animateTransform></circle><circle transform-origin="center" fill="none" opacity=".2" stroke="${color}" stroke-width="15" stroke-linecap="round" cx="100" cy="100" r="70"></circle></svg>
          </div>
        </div>
      </body>
    </html>`;
  }

  // Return the type of converstion mimetype
  private getMediaMimeType(conversation: any): string {
    if (!conversation?.message) return '';

    const { imageMessage, videoMessage, documentMessage, audioMessage, documentWithCaptionMessage } = conversation?.message || {};

    return to.string(imageMessage?.mimetype ?? audioMessage?.mimetype ?? videoMessage?.mimetype ?? documentMessage?.mimetype ?? documentWithCaptionMessage?.message?.documentMessage?.mimetype);
  }

  private getMediaCaption(conversation: any): string {
    if (!conversation?.message) return '';

    const { imageMessage, videoMessage, documentMessage, audioMessage, documentWithCaptionMessage } = conversation?.message || {};

    return to.string(imageMessage?.caption ?? audioMessage?.caption ?? videoMessage?.caption ?? documentMessage?.caption ?? documentWithCaptionMessage?.message?.documentMessage?.caption);
  }

  private getMediaType(conversation: any): string {
    if (!conversation?.message) return '';

    const { imageMessage, videoMessage, documentMessage, audioMessage, documentWithCaptionMessage } = conversation?.message || {};

    if (imageMessage) return 'image';
    if (videoMessage) return 'video';
    if (audioMessage) return 'audio';
    if (documentMessage) return 'document';
    if (documentWithCaptionMessage?.message?.documentMessage) return 'document';

    // If mimetype is available but message type unknown, derive from MIME prefix
    const mimetype = imageMessage?.mimetype ?? videoMessage?.mimetype ?? audioMessage?.mimetype ?? documentMessage?.mimetype ?? documentWithCaptionMessage?.message?.documentMessage?.mimetype ?? '';

    if (mimetype.startsWith('image/')) return 'image';
    if (mimetype.startsWith('video/')) return 'video';
    if (mimetype.startsWith('audio/')) return 'audio';
    if (mimetype.startsWith('application/')) return 'document';

    return 'unknown';
  }

  private getReplyId(conversation: any): string {
    if (!conversation?.message) return '';
    const contextInfo =
      conversation?.message?.extendedTextMessage?.contextInfo ||
      conversation?.message?.imageMessage?.contextInfo ||
      conversation?.message?.videoMessage?.contextInfo ||
      conversation?.message?.documentMessage?.contextInfo ||
      conversation?.message?.audioMessage?.contextInfo ||
      conversation?.message?.stickerMessage?.contextInfo;

    return to.string(contextInfo?.stanzaId);
  }

  // Baileys expects user chats as @s.whatsapp.net for presence operations.
  private normalizeJid(jid: string): string {
    if (jid.endsWith('@c.us')) return jid.replace('@c.us', '@s.whatsapp.net');
    return jid;
  }

  private hasSavedSession(): boolean {
    const sessionPath = path.resolve(this.credentialsFolderName);
    if (!fs.existsSync(sessionPath)) return false;

    const stats = fs.statSync(sessionPath);
    if (!stats.isDirectory()) return false;

    const files = fs.readdirSync(sessionPath);
    return files.includes('creds.json');
  }

  private isMessageOlderThanMaxAge(message: any): boolean {
    const timestampMs = this.getMessageTimestampMs(message?.messageTimestamp);
    if (timestampMs === 0) return false;
    return Date.now() - timestampMs > this.maxWebhookMessageAgeMs;
  }

  private parseAuthorizedWhatsAppIds(raw: string): Set<string> {
    const items = raw
      .split(/[\n,;]+/)
      .map((value) => value.trim())
      .filter((value) => value !== '')
      .map((value) => value.toLowerCase());
    return new Set(items);
  }

  private isAuthorizedMessage(message: any): boolean {
    if (this.authorizedWhatsAppIds.size === 0) return true;
    const from = to.string(message?.key?.remoteJid).toLowerCase();
    const participant = to.string(message?.key?.participant).toLowerCase();
    if (from !== '' && this.authorizedWhatsAppIds.has(from)) return true;
    if (participant !== '' && this.authorizedWhatsAppIds.has(participant)) return true;
    return false;
  }

  private getMessageTimestampMs(value: any): number {
    if (is.undefined(value) || value === null) return 0;

    if (is.number(value)) return value > 1_000_000_000_000 ? value : value * 1000;

    if (is.string(value)) {
      const asNumber = Number(value);
      if (!Number.isFinite(asNumber) || asNumber <= 0) return 0;
      return asNumber > 1_000_000_000_000 ? asNumber : asNumber * 1000;
    }

    if (is.object(value)) {
      const fromToNumber = value?.toNumber?.();
      if (is.number(fromToNumber) && Number.isFinite(fromToNumber)) return fromToNumber > 1_000_000_000_000 ? fromToNumber : fromToNumber * 1000;

      const fromToString = Number(value?.toString?.());
      if (Number.isFinite(fromToString) && fromToString > 0) return fromToString > 1_000_000_000_000 ? fromToString : fromToString * 1000;
    }

    return 0;
  }

  // Read existing data from the JSON file
  private readDataFromFile(): { chats: Chat[]; contacts: Contact[] } {
    if (fs.existsSync(this.filePath)) {
      const data = fs.readFileSync(this.filePath, 'utf8');
      return JSON.parse(data);
    }
    return { chats: [], contacts: [] };
  }

  // Save chats and contacts to the JSON file
  private saveDataToFile(chats: Chat[], contacts: Contact[]) {
    fs.writeFileSync(this.filePath, JSON.stringify({ chats, contacts }, null, 2), 'utf8');
  }
}
