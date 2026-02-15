import {
  HomeAssistantMcpClient,
  JsonRpcRequest,
  JsonRpcResponse,
  McpTool,
} from "./mcpClient";
import * as fs from "fs";
import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";

let client: HomeAssistantMcpClient | null = null;
let initialized = false;
let cachedTools: JsonRpcResponse | null = null;
let toolsByDomain: Record<string, McpTool[]> | null = null;

export interface HaEntity {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  friendly_name?: string;
  area_name?: string;
  last_changed?: string;
  last_updated?: string;
  context?: Record<string, unknown>;
}

let entitiesByDomain: Record<string, HaEntity[]> | null = null;
let lastEntityKeywords: string[] = [];
const execFileAsync = promisify(execFile);

function getClient(): HomeAssistantMcpClient | null {
  const baseUrl = process.env.HOME_ASSISTANT_URL ?? "";
  const token = process.env.HOME_ASSISTANT_TOKEN ?? "";

  if (baseUrl.trim() === "" || token.trim() === "") {
    return null;
  }

  if (!client) {
    const trimmedBase = baseUrl.replace(/\/+$/, "");
    const endpoint = `${trimmedBase}/api/mcp`;
    client = new HomeAssistantMcpClient({
      endpoint,
      authToken: token,
    });
  }

  return client;
}

async function fetchHomeAssistantStates(): Promise<void> {
  const baseUrl = process.env.HOME_ASSISTANT_URL ?? "";
  const token = process.env.HOME_ASSISTANT_TOKEN ?? "";

  if (baseUrl.trim() === "" || token.trim() === "") {
    console.log("States fetch skipped: missing HOME_ASSISTANT_URL or HOME_ASSISTANT_TOKEN");
    return;
  }

  const trimmedBase = baseUrl.replace(/\/+$/, "");
  const endpoint = `${trimmedBase}/api/states`;

  console.log("HA states fetch ->", endpoint);
  const response = await fetch(endpoint, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
    },
  });

  console.log("HA states fetch <- status", response.status);
  if (!response.ok) {
    const raw = await response.text();
    console.log("HA states fetch <- error", raw);
    return;
  }

  const data = (await response.json()) as HaEntity[];
  const grouped: Record<string, HaEntity[]> = {};

  if (Array.isArray(data)) {
    for (const rawEntity of data) {
      if (!rawEntity || typeof rawEntity.entity_id !== "string") {
        continue;
      }

      const friendlyName =
        typeof rawEntity.attributes?.friendly_name === "string"
          ? rawEntity.attributes.friendly_name
          : undefined;

      const areaName =
        typeof rawEntity.attributes?.area_name === "string"
          ? rawEntity.attributes.area_name
          : undefined;

      const entity: HaEntity = {
        ...rawEntity,
        friendly_name: friendlyName,
        area_name: areaName,
      };

      const domain = entity.entity_id.split(".")[0] ?? "unknown";
      if (!grouped[domain]) {
        grouped[domain] = [];
      }
      grouped[domain].push(entity);
    }
  }

  entitiesByDomain = grouped;
  console.log("HA states cached by domain", Object.keys(grouped).length);
  logMatchedEntitiesForLastPrompt(grouped);
}

function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  if (!value || typeof value !== "object") {
    return false;
  }

  const record = value as Record<string, unknown>;
  return record.jsonrpc === "2.0" && typeof record.method === "string";
}

function isRequestPayload(value: unknown): value is { prompt: string; result: string } {
  if (!value || typeof value !== "object") {
    return false;
  }

  const record = value as Record<string, unknown>;
  return typeof record.prompt === "string" && typeof record.result === "string";
}

function parseVerb(result: string): string | null {
  const parts = Object.fromEntries(
    result.split("|").map((p) => {
      const [k, v] = p.split(":").map((s) => s.trim());
      return [k.toLowerCase(), v];
    })
  );

  const verb = parts["verb"];
  return typeof verb === "string" ? verb.toLowerCase() : null;
}

function parseIntent(result: string): string | null {
  const parts = Object.fromEntries(
    result.split("|").map((p) => {
      const [k, v] = p.split(":").map((s) => s.trim());
      return [k.toLowerCase(), v];
    })
  );

  const intent = parts["intent"];
  return typeof intent === "string" ? intent.toLowerCase() : null;
}


