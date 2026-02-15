import type { BrokerResult } from "./messageBroker.js";
import { deleteChronicleEvent, getChronicleSchedule } from "./chronicle.js";

function extractEventIds(message: string, knownIds: Set<string>): string[] {
  const tokens = message.match(/[a-zA-Z0-9_-]{6,}/g) ?? [];
  const matched = tokens.filter((token) => knownIds.has(token));
  return Array.from(new Set(matched));
}

export async function handleCronRemove(uuid: string, message: string): Promise<BrokerResult> {
  const normalized = message.trim().toLowerCase();
  const deleteAll = normalized.includes("all");
  const schedule = await getChronicleSchedule(0, 500);
  if (!schedule.ok) {
    return { success: false, code: 502, msg: schedule.error ?? "Failed to query Chronicle", uuid };
  }

  const knownIds = new Set(schedule.rows.map((row) => row.id));
  const idsToDelete = deleteAll
    ? Array.from(knownIds)
    : extractEventIds(message, knownIds);

  if (idsToDelete.length === 0) {
    if (deleteAll) {
      return { success: true, code: 200, msg: "No cron jobs found.", uuid };
    }
    return { success: false, code: 400, msg: "No cron id provided", uuid };
  }

  let deleted = 0;
  for (const id of idsToDelete) {
    const result = await deleteChronicleEvent(id);
    if (!result.ok) {
      return { success: false, code: 502, msg: result.error ?? "Failed to delete Chronicle event", uuid };
    }
    deleted += 1;
  }

  return { success: true, code: 200, msg: `Removed ${deleted} rows`, uuid };
}
