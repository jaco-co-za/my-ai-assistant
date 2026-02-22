#!/usr/bin/env node
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import mysql from "mysql2/promise";

const DEFAULT_HOST = "192.168.55.113";
const DEFAULT_FILE_SERVICE_URL = `http://${DEFAULT_HOST}:3224`;
const DEFAULT_OLLAMA_URL = `http://${DEFAULT_HOST}:11434`;
const DEFAULT_OWNER = "sonja";
const DEFAULT_MODEL = "qwen3-embedding";
const DEFAULT_LARGE_FILE_BYTES = 1024 * 1024;
const DEFAULT_CHUNK_BYTES = 250 * 1024;
const DEFAULT_EMBED_MAX_INPUT_CHARS = 12000;
const DEFAULT_CLASSIFIER_ENABLED = true;
const DEFAULT_CLASSIFIER_MODEL = "qwen2.5:14b";
const DEFAULT_CLASSIFIER_TIMEOUT_MS = 45000;
const DEFAULT_VERBOSE_LOGS = false;
const HTTP_TIMEOUT_MS = 120_000;

function usage() {
  console.log("Usage: node src/index.mjs [--limit N] [--dry-run] [--metadata-only]");
  console.log("");
  console.log("Env:");
  console.log("  FILE_SERVICE_URL       default http://192.168.55.113:3224");
  console.log("  FILE_SERVICE_AUTH      bearer token value or full header value");
  console.log("  OLLAMA_URL             default http://192.168.55.113:11434");
  console.log("  OLLAMA_MODEL           default qwen3-embedding");
  console.log("  VECTOR_OWNER           default sonja");
  console.log("  LARGE_FILE_BYTES       default 1048576 (1MB)");
  console.log("  CHUNK_BYTES            default 256000 (250KB)");
  console.log("  EMBED_MAX_INPUT_CHARS  default 12000");
  console.log("  CLASSIFIER_ENABLED     default true");
  console.log("  CLASSIFIER_MODEL       default qwen2.5:14b");
  console.log("  CLASSIFIER_TIMEOUT_MS  default 45000");
  console.log("  VERBOSE_LOGS           default false");
  console.log("  MYSQL_HOST             default 127.0.0.1");
  console.log("  MYSQL_PORT             default 3306");
  console.log("  MYSQL_DATABASE         required");
  console.log("  MYSQL_USER             required");
  console.log("  MYSQL_PASSWORD         required");
}

function parseArgs(argv) {
  const out = { limit: 0, dryRun: false, metadataOnly: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i] || "").trim();
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }
    if (arg === "--dry-run") {
      out.dryRun = true;
      continue;
    }
    if (arg === "--metadata-only") {
      out.metadataOnly = true;
      continue;
    }
    if (arg === "--limit") {
      const raw = argv[i + 1];
      const parsed = Number.parseInt(String(raw || "0"), 10);
      if (Number.isFinite(parsed) && parsed >= 0) {
        out.limit = parsed;
      }
      i += 1;
    }
  }
  return out;
}

function normalizeHeaderToken(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }
  return /^bearer\s+/i.test(raw) ? raw : `Bearer ${raw}`;
}

function toInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function toBool(value, fallback = false) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return fallback;
  return raw === "1" || raw === "true" || raw === "yes" || raw === "y";
}

async function fetchWithTimeout(url, options = {}, timeoutMs = HTTP_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function splitBuffer(buffer, chunkBytes) {
  const chunks = [];
  for (let offset = 0; offset < buffer.length; offset += chunkBytes) {
    chunks.push(buffer.subarray(offset, Math.min(buffer.length, offset + chunkBytes)));
  }
  return chunks.length > 0 ? chunks : [Buffer.alloc(0)];
}

function normalizeClassifierText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isValidGrade(value) {
  return Number.isFinite(value) && value >= 1 && value <= 10;
}

function extractGradeCandidates(text) {
  const normalized = normalizeClassifierText(text);
  if (!normalized) {
    return [];
  }
  const out = [];
  const directNumericPatterns = [
    /\b(?:grade|graad|gr)\s*\.?\s*(\d{1,2})\b/g,
    /\bg\s*\.?\s*(\d{1,2})\b/g,
  ];
  for (const pattern of directNumericPatterns) {
    let match = null;
    while ((match = pattern.exec(normalized)) !== null) {
      const grade = Number(match[1]);
      if (isValidGrade(grade)) {
        out.push(grade);
      }
    }
  }
  const rangePatterns = [
    /\b(?:grade|graad|gr)\s*\.?\s*(\d{1,2})\s*(?:to|tot|and|en|-)\s*(\d{1,2})\b/g,
    /\b(\d{1,2})\s*(?:to|tot|and|en|-)\s*(\d{1,2})\s*(?:grade|graad)\b/g,
  ];
  for (const pattern of rangePatterns) {
    let match = null;
    while ((match = pattern.exec(normalized)) !== null) {
      const left = Number(match[1]);
      const right = Number(match[2]);
      if (isValidGrade(left)) out.push(left);
      if (isValidGrade(right)) out.push(right);
    }
  }
  const wordMap = new Map([
    ["one", 1], ["two", 2], ["three", 3], ["four", 4], ["five", 5], ["six", 6],
    ["seven", 7], ["eight", 8], ["nine", 9], ["ten", 10], ["eleven", 11], ["twelve", 12],
    ["first", 1], ["second", 2], ["third", 3], ["fourth", 4], ["fifth", 5], ["sixth", 6],
    ["seventh", 7], ["eighth", 8], ["ninth", 9], ["tenth", 10], ["eleventh", 11], ["twelfth", 12],
    ["een", 1], ["twee", 2], ["drie", 3], ["vier", 4], ["vyf", 5], ["ses", 6],
    ["sewe", 7], ["agt", 8], ["nege", 9], ["tien", 10], ["elf", 11], ["twaalf", 12],
    ["eerste", 1], ["tweede", 2], ["derde", 3], ["vierde", 4], ["vyfde", 5], ["sesde", 6],
    ["sewende", 7], ["agtste", 8], ["negende", 9], ["tiende", 10], ["elfde", 11], ["twaalfde", 12],
  ]);
  const gradeWords =
    "one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|" +
    "first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|" +
    "een|twee|drie|vier|vyf|ses|sewe|agt|nege|tien|elf|twaalf|" +
    "eerste|tweede|derde|vierde|vyfde|sesde|sewende|agtste|negende|tiende|elfde|twaalfde";
  const wordPattern =
    new RegExp(`\\b(?:grade|graad|gr)\\s*\\.?\\s*(${gradeWords})\\b`, "g");
  const inverseWordPattern =
    new RegExp(`\\b(${gradeWords})\\s*(?:grade|graad)\\b`, "g");
  const compactWordPattern =
    new RegExp(`\\b(${gradeWords})(?:grade|graad)(?=\\b|[a-z])`, "g");
  const wordPatterns = [wordPattern, inverseWordPattern, compactWordPattern];
  for (const pattern of wordPatterns) {
    let wordMatch = null;
    while ((wordMatch = pattern.exec(normalized)) !== null) {
      const grade = wordMap.get(wordMatch[1]) ?? null;
      if (grade !== null && isValidGrade(grade)) {
        out.push(grade);
      }
    }
  }
  return out;
}

function pickMostLikelyGrade(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return null;
  }
  const counts = new Map();
  for (const grade of candidates) {
    counts.set(grade, (counts.get(grade) || 0) + 1);
  }
  let bestGrade = null;
  let bestCount = -1;
  for (const [grade, count] of counts.entries()) {
    if (count > bestCount) {
      bestGrade = grade;
      bestCount = count;
      continue;
    }
    if (count === bestCount && bestGrade !== null && grade > bestGrade) {
      // Prefer higher grade when tied.
      bestGrade = grade;
    }
  }
  return bestGrade;
}

