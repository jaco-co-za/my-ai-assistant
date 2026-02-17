import type { BrokerResult } from "./messageBroker.js";
import { intentClassifier, extractTemporaryAction } from "./ollamaClient.js";
import { getDatabase } from "./database.js";
import { randomUUID } from "node:crypto";
import { createChronicleEvent } from "./chronicle.js";
import { DateTime } from "luxon";
import { handleSchedule } from "./schedule.js";

const DEFAULT_HASS_URL = "http://192.168.55.73:3222/requests";
const CONFIRM_TTL_MS = Number(process.env.CONFIRM_TTL_SEC ?? "") > 0
  ? Number(process.env.CONFIRM_TTL_SEC) * 1000
  : 120_000;

function resolveHassUrl(raw?: string): string {
  const value = (raw || "").trim();
  if (!value) {
    return DEFAULT_HASS_URL;
  }
  if (value.startsWith("http://") || value.startsWith("https://")) {
    return value;
  }
  return `http://${value}`;
}

async function postHomeAssistant(payload: Record<string, unknown>): Promise<string> {
  const url = resolveHassUrl(process.env.HOME_ASSISTANT_MICRO_SERVICE_URL);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const auth = (process.env.HASS_MICRO_AUTH || "").trim();
  if (auth) {
    headers.Authorization = auth;
  }

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });

  const text = await response.text();
  return text;
}

function createAppConfirmation(from: string, url: string, payload: Record<string, unknown>): void {
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

function extractJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      const slice = trimmed.slice(start, end + 1);
      try {
        return JSON.parse(slice) as Record<string, unknown>;
      } catch {
        return null;
      }
    }
    return null;
  }
}

function extractStateFromText(text: string): string | null {
  const normalized = text.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  const patterns: Array<{ regex: RegExp; state: string }> = [
    { regex: /\bis on\b/, state: "on" },
    { regex: /\bis off\b/, state: "off" },
    { regex: /\bis open\b/, state: "open" },
    { regex: /\bis closed\b/, state: "closed" },
    { regex: /\bis locked\b/, state: "locked" },
    { regex: /\bis unlocked\b/, state: "unlocked" },
  ];
  for (const pattern of patterns) {
    if (pattern.regex.test(normalized)) {
      return pattern.state;
    }
  }
  return null;
}

function isFollowUpQuestionFlag(parsed: Record<string, unknown>): boolean {
  const direct = parsed["follow-up-question"];
  const snake = parsed.follow_up_question;
  const compact = parsed.followup_question;
  const values = [direct, snake, compact];
  return values.some((value) => value === true || value === 1 || value === "true" || value === "1");
}

function isNotifyFlag(parsed: Record<string, unknown>): boolean {
  const value = parsed.notify;
  return value === true || value === 1 || value === "true" || value === "1";
}

async function getCurrentEntityState(entity: string): Promise<string | null> {
  const payload = {
    prompt: `Get the current state for entity "${entity}". Return ONLY JSON with fields: state (string), entity_id (string).`,
    result: "Class: homeassistant | Intent: get-state | Verb: get",
  };
  console.info("[homeassistant] get-state request", {
    url: resolveHassUrl(process.env.HOME_ASSISTANT_MICRO_SERVICE_URL),
    payload,
  });
  const responseText = await postHomeAssistant(payload);
  console.info("[homeassistant] get-state response", responseText);
  const parsed = extractJsonObject(responseText);
  const directState = typeof parsed?.state === "string" ? parsed.state.trim() : "";
  if (directState) {
    return directState;
  }
  const entities = Array.isArray(parsed?.entities) ? (parsed?.entities as Array<Record<string, unknown>>) : [];
  if (entities.length > 0) {
    const first = entities[0];
    const entityState = typeof first?.state === "string" ? first.state.trim() : "";
    if (entityState) {
      return entityState;
    }
  }
  if (parsed && typeof parsed === "object") {
    const entries = Object.entries(parsed).filter(([, value]) => typeof value === "string") as Array<
      [string, string]
    >;
    if (entries.length === 1) {
      return entries[0][1].trim();
    }
    if (entries.length > 1) {
      const lowered = entity.trim().toLowerCase();
      const hints = [
        lowered.replace(/\s+/g, "_"),
        lowered.replace(/\s+/g, "."),
      ];
      const match = entries.find(([key]) => hints.some((hint) => hint && key.toLowerCase().includes(hint)));
      if (match) {
        return match[1].trim();
      }
    }
  }
  return extractStateFromText(responseText);
}