function isQueryRequest(verb: string | null, intent: string | null): boolean {
  const verbValue = verb?.toLowerCase() ?? "";
  const intentValue = intent?.toLowerCase() ?? "";

  if (["query", "check", "get"].includes(verbValue)) {
    return true;
  }

  if (
    ["check-status", "query", "temperature inquiry", "temperature"].includes(intentValue)
  ) {
    return true;
  }

  return false;
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

function shouldCheckLearningsSql(prompt: string): boolean {
  return prompt.toLowerCase().includes("learn");
}

function buildEntityKeywordPrompt(payload: { prompt: string; result: string }) {
  const template = loadPrompt("entity_keywords");
  return {
    system: "You are a Home Assistant helper. Respond ONLY in structured JSON.",
    user: buildPromptMessage(template, {
      payload: JSON.stringify(payload),
    }, getCachedLearnings()),
  };
}

function getToolsList(): McpTool[] {
  if (!cachedTools || !("result" in cachedTools)) {
    return [];
  }

  const result = cachedTools.result as { tools?: McpTool[] };
  if (!Array.isArray(result.tools)) {
    return [];
  }

  return result.tools;
}

function getEntitiesList(): HaEntity[] {
  if (!entitiesByDomain) {
    return [];
  }
  return Object.values(entitiesByDomain).flat();
}

function filterEntitiesByKeywords(keywords: string[], entities: HaEntity[]): HaEntity[] {
  const tokens = keywords
    .flatMap((k) => k.toLowerCase().split(/\s+/))
    .filter((t) => t.length > 0);
  if (tokens.length === 0) {
    return [];
  }

  return entities.filter((e) => {
    const haystack = `${e.entity_id}`.toLowerCase();
    return tokens.some((t) => haystack.includes(t));
  });
}

function detectForcedDomain(prompt: string): string | null {
  const text = prompt.toLowerCase();
  const rules: Array<{ domain: string; keywords: string[] }> = [
    { domain: "light", keywords: ["light", "lights", "lamp", "lamps"] },
    { domain: "switch", keywords: ["switch", "outlet", "plug"] },
    { domain: "fan", keywords: ["fan"] },
    { domain: "climate", keywords: ["climate", "thermostat", "temperature", "temp", "heat", "cool"] },
    { domain: "lock", keywords: ["lock", "unlock"] },
    { domain: "cover", keywords: ["cover", "blind", "blinds", "curtain", "shutter"] },
  ];

  for (const rule of rules) {
    if (rule.keywords.some((k) => text.includes(k))) {
      return rule.domain;
    }
  }

  return null;
}

function isWaterUsageReadIntent(prompt: string): boolean {
  const text = prompt.toLowerCase();
  const hasWater = text.includes("water");
  if (!hasWater) {
    return false;
  }
  const hasUsage = ["use", "usage", "consumption", "current", "now", "status"].some((k) =>
    text.includes(k)
  );
  const hasReadVerb = ["what", "how much", "show", "check", "get"].some((k) => text.includes(k));
  return hasUsage || hasReadVerb;
}

function findToolByName(tools: McpTool[], targetName: string): McpTool | null {
  const target = targetName.toLowerCase();
  for (const tool of tools) {
    if (tool.name.toLowerCase() === target) {
      return tool;
    }
  }
  for (const tool of tools) {
    if (tool.name.toLowerCase().endsWith(`.${target}`)) {
      return tool;
    }
  }
  return null;
}

function canonicalToolName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function resolveRequestedTool(tools: McpTool[], requestedName: string): McpTool | null {
  const requested = requestedName.trim();
  if (requested === "") {
    return null;
  }

  const requestedLower = requested.toLowerCase();
  const requestedCanonical = canonicalToolName(requested);

  for (const tool of tools) {
    if (tool.name.toLowerCase() === requestedLower) {
      return tool;
    }
  }
  for (const tool of tools) {
    if (tool.name.toLowerCase().endsWith(`.${requestedLower}`)) {
      return tool;
    }
  }
  for (const tool of tools) {
    if (canonicalToolName(tool.name) === requestedCanonical) {
      return tool;
    }
  }

  return null;
}

function resolveRequestedTools(tools: McpTool[], requestedNames: string[]): McpTool[] {
  if (requestedNames.length === 0) {
    return tools;
  }

  const resolved: McpTool[] = [];
  const seen = new Set<string>();
  for (const name of requestedNames) {
    const tool = resolveRequestedTool(tools, name);
    if (!tool || seen.has(tool.name)) {
      continue;
    }
    seen.add(tool.name);
    resolved.push(tool);
  }

  return resolved;
}

function selectWaterUsageEntity(
  entities: HaEntity[],
  prompt: string
): HaEntity | null {
  const sensors = entities.filter((e) => e.entity_id.toLowerCase().startsWith("sensor."));
  if (sensors.length === 0) {
    return null;
  }

  const text = prompt.toLowerCase();
  const scoreEntity = (entity: HaEntity): number => {
    const id = entity.entity_id.toLowerCase();
    const name = (entity.friendly_name ?? "").toLowerCase();
    let score = 0;

    if (id === "sensor.water_use") {
      score += 100;
    }
    if (id.includes("water_use") || id.includes("waterusage") || id.includes("water_usage")) {
      score += 90;
    }
    if (name.includes("water use") || name.includes("water usage")) {
      score += 80;
    }
    if (id.includes("water") || name.includes("water")) {
      score += 50;
    }
    if (id.includes("consumption") || name.includes("consumption")) {
      score += 30;
    }
    if (id.includes("usage") || name.includes("usage") || id.includes("use") || name.includes("use")) {
      score += 20;
    }
    if (text.includes("pool") && (id.includes("pool") || name.includes("pool"))) {
      score += 20;
    }

    return score;
  };

  let best: HaEntity | null = null;
  let bestScore = -1;
  for (const sensor of sensors) {
    const score = scoreEntity(sensor);
    if (score > bestScore) {
      best = sensor;
      bestScore = score;
    }
  }

  return bestScore > 0 ? best : null;
}

function toStateString(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return null;
}

function maybeParseJson(value: string): unknown | null {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return null;
    }
  }
  return null;
}

function extractStateFromToolData(
  data: unknown,
  preferredEntityId?: string
): { entity_id?: string; state: string } | null {
  const candidates: Array<{ entity_id?: string; state: string }> = [];

  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) {
        walk(item);
      }
      return;
    }

    if (typeof value === "string") {
      const parsed = maybeParseJson(value);
      if (parsed) {
        walk(parsed);
      }
      return;
    }

    if (!value || typeof value !== "object") {
      return;
    }

    const record = value as Record<string, unknown>;
    const state = toStateString(record.state);
    if (state !== null) {
      const entityId = typeof record.entity_id === "string" ? record.entity_id : undefined;
      candidates.push({ entity_id: entityId, state });
    }

    for (const nested of Object.values(record)) {
      walk(nested);
    }
  };

  walk(data);

  if (candidates.length === 0) {
    return null;
  }

  if (preferredEntityId) {
    const preferred = candidates.find(
      (c) =>
        typeof c.entity_id === "string" &&
        c.entity_id.toLowerCase() === preferredEntityId.toLowerCase()
    );
    if (preferred) {
      return preferred;
    }
  }

  const withEntity = candidates.find((c) => typeof c.entity_id === "string");
  return withEntity ?? candidates[0];
}

function buildSensorValueMessage(
  entities: HaEntity[],
  state: { entity_id?: string; state: string },
  fallbackEntityName?: string
): string {
  if (state.entity_id) {
    const match = entities.find(
      (e) => e.entity_id.toLowerCase() === state.entity_id!.toLowerCase()
    );
    if (match?.friendly_name && match.friendly_name.trim() !== "") {
      return `${match.friendly_name} is ${state.state}.`;
    }
    return `${state.entity_id} is ${state.state}.`;
  }

  if (fallbackEntityName && fallbackEntityName.trim() !== "") {
    return `${fallbackEntityName} is ${state.state}.`;
  }

  return `Current value is ${state.state}.`;
}

function buildToolSelectionPrompt(payload: { prompt: string; result: string }, tools: McpTool[]) {
  const toolsSummary = tools.map((t) => ({
    name: t.name,
    description: t.description ?? "",
    inputSchema: t.inputSchema ?? {},
  }));

  const template = loadPrompt("tool_selection");
  return {
    system: "You are a Home Assistant helper. Respond ONLY in structured JSON.",
    user: buildPromptMessage(template, {
      toolsSummary: JSON.stringify(toolsSummary),
      payload: JSON.stringify(payload),
    }, getCachedLearnings()),
  };
}

function buildMcpCallPrompt(
  payload: { prompt: string; result: string },
  tools: McpTool[],
  entities: HaEntity[],
  filteredCount: number,
  forcedDomain: string | null
) {
  const toolsSummary = tools.map((t) => ({
    name: t.name,
    description: t.description ?? "",
    inputSchema: t.inputSchema ?? {},
  }));
  const entitiesSummary = entities.map((e) => ({
    entity_id: e.entity_id,
    name: e.friendly_name ?? "",
    area: e.area_name ?? "",
    state: e.state,
  }));

  const domainByName: Record<string, string> = {};
  for (const e of entities) {
    if (e.friendly_name) {
      domainByName[e.friendly_name.toLowerCase()] = e.entity_id.split(".")[0] ?? "";
    }
  }

  const template = loadPrompt("mcp_call");
  return {
    system: "You are a Home Assistant helper. Respond ONLY in structured JSON.",
    user: buildPromptMessage(template, {
      toolsSummary: JSON.stringify(toolsSummary),
      entitiesSummary: JSON.stringify(entitiesSummary),
      filteredCount: String(filteredCount),
      payload: JSON.stringify(payload),
      domainByName: JSON.stringify(domainByName),
      toolsList: toolsSummary.map((t) => t.name).join(", "),
      forcedDomainLine: forcedDomain ? ` Prefer domain ${forcedDomain} when it matches the selected entity.` : "",
    }, getCachedLearnings()),
  };
}

