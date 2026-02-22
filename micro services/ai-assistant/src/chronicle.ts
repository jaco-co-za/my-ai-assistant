import { DateTime } from "luxon";

type ChronicleTiming = {
  years?: number[];
  months?: number[];
  days?: number[];
  weekdays?: number[];
  hours?: number[];
  minutes?: number[];
  timezone?: string;
};

type ChronicleEventInput = {
  refId: string;
  message: string;
  summary?: string;
  cron?: string;
  runAt?: string;
  timezone: string;
};

type ChronicleEventResult = {
  ok: boolean;
  id?: string;
  error?: string;
};

const DEFAULT_TIMEZONE = "Africa/Johannesburg";

function normalizeBaseUrl(value: string): string {
  if (value.startsWith("http://") || value.startsWith("https://")) {
    return value.replace(/\/+$/, "");
  }
  return `http://${value.replace(/\/+$/, "")}`;
}

function buildWebhookUrl(): string {
  const base = (process.env.BASE_URL ?? "localhost").trim();
  const port = Number(process.env.WEBHOOK_PORT) || 3350;
  const normalized = normalizeBaseUrl(base);
  const url = new URL(normalized);
  if (!url.port) {
    url.port = String(port);
  }
  url.pathname = "/receive-msg";
  return url.toString();
}

function buildWebhookDescriptor(): string {
  const headers: string[] = [];
  const token = (process.env.CHRONICLE_BEARER_TOKEN ?? "").trim();
  if (token.length > 0) {
    headers.push(`Authorization: Bearer ${token}`);
  }
  headers.push("Content-Type: application/json");
  const base = buildWebhookUrl();
  if (headers.length === 0) {
    return base;
  }
  const headerSuffix = headers.map((header) => `[header: ${header}]`).join(" ");
  return `${base} ${headerSuffix}`;
}

function buildWebhookHeaders(): string {
  const headers: string[] = [];
  const token = (process.env.CHRONICLE_BEARER_TOKEN ?? "").trim();
  if (token.length > 0) {
    headers.push(`Authorization: Bearer ${token}`);
  }
  headers.push("Content-Type: application/json");
  return headers.join("\n");
}

function getChronicleTimeoutSec(): string {
  const raw = (process.env.CHRONICLE_TIMEOUT_SEC ?? "").trim();
  const parsed = Number.parseInt(raw, 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    return String(parsed);
  }
  return "30";
}

function parseCronValue(raw: string, isWeekday = false, isMonth = false): number | null {
  const value = raw.trim().toUpperCase();
  if (isMonth) {
    const months: Record<string, number> = {
      JAN: 1,
      FEB: 2,
      MAR: 3,
      APR: 4,
      MAY: 5,
      JUN: 6,
      JUL: 7,
      AUG: 8,
      SEP: 9,
      OCT: 10,
      NOV: 11,
      DEC: 12,
    };
    if (months[value]) {
      return months[value];
    }
  }
  if (isWeekday) {
    const days: Record<string, number> = {
      SUN: 0,
      MON: 1,
      TUE: 2,
      WED: 3,
      THU: 4,
      FRI: 5,
      SAT: 6,
    };
    if (days[value] !== undefined) {
      return days[value];
    }
  }
  const numeric = Number.parseInt(value, 10);
  if (Number.isNaN(numeric)) {
    return null;
  }
  if (isWeekday && numeric === 7) {
    return 0;
  }
  return numeric;
}

