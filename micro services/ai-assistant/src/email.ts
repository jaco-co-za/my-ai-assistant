import type { BrokerResult } from "./messageBroker.js";
import { intentClassifier } from "./ollamaClient.js";
import { getDatabase } from "./database.js";
import { randomUUID } from "node:crypto";

const DEFAULT_EMAIL_URL = "http://192.168.55.73:3222/llm-query";
const DEFAULT_WHATSAPP_MESSAGE_URL = "http://localhost:8085/message";
const EMAIL_TIMEOUT_MS = Number(process.env.EMAIL_TIMEOUT_MS ?? "") > 0
  ? Number(process.env.EMAIL_TIMEOUT_MS)
  : 300_000;
const CONFIRM_TTL_MS = Number(process.env.CONFIRM_TTL_SEC ?? "") > 0
  ? Number(process.env.CONFIRM_TTL_SEC) * 1000
  : 120_000;

function resolveEmailUrl(raw?: string): string {
  const value = (raw || "").trim();
  if (!value) {
    return DEFAULT_EMAIL_URL;
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

function normalizeWhatsappChatId(from: string): string {
  return (from || "").trim();
}

function isWhatsappSender(from: string): boolean {
  const value = (from || "").trim().toLowerCase();
  return value.includes("@lid") || value.endsWith("@c.us") || value.endsWith("@g.us");
}

async function postEmailQuery(payload: Record<string, unknown>): Promise<string> {
  const url = resolveEmailUrl(process.env.EMAIL_MICRO_SERVICE_URL);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(EMAIL_TIMEOUT_MS),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown fetch error";
    throw new Error(`Email endpoint unreachable at ${url}: ${message}`);
  }
  const text = await response.text();
  return text;
}

type EmailAttachmentResponse = {
  attachment_id?: unknown;
  filename?: unknown;
  content_type?: unknown;
  data_base64?: unknown;
};

type EmailAttachmentRow = {
  attachment_id?: unknown;
  filename?: unknown;
  content_type?: unknown;
};

type ParsedEmailResponse = {
  confirm?: unknown;
  message?: unknown;
  type?: unknown;
  notify?: unknown;
  ai_summary?: unknown;
  summary?: unknown;
  email_id?: unknown;
  emailId?: unknown;
  id?: unknown;
  attachments?: unknown;
  rows?: unknown;
  ui_actions?: unknown;
  uiActions?: unknown;
  follow_up_question?: unknown;
  followup_question?: unknown;
  "follow-up-question"?: unknown;
  email?: unknown;
  email_viewer_rows?: unknown;
};

type ParsedEmailViewerRow = {
  id: number;
  from_raw: string;
  to_raw: string;
  subject: string;
  received_at: string;
  folder: string;
  subfolder: string;
  body_text: string;
  body_html: string;
  attachments: string;
  attachment_ids: string;
  ai_summary: string;
  summary: string;
};

type ParsedUiAction = {
  type?: unknown;
  label?: unknown;
  text?: unknown;
};

function inferBuiltInEmailIntent(message: string): { intent: string; verb: string } | null {
  const lowered = message.toLowerCase();
  const hasMailWord = /\b(mail|email|mails|emails|inbox|message|messages)\b/.test(lowered);
  const hasPossessiveMailList =
    /\bmy\b/.test(lowered) &&
    /\b(mail|mails|email|emails|inbox)\b/.test(lowered);
  const hasShowVerb = /\b(show|list|display|check|view|read)\b/.test(lowered);
  const hasRecencyOrCount = /\b(last|latest|recent|newest|oldest|first|\d+)\b/.test(lowered);
  const hasPossessiveListPattern =
    /\bmy\b/.test(lowered) &&
    /\b(last|latest|recent|newest|oldest|first)\b/.test(lowered);

  if (hasMailWord && hasShowVerb && hasRecencyOrCount) {
    return { intent: "show", verb: "show" };
  }
  if (hasMailWord && hasShowVerb) {
    return { intent: "show", verb: "show" };
  }
  if (hasMailWord && hasPossessiveMailList) {
    return { intent: "show", verb: "show" };
  }
  if (hasMailWord && (hasRecencyOrCount || hasPossessiveListPattern)) {
    return { intent: "show", verb: "show" };
  }

  const hasCountVerb = /\b(count|how many|number of)\b/.test(lowered);
  const hasSentWord = /\b(sent|sent mail|sent email|outbox)\b/.test(lowered);
  if (hasMailWord && hasCountVerb && hasSentWord) {
    return { intent: "count-sent", verb: "count" };
  }

  const hasMarkAllReadPattern =
    /\bmark\b/.test(lowered) &&
    /\ball\b/.test(lowered) &&
    /\b(mail|email|emails|mails)\b/.test(lowered) &&
    /\bread\b/.test(lowered);
  if (hasMarkAllReadPattern) {
    return { intent: "mark-read", verb: "mark" };
  }
  const hasMailReference = /\b(mail|email)\b/.test(lowered);
  const hasAttachmentWord = /\b(attachment|pdf)\b/.test(lowered);
  const hasAttachmentVerb = /\b(download|get|fetch|retrieve|show|open|view)\b/.test(lowered);
  const hasIdReference = /\b(mail|email)\s*#?\s*\d+\b/.test(lowered);
  const hasNumericReference = /\bfrom\s+\d{3,}\b/.test(lowered);
  if (hasAttachmentWord && (hasAttachmentVerb || hasIdReference || hasMailReference || hasNumericReference)) {
    return { intent: "download-attachment", verb: "download" };
  }
  return null;
}

function shouldForceSkipCacheForSenderQuery(message: string): boolean {
  const lowered = String(message || "").toLowerCase();
  const hasSenderScope = /\bfrom\s+[a-z0-9._%+\-@]{2,}\b/.test(lowered);
  const hasMailShape = /\b(mail|email|message|inbox|sent)\b/.test(lowered);
  return hasSenderScope && hasMailShape;
}

function isReadEmailRequest(message: string, intent: { intent?: string; verb?: string } | null | undefined): boolean {
  const raw = String(message || "").trim().toLowerCase();
  if (/^\s*read\s+email\s+#?\d+\s*$/i.test(raw)) {
    return true;
  }
  const intentValue = String(intent?.intent || "").trim().toLowerCase();
  const verbValue = String(intent?.verb || "").trim().toLowerCase();
  return intentValue === "read" || verbValue === "read";
}

function isReadFullEmailRequest(message: string): boolean {
  const raw = String(message || "").trim().toLowerCase();
  return /^\s*read\s+full\s+email\s+#?\d+\s*$/i.test(raw);
}

function extractEmailIdFromMessage(message: string): string {
  const match = String(message || "").match(/\bemail\s+#?\s*(\d+)\b/i);
  return match ? String(match[1] || "").trim() : "";
}

function buildWhatsappReadSummary(parsed: ParsedEmailResponse, fallbackMessage: string, userMessage: string): string {
  const summaryRaw =
    (typeof parsed.ai_summary === "string" && parsed.ai_summary.trim()) ||
    (typeof parsed.summary === "string" && parsed.summary.trim()) ||
    "";
  const emailId =
    (typeof parsed.email_id === "number" ? String(parsed.email_id) : "") ||
    (typeof parsed.email_id === "string" ? parsed.email_id.trim() : "") ||
    (typeof parsed.emailId === "number" ? String(parsed.emailId) : "") ||
    (typeof parsed.emailId === "string" ? parsed.emailId.trim() : "") ||
    (typeof parsed.id === "number" ? String(parsed.id) : "") ||
    (typeof parsed.id === "string" ? parsed.id.trim() : "") ||
    extractEmailIdFromMessage(userMessage);

  const summary = summaryRaw || String(fallbackMessage || "").trim();
  if (!summary) {
    return emailId ? `Email ${emailId} summary is unavailable.` : "Email summary is unavailable.";
  }
  return emailId ? `Email ${emailId} summary:\n${summary}` : summary;
}

function parseAddressText(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  return "";
}

function looksLikeHtml(value: string): boolean {
  return /<\/?[a-z][\s\S]*>/i.test(value);
}

function splitCachedBody(value: string): { bodyHtml: string; bodyText: string } {
  const raw = String(value || "").trim();
  if (!raw) {
    return { bodyHtml: "", bodyText: "" };
  }
  if (looksLikeHtml(raw)) {
    return { bodyHtml: raw, bodyText: "" };
  }
  return { bodyHtml: "", bodyText: raw };
}

function parseEmailViewerPayload(
  parsed: ParsedEmailResponse,
  summaryFallback: string,
  userMessage: string,
): Record<string, unknown> | undefined {
  const parsedEmail = parsed.email && typeof parsed.email === "object" && !Array.isArray(parsed.email)
    ? parsed.email as Record<string, unknown>
    : {};
  const emailId =
    (typeof parsed.email_id === "number" ? String(parsed.email_id) : "") ||
    (typeof parsed.email_id === "string" ? parsed.email_id.trim() : "") ||
    (typeof parsed.emailId === "number" ? String(parsed.emailId) : "") ||
    (typeof parsed.emailId === "string" ? parsed.emailId.trim() : "") ||
    (typeof parsed.id === "number" ? String(parsed.id) : "") ||
    (typeof parsed.id === "string" ? parsed.id.trim() : "") ||
    (typeof parsedEmail.id === "number" ? String(parsedEmail.id) : "") ||
    (typeof parsedEmail.id === "string" ? parsedEmail.id.trim() : "") ||
    extractEmailIdFromMessage(userMessage);
  if (!emailId) {
    return undefined;
  }
  const fromValue = parseAddressText(parsedEmail.from_raw) || parseAddressText((parsed as unknown as Record<string, unknown>).from);
  const toValue = parseAddressText(parsedEmail.to_raw) || parseAddressText((parsed as unknown as Record<string, unknown>).to);
  const subjectValue = parseAddressText(parsedEmail.subject) || parseAddressText((parsed as unknown as Record<string, unknown>).subject);
  const receivedValue = parseAddressText(parsedEmail.received_at) || parseAddressText((parsed as unknown as Record<string, unknown>).received_at);
  const summaryValue =
    (typeof parsed.ai_summary === "string" ? parsed.ai_summary.trim() : "") ||
    (typeof parsed.summary === "string" ? parsed.summary.trim() : "") ||
    summaryFallback.trim();
  const bodyFromParsedEmail = typeof parsedEmail.body === "string" ? parsedEmail.body : "";
  const cachedBody = splitCachedBody(bodyFromParsedEmail);
  const resolvedBodyHtml = cachedBody.bodyHtml;
  const resolvedBodyText = cachedBody.bodyText;

  return {
    email_id: emailId,
    id: emailId,
    from: fromValue,
    to: toValue,
    subject: subjectValue,
    received_at: receivedValue,
    folder: "",
    subfolder: "",
    body_text: resolvedBodyText,
    body_html: resolvedBodyHtml,
    viewer_mode: resolvedBodyHtml ? "cache-html" : "cache-text",
    ai_summary: summaryValue,
    summary: summaryValue,
  };
}

function parseEmailViewerRowsPayload(parsed: ParsedEmailResponse): ParsedEmailViewerRow[] | undefined {
  const raw = parsed.email_viewer_rows;
  if (!Array.isArray(raw) || raw.length === 0) {
    return undefined;
  }
  const normalized = raw
    .map((entry) => {
      const row = entry && typeof entry === "object" ? entry as Record<string, unknown> : null;
      if (!row) {
        return null;
      }
      const idRaw = typeof row.id === "number" ? row.id : Number(row.id);
      const id = Number.isFinite(idRaw) && idRaw > 0 ? Math.floor(idRaw) : 0;
      if (!id) {
        return null;
      }
      return {
        id,
        from_raw: typeof row.from_raw === "string" ? row.from_raw : "",
        to_raw: typeof row.to_raw === "string" ? row.to_raw : "",
        subject: typeof row.subject === "string" ? row.subject : "",
        received_at: typeof row.received_at === "string" ? row.received_at : "",
        folder: typeof row.folder === "string" ? row.folder : "",
        subfolder: typeof row.subfolder === "string" ? row.subfolder : "",
        body_text: typeof row.body_text === "string" ? row.body_text : "",
        body_html: typeof row.body_html === "string" ? row.body_html : "",
        attachments: typeof row.attachments === "string" ? row.attachments : "",
        attachment_ids: typeof row.attachment_ids === "string" ? row.attachment_ids : "",
        ai_summary: typeof row.ai_summary === "string" ? row.ai_summary : "",
        summary: typeof row.summary === "string" ? row.summary : "",
      };
    })
    .filter((entry): entry is ParsedEmailViewerRow => entry !== null);
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeAttachments(value: unknown): BrokerResult["attachments"] {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized = value
    .map((entry) => {
      const row = (entry ?? {}) as EmailAttachmentResponse;
      const attachmentId = typeof row.attachment_id === "number" ? row.attachment_id : undefined;
      const filename = typeof row.filename === "string" ? row.filename.trim() : "";
      const contentType = typeof row.content_type === "string" ? row.content_type.trim() : "";
      const dataBase64 = typeof row.data_base64 === "string" ? row.data_base64.trim() : "";
      if (!filename || !dataBase64) {
        return null;
      }
      return {
        attachmentId,
        filename,
        contentType: contentType || "application/octet-stream",
        dataBase64,
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeAttachmentRows(value: unknown): Array<{
  attachmentId: number;
  filename: string;
  contentType?: string;
}> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => {
      const row = (entry ?? {}) as EmailAttachmentRow;
      const attachmentId = typeof row.attachment_id === "number" ? row.attachment_id : 0;
      const filename = typeof row.filename === "string" ? row.filename.trim() : "";
      const contentType = typeof row.content_type === "string" ? row.content_type.trim() : "";
      if (!attachmentId || !filename) {
        return null;
      }
      return {
        attachmentId,
        filename,
        contentType: contentType || undefined,
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
}

function normalizeUiActions(value: unknown): BrokerResult["uiActions"] {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized = value
    .map((entry) => {
      const row = (entry ?? {}) as ParsedUiAction;
      const type = typeof row.type === "string" ? row.type.trim().toLowerCase() : "";
      const text = typeof row.text === "string" ? row.text.trim() : "";
      const label = typeof row.label === "string" ? row.label.trim() : "";
      if (type !== "prefill" || !text) {
        return null;
      }
      return {
        type: "prefill",
        label: label || "Use Suggested Reply",
        text,
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  return normalized.length > 0 ? normalized : undefined;
}

function buildAttachmentListMessage(
  rows: Array<{ attachmentId: number; filename: string; contentType?: string }>,
  fallback: string,
): string {
  if (rows.length === 0) {
    return fallback;
  }
  const lines = rows.map((row) => {
    const typePart = row.contentType ? ` (${row.contentType})` : "";
    return `${row.attachmentId}: ${row.filename}${typePart}`;
  });
  return `Attachments found:\n${lines.join("\n")}\n\nReply with: display attachment <id>`;
}

function shouldSendAttachmentListOnly(userMessage: string, attachmentCount: number): boolean {
  const lowered = userMessage.toLowerCase();
  const asksList = /\battachments\b/.test(lowered) || /\blist\b/.test(lowered) || /\bshow\b/.test(lowered);
  return attachmentCount > 1 || asksList;
}

function isFollowUpQuestionFlag(parsed: ParsedEmailResponse): boolean {
  const values = [parsed["follow-up-question"], parsed.follow_up_question, parsed.followup_question];
  return values.some((value) => value === true || value === 1 || value === "true" || value === "1");
}

function isNotifyFlag(parsed: ParsedEmailResponse): boolean {
  const value = parsed.notify;
  return value === true || value === 1 || value === "true" || value === "1";
}

function getRecentConversationContext(sessionKey: string, currentMessageId: string, limit = 5): string {
  const key = sessionKey.trim();
  if (!key) {
    return "";
  }
  const db = getDatabase();
  const rows = db.prepare(
    `SELECT i.message AS user_message
     FROM inmessages i
     WHERE i."from" = ? AND i.id != ?
     ORDER BY i.received_at DESC
     LIMIT ?`,
  ).all(key, currentMessageId, limit) as Array<{ user_message?: string }>;
  if (!rows || rows.length === 0) {
    return "";
  }
  const chronological = rows.reverse();
  const lines: string[] = ["Recent user messages context:"];
  for (const row of chronological) {
    lines.push(`User: ${(row.user_message || "").trim() || "-"}`);
  }
  return lines.join("\n");
}

function buildIntentRetryMessage(message: string, context: string): string {
  if (!context) {
    return message;
  }
  return `${context}\n\nCurrent user message: ${message}`;
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
  console.log(
    `[whatsapp-attachment] sending chatId=${chatId} filename=${attachment.filename} mediaType=${mediaType} mimetype=${mimetype} bytes(base64)=${attachment.dataBase64.length} url=${url}`,
  );
  const media: Record<string, unknown> = {
    type: mediaType,
    caption,
    mimetype,
    data: attachment.dataBase64,
  };
  if (mediaType !== "image" && attachment.filename) {
    media.filename = attachment.filename;
  }
  const payload = {
    chatId,
    media,
  };
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  const body = await response.text();
  const preview = body.length > 400 ? `${body.slice(0, 400)}...<truncated>` : body;
  if (response.ok) {
    console.log(
      `[whatsapp-attachment] sent chatId=${chatId} filename=${attachment.filename} status=${response.status} body=${preview}`,
    );
    return;
  }
  throw new Error(`WhatsApp media send failed (${response.status}): ${preview}`);
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
  console.log(`[whatsapp-attachment] begin from=${from} chatId=${chatId} count=${attachments.length}`);
  for (const attachment of attachments) {
    await postWhatsappDocument(chatId, attachment, caption);
  }
  console.log(`[whatsapp-attachment] complete chatId=${chatId} count=${attachments.length}`);
}

function createEmailConfirmation(from: string, url: string, payload: Record<string, unknown>): void {
  const db = getDatabase();
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + CONFIRM_TTL_MS).toISOString();
  const confirmationPayload = JSON.stringify({ replyUrl: url, payload });
  db.prepare(
    `INSERT INTO pending_confirmations (id, "from", action, payload, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, from, "app-confirm", confirmationPayload, createdAt, expiresAt);
}

export async function handleEmail(
  uuid: string,
  message: string,
  from: string,
  options?: { skipCache?: boolean },
): Promise<BrokerResult> {
  const skipCache = Boolean(options?.skipCache);
  const forceSkipCache = shouldForceSkipCacheForSenderQuery(message);
  const effectiveSkipCache = skipCache || forceSkipCache;
  const builtInIntent = inferBuiltInEmailIntent(message);
  let intent = builtInIntent ?? await intentClassifier(message, "email", { skipCache: effectiveSkipCache });
  if ((!intent.intent || intent.intent === "unknown") && !builtInIntent) {
    const context = getRecentConversationContext(from, uuid, 5);
    if (context) {
      const retryMessage = buildIntentRetryMessage(message, context);
      intent = await intentClassifier(retryMessage, "email", { skipCache: effectiveSkipCache });
    }
  }

  if (!intent.intent || intent.intent === "unknown") {
    return {
      success: false,
      code: 400,
      msg:
        'Unable to parse intent. To add example: intent add class=email intent=count-sent verb=count desc="count sent emails".',
      uuid,
    };
  }

  const verbLabel = intent.verb ? ` | Verb: ${intent.verb}` : "";
  const llmResult = `Class: email | Intent: ${intent.intent}${verbLabel}`;
  const sourceChannel = from.includes("@lid") || from.endsWith("@c.us") || from.endsWith("@g.us")
    ? "whatsapp"
    : from;
  const payload = {
    prompt: message,
    result: llmResult,
    source_channel: sourceChannel,
    source_from: from,
    skip_cache: effectiveSkipCache,
  };

  try {
    const responseText = await postEmailQuery(payload);
    const trimmed = responseText.trim();
    try {
      const parsed = JSON.parse(trimmed) as ParsedEmailResponse;
      const confirm = parsed?.confirm === true;
      const confirmMessage = typeof parsed?.message === "string" ? parsed.message.trim() : "";
      if (confirm && confirmMessage) {
        const url = resolveEmailUrl(process.env.EMAIL_MICRO_SERVICE_URL);
        createEmailConfirmation(from, url, payload);
        return {
          success: true,
          code: 200,
          msg: `${confirmMessage} Reply YES to confirm or NO to cancel.`,
          uuid,
        };
      }
      const responseMessage = confirmMessage || responseText;
      const uiActions = normalizeUiActions(parsed.ui_actions ?? parsed.uiActions);
      const followUpQuestion = isFollowUpQuestionFlag(parsed);
      const notify = isNotifyFlag(parsed);
      const responseType = typeof parsed?.type === "string" ? parsed.type.trim().toLowerCase() : "";
      const viewerPayloadSingle =
        from === "queue-ui"
          ? parseEmailViewerPayload(parsed, responseMessage, message)
          : undefined;
      const viewerRowsPayload =
        from === "queue-ui"
          ? parseEmailViewerRowsPayload(parsed)
          : undefined;
      const viewerPayload =
        viewerPayloadSingle || viewerRowsPayload
          ? {
              ...(viewerPayloadSingle ?? {}),
              ...(viewerRowsPayload ? { email_viewer_rows: viewerRowsPayload } : {}),
            }
          : undefined;
      if (responseType === "attachment") {
        const attachments = normalizeAttachments(parsed.attachments);
        const rows = normalizeAttachmentRows(parsed.rows);
        console.log(
          `[email] attachment response from=${from} parsed=${attachments ? attachments.length : 0} type=${responseType}`,
        );
        if (from === "queue-ui") {
          return { success: true, code: 200, msg: responseMessage, uuid, attachments, payload: viewerPayload, uiActions, notify };
        }
        if (isWhatsappSender(from)) {
          const attachmentCount = attachments ? attachments.length : 0;
          const fallbackRows = (attachments ?? [])
            .filter((item) => typeof item.attachmentId === "number")
            .map((item) => ({
              attachmentId: item.attachmentId as number,
              filename: item.filename,
              contentType: item.contentType,
            }));
          const rowsForList = rows.length > 0 ? rows : fallbackRows;
          if (rowsForList.length > 0 && shouldSendAttachmentListOnly(message, attachmentCount)) {
            const listMessage = buildAttachmentListMessage(rowsForList, responseMessage);
            return { success: true, code: 200, msg: listMessage, uuid };
          }
          if (attachments && attachments.length > 0) {
            try {
              await postWhatsappAttachments(from, attachments, responseMessage);
              return { success: true, code: 200, msg: "", uuid };
            } catch (error) {
              const msg = error instanceof Error ? error.message : "unknown error";
              console.warn(`[whatsapp-attachment] failed: ${msg}`);
              return { success: false, code: 503, msg: "Failed to send WhatsApp attachment", uuid };
            }
          }
        }
        return { success: true, code: 200, msg: responseMessage, uuid, payload: viewerPayload, uiActions, notify };
      }
      if (followUpQuestion) {
        return { success: true, code: 200, msg: responseMessage, uuid, payload: viewerPayload, followUpRoute: "email", uiActions, notify };
      }
      if (isWhatsappSender(from) && isReadEmailRequest(message, intent) && !isReadFullEmailRequest(message)) {
        const summaryMessage = buildWhatsappReadSummary(parsed, responseMessage, message);
        return { success: true, code: 200, msg: summaryMessage, uuid, uiActions, notify };
      }
      if (confirmMessage) {
        return { success: true, code: 200, msg: confirmMessage, uuid, payload: viewerPayload, uiActions, notify };
      }
    } catch {
      // ignore parse errors, fall back to raw response
    }
    return { success: true, code: 200, msg: responseText, uuid };
  } catch (error) {
    const msg = error instanceof Error ? error.message : "unknown error";
    console.warn(`[email] request failed: ${msg}`);
    return { success: false, code: 503, msg: `Email service is unavailable: ${msg}`, uuid };
  }
}