function buildQueryEntityPrompt(
  payload: { prompt: string; result: string },
  entities: HaEntity[],
  filteredCount: number
) {
  const entitiesSummary = entities.map((e) => ({
    entity_id: e.entity_id,
    name: e.friendly_name ?? "",
    area: e.area_name ?? "",
    state: e.state,
  }));

  const template = loadPrompt("query_entity");
  return {
    system: "You are a Home Assistant helper. Respond ONLY in structured JSON.",
    user: buildPromptMessage(template, {
      payload: JSON.stringify(payload),
      filteredCount: String(filteredCount),
      entitiesSummary: JSON.stringify(entitiesSummary),
    }, getCachedLearnings()),
  };
}


function buildStatusSummaryPrompt(
  payload: { prompt: string; result: string },
  statusMap: Record<string, string>
) {
  const template = loadPrompt("status_summary");
  return {
    system: "You are a Home Assistant helper. Respond ONLY in structured JSON.",
    user: buildPromptMessage(template, {
      payload: JSON.stringify(payload),
      statusMap: JSON.stringify(statusMap),
    }, getCachedLearnings()),
  };
}

function buildOutcomePrompt(payload: { prompt: string; result: string }, actionResult: McpActionResult) {
  const template = loadPrompt("outcome");
  return {
    system: "You are a Home Assistant helper. Respond ONLY in structured JSON.",
    user: buildPromptMessage(template, {
      payload: JSON.stringify(payload),
      actionResult: JSON.stringify(actionResult),
    }, getCachedLearnings()),
  };
}

function parseSelectedTools(raw: string): string[] {
  try {
    const outer = JSON.parse(raw) as { msg?: string; message?: { content?: string } };
    if (typeof outer.msg === "string") {
      const inner = JSON.parse(outer.msg) as { message?: { content?: string } };
      const content = inner.message?.content;
      if (typeof content === "string") {
        const parsed = JSON.parse(content) as { tools?: string[] };
        return Array.isArray(parsed.tools) ? parsed.tools : [];
      }
    }
    if (outer.message?.content && typeof outer.message.content === "string") {
      const parsed = JSON.parse(outer.message.content) as { tools?: string[] };
      return Array.isArray(parsed.tools) ? parsed.tools : [];
    }
  } catch {
    return [];
  }
  return [];
}

function parseKeywords(raw: string): string[] {
  try {
    const outer = JSON.parse(raw) as { msg?: string; message?: { content?: string } };
    let content: string | undefined;
    if (typeof outer.msg === "string") {
      const inner = JSON.parse(outer.msg) as { message?: { content?: string } };
      content = inner.message?.content;
    } else if (outer.message?.content && typeof outer.message.content === "string") {
      content = outer.message.content;
    }

    if (!content) {
      return [];
    }

    const parsed = JSON.parse(content) as { keywords?: string[] };
    return Array.isArray(parsed.keywords) ? parsed.keywords.filter((k) => typeof k === "string") : [];
  } catch {
    return [];
  }
}

function parseSelectedEntityIds(raw: string): string[] {
  try {
    const outer = JSON.parse(raw) as { msg?: string; message?: { content?: string } };
    let content: string | undefined;
    if (typeof outer.msg === "string") {
      const inner = JSON.parse(outer.msg) as { message?: { content?: string } };
      content = inner.message?.content;
    } else if (outer.message?.content && typeof outer.message.content === "string") {
      content = outer.message.content;
    }

    if (!content) {
      return [];
    }

    const parsed = JSON.parse(content) as { entity_ids?: string[]; entity_id?: string };
    if (Array.isArray(parsed.entity_ids)) {
      return parsed.entity_ids.filter((id) => typeof id === "string");
    }
    if (typeof parsed.entity_id === "string") {
      return [parsed.entity_id];
    }
    return [];
  } catch {
    return [];
  }
}

function parseMcpCall(raw: string): { tool?: string; arguments?: Record<string, unknown> } | null {
  try {
    const outer = JSON.parse(raw) as { msg?: string; message?: { content?: string } };
    let content: string | undefined;
    if (typeof outer.msg === "string") {
      const inner = JSON.parse(outer.msg) as { message?: { content?: string } };
      content = inner.message?.content;
    } else if (outer.message?.content && typeof outer.message.content === "string") {
      content = outer.message.content;
    }

    if (!content) {
      return null;
    }

    const parsed = JSON.parse(content) as { tool?: string; arguments?: Record<string, unknown> };
    return parsed;
  } catch {
    return null;
  }
}

function parseMessage(raw: string): string | null {
  try {
    const outer = JSON.parse(raw) as { msg?: string; message?: { content?: string } };
    let content: string | undefined;
    if (typeof outer.msg === "string") {
      const inner = JSON.parse(outer.msg) as { message?: { content?: string } };
      content = inner.message?.content;
    } else if (outer.message?.content && typeof outer.message.content === "string") {
      content = outer.message.content;
    }

    if (!content) {
      return null;
    }

    const parsed = JSON.parse(content) as { message?: string };
    if (typeof parsed.message !== "string") {
      return null;
    }
    const firstSentence = parsed.message.split(/(?<=\.)\s+/)[0] ?? parsed.message;
    return firstSentence.trim();
  } catch {
    return null;
  }
}

interface McpActionResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}

interface AssistantResult {
  kind: "action";
  toolSelectionRaw: string;
  entitySelectionRaw: string | null;
  actionResult?: McpActionResult | null;
  finalMessage?: string | null;
}

interface QueryResult {
  kind: "query";
  entities: Array<{ entity_id: string; state: string }>;
}

interface MessageResult {
  kind: "message";
  message: string;
}

type EntryResult = AssistantResult | QueryResult | MessageResult;

interface LearningExtract {
  should_learn: boolean;
  learning?: string;
}

interface LearningsSqlResult {
  action: "list" | "delete" | "none";
  sql: string;
}

export async function summarizeStatusToMessage(
  payload: { prompt: string; result: string },
  statusMap: Record<string, string>
): Promise<string | null> {
  const prompt = buildStatusSummaryPrompt(payload, statusMap);
  const raw = await sendToAssistant(prompt);
  return raw ? parseMessage(raw) : null;
}

async function ensureLearningsDb(): Promise<string | null> {
  const dbPath = path.resolve(__dirname, "..", "data", "learnings.db");
  try {
    await execFileAsync("sqlite3", [
      dbPath,
      "CREATE TABLE IF NOT EXISTS learnings (id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));",
    ]);
    return dbPath;
  } catch (err) {
    console.log("Learnings DB init failed", err);
    return null;
  }
}

async function ensureCacheDb(): Promise<string | null> {
  const dbPath = path.resolve(__dirname, "..", "data", "cache.db");
  try {
    await execFileAsync("sqlite3", [
      dbPath,
      "CREATE TABLE IF NOT EXISTS action_cache (cache_key TEXT PRIMARY KEY, kind TEXT NOT NULL, tool TEXT, arguments_json TEXT, entity_ids_json TEXT, response_message TEXT, updated_at TEXT NOT NULL DEFAULT (datetime('now')));",
    ]);
    await execFileAsync("sqlite3", [
      dbPath,
      "ALTER TABLE action_cache ADD COLUMN response_message TEXT;",
    ]).catch(() => undefined);
    return dbPath;
  } catch (err) {
    console.log("Cache DB init failed", err);
    return null;
  }
}

let cachedLearnings: string[] = [];

function getCachedLearnings(): string[] {
  return cachedLearnings;
}

