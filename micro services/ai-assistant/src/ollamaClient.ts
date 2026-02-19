import 'dotenv/config';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { DateTime } from 'luxon';
import cronParser from 'cron-parser';
import { getDatabase } from './database.js';
import Database from "better-sqlite3";

import * as readline from 'node:readline/promises';

import { buildDynamicIntentInstructions } from "./dynamicIntents.js";
import { getCodexLaunchSpec } from "./codexEnvironment.js";

const DEFAULT_OLLAMA_URL = 'http://localhost:11434';
const DEFAULT_OLLAMA_MODEL = 'qwen2.5:14b';
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_RETRIES = 3;
const DEFAULT_ENV_PATH = '.env';
const DEFAULT_TRANSCRIBE_URL = 'http://192.168.55.113:3221';
const DEFAULT_PROMPTS_DIR = 'prompts';

const OLLAMA_URL = process.env.OLLAMA_URL || DEFAULT_OLLAMA_URL;
const OLLAMA_API_KEY = process.env.OLLAMA_API_KEY || '';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || '';
const OLLAMA_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
const OLLAMA_RETRIES = Number(process.env.OLLAMA_RETRIES || DEFAULT_RETRIES);
const TRANSCRIBE_URL = process.env.TRANSCRIBE_URL || DEFAULT_TRANSCRIBE_URL;
const PROMPTS_DIR = process.env.PROMPTS_DIR || DEFAULT_PROMPTS_DIR;
const PROMPT_CLASSES = process.env.PROMPT_CLASSES || 'homeassistant,email,file,general';
const INTENT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DURATION_PATTERN = /\bfor\s+(\d+)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w|months?)\b/i;
const OPENAI_ENABLED = (process.env.OPEN_AI_ENABLED ?? '').trim().toLowerCase();
const OPENAI_CODEX_ENABLED = (process.env.OPEN_AI_CODEX_ENABLED ?? '').trim().toLowerCase();
const OPENAI_TOKEN = (process.env.OPENAI_TOKEN ?? '').trim();
const OPENAI_MODEL = (process.env.OPENAI_MODEL ?? '').trim();
const OPENAI_SQL_MODEL = (process.env.OPENAI_SQL_MODEL ?? '').trim();
const OPENAI_BASE_URL = 'https://api.openai.com/v1';
const LEARNINGS_DB_PATH = path.resolve("data", "learnings.db");
const LEARNING_STOP_WORDS = new Set([
  "the","is","always","be","are","a","an","and","or","of","to","in","on","for","with","at","by","from","as","that","this",
  "it","its","your","my","our","their","was","were","will","would","should","could","can","may","might","do","does","did",
  "have","has","had","about","into","over","under","up","down","out","off","if","then","so","than","too","very",
]);

export type Role = 'system' | 'user' | 'assistant';

export interface Message {
  role: Role;
  content: string;
}

