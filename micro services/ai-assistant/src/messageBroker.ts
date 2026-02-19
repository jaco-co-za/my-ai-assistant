import { v4 as uuidv4 } from "uuid";
import { getDatabase } from "./database.js";
import { getClassificationCacheTag, getLlmProviderLabel, rawOllamaRequest, topicClassifier } from "./ollamaClient.js";
import { broadcastEvent } from "./websocket.js";
import type { TopicResult } from "./ollamaClient.js";
import { handleHomeAssistant } from "./homeAssistant.js";
import { handleEmail } from "./email.js";
import { handleFile } from "./file.js";
import { handleGeneral } from "./general.js";
import { handleSchedule } from "./schedule.js";
import { handleCronQuery } from "./cronQuery.js";
import { handleCronRemove } from "./cronRemove.js";
import { handleWeb } from "./web.js";
import { addDynamicIntent, clearDynamicIntents, listDynamicIntents, removeDynamicIntentById } from "./dynamicIntents.js";
import { sendPushoverNotification } from "./pushover.js";

export type IncomingMessage = {
  from: string;
  message: string;
  replyId?: string;
};

export type StoredIncomingMessage = {
  id: string;
  from: string;
  message: string;
  replyId?: string;
  receivedAt: string;
};

export type OutgoingMessage = {
  message: string;
  inmessageId?: string;
};

export type StoredOutgoingMessage = {
  id: string;
  inmessageId?: string;
  message: string;
  createdAt: string;
};

export type StoredVoiceNote = {
  id: string;
  base64: string;
  metadata: string;
  createdAt: string;
};

export type StoredCron = {
  id: number;
  inmessageId?: string;
  from: string;
  message: string;
  cron: string;
  runAt?: string;
  isRecurring: boolean;
  active: boolean;
  timezone?: string;
  summary?: string;
  action?: string;
  chronicleEventId?: string;
  lastRunAt?: string;
  lastResult?: string;
  lastError?: string;
  rawJson: string;
  createdAt: string;
};

export type StoredCronRun = {
  id: string;
  cronId: number;
  inmessageId?: string;
  status: string;
  result?: string;
  error?: string;
  createdAt: string;
};
export type BrokerResult = {
  success: boolean;
  code: number;
  msg: string;
  uuid?: string;
  followUpRoute?: string;
  notify?: boolean;
  payload?: Record<string, unknown>;
  uiActions?: {
    type: string;
    label: string;
    text: string;
  }[];
  attachments?: {
    attachmentId?: number;
    filename: string;
    contentType: string;
    dataBase64: string;
  }[];
};

export type CompileOptions = {
  skipCache?: boolean;
};



const db = getDatabase();

const CLASSIFICATION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CONFIRM_TTL_MS = Number(process.env.CONFIRM_TTL_SEC ?? "") > 0
  ? Number(process.env.CONFIRM_TTL_SEC) * 1000
  : 120_000;

type FollowUpTurn = {
  prompt: string;
  question: string;
  answer?: string;
};

type FollowUpRoute = {
  sessionKey: string;
  topic: string;
};

function normalizeCacheKey(text: string): string {
  const cleaned = text.replace(/^vn-transcribed:/i, "").trim();
  return cleaned
    .toLowerCase()
    .replace(
      /\bfor\s+\d+\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w|months?)\b/g,
      "for <duration>",
    )
    .replace(/\s+/g, " ")
    .trim();
}

function getFollowUpTurns(sessionKey: string): FollowUpTurn[] {
  const key = sessionKey.trim();
  if (!key) {
    return [];
  }
  const row = db.prepare(
    `SELECT turns_json FROM followup_sessions WHERE session_key = ? LIMIT 1`,
  ).get(key) as { turns_json: string } | undefined;
  if (!row?.turns_json) {
    return [];
  }
  try {
    const parsed = JSON.parse(row.turns_json) as FollowUpTurn[];
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .map((entry) => ({
        prompt: typeof entry?.prompt === "string" ? entry.prompt.trim() : "",
        question: typeof entry?.question === "string" ? entry.question.trim() : "",
        answer: typeof entry?.answer === "string" ? entry.answer.trim() : undefined,
      }))
      .filter((entry) => entry.prompt.length > 0 && entry.question.length > 0);
  } catch {
    return [];
  }
}

function saveFollowUpTurns(sessionKey: string, turns: FollowUpTurn[]): void {
  const key = sessionKey.trim();
  if (!key) {
    return;
  }
  const normalized = turns
    .map((entry) => ({
      prompt: (entry.prompt || "").trim(),
      question: (entry.question || "").trim(),
      answer: entry.answer ? entry.answer.trim() : undefined,
    }))
    .filter((entry) => entry.prompt.length > 0 && entry.question.length > 0);
  if (normalized.length === 0) {
    clearFollowUpTurns(key);
    return;
  }
  db.prepare(
    `INSERT INTO followup_sessions (session_key, turns_json, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(session_key) DO UPDATE SET turns_json = excluded.turns_json, updated_at = excluded.updated_at`,
  ).run(key, JSON.stringify(normalized), new Date().toISOString());
}

function clearFollowUpTurns(sessionKey: string): void {
  const key = sessionKey.trim();
  if (!key) {
    return;
  }
  db.prepare(`DELETE FROM followup_sessions WHERE session_key = ?`).run(key);
}

function getFollowUpRoute(sessionKey: string): FollowUpRoute | null {
  const key = sessionKey.trim();
  if (!key) {
    return null;
  }
  const row = db.prepare(
    `SELECT session_key, topic FROM followup_routes WHERE session_key = ? LIMIT 1`,
  ).get(key) as { session_key: string; topic: string } | undefined;
  if (!row?.topic) {
    return null;
  }
  return {
    sessionKey: row.session_key,
    topic: row.topic,
  };
}

function saveFollowUpRoute(sessionKey: string, topic: string): void {
  const key = sessionKey.trim();
  const routeTopic = topic.trim().toLowerCase();
  if (!key || !routeTopic) {
    return;
  }
  db.prepare(
    `INSERT INTO followup_routes (session_key, topic, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(session_key) DO UPDATE SET topic = excluded.topic, updated_at = excluded.updated_at`,
  ).run(key, routeTopic, new Date().toISOString());
}

function clearFollowUpRoute(sessionKey: string): void {
  const key = sessionKey.trim();
  if (!key) {
    return;
  }
  db.prepare(`DELETE FROM followup_routes WHERE session_key = ?`).run(key);
}

function withCurrentAnswer(turns: FollowUpTurn[], answer: string): FollowUpTurn[] {
  if (turns.length === 0) {
    return turns;
  }
  const index = turns.findIndex((turn) => !turn.answer || turn.answer.trim().length === 0);
  if (index < 0) {
    return turns;
  }
  return turns.map((turn, idx) => {
    if (idx !== index) {
      return turn;
    }
    return {
      ...turn,
      answer: answer.trim(),
    };
  });
}