async function refreshLearnings(): Promise<string[]> {
  const dbPath = await ensureLearningsDb();
  if (!dbPath) {
    cachedLearnings = [];
    return cachedLearnings;
  }
  try {
    const result = await execFileAsync("sqlite3", [dbPath, "SELECT content FROM learnings ORDER BY id ASC;"]);
    const lines = result.stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    cachedLearnings = lines;
    return cachedLearnings;
  } catch (err) {
    console.log("Learnings DB read failed", err);
    cachedLearnings = [];
    return cachedLearnings;
  }
}

function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

function isCacheEnabled(): boolean {
  return String(process.env.CACHE_ACTION_ENTITIES || "").toLowerCase() === "true";
}

function isResponseCacheEnabled(): boolean {
  return String(process.env.CACHE_RESPOND_PARSING || "").toLowerCase() === "true";
}

function normalizeCacheKey(prompt: string): string {
  const trimmed = prompt.trim();
  const stripped = trimmed.replace(/^vn-transcribed:\s*/i, "");
  return stripped.trim().toLowerCase();
}

function buildResponseCacheKey(kind: CacheResponseKind, prompt: string): string {
  return `${kind}|${normalizeCacheKey(prompt)}`;
}

async function appendLearning(content: string): Promise<void> {
  const dbPath = await ensureLearningsDb();
  if (!dbPath) {
    return;
  }
  const trimmed = content.trim();
  if (trimmed.length === 0) {
    return;
  }
  try {
    await execFileAsync("sqlite3", [
      dbPath,
      `INSERT INTO learnings (content) VALUES ('${escapeSqlLiteral(trimmed)}');`,
    ]);
    await refreshLearnings();
  } catch (err) {
    console.log("Learnings DB insert failed", err);
  }
}

async function getCachedAction(cacheKey: string): Promise<{
  tool: string;
  arguments: Record<string, unknown>;
  responseMessage: string | null;
} | null> {
  console.log("[cache] read action", cacheKey);
  const dbPath = await ensureCacheDb();
  if (!dbPath) {
    console.log("[cache] read action skipped: no db", cacheKey);
    return null;
  }
  const sql = `SELECT tool, arguments_json, response_message FROM action_cache WHERE cache_key='${escapeSqlLiteral(
    cacheKey
  )}' AND kind='action' LIMIT 1;`;
  try {
    const result = await execFileAsync("sqlite3", ["-separator", "\t", dbPath, sql]);
    const line = result.stdout.trim();
    if (!line) {
      console.log("[cache] miss action", cacheKey);
      return null;
    }
    const [tool, argumentsJson, responseMessage] = line.split("\t");
    if (!tool || !argumentsJson) {
      console.log("[cache] miss action (invalid row)", cacheKey);
      return null;
    }
    const parsed = JSON.parse(argumentsJson) as Record<string, unknown>;
    console.log("[cache] hit action", cacheKey);
    return { tool, arguments: parsed, responseMessage: responseMessage || null };
  } catch (err) {
    console.log("Cache read failed", err);
    return null;
  }
}

async function getCachedQuery(cacheKey: string): Promise<{ entityIds: string[] } | null> {
  console.log("[cache] read query", cacheKey);
  const dbPath = await ensureCacheDb();
  if (!dbPath) {
    console.log("[cache] read query skipped: no db", cacheKey);
    return null;
  }
  const sql = `SELECT entity_ids_json, response_message FROM action_cache WHERE cache_key='${escapeSqlLiteral(
    cacheKey
  )}' AND kind='query' LIMIT 1;`;
  try {
    const result = await execFileAsync("sqlite3", ["-separator", "\t", dbPath, sql]);
    const line = result.stdout.trim();
    if (!line) {
      console.log("[cache] miss query", cacheKey);
      return null;
    }
    const [entityIdsJson] = line.split("\t");
    const parsed = JSON.parse(entityIdsJson) as unknown;
    const entityIds = Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string") : [];
    if (entityIds.length === 0) {
      console.log("[cache] miss query (empty)", cacheKey);
      return null;
    }
    console.log("[cache] hit query", cacheKey);
    return { entityIds };
  } catch (err) {
    console.log("Cache read failed", err);
    return null;
  }
}


async function saveCachedAction(
  cacheKey: string,
  tool: string,
  args: Record<string, unknown>,
  responseMessage?: string | null
): Promise<void> {
  console.log("[cache] write action", cacheKey);
  const dbPath = await ensureCacheDb();
  if (!dbPath) {
    console.log("[cache] write action skipped: no db", cacheKey);
    return;
  }
  const sql = `INSERT OR REPLACE INTO action_cache (cache_key, kind, tool, arguments_json, entity_ids_json, updated_at) VALUES ('${escapeSqlLiteral(
    cacheKey
  )}', 'action', '${escapeSqlLiteral(tool)}', '${escapeSqlLiteral(
    JSON.stringify(args)
  )}', '', datetime('now'));`;
  try {
    await execFileAsync("sqlite3", [dbPath, sql]);
    if (responseMessage) {
      await saveCachedResponse(cacheKey, "action", responseMessage);
    }
  } catch (err) {
    console.log("Cache save failed", err);
  }
}

async function saveCachedQuery(cacheKey: string, entityIds: string[]): Promise<void> {
  console.log("[cache] write query", cacheKey);
  const dbPath = await ensureCacheDb();
  if (!dbPath) {
    console.log("[cache] write query skipped: no db", cacheKey);
    return;
  }
  const sql = `INSERT OR REPLACE INTO action_cache (cache_key, kind, tool, arguments_json, entity_ids_json, updated_at) VALUES ('${escapeSqlLiteral(
    cacheKey
  )}', 'query', '', '', '${escapeSqlLiteral(
    JSON.stringify(entityIds)
  )}', datetime('now'));`;
  try {
    await execFileAsync("sqlite3", [dbPath, sql]);
  } catch (err) {
    console.log("Cache save failed", err);
  }
}


async function deleteCache(cacheKey: string): Promise<void> {
  console.log("[cache] delete", cacheKey);
  const dbPath = await ensureCacheDb();
  if (!dbPath) {
    console.log("[cache] delete skipped: no db", cacheKey);
    return;
  }
  const sql = `DELETE FROM action_cache WHERE cache_key='${escapeSqlLiteral(cacheKey)}';`;
  try {
    await execFileAsync("sqlite3", [dbPath, sql]);
  } catch (err) {
    console.log("Cache delete failed", err);
  }
}

type CacheResponseKind =
  | "action"
  | "query"
  | "learnings_sql"
  | "learnings_extract"
  | "query_entity";

async function saveCachedResponse(cacheKey: string, kind: CacheResponseKind, message: string): Promise<void> {
  console.log("[cache] write response", kind, cacheKey);
  const dbPath = await ensureCacheDb();
  if (!dbPath) {
    console.log("[cache] write response skipped: no db", kind, cacheKey);
    return;
  }
  try {
    const insertSql = `INSERT OR IGNORE INTO action_cache (cache_key, kind, response_message, updated_at) VALUES ('${escapeSqlLiteral(
      cacheKey
    )}', '${kind}', '${escapeSqlLiteral(message)}', datetime('now'));`;
    const updateSql = `UPDATE action_cache SET response_message='${escapeSqlLiteral(
      message
    )}', updated_at=datetime('now') WHERE cache_key='${escapeSqlLiteral(cacheKey)}' AND kind='${kind}';`;
    await execFileAsync("sqlite3", [dbPath, insertSql]);
    await execFileAsync("sqlite3", [dbPath, updateSql]);
  } catch (err) {
    console.log("Cache response save failed", err);
  }
}