function buildRestoreAction(entity: string, state: string): string {
  const normalized = state.trim().toLowerCase();
  if (normalized === "on") {
    return `turn on ${entity}`;
  }
  if (normalized === "off") {
    return `turn off ${entity}`;
  }
  if (normalized === "open") {
    return `open ${entity}`;
  }
  if (normalized === "closed" || normalized === "close") {
    return `close ${entity}`;
  }
  if (normalized === "locked") {
    return `lock ${entity}`;
  }
  if (normalized === "unlocked") {
    return `unlock ${entity}`;
  }
  return `set ${entity} to ${state}`;
}

function isTemporaryRequest(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  if (/\bfor\b/.test(normalized)) {
    return true;
  }
  if (normalized.includes("temporarily")) {
    return true;
  }
  if (normalized.includes("for a bit") || normalized.includes("for a while") || normalized.includes("for awhile")) {
    return true;
  }
  if (normalized.includes("then turn back") || normalized.includes("then switch back")) {
    return true;
  }
  return false;
}

export async function handleHomeAssistant(
  uuid: string,
  message: string,
  fromSystem?: string,
  options?: { skipCache?: boolean },
): Promise<BrokerResult> {
  const skipCache = Boolean(options?.skipCache);
  const isCron = typeof fromSystem === "string" && fromSystem.startsWith("cron-");
  if (isCron) {
    const payload = {
      prompt: message,
      result: "Class: homeassistant | Intent: cron-action | Verb: execute",
    };
    try {
      const responseText = await postHomeAssistant(payload);
      const trimmed = responseText.trim();
      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        const confirm = parsed?.confirm === true;
        const confirmMessage = typeof parsed?.message === "string" ? parsed.message.trim() : "";
        const isFollowUp = isFollowUpQuestionFlag(parsed);
        const notify = isNotifyFlag(parsed);
        if (confirm && confirmMessage) {
          const url = resolveHassUrl(process.env.HOME_ASSISTANT_MICRO_SERVICE_URL);
          createAppConfirmation(fromSystem ?? "cron", url, payload);
          return {
            success: true,
            code: 200,
            msg: `${confirmMessage} Reply YES to confirm or NO to cancel.`,
            uuid,
            notify,
          };
        }
        if (isFollowUp) {
          return {
            success: true,
            code: 200,
            msg: confirmMessage || responseText,
            uuid,
            followUpRoute: "homeassistant",
            notify,
          };
        }
      } catch {
        // ignore parse errors
      }
      return { success: true, code: 200, msg: responseText, uuid };
    } catch (error) {
      const msg = error instanceof Error ? error.message : "unknown error";
      console.warn(`[homeassistant] cron request failed: ${msg}`);
      return { success: false, code: 503, msg: "Home assistant service is unavailable", uuid };
    }
  }

  const temporary = await extractTemporaryAction(message);
  const useTemporary =
    temporary.durationSeconds > 0 &&
    temporary.action &&
    temporary.entity &&
    temporary.desiredState &&
    isTemporaryRequest(message);
  if (useTemporary) {
    try {
      const currentState = await getCurrentEntityState(temporary.entity);
      if (!currentState) {
        return { success: false, code: 400, msg: "Unable to read current state", uuid };
      }

      const immediateIntent = await intentClassifier(temporary.action, "homeassistant", { skipCache });
  if (!immediateIntent.intent || immediateIntent.intent === "unknown") {
        return {
          success: false,
          code: 400,
          msg:
            'Unable to parse intent. To add example: intent add class=email intent=count-sent verb=count desc="count sent emails".',
          uuid,
        };
      }

      const immediateVerb = immediateIntent.verb ? ` | Verb: ${immediateIntent.verb}` : "";
      const immediateResult = `Class: homeassistant | Intent: ${immediateIntent.intent}${immediateVerb}`;
      const immediatePayload = {
        prompt: temporary.action,
        result: immediateResult,
      };
      const responseText = await postHomeAssistant(immediatePayload);

      const startedAt = DateTime.now().setZone("Africa/Johannesburg");
      const targetAt = startedAt.plus({ seconds: temporary.durationSeconds });
      const minFuture = DateTime.now().setZone("Africa/Johannesburg").plus({ seconds: 1 });
      const effectiveAt = targetAt <= minFuture ? minFuture : targetAt;
      const runAt = effectiveAt.toUTC().toISO();
      const restoreAction = buildRestoreAction(temporary.entity, currentState);
      const chronicleResult = await createChronicleEvent({
        refId: `restore-${uuid}`,
        message: restoreAction,
        summary: `Restore ${temporary.entity}`,
        cron: "",
        runAt: runAt ?? undefined,
        timezone: "Africa/Johannesburg",
      });

      if (!chronicleResult.ok) {
        return { success: false, code: 502, msg: chronicleResult.error ?? "Failed to schedule restore", uuid };
      }

      const suffix = `Will restore in ${temporary.durationSeconds} seconds.`;
      const trimmed = responseText.trim();
      const msg = trimmed ? `${trimmed}\n${suffix}` : suffix;
      return { success: true, code: 200, msg, uuid };
    } catch (error) {
      const msg = error instanceof Error ? error.message : "unknown error";
      console.warn(`[homeassistant] temporary action failed: ${msg}`);
      return { success: false, code: 503, msg: "Home assistant service is unavailable", uuid };
    }
  }

  const intent = await intentClassifier(message, "homeassistant", { skipCache });

  if (!intent.intent || intent.intent === "unknown") {
    return {
      success: false,
      code: 400,
      msg:
        'Unable to parse intent. To add example: intent add class=email intent=count-sent verb=count desc="count sent emails".',
      uuid,
    };
  }

  const intentLabel = (intent.intent || "").toLowerCase();
  const verbLabel = (intent.verb || "").toLowerCase();
  const isScheduleIntent =
    intentLabel.includes("schedule") ||
    intentLabel.includes("timer") ||
    verbLabel.includes("timer") ||
    verbLabel.includes("schedule");
  if (isScheduleIntent) {
    return handleSchedule(uuid, "homeassistant", message);
  }

  const verbLabelText = intent.verb ? ` | Verb: ${intent.verb}` : "";
  const llmResult = `Class: homeassistant | Intent: ${intent.intent}${verbLabelText}`;
  const payload = {
    prompt: message,
    result: llmResult,
  };

  try {
    const responseText = await postHomeAssistant(payload);
    const trimmed = responseText.trim();
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const confirm = parsed?.confirm === true;
      const confirmMessage = typeof parsed?.message === "string" ? parsed.message.trim() : "";
      const isFollowUp = isFollowUpQuestionFlag(parsed);
      const notify = isNotifyFlag(parsed);
      if (confirm && confirmMessage) {
        const url = resolveHassUrl(process.env.HOME_ASSISTANT_MICRO_SERVICE_URL);
        createAppConfirmation(fromSystem ?? "queue-ui", url, payload);
        return {
          success: true,
          code: 200,
          msg: `${confirmMessage} Reply YES to confirm or NO to cancel.`,
          uuid,
          notify,
        };
      }
      if (isFollowUp) {
        return {
          success: true,
          code: 200,
          msg: confirmMessage || responseText,
          uuid,
          followUpRoute: "homeassistant",
          notify,
        };
      }
    } catch {
      // ignore parse errors
    }
    return { success: true, code: 200, msg: responseText, uuid };
  } catch (error) {
    const msg = error instanceof Error ? error.message : "unknown error";
    console.warn(`[homeassistant] request failed: ${msg}`);
    return { success: false, code: 503, msg: "Home assistant service is unavailable", uuid };
  }
}
