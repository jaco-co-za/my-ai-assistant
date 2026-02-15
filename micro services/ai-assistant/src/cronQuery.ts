import { DateTime } from "luxon";
import type { BrokerResult } from "./messageBroker.js";
import { deleteChronicleEvent, getChronicleSchedule } from "./chronicle.js";
import { formatCronRows } from "./ollamaClient.js";

type ChronicleRow = {
  id: string;
  title?: string;
  timezone?: string;
  timing?: {
    years?: number[];
    months?: number[];
    days?: number[];
    hours?: number[];
    minutes?: number[];
    timezone?: string;
  };
  web_hook_custom_data?: {
    message?: string;
    meta?: {
      summary?: string;
      cron?: string;
      run_at?: string;
      timezone?: string;
    };
  };
};

function parseDateFilter(message: string): { start?: DateTime; end?: DateTime; explicit: boolean } {
  const normalized = message.trim().toLowerCase();
  const now = DateTime.now().setZone("Africa/Johannesburg");
  if (normalized.includes("today")) {
    return { start: now.startOf("day"), end: now.endOf("day"), explicit: true };
  }
  if (normalized.includes("tomorrow")) {
    const tomorrow = now.plus({ days: 1 });
    return { start: tomorrow.startOf("day"), end: tomorrow.endOf("day"), explicit: true };
  }
  const dates = normalized.match(/\d{4}-\d{2}-\d{2}/g) ?? [];
  if (dates.length === 1) {
    const dt = DateTime.fromISO(dates[0], { zone: "Africa/Johannesburg" });
    if (dt.isValid) {
      return { start: dt.startOf("day"), end: dt.endOf("day"), explicit: true };
    }
  }
  if (dates.length >= 2) {
    if (!dates[0] || !dates[1]) {
      return { explicit: true };
    }
    const start = DateTime.fromISO(dates[0], { zone: "Africa/Johannesburg" });
    const end = DateTime.fromISO(dates[1], { zone: "Africa/Johannesburg" });
    if (start.isValid && end.isValid) {
      return { start: start.startOf("day"), end: end.endOf("day"), explicit: true };
    }
  }
  return { explicit: false };
}

function parseRunAt(value: string): DateTime | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const utcParsed = DateTime.fromISO(trimmed, { zone: "utc" }).setZone("Africa/Johannesburg");
  if (utcParsed.isValid) {
    return utcParsed;
  }
  const localParsed = DateTime.fromISO(trimmed, { zone: "Africa/Johannesburg" });
  if (localParsed.isValid) {
    return localParsed;
  }
  return null;
}

function isRecurringRow(row: ChronicleRow): boolean {
  const cron = row.web_hook_custom_data?.meta?.cron ?? "";
  return cron.trim().length > 0;
}

function isPastOneOff(row: ChronicleRow, now: DateTime): boolean {
  if (isRecurringRow(row)) {
    return false;
  }
  const runAt = row.web_hook_custom_data?.meta?.run_at ?? "";
  if (!runAt) {
    return false;
  }
  const dt = parseRunAt(runAt);
  if (!dt) {
    return false;
  }
  return dt <= now;
}

async function cleanupExpiredOneOffChronicleEvents(rows: ChronicleRow[]): Promise<Set<string>> {
  const now = DateTime.now().setZone("Africa/Johannesburg");
  const staleIds = rows
    .filter((row) => isPastOneOff(row, now))
    .map((row) => row.id)
    .filter((id) => Boolean(id));
  const removedIds = new Set<string>();
  for (const id of staleIds) {
    const result = await deleteChronicleEvent(id);
    if (result.ok) {
      removedIds.add(id);
    }
  }
  if (removedIds.size > 0) {
    console.log(`[cron-query-cleanup] deleted expired one-off events=${removedIds.size}`);
  }
  return removedIds;
}

export async function handleCronQuery(uuid: string, message: string): Promise<BrokerResult> {
  const schedule = await getChronicleSchedule(0, 500);
  if (!schedule.ok) {
    return { success: false, code: 502, msg: schedule.error ?? "Failed to query Chronicle", uuid };
  }

  const rows = (schedule.rows ?? []) as ChronicleRow[];
  const deletedIds = await cleanupExpiredOneOffChronicleEvents(rows);
  const activeRows = rows.filter((row) => !deletedIds.has(row.id));
  const now = DateTime.now().setZone("Africa/Johannesburg");
  const { start, end, explicit } = parseDateFilter(message);
  const filtered = activeRows.filter((row) => {
    if (!explicit && isPastOneOff(row, now)) {
      return false;
    }
    const runAt = row.web_hook_custom_data?.meta?.run_at ?? "";
    if (!start || !end) {
      return true;
    }
    if (!runAt) {
      return false;
    }
    const dt = parseRunAt(runAt);
    if (!dt) {
      return false;
    }
    return dt >= start && dt <= end;
  });

  if (filtered.length === 0) {
    return { success: true, code: 200, msg: "No cron jobs found.", uuid };
  }

  const formattedRows = filtered.map((row) => ({
    id: row.id,
    message: row.web_hook_custom_data?.message ?? row.title ?? "",
    summary: row.web_hook_custom_data?.meta?.summary ?? row.title ?? "",
    cron: row.web_hook_custom_data?.meta?.cron ?? "",
    run_at: row.web_hook_custom_data?.meta?.run_at ?? "",
    timezone: row.web_hook_custom_data?.meta?.timezone ?? row.timezone ?? "Africa/Johannesburg",
    is_recurring: row.web_hook_custom_data?.meta?.cron ? 1 : 0,
  }));

  const formatted = await formatCronRows(formattedRows);
  return { success: true, code: 200, msg: formatted, uuid };
}