async function getCachedResponse(cacheKey: string, kind: CacheResponseKind): Promise<string | null> {
  console.log("[cache] read response", kind, cacheKey);
  const dbPath = await ensureCacheDb();
  if (!dbPath) {
    console.log("[cache] read response skipped: no db", kind, cacheKey);
    return null;
  }
  const sql = `SELECT response_message FROM action_cache WHERE cache_key='${escapeSqlLiteral(
    cacheKey
  )}' AND kind='${kind}' LIMIT 1;`;
  try {
    const result = await execFileAsync("sqlite3", ["-separator", "\t", dbPath, sql]);
    const message = result.stdout.trim();
    console.log(message.length > 0 ? "[cache] hit response" : "[cache] miss response", kind, cacheKey);
    return message.length > 0 ? message : null;
  } catch (err) {
    console.log("Cache read failed", err);
    return null;
  }
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

async function runLearningsSql(sql: string): Promise<{ rows: string[]; deleted: number | null }> {
  const dbPath = await ensureLearningsDb();
  if (!dbPath) {
    return { rows: [], deleted: null };
  }
  if (!isSafeLearningsSql(sql)) {
    return { rows: [], deleted: null };
  }
  if (sql.trim().toLowerCase().startsWith("select")) {
    const result = await execFileAsync("sqlite3", [dbPath, sql]);
    const rows = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    return { rows, deleted: null };
  }
  await execFileAsync("sqlite3", [dbPath, sql]);
  return { rows: [], deleted: 0 };
}

function formatLearningsRows(rows: string[]): string {
  if (rows.length === 0) {
    return "No learnings found.";
  }
  const formatted = rows.map((row) => {
    const parts = row.split("|");
    if (parts.length >= 3) {
      const [id, content, createdAt] = parts;
      return `#${id}: ${content} (${createdAt})`;
    }
    return row;
  });
  return formatted.join("\n");
}

function buildLearningExtractPrompt(payload: { prompt: string; result: string }) {
  const template = loadPrompt("learnings_extract");
  return {
    system: "You are a Home Assistant helper. Respond ONLY in structured JSON.",
    user: buildPromptMessage(template, {
      payload: JSON.stringify(payload),
    }, getCachedLearnings()),
  };
}

function buildLearningsSqlPrompt(payload: { prompt: string; result: string }) {
  const template = loadPrompt("learnings_sql");
  return {
    system: "You are a Home Assistant helper. Respond ONLY in structured JSON.",
    user: buildPromptMessage(template, {
      payload: JSON.stringify(payload),
    }, getCachedLearnings()),
  };
}

function parseLearningExtract(raw: string): LearningExtract | null {
  try {
    const outer = JSON.parse(raw) as { msg?: string; message?: { content?: string } };
    let content: string | undefined;
    if (typeof outer.msg === "string") {
      const inner = JSON.parse(outer.msg) as { message?: { content?: string } };
      content = inner.message?.content;
    } else if (outer.message?.content && typeof outer.message.content === "string") {
      content = outer.message.content;
    }

    if (!content) {
      return null;
    }

    const parsed = JSON.parse(content) as LearningExtract;
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

function parseLearningsSql(raw: string): LearningsSqlResult | null {
  try {
    const outer = JSON.parse(raw) as { msg?: string; message?: { content?: string } };
    let content: string | undefined;
    if (typeof outer.msg === "string") {
      const inner = JSON.parse(outer.msg) as { message?: { content?: string } };
      content = inner.message?.content;
    } else if (outer.message?.content && typeof outer.message.content === "string") {
      content = outer.message.content;
    }

    if (!content) {
      return null;
    }

    const parsed = JSON.parse(content) as LearningsSqlResult;
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

async function sendToAssistant(
  input:
    | ReturnType<typeof buildToolSelectionPrompt>
    | ReturnType<typeof buildMcpCallPrompt>
    | ReturnType<typeof buildQueryEntityPrompt>
    | ReturnType<typeof buildOutcomePrompt>
    | ReturnType<typeof buildEntityKeywordPrompt>
    | ReturnType<typeof buildStatusSummaryPrompt>
    | ReturnType<typeof buildLearningExtractPrompt>
    | ReturnType<typeof buildLearningsSqlPrompt>,
  options?: { model?: string }
): Promise<string | null> {
  const rawUrl = process.env.ASSISTANT_URL ?? "";
  const authEnv = (process.env.ASSISTANT_AUTH ?? "").trim();
  const rawToken = authEnv.replace(/^Bearer\s+/i, "").trim();
  const bearerToken = rawToken === "" ? "" : `Bearer ${rawToken}`;

  if (rawUrl.trim() === "") {
    console.log("Assistant call skipped: missing ASSISTANT_URL");
    return null;
  }

  const url = rawUrl.match(/^https?:\/\//i) ? rawUrl : `http://${rawUrl}`;

  const messagePayload: Record<string, unknown> = {
    // custom-prompt expects the raw token in payload, without the "Bearer " prefix.
    Authorization: rawToken,
    model: options?.model ?? process.env.ASSISTANT_MODEL ?? "qwen2.5:14b",
    messages: [
      { role: "system", content: input.system.trim() },
      { role: "user", content: input.user },
    ],
    temperature: 0.2,
    stream: false,
    format: "json",
  };

  const body = {
    from: "custom-prompt",
    message: JSON.stringify(messagePayload),
  };

  const safePayload = {
    model: messagePayload.model,
    messages: messagePayload.messages,
    temperature: messagePayload.temperature,
    stream: messagePayload.stream,
    format: messagePayload.format,
  };
  console.log("[llm] request ->", url, JSON.stringify(safePayload));
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(bearerToken === "" ? {} : { Authorization: bearerToken }),
    },
    body: JSON.stringify(body),
  });

  console.log("[llm] response <- status", response.status);
  if (!response.ok) {
    console.log("[llm] call failed", response.status);
  }
  const raw = await response.text();
  console.log("[llm] response <-", raw);
  return raw;
}

export async function entryPoint(payload: unknown): Promise<EntryResult | null> {
  const mcpClient = getClient();
  if (!mcpClient) {
    console.log("entryPoint skipped: MCP client not configured");
    return null;
  }

  if (!initialized) {
    await initializeHomeAssistant();
  }

  if (isRequestPayload(payload)) {
    const requestPayload = payload;
    console.log("[request] payload", JSON.stringify(requestPayload));
    await fetchHomeAssistantStates();
    const verb = parseVerb(requestPayload.result);
    const intent = parseIntent(requestPayload.result);
    console.log("[request] parsed", JSON.stringify({ verb, intent }));
    const entities = getEntitiesList();
    const cacheEnabled = isCacheEnabled();
    const responseCacheEnabled = isResponseCacheEnabled();
    const cacheKey = normalizeCacheKey(requestPayload.prompt);
    const forceWaterUsageRead = isWaterUsageReadIntent(requestPayload.prompt);
    console.log("[request] cache", JSON.stringify({ cacheEnabled, responseCacheEnabled, cacheKey }));
    const executeActionFromCall = async (
      tool: string,
      args: Record<string, unknown>,
      toolSelectionRaw: string,
      entitySelectionRaw: string | null,
      cachedResponse?: string | null
    ): Promise<AssistantResult> => {
      const cleanedArgs = alignDomainWithEntity(sanitizeArguments(args), entities);
      console.log("[mcp] call payload", JSON.stringify({ tool, arguments: cleanedArgs }));
      console.log("[mcp] tools/call ->", tool, JSON.stringify(cleanedArgs));
      const actionResponse = await mcpClient.callTool(tool, cleanedArgs);
      const actionResult: McpActionResult = mapMcpResponse(actionResponse);
      console.log("[mcp] tools/call <-", tool, JSON.stringify(actionResult));
      let finalMessage: string | null = null;
      const preferredEntityId =
        typeof cleanedArgs.entity_id === "string" ? cleanedArgs.entity_id : undefined;
      const sensorState = extractStateFromToolData(actionResult.data, preferredEntityId);
      const toolNameLower = tool.toLowerCase();
      const isReadStateTool = toolNameLower === "hassgetstate" || toolNameLower.endsWith(".hassgetstate");
      const fallbackEntityName =
        typeof cleanedArgs.name === "string" ? cleanedArgs.name : undefined;

      if (isActionSuccessful(actionResult) && sensorState && (forceWaterUsageRead || isReadStateTool)) {
        finalMessage = buildSensorValueMessage(entities, sensorState, fallbackEntityName);
      } else if (cachedResponse && responseCacheEnabled && isActionSuccessful(actionResult)) {
        finalMessage = cachedResponse;
      } else {
        const outcomePrompt = buildOutcomePrompt(requestPayload, actionResult);
        const outcomeRaw = await sendToAssistant(outcomePrompt);
        finalMessage = outcomeRaw ? parseMessage(outcomeRaw) : null;
        if (isActionSuccessful(actionResult) && finalMessage && responseCacheEnabled) {
          await saveCachedResponse(cacheKey, "action", finalMessage);
        }
      }
      return { kind: "action", toolSelectionRaw, entitySelectionRaw, actionResult, finalMessage };
    };

    if (forceWaterUsageRead) {
      const waterEntity = selectWaterUsageEntity(entities, requestPayload.prompt);
      if (waterEntity) {
        console.log("[request] water usage read intent -> direct query", waterEntity.entity_id);
        if (cacheEnabled) {
          await deleteCache(cacheKey);
          await saveCachedQuery(cacheKey, [waterEntity.entity_id]);
        }
        return { kind: "query", entities: [{ entity_id: waterEntity.entity_id, state: waterEntity.state }] };
      }
    }

    if (cacheEnabled && isQueryRequest(verb, intent)) {
      const cachedQuery = await getCachedQuery(cacheKey);
      if (cachedQuery && cachedQuery.entityIds.length > 0) {
        const cachedResults = cachedQuery.entityIds
          .map((id) => entities.find((e) => e.entity_id === id))
          .filter((e): e is HaEntity => !!e)
          .map((e) => ({ entity_id: e.entity_id, state: e.state }));
        console.log("[cache] query cached entity_ids", JSON.stringify(cachedQuery.entityIds));
        console.log("[cache] query resolved results", JSON.stringify(cachedResults));
        if (cachedResults.length > 0) {
          console.log("Cache hit (query)", cacheKey);
          return { kind: "query", entities: cachedResults };
        }
        console.log("Cache miss (query)", cacheKey);
        await deleteCache(cacheKey);
      } else {
        console.log("Cache miss (query)", cacheKey);
      }
    }

    if (
      cacheEnabled &&
      !forceWaterUsageRead &&
      !isQueryRequest(verb, intent) &&
      !isLearningIntent(verb, intent, requestPayload.prompt)
    ) {
      const cached = await getCachedAction(cacheKey);
      if (cached) {
        console.log("Cache hit (action)", cacheKey);
        const cachedResult = await executeActionFromCall(
          cached.tool,
          cached.arguments,
          "cache",
          "cache",
          cached.responseMessage
        );
        if (isActionSuccessful(cachedResult.actionResult)) {
          return cachedResult;
        }
        console.log("Cache miss (action)", cacheKey);
        await deleteCache(cacheKey);
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const freshResult = await runFreshActionFlow();
          if (isActionSuccessful(freshResult?.actionResult)) {
            return freshResult;
          }
        }
        return null;
      }
      console.log("Cache miss (action)", cacheKey);
    }

    if (shouldCheckLearningsSql(requestPayload.prompt)) {
      await refreshLearnings();
      let learningsRaw: string | null = null;
      const learningsCacheKey = buildResponseCacheKey("learnings_sql", requestPayload.prompt);
      if (responseCacheEnabled) {
        const cachedLearningsSql = await getCachedResponse(learningsCacheKey, "learnings_sql");
        if (cachedLearningsSql) {
          console.log("Cache hit (learnings_sql)", learningsCacheKey);
          learningsRaw = cachedLearningsSql;
        } else {
          console.log("Cache miss (learnings_sql)", learningsCacheKey);
        }
      }
      if (!learningsRaw) {
        const learningsPrompt = buildLearningsSqlPrompt(requestPayload);
        learningsRaw = await sendToAssistant(learningsPrompt, { model: "qwen2.5-coder:14b" });
        if (responseCacheEnabled && learningsRaw) {
          await saveCachedResponse(learningsCacheKey, "learnings_sql", learningsRaw);
        }
      }
      const learningsSql = learningsRaw ? parseLearningsSql(learningsRaw) : null;
      if (learningsSql && learningsSql.action !== "none") {
        const result = await runLearningsSql(learningsSql.sql);
        if (learningsSql.action === "list") {
          const message = formatLearningsRows(result.rows);
          return { kind: "message", message };
        }
        if (learningsSql.action === "delete") {
          await refreshLearnings();
          return { kind: "message", message: "Learning removed." };
        }
      }
    }
    if (isLearningIntent(verb, intent, requestPayload.prompt)) {
      let learningRaw: string | null = null;
      if (responseCacheEnabled) {
        const learningCacheKey = buildResponseCacheKey("learnings_extract", requestPayload.prompt);
        const cachedLearningExtract = await getCachedResponse(learningCacheKey, "learnings_extract");
        if (cachedLearningExtract) {
          console.log("Cache hit (learnings_extract)", learningCacheKey);
          learningRaw = cachedLearningExtract;
        } else {
          console.log("Cache miss (learnings_extract)", learningCacheKey);
        }
      }
      if (!learningRaw) {
        const learningPrompt = buildLearningExtractPrompt(requestPayload);
        learningRaw = await sendToAssistant(learningPrompt);
        if (responseCacheEnabled && learningRaw) {
          const learningCacheKey = buildResponseCacheKey("learnings_extract", requestPayload.prompt);
          await saveCachedResponse(learningCacheKey, "learnings_extract", learningRaw);
        }
      }
      const learningExtract = learningRaw ? parseLearningExtract(learningRaw) : null;
      if (learningExtract?.should_learn && learningExtract.learning) {
        await appendLearning(learningExtract.learning);
        return { kind: "message", message: "Got it. I've added that learning." };
      }
    }
    const keywordPrompt = buildEntityKeywordPrompt(requestPayload);
    const keywordRaw = await sendToAssistant(keywordPrompt);
    const keywords = keywordRaw ? parseKeywords(keywordRaw) : [];
    console.log("Entity keywords", JSON.stringify(keywords));
    lastEntityKeywords = keywords;
    const forcedDomain = detectForcedDomain(requestPayload.prompt);
    const filteredEntities = filterEntitiesByKeywords(keywords, entities);
    const fallbackEntities =
      filteredEntities.length > 0
        ? filteredEntities
        : forcedDomain
          ? entities.filter((e) => e.entity_id.startsWith(`${forcedDomain}.`))
          : entities;
    if (fallbackEntities.length === 0) {
      console.log("Entity filter: no matches");
      return null;
    }

    if (forceWaterUsageRead) {
      const waterEntity = selectWaterUsageEntity(fallbackEntities, requestPayload.prompt);
      if (waterEntity) {
        if (cacheEnabled) {
          await saveCachedQuery(cacheKey, [waterEntity.entity_id]);
        }
        return { kind: "query", entities: [{ entity_id: waterEntity.entity_id, state: waterEntity.state }] };
      }
    }

    if (isQueryRequest(verb, intent)) {
      let entitySelectionRaw: string | null = null;
      if (responseCacheEnabled) {
        const queryEntityCacheKey = buildResponseCacheKey("query_entity", requestPayload.prompt);
        const cachedQueryEntity = await getCachedResponse(queryEntityCacheKey, "query_entity");
        if (cachedQueryEntity) {
          console.log("Cache hit (query_entity)", queryEntityCacheKey);
          entitySelectionRaw = cachedQueryEntity;
        } else {
          console.log("Cache miss (query_entity)", queryEntityCacheKey);
        }
      }
      if (!entitySelectionRaw) {
        const entityPrompt = buildQueryEntityPrompt(requestPayload, fallbackEntities, fallbackEntities.length);
        entitySelectionRaw = await sendToAssistant(entityPrompt);
        if (responseCacheEnabled && entitySelectionRaw) {
          const queryEntityCacheKey = buildResponseCacheKey("query_entity", requestPayload.prompt);
          await saveCachedResponse(queryEntityCacheKey, "query_entity", entitySelectionRaw);
        }
      }
      if (!entitySelectionRaw) {
        return null;
      }

      const selectedEntityIds = parseSelectedEntityIds(entitySelectionRaw);
      if (selectedEntityIds.length === 0) {
        console.log("Invalid entity_id from assistant", "none");
        return null;
      }

      const results = selectedEntityIds
        .map((id) => entities.find((e) => e.entity_id === id))
        .filter((e): e is HaEntity => !!e)
        .map((e) => ({ entity_id: e.entity_id, state: e.state }));

      if (results.length === 0) {
        return null;
      }

      if (cacheEnabled) {
        await saveCachedQuery(cacheKey, selectedEntityIds);
      }
      return { kind: "query", entities: results };
    }

    async function runFreshActionFlow(): Promise<AssistantResult | null> {
      const tools = getToolsList();
      const forcedWaterEntity = forceWaterUsageRead
        ? selectWaterUsageEntity(fallbackEntities, requestPayload.prompt)
        : null;
      const forcedStateTool = forceWaterUsageRead ? findToolByName(tools, "HassGetState") : null;

      if (forceWaterUsageRead && forcedWaterEntity && forcedStateTool) {
        const forcedArgs: Record<string, unknown> = {
          entity_id: forcedWaterEntity.entity_id,
        };
        const forcedResult = await executeActionFromCall(
          forcedStateTool.name,
          forcedArgs,
          "forced:HassGetState",
          "forced:water_usage_intent"
        );
        if (isActionSuccessful(forcedResult.actionResult)) {
          if (cacheEnabled) {
            await saveCachedAction(
              cacheKey,
              forcedStateTool.name,
              forcedArgs,
              responseCacheEnabled ? forcedResult.finalMessage ?? null : null
            );
          } else if (responseCacheEnabled && forcedResult.finalMessage) {
            await saveCachedResponse(cacheKey, "action", forcedResult.finalMessage);
          }
          return forcedResult;
        }
      }

      const prompt = buildToolSelectionPrompt(requestPayload, tools);
      const toolSelectionRaw = await sendToAssistant(prompt);
      if (!toolSelectionRaw) {
        return null;
      }

      const selectedTools = parseSelectedTools(toolSelectionRaw);
      const entitiesForPrompt = fallbackEntities;
      console.log(`Entity filter: ${fallbackEntities.length} matched`);

      let toolsForMcp = resolveRequestedTools(tools, selectedTools);
      if (selectedTools.length > 0 && toolsForMcp.length === 0) {
        console.log(
          "Assistant selected unavailable tools; using full tool list",
          JSON.stringify(selectedTools)
        );
        toolsForMcp = tools;
      }

      const mcpPrompt = buildMcpCallPrompt(
        requestPayload,
        toolsForMcp,
        entitiesForPrompt,
        fallbackEntities.length,
        forcedDomain
      );
      const entitySelectionRaw = await sendToAssistant(mcpPrompt);
      if (!entitySelectionRaw) {
        return null;
      }

      const mcpCall = parseMcpCall(entitySelectionRaw);
      if (!mcpCall?.tool || !mcpCall.arguments) {
        console.log("Invalid MCP call from assistant");
        return { kind: "action", toolSelectionRaw, entitySelectionRaw };
      }

      const resolvedMcpTool = resolveRequestedTool(tools, mcpCall.tool);
      if (!resolvedMcpTool) {
        console.log("Assistant selected unavailable tool", mcpCall.tool);
        return { kind: "action", toolSelectionRaw, entitySelectionRaw };
      }

      if (toolsForMcp.length > 0 && !toolsForMcp.some((t) => t.name === resolvedMcpTool.name)) {
        console.log("Assistant tool not in resolved selected tools", resolvedMcpTool.name);
        return { kind: "action", toolSelectionRaw, entitySelectionRaw };
      }

      const result = await executeActionFromCall(
        resolvedMcpTool.name,
        mcpCall.arguments,
        toolSelectionRaw,
        entitySelectionRaw
      );
      if (isActionSuccessful(result.actionResult)) {
        if (cacheEnabled) {
          await saveCachedAction(
            cacheKey,
            resolvedMcpTool.name,
            mcpCall.arguments,
            responseCacheEnabled ? result.finalMessage ?? null : null
          );
        } else if (responseCacheEnabled && result.finalMessage) {
          await saveCachedResponse(cacheKey, "action", result.finalMessage);
        }
      }
      return result;
    }

    return await runFreshActionFlow();
  }

  if (isJsonRpcRequest(payload)) {
    console.log("entryPoint forwarding JSON-RPC payload");
    await mcpClient.send(payload);
    return null;
  }

  console.log("entryPoint received non-JSON-RPC payload");
  return null;
}

export async function initializeHomeAssistant(): Promise<void> {
  const mcpClient = getClient();
  if (!mcpClient) {
    console.log("MCP init skipped: missing HOME_ASSISTANT_URL or HOME_ASSISTANT_TOKEN");
    return;
  }

  if (!initialized) {
    console.log("MCP initializing...");
    await mcpClient.initialize();
    initialized = true;
  }

  const toolsResponse = await mcpClient.listTools();
  if (toolsResponse.type === "json" && toolsResponse.response) {
    cachedTools = toolsResponse.response;
    toolsByDomain = groupToolsByDomain(cachedTools);
  }

  await fetchHomeAssistantStates();
}

export function getCachedTools(): JsonRpcResponse | null {
  return cachedTools;
}

export function getToolsByDomain(): Record<string, McpTool[]> | null {
  return toolsByDomain;
}

export function getEntitiesByDomain(): Record<string, HaEntity[]> | null {
  return entitiesByDomain;
}

function logMatchedEntitiesForLastPrompt(map: Record<string, HaEntity[]>): void {
  if (lastEntityKeywords.length === 0) {
    return;
  }
  const tokens = lastEntityKeywords.map((t) => t.toLowerCase()).filter((t) => t.length > 0);
  if (tokens.length === 0) {
    return;
  }

  const matches = Object.values(map)
    .flat()
    .filter((e) =>
      tokens.some(
        (t) =>
          e.entity_id.toLowerCase().includes(t) ||
          e.friendly_name?.toLowerCase().includes(t) ||
          e.area_name?.toLowerCase().includes(t)
      )
    );

  if (matches.length === 0) {
    return;
  }

  console.log(
    `Matched entities for keywords "${tokens.join(" ")}":`,
    JSON.stringify(
      matches.map((e) => ({
        id: e.entity_id,
        name: e.friendly_name,
        area: e.area_name,
      }))
    )
  );
}

function groupToolsByDomain(response: JsonRpcResponse): Record<string, McpTool[]> | null {
  if ("result" in response) {
    const result = response.result as { tools?: McpTool[] };
    if (!Array.isArray(result.tools)) {
      return null;
    }

    const grouped: Record<string, McpTool[]> = {};
    for (const tool of result.tools) {
      const rawName = typeof tool?.name === "string" ? tool.name : "unknown";
      const domain = rawName.split(".")[0] ?? "unknown";
      if (!grouped[domain]) {
        grouped[domain] = [];
      }
      grouped[domain].push(tool);
    }

    return grouped;
  }

  return null;
}

function mapMcpResponse(response: { type: string; response?: JsonRpcResponse; raw?: string }): McpActionResult {
  if (response.type === "json" && response.response) {
    if ("error" in response.response) {
      return {
        ok: false,
        error: response.response.error.message,
        data: response.response.error,
      };
    }
    return {
      ok: true,
      data: response.response.result,
    };
  }

  return {
    ok: false,
    error: "Unexpected MCP response type",
    data: response.raw ?? null,
  };
}

function actionResultHasError(data: unknown): boolean {
  if (!data || typeof data !== "object") {
    return false;
  }
  const record = data as { isError?: boolean; content?: Array<{ isError?: boolean }> };
  if (record.isError === true) {
    return true;
  }
  if (Array.isArray(record.content)) {
    return record.content.some((item) => item?.isError === true);
  }
  return false;
}

function isActionSuccessful(result: McpActionResult | null | undefined): boolean {
  if (!result || result.ok !== true) {
    return false;
  }
  return !actionResultHasError(result.data);
}

function sanitizeArguments(args: Record<string, unknown>): Record<string, unknown> {
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) {
      continue;
    }
    if (typeof value === "string" && value.trim() === "") {
      continue;
    }
    if (Array.isArray(value) && value.length === 0) {
      continue;
    }
    cleaned[key] = value;
  }
  return cleaned;
}