export interface ChatCompletionRequest {
  model?: string;
  messages: Message[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stream?: boolean;
  format?: string;
  options?: Record<string, unknown>;
}

export interface ChatCompletionResponse {
  model: string;
  created_at: string;
  message: Message;
  done: boolean;
  done_reason?: string;
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  eval_count?: number;
  eval_duration?: number;
}

export interface CompletionRequest {
  model?: string;
  prompt: string;
  stream?: boolean;
  format?: string;
  options?: Record<string, unknown>;
}

export interface CompletionResponse {
  model: string;
  created_at: string;
  response: string;
  done: boolean;
  done_reason?: string;
  context?: number[];
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  eval_count?: number;
  eval_duration?: number;
}

export interface EmbeddingRequest {
  model?: string;
  input: string | string[];
}

export interface EmbeddingResponse {
  object: string;
  model: string;
  data: {
    embedding: number[];
    index: number;
  }[];
  usage: {
    prompt_tokens: number;
    total_tokens: number;
  };
}

type TranscribeOptions = {
  mimeType?: string;
  task?: 'transcribe' | 'translate';
};

type PromptTemplate = {
  name?: string;
  version?: number;
  instructions: string | string[];
  output_schema?: Record<string, unknown>;
};

export type IntentResult = {
  intent: string;
  verb?: string;
  contextRequired: boolean;
  question?: string;
};

function isIntentCacheEnabled(): boolean {
  const value = (process.env.CACHE_INTENTS ?? '').trim().toLowerCase();
  return value === 'true' || value === '1' || value === 'yes';
}

function getCachedIntent(prompt: string, messageClass: string): IntentResult | null {
  if (!isIntentCacheEnabled()) {
    return null;
  }
  const db = getDatabase();
  const key = normalizeCacheKey(prompt);
  const row = db.prepare(
    `SELECT intent, verb, created_at FROM intent_cache WHERE prompt = ? AND class = ? ORDER BY created_at DESC LIMIT 1`,
  ).get(key, messageClass) as { intent: string; verb?: string | null; created_at: string } | undefined;
  if (!row) {
    console.log("[cache] intent miss");
    return null;
  }
  const createdAt = Date.parse(row.created_at);
  if (Number.isNaN(createdAt)) {
    console.log("[cache] intent miss (invalid date)");
    return null;
  }
  if (Date.now() - createdAt > INTENT_TTL_MS) {
    console.log("[cache] intent miss (expired)");
    return null;
  }
  console.log("[cache] intent hit");
  return { intent: row.intent, verb: row.verb ?? undefined, contextRequired: false };
}

function setCachedIntent(prompt: string, messageClass: string, intent: string, verb?: string): void {
  if (!isIntentCacheEnabled()) {
    return;
  }
  if (!intent || intent === 'unknown') {
    return;
  }
  const key = normalizeCacheKey(prompt);
  const db = getDatabase();
  db.prepare(
    `INSERT INTO intent_cache (prompt, class, intent, verb, created_at) VALUES (?, ?, ?, ?, datetime('now'))`,
  ).run(key, messageClass, intent, verb ?? null);
}

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

function normalizeTemporaryCacheKey(text: string): { key: string; durationSeconds: number } {
  const normalized = normalizeCacheKey(text);
  const match = text.match(DURATION_PATTERN);
  let durationSeconds = 0;
  if (match) {
    const value = Number(match[1]);
    const unit = match[2].toLowerCase();
    if (Number.isFinite(value) && value > 0) {
      if (unit.startsWith("s")) durationSeconds = value;
      else if (unit.startsWith("m")) durationSeconds = value * 60;
      else if (unit.startsWith("h")) durationSeconds = value * 3600;
      else if (unit.startsWith("d")) durationSeconds = value * 86400;
      else if (unit.startsWith("w")) durationSeconds = value * 604800;
      else if (unit.startsWith("month")) durationSeconds = value * 2592000;
    }
  }
  const key = `${normalized}|${durationSeconds}`;
  return { key, durationSeconds };
}

function getCachedTemporaryAction(prompt: string): TemporaryActionResult | null {
  if (!isIntentCacheEnabled()) {
    return null;
  }
  const db = getDatabase();
  const { key } = normalizeTemporaryCacheKey(prompt);
  const row = db.prepare(
    `SELECT action, entity, desired_state, duration_seconds, created_at
     FROM temporary_action_cache WHERE prompt = ? ORDER BY created_at DESC LIMIT 1`,
  ).get(key) as
    | {
        action: string;
        entity: string;
        desired_state: string;
        duration_seconds: number;
        created_at: string;
      }
    | undefined;
  if (!row) {
    console.log("[cache] temporary action miss");
    return null;
  }
  const createdAt = Date.parse(row.created_at);
  if (Number.isNaN(createdAt)) {
    console.log("[cache] temporary action miss (invalid date)");
    return null;
  }
  if (Date.now() - createdAt > INTENT_TTL_MS) {
    console.log("[cache] temporary action miss (expired)");
    return null;
  }
  console.log("[cache] temporary action hit");
  return {
    action: row.action,
    entity: row.entity,
    desiredState: row.desired_state,
    durationSeconds: row.duration_seconds,
    raw: {},
  };
}

function setCachedTemporaryAction(result: TemporaryActionResult, prompt: string): void {
  if (!isIntentCacheEnabled()) {
    return;
  }
  if (!result.action || !result.entity || !result.desiredState || result.durationSeconds <= 0) {
    return;
  }
  const { key, durationSeconds } = normalizeTemporaryCacheKey(prompt);
  const db = getDatabase();
  db.prepare(
    `INSERT INTO temporary_action_cache
     (prompt, action, entity, desired_state, duration_seconds, created_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))`,
  ).run(key, result.action, result.entity, result.desiredState, durationSeconds || result.durationSeconds);
}

export type ScheduleResult = {
  cron: string;
  runAt?: string;
  isRecurring: boolean;
  explicitTime: boolean;
  pastTime: boolean;
  invalidReason?: string;
  timezone?: string;
  summary?: string;
  contextRequired: boolean;
  question?: string;
  raw: Record<string, unknown>;
};

export type ScheduleVerifyResult = {
  confirmed: boolean;
  contextRequired: boolean;
  question?: string;
  reason?: string;
  raw: Record<string, unknown>;
};

export type ScheduleResponseInput = {
  action: string;
  summary?: string;
  isRecurring: boolean;
  cron: string;
  runAt?: string;
  timezone: string;
  firstOccurrence: string;
};

export type ScheduleActionResult = {
  action: string;
  contextRequired: boolean;
  question?: string;
  raw: Record<string, unknown>;
};

export type TemporaryActionResult = {
  action: string;
  entity: string;
  desiredState: string;
  durationSeconds: number;
  raw: Record<string, unknown>;
};

const promptCache = new Map<string, PromptTemplate>();

async function loadPromptTemplate(name: string): Promise<PromptTemplate> {
  const cached = promptCache.get(name);
  if (cached) {
    return cached;
  }

  const promptPath = path.resolve(process.cwd(), PROMPTS_DIR, `${name}.json`);
  const content = await fs.readFile(promptPath, 'utf8');
  const parsed = JSON.parse(content) as PromptTemplate;
  promptCache.set(name, parsed);
  return parsed;
}

function parsePromptClasses(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function normalizeInstructions(instructions: string | string[]): string {
  if (Array.isArray(instructions)) {
    return instructions.join('\n');
  }
  return instructions;
}

function withNormalizedInstructions(template: PromptTemplate): PromptTemplate {
  return {
    ...template,
    instructions: normalizeInstructions(template.instructions),
  };
}

function renderPromptInstructions(template: PromptTemplate, classes: string[]): string {
  const label = classes.join(', ');
  return normalizeInstructions(template.instructions).replace('{{classes}}', label);
}

function renderPromptForClass(template: PromptTemplate, messageClass: string): string {
  return normalizeInstructions(template.instructions).replace('{{class}}', messageClass);
}

function tokenizeLearning(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((token) => token.trim())
    .filter((token) => token.length > 0 && !LEARNING_STOP_WORDS.has(token));
}

function getRelevantLearnings(prompt: string): string[] {
  const cleaned = prompt.replace(/^vn-transcribed:/i, "").trim();
  const text = cleaned.toLowerCase();
  let db: Database.Database | null = null;
  try {
    db = new Database(LEARNINGS_DB_PATH);
  } catch {
    return [];
  }
  try {
    const rows = db.prepare("SELECT content FROM learnings ORDER BY id ASC;").all() as Array<{ content: string }>;
    const learnings = rows
      .map((row) => (row?.content ? String(row.content).trim() : ""))
      .filter((value) => value.length > 0);
    return learnings.filter((learning) => {
      const tokens = tokenizeLearning(learning);
      return tokens.some((token) => text.includes(token));
    });
  } catch {
    return [];
  } finally {
    try {
      db.close();
    } catch {
      // ignore
    }
  }
}

export function getClassificationCacheTag(prompt: string): string {
  const relevant = getRelevantLearnings(prompt);
  if (relevant.length === 0) {
    return "none";
  }
  const hash = createHash("sha1")
    .update(relevant.join("\n"))
    .digest("hex");
  return `learn:${hash}`;
}

function parseRelativeOffsetMs(text: string): number | null {
  const match = text.match(/\bin\s+(\d+)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w)\b/i);
  if (!match) {
    return null;
  }
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }
  const unit = match[2].toLowerCase();
  if (unit.startsWith('s')) {
    return value * 1000;
  }
  if (unit.startsWith('m')) {
    return value * 60_000;
  }
  if (unit.startsWith('h')) {
    return value * 60 * 60_000;
  }
  if (unit.startsWith('d')) {
    return value * 24 * 60 * 60_000;
  }
  if (unit.startsWith('w')) {
    return value * 7 * 24 * 60 * 60_000;
  }
  return null;
}

export function shouldBypassVerify(text: string): boolean {
  return /\bin\s+\d+\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w)\b/i.test(text);
}

function hasNegativeOffset(text: string): boolean {
  return /\bin\s*-\s*\d+\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w)\b/i.test(text);
}

function normalizeRunAt(runAt: string, timezone: string): string | undefined {
  const trimmed = runAt.trim();
  if (!trimmed) {
    return undefined;
  }
  const hasOffset = /[+-]\d{2}:\d{2}$/.test(trimmed);
  const hasZulu = /[zZ]$/.test(trimmed);
  let dt: DateTime;
  if (hasOffset) {
    dt = DateTime.fromISO(trimmed, { setZone: true }).toUTC();
  } else if (hasZulu) {
    // Treat Z timestamps as local time in the user's timezone, then convert to UTC.
    dt = DateTime.fromISO(trimmed.replace(/[zZ]$/, ''), { zone: timezone }).toUTC();
  } else {
    dt = DateTime.fromISO(trimmed, { zone: timezone }).toUTC();
  }
  if (!dt.isValid) {
    return undefined;
  }
  return dt.toISO() ?? undefined;
}