function buildFollowUpMessage(currentMessage: string, turns: FollowUpTurn[]): string {
  if (turns.length === 0) {
    return currentMessage;
  }
  const resolvedTurns = withCurrentAnswer(turns, currentMessage);
  const blocks = resolvedTurns.map((turn, index) => {
    const answer = turn.answer && turn.answer.length > 0 ? turn.answer : "";
    return [
      `Step ${index + 1}:`,
      `Original user prompt: ${turn.prompt}`,
      `Assistant follow-up question: ${turn.question}`,
      `User answer: ${answer}`,
    ].join("\n");
  });
  return [
    "Follow-up context for this session (use only this context):",
    blocks.join("\n\n"),
    "",
    `Current user message: ${currentMessage}`,
  ].join("\n");
}

function isFollowUpQuestion(msg: string): boolean {
  const trimmed = (msg || "").trim();
  if (!trimmed) {
    return false;
  }
  if (trimmed.includes("Reply YES to confirm or NO to cancel.")) {
    return false;
  }
  if (/^confirm\b/i.test(trimmed)) {
    return false;
  }
  return /\?\s*$/.test(trimmed);
}

function buildClassificationCacheKey(prompt: string): string {
  const base = normalizeCacheKey(prompt);
  const tag = getClassificationCacheTag(prompt);
  return `${base}|${tag}`;
}

function isClassificationCacheEnabled(): boolean {
  const value = (process.env.CACHE_CLASSIFICATION ?? "").trim().toLowerCase();
  return value === "true" || value === "1" || value === "yes";
}

function getCachedClassification(prompt: string): string | null {
  if (!isClassificationCacheEnabled()) {
    return null;
  }
  const key = buildClassificationCacheKey(prompt);
  const row = db.prepare(
    `SELECT class, created_at FROM classification_cache WHERE prompt = ? ORDER BY created_at DESC LIMIT 1`,
  ).get(key) as { class: string; created_at: string } | undefined;
  if (!row) {
    console.log("[cache] classification miss");
    return null;
  }
  const createdAt = Date.parse(row.created_at);
  if (Number.isNaN(createdAt)) {
    console.log("[cache] classification miss (invalid date)");
    return null;
  }
  if (Date.now() - createdAt > CLASSIFICATION_TTL_MS) {
    console.log("[cache] classification miss (expired)");
    return null;
  }
  if (row.class === "unknown") {
    console.log("[cache] classification miss (unknown)");
    return null;
  }
  console.log("[cache] classification hit");
  return row.class;
}

function setCachedClassification(prompt: string, topic: string): void {
  if (!isClassificationCacheEnabled()) {
    return;
  }
  if (!topic || topic === "unknown") {
    return;
  }
  const key = buildClassificationCacheKey(prompt);
  db.prepare(
    `INSERT INTO classification_cache (prompt, class, created_at) VALUES (?, ?, datetime('now'))`,
  ).run(key, topic);
}

function clearCachesForPrompt(prompt: string): void {
  const key = normalizeCacheKey(prompt);
  db.prepare(`DELETE FROM classification_cache WHERE prompt = ?`).run(key);
  db.prepare(`DELETE FROM intent_cache WHERE prompt = ?`).run(key);
}

function getRecentConversationForRetry(
  sessionKey: string,
  currentMessageId: string,
  limit = 3,
): Array<{ user: string; assistant: string }> {
  const key = sessionKey.trim();
  if (!key) {
    return [];
  }
  const rows = db.prepare(
    `SELECT i.id, i.message AS user_message, o.message AS assistant_message
     FROM inmessages i
     LEFT JOIN outmessages o ON o.inmessage_id = i.id
     WHERE i."from" = ? AND i.id != ?
     ORDER BY i.received_at DESC
     LIMIT ?`,
  ).all(key, currentMessageId, limit) as Array<{
    id: string;
    user_message: string;
    assistant_message?: string | null;
  }>;
  return rows
    .reverse()
    .map((row) => ({
      user: (row.user_message || "").trim(),
      assistant: (row.assistant_message || "").trim(),
    }))
    .filter((row) => row.user.length > 0 || row.assistant.length > 0);
}

function buildClassificationRetryMessage(message: string, history: Array<{ user: string; assistant: string }>): string {
  if (history.length === 0) {
    return message;
  }
  const lines: string[] = ["Recent conversation context:"];
  for (let i = 0; i < history.length; i += 1) {
    const row = history[i];
    lines.push(`User: ${row.user || "-"}`);
    lines.push(`Assistant: ${row.assistant || "-"}`);
  }
  lines.push("");
  lines.push(`Current user message: ${message}`);
  return lines.join("\n");
}

function buildGeneralHistoryMessage(message: string, history: Array<{ user: string; assistant: string }>): string {
  if (history.length === 0) {
    return message;
  }
  const lines: string[] = [
    "Recent conversation (same session):",
  ];
  for (let i = 0; i < history.length; i += 1) {
    const row = history[i];
    lines.push(`User: ${row.user || "-"}`);
    lines.push(`Assistant: ${row.assistant || "-"}`);
  }
  lines.push("");
  lines.push(`Current user message: ${message}`);
  return lines.join("\n");
}

function buildWebHistoryMessage(message: string, history: Array<{ user: string; assistant: string }>): string {
  if (history.length === 0) {
    return message;
  }
  const lines: string[] = [
    "Recent web conversation context (same session):",
  ];
  for (let i = 0; i < history.length; i += 1) {
    const row = history[i];
    lines.push(`User: ${row.user || "-"}`);
    lines.push(`Assistant: ${row.assistant || "-"}`);
  }
  lines.push("");
  lines.push(`Current user message: ${message}`);
  return lines.join("\n");
}