function findEntityForArguments(args: Record<string, unknown>, entities: HaEntity[]): HaEntity | null {
  const entityIdArg = typeof args.entity_id === "string" ? args.entity_id.toLowerCase() : null;
  if (entityIdArg) {
    const match = entities.find((e) => e.entity_id.toLowerCase() === entityIdArg);
    if (match) {
      return match;
    }
  }

  const nameArg = typeof args.name === "string" ? args.name.trim().toLowerCase() : null;
  if (!nameArg) {
    return null;
  }

  const exactByName = entities.filter((e) => (e.friendly_name ?? "").trim().toLowerCase() === nameArg);
  if (exactByName.length === 1) {
    return exactByName[0];
  }

  const exactById = entities.filter((e) => e.entity_id.toLowerCase() === nameArg);
  if (exactById.length === 1) {
    return exactById[0];
  }

  const partialByName = entities.filter((e) => (e.friendly_name ?? "").toLowerCase().includes(nameArg));
  if (partialByName.length === 1) {
    return partialByName[0];
  }

  return null;
}

function alignDomainWithEntity(args: Record<string, unknown>, entities: HaEntity[]): Record<string, unknown> {
  const matchedEntity = findEntityForArguments(args, entities);
  if (!matchedEntity) {
    return args;
  }

  const resolvedDomain = matchedEntity.entity_id.split(".")[0];
  if (!resolvedDomain) {
    return args;
  }

  const currentDomain = args.domain;
  if (typeof currentDomain === "string") {
    if (currentDomain.toLowerCase() === resolvedDomain.toLowerCase()) {
      return args;
    }
    console.log("[mcp] domain corrected", JSON.stringify({ from: currentDomain, to: resolvedDomain, name: args.name }));
    return { ...args, domain: resolvedDomain };
  }

  if (Array.isArray(currentDomain)) {
    const domains = currentDomain.filter((d): d is string => typeof d === "string");
    if (domains.length === 1 && domains[0].toLowerCase() === resolvedDomain.toLowerCase()) {
      return args;
    }
    if (domains.some((d) => d.toLowerCase() === resolvedDomain.toLowerCase()) && domains.length > 0) {
      return args;
    }
    console.log("[mcp] domain corrected", JSON.stringify({ from: domains, to: [resolvedDomain], name: args.name }));
    return { ...args, domain: [resolvedDomain] };
  }

  return { ...args, domain: [resolvedDomain] };
}

