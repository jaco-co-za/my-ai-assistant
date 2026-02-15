import type { Message } from "./ollamaClient.js";
import { chatCompletion } from "./ollamaClient.js";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const CURRENT_DIR = path.resolve(".");
const PROMPTS_DIR = path.resolve("prompts");
const LEARNINGS_DB_PATH = path.resolve("data", "learnings.db");

const STOP_WORDS = new Set([
  "the",
  "is",
  "always",
  "be",
  "are",
  "a",
  "an",
  "and",
  "or",
  "of",
  "to",
  "in",
  "on",
  "for",
  "with",
  "at",
  "by",
  "from",
  "as",
  "that",
  "this",
  "it",
  "its",
  "your",
  "my",
  "our",
  "their",
  "was",
  "were",
  "will",
  "would",
  "should",
  "could",
  "can",
  "may",
  "might",
  "do",
  "does",
  "did",
  "have",
  "has",
  "had",
  "about",
  "into",
  "over",
  "under",
  "up",
  "down",
  "out",
  "off",
  "if",
  "then",
  "so",
  "than",
  "too",
  "very",
]);

type PromptTemplate = {
  name: string;
  version: number;
  instructions: string[];
  output_schema: Record<string, unknown>;
};

type LearningsSqlResult = {
  action: "list" | "delete" | "none";
  sql: string;
};

type LearningExtract = {
  should_learn: boolean;
  learning?: string;
};

type LearningsRun = {
  rows: string[];
  deleted: number | null;
};

let learningsDb: Database.Database | null = null;
let cachedLearnings: string[] = [];

function loadPrompt(name: string): PromptTemplate {
  const promptPath = path.resolve(PROMPTS_DIR, `${name}.json`);
  const raw = fs.readFileSync(promptPath, "utf-8");
  return JSON.parse(raw) as PromptTemplate;
}

function renderPrompt(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key: string) => {
    return Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : "";
  });
}

function tokenizeText(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((token) => token.trim())
    .filter((token) => token.length > 0 && !STOP_WORDS.has(token));
}

function learningTokensMatchPrompt(learning: string, promptText: string): boolean {
  const tokens = tokenizeText(learning);
  if (tokens.length === 0) {
    return false;
  }
  return tokens.some((token) => promptText.includes(token));
}

function buildPromptMessage(template: PromptTemplate, vars: Record<string, string>, learnings: string[]): string {
  const base = template.instructions.join("\n");
  const rendered = renderPrompt(base, vars);
  if (!learnings || learnings.length === 0) {
    return rendered;
  }
  const promptText = `${vars.payload ?? ""}`.toLowerCase();
  const filteredLearnings = learnings.filter((learning) => learningTokensMatchPrompt(learning, promptText));
  if (filteredLearnings.length === 0) {
    return rendered;
  }
  const contextLines = ["Additional context:", ...filteredLearnings.map((learning) => `- ${learning}`)];
  return `${contextLines.join("\n")}\n\n${rendered}`;
}