function parseExplicitLocalTime(text: string, timezone: string): string | null {
  let hour = Number.NaN;
  let minute = Number.NaN;
  const amPmMatch = text.match(/\b(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)\b/i);
  if (amPmMatch) {
    hour = Number(amPmMatch[1]);
    minute = amPmMatch[2] ? Number(amPmMatch[2]) : 0;
    const meridiem = amPmMatch[3].toLowerCase();
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
      return null;
    }
    if (hour < 1 || hour > 12 || minute < 0 || minute > 59) {
      return null;
    }
    if (meridiem === 'pm' && hour !== 12) {
      hour += 12;
    }
    if (meridiem === 'am' && hour === 12) {
      hour = 0;
    }
  } else {
    const twentyFourHourMatch = text.match(/\b(?:at\s*)?([01]?\d|2[0-3])[:.]([0-5]\d)\b/i);
    if (!twentyFourHourMatch) {
      return null;
    }
    hour = Number(twentyFourHourMatch[1]);
    minute = Number(twentyFourHourMatch[2]);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
      return null;
    }
  }

  let base = DateTime.now().setZone(timezone);
  const inMonthsMatch = text.match(/\bin\s+(\d+)\s+months?\b/i);
  const inWeeksMatch = text.match(/\bin\s+(\d+)\s+weeks?\b/i);
  const inDaysMatch = text.match(/\bin\s+(\d+)\s+days?\b/i);
  const andDaysMatch = text.match(/\band\s+(\d+)\s+days?\b/i);
  if (inMonthsMatch) {
    const months = Number(inMonthsMatch[1]);
    if (Number.isFinite(months) && months > 0) {
      base = base.plus({ months });
    }
    const extraDays = andDaysMatch ? Number(andDaysMatch[1]) : Number.NaN;
    if (Number.isFinite(extraDays) && extraDays > 0) {
      base = base.plus({ days: extraDays });
    }
  } else if (inWeeksMatch) {
    const weeks = Number(inWeeksMatch[1]);
    if (Number.isFinite(weeks) && weeks > 0) {
      base = base.plus({ days: weeks * 7 });
    }
  } else if (inDaysMatch) {
    const days = Number(inDaysMatch[1]);
    if (Number.isFinite(days) && days > 0) {
      base = base.plus({ days });
    }
  } else if (/\b(tomorrow|tommorow)\b/i.test(text)) {
    base = base.plus({ days: 1 });
  } else if (!/\btoday\b/i.test(text)) {
    const candidate = base.set({ hour, minute, second: 0, millisecond: 0 });
    if (candidate <= base) {
      base = base.plus({ days: 1 });
    }
  }

  const local = base.set({ hour, minute, second: 0, millisecond: 0 });
  return local.toUTC().toISO() ?? null;
}

type ModelRequest = {
  model?: string;
};
function resolveModel<T extends ModelRequest>(req: T): T & { model: string } {
  const configuredModel = process.env.OLLAMA_MODEL || OLLAMA_MODEL;
  const model = req.model || configuredModel;
  return { ...req, model: model || DEFAULT_OLLAMA_MODEL };
}

function buildHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (OLLAMA_API_KEY) {
    headers.Authorization = `Bearer ${OLLAMA_API_KEY}`;
  }
  return headers;
}

function isOpenAIEnabled(): boolean {
  return Boolean(OPENAI_TOKEN) && (OPENAI_ENABLED === 'true' || OPENAI_ENABLED === '1' || OPENAI_ENABLED === 'yes');
}

function isCodexCliEnabled(): boolean {
  if (isOpenAIEnabled()) {
    return false;
  }
  return OPENAI_CODEX_ENABLED === 'true' || OPENAI_CODEX_ENABLED === '1' || OPENAI_CODEX_ENABLED === 'yes';
}

function isCommandExecutionEnabled(): boolean {
  const value = (process.env.ALLOW_COMMAND_EXECUTION ?? "").trim().toLowerCase();
  return value === "true" || value === "1" || value === "yes";
}

function isCodexTraceEnabled(): boolean {
  const value = (process.env.CODEX_TRACE_ENABLED ?? "false").trim().toLowerCase();
  return value === "true" || value === "1" || value === "yes";
}

export function getLlmProviderLabel(): "codex" | "openai" | "ollama" {
  if (isCodexCliEnabled()) {
    return "codex";
  }
  if (isOpenAIEnabled()) {
    return "openai";
  }
  return "ollama";
}

function resolveOpenAIModel(requestedModel?: string): string | undefined {
  if (requestedModel && requestedModel.toLowerCase().includes('coder')) {
    return OPENAI_SQL_MODEL || undefined;
  }
  if (requestedModel && requestedModel.toLowerCase().includes('qwen')) {
    return OPENAI_MODEL || undefined;
  }
  return requestedModel || OPENAI_MODEL || undefined;
}

function resolveCodexModel(requestedModel?: string): string | undefined {
  const requested = (requestedModel ?? '').trim();
  if (requested && !requested.includes(':') && !requested.toLowerCase().includes('qwen')) {
    return requested;
  }
  if (OPENAI_SQL_MODEL) {
    return OPENAI_SQL_MODEL;
  }
  if (OPENAI_MODEL) {
    return OPENAI_MODEL;
  }
  return undefined;
}

function buildCodexPrompt(req: ChatCompletionRequest): string {
  const chunks: string[] = [];
  for (const message of req.messages || []) {
    const role = String(message.role || 'user').toUpperCase();
    const content = String(message.content || '').trim();
    if (!content) {
      continue;
    }
    chunks.push(`${role}:\n${content}`);
  }
  if ((req.format ?? '').trim().toLowerCase() === 'json') {
    chunks.push('Return ONLY valid JSON. Do not include markdown or code fences.');
  }
  return chunks.join('\n\n');
}