type PromptTemplate = {
  name: string;
  version: number;
  instructions: string[];
  output_schema: Record<string, unknown>;
};

const promptCache = new Map<string, PromptTemplate>();

function loadPrompt(name: string): PromptTemplate {
  const cached = promptCache.get(name);
  if (cached) {
    return cached;
  }
  const promptPath = path.resolve(__dirname, "..", "prompts", `${name}.json`);
  const raw = fs.readFileSync(promptPath, "utf-8");
  const parsed = JSON.parse(raw) as PromptTemplate;
  promptCache.set(name, parsed);
  return parsed;
}

function renderPrompt(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key: string) => {
    return Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : "";
  });
}

function buildPromptMessage(
  template: PromptTemplate,
  vars: Record<string, string>,
  learnings: string[]
) {
  const base = template.instructions.join("\n");
  const rendered = renderPrompt(base, vars);
  if (!learnings || learnings.length === 0) {
    return rendered;
  }
  const promptText = `${vars.payload ?? ""}`.toLowerCase();
  const filteredLearnings = learnings.filter((learning) =>
    learningTokensMatchPrompt(learning, promptText)
  );
  if (filteredLearnings.length === 0) {
    return rendered;
  }
  const contextLines = [
    "Additional context:",
    ...filteredLearnings.map((learning) => `- ${learning}`),
  ];
  return `${contextLines.join("\n")}\n\n${rendered}`;
}

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
  "very"
]);

function tokenizeText(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((t) => t.trim())
    .filter((t) => t.length > 0 && !STOP_WORDS.has(t));
}

function learningTokensMatchPrompt(learning: string, promptText: string): boolean {
  const tokens = tokenizeText(learning);
  if (tokens.length === 0) {
    return false;
  }
  return tokens.some((token) => promptText.includes(token));
}