function parseLearningsSql(raw: string): LearningsSqlResult | null {
  try {
    const parsed = JSON.parse(raw) as LearningsSqlResult;
    if (parsed.action !== "list" && parsed.action !== "delete" && parsed.action !== "none") {
      return null;
    }
    if (typeof parsed.sql !== "string") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function parseLearningExtract(raw: string): LearningExtract | null {
  try {
    const parsed = JSON.parse(raw) as LearningExtract;
    if (typeof parsed.should_learn !== "boolean") {
      return null;
    }
    if (parsed.learning && typeof parsed.learning !== "string") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

function ensureLearningsDb(): Database.Database {
  if (learningsDb) {
    return learningsDb;
  }
  learningsDb = new Database(LEARNINGS_DB_PATH);
  learningsDb.exec(
    "CREATE TABLE IF NOT EXISTS learnings (id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));",
  );
  return learningsDb;
}

export function refreshLearnings(): string[] {
  const db = ensureLearningsDb();
  const rows = db.prepare("SELECT content FROM learnings ORDER BY id ASC;").all() as Array<{ content: string }>;
  cachedLearnings = rows
    .map((row) => (row?.content ? String(row.content) : ""))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return cachedLearnings;
}

function appendLearning(content: string): void {
  const db = ensureLearningsDb();
  const trimmed = content.trim();
  if (trimmed.length === 0) {
    return;
  }
  db.prepare(`INSERT INTO learnings (content) VALUES ('${escapeSqlLiteral(trimmed)}');`).run();
  refreshLearnings();
}

function isSafeLearningsSql(sql: string): boolean {
  const normalized = sql.trim().toLowerCase();
  if (normalized.startsWith("select")) {
    return normalized.includes(" from learnings");
  }
  if (normalized.startsWith("delete")) {
    return normalized.includes(" from learnings");
  }
  return false;
}

function runLearningsSql(sql: string): LearningsRun {
  const db = ensureLearningsDb();
  if (!isSafeLearningsSql(sql)) {
    return { rows: [], deleted: null };
  }
  if (sql.trim().toLowerCase().startsWith("select")) {
    const rows = db.prepare(sql).all() as Array<{ id: number; content: string; created_at: string }>;
    const formatted = rows.map((row) => `#${row.id}: ${row.content} (${row.created_at})`);
    return { rows: formatted, deleted: null };
  }
  const result = db.prepare(sql).run();
  return { rows: [], deleted: result.changes };
}

function formatLearningsRows(rows: string[]): string {
  if (rows.length === 0) {
    return "No learnings found.";
  }
  return rows.join("\n");
}

function parseVerb(result?: string): string | null {
  if (!result) return null;
  const parts = Object.fromEntries(
    result.split("|").map((part) => {
      const [key, value] = part.split(":").map((segment) => segment.trim());
      return [key.toLowerCase(), value];
    }),
  );
  const verb = parts.verb;
  return typeof verb === "string" ? verb.toLowerCase() : null;
}

function parseIntent(result?: string): string | null {
  if (!result) return null;
  const parts = Object.fromEntries(
    result.split("|").map((part) => {
      const [key, value] = part.split(":").map((segment) => segment.trim());
      return [key.toLowerCase(), value];
    }),
  );
  const intent = parts.intent;
  return typeof intent === "string" ? intent.toLowerCase() : null;
}

function isLearningIntent(verb: string | null, intent: string | null, prompt: string): boolean {
  const verbValue = verb?.toLowerCase() ?? "";
  const intentValue = intent?.toLowerCase() ?? "";
  if (["teach", "learn", "define"].includes(verbValue)) {
    return true;
  }
  if (intentValue.includes("learn") || intentValue.includes("teach") || intentValue.includes("define")) {
    return true;
  }
  const text = prompt.toLowerCase();
  return text.includes("learn") || text.includes("remember") || text.includes("teach");
}

function shouldAttemptLearningsSql(prompt: string): boolean {
  const text = prompt.toLowerCase();
  // Prevent vague commands from being treated as learnings list/delete operations.
  return (
    /\blearning\b/.test(text) ||
    /\blearnings\b/.test(text) ||
    /\bremember\b/.test(text) ||
    /\blearn\b/.test(text) ||
    /\bteach\b/.test(text) ||
    /\bdefine\b/.test(text)
  );
}

async function sendToAssistant(system: string, user: string, model?: string): Promise<string | null> {
  const messages: Message[] = [
    { role: "system", content: system.trim() },
    { role: "user", content: user },
  ];
  const response = await chatCompletion({
    model: model ?? "qwen2.5:14b",
    messages,
    temperature: 0.2,
    stream: false,
    format: "json",
  });
  return response.message.content.trim();
}

export async function processLearnings(payload: { prompt: string; result?: string }): Promise<{ handled: boolean; message?: string; learnings: string[] }> {
  const prompt = payload.prompt;
  const result = payload.result;

  refreshLearnings();

  if (shouldAttemptLearningsSql(prompt)) {
    const learningsSqlPrompt = buildPromptMessage(loadPrompt("learnings_sql"), { payload: JSON.stringify(payload) }, cachedLearnings);
    const learningsRaw = await sendToAssistant("You are a helper. Respond ONLY in structured JSON.", learningsSqlPrompt, "qwen2.5-coder:14b");
    const learningsSql = learningsRaw ? parseLearningsSql(learningsRaw) : null;
    if (learningsSql && learningsSql.action !== "none") {
      const resultData = runLearningsSql(learningsSql.sql);
      if (learningsSql.action === "list") {
        return { handled: true, message: formatLearningsRows(resultData.rows), learnings: cachedLearnings };
      }
      if (learningsSql.action === "delete") {
        refreshLearnings();
        return { handled: true, message: "Learning removed.", learnings: cachedLearnings };
      }
    }
  }

  const verb = parseVerb(result);
  const intent = parseIntent(result);
  if (isLearningIntent(verb, intent, prompt)) {
    const learningPrompt = buildPromptMessage(loadPrompt("learnings_extract"), { payload: JSON.stringify(payload) }, cachedLearnings);
    const learningRaw = await sendToAssistant("You are a helper. Respond ONLY in structured JSON.", learningPrompt);
    const learningExtract = learningRaw ? parseLearningExtract(learningRaw) : null;
    if (learningExtract?.should_learn && learningExtract.learning) {
      appendLearning(learningExtract.learning);
      return { handled: true, message: "Got it. I've added that learning.", learnings: cachedLearnings };
    }
  }

  return { handled: false, learnings: cachedLearnings };
}

export function buildLearningsContext(promptText: string, learnings: string[]): string[] {
  if (!learnings || learnings.length === 0) {
    return [];
  }
  const text = promptText.toLowerCase();
  return learnings.filter((learning) => learningTokensMatchPrompt(learning, text));
}
