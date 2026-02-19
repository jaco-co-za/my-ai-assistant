import type { Express } from "express";
import fs from "node:fs";
import path from "node:path";
import {
  classifyAndCompile,
  storeIncomingMessage,
  storeOutgoingMessage,
  storeVoiceNote,
} from "./messageBroker.js";
import { transcribeVoiceNote } from "./ollamaClient.js";
import { broadcastEvent } from "./websocket.js";
import { listDynamicIntents } from "./dynamicIntents.js";

const DEFAULT_FILE_UPLOAD_URL = "http://localhost:3224/file/upload";
const DEFAULT_WHATSAPP_MESSAGE_URL = "http://localhost:8085/message";
const DEFAULT_UI_UPLOAD_CALLBACK_PATH = "/file/upload-status";
const DEFAULT_FILE_OWNER = "me";
const FILE_UPLOAD_TIMEOUT_MS = Number(process.env.FILE_UPLOAD_TIMEOUT_MS ?? "") > 0
  ? Number(process.env.FILE_UPLOAD_TIMEOUT_MS)
  : 120_000;

function resolveFileUploadUrl(raw?: string): string {
  const candidate = (raw ?? "").trim();
  if (!candidate) {
    return DEFAULT_FILE_UPLOAD_URL;
  }
  const withScheme = /^https?:\/\//i.test(candidate) ? candidate : `http://${candidate}`;
  if (/\/file\/upload$/i.test(withScheme)) {
    return withScheme;
  }
  return `${withScheme.replace(/\/+$/, "")}/file/upload`;
}

function normalizeBearer(raw?: string): string {
  return String(raw ?? "").trim().replace(/^Bearer\s+/i, "");
}

function sanitizeLogValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeLogValue(item));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
      const keyLower = key.toLowerCase();
      if (keyLower === "base64" || keyLower === "data_base64") {
        const len = typeof raw === "string" ? raw.length : 0;
        out[key] = `[omitted base64 len=${len}]`;
        continue;
      }
      if (keyLower === "images" && Array.isArray(raw)) {
        out[key] = `[omitted images count=${raw.length}]`;
        continue;
      }
      out[key] = sanitizeLogValue(raw);
    }
    return out;
  }
  if (typeof value === "string" && value.length > 1200) {
    return `${value.slice(0, 1200)}...[truncated ${value.length - 1200} chars]`;
  }
  return value;
}

function sanitizeMessageForLog(message: string): string {
  const raw = String(message || "");
  if (!raw) {
    return raw;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return JSON.stringify(sanitizeLogValue(parsed));
  } catch {
    return raw.length > 1200 ? `${raw.slice(0, 1200)}...[truncated ${raw.length - 1200} chars]` : raw;
  }
}

function normalizeFileOwner(raw?: string): string {
  const value = String(raw ?? "").trim().toLowerCase();
  if (!value) {
    return DEFAULT_FILE_OWNER;
  }
  return value.includes("sonja") ? "sonja" : DEFAULT_FILE_OWNER;
}

function isWhatsappInbound(from: string): boolean {
  const value = String(from || "").toLowerCase();
  return value.includes("@lid") || value.includes("whatsapp");
}

function resolveWhatsappMessageUrl(raw?: string): string {
  const candidate = (raw ?? "").trim();
  if (!candidate) {
    return DEFAULT_WHATSAPP_MESSAGE_URL;
  }
  return /^https?:\/\//i.test(candidate) ? candidate : `http://${candidate}`;
}

async function sendWhatsappStoredPdfNotice(chatId: string, text: string): Promise<void> {
  const normalizedChatId = String(chatId || "").trim();
  const normalizedText = String(text || "").trim();
  if (!normalizedChatId || !normalizedText) {
    return;
  }
  const url = resolveWhatsappMessageUrl(process.env.WHATSAPP_MESSAGE_URL);
  const auth = (process.env.WHATSAPP_MESSAGE_AUTH ?? "").trim();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (auth) {
    headers.Authorization = auth;
  }
  await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      chatId: normalizedChatId,
      text: normalizedText,
      message: normalizedText,
    }),
  });
}