export function storeIncomingMessage(payload: IncomingMessage): StoredIncomingMessage {
  const receivedAt = new Date().toISOString();
  const id = uuidv4();

  db.prepare(
    `INSERT INTO inmessages (id, "from", message, received_at, reply_id)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, payload.from, payload.message, receivedAt, payload.replyId ?? null);

  return {
    id,
    from: payload.from,
    message: payload.message,
    replyId: payload.replyId,
    receivedAt,
  };
}

export function storeOutgoingMessage(payload: OutgoingMessage): StoredOutgoingMessage {
  const createdAt = new Date().toISOString();
  const id = uuidv4();
  db.prepare(
    `INSERT INTO outmessages (id, inmessage_id, message, created_at)
     VALUES (?, ?, ?, ?)`,
  ).run(id, payload.inmessageId ?? null, payload.message, createdAt);

  return {
    id,
    inmessageId: payload.inmessageId,
    message: payload.message,
    createdAt,
  };
}

export function storeVoiceNote(payload: { base64: string; metadata: Record<string, unknown> }): StoredVoiceNote {
  const createdAt = new Date().toISOString();
  const id = uuidv4();
  const metadata = JSON.stringify(payload.metadata);

  db.prepare(
    `INSERT INTO voicenotes (id, base64, metadata, created_at)
     VALUES (?, ?, ?, ?)`,
  ).run(id, payload.base64, metadata, createdAt);

  return {
    id,
    base64: payload.base64,
    metadata,
    createdAt,
  };
}

export function storeCron(payload: {
  inmessageId?: string;
  from: string;
  message: string;
  cron: string;
  runAt?: string;
  isRecurring: boolean;
  active?: boolean;
  timezone?: string;
  summary?: string;
  action?: string;
  chronicleEventId?: string;
  rawJson: Record<string, unknown>;
}): StoredCron {
  const createdAt = new Date().toISOString();
  const rawJson = JSON.stringify(payload.rawJson);
  const active = payload.active ?? true;

  db.prepare(
    `INSERT INTO crons (id, inmessage_id, "from", message, cron, run_at, is_recurring, active, timezone, summary, action, chronicle_event_id, raw_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    null,
    payload.inmessageId ?? null,
    payload.from,
    payload.message,
    payload.cron,
    payload.runAt ?? null,
    payload.isRecurring ? 1 : 0,
    active ? 1 : 0,
    payload.timezone ?? null,
    payload.summary ?? null,
    payload.action ?? null,
    payload.chronicleEventId ?? null,
    rawJson,
    createdAt,
  );
  const row = db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number };
  const id = Number(row.id);

  return {
    id,
    inmessageId: payload.inmessageId,
    from: payload.from,
    message: payload.message,
    cron: payload.cron,
    runAt: payload.runAt,
    isRecurring: payload.isRecurring,
    active,
    timezone: payload.timezone,
    summary: payload.summary,
    action: payload.action,
    chronicleEventId: payload.chronicleEventId,
    rawJson,
    createdAt,
  };
}

