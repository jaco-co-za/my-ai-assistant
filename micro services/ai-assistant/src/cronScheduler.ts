import cron from "node-cron";
import { getDatabase } from "./database.js";
import {
  classifyAndCompile,
  storeCronRun,
  storeIncomingMessage,
  storeOutgoingMessage,
} from "./messageBroker.js";

type CronRow = {
  id: number;
  cron: string;
  run_at: string | null;
  is_recurring: number;
  active: number;
  timezone: string | null;
  action: string | null;
};

type ScheduledEntry = {
  signature: string;
  task: cron.ScheduledTask;
};

const scheduled = new Map<number, ScheduledEntry>();
let refreshTimer: NodeJS.Timeout | null = null;
let oneOffTimer: NodeJS.Timeout | null = null;
const executionQueue: CronRow[] = [];
let isProcessingQueue = false;
let lastExecutionAt = 0;

function buildSignature(row: CronRow): string {
  return `${row.cron}|${row.timezone ?? ""}|${row.action ?? ""}`;
}

function loadCrons(): CronRow[] {
  const db = getDatabase();
  return db
    .prepare("SELECT id, cron, run_at, is_recurring, active, timezone, action FROM crons")
    .all() as CronRow[];
}

function updateCronStatus(cronId: number, result?: string, error?: string, deactivate = false): void {
  const db = getDatabase();
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE crons SET last_run_at = ?, last_result = ?, last_error = ?, active = ? WHERE id = ?`,
  ).run(now, result ?? null, error ?? null, deactivate ? 0 : 1, cronId);
}

async function runCron(row: CronRow): Promise<void> {
  if (!row.action) {
    return;
  }

  const from = `cron-${row.id}`;
  const stored = storeIncomingMessage({ from, message: row.action });
  try {
    const result = await classifyAndCompile(from, row.action, stored.id);
    storeOutgoingMessage({ inmessageId: stored.id, message: result.msg });
    storeCronRun({
      cronId: row.id,
      inmessageId: stored.id,
      status: "success",
      result: result.msg,
    });
    updateCronStatus(row.id, result.msg, undefined, row.is_recurring === 0);
  } catch (error) {
    const msg = error instanceof Error ? error.message : "unknown error";
    storeCronRun({
      cronId: row.id,
      inmessageId: stored.id,
      status: "error",
      error: msg,
    });
    updateCronStatus(row.id, undefined, msg, row.is_recurring === 0);
  }
}

function enqueueCron(row: CronRow): void {
  executionQueue.push(row);
  void processQueue();
}

async function processQueue(): Promise<void> {
  if (isProcessingQueue) {
    return;
  }
  isProcessingQueue = true;
  try {
    while (executionQueue.length > 0) {
      const now = Date.now();
      const waitMs = Math.max(0, 5_000 - (now - lastExecutionAt));
      if (waitMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
      const next = executionQueue.shift();
      if (!next) {
        break;
      }
      lastExecutionAt = Date.now();
      await runCron(next);
    }
  } finally {
    isProcessingQueue = false;
  }
}

function scheduleCron(row: CronRow): void {
  const timezone = row.timezone || undefined;
  if (!cron.validate(row.cron)) {
    console.warn(`[cron] invalid cron expression id=${row.id} cron=${row.cron}`);
    return;
  }

  console.log(`[cron] schedule id=${row.id} cron="${row.cron}" timezone="${row.timezone ?? ""}"`);
  const task = cron.schedule(
    row.cron,
    () => {
      enqueueCron(row);
    },
    timezone ? { timezone } : undefined,
  );
  scheduled.set(row.id, { signature: buildSignature(row), task });
}

function syncCrons(): void {
  const rows = loadCrons();
  const existing = new Set<number>(scheduled.keys());

  for (const row of rows) {
    if (row.is_recurring === 0 || row.active === 0) {
      continue;
    }
    existing.delete(row.id);
    const signature = buildSignature(row);
    const current = scheduled.get(row.id);
    if (current && current.signature === signature) {
      continue;
    }
    if (current) {
      current.task.stop();
      scheduled.delete(row.id);
    }
    if (row.action) {
      scheduleCron(row);
    }
  }

  for (const id of existing) {
    const entry = scheduled.get(id);
    if (entry) {
      entry.task.stop();
      scheduled.delete(id);
    }
  }
}

function checkOneOffs(): void {
  const db = getDatabase();
  const now = new Date().toISOString();
  const rows = db
    .prepare(
      `SELECT id, cron, run_at, is_recurring, active, timezone, action FROM crons
       WHERE is_recurring = 0 AND active = 1 AND last_run_at IS NULL AND run_at IS NOT NULL AND run_at <= ?`,
    )
    .all(now) as CronRow[];
  if (rows.length > 0) {
    console.log(`[cron] one-off ready count=${rows.length}`);
    const ids = rows.map((row) => row.id);
    const placeholders = ids.map(() => "?").join(", ");
    db.prepare(`UPDATE crons SET active = 0 WHERE id IN (${placeholders})`).run(...ids);
  }
  for (const row of rows) {
    enqueueCron(row);
  }
}

export function startCronScheduler(): void {
  syncCrons();
  checkOneOffs();
  if (refreshTimer) {
    clearInterval(refreshTimer);
  }
  if (oneOffTimer) {
    clearInterval(oneOffTimer);
  }
  refreshTimer = setInterval(syncCrons, 30_000);
  oneOffTimer = setInterval(checkOneOffs, 5_000);
}
