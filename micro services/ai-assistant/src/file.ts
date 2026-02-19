import type { BrokerResult } from "./messageBroker.js";
import { intentClassifier } from "./ollamaClient.js";

const DEFAULT_FILE_QUERY_URL = "http://192.168.55.73:3224/llm-query";
const FILE_TIMEOUT_MS = Number(process.env.FILE_TIMEOUT_MS ?? "") > 0 ? Number(process.env.FILE_TIMEOUT_MS) : 120_000;
const DEFAULT_WHATSAPP_MESSAGE_URL = "http://localhost:8085/message";

type ParsedFileResponse = {
  success?: unknown;
  type?: unknown;
  message?: unknown;
  rows?: unknown;
  attachments?: unknown;
};

function resolveFileQueryUrl(raw?: string): string {
  const value = (raw || "").trim();
  if (!value) {
    return DEFAULT_FILE_QUERY_URL;
  }
  if (value.startsWith("http://") || value.startsWith("https://")) {
    return value;
  }
  return `http://${value}`;
}

function resolveWhatsappMessageUrl(raw?: string): string {
  const value = (raw || "").trim();
  if (!value) {
    return DEFAULT_WHATSAPP_MESSAGE_URL;
  }
  if (value.startsWith("http://") || value.startsWith("https://")) {
    return value;
  }
  return `http://${value}`;
}

function isWhatsappSender(from: string): boolean {
  const value = (from || "").trim().toLowerCase();
  return value.includes("@lid") || value.endsWith("@c.us") || value.endsWith("@g.us");
}

function normalizeWhatsappChatId(from: string): string {
  return (from || "").trim();
}

function normalizeAttachments(value: unknown): NonNullable<BrokerResult["attachments"]> | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized = value
    .map((entry) => {
      const row = (entry ?? {}) as Record<string, unknown>;
      const attachmentId = Number(row.attachment_id);
      const filename = typeof row.filename === "string" ? row.filename.trim() : "";
      const contentType = typeof row.content_type === "string" ? row.content_type.trim() : "application/octet-stream";
      const dataBase64 = typeof row.data_base64 === "string" ? row.data_base64.trim() : "";
      if (!filename || !dataBase64) {
        return null;
      }
      return {
        attachmentId: Number.isFinite(attachmentId) && attachmentId > 0 ? attachmentId : undefined,
        filename,
        contentType,
        dataBase64,
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  return normalized.length > 0 ? normalized : undefined;
}

async function postWhatsappDocument(
  chatId: string,
  attachment: NonNullable<BrokerResult["attachments"]>[number],
  caption: string,
): Promise<void> {
  const url = resolveWhatsappMessageUrl(process.env.WHATSAPP_MESSAGE_URL);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const auth = (process.env.WHATSAPP_MESSAGE_AUTH ?? "").trim();
  if (auth) {
    headers.Authorization = auth;
  }
  const mimetype = attachment.contentType || "application/octet-stream";
  const mediaType = mimetype.toLowerCase().startsWith("image/") ? "image" : "document";
  const media: Record<string, unknown> = {
    type: mediaType,
    caption,
    mimetype,
    data: attachment.dataBase64,
  };
  if (mediaType !== "image" && attachment.filename) {
    media.filename = attachment.filename;
  }
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ chatId, media }),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`WhatsApp media send failed (${response.status}): ${body}`);
  }
}

async function postWhatsappAttachments(
  from: string,
  attachments: NonNullable<BrokerResult["attachments"]>,
  caption: string,
): Promise<void> {
  const chatId = normalizeWhatsappChatId(from);
  if (!chatId) {
    throw new Error("Missing WhatsApp chat id");
  }
  for (const attachment of attachments) {
    await postWhatsappDocument(chatId, attachment, caption);
  }
}

async function postFileQuery(payload: Record<string, unknown>): Promise<string> {
  const url = resolveFileQueryUrl(process.env.FILE_MICRO_SERVICE_QUERY_URL || process.env.FILE_MICRO_SERVICE_URL);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const auth = (process.env.FILE_MICRO_SERVICE_AUTH ?? "").trim();
  if (auth) {
    headers.Authorization = auth;
  }
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(FILE_TIMEOUT_MS),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`File service request failed (${response.status}): ${text}`);
  }
  return text;
}

export async function handleFile(
  uuid: string,
  message: string,
  from: string,
  options?: { skipCache?: boolean },
): Promise<BrokerResult> {
  const skipCache = Boolean(options?.skipCache);
  const intent = await intentClassifier(message, "file", { skipCache });
  const verbLabel = intent.verb ? ` | Verb: ${intent.verb}` : "";
  const llmResult = `Class: file | Intent: ${intent.intent || "query"}${verbLabel}`;
  const sourceChannel = isWhatsappSender(from) ? "whatsapp" : from;
  const payload = {
    prompt: message,
    result: llmResult,
    source_channel: sourceChannel,
    source_from: from,
    skip_cache: skipCache,
  };
  try {
    const responseText = await postFileQuery(payload);
    const parsed = JSON.parse(responseText.trim()) as ParsedFileResponse;
    const responseType = typeof parsed.type === "string" ? parsed.type.trim().toLowerCase() : "";
    const responseMessage = typeof parsed.message === "string" ? parsed.message.trim() : responseText;
    if (responseType === "attachment") {
      const attachments = normalizeAttachments(parsed.attachments);
      if (isWhatsappSender(from) && attachments && attachments.length > 0) {
        await postWhatsappAttachments(from, attachments.slice(0, 3), responseMessage || "Requested files");
        return { success: true, code: 200, msg: "", uuid };
      }
      return { success: true, code: 200, msg: responseMessage, uuid, attachments };
    }
    return { success: true, code: 200, msg: responseMessage, uuid };
  } catch (error) {
    const msg = error instanceof Error ? error.message : "unknown error";
    return { success: false, code: 503, msg: `File service is unavailable: ${msg}`, uuid };
  }
}