export function storeCronRun(payload: {
  cronId: number;
  inmessageId?: string;
  status: "success" | "error";
  result?: string;
  error?: string;
}): StoredCronRun {
  const createdAt = new Date().toISOString();
  const id = uuidv4();

  db.prepare(
    `INSERT INTO cron_runs (id, cron_id, inmessage_id, status, result, error, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    payload.cronId,
    payload.inmessageId ?? null,
    payload.status,
    payload.result ?? null,
    payload.error ?? null,
    createdAt,
  );

  return {
    id,
    cronId: payload.cronId,
    inmessageId: payload.inmessageId,
    status: payload.status,
    result: payload.result,
    error: payload.error,
    createdAt,
  };
}

export async function classifyAndCompile(
  fromSystem?: string,
  message?: string,
  uuid?: string,
  options?: CompileOptions,
): Promise<BrokerResult> {
  try {
    if (!fromSystem || !message || !uuid) {
      return { success: false, code: 400, msg: "missing parameter" };
    }

    let normalizedFrom = fromSystem.includes("@lid") ? "whatsapp" : fromSystem;
    if (normalizedFrom.startsWith("cron-")) {
      normalizedFrom = "cron";
    }

    if (normalizedFrom === "whatsapp") {
      return compileWhatsapp(uuid, message, fromSystem, options);
    }

    if (normalizedFrom === "queue-ui") {
      return compileUI(uuid, message, fromSystem, options);
    }

    if (normalizedFrom === "custom-prompt") {
      return compileCustomPrompt(uuid, message);
    }

    if (normalizedFrom === "cron") {
      return compileCron(uuid, message, fromSystem, options);
    }

    return { success: false, code: 400, msg: "unsupported fromSystem" };
  } catch (error) {
    const msg = error instanceof Error ? error.message : "unknown error";
    return { success: false, code: 500, msg };
  }
}

function getTopicOverride(message: string): TopicResult | null {
  const normalizedMessage = message.trim().toLowerCase();
  const isDirectAttachmentIdCommand = isExplicitAttachmentIdCommand(normalizedMessage);
  if (isDirectAttachmentIdCommand) {
    return { topic: "email", contextRequired: false };
  }
  const hasEmailKeyword = /\b(email|emails|mail|mails|inbox|inbound|sent)\b/i.test(normalizedMessage);
  const hasPossessiveEmailRequest =
    /\bmy\b/.test(normalizedMessage) &&
    /\b(email|emails|mail|mails|inbox)\b/.test(normalizedMessage);
  if (hasPossessiveEmailRequest) {
    return { topic: "email", contextRequired: false };
  }
  const hasEmailActionKeyword =
    /\b(show|list|read|check|find|search|count|reply|forward|delete|move|archive|download)\b/i.test(
      normalizedMessage,
    );
  const hasEmailRecencyKeyword =
    /\b(last|latest|recent|newest|oldest|first)\b/i.test(normalizedMessage) ||
    /\b\d+\b/.test(normalizedMessage);
  const hasDateFilterKeyword =
    normalizedMessage.includes("today") ||
    normalizedMessage.includes("yesterday") ||
    normalizedMessage.includes("tomorrow") ||
    normalizedMessage.includes("this week") ||
    normalizedMessage.includes("this month") ||
    /\b\d{4}-\d{2}-\d{2}\b/.test(normalizedMessage);
  if (hasEmailKeyword && (hasEmailActionKeyword || hasDateFilterKeyword || hasEmailRecencyKeyword)) {
    return { topic: "email", contextRequired: false };
  }
  const hasMarkAllReadPattern =
    /\bmark\b/.test(normalizedMessage) &&
    /\ball\b/.test(normalizedMessage) &&
    /\b(mail|email|emails|mails)\b/.test(normalizedMessage) &&
    /\b(read)\b/.test(normalizedMessage);
  if (hasMarkAllReadPattern) {
    return { topic: "email", contextRequired: false };
  }
  const hasWeatherKeyword =
    /\bweather\b/i.test(normalizedMessage) ||
    /\bforecast\b/i.test(normalizedMessage) ||
    /\brain\b/i.test(normalizedMessage) ||
    /\bhumidity\b/i.test(normalizedMessage) ||
    /\bwind\b/i.test(normalizedMessage) ||
    /\btemperature\b/i.test(normalizedMessage);
  if (hasWeatherKeyword) {
    return { topic: "homeassistant", contextRequired: false };
  }
  const hasUsageKeyword =
    /\b(use|usage|consumption|consumed|current|today|now)\b/i.test(normalizedMessage);
  const hasWaterKeyword =
    /\b(water|litres|liters|l\/m|flow)\b/i.test(normalizedMessage);
  if (hasWaterKeyword && hasUsageKeyword) {
    return { topic: "homeassistant", contextRequired: false };
  }
  const hasScheduleKeyword =
    /\b(in|after)\s+\d+\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w|months?|years?)\b/i.test(
      normalizedMessage,
    ) ||
    /\b\d{4}-\d{2}-\d{2}\b/.test(normalizedMessage) ||
    /\b(at|on)\s+\d{1,2}(:\d{2})?\s*(am|pm)?\b/i.test(normalizedMessage) ||
    /\b\d{1,2}(:\d{2})\s*(am|pm)?\b/i.test(normalizedMessage) ||
    normalizedMessage.includes("tomorrow") ||
    normalizedMessage.includes("today") ||
    normalizedMessage.includes("tonight") ||
    normalizedMessage.includes("next week") ||
    normalizedMessage.includes("next month") ||
    normalizedMessage.includes("next year") ||
    normalizedMessage.includes("every") ||
    normalizedMessage.includes("daily") ||
    normalizedMessage.includes("weekly") ||
    normalizedMessage.includes("monthly") ||
    normalizedMessage.includes("yearly") ||
    normalizedMessage.includes("each day") ||
    normalizedMessage.includes("each week") ||
    normalizedMessage.includes("each month") ||
    normalizedMessage.includes("each year") ||
    /\bmon(day)?\b|\btue(s|sday)?\b|\bwed(nesday)?\b|\bthu(rs|rsday)?\b|\bfri(day)?\b|\bsat(urday)?\b|\bsun(day)?\b/i.test(
      normalizedMessage,
    );
  const hasReminderKeyword =
    normalizedMessage.includes("remind me") ||
    normalizedMessage.startsWith("remind ") ||
    normalizedMessage.includes("set reminder") ||
    normalizedMessage.includes("create reminder");
  if (hasReminderKeyword && hasScheduleKeyword) {
    return { topic: "schedule", contextRequired: false };
  }
  if (hasScheduleKeyword) {
    return { topic: "schedule", contextRequired: false };
  }
  const isHomeAssistantPrefix =
    normalizedMessage.startsWith("ha ") ||
    normalizedMessage.startsWith("ha:") ||
    normalizedMessage.startsWith("ha-") ||
    normalizedMessage.startsWith("home assistant");
  if (isHomeAssistantPrefix) {
    return { topic: "homeassistant", contextRequired: false };
  }
  if (/\bhass\b/i.test(normalizedMessage)) {
    return { topic: "homeassistant", contextRequired: false };
  }
  const hasAttachmentKeyword = /\b(attachment|attachments|pdf)\b/i.test(normalizedMessage);
  const hasMailIdReference = /\bfrom\s+\d{3,}\b/i.test(normalizedMessage) || /\b(mail|email)\s*#?\s*\d+\b/i.test(
    normalizedMessage,
  );
  if (hasAttachmentKeyword && (hasEmailKeyword || hasMailIdReference)) {
    return { topic: "email", contextRequired: false };
  }
  const hasFileKeyword =
    /\b(file|files|document|documents|upload|uploads)\b/i.test(normalizedMessage) ||
    /\bfile\s+id\b/i.test(normalizedMessage);
  const hasFileAction =
    /\b(show|list|find|search|get|download|open|send|latest|last|recent|summary|lookup)\b/i.test(normalizedMessage) ||
    /\blook(?:ing)?\s+for\b/i.test(normalizedMessage);
  if (hasFileKeyword && hasFileAction) {
    return { topic: "file", contextRequired: false };
  }
  const hasWebKeyword =
    /\b(web|website|webpage|browser|playwright|todomvc)\b/i.test(normalizedMessage) ||
    /\bweb search\b/i.test(normalizedMessage);
  const hasUrl = /https?:\/\/[^\s"')]+/i.test(normalizedMessage);
  if (hasWebKeyword || hasUrl) {
    return { topic: "web", contextRequired: false };
  }
  return null;
}

function isExplicitAttachmentIdCommand(message: string): boolean {
  const normalizedMessage = message.trim().toLowerCase();
  return (
    /\b(?:display|download|fetch|get|open|show)\s+(?:the\s+)?(?:attachment|attachement|file)(?:\s+id)?\s*[#: ]\s*\d+\b/i.test(
      normalizedMessage,
    ) ||
    /\b(?:attachment|attachement|file)(?:\s+id)?\s*[#: ]\s*\d+\b/i.test(normalizedMessage)
  );
}

function parseKeyValueArgs(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  const regex = /(\w+)=("([^"]*)"|'([^']*)'|(\S+))/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const key = match[1]?.toLowerCase() ?? "";
    const value = match[3] ?? match[4] ?? match[5] ?? "";
    if (key) {
      result[key] = value;
    }
  }
  return result;
}

function parseExamples(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(/[|;]+/g)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

type ConfirmationPayload = {
  class?: string;
  id?: number;
  replyUrl?: string;
  requestId?: string;
  prompt?: string;
  payload?: Record<string, unknown>;
  schedule_from?: string;
  schedule_message?: string;
};

function createConfirmation(
  action: string,
  from: string,
  payload: ConfirmationPayload,
): { prompt: string } {
  const id = uuidv4();
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + CONFIRM_TTL_MS).toISOString();
  db.prepare(
    `INSERT INTO pending_confirmations (id, "from", action, payload, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, from, action, JSON.stringify(payload), createdAt, expiresAt);
  return {
    prompt: `Confirm ${action.replace("-", " ")}?`,
  };
}

function getPendingConfirmation(from: string): {
  id: string;
  action: string;
  payload: string;
  expires_at: string;
  expired: boolean;
} | null {
  const row = db.prepare(
    `SELECT id, action, payload, expires_at
     FROM pending_confirmations
     WHERE "from" = ?
     ORDER BY created_at DESC
     LIMIT 1`,
  ).get(from) as { id: string; action: string; payload: string; expires_at: string } | undefined;
  if (!row) {
    return null;
  }
  const expiresAt = Date.parse(row.expires_at);
  if (Number.isNaN(expiresAt) || Date.now() > expiresAt) {
    db.prepare(`DELETE FROM pending_confirmations WHERE id = ?`).run(row.id);
    return { ...row, expired: true };
  }
  return { ...row, expired: false };
}

function clearConfirmation(id: string): void {
  db.prepare(`DELETE FROM pending_confirmations WHERE id = ?`).run(id);
}

function isConfirmMessage(text: string): boolean {
  const value = text.trim().toLowerCase();
  return value === "yes" || value === "y" || value === "confirm" || value === "ok";
}

function isDeclineMessage(text: string): boolean {
  const value = text.trim().toLowerCase();
  return value === "no" || value === "n" || value === "decline" || value === "cancel";
}

async function handleConfirmation(from: string, message: string): Promise<BrokerResult | null> {
  const pending = getPendingConfirmation(from);
  if (!pending) {
    return null;
  }
  clearConfirmation(pending.id);
  if (pending.expired) {
    const payload = JSON.parse(pending.payload) as ConfirmationPayload;
    if (pending.action === "external-confirm") {
      await postConfirmationCallback(payload, from, false, "timeout");
    }
    return { success: true, code: 200, msg: "Cancelled." };
  }
  if (isConfirmMessage(message)) {
    const payload = JSON.parse(pending.payload) as ConfirmationPayload;
    if (pending.action === "app-confirm") {
      const url = (payload.replyUrl || "").trim();
      const body = payload.payload && typeof payload.payload === "object" ? payload.payload : null;
      if (!url || !body) {
        return { success: false, code: 400, msg: "Unable to confirm request" };
      }
      const confirmBody = { ...body, skip_confirmation: true };
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(confirmBody),
        });
        const text = await response.text();
        return { success: true, code: 200, msg: text };
      } catch (error) {
        const msg = error instanceof Error ? error.message : "unknown error";
        return { success: false, code: 503, msg };
      }
    }
    if (pending.action === "external-confirm") {
      await postConfirmationCallback(payload, from, true, message);
      return { success: true, code: 200, msg: "Confirmed." };
    }
    if (pending.action === "remove-intent") {
      const id = payload.id ?? 0;
      const result = removeDynamicIntentById(id);
      if (!result.ok) {
        return { success: false, code: 400, msg: result.error ?? "Unable to remove intent" };
      }
      if (result.count === 0) {
        return { success: true, code: 200, msg: `No intent found with id=${id}.` };
      }
      return { success: true, code: 200, msg: `Removed intent id=${id}.` };
    }
    if (pending.action === "remove-intents") {
      const result = clearDynamicIntents(payload.class);
      if (!result.ok) {
        return { success: false, code: 400, msg: result.error ?? "Unable to remove intents" };
      }
      const target = payload.class ? `class=${payload.class}` : "all classes";
      return { success: true, code: 200, msg: `Removed ${result.count} intents (${target}).` };
    }
    if (pending.action === "schedule-confirm") {
      const scheduleMessage = (payload.schedule_message || "").trim();
      const scheduleFrom = (payload.schedule_from || from).trim() || from;
      if (!scheduleMessage) {
        return { success: false, code: 400, msg: "Unable to confirm schedule request" };
      }
      return handleSchedule(uuidv4(), scheduleFrom, scheduleMessage, { skipConfirmation: true });
    }
    return { success: true, code: 200, msg: "Confirmed." };
  }
  if (isDeclineMessage(message)) {
    if (pending.action === "external-confirm") {
      const payload = JSON.parse(pending.payload) as ConfirmationPayload;
      await postConfirmationCallback(payload, from, false, message);
    }
    return { success: true, code: 200, msg: "Cancelled." };
  }
  if (pending.action === "external-confirm") {
    const payload = JSON.parse(pending.payload) as ConfirmationPayload;
    await postConfirmationCallback(payload, from, false, message);
  }
  return { success: true, code: 200, msg: "Cancelled." };
}