function extensionFromMime(mimeType: string): string {
  const normalizedMime = String(mimeType || "").toLowerCase();
  if (normalizedMime.includes("pdf")) {
    return "pdf";
  }
  if (normalizedMime.includes("msword")) {
    return "doc";
  }
  if (normalizedMime.includes("officedocument.wordprocessingml.document")) {
    return "docx";
  }
  if (normalizedMime.includes("jpeg") || normalizedMime.includes("jpg")) {
    return "jpg";
  }
  if (normalizedMime.includes("png")) {
    return "png";
  }
  if (normalizedMime.includes("gif")) {
    return "gif";
  }
  if (normalizedMime.includes("webp")) {
    return "webp";
  }
  if (normalizedMime.includes("mp4")) {
    return "mp4";
  }
  if (normalizedMime.includes("mpeg")) {
    return "mpeg";
  }
  if (normalizedMime.includes("plain")) {
    return "txt";
  }
  return "bin";
}

function inferFilename(body: any, bodyMimeType: string, messageId?: string): string {
  const explicitName = (() => {
    const lower =
      typeof body?.media?.filename === "string" && body.media.filename.trim().length > 0
        ? body.media.filename.trim()
        : "";
    if (lower) {
      return lower;
    }
    const camel =
      typeof body?.media?.fileName === "string" && body.media.fileName.trim().length > 0
        ? body.media.fileName.trim()
        : "";
    return camel;
  })();
  if (explicitName) {
    return explicitName;
  }
  const normalizedMime = String(bodyMimeType || "").toLowerCase();
  const suffix = String(messageId || "").trim().replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 24);
  const ext = extensionFromMime(normalizedMime);
  const idPart = suffix ? `-${suffix}` : "";
  if (normalizedMime.includes("pdf")) {
    return `whatsapp-file${idPart}.pdf`;
  }
  if (normalizedMime.startsWith("image/")) {
    return `whatsapp-image${idPart}.${ext}`;
  }
  if (normalizedMime.startsWith("video/")) {
    return `whatsapp-video${idPart}.${ext}`;
  }
  return `whatsapp-file${idPart}.${ext}`;
}

function isPdfUpload(args: { mimeType?: string; filename?: string }): boolean {
  const mime = String(args.mimeType || "").toLowerCase();
  const name = String(args.filename || "").toLowerCase();
  return mime.includes("pdf") || name.endsWith(".pdf");
}