function detectGrade(summary, filename) {
  const filenameCandidates = extractGradeCandidates(filename);
  if (filenameCandidates.length > 0) {
    return pickMostLikelyGrade(filenameCandidates);
  }
  const summaryCandidates = extractGradeCandidates(summary);
  if (summaryCandidates.length > 0) {
    return pickMostLikelyGrade(summaryCandidates);
  }
  return null;
}

const SUBJECT_RULES = [
  {
    key: "math",
    patterns: [
      /\bmath\b/, /\bmaths\b/, /\bmathematics\b/, /\bwiskunde\b/, /\bwisk\b/,
      /\balgebra\b/, /\bgeometry\b/, /\bgeometrie\b/, /\bfractions?\b/,
      /\boptel\b/, /\baftrek\b/, /\bdeel\b/, /\bvermenigvuldig\b/,
      /\baddition\b/, /\bsubtraction\b/, /\bmultiplication\b/, /\bdivision\b/,
      /\barithmetic\b/,
    ],
  },
  { key: "mathematical-literacy", patterns: [/\bmathematical literacy\b/, /\bwiskundige geletterdheid\b/] },
  { key: "afrikaans", patterns: [/\bafrikaans\b/, /\bafr\b/] },
  { key: "english", patterns: [/\benglish\b/, /\beng\b/] },
  { key: "isizulu", patterns: [/\bisizulu\b/, /\bzulu\b/] },
  { key: "isixhosa", patterns: [/\bisixhosa\b/, /\bxhosa\b/] },
  { key: "sepedi", patterns: [/\bsepedi\b/, /\bnorthern sotho\b/] },
  { key: "setswana", patterns: [/\bsetswana\b/, /\btswana\b/] },
  { key: "sesotho", patterns: [/\bsesotho\b/, /\bsotho\b/] },
  { key: "xitsonga", patterns: [/\bxitsonga\b/, /\btsonga\b/] },
  { key: "tshivenda", patterns: [/\btshivenda\b/, /\bvenda\b/] },
  { key: "siswati", patterns: [/\bsiswati\b/, /\bswati\b/] },
  { key: "isindebele", patterns: [/\bisindebele\b/, /\bndebele\b/] },
  { key: "natural-sciences", patterns: [/\bnatural sciences\b/, /\bnatuurwetenskap\b/, /\bnst\b/] },
  { key: "life-sciences", patterns: [/\blife sciences\b/, /\blewenswetenskappe\b/, /\bbiology\b/] },
  { key: "physical-sciences", patterns: [/\bphysical sciences\b/, /\bfisiese wetenskappe\b/, /\bphysics\b/, /\bchemistry\b/] },
  { key: "social-sciences", patterns: [/\bsocial sciences\b/, /\bsosiale wetenskappe\b/, /\bss\b/] },
  { key: "science", patterns: [/\bscience\b/] },
  { key: "history", patterns: [/\bhistory\b/, /\bgeskiedenis\b/] },
  { key: "geography", patterns: [/\bgeography\b/, /\baardrykskunde\b/] },
  { key: "technology", patterns: [/\btechnology\b/, /\btegnologie\b/] },
  { key: "robotics-coding", patterns: [/\brobotics\b/, /\bcoding\b/, /\bprogramming\b/] },
  { key: "life-orientation", patterns: [/\blife orientation\b/, /\blewensorientering\b/, /\blo\b/] },
  { key: "creative-arts", patterns: [/\bcreative arts\b/, /\bskeppende kunste\b/] },
  { key: "visual-arts", patterns: [/\bvisual arts\b/, /\bvisuele kunste\b/] },
  { key: "dramatic-arts", patterns: [/\bdramatic arts\b/, /\bdrama\b/] },
  { key: "music", patterns: [/\bmusic\b/, /\bmusiek\b/] },
  { key: "arts", patterns: [/\barts\b/] },
  { key: "ems", patterns: [/\beconomic and management sciences\b/, /\bems\b/] },
  { key: "accounting", patterns: [/\baccounting\b/, /\brekeningkunde\b/] },
  { key: "business-studies", patterns: [/\bbusiness studies\b/, /\bbesigheidstudies\b/] },
  { key: "economics", patterns: [/\beconomics\b/, /\bekonomie\b/] },
  { key: "tourism", patterns: [/\btourism\b/, /\btoerisme\b/] },
  { key: "consumer-studies", patterns: [/\bconsumer studies\b/, /\bverbruikerstudies\b/] },
  { key: "agricultural-sciences", patterns: [/\bagricultural sciences\b/, /\blandbouw\b/, /\blandbou\b/] },
  { key: "cat", patterns: [/\bcomputer applications technology\b/, /\bcat\b/] },
  { key: "information-technology", patterns: [/\binformation technology\b/, /\bit\b/] },
  { key: "religion-studies", patterns: [/\breligion studies\b/, /\bgodsdiensstudies\b/] },
  { key: "engineering-graphics-design", patterns: [/\bengineering graphics and design\b/, /\begd\b/] },
  { key: "civil-technology", patterns: [/\bcivil technology\b/] },
  { key: "electrical-technology", patterns: [/\belectrical technology\b/] },
  { key: "mechanical-technology", patterns: [/\bmechanical technology\b/] },
];