async function postConfirmationCallback(
  payload: ConfirmationPayload,
  from: string,
  confirmed: boolean,
  responseMessage: string,
): Promise<void> {
  const url = (payload.replyUrl || "").trim();
  if (!url) {
    return;
  }
  const body = {
    id: payload.requestId || "",
    confirmed,
    dont_confirm: confirmed,
    from,
    response_message: responseMessage,
    prompt: payload.prompt || "",
  };
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "unknown error";
    console.warn(`[confirm-callback] failed: ${msg}`);
  }
}

function handleExternalConfirmRequest(message: string, from: string): BrokerResult | null {
  const normalized = message.trim();
  const lowered = normalized.toLowerCase();
  if (!lowered.startsWith("confirm request")) {
    return null;
  }
  const args = parseKeyValueArgs(normalized);
  const replyUrl = args.reply_url || args.replyurl || args.url || "";
  const prompt = args.message || args.prompt || "";
  const requestId = args.id || "";
  if (!replyUrl || !prompt) {
    return {
      success: false,
      code: 400,
      msg: 'Usage: confirm request reply_url=<url> id=<id> message="Confirm ...?"',
    };
  }
  const confirmation = createConfirmation("external-confirm", from, {
    replyUrl,
    requestId,
    prompt,
  });
  return {
    success: true,
    code: 200,
    msg: `${prompt} Reply YES to confirm or NO to cancel.`,
  };
}