async function runCodexExecPrompt(prompt: string, model?: string): Promise<string> {
  const codexLaunch = await getCodexLaunchSpec();
  const outputPath = path.resolve(process.cwd(), "data", `codex-llm-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  const normalizePromptForCodexExec = (value: string): string => {
    const raw = String(value || "");
    return raw.replace(/services[\\/]+ai-assistant[\\/]+/gi, "");
  };

  const extractCodexFinalMessage = (raw: string): string => {
    const text = String(raw || "").replace(/\r\n/g, "\n").trim();
    if (!text) {
      return "";
    }
    const matches = Array.from(text.matchAll(/(?:^|\n)codex\n([\s\S]*?)(?:\ntokens used\b|$)/gi));
    if (matches.length > 0) {
      const candidate = (matches[matches.length - 1]?.[1] || "").trim();
      if (candidate) {
        return candidate;
      }
    }
    return text
      .replace(/^Debugger attached\.\s*/i, "")
      .replace(/\n?tokens used[\s\S]*$/i, "")
      .replace(/\n?Waiting for the debugger to disconnect\.\s*$/i, "")
      .trim();
  };

  return new Promise((resolve, reject) => {
    let settled = false;
    let logs = "";
    let timer: NodeJS.Timeout | null = null;
    const args = ["exec", "--skip-git-repo-check", "--output-last-message", outputPath];
    if (isCommandExecutionEnabled()) {
      args.push("--dangerously-bypass-approvals-and-sandbox");
    }
    if (model) {
      args.push("--model", model);
    }
    if (isCodexTraceEnabled()) {
      console.log(`[codex] exec args=${JSON.stringify(args)}`);
    }

    const finishResolve = async (value: string): Promise<void> => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      try {
        await fs.unlink(outputPath);
      } catch {
        // ignore cleanup
      }
      resolve(value);
    };

    const finishReject = async (error: Error): Promise<void> => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      try {
        await fs.unlink(outputPath);
      } catch {
        // ignore cleanup
      }
      reject(error);
    };

    let child;
    try {
      child = spawn(codexLaunch.command, [...codexLaunch.prefixArgs, ...args], {
        shell: false,
        windowsHide: true,
        env: codexLaunch.env,
      });
      child.stdin.write(`${normalizePromptForCodexExec(prompt)}\n`);
      child.stdin.end();
    } catch (error) {
      const msg = error instanceof Error ? error.message : "unknown error";
      void finishReject(new Error(`Codex spawn failed: ${msg}`));
      return;
    }

    const collect = (chunk: Buffer | string): void => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      logs += text;
      if (isCodexTraceEnabled() && text.trim().length > 0) {
        const lines = text.split(/\r?\n/g).filter((line) => line.trim().length > 0);
        for (const line of lines) {
          console.log(`[codex] ${line}`);
        }
      }
    };

    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", (error: Error) => {
      void finishReject(new Error(`Codex exec failed: ${error.message}`));
    });
    child.on("exit", async (code) => {
      let finalText = "";
      try {
        finalText = (await fs.readFile(outputPath, "utf8")).trim();
      } catch {
        finalText = "";
      }
      if (!finalText) {
        finalText = logs.trim();
      }
      finalText = extractCodexFinalMessage(finalText || logs);
      if (code !== 0) {
        const tail = finalText || logs.trim() || `exit code ${code}`;
        await finishReject(new Error(`Codex exec failed: ${tail}`));
        return;
      }
      if (isCodexTraceEnabled()) {
        console.log(`[codex] exec done model=${model || "default"} output_chars=${finalText.length}`);
      }
      await finishResolve(finalText);
    });

    timer = setTimeout(() => {
      child.kill();
      const tail = logs.trim() || "timed out";
      void finishReject(new Error(`Codex exec timeout: ${tail}`));
    }, OLLAMA_TIMEOUT_MS);
  });
}

async function codexChatCompletion(req: ChatCompletionRequest): Promise<ChatCompletionResponse> {
  const model = resolveCodexModel(req.model);
  const prompt = buildCodexPrompt(req);
  if (!prompt.trim()) {
    throw new Error("Codex request has no prompt content");
  }
  const content = await runCodexExecPrompt(prompt, model);
  return {
    model: model || "codex-cli",
    created_at: new Date().toISOString(),
    message: { role: "assistant", content: content.trim() },
    done: true,
    done_reason: "stop",
  };
}

function isCodexCliMissing(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error || "");
  return /spawn\s+codex\s+enoent/i.test(msg) || /codex.*not\s+found/i.test(msg);
}

async function openaiChatCompletion(req: ChatCompletionRequest): Promise<ChatCompletionResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS);
  const model = resolveOpenAIModel(req.model);
  const useResponses = typeof model === "string" && model.toLowerCase().includes("gpt-5.2-codex");

  try {
    if (useResponses) {
      const body = {
        model,
        input: req.messages.map((message) => ({
          role: message.role,
          content: message.content,
        })),
        max_output_tokens: req.max_tokens,
      } as Record<string, unknown>;

      const response = await fetch(`${OPENAI_BASE_URL}/responses`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${OPENAI_TOKEN}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`OpenAI ${response.status} ${response.statusText}: ${errorText}`);
      }

      const json = await response.json() as {
        id: string;
        model: string;
        created_at: number;
        output: Array<{
          type: string;
          role?: string;
          content?: Array<{ type: string; text?: string }>;
        }>;
      };

      const outputText = (json.output || [])
        .flatMap((item) => item.content || [])
        .map((item) => item.text || "")
        .filter(Boolean)
        .join("");

      return {
        model: json.model || model || "",
        created_at: new Date((json.created_at ?? Math.floor(Date.now() / 1000)) * 1000).toISOString(),
        message: { role: "assistant", content: outputText },
        done: true,
        done_reason: "stop",
      };
    }

    const body = {
      messages: req.messages,
      temperature: req.temperature,
      top_p: req.top_p,
      max_completion_tokens: req.max_tokens,
    } as Record<string, unknown>;
    if (model) {
      body.model = model;
    }

    const response = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_TOKEN}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenAI ${response.status} ${response.statusText}: ${errorText}`);
    }

    const json = await response.json() as {
      id: string;
      model: string;
      created: number;
      choices: Array<{
        message: { role: Role; content: string };
        finish_reason?: string;
      }>;
    };

    const choice = json.choices?.[0];
    if (!choice) {
      throw new Error("OpenAI response missing choices");
    }

    return {
      model: json.model || model || "",
      created_at: new Date((json.created ?? Math.floor(Date.now() / 1000)) * 1000).toISOString(),
      message: choice.message,
      done: true,
      done_reason: choice.finish_reason,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function summarizeRequestBody(body: unknown): string {
  if (typeof body !== 'object' || body === null) {
    return String(body);
  }

  const record = body as Record<string, unknown>;
  const model = typeof record.model === 'string' ? record.model : '';
  const messages = Array.isArray(record.messages) ? record.messages.length : undefined;
  const prompt = typeof record.prompt === 'string' ? record.prompt.length : undefined;
  const format = typeof record.format === 'string' ? record.format : '';
  const stream = typeof record.stream === 'boolean' ? record.stream : undefined;
  const options = typeof record.options === 'object' && record.options !== null ? Object.keys(record.options).length : undefined;

  return [
    model ? `model=${model}` : '',
    typeof messages === 'number' ? `messages=${messages}` : '',
    typeof prompt === 'number' ? `promptChars=${prompt}` : '',
    format ? `format=${format}` : '',
    typeof stream === 'boolean' ? `stream=${stream}` : '',
    typeof options === 'number' ? `options=${options}` : ''
  ].filter(Boolean).join(' ');
}

async function post<T>(path: string, body: unknown, retries = OLLAMA_RETRIES): Promise<T> {
  const url = `${OLLAMA_URL}${path}`;
  const summary = summarizeRequestBody(body);

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: buildHeaders(),
        body: JSON.stringify(body),
        signal: controller.signal
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Ollama ${response.status} ${response.statusText}: ${errorText}`);
      }

      const json = (await response.json()) as T;
      return json;
    } catch (error) {
      if (attempt === retries) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 200 * 2 ** attempt));
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error('Ollama request failed unexpectedly.');
}

async function get<T>(path: string, retries = OLLAMA_RETRIES): Promise<T> {
  const url = `${OLLAMA_URL}${path}`;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: buildHeaders(),
        signal: controller.signal
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Ollama ${response.status} ${response.statusText}: ${errorText}`);
      }

      return (await response.json()) as T;
    } catch (error) {
      if (attempt === retries) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 200 * 2 ** attempt));
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error('Ollama request failed unexpectedly.');
}