function scoreSubject(text, weight) {
  const normalized = normalizeClassifierText(text);
  const scores = new Map();
  if (!normalized) {
    return scores;
  }
  for (const rule of SUBJECT_RULES) {
    for (const pattern of rule.patterns) {
      if (pattern.test(normalized)) {
        scores.set(rule.key, (scores.get(rule.key) || 0) + weight);
      }
    }
  }
  return scores;
}

function mergeScores(a, b) {
  const out = new Map(a);
  for (const [k, v] of b.entries()) {
    out.set(k, (out.get(k) || 0) + v);
  }
  return out;
}

function detectSubject(summary, filename) {
  const fromFilename = scoreSubject(filename, 3);
  const fromSummary = scoreSubject(summary, 2);
  const combined = mergeScores(fromFilename, fromSummary);
  let best = "unknown";
  let bestScore = 0;
  for (const [key, score] of combined.entries()) {
    if (score > bestScore) {
      best = key;
      bestScore = score;
    }
  }
  return best;
}

function parseEducational(summary, filename, grade, subject) {
  const value = normalizeClassifierText(`${summary} ${filename}`);
  const negativeSignals = [
    /\bbank statement\b/,
    /\bcredit facility\b/,
    /\bquotation\b/,
    /\binvoice\b/,
    /\btax invoice\b/,
    /\bpayment advice\b/,
    /\bproof of payment\b/,
    /\bsalary slip\b/,
    /\bpayslip\b/,
    /\bpolicy schedule\b/,
    /\bid document\b/,
    /\bidentity document\b/,
    /\bcontract\b/,
    /\blease agreement\b/,
  ];
  const positiveSignals = [
    /\bworksheet\b/,
    /\bworksheets\b/,
    /\bworkbook\b/,
    /\blesson\b/,
    /\bclasswork\b/,
    /\bhomework\b/,
    /\bactivity\b/,
    /\bassessment\b/,
    /\bexam\b/,
    /\btoets\b/,
    /\boefening\b/,
    /\bbegripslees\b/,
    /\bleer\b/,
    /\bschool\b/,
  ];
  let negative = 0;
  let positive = 0;
  for (const pattern of negativeSignals) {
    if (pattern.test(value)) {
      negative += 1;
    }
  }
  for (const pattern of positiveSignals) {
    if (pattern.test(value)) {
      positive += 1;
    }
  }
  if (negative > positive) {
    return 0;
  }
  if (positive > 0) {
    return 1;
  }
  if (grade !== null || subject !== "unknown") {
    return 1;
  }
  return 0;
}

function canonicalizeSubjectLabel(label) {
  const text = normalizeClassifierText(label);
  if (!text || text === "other") return "unknown";
  const byLabel = [
    ["mathematical-literacy", /\bmathematical literacy\b|\bwiskundige geletterdheid\b/],
    ["math", /\bmathematics\b|\bmaths?\b|\bwiskunde\b/],
    ["english", /\benglish\b/],
    ["afrikaans", /\bafrikaans\b/],
    ["isizulu", /\bisizulu\b|\bzulu\b/],
    ["isixhosa", /\bisixhosa\b|\bxhosa\b/],
    ["sepedi", /\bsepedi\b|\bnorthern sotho\b/],
    ["setswana", /\bsetswana\b|\btswana\b/],
    ["sesotho", /\bsesotho\b/],
    ["xitsonga", /\bxitsonga\b/],
    ["tshivenda", /\btshivenda\b|\bvenda\b/],
    ["siswati", /\bsiswati\b|\bswati\b/],
    ["isindebele", /\bisindebele\b|\bndebele\b/],
    ["natural-sciences", /\bnatural sciences\b/],
    ["life-sciences", /\blife sciences\b/],
    ["physical-sciences", /\bphysical sciences\b/],
    ["social-sciences", /\bsocial sciences\b/],
    ["history", /\bhistory\b/],
    ["geography", /\bgeography\b/],
    ["technology", /\btechnology\b/],
    ["robotics-coding", /\brobotics\b|\bcoding\b/],
    ["life-orientation", /\blife orientation\b/],
    ["creative-arts", /\bcreative arts\b/],
    ["visual-arts", /\bvisual arts\b/],
    ["dramatic-arts", /\bdramatic arts\b/],
    ["music", /\bmusic\b/],
    ["ems", /\bems\b|\beconomic and management sciences\b/],
    ["accounting", /\baccounting\b/],
    ["business-studies", /\bbusiness studies\b/],
    ["economics", /\beconomics\b/],
    ["tourism", /\btourism\b/],
    ["consumer-studies", /\bconsumer studies\b/],
    ["agricultural-sciences", /\bagricultural sciences\b|\blandbou\b/],
    ["cat", /\bcat\b|\bcomputer applications technology\b/],
    ["information-technology", /\binformation technology\b/],
    ["religion-studies", /\breligion studies\b/],
    ["engineering-graphics-design", /\bengineering graphics and design\b|\begd\b/],
    ["civil-technology", /\bcivil technology\b/],
    ["electrical-technology", /\belectrical technology\b/],
    ["mechanical-technology", /\bmechanical technology\b/],
  ];
  for (const [key, pattern] of byLabel) {
    if (pattern.test(text)) {
      return key;
    }
  }
  return "unknown";
}

