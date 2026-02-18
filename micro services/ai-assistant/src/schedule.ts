import type { BrokerResult } from "./messageBroker.js";
import {
  buildScheduleResponse,
  computeFirstOccurrence,
  extractSchedule,
  extractScheduleAction,
  verifySchedule,
} from "./ollamaClient.js";
import { shouldBypassVerify } from "./ollamaClient.js";
import { createChronicleEvent } from "./chronicle.js";
import { DateTime } from "luxon";

function isReminderScheduleRequest(message: string): boolean {
  const lowered = message.trim().toLowerCase();
  if (!lowered) {
    return false;
  }
  return lowered.includes("remind me") || lowered.startsWith("remind ") || lowered.includes("set reminder");
}

function normalizeReminderText(action: string): string {
  const trimmed = action.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed
    .replace(/^notify me\s*/i, "")
    .replace(/^remind me(?: to)?\s*/i, "")
    .replace(/^set (?:a )?reminder(?: to)?\s*/i, "")
    .trim();
}

function toChronicleAction(message: string, action: string): string {
  const actionText = action.trim();
  if (!actionText) {
    return actionText;
  }
  if (!isReminderScheduleRequest(message)) {
    return actionText;
  }
  if (/^notify me\b/i.test(actionText)) {
    return actionText;
  }
  const reminder = normalizeReminderText(actionText);
  return reminder ? `notify me ${reminder}` : `notify me ${actionText}`;
}

export async function handleSchedule(
  uuid: string,
  from: string,
  message: string,
  options?: { skipConfirmation?: boolean },
): Promise<BrokerResult> {
  console.log(`[schedule] start from=${from} uuid=${uuid} message="${message}"`);
  let extracted: Awaited<ReturnType<typeof extractSchedule>> | null = null;
  let action: Awaited<ReturnType<typeof extractScheduleAction>> | null = null;
  let verified: Awaited<ReturnType<typeof verifySchedule>> | null = null;
  let lastProblem = "";

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const attemptPrompt = lastProblem
      ? `${message}\n\nProblem: ${lastProblem}\nPlease correct the schedule.`
      : message;
    console.log(`[schedule] attempt ${attempt} prompt="${attemptPrompt}"`);

    extracted = await extractSchedule(attemptPrompt);
    if (extracted.contextRequired) {
      return { success: false, code: 400, msg: extracted.invalidReason || "Schedule date is invalid", uuid };
    }
    if (extracted.pastTime) {
      return { success: false, code: 400, msg: extracted.invalidReason || "Schedule time is in the past", uuid };
    }

    if (extracted.isRecurring && !extracted.cron) {
      lastProblem = "Missing cron for recurring schedule.";
      console.warn(`[schedule] ${lastProblem} uuid=${uuid}`);
      continue;
    }
    if (!extracted.isRecurring && !extracted.runAt) {
      lastProblem = "Missing run_at for one-off schedule.";
      console.warn(`[schedule] ${lastProblem} uuid=${uuid}`);
      continue;
    }

    action = await extractScheduleAction(attemptPrompt);
    if (action.contextRequired && action.question) {
      return { success: true, code: 200, msg: action.question, uuid };
    }

    if (!action.action) {
      lastProblem = "Missing action text.";
      console.warn(`[schedule] ${lastProblem} uuid=${uuid}`);
      continue;
    }

    if (extracted.explicitTime || shouldBypassVerify(message)) {
      verified = { confirmed: true, contextRequired: false, raw: {} };
    } else {
      verified = await verifySchedule(message, extracted);
      if (verified.contextRequired && verified.question) {
        return { success: true, code: 200, msg: verified.question, uuid };
      }

      if (!verified.confirmed) {
        const reason = verified.reason ? `: ${verified.reason}` : "";
        lastProblem = `Verification failed${reason}`;
        console.warn(`[schedule] ${lastProblem} uuid=${uuid}`);
        continue;
      }
    }

    break;
  }

  if (!extracted || !action || !verified || !verified.confirmed) {
    return { success: false, code: 400, msg: "Schedule could not be confirmed", uuid };
  }
  const chronicleAction = toChronicleAction(message, action.action);
  if (!chronicleAction) {
    return { success: false, code: 400, msg: "Schedule action is empty", uuid };
  }

  if (!extracted.isRecurring && extracted.runAt) {
    const runAtLocal = DateTime.fromISO(extracted.runAt, { zone: "utc" }).setZone(
      extracted.timezone || "Africa/Johannesburg",
    );
    if (runAtLocal.isValid && runAtLocal <= DateTime.now().setZone(runAtLocal.zoneName)) {
      return { success: false, code: 400, msg: "Schedule time is in the past", uuid };
    }
  }
  const firstOccurrence = computeFirstOccurrence(
    extracted.isRecurring,
    extracted.cron,
    extracted.runAt,
    extracted.timezone || "Africa/Johannesburg",
  );
  const responseMessage = firstOccurrence
    ? await buildScheduleResponse({
        action: chronicleAction,
        summary: extracted.summary,
        isRecurring: extracted.isRecurring,
        cron: extracted.cron,
        runAt: extracted.runAt,
        timezone: extracted.timezone || "Africa/Johannesburg",
        firstOccurrence,
      })
    : "";
  const fallback = extracted.summary
    ? `Schedule saved for ${extracted.summary}`
    : "Schedule saved.";

  const chronicleResult = await createChronicleEvent({
    refId: uuid,
    message: chronicleAction,
    summary: extracted.summary,
    cron: extracted.isRecurring ? extracted.cron : "",
    runAt: extracted.isRecurring ? undefined : extracted.runAt,
    timezone: extracted.timezone || "Africa/Johannesburg",
  });

  if (!chronicleResult.ok || !chronicleResult.id) {
    return {
      success: false,
      code: 502,
      msg: chronicleResult.error ?? "Failed to create Chronicle event",
      uuid,
    };
  }

  return {
    success: true,
    code: 200,
    msg: responseMessage || fallback,
    uuid,
  };
}
