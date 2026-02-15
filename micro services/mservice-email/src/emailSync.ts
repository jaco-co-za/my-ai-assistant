import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chunkUids, formatAddressList, formatHeaders, sleep } from './helpers.js';
import PDFParser from 'pdf2json';

type DbGet = (sql: string, ...params: unknown[]) => Promise<any>;
type DbRun = (sql: string, ...params: unknown[]) => Promise<void>;
type DbAll = (sql: string, ...params: unknown[]) => Promise<any[]>;

type ImapConfig = {
  host?: string;
  port?: number;
  secure?: boolean;
  auth?: { user?: string; pass?: string };
};

type EmailSyncOptions = {
  dbGet: DbGet;
  dbRun: DbRun;
  dbAll: DbAll;
  imapConfig: ImapConfig;
  debug: boolean;
  attachmentsDir?: string;
  trashMailboxPath?: string;
  onMailChange?: (payload: unknown) => void;
};

export function createEmailSync({
  dbGet,
  dbRun,
  dbAll,
  imapConfig,
  debug,
  attachmentsDir,
  trashMailboxPath,
  onMailChange,
}: EmailSyncOptions) {
  const PDF_DEFAULT_PASSWORD = process.env.PDF_DEFAULT_PASSWORD || '';
  const IMAP_OPERATION_TIMEOUT_MS = Number.parseInt(
    process.env.EMAIL_IMAP_OPERATION_TIMEOUT_MS || '30000',
    10,
  );
  let syncInProgress = false;
  const trashPath = (trashMailboxPath || 'Trash').trim() || 'Trash';

  async function withImapTimeout<T>(label: string, operation: Promise<T>, timeoutMs?: number): Promise<T> {
    const duration =
      Number.isFinite(timeoutMs) && Number(timeoutMs) > 0
        ? Math.floor(Number(timeoutMs))
        : IMAP_OPERATION_TIMEOUT_MS;
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`${label} timed out after ${duration}ms`));
      }, duration);
      operation
        .then((value) => {
          clearTimeout(timer);
          resolve(value);
        })
        .catch((err) => {
          clearTimeout(timer);
          reject(err);
        });
    });
  }

  function attachImapErrorHandler(client: ImapFlow, context: string) {
    client.on('error', (err: any) => {
      const code = err?.code ? String(err.code) : 'UNKNOWN';
      const message = err?.message ? String(err.message) : 'IMAP error';
      // eslint-disable-next-line no-console
      console.error(`[imap:${context}] ${code} ${message}`);
    });
  }

  function isConnectionUnavailableError(err: any): boolean {
    const code = err?.code ? String(err.code).toLowerCase() : '';
    const message = err?.message ? String(err.message).toLowerCase() : '';
    return (
      code.includes('noconnection') ||
      code.includes('etimeout') ||
      message.includes('connection not available') ||
      message.includes('socket timeout') ||
      message.includes('no connection')
    );
  }

  async function ensureFolderRow(path: string, name?: string) {
    let folder = await dbGet('SELECT * FROM folders WHERE path = ? LIMIT 1;', path);
    if (!folder) {
      await dbRun('INSERT INTO folders (name, path) VALUES (?, ?);', name || path, path);
      folder = await dbGet('SELECT * FROM folders WHERE path = ? LIMIT 1;', path);
    }
    return folder;
  }

  async function loadBlockedPatterns(): Promise<string[]> {
    const rows = await dbAll('SELECT pattern FROM blocked_senders;');
    return rows
      .map((row) => (row?.pattern ? String(row.pattern) : ''))
      .map((value) => value.trim().toLowerCase())
      .filter((value) => value.length > 0);
  }

  function isBlockedSender(fromRaw: string | null, blocked: string[]): boolean {
    if (!fromRaw || blocked.length === 0) {
      return false;
    }
    const lowered = fromRaw.toLowerCase();
    return blocked.some((pattern) => lowered.includes(pattern));
  }

  async function handleIncomingMessage(
    client: ImapFlow,
    folder: { id: number; path: string },
    msg: any,
    blockedPatterns: string[],
  ) {
    if (!blockedPatterns.length || folder.path.toLowerCase() === trashPath.toLowerCase()) {
      await upsertMessage(folder.id, msg);
      return;
    }
    const fromRaw = formatAddressList(msg.envelope?.from);
    if (!isBlockedSender(fromRaw, blockedPatterns)) {
      await upsertMessage(folder.id, msg);
      return;
    }

    try {
      await client.messageFlagsAdd(msg.uid, ['\\Seen'], { uid: true });
      const moveResult = await client.messageMove(msg.uid, trashPath, { uid: true });
      let newUid = msg.uid;
      if (moveResult && moveResult.uidMap && typeof moveResult.uidMap.get === 'function') {
        const mapped = moveResult.uidMap.get(msg.uid);
        if (mapped) {
          newUid = mapped;
        } else {
          throw new Error(`UID ${msg.uid} was not moved`);
        }
      }
      const trashFolder = await ensureFolderRow(trashPath, trashPath);
      const movedMsg = { ...msg, uid: newUid };
      await upsertMessage(trashFolder.id, movedMsg);
      if (debug) {
        // eslint-disable-next-line no-console
        console.log(`[blocked] moved UID ${msg.uid} from ${folder.path} to ${trashPath}`);
      }
    } catch (err: any) {
      if (isConnectionUnavailableError(err)) {
        throw err;
      }
      // eslint-disable-next-line no-console
      console.error('[blocked] failed to move message, storing in source folder', err?.message);
      await upsertMessage(folder.id, msg);
    }
  }

  async function enforceBlockedMessagesInFolder(
    client: ImapFlow,
    folder: { id: number; path: string },
    blockedPatterns: string[],
  ) {
    if (!blockedPatterns.length || folder.path.toLowerCase() === trashPath.toLowerCase()) {
      return { moved: 0, failed: 0 };
    }
    const rows = await dbAll(
      'SELECT id, server_uid, from_raw FROM email_messages WHERE folder_id = ?;',
      folder.id,
    );
    const candidates = rows.filter((row) => {
      const uid = Number(row?.server_uid);
      if (!Number.isFinite(uid) || uid <= 0) {
        return false;
      }
      return isBlockedSender(row?.from_raw ? String(row.from_raw) : null, blockedPatterns);
    });
    if (candidates.length === 0) {
      return { moved: 0, failed: 0 };
    }

    const trashFolder = await ensureFolderRow(trashPath, trashPath);
    let moved = 0;
    let failed = 0;
    for (const row of candidates) {
      const uid = Number(row.server_uid);
      const emailId = Number(row.id);
      if (!Number.isFinite(uid) || uid <= 0 || !Number.isFinite(emailId) || emailId <= 0) {
        continue;
      }
      try {
        await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
        const moveResult = await client.messageMove(uid, trashPath, { uid: true });
        let newUid = uid;
        if (moveResult && moveResult.uidMap && typeof moveResult.uidMap.get === 'function') {
          const mapped = Number(moveResult.uidMap.get(uid));
          if (Number.isFinite(mapped) && mapped > 0) {
            newUid = mapped;
          } else {
            throw new Error(`UID ${uid} was not moved`);
          }
        }
        await dbRun(
          'UPDATE email_messages SET folder_id = ?, server_uid = ? WHERE id = ?;',
          trashFolder.id,
          newUid,
          emailId,
        );
        moved += 1;
      } catch (err: any) {
        if (isConnectionUnavailableError(err)) {
          throw err;
        }
        failed += 1;
        if (debug) {
          // eslint-disable-next-line no-console
          console.warn(
            `[blocked] failed to enforce move for email ${emailId} UID ${uid} in ${folder.path}: ${err?.message || 'move failed'}`,
          );
        }
      }
    }
    return { moved, failed };
  }

  function safeFilename(value?: string | null) {
    if (!value) return 'attachment';
    return value.replace(/[^a-zA-Z0-9._-]/g, '_');
  }

  function normalizeWhitespace(value: string): string {
    return value.replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').trim();
  }

  function isPdfAttachment(attachment: any): boolean {
    const contentType = String(attachment?.contentType || '').toLowerCase();
    const filename = String(attachment?.filename || '').toLowerCase();
    return contentType.includes('pdf') || filename.endsWith('.pdf');
  }

  async function extractPdfTextFromBuffer(pdfBuffer: Buffer): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const parser = new PDFParser(undefined, true, PDF_DEFAULT_PASSWORD || undefined);
      parser.on('pdfParser_dataError', (errData: any) => {
        const reason =
          errData?.parserError?.message ||
          errData?.parserError ||
          errData?.message ||
          'PDF parse failed';
        reject(new Error(String(reason)));
      });
      parser.on('pdfParser_dataReady', () => {
        try {
          const content = parser.getRawTextContent();
          resolve(normalizeWhitespace(content || ''));
        } catch (error: any) {
          reject(new Error(error?.message || 'Failed to read extracted PDF text'));
        }
      });
      try {
        parser.parseBuffer(pdfBuffer, 0);
      } catch (error: any) {
        reject(new Error(error?.message || 'Unable to parse PDF buffer'));
      }
    });
  }

  async function autoExtractPdfText(
    attachmentRowId: number,
    emailId: number,
    folderPath: string,
    attachment: any,
  ) {
    if (!Number.isFinite(attachmentRowId) || attachmentRowId <= 0) {
      return;
    }
    if (!isPdfAttachment(attachment)) {
      return;
    }
    const existing = await dbGet(
      'SELECT attachment_id FROM attachment_text_extractions WHERE attachment_id = ? LIMIT 1;',
      attachmentRowId,
    );
    if (existing?.attachment_id) {
      return;
    }
    const content = attachment?.content;
    if (!content || !Buffer.isBuffer(content)) {
      return;
    }
    const extractedText = await extractPdfTextFromBuffer(content);
    const finalText = normalizeWhitespace(extractedText);
    if (!finalText) {
      return;
    }
    await dbRun(
      `INSERT INTO attachment_text_extractions
        (attachment_id, email_id, folder_path, filename, content_type, extracted_text, text_length, extractor, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pdf2json', CURRENT_TIMESTAMP)
       ON CONFLICT(attachment_id) DO UPDATE SET
         email_id = excluded.email_id,
         folder_path = excluded.folder_path,
         filename = excluded.filename,
         content_type = excluded.content_type,
         extracted_text = excluded.extracted_text,
         text_length = excluded.text_length,
         extractor = excluded.extractor,
         updated_at = CURRENT_TIMESTAMP;`,
      attachmentRowId,
      emailId,
      folderPath,
      attachment?.filename || null,
      attachment?.contentType || null,
      finalText,
      finalText.length,
    );
  }

  async function parseMessage(msg: { source?: Buffer | string }) {
    if (!msg.source) {
      return { headersRaw: null, textBody: null, htmlBody: null, attachments: [] as any[] };
    }
    const parsed = await simpleParser(msg.source);
    const htmlBody =
      typeof parsed?.html === 'string'
        ? parsed.html
        : Buffer.isBuffer(parsed?.html)
          ? parsed.html.toString('utf-8')
          : null;
    return {
      headersRaw: formatHeaders(parsed?.headers),
      textBody: parsed?.text || null,
      htmlBody,
      attachments: Array.isArray(parsed?.attachments) ? parsed.attachments : [],
    };
  }

  function isSeenMessage(msg: any): boolean {
    const raw = msg?.flags;
    if (raw instanceof Set) {
      return raw.has('\\Seen');
    }
    if (Array.isArray(raw)) {
      return raw.some((flag) => String(flag).toLowerCase() === '\\seen');
    }
    // Default to seen to match historical behavior for existing rows.
    return true;
  }

  async function writeAttachmentFile(emailId: number, attachment: any, index: number) {
    const dir = attachmentsDir || './attachments';
    await mkdir(dir, { recursive: true });
    const filename = safeFilename(attachment.filename || `attachment_${index}`);
    const filePath = join(dir, `${emailId}_${index}_${filename}.json`);
    const payload = {
      email_id: emailId,
      filename: attachment.filename || null,
      content_type: attachment.contentType || null,
      disposition: attachment.contentDisposition || null,
      content_id: attachment.contentId || null,
      checksum: attachment.checksum || null,
      size: attachment.size || null,
      content_base64: attachment.content ? attachment.content.toString('base64') : null,
    };
    await writeFile(filePath, JSON.stringify(payload));
    return filePath;
  }

  async function deleteAttachmentFiles(emailId: number) {
    const rows = await dbAll(
      'SELECT storage_path FROM email_attachments WHERE email_id = ?;',
      emailId,
    );
    for (const row of rows) {
      if (row?.storage_path) {
        await rm(row.storage_path, { force: true }).catch(() => {});
      }
    }
  }

  async function deleteFolderAttachmentFiles(folderId: number) {
    const rows = await dbAll(
      'SELECT ea.storage_path FROM email_attachments ea INNER JOIN email_messages em ON em.id = ea.email_id WHERE em.folder_id = ?;',
      folderId,
    );
    for (const row of rows) {
      if (row?.storage_path) {
        await rm(row.storage_path, { force: true }).catch(() => {});
      }
    }
  }

  async function upsertMessage(folderId: number, msg: any) {
    let eventType = 'mail_created';
    const existing = await dbGet(
      'SELECT id FROM email_messages WHERE folder_id = ? AND server_uid = ? LIMIT 1;',
      folderId,
      msg.uid,
    );
    if (existing?.id) {
      eventType = 'mail_updated';
    }

    let headersRaw: string | null = null;
    let textBody: string | null = null;
    let htmlBody: string | null = null;
    let parsedAttachments: any[] = [];
    try {
      const parsed = await parseMessage(msg);
      headersRaw = parsed.headersRaw;
      textBody = parsed.textBody;
      htmlBody = parsed.htmlBody;
      parsedAttachments = parsed.attachments;
    } catch (err: any) {
      if (debug) {
        // eslint-disable-next-line no-console
        console.warn('failed to parse message source for headers/text', err?.message);
      }
    }

    await dbRun(
      `INSERT INTO email_messages
        (folder_id, server_uid, message_id, from_raw, to_raw, cc_raw, bcc_raw, subject, received_at, headers_raw, text_body, html_body, is_seen)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(folder_id, server_uid) DO UPDATE SET
         message_id=excluded.message_id,
         from_raw=excluded.from_raw,
         to_raw=excluded.to_raw,
         cc_raw=excluded.cc_raw,
         bcc_raw=excluded.bcc_raw,
         subject=excluded.subject,
         received_at=excluded.received_at,
         headers_raw=excluded.headers_raw,
         text_body=excluded.text_body,
         html_body=excluded.html_body,
         is_seen=excluded.is_seen;`,
      folderId,
      msg.uid,
      msg.envelope?.messageId || null,
      formatAddressList(msg.envelope?.from),
      formatAddressList(msg.envelope?.to),
      formatAddressList(msg.envelope?.cc),
      formatAddressList(msg.envelope?.bcc),
      msg.envelope?.subject || null,
      msg.internalDate ? new Date(msg.internalDate).toISOString() : null,
      headersRaw,
      textBody,
      htmlBody,
      isSeenMessage(msg) ? 1 : 0,
    );

    const row = await dbGet(
      'SELECT id FROM email_messages WHERE folder_id = ? AND server_uid = ? LIMIT 1;',
      folderId,
      msg.uid,
    );
    if (!row?.id) return;
    const folderRow = await dbGet('SELECT path FROM folders WHERE id = ? LIMIT 1;', folderId);
    const folderPath = folderRow?.path ? String(folderRow.path) : '';

    await deleteAttachmentFiles(row.id);
    await dbRun('DELETE FROM email_attachments WHERE email_id = ?;', row.id);
    if (parsedAttachments.length > 0) {
      let index = 0;
      for (const attachment of parsedAttachments) {
        index += 1;
        const storagePath = await writeAttachmentFile(row.id, attachment, index);
        await dbRun(
          `INSERT INTO email_attachments
           (email_id, part, filename, disposition, content_type, size, storage_path)
           VALUES (?, ?, ?, ?, ?, ?, ?);`,
          row.id,
          null,
          attachment.filename || null,
          attachment.contentDisposition || null,
          attachment.contentType || null,
          attachment.size || null,
          storagePath,
        );
        const attachmentRow = await dbGet(
          'SELECT id FROM email_attachments WHERE email_id = ? AND storage_path = ? ORDER BY id DESC LIMIT 1;',
          row.id,
          storagePath,
        );
        try {
          const attachmentId = Number(attachmentRow?.id || 0);
          await autoExtractPdfText(attachmentId, row.id, folderPath, attachment);
        } catch (err: any) {
          if (debug) {
            // eslint-disable-next-line no-console
            console.warn('failed to auto extract attachment text', err?.message);
          }
        }
      }
    }

    if (typeof onMailChange === 'function') {
      const messageRow = await dbGet('SELECT * FROM email_messages WHERE id = ?;', row.id);
      const attachmentRows = await dbAll(
        'SELECT id, email_id, part, filename, disposition, content_type, size, storage_path FROM email_attachments WHERE email_id = ?;',
        row.id,
      );
      onMailChange({
        type: eventType,
        message: messageRow,
        attachments: attachmentRows || [],
      });
    }
  }

  async function deleteMessage(folderId: number, uid: number) {
    const row = await dbGet(
      'SELECT id FROM email_messages WHERE folder_id = ? AND server_uid = ? LIMIT 1;',
      folderId,
      uid,
    );
    if (!row?.id) return;
    const messageRow = await dbGet('SELECT * FROM email_messages WHERE id = ?;', row.id);
    const attachmentRows = await dbAll(
      'SELECT id, email_id, part, filename, disposition, content_type, size, storage_path FROM email_attachments WHERE email_id = ?;',
      row.id,
    );
    await deleteAttachmentFiles(row.id);
    await dbRun('DELETE FROM email_attachments WHERE email_id = ?;', row.id);
    await dbRun('DELETE FROM email_messages WHERE id = ?;', row.id);
    if (typeof onMailChange === 'function') {
      onMailChange({
        type: 'mail_deleted',
        message: messageRow,
        attachments: attachmentRows || [],
      });
    }
  }

  async function reconcileFolder(client: ImapFlow, folderId: number, path: string) {
    const serverUidsRaw = await client.search({ all: true }, { uid: true });
    const serverUids = Array.isArray(serverUidsRaw) ? serverUidsRaw : [];
    const serverSet = new Set<number>(serverUids);
    const rows = await dbAll('SELECT server_uid FROM email_messages WHERE folder_id = ?;', folderId);

    for (const row of rows) {
      if (!serverSet.has(row.server_uid)) {
        await deleteMessage(folderId, row.server_uid);
      }
    }

    const maxServerUid = serverUids.length > 0 ? Math.max(...serverUids) : 0;
    await dbRun('UPDATE folders SET last_uid = ? WHERE id = ?;', maxServerUid, folderId);
    if (!debug) {
      // no per-folder reconcile logging
    }
  }

  async function reconcileAll(): Promise<void> {
    if (!imapConfig?.host || !imapConfig?.auth?.user || !imapConfig?.auth?.pass) {
      // eslint-disable-next-line no-console
      console.warn('[email-micro-service] IMAP settings missing, reconcile skipped');
      return;
    }

    const authUser = imapConfig.auth?.user || '';
    const authPass = imapConfig.auth?.pass || '';
    const host = imapConfig.host || '';
    const port = imapConfig.port ?? 993;
    const secure = imapConfig.secure ?? true;
    const client = new ImapFlow({
      host,
      port,
      secure,
      logger: debug ? undefined : false,
      auth: {
        user: authUser,
        pass: authPass,
      },
    });
    attachImapErrorHandler(client, 'reconcile');

    try {
      await client.connect();
      const mailboxes = await client.list();
      for (const mailbox of mailboxes) {
        const path = mailbox.path;
        const name = mailbox.name || mailbox.path;
        const folder = await ensureFolderRow(path, name);
        await client.mailboxOpen(path, { readOnly: true });
        await reconcileFolder(client, folder.id, path);
      }
    } finally {
      await client.logout().catch(() => {});
    }
  }

  async function syncIfNeeded(options?: { ignoreDbMax?: boolean }) {
    if (syncInProgress) {
      if (!debug) {
        // eslint-disable-next-line no-console
        console.log('[email-micro-service] sync skipped: already in progress');
      }
      return;
    }
    let shouldLogCycle = false;
    if (!imapConfig?.host || !imapConfig?.auth?.user || !imapConfig?.auth?.pass) {
      // eslint-disable-next-line no-console
      console.warn('[email-micro-service] IMAP settings missing, skipping sync');
      return;
    }

    const cycleStartedAt = Date.now();
    if (!debug) {
      // eslint-disable-next-line no-console
      console.log('IMAP sync cycle running');
      shouldLogCycle = true;
    }
    const authUser = imapConfig.auth?.user || '';
    const authPass = imapConfig.auth?.pass || '';
    const host = imapConfig.host || '';
    const port = imapConfig.port ?? 993;
    const secure = imapConfig.secure ?? true;
    const client = new ImapFlow({
      host,
      port,
      secure,
      logger: debug ? undefined : false,
      auth: {
        user: authUser,
        pass: authPass,
      },
    });
    attachImapErrorHandler(client, 'sync');

    try {
      syncInProgress = true;
      await withImapTimeout('IMAP connect', client.connect());
      const mailboxes = await withImapTimeout('IMAP list', client.list());

      let folderCount = 0;
      for (const mailbox of mailboxes) {
        const path = mailbox.path;
        const name = mailbox.name || mailbox.path;
        const folder = await ensureFolderRow(path, name);
        folderCount += 1;
        const mailboxInfo = await withImapTimeout(
          `IMAP mailboxOpen(${path})`,
          client.mailboxOpen(path, { readOnly: false }),
        );
        const blockedPatterns = await loadBlockedPatterns();
        const enforced = await enforceBlockedMessagesInFolder(client, { id: folder.id, path }, blockedPatterns);
        if (debug && (enforced.moved > 0 || enforced.failed > 0)) {
          // eslint-disable-next-line no-console
          console.log(
            `[blocked] enforced in ${path}: moved=${enforced.moved} failed=${enforced.failed}`,
          );
        }

        const retryDelays = [5000, 30000, 120000];
        let attempt = 0;
        while (attempt <= retryDelays.length) {
          const isLastAttempt = attempt === retryDelays.length;
          try {
            const maxUidRow = await dbGet(
              'SELECT COALESCE(MAX(server_uid), 0) as max_uid FROM email_messages WHERE folder_id = ?;',
              folder.id,
            );
            let maxUid = options?.ignoreDbMax
              ? folder.last_uid || 0
              : Math.max(folder.last_uid || 0, maxUidRow?.max_uid || 0);
            const uidNext = mailboxInfo?.uidNext || 1;
            const exists = mailboxInfo?.exists || 0;
            const lastExistingUid = Math.max(uidNext - 1, 0);
            if (exists === 0) {
              await dbRun('UPDATE folders SET last_uid = 0 WHERE id = ?;', folder.id);
              break;
            }
            if (lastExistingUid === 0) {
              await dbRun('UPDATE folders SET last_uid = 0 WHERE id = ?;', folder.id);
              break;
            }
            if (maxUid >= lastExistingUid) {
              await dbRun('UPDATE folders SET last_uid = ? WHERE id = ?;', maxUid, folder.id);
              break;
            }

            let folderCount = 0;
            const fetchMessages = async (rangeOrUids: string | number[]) => {
              for await (const msg of client.fetch(
                rangeOrUids,
                {
                  envelope: true,
                  source: true,
                  internalDate: true,
                  flags: true,
                },
                { uid: true },
              )) {
                await handleIncomingMessage(client, { id: folder.id, path }, msg, blockedPatterns);
                if (msg.uid > maxUid) {
                  maxUid = msg.uid;
                  await dbRun('UPDATE folders SET last_uid = ? WHERE id = ?;', maxUid, folder.id);
                }
                folderCount += 1;
                if (debug) {
                  // eslint-disable-next-line no-console
                  console.log(`[debug] ${path}: fetched UID ${msg.uid}`);
                }
              }
            };

            const fetchWithFallback = async () => {
              const allUids = await withImapTimeout(
                `IMAP search(${path})`,
                client.search({ all: true }, { uid: true }),
              );
              const remainingUids = Array.isArray(allUids)
                ? allUids.filter((uid: number) => uid > maxUid)
                : [];
              if (remainingUids.length === 0) {
                return;
              }
              for (const chunk of chunkUids(remainingUids, 200)) {
                await fetchMessages(chunk);
              }
            };

            await fetchWithFallback();
            await dbRun('UPDATE folders SET last_uid = ? WHERE id = ?;', maxUid, folder.id);
            break;
          } catch (err: any) {
            const errDetails = {
              message: err?.message || 'unknown error',
              responseText: err?.responseText || null,
              responseStatus: err?.responseStatus || null,
              executedCommand: err?.executedCommand || null,
              mailboxExists: mailboxInfo?.exists ?? null,
              mailboxUidNext: mailboxInfo?.uidNext ?? null,
            };
            // eslint-disable-next-line no-console
            console.error(`${path}: sync failed`, errDetails);

            if (isConnectionUnavailableError(err)) {
              // Current IMAP client/session is no longer usable. Abort this cycle and let caller reconnect.
              throw err;
            }

            const maxUidRow = await dbGet(
              'SELECT COALESCE(MAX(server_uid), 0) as max_uid FROM email_messages WHERE folder_id = ?;',
              folder.id,
            );
            const dbMaxUid = maxUidRow?.max_uid || 0;
            const uidNext = mailboxInfo?.uidNext || 1;
            const exists = mailboxInfo?.exists || 0;
            const lastExistingUid = Math.max(uidNext - 1, 0);
            const folderSeemsCorrupt =
              (dbMaxUid > lastExistingUid && lastExistingUid > 0) ||
              (lastExistingUid === 0 && dbMaxUid > 0) ||
              (exists === 0 && dbMaxUid > 0);

            if (folderSeemsCorrupt) {
              // eslint-disable-next-line no-console
              console.error(
                `${path}: detected corrupt folder state (db max UID ${dbMaxUid}, server last UID ${lastExistingUid}). Resetting this folder.`,
              );
              await deleteFolderAttachmentFiles(folder.id);
              await dbRun('DELETE FROM email_messages WHERE folder_id = ?;', folder.id);
              await dbRun('UPDATE folders SET last_uid = 0 WHERE id = ?;', folder.id);

              if (lastExistingUid === 0) {
              break;
            }

              let maxUid = 0;
              let folderCount = 0;
              for await (const msg of client.fetch(
                '1:*',
                {
                  envelope: true,
                  source: true,
                  internalDate: true,
                  flags: true,
                },
                { uid: true },
              )) {
                await upsertMessage(folder.id, msg);
                if (msg.uid > maxUid) {
                  maxUid = msg.uid;
                  await dbRun('UPDATE folders SET last_uid = ? WHERE id = ?;', maxUid, folder.id);
                }
                folderCount += 1;
                if (debug) {
                  // eslint-disable-next-line no-console
                  console.log(`[debug] ${path}: fetched UID ${msg.uid}`);
                }
              }
              await dbRun('UPDATE folders SET last_uid = ? WHERE id = ?;', maxUid, folder.id);
              break;
            }

            if (isLastAttempt) {
              // eslint-disable-next-line no-console
              console.error(`${path}: giving up after retries.`);
              break;
            }

            const delay = retryDelays[attempt];
            attempt += 1;
            // eslint-disable-next-line no-console
            console.error(`${path}: retrying in ${Math.round(delay / 1000)}s.`);
            await sleep(delay);
          }
        }
      }
    } finally {
      syncInProgress = false;
      await client.logout().catch(() => {});
      if (shouldLogCycle) {
        // eslint-disable-next-line no-console
        console.log(`IMAP sync cycle complete (${Date.now() - cycleStartedAt}ms)`);
      }
    }
  }

  async function forceResyncAll(): Promise<void> {
    // eslint-disable-next-line no-console
    await dbRun('UPDATE folders SET last_uid = 0;');
    await syncIfNeeded({ ignoreDbMax: true });
  }


  function startWatcher() {
    if (!imapConfig?.host || !imapConfig?.auth?.user || !imapConfig?.auth?.pass) {
      // eslint-disable-next-line no-console
      console.warn('[email-micro-service] IMAP settings missing, watcher disabled');
      return;
    }

    const run = async () => {
      const resyncIntervalMs = 5 * 60 * 1000;
      let resyncTimer: NodeJS.Timeout | null = null;
      let inboxPollTimer: NodeJS.Timeout | null = null;
      let sentPollTimer: NodeJS.Timeout | null = null;
      while (true) {
        const authUser = imapConfig.auth?.user || '';
        const authPass = imapConfig.auth?.pass || '';
        const host = imapConfig.host || '';
        const port = imapConfig.port ?? 993;
        const secure = imapConfig.secure ?? true;
        const client = new ImapFlow({
          host,
          port,
          secure,
          logger: debug ? undefined : false,
          auth: {
            user: authUser,
            pass: authPass,
          },
        });
        attachImapErrorHandler(client, 'watcher');
        let errorResolve: (err: unknown) => void = () => {};
        const errorPromise = new Promise<unknown>((resolve) => {
          errorResolve = resolve;
        });
        client.on('error', (err) => {
          errorResolve(err);
        });

        try {
          await client.connect();
          // eslint-disable-next-line no-console
          console.log('[email-micro-service] IMAP watcher connected');
          if (!resyncTimer) {
            // eslint-disable-next-line no-console
            console.log('[email-micro-service] periodic resync scheduled every 5 minutes');
            resyncTimer = setInterval(() => {
              if (!syncInProgress) {
                // eslint-disable-next-line no-console
                console.log('[email-micro-service] periodic resync starting');
                syncIfNeeded()
                  .then(() => reconcileAll())
                  .catch((err) => {
                  // eslint-disable-next-line no-console
                  console.error('[email-micro-service] periodic resync failed:', err);
                  });
              }
            }, resyncIntervalMs);
          }
          const inboxPollIntervalMs = 30000;
          const pollInbox = async () => {
            if (syncInProgress) {
              return;
            }
            try {
              const mailboxPath = 'INBOX';
              const folder = await ensureFolderRow(mailboxPath, mailboxPath);
              const mailboxInfo = await client.mailboxOpen(mailboxPath, { readOnly: true });
              const lastUidRow = await dbGet('SELECT last_uid FROM folders WHERE id = ?;', folder.id);
              let currentLastUid = lastUidRow?.last_uid || 0;
              const uidNext = mailboxInfo?.uidNext || 1;
              const lastExistingUid = Math.max(uidNext - 1, 0);
              if (currentLastUid >= lastExistingUid || lastExistingUid === 0) {
                return;
              }
              let maxUid = currentLastUid;
              const allUids = await client.search({ all: true }, { uid: true });
              const remainingUids = Array.isArray(allUids)
                ? allUids.filter((uid: number) => uid > currentLastUid)
                : [];
              if (remainingUids.length === 0) {
                return;
              }
              // eslint-disable-next-line no-console
              console.log(
                `[watcher] INBOX poll fetch ${remainingUids.length} uid(s) (from ${remainingUids[0]} to ${remainingUids[remainingUids.length - 1]})`,
              );
              for (const chunk of chunkUids(remainingUids, 200)) {
              const blockedPatterns = await loadBlockedPatterns();
              for await (const msg of client.fetch(
                chunk,
                {
                  envelope: true,
                  source: true,
                  internalDate: true,
                  flags: true,
                },
                { uid: true },
              )) {
                // eslint-disable-next-line no-console
                console.log('[watcher] INBOX fetched UID', msg.uid);
                await handleIncomingMessage(client, { id: folder.id, path: mailboxPath }, msg, blockedPatterns);
                if (msg.uid > maxUid) maxUid = msg.uid;
              }
              }
              if (maxUid !== currentLastUid) {
                // eslint-disable-next-line no-console
                console.log(
                  `[watcher] INBOX advancing last_uid ${currentLastUid} -> ${maxUid}`,
                );
                await dbRun('UPDATE folders SET last_uid = ? WHERE id = ?;', maxUid, folder.id);
              }
            } catch (err: any) {
              if (err?.code === 'NoConnection') {
                return;
              }
              // eslint-disable-next-line no-console
              console.error('[watcher] INBOX poll failed:', err);
            }
          };
          if (!inboxPollTimer) {
            inboxPollTimer = setInterval(() => {
              pollInbox().catch(() => {});
            }, inboxPollIntervalMs);
          }
          const sentPollIntervalMs = 30000;
          const pollSent = async () => {
            if (syncInProgress) {
              return;
            }
            try {
              const mailboxPath = 'INBOX.Sent';
              const folder = await ensureFolderRow(mailboxPath, 'Sent');
              const mailboxInfo = await client.mailboxOpen(mailboxPath, { readOnly: true });
              const lastUidRow = await dbGet('SELECT last_uid FROM folders WHERE id = ?;', folder.id);
              let currentLastUid = lastUidRow?.last_uid || 0;
              const uidNext = mailboxInfo?.uidNext || 1;
              const lastExistingUid = Math.max(uidNext - 1, 0);
              if (currentLastUid >= lastExistingUid || lastExistingUid === 0) {
                return;
              }
              let maxUid = currentLastUid;
              const allUids = await client.search({ all: true }, { uid: true });
              const remainingUids = Array.isArray(allUids)
                ? allUids.filter((uid: number) => uid > currentLastUid)
                : [];
              if (remainingUids.length === 0) {
                return;
              }
              // eslint-disable-next-line no-console
              console.log(
                `[watcher] Sent poll fetch ${remainingUids.length} uid(s) (from ${remainingUids[0]} to ${remainingUids[remainingUids.length - 1]})`,
              );
              for (const chunk of chunkUids(remainingUids, 200)) {
              const blockedPatterns = await loadBlockedPatterns();
              for await (const msg of client.fetch(
                chunk,
                {
                  envelope: true,
                  source: true,
                  internalDate: true,
                  flags: true,
                },
                { uid: true },
              )) {
                // eslint-disable-next-line no-console
                console.log('[watcher] Sent fetched UID', msg.uid);
                await handleIncomingMessage(client, { id: folder.id, path: mailboxPath }, msg, blockedPatterns);
                if (msg.uid > maxUid) maxUid = msg.uid;
              }
              }
              if (maxUid !== currentLastUid) {
                // eslint-disable-next-line no-console
                console.log(
                  `[watcher] Sent advancing last_uid ${currentLastUid} -> ${maxUid}`,
                );
                await dbRun('UPDATE folders SET last_uid = ? WHERE id = ?;', maxUid, folder.id);
              }
            } catch (err: any) {
              if (err?.code === 'NoConnection') {
                return;
              }
              // eslint-disable-next-line no-console
              console.error('[watcher] Sent poll failed:', err);
            }
          };
          if (!sentPollTimer) {
            sentPollTimer = setInterval(() => {
              pollSent().catch(() => {});
            }, sentPollIntervalMs);
          }

          while (true) {
            if (syncInProgress) {
              await sleep(1500);
              continue;
            }

            const mailboxPath = 'INBOX';
            const folder = await ensureFolderRow(mailboxPath, mailboxPath);
            const mailboxInfo = await client.mailboxOpen(mailboxPath, { readOnly: true });

            const lastUidRow = await dbGet('SELECT last_uid FROM folders WHERE id = ?;', folder.id);
            let currentLastUid = lastUidRow?.last_uid || 0;
            const uidNext = mailboxInfo?.uidNext || 1;
            const lastExistingUid = Math.max(uidNext - 1, 0);
            if (currentLastUid > lastExistingUid) {
              currentLastUid = lastExistingUid;
              await dbRun('UPDATE folders SET last_uid = ? WHERE id = ?;', currentLastUid, folder.id);
            }
            let reconcileRequested = false;
            let reconcileRunning = false;

            const onExists = async () => {
              const nextUid = Math.max(currentLastUid + 1, 1);
              if (nextUid > lastExistingUid && lastExistingUid > 0) {
                return;
              }
              const fetchRange = `${nextUid}:*`;
              let maxUid = currentLastUid;
              try {
                const blockedPatterns = await loadBlockedPatterns();
                for await (const msg of client.fetch(
                  fetchRange,
                  {
                    envelope: true,
                    source: true,
                    internalDate: true,
                    flags: true,
                  },
                  { uid: true },
                )) {
                  await handleIncomingMessage(client, { id: folder.id, path: mailboxPath }, msg, blockedPatterns);
                  if (msg.uid > maxUid) maxUid = msg.uid;
                }
              } catch (err: any) {
                if (
                  err?.responseStatus === 'BAD' &&
                  /Invalid messageset/i.test(err?.responseText || '')
                ) {
                  return;
                }
                throw err;
              }
              if (maxUid !== currentLastUid) {
                currentLastUid = maxUid;
                await dbRun('UPDATE folders SET last_uid = ? WHERE id = ?;', currentLastUid, folder.id);
              }
            };

            const onExpunge = async (data: any) => {
              const uidFromEvent = typeof data === 'object' ? data?.uid : null;
              if (uidFromEvent) {
                await deleteMessage(folder.id, uidFromEvent);
                return;
              }

              // Fallback: schedule a full reconcile if we can't resolve UID.
              reconcileRequested = true;
            };

            client.on('exists', onExists);
            client.on('expunge', onExpunge);

            const idleResult = await Promise.race([client.idle().then(() => null), errorPromise]);
            if (idleResult instanceof Error) {
              throw idleResult;
            }
            client.removeListener('exists', onExists);
            client.removeListener('expunge', onExpunge);

            if (reconcileRequested && !reconcileRunning) {
              reconcileRunning = true;
              await reconcileFolder(client, folder.id, mailboxPath);
              reconcileRequested = false;
              reconcileRunning = false;
            }
          }
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error('IMAP watcher failed:', err);
          if (resyncTimer) {
            clearInterval(resyncTimer);
            resyncTimer = null;
          }
          if (inboxPollTimer) {
            clearInterval(inboxPollTimer);
            inboxPollTimer = null;
          }
          if (sentPollTimer) {
            clearInterval(sentPollTimer);
            sentPollTimer = null;
          }
          // eslint-disable-next-line no-console
          console.log('[email-micro-service] watcher reconnecting in 30s');
          await client.logout().catch(() => {});
          // eslint-disable-next-line no-console
          console.log('[email-micro-service] IMAP watcher retrying in 30s');
          await sleep(30000);
        }
      }
    };

    run().catch((err) => {
      // eslint-disable-next-line no-console
      console.error('IMAP watcher fatal error:', err);
    });
  }

  return { syncIfNeeded, forceResyncAll, reconcileAll, startWatcher };
}
