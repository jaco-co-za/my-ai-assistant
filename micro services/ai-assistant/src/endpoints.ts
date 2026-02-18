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

function isWhatsappInbound(from: string): boolean {
  const value = String(from || "").toLowerCase();
  return value.includes("@lid") || value.includes("whatsapp");
}

function inferFilename(body: any, bodyMimeType: string): string {
  const explicitName =
    typeof body?.media?.filename === "string" && body.media.filename.trim().length > 0
      ? body.media.filename.trim()
      : "";
  if (explicitName) {
    return explicitName;
  }
  const normalizedMime = String(bodyMimeType || "").toLowerCase();
  if (normalizedMime.includes("pdf")) {
    return "whatsapp-file.pdf";
  }
  if (normalizedMime.startsWith("image/")) {
    return "whatsapp-image";
  }
  if (normalizedMime.startsWith("video/")) {
    return "whatsapp-video";
  }
  return "whatsapp-file.bin";
}

async function uploadWhatsappMediaToFileService(args: {
  from: string;
  messageId: string;
  caption: string;
  mimeType: string;
  filename: string;
  base64: string;
}): Promise<{ fileId: number | null; key: string | null; summary: string | null }> {
  const url = resolveFileUploadUrl(process.env.FILE_MICRO_SERVICE_URL);
  const token = normalizeBearer(process.env.FILE_MICRO_SERVICE_AUTH ?? process.env.WEBHOOK_BEARER_TOKEN ?? "");
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      source: "whatsapp",
      source_sender: args.from,
      source_message_id: args.messageId || null,
      caption: args.caption || null,
      filename: args.filename,
      content_type: args.mimeType || "application/octet-stream",
      data_base64: args.base64,
    }),
  });
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
        const uploaded = await uploadWhatsappMediaToFileService({
          from,
          messageId: bodyMessageId,
          caption: bodyCaption,
          mimeType: bodyMimeType,
          filename: inferFilename(body, bodyMimeType),
          base64: bodyBase64,
        });
        uploadedFileId = uploaded.fileId;
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
        } else if (uploadedFileId) {
          message = `FILE-${uploadedFileId}`;
        } else {
          message = "File uploaded";
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
    console.log(
      `[inbound] from=${from} replyId=${replyId ?? "none"} message=${message}`,
    );
    console.log(
      `[inbound-body] ${JSON.stringify({
        from,
        message,
        replyId: replyId ?? null,
        meta: typeof body.meta === "object" && body.meta ? body.meta : undefined,
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

  ui.get("/", (_req, res) => {
    res.status(200).type("html").send(readUiHtml());
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