function normalizeClassifierInput(summary, filename) {
  const parts = [
    `filename: ${String(filename || "").trim()}`,
    `summary: ${String(summary || "").trim()}`,
  ];
  return parts.join("\n").trim();
}

function isClassifierEnabled(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return DEFAULT_CLASSIFIER_ENABLED;
  return raw === "1" || raw === "true" || raw === "yes" || raw === "y";
}

function buildClassifierPromptPayload(summary, filename, allowedSubjects) {
  return {
    filename: String(filename || ""),
    summary: String(summary || ""),
    rules: {
      grade_range: "1..10 only, else null",
      subject_must_be_one_of: allowedSubjects,
      educational_binary: "1=educational school content, 0=non-educational",
      output_json_only: true,
    },
  };
}

async function classifyWithOllama(config, summary, filename, allowedSubjects) {
  const startedAt = Date.now();
  const payload = buildClassifierPromptPayload(summary, filename, allowedSubjects);
  if (config.verboseLogs) {
    console.log(`[classify] request file="${filename}" model=${config.classifierModel}`);
  }
  const response = await fetchWithTimeout(
    `${config.ollamaUrl}/api/chat`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        model: config.classifierModel,
        stream: false,
        format: "json",
        options: { temperature: 0 },
        messages: [
          {
            role: "system",
            content:
              "You are a strict file metadata classifier. Return ONLY JSON with keys: grade, subject, educational, confidence.",
          },
          { role: "user", content: JSON.stringify(payload) },
        ],
      }),
    },
    config.classifierTimeoutMs,
  );
  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`classification call failed (${response.status}): ${raw}`);
  }
  let parsed = {};
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = {};
  }
  let content = "";
  if (typeof parsed?.message?.content === "string") {
    content = parsed.message.content;
  } else if (typeof parsed?.response === "string") {
    content = parsed.response;
  } else if (typeof raw === "string") {
    content = raw;
  }
  let json = {};
  try {
    json = JSON.parse(content);
  } catch {
    json = {};
  }
  const rawGrade = Number(json.grade);
  const grade = isValidGrade(rawGrade) ? rawGrade : null;
  const subject = canonicalizeSubjectLabel(json.subject);
  const educational = Number(json.educational) === 1 ? 1 : Number(json.educational) === 0 ? 0 : null;
  const confidence = Number.isFinite(Number(json.confidence)) ? Number(json.confidence) : 0;
  if (config.verboseLogs) {
    console.log(
      `[classify] result file="${filename}" grade=${grade ?? "null"} subject=${subject} educational=${educational ?? "null"} confidence=${confidence} elapsed=${Date.now() - startedAt}ms`,
    );
  }
  return { grade, subject, educational, confidence };
}

async function createClassifierContext(config) {
  if (!config.classifierEnabled) {
    return {
      enabled: false,
      classifySubject: async () => ({ subject: "unknown", score: 0 }),
      classifyGrade: async () => ({ grade: null, score: 0 }),
      classifyAll: async () => ({ grade: null, subject: "unknown", educational: null, confidence: 0 }),
    };
  }
  const cache = new Map();
  const allowedSubjects = Array.from(new Set(SUBJECT_RULES.map((rule) => rule.key)));

  return {
    enabled: true,
    async classifySubject(summary, filename) {
      const key = normalizeClassifierInput(summary, filename);
      if (!key) {
        return { subject: "unknown", score: 0 };
      }
      if (!cache.has(key)) {
        cache.set(key, await classifyWithOllama(config, summary, filename, allowedSubjects));
      }
      const hit = cache.get(key);
      return { subject: hit.subject || "unknown", score: hit.confidence || 0 };
    },
    async classifyGrade(summary, filename) {
      const key = normalizeClassifierInput(summary, filename);
      if (!key) {
        return { grade: null, score: 0 };
      }
      if (!cache.has(key)) {
        cache.set(key, await classifyWithOllama(config, summary, filename, allowedSubjects));
      }
      const hit = cache.get(key);
      return { grade: hit.grade, score: hit.confidence || 0 };
    },
    async classifyAll(summary, filename) {
      const key = normalizeClassifierInput(summary, filename);
      if (!key) {
        return { grade: null, subject: "unknown", educational: null, confidence: 0 };
      }
      if (!cache.has(key)) {
        cache.set(key, await classifyWithOllama(config, summary, filename, allowedSubjects));
      }
      return cache.get(key);
    },
  };
}

async function classifyMetadata(summary, filename, classifierCtx) {
  let grade = detectGrade(summary, filename);
  let subject = detectSubject(summary, filename);
  let educational = parseEducational(summary, filename, grade, subject);
  if (classifierCtx?.enabled) {
    const predicted = await classifierCtx.classifyAll(summary, filename);
    if (subject === "unknown") {
      const subjectPred = await classifierCtx.classifySubject(summary, filename);
      if (subjectPred.subject && subjectPred.subject !== "other") {
        subject = subjectPred.subject;
      }
    }
    if (grade === null) {
      const gradePred = await classifierCtx.classifyGrade(summary, filename);
      if (gradePred.grade !== null) {
        grade = gradePred.grade;
      }
    }
    if (predicted && (predicted.educational === 0 || predicted.educational === 1)) {
      educational = predicted.educational;
    } else {
      educational = parseEducational(summary, filename, grade, subject);
    }
  } else {
    educational = parseEducational(summary, filename, grade, subject);
  }
  return { grade, subject, educational };
}