export async function rawOllamaRequest<T>(path: string, body: unknown): Promise<T> {
  const isLikelyOllamaModel = (modelValue: unknown): boolean => {
    if (typeof modelValue !== "string") {
      return false;
    }
    const model = modelValue.trim().toLowerCase();
    if (!model) {
      return false;
    }
    // Typical Ollama/local model id formats: "model:tag", "qwen...", "llama...", etc.
    return model.includes(":") || model.startsWith("qwen") || model.startsWith("llama") || model.startsWith("mistral");
  };

  if (isCodexCliEnabled() && path === '/api/chat' && typeof body === 'object' && body !== null) {
    const record = body as Partial<ChatCompletionRequest>;
    if (Array.isArray(record.messages) && !isLikelyOllamaModel(record.model)) {
      try {
        return (await codexChatCompletion(record as ChatCompletionRequest)) as unknown as T;
      } catch (error) {
        if (isCodexCliMissing(error)) {
          console.warn("[codex] CLI not found; falling back to Ollama /api/chat");
          return post<T>(path, body);
        }
        throw error;
      }
    }
  }
  if (isOpenAIEnabled() && path === '/api/chat' && typeof body === 'object' && body !== null) {
    const record = body as Partial<ChatCompletionRequest>;
    if (Array.isArray(record.messages) && !isLikelyOllamaModel(record.model)) {
      return (await openaiChatCompletion(record as ChatCompletionRequest)) as unknown as T;
    }
  }
  return post<T>(path, body);
}

export async function generalChat(text: string): Promise<string> {
  const trimmed = text.trim();
  if (!trimmed) {
    return '';
  }

  try {
    const template = withNormalizedInstructions(await loadPromptTemplate('general'));
    const response = await chatCompletion({
      messages: [
        { role: 'system', content: JSON.stringify(template) },
        { role: 'user', content: trimmed }
      ],
      temperature: 0.2,
      max_tokens: 512,
      stream: false,
      format: 'json'
    });
    return response.message.content.trim();
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'unknown error';
    console.warn(`[general-chat] failed: ${msg}`);
    return '';
  }
}

export async function extractSchedule(text: string): Promise<ScheduleResult> {
  const trimmed = text.trim();
  if (!trimmed) {
    return {
      cron: '',
      isRecurring: true,
      explicitTime: false,
      pastTime: false,
      invalidReason: undefined,
      contextRequired: true,
      question: 'Please provide a schedule.',
      raw: {},
    };
  }

  try {
    console.log(`[schedule-extract] input="${trimmed}"`);
    const template = withNormalizedInstructions(await loadPromptTemplate('schedule'));
    const nowIso = new Date().toISOString();
    const payload = { ...template, current_time: nowIso };
    const response = await chatCompletion({
      messages: [
        { role: 'system', content: JSON.stringify(payload) },
        { role: 'user', content: trimmed }
      ],
      temperature: 0,
      max_tokens: 256,
      stream: false,
      format: 'json'
    });
    const raw = response.message.content.trim();
    console.log(`[schedule-extract] raw="${raw}"`);
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed['context-required'] === true) {
      const question = typeof parsed.question === 'string' ? parsed.question : 'Please provide more details.';
      console.log(`[schedule-extract] context-required question="${question}"`);
      return {
        cron: '',
        isRecurring: true,
        explicitTime: false,
        pastTime: false,
        invalidReason: question || 'Schedule is invalid',
        contextRequired: false,
        question: undefined,
        raw: parsed,
      };
    }

    const cron = typeof parsed.cron === 'string' ? parsed.cron.trim() : '';
    const runAt = typeof parsed.run_at === 'string' ? parsed.run_at.trim() : '';
    const isRecurring = parsed.is_recurring === false ? false : true;
    const timezoneRaw = typeof parsed.timezone === 'string' ? parsed.timezone.trim() : '';
    const timezone = timezoneRaw || 'Africa/Johannesburg';
    const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : '';
    console.log(
      `[schedule-extract] parsed cron="${cron}" run_at="${runAt}" is_recurring=${isRecurring} timezone="${timezone}" summary="${summary}"`,
    );
    let resolvedRunAt = runAt || undefined;
    let usedExplicitTime = false;
    let pastTime = false;
    let invalidReason: string | undefined;
    if (!isRecurring) {
      if (hasNegativeOffset(trimmed)) {
        return {
          cron: '',
          isRecurring,
          explicitTime: false,
          pastTime: false,
          invalidReason: 'Relative time cannot be negative',
          contextRequired: false,
          question: undefined,
          raw: parsed,
        };
      }
      const explicitTime = parseExplicitLocalTime(trimmed, timezone);
      if (explicitTime) {
        resolvedRunAt = explicitTime;
        usedExplicitTime = true;
        console.log(`[schedule-extract] run_at overridden by explicit time -> ${resolvedRunAt}`);
      }
      const offsetMs = usedExplicitTime ? null : parseRelativeOffsetMs(trimmed);
      if (offsetMs) {
        resolvedRunAt = new Date(Date.now() + offsetMs).toISOString();
        usedExplicitTime = true;
        console.log(`[schedule-extract] run_at overridden by relative offset -> ${resolvedRunAt}`);
      } else if (resolvedRunAt && !usedExplicitTime) {
        const normalized = normalizeRunAt(resolvedRunAt, timezone);
        if (normalized) {
          resolvedRunAt = normalized;
        }
      }
      if (resolvedRunAt) {
        const parsedMs = Date.parse(resolvedRunAt);
        if (!Number.isNaN(parsedMs) && parsedMs <= Date.now()) {
          return {
            cron: '',
            isRecurring,
            explicitTime: usedExplicitTime,
            pastTime: true,
            invalidReason: 'Schedule time is in the past',
            contextRequired: false,
            raw: parsed,
          };
        }
      }
    }
    return {
      cron,
      runAt: resolvedRunAt,
      isRecurring,
      explicitTime: usedExplicitTime,
      pastTime,
      invalidReason,
      timezone,
      summary: summary || undefined,
      contextRequired: false,
      raw: parsed,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'unknown error';
    console.warn(`[schedule-extract] failed: ${msg}`);
    return {
      cron: '',
      isRecurring: true,
      explicitTime: false,
      pastTime: false,
      invalidReason: undefined,
      contextRequired: true,
      question: 'Please restate the schedule.',
      raw: {},
    };
  }
}