function resolveUiUploadCallbackUrl(): string {
  const explicit = String(process.env.UI_FILE_UPLOAD_CALLBACK_URL ?? "").trim();
  if (explicit) {
    return /^https?:\/\//i.test(explicit) ? explicit : `http://${explicit}`;
  }
  const hostRaw = String(process.env.UI_UPLOAD_CALLBACK_HOST ?? process.env.UI_WEBSOCKET_URL ?? "localhost").trim();
  const host = hostRaw
    .replace(/^wss?:\/\//i, "")
    .replace(/^https?:\/\//i, "")
    .replace(/\/ws\/?$/i, "")
    .replace(/\/+$/, "");
  const port = Number(process.env.WEBHOOK_PORT) || 3350;
  const hasPort = /:\d+$/.test(host);
  const base = `http://${host}${hasPort ? "" : `:${port}`}`;
  return `${base.replace(/\/+$/, "")}${DEFAULT_UI_UPLOAD_CALLBACK_PATH}`;
}

async function uploadToFileService(args: {
  owner?: string;
  source: string;
  sourceSender: string;
  sourceMessageId: string;
  caption: string;
  mimeType: string;
  filename: string;
  base64: string;
  callbackUrl?: string;
  callbackAuthorization?: string;
}): Promise<{ fileId: number | null; key: string | null; summary: string | null; summaryStatus: string | null }> {
  const url = resolveFileUploadUrl(process.env.FILE_MICRO_SERVICE_URL);
  const token = normalizeBearer(process.env.FILE_MICRO_SERVICE_AUTH ?? process.env.WEBHOOK_BEARER_TOKEN ?? "");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FILE_UPLOAD_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        owner: normalizeFileOwner(args.owner),
        source_owner: normalizeFileOwner(args.owner),
        source: args.source,
        source_sender: args.sourceSender,
        source_message_id: args.sourceMessageId || null,
        caption: args.caption || null,
        filename: args.filename,
        content_type: args.mimeType || "application/octet-stream",
        data_base64: args.base64,
        callback_url: args.callbackUrl || null,
        callback_authorization: args.callbackAuthorization || null,
      }),
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`file upload timed out after ${FILE_UPLOAD_TIMEOUT_MS}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`file upload failed (${response.status}): ${text.slice(0, 240)}`);
  }
  let parsed: any = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  return {
    fileId: Number.isFinite(Number(parsed?.file_id)) ? Number(parsed.file_id) : null,
    key: typeof parsed?.key === "string" && parsed.key.trim().length > 0 ? parsed.key.trim() : null,
    summary: typeof parsed?.summary === "string" && parsed.summary.trim().length > 0 ? parsed.summary.trim() : null,
    summaryStatus:
      typeof parsed?.summary_status === "string" && parsed.summary_status.trim().length > 0
        ? parsed.summary_status.trim().toLowerCase()
        : null,
  };
}

export function registerEndpoints(
  app: Express,
  ui: Express,
): void {
  app.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  app.get("/intents", (req, res) => {
    const messageClass = typeof req.query?.class === "string" ? req.query.class : "";
    const rows = listDynamicIntents(messageClass);
    res.status(200).json({ success: true, intents: rows });
  });

  // POST /intents removed (managed via inbound messages)

  app.post("/receive-msg", async (req, res) => {
    const from = typeof req.body?.from === "string" ? req.body.from.trim() : "";
    const action = typeof req.body?.action === "string" ? req.body.action.trim() : "";
    const body = req.body ?? {};
    const bodyType = typeof body?.type === "string" ? body.type.trim() : "";
    const bodyMessage = typeof body?.message === "string" ? body.message.trim() : "";
    const bodyCaption =
      typeof body?.media?.caption === "string" ? body.media.caption : "";
    const bodyBase64 = typeof body?.media?.base64 === "string" ? body.media.base64.trim() : "";
    const bodyMimeType = typeof body?.media?.mimeType === "string" ? body.media.mimeType : "";
    const bodyMessageId = typeof body?.messageId === "string" ? body.messageId.trim() : "";
    let message = bodyMessage;
    let transcription = "";
    let uploadedFileId: number | null = null;
    let uploadedNonAudioWhatsappMedia = false;

    if (bodyType === "audio") {
      if (bodyBase64.length > 0) {
        const note = storeVoiceNote({
          base64: bodyBase64,
          metadata: {
            from,
            pushName: body?.pushName,
            isMe: body?.isMe,
            type: bodyType,
            messageId: body?.messageId,
            key: body?.key,
            media: {
              mimeType: bodyMimeType,
              caption: bodyCaption,
            },
          },
        });
        message = `VN-${note.id}`;
        console.log(
          `[voice-note] from=${from} id=${note.id} mimeType=${bodyMimeType || "unknown"} bytes=${bodyBase64.length}`,
        );
        try {
          transcription = (await transcribeVoiceNote(bodyBase64, { mimeType: bodyMimeType })).trim();
        } catch (error) {
          const msg = error instanceof Error ? error.message : "unknown error";
          console.warn(`[transcribe] failed: ${msg}`);
          res.status(503).json({
            success: false,
            code: 503,
            msg: "Voicenote transcribing is currently unavailble, please try again later",
          });
          return;
        }
      } else {
        message = bodyCaption;
      }
    } else if (isWhatsappInbound(from) && bodyBase64.length > 0) {
      try {
        const inferredFilename = inferFilename(body, bodyMimeType, bodyMessageId);
        const uploaded = await uploadToFileService({
          owner: "me",
          source: "whatsapp",
          sourceSender: from,
          sourceMessageId: bodyMessageId,
          caption: bodyCaption,
          mimeType: bodyMimeType,
          filename: inferredFilename,
          base64: bodyBase64,
        });
        uploadedFileId = uploaded.fileId;
        uploadedNonAudioWhatsappMedia = true;
        console.log(
          `[whatsapp-file] stored from=${from} id=${uploaded.fileId ?? "unknown"} key=${uploaded.key ?? "unknown"} mime=${bodyMimeType || "unknown"} summary=${uploaded.summary ? "yes" : "no"}`,
        );
      } catch (error) {
        const msg = error instanceof Error ? error.message : "unknown error";
        console.warn(`[whatsapp-file] upload failed: ${msg}`);
        res.status(503).json({
          success: false,
          code: 503,
          msg: "File upload is currently unavailable, please try again later",
        });
        return;
      }
      if (!message) {
        if (bodyCaption.trim().length > 0) {
          message = bodyCaption.trim();
        }
      }
    }
    const replyId =
      typeof req.body?.replyId === "string" && req.body.replyId.trim().length > 0
        ? req.body.replyId.trim()
        : undefined;

    if (bodyType === "cronicle_job" || action.startsWith("job_")) {
      res.status(200).json({ success: true, code: 200, msg: "ignored" });
      return;
    }

    if (from.startsWith("cron-") && action && action !== "job_start") {
      res.status(200).json({ success: true, code: 200, msg: "ignored" });
      return;
    }

    if (!from || !message) {
      if (uploadedNonAudioWhatsappMedia && from && !message) {
        const storedName = inferFilename(body, bodyMimeType, bodyMessageId);
        const idPart = uploadedFileId && uploadedFileId > 0 ? ` (ID ${uploadedFileId})` : "";
        const notice = `File stored${idPart}: ${storedName}. Summary is processing.`;
        await sendWhatsappStoredPdfNotice(from, notice).catch(() => {});
        res.status(200).json({ success: true, code: 200, msg: "" });
        return;
      }
      const safeBody =
        typeof body?.media?.base64 === "string"
          ? {
              ...body,
              media: {
                ...(typeof body.media === "object" && body.media ? body.media : {}),
                base64: "[omitted]",
              },
            }
          : body;
      console.warn(
        "[inbound-reject] missing fields",
        JSON.stringify({
          from,
          message,
          replyId,
          type: bodyType,
          contentType: req.headers["content-type"],
          body: safeBody,
        }),
      );
      res.status(400).json({ error: "`from` and `message` are required fields" });
      return;
    }

    if (from.startsWith("cron-")) {
      const detail = JSON.stringify(body);
      console.log(`[chronicle-inbound] from=${from} body=${detail}`);
      broadcastEvent("chronicle inbound", detail);
    }
    if (from.includes("@lid")) {
      const lid = from.trim();
      console.log(`[whatsapp-lid] inbound lid=${lid}`);
    }
    const loggedMessage = sanitizeMessageForLog(message);
    console.log(
      `[inbound] from=${from} replyId=${replyId ?? "none"} message=${loggedMessage}`,
    );
    console.log(
      `[inbound-body] ${JSON.stringify({
        from,
        message: loggedMessage,
        replyId: replyId ?? null,
        meta: sanitizeLogValue(typeof body.meta === "object" && body.meta ? body.meta : undefined),
      })}`,
    );

    const stored = storeIncomingMessage({ from, message, replyId });
    const messageForProcessing =
      transcription.length > 0 ? `VN-TRANSCRIBED:${transcription}` : message;
    const storedForProcessing =
      transcription.length > 0 ? storeIncomingMessage({ from, message: transcription, replyId }) : stored;
    const result = await classifyAndCompile(from, messageForProcessing, storedForProcessing.id);
    storeOutgoingMessage({
      inmessageId: storedForProcessing.id,
      message: result.msg,
    });
    console.log(
      `[inbound-reply] to=${from} replyId=${replyId ?? "none"} code=${result.code} msg=${result.msg}`,
    );
    console.log(`[final-reply] to=${from} msg=${result.msg}`);
    res.status(result.code).json(result);
  });

  app.post("/file/upload-status", (req, res) => {
    const filename = typeof req.body?.filename === "string" ? req.body.filename.trim() : "";
    const fileIdRaw = Number(req.body?.file_id);
    const fileId = Number.isFinite(fileIdRaw) && fileIdRaw > 0 ? String(Math.floor(fileIdRaw)) : "unknown";
    const summaryStatus =
      typeof req.body?.summary_status === "string" ? req.body.summary_status.trim().toLowerCase() : "unknown";
    const errorDetail = typeof req.body?.error === "string" ? req.body.error.trim() : "";
    const summaryRaw = typeof req.body?.summary === "string" ? req.body.summary.trim() : "";
    const summary = summaryRaw.length > 240 ? `${summaryRaw.slice(0, 237)}...` : summaryRaw;
    const baseLabel = filename || `file #${fileId}`;
    if (summaryStatus === "failed") {
      const detail = errorDetail
        ? `${baseLabel} summary failed: ${errorDetail}`
        : `${baseLabel} summary failed.`;
      broadcastEvent("file-upload", detail);
    }
    res.status(200).json({ success: true });
  });

  ui.get("/", (_req, res) => {
    res.status(200).type("html").send(readUiHtml());
  });

  ui.post("/upload-file", async (req, res) => {
    const owner = normalizeFileOwner(typeof req.body?.owner === "string" ? req.body.owner : "");
    const filename = typeof req.body?.filename === "string" ? req.body.filename.trim() : "";
    const mimeType = typeof req.body?.mimeType === "string" ? req.body.mimeType.trim() : "";
    const dataBase64 = typeof req.body?.dataBase64 === "string" ? req.body.dataBase64.trim() : "";
    const caption = typeof req.body?.caption === "string" ? req.body.caption : "";
    if (!filename || !dataBase64) {
      res.status(400).json({ success: false, message: "filename and dataBase64 are required" });
      return;
    }
    try {
      console.log(
        `[ui-upload] start owner=${owner} filename=${filename} mime=${mimeType || "application/octet-stream"} bytes(base64)=${dataBase64.length}`,
      );
      broadcastEvent("upload", `starting upload (${owner}): ${filename}`);
      const webhookToken = normalizeBearer(process.env.WEBHOOK_BEARER_TOKEN ?? "");
      const uploaded = await uploadToFileService({
        owner,
        source: "ui",
        sourceSender: owner === "sonja" ? "queue-ui-sonja" : "queue-ui",
        sourceMessageId: "",
        caption,
        mimeType: mimeType || "application/octet-stream",
        filename,
        base64: dataBase64,
        callbackUrl: resolveUiUploadCallbackUrl(),
        callbackAuthorization: webhookToken ? `Bearer ${webhookToken}` : "",
      });
      console.log(
        `[ui-upload] success owner=${owner} filename=${filename} fileId=${uploaded.fileId ?? "unknown"} key=${uploaded.key ?? "unknown"} summary_status=${uploaded.summaryStatus ?? "pending"}`,
      );
      broadcastEvent("upload", `${owner}: ${filename} uploaded (id ${uploaded.fileId ?? "unknown"})`);
      res.status(201).json({
        success: true,
        file_id: uploaded.fileId,
        key: uploaded.key,
        summary: uploaded.summary,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : "upload failed";
      console.warn(`[ui-upload] failed owner=${owner} filename=${filename} error=${msg}`);
      broadcastEvent("upload", `${owner}: ${filename} upload failed: ${msg}`);
      res.status(503).json({ success: false, message: msg });
    }
  });
}

function resolveUiWebsocketUrl(): string {
  const raw = (process.env.UI_WEBSOCKET_URL ?? "").trim() || "localhost";
  const port = Number(process.env.WEBHOOK_PORT) || 3350;
  if (raw.startsWith("ws://") || raw.startsWith("wss://")) {
    return `${raw.replace(/\/+$/, "")}/ws`;
  }
  return `ws://${raw}:${port}/ws`;
}

function resolveUiHistoryDays(): string {
  const parsed = Number(process.env.UI_HISTORY_DAYS ?? "");
  if (Number.isFinite(parsed) && parsed > 0) {
    return String(parsed);
  }
  return "1";
}

function resolveShowSendNoCacheButton(): string {
  const raw = String(process.env.UI_SHOW_SEND_NO_CACHE_BUTTON ?? "false").trim().toLowerCase();
  return raw === "true" || raw === "1" || raw === "yes" || raw === "on" ? "true" : "false";
}

function resolveS3BrowserBaseUrl(): string {
  const raw = (process.env.UI_S3_BROWSER_BASE_URL ?? "").trim();
  if (raw.length > 0) {
    return raw;
  }
  return "http://192.168.55.113:9001";
}

function readUiHtml(): string {
  const uiPath = path.resolve("src", "ui", "index.html");
  return fs
    .readFileSync(uiPath, "utf-8")
    .replaceAll("{{uiWsUrl}}", resolveUiWebsocketUrl())
    .replaceAll("{{historyDays}}", resolveUiHistoryDays())
    .replaceAll("{{showSendNoCacheButton}}", resolveShowSendNoCacheButton())
    .replaceAll("{{s3BrowserBaseUrl}}", resolveS3BrowserBaseUrl());
}