function expandCronField(
  field: string,
  min: number,
  max: number,
  isWeekday = false,
  isMonth = false,
): number[] | null {
  const trimmed = field.trim();
  if (trimmed === "*" || trimmed === "?") {
    return null;
  }
  const values = new Set<number>();
  for (const part of trimmed.split(",")) {
    const segment = part.trim();
    if (!segment) {
      continue;
    }
    const [rangePart, stepPart] = segment.split("/");
    const step = stepPart ? Math.max(Number.parseInt(stepPart, 10), 1) : 1;
    let rangeStart = min;
    let rangeEnd = max;
    if (rangePart && rangePart !== "*" && rangePart !== "?") {
      if (rangePart.includes("-")) {
        const [startRaw, endRaw] = rangePart.split("-");
        const startValue = parseCronValue(startRaw, isWeekday, isMonth);
        const endValue = parseCronValue(endRaw, isWeekday, isMonth);
        if (startValue !== null && endValue !== null) {
          rangeStart = startValue;
          rangeEnd = endValue;
        }
      } else {
        const single = parseCronValue(rangePart, isWeekday, isMonth);
        if (single !== null) {
          rangeStart = single;
          rangeEnd = single;
        }
      }
    }
    for (let value = rangeStart; value <= rangeEnd; value += step) {
      if (value < min || value > max) {
        continue;
      }
      values.add(value);
    }
  }
  if (values.size === 0) {
    return null;
  }
  return Array.from(values).sort((a, b) => a - b);
}

function cronToTiming(cronExpression: string): ChronicleTiming | null {
  const parts = cronExpression.trim().split(/\s+/);
  if (parts.length < 5) {
    return null;
  }
  let minute = "";
  let hour = "";
  let day = "";
  let month = "";
  let weekday = "";
  let year = "";

  if (parts.length === 5) {
    [minute, hour, day, month, weekday] = parts;
  } else if (parts.length === 6) {
    if (/^\d{4}$/.test(parts[5])) {
      [minute, hour, day, month, weekday, year] = parts;
    } else {
      [, minute, hour, day, month, weekday] = parts;
    }
  } else if (parts.length >= 7) {
    [, minute, hour, day, month, weekday, year] = parts;
  }

  const timing: ChronicleTiming = {};
  const minutes = expandCronField(minute, 0, 59);
  const hours = expandCronField(hour, 0, 23);
  const days = expandCronField(day, 1, 31);
  const months = expandCronField(month, 1, 12, false, true);
  const weekdays = expandCronField(weekday, 0, 6, true, false);
  const years = year ? expandCronField(year, 1970, 2099) : null;

  if (minutes) timing.minutes = minutes;
  if (hours) timing.hours = hours;
  if (days) timing.days = days;
  if (months) timing.months = months;
  if (weekdays) timing.weekdays = weekdays;
  if (years) timing.years = years;

  return timing;
}

function runAtToTiming(runAt: string, timezone: string): ChronicleTiming | null {
  const zone = timezone || DEFAULT_TIMEZONE;
  const now = DateTime.now().setZone(zone);
  let dt = DateTime.fromISO(runAt, { zone: "utc" }).setZone(zone);
  if (!dt.isValid) {
    return null;
  }
  if (dt <= now) {
    dt = now.plus({ minutes: 1 }).startOf("minute");
  } else if (dt.second > 0 || dt.millisecond > 0) {
    dt = dt.plus({ minutes: 1 }).startOf("minute");
  } else {
    dt = dt.startOf("minute");
  }
  return {
    years: [dt.year],
    months: [dt.month],
    days: [dt.day],
    hours: [dt.hour],
    minutes: [dt.minute],
  };
}

function getChronicleConfig(): {
  baseUrl: string;
  apiKey: string;
  category: string;
  target: string;
  plugin: string;
} | null {
  const baseUrl = (process.env.CHRONICLE_BASE_URL ?? "").trim();
  const apiKey = (process.env.CHRONICLE_API ?? "").trim();
  const category = (process.env.CHRONICLE_CATEGORY_ID ?? "").trim();
  const target = (process.env.CHRONICLE_TARGET ?? "").trim();
  const plugin = (process.env.CHRONICLE_PLUGIN_ID ?? "http").trim();
  if (!baseUrl || !apiKey || !category || !target) {
    return null;
  }
  return {
    baseUrl: normalizeBaseUrl(baseUrl),
    apiKey,
    category,
    target,
    plugin,
  };
}