export async function verifySchedule(text: string, schedule: ScheduleResult): Promise<ScheduleVerifyResult> {
  const trimmed = text.trim();
  if (!trimmed) {
    return { confirmed: false, contextRequired: true, question: 'Please provide a schedule.', raw: {} };
  }

  try {
    console.log(
      `[schedule-verify] input="${trimmed}" cron="${schedule.cron}" run_at="${schedule.runAt ?? ""}" is_recurring=${schedule.isRecurring} timezone="${schedule.timezone ?? ""}" summary="${schedule.summary ?? ""}"`,
    );
    const template = withNormalizedInstructions(await loadPromptTemplate('schedule-verify'));
    const localRunAt = schedule.runAt
      ? DateTime.fromISO(schedule.runAt, { zone: 'utc' })
          .setZone(schedule.timezone || 'Africa/Johannesburg')
          .toFormat('yyyy-LL-dd HH:mm:ss')
      : '';
    const payload = {
      ...template,
      input: {
        message: trimmed,
        schedule: {
          cron: schedule.cron,
          run_at: schedule.runAt || '',
          is_recurring: schedule.isRecurring,
          timezone: schedule.timezone || '',
          summary: schedule.summary || '',
          local_time: localRunAt,
        },
      },
    };
    const response = await chatCompletion({
      messages: [
        { role: 'system', content: JSON.stringify(payload) },
        { role: 'user', content: trimmed }
      ],
      temperature: 0,
      max_tokens: 256,
      stream: false,
      format: 'json'
    });
    const raw = response.message.content.trim();
    console.log(`[schedule-verify] raw="${raw}"`);
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const confirmed = parsed.confirmed === true;
    const reason = typeof parsed.reason === 'string' ? parsed.reason : undefined;
    console.log(`[schedule-verify] confirmed=${confirmed} reason="${reason ?? ""}"`);
    return { confirmed, contextRequired: false, reason, raw: parsed };
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'unknown error';
    console.warn(`[schedule-verify] failed: ${msg}`);
    return { confirmed: false, contextRequired: true, question: 'Please restate the schedule.', raw: {} };
  }
}

export async function extractScheduleAction(text: string): Promise<ScheduleActionResult> {
  const trimmed = text.trim();
  if (!trimmed) {
    return { action: '', contextRequired: false, raw: {} };
  }

  try {
    console.log(`[schedule-action] input="${trimmed}"`);
    const template = withNormalizedInstructions(await loadPromptTemplate('schedule-action'));
    const response = await chatCompletion({
      messages: [
        { role: 'system', content: JSON.stringify(template) },
        { role: 'user', content: trimmed }
      ],
      temperature: 0,
      max_tokens: 256,
      stream: false,
      format: 'json'
    });
    const raw = response.message.content.trim();
    console.log(`[schedule-action] raw="${raw}"`);
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const action = typeof parsed.action === 'string' ? parsed.action.trim() : '';
    console.log(`[schedule-action] parsed action="${action}"`);
    return { action, contextRequired: false, raw: parsed };
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'unknown error';
    console.warn(`[schedule-action] failed: ${msg}`);
    return { action: '', contextRequired: false, raw: {} };
  }
}

export async function extractTemporaryAction(text: string): Promise<TemporaryActionResult> {
  const trimmed = text.trim();
  if (!trimmed) {
    return { action: '', entity: '', desiredState: '', durationSeconds: 0, raw: {} };
  }

  try {
    const cached = getCachedTemporaryAction(trimmed);
    if (cached) {
      return cached;
    }
    const template = withNormalizedInstructions(await loadPromptTemplate('temporary-action-extract'));
    const response = await chatCompletion({
      messages: [
        { role: 'system', content: JSON.stringify(template) },
        { role: 'user', content: trimmed }
      ],
      temperature: 0,
      max_tokens: 256,
      stream: false,
      format: 'json'
    });
    const raw = response.message.content.trim();
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const action = typeof parsed.action === 'string' ? parsed.action.trim() : '';
    const entity = typeof parsed.entity === 'string' ? parsed.entity.trim() : '';
    const desiredState = typeof parsed.desired_state === 'string' ? parsed.desired_state.trim() : '';
    const durationSeconds = typeof parsed.duration_seconds === 'number'
      ? Math.max(0, Math.floor(parsed.duration_seconds))
      : 0;
    const result = { action, entity, desiredState, durationSeconds, raw: parsed };
    setCachedTemporaryAction(result, trimmed);
    return result;
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'unknown error';
    console.warn(`[temporary-action-extract] failed: ${msg}`);
    return { action: '', entity: '', desiredState: '', durationSeconds: 0, raw: {} };
  }
}

export async function buildScheduleResponse(input: ScheduleResponseInput): Promise<string> {
  try {
    const template = withNormalizedInstructions(await loadPromptTemplate('schedule-response'));
    const payload = {
      ...template,
      input,
    };
    const response = await chatCompletion({
      messages: [
        { role: 'system', content: JSON.stringify(payload) },
        {
          role: 'user',
          content: `action="${input.action}" first_occurrence="${input.firstOccurrence}"`
        }
      ],
      temperature: 0.2,
      max_tokens: 128,
      stream: false,
      format: 'json'
    });
    const raw = response.message.content.trim();
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.message === 'string' && parsed.message.trim()) {
      return parsed.message.trim();
    }
    return '';
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'unknown error';
    console.warn(`[schedule-response] failed: ${msg}`);
    return '';
  }
}

export function computeFirstOccurrence(
  isRecurring: boolean,
  cronExpression: string,
  runAt: string | undefined,
  timezone: string,
): string | null {
  if (!timezone) {
    timezone = 'Africa/Johannesburg';
  }
  if (!isRecurring) {
    if (!runAt) {
      return null;
    }
    const dt = DateTime.fromISO(runAt, { zone: 'utc' }).setZone(timezone);
    if (!dt.isValid) {
      return null;
    }
    return dt.toFormat('yyyy-LL-dd HH:mm:ss');
  }

  try {
    const interval = cronParser.parseExpression(cronExpression, {
      currentDate: new Date(),
      tz: timezone,
    });
    const next = interval.next().toDate();
    const dt = DateTime.fromJSDate(next, { zone: timezone });
    return dt.toFormat('yyyy-LL-dd HH:mm:ss');
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'unknown error';
    console.warn(`[schedule-response] compute failed: ${msg}`);
    return null;
  }
}

const CRON_SCHEMA = `
Table: crons
Columns:
- id (INTEGER, primary key)
- inmessage_id (TEXT)
- from (TEXT)
- message (TEXT)
- cron (TEXT)
- run_at (TEXT)
- is_recurring (INTEGER)
- active (INTEGER)
- timezone (TEXT)
- summary (TEXT)
- action (TEXT)
- last_run_at (TEXT)
- last_result (TEXT)
- last_error (TEXT)
- raw_json (TEXT)
- created_at (TEXT)

Table: cron_runs
Columns:
- id (TEXT, primary key)
- cron_id (TEXT)
- inmessage_id (TEXT)
- status (TEXT)
- result (TEXT)
- error (TEXT)
- created_at (TEXT)
`.trim();

export async function cronQuerySql(text: string): Promise<string> {
  const trimmed = text.trim();
  if (!trimmed) {
    return 'SELECT * FROM crons ORDER BY created_at DESC';
  }

  try {
    const template = withNormalizedInstructions(await loadPromptTemplate('cron-query'));
    const payload = { ...template, schema: CRON_SCHEMA };
    const messages: Message[] = [
      { role: 'system', content: JSON.stringify(payload) },
      { role: 'user', content: trimmed }
    ];
    const request = {
      model: isOpenAIEnabled() ? (OPENAI_SQL_MODEL || undefined) : 'qwen2.5-coder:14b',
      messages,
      temperature: 0,
      max_tokens: 256,
      stream: false,
      format: 'json'
    };
    let raw = '';
    try {
      const response = await chatCompletion(request);
      raw = response.message.content.trim();
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'unknown error';
      if (msg.includes("model 'qwen2.5-coder") && msg.includes("not found")) {
        const fallback = await chatCompletion({ ...request, model: undefined });
        raw = fallback.message.content.trim();
      } else {
        throw error;
      }
    }
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const sql = typeof parsed.sql === 'string' ? parsed.sql.trim() : '';
    return sql || 'SELECT * FROM crons ORDER BY created_at DESC';
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'unknown error';
    console.warn(`[cron-query] failed: ${msg}`);
    return 'SELECT * FROM crons ORDER BY created_at DESC';
  }
}