async function loadEnvFromFile(filePath) {
  const content = await fs.readFile(filePath, "utf8").catch(() => "");
  if (!content) {
    return {};
  }
  const out = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx < 0) continue;
    out[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
  }
  return out;
}

async function resolveConfig() {
  const here = path.dirname(new URL(import.meta.url).pathname);
  const repoRoot = path.resolve(here, "..", "..", "..");
  const localEnv = await loadEnvFromFile(path.resolve(here, "..", ".env"));
  const fileEnv = await loadEnvFromFile(path.resolve(repoRoot, "micro services", "mservice-file", ".env"));
  const mysqlEnv = await loadEnvFromFile(path.resolve(repoRoot, "servers", "mysql-docker", ".env"));

  const fileServiceUrl = String(process.env.FILE_SERVICE_URL || localEnv.FILE_SERVICE_URL || DEFAULT_FILE_SERVICE_URL).replace(/\/+$/, "");
  const fileServiceAuth = normalizeHeaderToken(
    process.env.FILE_SERVICE_AUTH || localEnv.FILE_SERVICE_AUTH || fileEnv.AUTH_BEARER_TOKEN || fileEnv.FILE_MICRO_SERVICE_AUTH || "",
  );
  const ollamaUrl = String(process.env.OLLAMA_URL || localEnv.OLLAMA_URL || DEFAULT_OLLAMA_URL).replace(/\/+$/, "");
  const model = String(process.env.OLLAMA_MODEL || localEnv.OLLAMA_MODEL || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  const owner = String(process.env.VECTOR_OWNER || localEnv.VECTOR_OWNER || DEFAULT_OWNER).trim().toLowerCase() || DEFAULT_OWNER;
  const largeFileBytes = toInt(process.env.LARGE_FILE_BYTES || localEnv.LARGE_FILE_BYTES, DEFAULT_LARGE_FILE_BYTES);
  const chunkBytes = toInt(process.env.CHUNK_BYTES || localEnv.CHUNK_BYTES, DEFAULT_CHUNK_BYTES);
  const embedMaxInputChars = toInt(
    process.env.EMBED_MAX_INPUT_CHARS || localEnv.EMBED_MAX_INPUT_CHARS,
    DEFAULT_EMBED_MAX_INPUT_CHARS,
  );
  const classifierEnabled = isClassifierEnabled(process.env.CLASSIFIER_ENABLED ?? localEnv.CLASSIFIER_ENABLED);
  const classifierModel = String(process.env.CLASSIFIER_MODEL || localEnv.CLASSIFIER_MODEL || DEFAULT_CLASSIFIER_MODEL).trim();
  const classifierTimeoutMs = toInt(
    process.env.CLASSIFIER_TIMEOUT_MS || localEnv.CLASSIFIER_TIMEOUT_MS,
    DEFAULT_CLASSIFIER_TIMEOUT_MS,
  );
  const verboseLogs = toBool(process.env.VERBOSE_LOGS ?? localEnv.VERBOSE_LOGS, DEFAULT_VERBOSE_LOGS);

  const mysqlHostRaw = String(
    process.env.MYSQL_HOST || localEnv.MYSQL_HOST || mysqlEnv.VECTORIZER_MYSQL_HOST || mysqlEnv.MYSQL_HOST || "127.0.0.1",
  ).trim();
  const mysqlHost = mysqlHostRaw === "%" ? "127.0.0.1" : mysqlHostRaw;
  const mysqlPort = toInt(process.env.MYSQL_PORT || localEnv.MYSQL_PORT || mysqlEnv.MYSQL_PORT, 3306);
  const mysqlDatabase = String(process.env.MYSQL_DATABASE || localEnv.MYSQL_DATABASE || mysqlEnv.MYSQL_DATABASE || "").trim();
  const mysqlUser = String(
    process.env.MYSQL_USER || localEnv.MYSQL_USER || mysqlEnv.VECTORIZER_MYSQL_USER || mysqlEnv.MYSQL_USER || "",
  ).trim();
  const mysqlPassword = String(
    process.env.MYSQL_PASSWORD || localEnv.MYSQL_PASSWORD || mysqlEnv.VECTORIZER_MYSQL_PASSWORD || mysqlEnv.MYSQL_PASSWORD || "",
  ).trim();

  if (!fileServiceAuth) {
    throw new Error("Missing FILE_SERVICE_AUTH (or AUTH_BEARER_TOKEN in micro services/mservice-file/.env)");
  }
  if (!mysqlDatabase || !mysqlUser || !mysqlPassword) {
    throw new Error("Missing MySQL config (MYSQL_DATABASE, MYSQL_USER, MYSQL_PASSWORD)");
  }

  return {
    fileServiceUrl,
    fileServiceAuth,
    ollamaUrl,
    model,
    owner,
    largeFileBytes,
    chunkBytes,
    embedMaxInputChars,
    classifierEnabled,
    classifierModel,
    classifierTimeoutMs,
    verboseLogs,
    mysqlHost,
    mysqlPort,
    mysqlDatabase,
    mysqlUser,
    mysqlPassword,
  };
}

async function listSonjaFiles(config) {
  const pageSize = 500;
  let offset = 0;
  const all = [];
  while (true) {
    const url =
      `${config.fileServiceUrl}/file/records?owner=${encodeURIComponent(config.owner)}` +
      `&limit=${encodeURIComponent(String(pageSize))}&offset=${encodeURIComponent(String(offset))}`;
    const response = await fetchWithTimeout(url, {
      headers: { Authorization: config.fileServiceAuth, Accept: "application/json" },
    });
    const raw = await response.text();
    let parsed = {};
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = {};
    }
    if (!response.ok || !parsed.success) {
      throw new Error(parsed.message || raw || `Failed to list files (${response.status})`);
    }
    const page = Array.isArray(parsed.files) ? parsed.files : [];
    all.push(...page);
    if (page.length < pageSize) {
      break;
    }
    offset += page.length;
  }
  return all;
}