function handleIntentCommand(message: string, from: string): BrokerResult | null {
  const normalized = message.trim();
  const lowered = normalized.toLowerCase();
  if (
    /how to add (an |a )?intent/.test(lowered) ||
    lowered === "intent help" ||
    lowered === "help intent" ||
    lowered === "add intent" ||
    lowered.includes("add intent")
  ) {
    return {
      success: true,
      code: 200,
      msg:
        'To add: intent add class=<class> intent=<intent> verb=<verb> desc="..." examples="ex1|ex2". Example: intent add class=email intent=count-sent verb=count desc="count sent emails". To list: intent list [class=<class>].',
    };
  }
  if (lowered.startsWith("add intent ")) {
    const args = parseKeyValueArgs(normalized);
    const result = addDynamicIntent({
      class: args.class ?? "",
      intent: args.intent ?? "",
      verb: args.verb ?? "",
      description: args.desc ?? args.description ?? "",
      examples: parseExamples(args.examples ?? args.example),
    });
    if (!result.ok) {
      return { success: false, code: 400, msg: result.error ?? "Invalid intent" };
    }
    const rows = listDynamicIntents(args.class);
    const lines = rows.map((row) => {
      const verb = row.verb ? ` verb=${row.verb}` : "";
      const description = row.description ? ` desc="${row.description}"` : "";
      return `id=${row.id} class=${row.class} intent=${row.intent}${verb}${description}`;
    });
    const summary = `Intent added (id=${result.id}).`;
    const body = lines.length > 0 ? `${summary}\n${lines.join("\n")}` : summary;
    return { success: true, code: 200, msg: body };
  }
  if (/\bremove\b/.test(lowered) && /\bintent(s)?\b/.test(lowered)) {
    const args = parseKeyValueArgs(normalized);
    let id: number | undefined;
    const idMatch = normalized.match(/\bintent\s+(\d+)\b/i) ?? normalized.match(/\bintent\s*#\s*(\d+)\b/i);
    if (idMatch) {
      id = Number(idMatch[1]);
    }
    const payload = { class: args.class ?? "", id };
    const isAll = /\ball\b/.test(lowered);
    if (id && !isAll) {
      const result = removeDynamicIntentById(id);
      if (!result.ok) {
        return { success: false, code: 400, msg: result.error ?? "Unable to remove intent" };
      }
      if (result.count === 0) {
        return { success: true, code: 200, msg: `No intent found with id=${id}.` };
      }
      return { success: true, code: 200, msg: `Removed intent id=${id}.` };
    }
    const action = "remove-intents";
    const confirmation = createConfirmation(action, from, payload);
    return {
      success: true,
      code: 200,
      msg: `${confirmation.prompt} Reply YES to confirm or NO to cancel.`,
    };
  }
  if (lowered === "list intents" || lowered === "show intents" || lowered.startsWith("list intents ")) {
    const args = parseKeyValueArgs(normalized);
    const rows = listDynamicIntents(args.class);
    if (rows.length === 0) {
      return { success: true, code: 200, msg: "No dynamic intents found." };
    }
    const lines = rows.map((row) => {
      const verb = row.verb ? ` verb=${row.verb}` : "";
      const description = row.description ? ` desc="${row.description}"` : "";
      return `id=${row.id} class=${row.class} intent=${row.intent}${verb}${description}`;
    });
    return { success: true, code: 200, msg: lines.join("\n") };
  }
  if (!lowered.startsWith("intent ")) {
    return null;
  }
  const rest = normalized.slice(7).trim();
  if (!rest || rest.toLowerCase() === "add") {
    return {
      success: true,
      code: 200,
      msg:
        'Usage: intent add class=<class> intent=<intent> verb=<verb> desc="..." examples="ex1|ex2". Example: intent add class=email intent=count-sent verb=count desc="count sent emails".',
    };
  }
  if (rest.toLowerCase().startsWith("list")) {
    const args = parseKeyValueArgs(rest);
    const rows = listDynamicIntents(args.class);
    if (rows.length === 0) {
      return { success: true, code: 200, msg: "No dynamic intents found." };
    }
    const lines = rows.map((row) => {
      const verb = row.verb ? ` verb=${row.verb}` : "";
      const description = row.description ? ` desc="${row.description}"` : "";
      return `id=${row.id} class=${row.class} intent=${row.intent}${verb}${description}`;
    });
    return { success: true, code: 200, msg: lines.join("\n") };
  }
  if (rest.toLowerCase().startsWith("add")) {
    const args = parseKeyValueArgs(rest);
    const result = addDynamicIntent({
      class: args.class ?? "",
      intent: args.intent ?? "",
      verb: args.verb ?? "",
      description: args.desc ?? args.description ?? "",
      examples: parseExamples(args.examples ?? args.example),
    });
    if (!result.ok) {
      return { success: false, code: 400, msg: result.error ?? "Invalid intent" };
    }
    const rows = listDynamicIntents(args.class);
    const lines = rows.map((row) => {
      const verb = row.verb ? ` verb=${row.verb}` : "";
      const description = row.description ? ` desc="${row.description}"` : "";
      return `class=${row.class} intent=${row.intent}${verb}${description}`;
    });
    const summary = `Intent added (id=${result.id}).`;
    const body = lines.length > 0 ? `${summary}\n${lines.join("\n")}` : summary;
    return { success: true, code: 200, msg: body };
  }
  return {
    success: true,
    code: 200,
    msg:
      'Usage: intent add class=<class> intent=<intent> verb=<verb> desc="..." examples="ex1|ex2". Example: intent add class=email intent=count-sent verb=count desc="count sent emails".',
  };
}

function extractNotifyMessage(message: string): string | null {
  const normalized = message.trim();
  if (!normalized) {
    return null;
  }
  const lower = normalized.toLowerCase();
  if (lower.startsWith("notify me")) {
    const tail = normalized.slice("notify me".length).trim().replace(/^[:\-\s]+/, "").trim();
    return tail;
  }
  if (lower.startsWith("notify ")) {
    const tail = normalized.slice("notify ".length).trim().replace(/^[:\-\s]+/, "").trim();
    return tail;
  }
  return null;
}

function isTruthyEnv(value: string | undefined, defaultValue = true): boolean {
  const normalized = (value ?? "").trim().toLowerCase();
  if (!normalized) {
    return defaultValue;
  }
  return normalized === "true" || normalized === "1" || normalized === "yes";
}

function isUiNotifyEnabled(): boolean {
  return isTruthyEnv(process.env.NOTIFY_UI_ENABLED, true);
}

function isPushoverNotifyEnabled(): boolean {
  return isTruthyEnv(process.env.NOTIFY_PUSHOVER_ENABLED, true);
}

function isWhatsappNotifyEnabled(): boolean {
  return isTruthyEnv(process.env.NOTIFY_WHATSAPP_ENABLED, true);
}

type NotificationPlan = {
  ui: boolean;
  pushover: boolean;
  whatsapp: boolean;
  explicit: boolean;
};

function buildNotificationPlan(
  message: string,
  enabled: { ui: boolean; pushover: boolean; whatsapp: boolean },
  _sourceChannel: string,
): NotificationPlan {
  const text = (message || "").toLowerCase();
  const wantsUi =
    /\bui\b/.test(text) ||
    /\bbrowser\b/.test(text) ||
    /\bin app\b/.test(text) ||
    /\bin-app\b/.test(text) ||
    /\bapp notification\b/.test(text);
  const wantsPushover = /\bpushover\b/.test(text) || /\bpush over\b/.test(text);
  const wantsWhatsapp = /\bwhatsapp\b/.test(text) || /\bwhats app\b/.test(text);
  const explicit = wantsUi || wantsPushover || wantsWhatsapp;

  if (explicit) {
    return {
      ui: wantsUi && enabled.ui,
      pushover: wantsPushover && enabled.pushover,
      whatsapp: wantsWhatsapp && enabled.whatsapp,
      explicit: true,
    };
  }

  // Default when no explicit channel was requested: WhatsApp.
  return {
    ui: false,
    pushover: false,
    whatsapp: enabled.whatsapp,
    explicit: false,
  };
}

function resolveWhatsappMessageUrl(raw?: string): string {
  const value = (raw || "").trim();
  if (!value) {
    return "http://localhost:8085/message";
  }
  if (value.startsWith("http://") || value.startsWith("https://")) {
    return value;
  }
  return `http://${value}`;
}

function getPrimaryWhatsappLid(): string {
  return (process.env.PRIMARY_WHATSAPP_LID ?? "").trim();
}

async function sendWhatsappNotification(message: string): Promise<void> {
  const chatId = getPrimaryWhatsappLid();
  if (!chatId) {
    throw new Error("PRIMARY_WHATSAPP_LID is not configured");
  }
  const url = resolveWhatsappMessageUrl(process.env.WHATSAPP_MESSAGE_URL);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const auth = (process.env.WHATSAPP_MESSAGE_AUTH ?? "").trim();
  if (auth) {
    headers.Authorization = auth;
  }
  const payload = {
    chatId,
    text: message,
    message,
  };
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`WhatsApp notify failed (${response.status}): ${body}`);
  }
}