export async function formatCronRows(rows: unknown[]): Promise<string> {
  if (!rows || rows.length === 0) {
    return "No cron jobs found.";
  }

  const fallback = () => {
    const typed = rows as Array<Record<string, unknown>>;
    return typed
      .map((row) => {
        const id = typeof row.id === "number" ? String(row.id) : typeof row.id === "string" ? row.id : "unknown";
        const action = typeof row.action === "string" ? row.action : "";
        const summary = typeof row.summary === "string" ? row.summary : "";
        const runAtRaw = typeof row.run_at === "string" ? row.run_at : "";
        const runAt = runAtRaw
          ? DateTime.fromISO(runAtRaw, { zone: "utc" })
              .setZone("Africa/Johannesburg")
              .toFormat("yyyy-LL-dd HH:mm:ss")
          : "";
        const cron = typeof row.cron === "string" ? row.cron : "";
        const when = runAt || cron || "";
        const details = [action || summary, when].filter(Boolean).join(" | ");
        return `${id}${details ? ` | ${details}` : ""}`;
      })
      .join("\n");
  };

  try {
    const template = withNormalizedInstructions(await loadPromptTemplate('cron-display'));
    const normalizedRows = (rows as Array<Record<string, unknown>>).map((row) => {
      const runAtRaw = typeof row.run_at === "string" ? row.run_at : "";
      const runAt = runAtRaw
        ? DateTime.fromISO(runAtRaw, { zone: "utc" })
            .setZone("Africa/Johannesburg")
            .toFormat("yyyy-LL-dd HH:mm:ss")
        : "";
      return {
        ...row,
        run_at: runAt,
      };
    });
    const payload = { ...template, rows: normalizedRows, timezone: "Africa/Johannesburg" };
    const response = await chatCompletion({
      messages: [
        { role: 'system', content: JSON.stringify(payload) },
        { role: 'user', content: `Format ${rows.length} cron rows.` }
      ],
      temperature: 0,
      max_tokens: 512,
      stream: false,
      format: 'json'
    });
    const raw = response.message.content.trim();
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.message === 'string' && parsed.message.trim()) {
      const message = parsed.message.trim();
      const typedRows = rows as Array<Record<string, unknown>>;
      const missingId = typedRows.some((row) => {
        const id = typeof row.id === "number" ? String(row.id) : typeof row.id === "string" ? row.id : "";
        return id && !message.includes(id);
      });
      return missingId ? fallback() : message;
    }
    return fallback();
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'unknown error';
    console.warn(`[cron-display] failed: ${msg}`);
    return fallback();
  }
}

export async function cronRemoveSql(text: string): Promise<string> {
  const trimmed = text.trim();
  if (!trimmed) {
    return '';
  }

  try {
    const template = withNormalizedInstructions(await loadPromptTemplate('cron-remove'));
    const payload = { ...template, schema: CRON_SCHEMA };
    const messages: Message[] = [
      { role: 'system', content: JSON.stringify(payload) },
      { role: 'user', content: trimmed }
    ];
    const request = {
      model: isOpenAIEnabled() ? (OPENAI_SQL_MODEL || undefined) : 'qwen2.5-coder:14b',
      messages,
      temperature: 0,
      max_tokens: 256,
      stream: false,
      format: 'json'
    };
    let raw = '';
    try {
      const response = await chatCompletion(request);
      raw = response.message.content.trim();
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'unknown error';
      if (msg.includes("model 'qwen2.5-coder") && msg.includes("not found")) {
        const fallback = await chatCompletion({ ...request, model: undefined });
        raw = fallback.message.content.trim();
      } else {
        throw error;
      }
    }
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const sql = typeof parsed.sql === 'string' ? parsed.sql.trim() : '';
    return sql;
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'unknown error';
    console.warn(`[cron-remove] failed: ${msg}`);
    return '';
  }
}

type OllamaTagsResponse = {
  models?: Array<{
    name?: string;
    model?: string;
  }>;
};

function upsertEnvValue(content: string, key: string, value: string): string {
  const line = `${key}=${value}`;
  const keyPattern = new RegExp(`^${key}=.*$`, 'm');

  if (keyPattern.test(content)) {
    return content.replace(keyPattern, line);
  }

  const withNewline = content.length > 0 && !content.endsWith('\n') ? `${content}\n` : content;
  return `${withNewline}${line}\n`;
}

export async function listAvailableModels(): Promise<string[]> {
  const tags = await get<OllamaTagsResponse>('/api/tags');
  const modelNames = (tags.models || [])
    .map((model) => model.name || model.model || '')
    .filter((name): name is string => Boolean(name));

  return Array.from(new Set(modelNames));
}

export async function ensureOllamaModelConfigured(envPath = DEFAULT_ENV_PATH): Promise<string> {
  const configuredModel = process.env.OLLAMA_MODEL || OLLAMA_MODEL;
  if (configuredModel) {
    return configuredModel;
  }

  const models = await listAvailableModels();
  if (models.length === 0) {
    throw new Error('No Ollama models found. Pull a model first (for example: ollama pull llama3:8b).');
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.env.OLLAMA_MODEL = DEFAULT_OLLAMA_MODEL;
    return DEFAULT_OLLAMA_MODEL;
  }

  console.log('\nOllama models available:');
  models.forEach((model, index) => {
    console.log(`  ${index + 1}) ${model}`);
  });

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  let selectedModel = '';
  try {
    while (!selectedModel) {
      const answer = (await rl.question(`Select a model [1-${models.length}]: `)).trim();
      const selectedIndex = Number(answer);
      if (Number.isInteger(selectedIndex) && selectedIndex >= 1 && selectedIndex <= models.length) {
        selectedModel = models[selectedIndex - 1];
      } else if (models.includes(answer)) {
        selectedModel = answer;
      } else {
        console.log('Invalid selection. Enter a number from the list or an exact model name.');
      }
    }
  } finally {
    rl.close();
  }

  const envContent = await fs.readFile(envPath, 'utf8').catch(() => '');
  const updatedEnv = upsertEnvValue(envContent, 'OLLAMA_MODEL', selectedModel);
  await fs.writeFile(envPath, updatedEnv, 'utf8');
  process.env.OLLAMA_MODEL = selectedModel;

  return selectedModel;
}

export type OllamaStartupCheck = {
  ok: boolean;
  models: string[];
  configuredModel: string;
  error?: string;
};