async function downloadFile(config, fileId) {
  const url = `${config.fileServiceUrl}/file/download?owner=${encodeURIComponent(config.owner)}&id=${encodeURIComponent(String(fileId))}`;
  const response = await fetchWithTimeout(url, {
    headers: { Authorization: config.fileServiceAuth },
  });
  if (!response.ok) {
    const raw = await response.text().catch(() => "");
    throw new Error(`download failed for file ${fileId} (${response.status}): ${raw}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  const contentType = response.headers.get("content-type") || "application/octet-stream";
  return { buffer: Buffer.from(arrayBuffer), contentType };
}

async function embedChunk(config, payload) {
  const startedAt = Date.now();
  const embedUrl = `${config.ollamaUrl}/api/embed`;
  const requestBody = {
    model: config.model,
    input: payload,
  };
  const response = await fetchWithTimeout(embedUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(requestBody),
  });
  const raw = await response.text();
  if (!response.ok) {
    if (response.status === 400 && /context length|input length exceeds/i.test(raw)) {
      throw new Error(
        `Ollama embed input too large for model context. Reduce CHUNK_BYTES/EMBED_MAX_INPUT_CHARS. Response: ${raw}`,
      );
    }
    throw new Error(`Ollama embed failed (${response.status}): ${raw}`);
  }
  let parsed = {};
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = {};
  }
  if (Array.isArray(parsed.embeddings) && Array.isArray(parsed.embeddings[0])) {
    if (config.verboseLogs) {
      console.log(`[vector] embed ok dim=${parsed.embeddings[0].length} elapsed=${Date.now() - startedAt}ms`);
    }
    return parsed.embeddings[0];
  }
  if (Array.isArray(parsed.embedding)) {
    if (config.verboseLogs) {
      console.log(`[vector] embed ok dim=${parsed.embedding.length} elapsed=${Date.now() - startedAt}ms`);
    }
    return parsed.embedding;
  }
  throw new Error("Ollama embed response missing embedding array");
}

async function ensureChunkTable(connection) {
  await connection.execute(
    `CREATE TABLE IF NOT EXISTS sonja_file_embedding_chunks (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      owner VARCHAR(32) NOT NULL DEFAULT 'sonja',
      file_id BIGINT UNSIGNED NOT NULL,
      chunk_index INT UNSIGNED NOT NULL,
      chunk_count INT UNSIGNED NOT NULL,
      chunk_size_bytes INT UNSIGNED NOT NULL,
      s3_key VARCHAR(1024) NULL,
      filename VARCHAR(512) NULL,
      content_type VARCHAR(255) NULL,
      summary LONGTEXT NULL,
      grade TINYINT UNSIGNED NULL,
      subject VARCHAR(128) NULL,
      educational TINYINT(1) NOT NULL DEFAULT 1,
      embedding_model VARCHAR(128) NOT NULL,
      embedding_dim INT UNSIGNED NOT NULL,
      embedding_json JSON NOT NULL,
      content_hash CHAR(64) NOT NULL,
      metadata_json JSON NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_owner_file_chunk_model (owner, file_id, chunk_index, embedding_model),
      KEY idx_owner_grade_subject_edu_chunk (owner, grade, subject, educational)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  );
}

async function upsertChunk(connection, row) {
  const startedAt = Date.now();
  await connection.execute(
    `INSERT INTO sonja_file_embedding_chunks (
      owner, file_id, chunk_index, chunk_count, chunk_size_bytes, s3_key, filename, content_type, summary,
      grade, subject, educational, embedding_model, embedding_dim, embedding_json, content_hash, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON), ?, CAST(? AS JSON))
    ON DUPLICATE KEY UPDATE
      chunk_count = VALUES(chunk_count),
      chunk_size_bytes = VALUES(chunk_size_bytes),
      s3_key = VALUES(s3_key),
      filename = VALUES(filename),
      content_type = VALUES(content_type),
      summary = VALUES(summary),
      grade = VALUES(grade),
      subject = VALUES(subject),
      educational = VALUES(educational),
      embedding_dim = VALUES(embedding_dim),
      embedding_json = VALUES(embedding_json),
      content_hash = VALUES(content_hash),
      metadata_json = VALUES(metadata_json),
      updated_at = CURRENT_TIMESTAMP`,
    [
      row.owner,
      row.fileId,
      row.chunkIndex,
      row.chunkCount,
      row.chunkSizeBytes,
      row.s3Key,
      row.filename,
      row.contentType,
      row.summary,
      row.grade,
      row.subject,
      row.educational,
      row.embeddingModel,
      row.embeddingDim,
      JSON.stringify(row.embedding),
      row.contentHash,
      JSON.stringify(row.metadata || {}),
    ],
  );
  if (row.verboseLogs) {
    console.log(
      `[sql] upsert file_id=${row.fileId} chunk=${row.chunkIndex}/${Math.max(0, row.chunkCount - 1)} subject=${row.subject} grade=${row.grade ?? "null"} educational=${row.educational} elapsed=${Date.now() - startedAt}ms`,
    );
  }
}

async function updateChunkMetadataOnly(connection, row) {
  const startedAt = Date.now();
  await connection.execute(
    `UPDATE sonja_file_embedding_chunks
     SET
      chunk_count = ?,
      chunk_size_bytes = ?,
      s3_key = ?,
      filename = ?,
      content_type = ?,
      summary = ?,
      grade = ?,
      subject = ?,
      educational = ?,
      content_hash = ?,
      metadata_json = CAST(? AS JSON),
      updated_at = CURRENT_TIMESTAMP
     WHERE owner = ? AND file_id = ? AND chunk_index = ? AND embedding_model = ?`,
    [
      row.chunkCount,
      row.chunkSizeBytes,
      row.s3Key,
      row.filename,
      row.contentType,
      row.summary,
      row.grade,
      row.subject,
      row.educational,
      row.contentHash,
      JSON.stringify(row.metadata || {}),
      row.owner,
      row.fileId,
      row.chunkIndex,
      row.embeddingModel,
    ],
  );
  if (row.verboseLogs) {
    console.log(
      `[sql] metadata-update file_id=${row.fileId} chunk=${row.chunkIndex}/${Math.max(0, row.chunkCount - 1)} hash=${String(row.contentHash || "").slice(0, 12)} elapsed=${Date.now() - startedAt}ms`,
    );
  }
}

async function loadExistingChunkIndex(connection, owner, fileId, embeddingModel) {
  const [rows] = await connection.execute(
    `SELECT chunk_index, content_hash
     FROM sonja_file_embedding_chunks
     WHERE owner = ? AND file_id = ? AND embedding_model = ?`,
    [owner, fileId, embeddingModel],
  );
  const map = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const chunkIndex = Number(row.chunk_index);
    const contentHash = String(row.content_hash || "").trim().toLowerCase();
    if (!Number.isFinite(chunkIndex) || chunkIndex < 0) {
      continue;
    }
    if (!contentHash) {
      continue;
    }
    map.set(Math.floor(chunkIndex), contentHash);
  }
  return map;
}

async function deleteStaleChunks(connection, owner, fileId, embeddingModel, chunkCount) {
  await connection.execute(
    `DELETE FROM sonja_file_embedding_chunks
     WHERE owner = ? AND file_id = ? AND embedding_model = ? AND chunk_index >= ?`,
    [owner, fileId, embeddingModel, chunkCount],
  );
}

async function backfillChunkMetadata(connection, owner, classifierCtx) {
  const pageSize = 1000;
  let offset = 0;
  let processed = 0;
  let updated = 0;
  let unchanged = 0;
  const startedAt = Date.now();
  const [countRows] = await connection.query(
    "SELECT COUNT(*) AS total FROM sonja_file_embedding_chunks WHERE owner = ?",
    [String(owner || "sonja")],
  );
  const totalRows = Number(Array.isArray(countRows) && countRows[0] ? countRows[0].total : 0) || 0;
  const progressEvery = 100;

  function logProgress(force = false) {
    if (!force && (processed === 0 || processed % progressEvery !== 0)) {
      return;
    }
    const elapsedSec = Math.max(1, Math.floor((Date.now() - startedAt) / 1000));
    const rate = (processed / elapsedSec).toFixed(1);
    const pct = totalRows > 0 ? ((processed / totalRows) * 100).toFixed(1) : "0.0";
    console.log(
      `[metadata] processed=${processed}/${totalRows} (${pct}%) updated=${updated} unchanged=${unchanged} rate=${rate}/s`,
    );
  }

  console.log(`[metadata] total rows to inspect: ${totalRows}`);
  while (true) {
    const safePageSize = Math.max(1, Math.floor(pageSize));
    const safeOffset = Math.max(0, Math.floor(offset));
    const safeOwner = String(owner || "sonja");
    const escapedOwner = safeOwner.replace(/\\/g, "\\\\").replace(/'/g, "''");
    const [rows] = await connection.query(
      `SELECT id, summary, filename, grade, subject, educational
       FROM sonja_file_embedding_chunks
       WHERE owner = '${escapedOwner}'
       ORDER BY id ASC
       LIMIT ${safePageSize} OFFSET ${safeOffset}`,
    );
    const list = Array.isArray(rows) ? rows : [];
    if (list.length === 0) {
      break;
    }
    for (const row of list) {
      const id = Number(row.id);
      if (!Number.isFinite(id) || id <= 0) {
        continue;
      }
      const summary = String(row.summary || "");
      const filename = String(row.filename || "");
      const classified = await classifyMetadata(summary, filename, classifierCtx);
      const prevGrade = row.grade === null || row.grade === undefined ? null : Number(row.grade);
      const prevSubject = String(row.subject || "unknown");
      const prevEducational = row.educational === null || row.educational === undefined ? 0 : Number(row.educational);
      const gradeChanged = prevGrade !== classified.grade;
      const subjectChanged = prevSubject !== classified.subject;
      const educationalChanged = prevEducational !== classified.educational;
      if (gradeChanged || subjectChanged || educationalChanged) {
        await connection.execute(
          `UPDATE sonja_file_embedding_chunks
           SET grade = ?, subject = ?, educational = ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [classified.grade, classified.subject, classified.educational, id],
        );
        updated += 1;
      } else {
        unchanged += 1;
      }
      processed += 1;
      logProgress(false);
    }
    offset += list.length;
  }
  logProgress(true);
  const elapsedSec = Math.max(1, Math.floor((Date.now() - startedAt) / 1000));
  return { totalRows, processed, updated, unchanged, elapsedSec };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const config = await resolveConfig();
  console.log(`File service: ${config.fileServiceUrl}`);
  console.log(`Ollama: ${config.ollamaUrl} model=${config.model}`);
  console.log(`Owner: ${config.owner}`);
  console.log(`Chunk rule: >${config.largeFileBytes} bytes -> ${config.chunkBytes} byte chunks`);
  console.log(`Embed max input chars: ${config.embedMaxInputChars}`);
  console.log(`Metadata classifier: ${config.classifierEnabled ? "enabled" : "disabled"}`);
  if (config.classifierEnabled) {
    console.log(`Classifier model: ${config.classifierModel} timeout=${config.classifierTimeoutMs}ms`);
  }
  console.log(`Verbose logs: ${config.verboseLogs ? "enabled" : "disabled"}`);

  const files = await listSonjaFiles(config);
  const selected = options.limit > 0 ? files.slice(0, options.limit) : files;
  console.log(`Found ${files.length} files, processing ${selected.length}.`);

  const connection = await mysql.createConnection({
    host: config.mysqlHost,
    port: config.mysqlPort,
    user: config.mysqlUser,
    password: config.mysqlPassword,
    database: config.mysqlDatabase,
    charset: "utf8mb4",
  });

  try {
    await ensureChunkTable(connection);
    const classifierCtx = await createClassifierContext(config);
    if (options.metadataOnly) {
      console.log("Running metadata-only reclassification...");
      const stats = await backfillChunkMetadata(connection, config.owner, classifierCtx);
      console.log(
        `Done. Processed=${stats.processed}/${stats.totalRows}, updated=${stats.updated}, unchanged=${stats.unchanged}, elapsed=${stats.elapsedSec}s.`,
      );
      return;
    }
    let processedFiles = 0;
    let embeddedChunks = 0;
    let skippedChunks = 0;

    for (let i = 0; i < selected.length; i += 1) {
      const file = selected[i] || {};
      const fileId = Number(file.id);
      if (!Number.isFinite(fileId) || fileId <= 0) {
        continue;
      }
      const filename = String(file.filename || `file-${fileId}`);
      const summary = String(file.summary || "");
      const s3Key = file.s3_key ? String(file.s3_key) : null;
      const baseContentType = String(file.content_type || "application/octet-stream");

      console.log(`[${i + 1}/${selected.length}] ${filename} (id=${fileId})`);
      const downloaded = await downloadFile(config, fileId);
      const payloadBuffer = downloaded.buffer;
      const contentType = downloaded.contentType || baseContentType;
      const maxBytesByContext = Math.max(1024, Math.floor((config.embedMaxInputChars - 512) * 0.75));
      const effectiveChunkBytes = Math.max(1024, Math.min(config.chunkBytes, maxBytesByContext));
      const shouldChunk = payloadBuffer.length > Math.min(config.largeFileBytes, effectiveChunkBytes);
      const chunks = shouldChunk ? splitBuffer(payloadBuffer, effectiveChunkBytes) : [payloadBuffer];
      const existingByChunk = await loadExistingChunkIndex(connection, config.owner, fileId, config.model);
      const chunkHashes = chunks.map((chunk) => createHash("sha256").update(chunk).digest("hex"));

      // Fast path: if every chunk hash already matches, skip file completely (no classifier/LLM call).
      const fileFullyUnchanged =
        existingByChunk.size === chunks.length &&
        chunkHashes.every((hash, idx) => existingByChunk.get(idx) === hash.toLowerCase());
      if (fileFullyUnchanged) {
        if (config.verboseLogs) {
          console.log(`[skip] unchanged file_id=${fileId} chunks=${chunks.length} (classifier/vector/sql skipped)`);
        }
        skippedChunks += chunks.length;
        processedFiles += 1;
        continue;
      }

      const classified = await classifyMetadata(summary, filename, classifierCtx);
      if (config.verboseLogs) {
        console.log(
          `[classify] effective file_id=${fileId} grade=${classified.grade ?? "null"} subject=${classified.subject} educational=${classified.educational}`,
        );
      }

      for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
        const chunk = chunks[chunkIndex];
        const contentHash = chunkHashes[chunkIndex];
        const metadataPayload = {
          owner: config.owner,
          fileId,
          chunkIndex,
          chunkCount: chunks.length,
          chunkSizeBytes: chunk.length,
          s3Key,
          filename,
          contentType,
          summary,
          grade: classified.grade,
          subject: classified.subject,
          educational: classified.educational,
          embeddingModel: config.model,
          contentHash,
          metadata: {
            source: "sonja-file-vectorizer",
            chunking_rule: {
              large_file_bytes: config.largeFileBytes,
              chunk_bytes: config.chunkBytes,
            },
          },
          verboseLogs: config.verboseLogs,
        };
        const existingHash = existingByChunk.get(chunkIndex);
        if (existingHash && existingHash === contentHash.toLowerCase()) {
          if (!options.dryRun) {
            await updateChunkMetadataOnly(connection, metadataPayload);
          }
          if (config.verboseLogs) {
            console.log(
              `[vector] skip-embed file_id=${fileId} chunk=${chunkIndex}/${Math.max(0, chunks.length - 1)} reason=hash-match`,
            );
          }
          skippedChunks += 1;
          continue;
        }
        const chunkText = [
          `owner=${config.owner}`,
          `file_id=${fileId}`,
          `filename=${filename}`,
          `content_type=${contentType}`,
          `chunk_index=${chunkIndex}`,
          `chunk_count=${chunks.length}`,
          `encoding=base64`,
          `data=${chunk.toString("base64")}`,
        ].join("\n");
        const embedding = await embedChunk(config, chunkText);
        if (!Array.isArray(embedding) || embedding.length === 0) {
          throw new Error(`empty embedding for file_id=${fileId} chunk=${chunkIndex}`);
        }
        if (!options.dryRun) {
          await upsertChunk(connection, {
            ...metadataPayload,
            embeddingDim: embedding.length,
            embedding,
          });
        }
        if (config.verboseLogs) {
          console.log(
            `[vector] stored file_id=${fileId} chunk=${chunkIndex}/${Math.max(0, chunks.length - 1)} dim=${embedding.length}`,
          );
        }
        embeddedChunks += 1;
      }
      if (!options.dryRun) {
        await deleteStaleChunks(connection, config.owner, fileId, config.model, chunks.length);
      }
      processedFiles += 1;
    }

    console.log(
      options.dryRun
        ? `Dry run complete. Processed files=${processedFiles}, chunks embedded=${embeddedChunks}, chunks skipped=${skippedChunks}, db writes skipped.`
        : `Done. Processed files=${processedFiles}, chunks embedded=${embeddedChunks}, chunks skipped=${skippedChunks}.`,
    );
  } finally {
    await connection.end();
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`ERROR: ${message}`);
  process.exit(1);
});