async function handleNotifyCommand(message: string, sourceChannel: string): Promise<BrokerResult | null> {
  const payload = extractNotifyMessage(message);
  if (payload === null) {
    return null;
  }
  if (!payload) {
    return {
      success: false,
      code: 400,
      msg: 'Usage: notify me <message>',
    };
  }
  const uiEnabled = isUiNotifyEnabled();
  const pushoverEnabled = isPushoverNotifyEnabled();
  const whatsappEnabled = isWhatsappNotifyEnabled();
  if (!pushoverEnabled && !uiEnabled && !whatsappEnabled) {
    return {
      success: false,
      code: 400,
      msg: "All notification channels are disabled in control panel settings.",
    };
  }
  const plan = buildNotificationPlan(payload, {
    ui: uiEnabled,
    pushover: pushoverEnabled,
    whatsapp: whatsappEnabled,
  }, sourceChannel);
  if (!plan.ui && !plan.pushover && !plan.whatsapp) {
    return {
      success: false,
      code: 400,
      msg: "Requested notification channels are disabled in control panel settings.",
    };
  }
  try {
    let pushoverSent = false;
    if (plan.pushover) {
      await sendPushoverNotification(payload);
      pushoverSent = true;
    }
    if (plan.whatsapp) {
      try {
        await sendWhatsappNotification(payload);
      } catch (error) {
        const msg = error instanceof Error ? error.message : "unknown error";
        console.warn(`[notify-whatsapp] failed: ${msg}`);
      }
    }
    console.log(
      `[notify] command plan_ui=${plan.ui} plan_pushover=${plan.pushover} pushover_sent=${pushoverSent} plan_whatsapp=${plan.whatsapp} payload="${payload}"`,
    );
    return {
      success: true,
      code: 200,
      msg: `Notification sent: ${payload}`,
      notify: plan.ui,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : "unknown error";
    console.warn(
      `[notify] command failed ui_enabled=${uiEnabled} pushover_enabled=${pushoverEnabled} payload="${payload}" error="${msg}"`,
    );
    return {
      success: false,
      code: 503,
      msg: `Notification failed: ${msg}`,
    };
  }
}

async function applyNotificationContract(
  result: BrokerResult,
  fallbackMessage: string,
  sourceChannel: string,
): Promise<BrokerResult> {
  if (!result.notify) {
    return result;
  }
  if (!result.success) {
    return { ...result, notify: false };
  }
  const payload = (result.msg || "").trim() || fallbackMessage.trim();
  const plan = buildNotificationPlan(payload, {
    ui: isUiNotifyEnabled(),
    pushover: isPushoverNotifyEnabled(),
    whatsapp: isWhatsappNotifyEnabled(),
  }, sourceChannel);
  const normalizedResult: BrokerResult = {
    ...result,
    notify: plan.ui,
  };
  if (!payload) {
    return normalizedResult;
  }
  if (plan.pushover) {
    try {
      await sendPushoverNotification(payload);
    } catch (error) {
      const msg = error instanceof Error ? error.message : "unknown error";
      console.warn(`[notify] failed: ${msg}`);
    }
  }
  if (plan.whatsapp) {
    try {
      await sendWhatsappNotification(payload);
    } catch (error) {
      const msg = error instanceof Error ? error.message : "unknown error";
      console.warn(`[notify-whatsapp] failed: ${msg}`);
    }
  }
  return normalizedResult;
}

async function compileByTopic(
  uuid: string,
  message: string,
  channelLabel: string,
  fromForSchedule: string,
  confirmKey: string,
  options?: CompileOptions,
): Promise<BrokerResult> {
  const skipCache = Boolean(options?.skipCache);
  const provider = getLlmProviderLabel();
  console.log(`[llm] provider=${provider} channel=${channelLabel} uuid=${uuid}`);
  broadcastEvent("llm", `provider=${provider} channel=${channelLabel}`);

  const runTopicHandler = async (topic: string, inputMessage: string): Promise<BrokerResult> => {
    if (topic === "homeassistant") {
      return handleHomeAssistant(uuid, inputMessage, confirmKey, { skipCache });
    }
    if (topic === "email") {
      return handleEmail(uuid, inputMessage, confirmKey, { skipCache });
    }
    if (topic === "file") {
      return handleFile(uuid, inputMessage, confirmKey, { skipCache });
    }
    if (topic === "schedule") {
      return handleSchedule(uuid, confirmKey, inputMessage);
    }
    if (topic === "cron-query") {
      return handleCronQuery(uuid, inputMessage);
    }
    if (topic === "cron-remove") {
      return handleCronRemove(uuid, inputMessage);
    }
    if (topic === "general") {
      return handleGeneral(uuid, inputMessage);
    }
    if (topic === "web") {
      return handleWeb(uuid, inputMessage);
    }
    return { success: true, code: 200, msg: `Class: ${topic}`, uuid };
  };

  const confirmationResult = await handleConfirmation(confirmKey, message);
  if (confirmationResult) {
    return { ...confirmationResult, uuid };
  }
  const externalConfirm = handleExternalConfirmRequest(message, confirmKey);
  if (externalConfirm) {
    return { ...externalConfirm, uuid };
  }
  const intentCommand = handleIntentCommand(message, confirmKey);
  if (intentCommand) {
    return { ...intentCommand, uuid };
  }
  const notifyCommand = await handleNotifyCommand(message, channelLabel);
  if (notifyCommand) {
    return { ...notifyCommand, uuid };
  }
  const explicitAttachmentIdCommand = isExplicitAttachmentIdCommand(message);
  if (explicitAttachmentIdCommand) {
    clearFollowUpRoute(confirmKey);
    clearFollowUpTurns(confirmKey);
    console.log(`[followup-route] session=${confirmKey} cleared=true reason=direct-attachment-id`);
    console.log(`[followup] session=${confirmKey} cleared=true reason=direct-attachment-id`);
    const directAttachmentResult = await runTopicHandler("email", message);
    return applyNotificationContract(directAttachmentResult, message, channelLabel);
  }
  const followUpRoute = getFollowUpRoute(confirmKey);
  if (followUpRoute) {
    console.log(`[followup-route] session=${confirmKey} forced_topic=${followUpRoute.topic}`);
    clearFollowUpTurns(confirmKey);
    const routedInput =
      followUpRoute.topic === "web"
        ? buildWebHistoryMessage(message, getRecentConversationForRetry(confirmKey, uuid, 5))
        : message;
    const routedResult = await runTopicHandler(followUpRoute.topic, routedInput);
    if (routedResult.followUpRoute && routedResult.followUpRoute === followUpRoute.topic) {
      saveFollowUpRoute(confirmKey, routedResult.followUpRoute);
    } else {
      clearFollowUpRoute(confirmKey);
      console.log(`[followup-route] session=${confirmKey} cleared=true`);
    }
    return applyNotificationContract(routedResult, message, channelLabel);
  }
  const followUpTurns = getFollowUpTurns(confirmKey);
  const messageForModel = followUpTurns.length > 0 ? buildFollowUpMessage(message, followUpTurns) : message;
  if (followUpTurns.length > 0) {
    console.log(`[followup] session=${confirmKey} applied=true turns=${followUpTurns.length}`);
  }
  const override = getTopicOverride(message);
  const cached = override || followUpTurns.length > 0 || skipCache ? null : getCachedClassification(message);
  let topicResult: TopicResult = override
    ? override
    : cached
      ? { topic: cached, contextRequired: false }
      : await topicClassifier(messageForModel);
  if (!override && !cached && (!topicResult.topic || topicResult.topic === "unknown")) {
    const history = getRecentConversationForRetry(confirmKey, uuid, 3);
    if (history.length > 0) {
      const retryMessage = buildClassificationRetryMessage(messageForModel, history);
      console.log(`[topic-retry] channel=${channelLabel} uuid=${uuid} history_count=${history.length}`);
      topicResult = await topicClassifier(retryMessage);
    }
  }
  if (topicResult.contextRequired && topicResult.question) {
    const answered = withCurrentAnswer(followUpTurns, message);
    const updated = [...answered, { prompt: message, question: topicResult.question }];
    saveFollowUpTurns(confirmKey, updated);
    clearCachesForPrompt(message);
    console.log(`[followup] session=${confirmKey} stored=true turns=${updated.length}`);
    return { success: true, code: 200, msg: topicResult.question, uuid };
  }
  const topic = topicResult.topic;
  if (!topic || topic === "unknown") {
    return { success: false, code: 400, msg: "Unable to classify request", uuid };
  }
  console.log(`[topic] channel=${channelLabel} uuid=${uuid} topic=${topic}`);
  const payloadMessage = followUpTurns.length > 0 ? messageForModel : message;
  const dispatchMessage =
    topic === "general"
      ? buildGeneralHistoryMessage(payloadMessage, getRecentConversationForRetry(confirmKey, uuid, 5))
      : topic === "web"
        ? buildWebHistoryMessage(payloadMessage, getRecentConversationForRetry(confirmKey, uuid, 5))
      : payloadMessage;
  const result = await runTopicHandler(topic, dispatchMessage);
  const classificationEligibleForCache =
    !override && !cached && followUpTurns.length === 0 && !followUpRoute && topic !== "unknown" && topic !== "general";
  const isFollowUpInteraction = Boolean(result.followUpRoute) || isFollowUpQuestion(result.msg);
  if (!skipCache && classificationEligibleForCache && !isFollowUpInteraction) {
    setCachedClassification(message, topic);
  } else if (isFollowUpInteraction || followUpTurns.length > 0 || followUpRoute || topic === "general") {
    clearCachesForPrompt(message);
  }
  if (result.followUpRoute) {
    saveFollowUpRoute(confirmKey, result.followUpRoute);
    console.log(`[followup-route] session=${confirmKey} stored=true topic=${result.followUpRoute}`);
  } else {
    clearFollowUpRoute(confirmKey);
  }
  if (isFollowUpQuestion(result.msg)) {
    const answered = withCurrentAnswer(followUpTurns, message);
    const updated = [...answered, { prompt: message, question: result.msg }];
    saveFollowUpTurns(confirmKey, updated);
    console.log(`[followup] session=${confirmKey} stored=true turns=${updated.length}`);
  } else if (followUpTurns.length > 0) {
    clearFollowUpTurns(confirmKey);
    console.log(`[followup] session=${confirmKey} cleared=true`);
  }
  return applyNotificationContract(result, dispatchMessage, channelLabel);
}

export async function compileWhatsapp(uuid?: string, message?: string, fromKey?: string, options?: CompileOptions): Promise<BrokerResult> {
  try {
    if (!uuid || !message) {
      return { success: false, code: 400, msg: "missing parameter" };
    }
    const result = await compileByTopic(uuid, message, "whatsapp", "whatsapp", fromKey ?? "whatsapp", options);
    if (result.notify) {
      broadcastEvent("notify", result.msg);
    }
    return result;
  } catch (error) {
    const msg = error instanceof Error ? error.message : "unknown error";
    return { success: false, code: 500, msg };
  }
}

export async function compileUI(uuid?: string, message?: string, fromKey?: string, options?: CompileOptions): Promise<BrokerResult> {
  try {
    if (!uuid || !message) {
      return { success: false, code: 400, msg: "missing parameter" };
    }
    return compileByTopic(uuid, message, "queue-ui", "queue-ui", fromKey ?? "queue-ui", options);
  } catch (error) {
    const msg = error instanceof Error ? error.message : "unknown error";
    return { success: false, code: 500, msg };
  }
}

function cleanupNonRunnableCrons(): number {
  const now = new Date().toISOString();
  const result = db.prepare(
    `DELETE FROM crons
     WHERE is_recurring = 0
       AND (
         active = 0
         OR last_run_at IS NOT NULL
         OR (run_at IS NOT NULL AND run_at <= ?)
       )`,
  ).run(now);
  const removed = typeof result.changes === "number" ? result.changes : 0;
  if (removed > 0) {
    console.log(`[cron-cleanup] removed=${removed} reason=non-runnable one-off`);
  }
  return removed;
}

export async function compileCron(
  uuid?: string,
  message?: string,
  fromSystem?: string,
  options?: CompileOptions,
): Promise<BrokerResult> {
  try {
    if (!uuid || !message || !fromSystem) {
      return { success: false, code: 400, msg: "missing parameter" };
    }

    cleanupNonRunnableCrons();
    const result = await compileByTopic(uuid, message, "cron", fromSystem, fromSystem, options);
    broadcastEvent("chronicle response", result.msg);
    if (result.notify) {
      broadcastEvent("notify", result.msg);
    }
    await postResultWebhook(fromSystem, message, result.msg, Boolean(result.notify));
    return result;
  } catch (error) {
    const msg = error instanceof Error ? error.message : "unknown error";
    return { success: false, code: 500, msg };
  }
}

async function postResultWebhook(
  fromSystem: string,
  originalMessage: string,
  reply: string,
  isNotification: boolean,
): Promise<void> {
  if (isNotification && !isWhatsappNotifyEnabled()) {
    return;
  }
  const url = (process.env.RESULT_WEBHOOK_URL ?? "").trim();
  if (!url) {
    return;
  }
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const auth = (process.env.RESULT_WEBHOOK_AUTH ?? "").trim();
  if (auth) {
    headers.Authorization = auth;
  }
  const payload = {
    from: `cron-result-${fromSystem}`,
    message: reply,
    meta: {
      original_message: originalMessage,
      source: "cron",
      cron_from: fromSystem,
    },
  };
  try {
    console.log(`[result-webhook] POST ${url} payload=${JSON.stringify(payload)}`);
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    const text = await response.text();
    console.log(`[result-webhook] response status=${response.status} body=${text}`);
  } catch (error) {
    const msg = error instanceof Error ? error.message : "unknown error";
    console.warn(`[result-webhook] failed: ${msg}`);
  }
}

export async function compileCustomPrompt(uuid?: string, message?: string): Promise<BrokerResult> {
  try {
    if (!uuid || !message) {
      return { success: false, code: 400, msg: "missing parameter" };
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(message) as Record<string, unknown>;
    } catch (error) {
      return { success: false, code: 400, msg: "message must be valid JSON", uuid };
    }

    const token = typeof payload.Authorization === "string"
      ? payload.Authorization
      : typeof payload.authorization === "string"
        ? payload.authorization
        : "";
    const expected = process.env.WEBHOOK_BEARER_TOKEN ?? "";
    if (expected.length > 0 && token !== expected) {
      return { success: false, code: 401, msg: "unauthorized", uuid };
    }

    delete payload.Authorization;
    delete payload.authorization;

    const response = await rawOllamaRequest<unknown>("/api/chat", payload);
    return { success: true, code: 200, msg: JSON.stringify(response), uuid };
  } catch (error) {
    const msg = error instanceof Error ? error.message : "unknown error";
    return { success: false, code: 500, msg };
  }
}