export async function testOllamaOnStartup(): Promise<OllamaStartupCheck> {
  const configuredModel = process.env.OLLAMA_MODEL || OLLAMA_MODEL || DEFAULT_OLLAMA_MODEL;

  try {
    const models = await listAvailableModels();
    return { ok: true, models, configuredModel };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';
    return { ok: false, models: [], configuredModel, error: message };
  }
}

function mimeTypeToExtension(mimeType: string): string {
  const normalized = mimeType.split(';')[0]?.trim().toLowerCase();
  switch (normalized) {
    case 'audio/ogg':
      return 'ogg';
    case 'audio/wav':
    case 'audio/x-wav':
      return 'wav';
    case 'audio/mpeg':
    case 'audio/mp3':
      return 'mp3';
    case 'audio/webm':
      return 'webm';
    default:
      return 'bin';
  }
}

function extractTranscription(responseText: string, json: unknown): string {
  if (typeof json === 'object' && json !== null) {
    const record = json as Record<string, unknown>;
    const candidate =
      (typeof record.text === 'string' && record.text) ||
      (typeof record.transcription === 'string' && record.transcription) ||
      (typeof record.result === 'string' && record.result) ||
      '';
    if (candidate) {
      return candidate.trim();
    }
  }
  return responseText.trim();
}

export async function transcribeVoiceNote(base64: string, options: TranscribeOptions = {}): Promise<string> {
  const mimeType = options.mimeType?.trim() || 'application/octet-stream';
  const extension = mimeTypeToExtension(mimeType);
  const tempPath = path.join(os.tmpdir(), `voice-${randomUUID()}.${extension}`);

  await fs.writeFile(tempPath, Buffer.from(base64, 'base64'));

  try {
    const fileBuffer = await fs.readFile(tempPath);
    const form = new FormData();
    const blob = new Blob([fileBuffer], { type: mimeType });
    form.append('file', blob, `voice.${extension}`);

    const taskParam = options.task === 'translate' ? '?task=translate' : '';
    const url = `${TRANSCRIBE_URL}/transcribe${taskParam}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    const response = await fetch(url, {
      method: 'POST',
      body: form,
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Transcribe ${response.status} ${response.statusText}: ${errorText}`);
    }

    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const json = (await response.json()) as unknown;
      return extractTranscription('', json);
    }

    const responseText = await response.text();
    return extractTranscription(responseText, null);
  } finally {
    await fs.unlink(tempPath).catch(() => undefined);
  }
}

export type TopicResult = {
  topic: string;
  contextRequired: boolean;
  question?: string;
};

export async function topicClassifier(text: string): Promise<TopicResult> {
  const trimmed = text.trim();
  if (!trimmed) {
    return { topic: 'unknown', contextRequired: false };
  }

  try {
    const classes = parsePromptClasses(PROMPT_CLASSES);
    const template = withNormalizedInstructions(await loadPromptTemplate('classification'));
    const baseInstructions = renderPromptInstructions(template, classes);
    const learnings = getRelevantLearnings(trimmed);
    const instructions = learnings.length > 0
      ? `Additional context:\n- ${learnings.join("\n- ")}\n\n${baseInstructions}`
      : baseInstructions;
    const promptPayload = {
      ...template,
      instructions,
      classes
    };
    const response = await chatCompletion({
      messages: [
        { role: 'system', content: JSON.stringify(promptPayload) },
        { role: 'user', content: trimmed }
      ],
      temperature: 0,
      max_tokens: 128,
      stream: false,
      format: 'json'
    });
    const raw = response.message.content.trim();
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed['context-required'] === true) {
      const question = typeof parsed.question === 'string' ? parsed.question : 'follow-up required';
      console.log(`[topic] context-required question="${question}"`);
      return { topic: 'unknown', contextRequired: true, question };
    }

    let label = typeof parsed.class === 'string' ? parsed.class.trim() : '';
    if (label === 'cron-add') {
      label = 'schedule';
    }
    if (!label || !classes.includes(label)) {
      return { topic: 'unknown', contextRequired: false };
    }

    return { topic: label, contextRequired: false };
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'unknown error';
    console.warn(`[topic-classifier] failed: ${msg}`);
    return { topic: 'unknown', contextRequired: false };
  }
}

export async function intentClassifier(
  text: string,
  messageClass: string,
  options?: { skipCache?: boolean },
): Promise<IntentResult> {
  const trimmed = text.trim();
  if (!trimmed) {
    return { intent: 'unknown', contextRequired: false };
  }

  try {
    if (!options?.skipCache) {
      const cached = getCachedIntent(trimmed, messageClass);
      if (cached) {
        return cached;
      }
    }
    const template = withNormalizedInstructions(await loadPromptTemplate('intent'));
    const baseInstructions = renderPromptForClass(template, messageClass);
    const learnings = getRelevantLearnings(trimmed);
    const dynamic = buildDynamicIntentInstructions(messageClass);
    const chunks: string[] = [];
    if (learnings.length > 0) {
      chunks.push(`Additional context:\n- ${learnings.join("\n- ")}`);
    }
    if (dynamic.length > 0) {
      chunks.push(`Dynamic intents:\n- ${dynamic.join("\n- ")}`);
    }
    chunks.push(baseInstructions);
    const instructions = chunks.join("\n\n");
    const promptPayload = {
      ...template,
      instructions,
      class: messageClass
    };
    const response = await chatCompletion({
      messages: [
        { role: 'system', content: JSON.stringify(promptPayload) },
        { role: 'user', content: trimmed }
      ],
      temperature: 0,
      max_tokens: 128,
      stream: false,
      format: 'json'
    });
    const raw = response.message.content.trim();
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const intent = typeof parsed.intent === 'string' ? parsed.intent.trim() : '';
    const verb = typeof parsed.verb === 'string' ? parsed.verb.trim() : '';
    if (!intent) {
      return { intent: 'unknown', contextRequired: false };
    }

    if (!options?.skipCache) {
      setCachedIntent(trimmed, messageClass, intent, verb || undefined);
    }
    return { intent, verb: verb || undefined, contextRequired: false };
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'unknown error';
    console.warn(`[intent-classifier] failed: ${msg}`);
    return { intent: 'unknown', contextRequired: false };
  }
}

export async function chatCompletion(req: ChatCompletionRequest): Promise<ChatCompletionResponse> {
  if (isCodexCliEnabled()) {
    try {
      return await codexChatCompletion(req);
    } catch (error) {
      if (isCodexCliMissing(error)) {
        console.warn("[codex] CLI not found; falling back to Ollama /api/chat");
        return post<ChatCompletionResponse>('/api/chat', resolveModel(req));
      }
      throw error;
    }
  }
  if (isOpenAIEnabled()) {
    return openaiChatCompletion(req);
  }
  return post<ChatCompletionResponse>('/api/chat', resolveModel(req));
}

export async function completions(req: CompletionRequest): Promise<CompletionResponse> {
  return post<CompletionResponse>('/api/generate', resolveModel(req));
}

export async function embeddings(req: EmbeddingRequest): Promise<EmbeddingResponse> {
  return post<EmbeddingResponse>('/api/embeddings', resolveModel(req));
}