export async function createChronicleEvent(input: ChronicleEventInput): Promise<ChronicleEventResult> {
  const config = getChronicleConfig();
  if (!config) {
    return { ok: false, error: "Chronicle configuration missing (base url, api key, category, target)" };
  }
  const chronicleConfig = config;

  const timezone = input.timezone || DEFAULT_TIMEZONE;
  const timing = input.cron
    ? cronToTiming(input.cron)
    : input.runAt
      ? runAtToTiming(input.runAt, timezone)
      : null;

  if (!timing) {
    return { ok: false, error: "Unable to build Chronicle timing" };
  }

  const payload = {
    title: input.summary || input.message || `cron-${input.refId}`,
    enabled: 1,
    category: chronicleConfig.category,
    target: chronicleConfig.target,
    plugin: chronicleConfig.plugin,
    timezone,
    timing,
    params: {
      method: "POST",
      url: buildWebhookUrl(),
      headers: buildWebhookHeaders(),
      data: JSON.stringify({
        from: `cron-${input.refId}`,
        message: input.message,
        meta: {
          summary: input.summary || "",
          cron: input.cron || "",
          run_at: input.runAt || "",
          timezone,
        },
      }),
      timeout: getChronicleTimeoutSec(),
      follow: 0,
      ssl_cert_bypass: 0,
      success_match: "",
      error_match: "",
    },
    web_hook: buildWebhookDescriptor(),
    web_hook_custom_data: {
      from: `cron-${input.refId}`,
      message: input.message,
      meta: {
        summary: input.summary || "",
        cron: input.cron || "",
        run_at: input.runAt || "",
        timezone,
      },
    },
  };

  const url = `${chronicleConfig.baseUrl}/api/app/create_event/v1`;
  console.log(`[chronicle] create_event url=${url} refId=${input.refId}`);
  console.log(`[chronicle] create_event payload=${JSON.stringify(payload)}`);

  async function postCreateEvent(eventPayload: Record<string, unknown>) {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": chronicleConfig.apiKey,
      },
      body: JSON.stringify(eventPayload),
    });
    const data = (await response.json()) as { code?: number; id?: string; description?: string };
    return { response, data };
  }

  async function lookupGeneralCategoryId(): Promise<string | null> {
    const endpoints = ["/api/app/get_categories/v1", "/api/app/get_category_list/v1"];
    for (const endpoint of endpoints) {
      try {
        const response = await fetch(`${chronicleConfig.baseUrl}${endpoint}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-API-Key": chronicleConfig.apiKey,
          },
          body: JSON.stringify({}),
        });
        const raw = (await response.json()) as {
          code?: number;
          rows?: Array<Record<string, unknown>>;
          categories?: Array<Record<string, unknown>>;
        };
        if (!response.ok || raw.code !== 0) {
          continue;
        }
        const rows = Array.isArray(raw.rows)
          ? raw.rows
          : Array.isArray(raw.categories)
            ? raw.categories
            : [];
        const match = rows.find((row) => {
          const name = String(row?.title ?? row?.name ?? row?.label ?? "").trim().toLowerCase();
          return name === "general";
        });
        const id = String(match?.id ?? match?._id ?? "").trim();
        if (id) {
          return id;
        }
      } catch {
        // Try next endpoint.
      }
    }
    return null;
  }

  try {
    let { response, data } = await postCreateEvent(payload as unknown as Record<string, unknown>);
    console.log(`[chronicle] create_event response=${JSON.stringify(data)}`);
    if ((!response.ok || data.code !== 0 || !data.id) && /category not found/i.test(String(data?.description || ""))) {
      const generalCategoryId = await lookupGeneralCategoryId();
      if (generalCategoryId && generalCategoryId !== chronicleConfig.category) {
        const retryPayload = { ...payload, category: generalCategoryId };
        console.warn(
          `[chronicle] category '${chronicleConfig.category}' not found, retrying with General category id='${generalCategoryId}'`,
        );
        ({ response, data } = await postCreateEvent(retryPayload as unknown as Record<string, unknown>));
        console.log(`[chronicle] create_event retry response=${JSON.stringify(data)}`);
      }
    }
    if (!response.ok || data.code !== 0 || !data.id) {
      const error = data.description || `Chronicle error (status ${response.status})`;
      console.warn(`[chronicle] create_event failed: ${error}`);
      return { ok: false, error };
    }
    console.log(`[chronicle] create_event ok id=${data.id}`);
    return { ok: true, id: data.id };
  } catch (error) {
    const msg = error instanceof Error ? error.message : "unknown error";
    console.warn(`[chronicle] create_event failed: ${msg}`);
    return { ok: false, error: msg };
  }
}

export async function deleteChronicleEvent(eventId: string): Promise<ChronicleEventResult> {
  const config = getChronicleConfig();
  if (!config) {
    return { ok: false, error: "Chronicle configuration missing (base url, api key, category, target)" };
  }
  const url = `${config.baseUrl}/api/app/delete_event/v1`;
  console.log(`[chronicle] delete_event url=${url} id=${eventId}`);
  console.log(`[chronicle] delete_event payload=${JSON.stringify({ id: eventId })}`);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": config.apiKey,
      },
      body: JSON.stringify({ id: eventId }),
    });
    const data = (await response.json()) as { code?: number; description?: string };
    console.log(`[chronicle] delete_event response=${JSON.stringify(data)}`);
    if (!response.ok || data.code !== 0) {
      const error = data.description || `Chronicle error (status ${response.status})`;
      console.warn(`[chronicle] delete_event failed: ${error}`);
      return { ok: false, error };
    }
    console.log(`[chronicle] delete_event ok id=${eventId}`);
    return { ok: true, id: eventId };
  } catch (error) {
    const msg = error instanceof Error ? error.message : "unknown error";
    console.warn(`[chronicle] delete_event failed: ${msg}`);
    return { ok: false, error: msg };
  }
}

export type ChronicleScheduleRow = {
  id: string;
  title?: string;
  timezone?: string;
  timing?: ChronicleTiming;
  web_hook_custom_data?: {
    from?: string;
    message?: string;
    meta?: {
      summary?: string;
      cron?: string;
      run_at?: string;
      timezone?: string;
    };
  };
};

export async function getChronicleSchedule(offset = 0, limit = 200): Promise<{
  ok: boolean;
  rows: ChronicleScheduleRow[];
  error?: string;
}> {
  const config = getChronicleConfig();
  if (!config) {
    return {
      ok: false,
      rows: [],
      error: "Chronicle configuration missing (base url, api key, category, target)",
    };
  }
  const url = `${config.baseUrl}/api/app/get_schedule/v1`;
  const payload = { offset, limit };
  console.log(`[chronicle] get_schedule url=${url}`);
  console.log(`[chronicle] get_schedule payload=${JSON.stringify(payload)}`);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": config.apiKey,
      },
      body: JSON.stringify(payload),
    });
    const data = (await response.json()) as { code?: number; rows?: ChronicleScheduleRow[]; description?: string };
    console.log(`[chronicle] get_schedule response=${JSON.stringify(data)}`);
    if (!response.ok || data.code !== 0 || !Array.isArray(data.rows)) {
      const error = data.description || `Chronicle error (status ${response.status})`;
      console.warn(`[chronicle] get_schedule failed: ${error}`);
      return { ok: false, rows: [], error };
    }
    return { ok: true, rows: data.rows };
  } catch (error) {
    const msg = error instanceof Error ? error.message : "unknown error";
    console.warn(`[chronicle] get_schedule failed: ${msg}`);
    return { ok: false, rows: [], error: msg };
  }
}
