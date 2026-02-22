#!/usr/bin/env node
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import mysql from "mysql2/promise";

const KNOWN_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".bmp",
  ".tif",
  ".tiff",
  ".pdf",
  ".doc",
  ".docx",
]);

const IGNORED_EXTENSIONS = new Set([".xls", ".xlsx"]);

const MIME_BY_EXT = new Map([
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"],
  [".bmp", "image/bmp"],
  [".tif", "image/tiff"],
  [".tiff", "image/tiff"],
  [".pdf", "application/pdf"],
  [".doc", "application/msword"],
  [".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
]);

const POLL_INTERVAL_MS = 2000;
const FILE_WAIT_TIMEOUT_MS = 10 * 60 * 1000;
const HTTP_TIMEOUT_MS = 60 * 1000;
const PENDING_LOG_INTERVAL_MS = 30 * 1000;
const DEFAULT_BASE_HOST = "192.168.55.113";
const LEGACY_BASE_HOST = "192.168.55.73";
const DEFAULT_OLLAMA_URL = `http://${DEFAULT_BASE_HOST}:11434`;
const DEFAULT_OLLAMA_MODEL = "qwen3-embedding";
const DEFAULT_LARGE_FILE_BYTES = 1024 * 1024;
const DEFAULT_CHUNK_BYTES = 250 * 1024;

function printUsage() {
  console.log("Usage: node src/index.mjs <absolute-path> [limit=1] [Sonja] [recursive=true|false]");
  console.log("       Use limit=0 to process all discovered files.");
  console.log("Example (me): node src/index.mjs \"E:\\\\Photos\\\\Batch\" 20");
  console.log("Example (all): node src/index.mjs \"E:\\\\Photos\\\\Batch\" 0");
  console.log("Example (sonja): node src/index.mjs \"E:\\\\Photos\\\\Batch\" 20 Sonja");
  console.log("Example (recursive): node src/index.mjs \"E:\\\\Photos\\\\Batch\" 0 Sonja true");
}

function normalizeOwner(value) {
  const v = String(value || "").trim().toLowerCase();
  return v === "sonja" ? "sonja" : "me";
}

function ensureUrl(value, fallbackPath = "") {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  if (!fallbackPath) {
    return withScheme;
  }
  if (withScheme.toLowerCase().endsWith(fallbackPath.toLowerCase())) {
    return withScheme;
  }
  return `${withScheme.replace(/\/+$/, "")}${fallbackPath}`;
}

function normalizeLegacyHost(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return raw;
  }
  return raw
    .split(LEGACY_BASE_HOST)
    .join(DEFAULT_BASE_HOST)
    .replace(/(^|[/:])localhost(?=[:/]|$)/gi, `$1${DEFAULT_BASE_HOST}`)
    .replace(/(^|[/:])127\.0\.0\.1(?=[:/]|$)/g, `$1${DEFAULT_BASE_HOST}`);
}

function parseEnvFile(content) {
  const out = {};
  const lines = String(content || "").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const idx = trimmed.indexOf("=");
    if (idx < 0) {
      continue;
    }
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    out[key] = value;
  }
  return out;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function trimQuotes(value) {
  const raw = String(value || "").trim();
  if ((raw.startsWith("\"") && raw.endsWith("\"")) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  return raw;
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
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isValidGrade(value) {
  return Number.isFinite(value) && value >= 0 && value <= 12;
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
  { key: "math", patterns: [/\bmath\b/, /\bmaths\b/, /\bmathematics\b/, /\bwiskunde\b/, /\boptel\b/, /\baftrek\b/] },
  { key: "afrikaans", patterns: [/\bafrikaans\b/, /\bafr\b/] },
  { key: "english", patterns: [/\benglish\b/, /\beng\b/] },
  { key: "science", patterns: [/\bscience\b/, /\bnatuurwetenskap\b/, /\bnatural sciences\b/, /\bnst\b/] },
];

function detectSubject(summary, filename) {
  const value = normalizeClassifierText(`${filename} ${summary}`);
  if (!value) {
    return "unknown";
  }
  let best = "unknown";
  let bestScore = 0;
  for (const rule of SUBJECT_RULES) {
    let score = 0;
    for (const pattern of rule.patterns) {
      if (pattern.test(value)) {
        score += 1;
      }
    }
    if (score > bestScore) {
      best = rule.key;
      bestScore = score;
    }
  }
  return best;
}

function parseEducational(summary, filename, grade, subject) {
  const value = normalizeClassifierText(`${summary} ${filename}`);
  if (
    /\bbank statement\b|\bcredit facility\b|\bquotation\b|\binvoice\b|\bproof of payment\b|\bid document\b/.test(value)
  ) {
    return 0;
  }
  if (
    /\bworksheet\b|\bworkbook\b|\blesson\b|\bactivity\b|\bassessment\b|\btoets\b|\boefening\b|\bbegripslees\b/.test(value)
  ) {
    return 1;
  }
  return grade !== null || subject !== "unknown" ? 1 : 0;
}

async function ensureVectorChunkTable(connection) {
  await connection.execute(
    `CREATE TABLE IF NOT EXISTS sonja_file_embedding_chunks (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      owner VARCHAR(64) NOT NULL,
      file_id BIGINT UNSIGNED NOT NULL,
      chunk_index INT UNSIGNED NOT NULL,
      chunk_count INT UNSIGNED NOT NULL,
      chunk_size_bytes INT UNSIGNED NOT NULL,
      s3_key VARCHAR(1024) NULL,
      filename VARCHAR(512) NULL,
      content_type VARCHAR(255) NULL,
      summary LONGTEXT NULL,
      grade TINYINT UNSIGNED NULL,
      subject VARCHAR(64) NOT NULL DEFAULT 'unknown',
      educational TINYINT(1) NOT NULL DEFAULT 0,
      embedding_model VARCHAR(128) NOT NULL,
      embedding_dim INT UNSIGNED NOT NULL,
      embedding_json JSON NOT NULL,
      content_hash CHAR(64) NOT NULL,
      metadata_json JSON NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_owner_file_chunk_model (owner, file_id, chunk_index, embedding_model),
      KEY idx_owner_file (owner, file_id),
      KEY idx_owner_grade_subject (owner, grade, subject),
      KEY idx_owner_educational (owner, educational)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  );
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
    map.set(Number(row.chunk_index), String(row.content_hash || "").toLowerCase());
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

async function upsertChunk(connection, row) {
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
}

async function updateChunkMetadataOnly(connection, row) {
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
}

async function embedChunk(ollamaUrl, model, payload) {
  const response = await fetchWithTimeout(`${ollamaUrl}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ model, input: payload }),
  });
  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`Ollama embed failed (${response.status}): ${raw}`);
  }
  const parsed = JSON.parse(raw);
  if (Array.isArray(parsed.embeddings) && Array.isArray(parsed.embeddings[0])) {
    return parsed.embeddings[0];
  }
  if (Array.isArray(parsed.embedding)) {
    return parsed.embedding;
  }
  throw new Error("Ollama embed response missing embedding array");
}

async function downloadFileById(fileBaseUrl, statusAuth, owner, fileId) {
  const url = `${fileBaseUrl}/file/download?owner=${encodeURIComponent(owner)}&id=${encodeURIComponent(String(fileId))}`;
  const response = await fetchWithTimeout(url, {
    headers: { Authorization: statusAuth },
  });
  if (!response.ok) {
    const raw = await response.text().catch(() => "");
    throw new Error(`download failed for file ${fileId} (${response.status}): ${raw}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  const contentType = response.headers.get("content-type") || "application/octet-stream";
  return { buffer: Buffer.from(arrayBuffer), contentType };
}

async function vectorizeUploadedFile({
  connection,
  fileBaseUrl,
  statusAuth,
  owner,
  fileId,
  s3Key,
  filename,
  contentType,
  summary,
  model,
  ollamaUrl,
  largeFileBytes,
  chunkBytes,
}) {
  const downloaded = await downloadFileById(fileBaseUrl, statusAuth, owner, fileId);
  const payloadBuffer = downloaded.buffer;
  const resolvedContentType = downloaded.contentType || contentType || "application/octet-stream";
  const grade = detectGrade(summary, filename);
  const subject = detectSubject(summary, filename);
  const educational = parseEducational(summary, filename, grade, subject);
  const chunks = payloadBuffer.length > largeFileBytes ? splitBuffer(payloadBuffer, chunkBytes) : [payloadBuffer];
  const existingByChunk = await loadExistingChunkIndex(connection, owner, fileId, model);

  let embedded = 0;
  let skipped = 0;
  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
    const chunk = chunks[chunkIndex];
    const contentHash = createHash("sha256").update(chunk).digest("hex");
    const row = {
      owner,
      fileId,
      chunkIndex,
      chunkCount: chunks.length,
      chunkSizeBytes: chunk.length,
      s3Key,
      filename,
      contentType: resolvedContentType,
      summary,
      grade,
      subject,
      educational,
      embeddingModel: model,
      contentHash,
      metadata: {
        source: "mservice-file-bulk-uploader",
        chunking_rule: {
          large_file_bytes: largeFileBytes,
          chunk_bytes: chunkBytes,
        },
      },
    };
    const existingHash = existingByChunk.get(chunkIndex);
    if (existingHash && existingHash === contentHash.toLowerCase()) {
      await updateChunkMetadataOnly(connection, row);
      skipped += 1;
      continue;
    }
    const chunkText = [
      `owner=${owner}`,
      `file_id=${fileId}`,
      `filename=${filename}`,
      `content_type=${resolvedContentType}`,
      `chunk_index=${chunkIndex}`,
      `chunk_count=${chunks.length}`,
      `encoding=base64`,
      `data=${chunk.toString("base64")}`,
    ].join("\n");
    const embedding = await embedChunk(ollamaUrl, model, chunkText);
    await upsertChunk(connection, {
      ...row,
      embedding,
      embeddingDim: embedding.length,
    });
    embedded += 1;
  }
  await deleteStaleChunks(connection, owner, fileId, model, chunks.length);
  return { embedded, skipped, chunkCount: chunks.length };
}

function parseRecursiveFlag(value) {
  const raw = String(value || "").trim().toLowerCase();
  return raw === "true" || raw === "1" || raw === "yes" || raw === "y";
}

async function collectFiles(rootDir, recursive) {
  const results = [];
  const maxDepth = recursive ? 3 : 0;
  const stack = [{ dir: rootDir, depth: 0 }];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    const { dir, depth } = current;
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < maxDepth) {
          stack.push({ dir: fullPath, depth: depth + 1 });
        }
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const ext = path.extname(entry.name).toLowerCase();
      if (IGNORED_EXTENSIONS.has(ext)) {
        continue;
      }
      if (!KNOWN_EXTENSIONS.has(ext)) {
        continue;
      }
      results.push(fullPath);
    }
  }
  results.sort((a, b) => a.localeCompare(b));
  return results;
}

function inferMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_BY_EXT.get(ext) || "application/octet-stream";
}

async function uploadViaAssistant(uploadUrl, owner, filePath) {
  const filename = path.basename(filePath);
  const mimeType = inferMimeType(filePath);
  const fileBuffer = await fs.readFile(filePath);
  const response = await fetchWithTimeout(uploadUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      owner,
      filename,
      mimeType,
      dataBase64: fileBuffer.toString("base64"),
      caption: "",
    }),
  }, HTTP_TIMEOUT_MS);
  const rawText = await response.text();
  let parsed = {};
  try {
    parsed = JSON.parse(rawText);
  } catch {
    parsed = {};
  }
  if (!response.ok || !parsed.success) {
    const reason = parsed.message || rawText || `HTTP ${response.status}`;
    throw new Error(`upload failed for ${filename}: ${reason}`);
  }
  return {
    fileId: Number.isFinite(Number(parsed.file_id)) ? Number(parsed.file_id) : null,
    key: typeof parsed.key === "string" ? parsed.key.trim() : "",
    summary: typeof parsed.summary === "string" ? parsed.summary.trim() : "",
    summaryStatus: typeof parsed.summary_status === "string" ? parsed.summary_status.trim().toLowerCase() : "",
    summaryAsync: Boolean(parsed.summary_async),
    duplicate: Boolean(parsed.duplicate),
  };
}

async function pollFileCompletion(statusUrl, authHeader, owner, fileId, key, display) {
  const started = Date.now();
  let nextPendingLogAt = started + PENDING_LOG_INTERVAL_MS;
  let notFoundCount = 0;
  while (Date.now() - started <= FILE_WAIT_TIMEOUT_MS) {
    const params = new URLSearchParams();
    params.set("owner", owner);
    if (fileId && fileId > 0) {
      params.set("id", String(fileId));
    } else if (key) {
      params.set("key", key);
    }
    const response = await fetchWithTimeout(`${statusUrl}?${params.toString()}`, {
      headers: authHeader ? { Authorization: authHeader } : {},
    }, HTTP_TIMEOUT_MS);

    if (response.status === 404) {
      notFoundCount += 1;
      // Skipped files are deleted from DB/S3 in current server behavior.
      // Treat repeated 404s as terminal instead of polling forever.
      if (notFoundCount >= 3) {
        return {
          status: "deleted",
          error: "status record removed",
          filename: "",
          contentType: "",
        };
      }
      await sleep(POLL_INTERVAL_MS);
      continue;
    }
    notFoundCount = 0;

    const raw = await response.text();
    let parsed = {};
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = {};
    }

    if (!response.ok || !parsed.success || !parsed.file) {
      const detail = parsed.message || raw || `HTTP ${response.status}`;
      throw new Error(`status check failed: ${detail}`);
    }

    const status = String(parsed.file.summary_status || "").trim().toLowerCase();
    if (!status || status === "pending") {
      if (Date.now() >= nextPendingLogAt) {
        const elapsedSec = Math.floor((Date.now() - started) / 1000);
        console.log(`Waiting on summary for ${display || key || fileId || "file"} (${elapsedSec}s elapsed, status=pending)...`);
        nextPendingLogAt = Date.now() + PENDING_LOG_INTERVAL_MS;
      }
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    return {
      status,
      error: String(parsed.file.summary_error || "").trim(),
      summary: String(parsed.file.summary || "").trim(),
      filename: String(parsed.file.filename || ""),
      contentType: String(parsed.file.content_type || "").trim().toLowerCase(),
    };
  }

  throw new Error(`timed out waiting for file completion after ${FILE_WAIT_TIMEOUT_MS}ms`);
}

function isNonFatalSummaryFailure(detail) {
  const text = String(detail || "").toLowerCase();
  return (
    text.includes("summary service response could not be parsed") ||
    text.includes("summary service returned an empty response") ||
    text.includes("unsupported encryption algorithm") ||
    (text.includes("unsupported") && text.includes("encryption")) ||
    (text.includes("encrypted") && text.includes("pdf")) ||
    text.includes("pdf extraction timed out")
  );
}

async function cancelSummaryJob(cancelUrl, authHeader, owner, fileId, key) {
  if (!cancelUrl) {
    return;
  }
  if ((!fileId || fileId <= 0) && !key) {
    return;
  }
  const payload = { owner };
  if (fileId && fileId > 0) {
    payload.id = fileId;
  } else if (key) {
    payload.key = key;
  }
  try {
    const response = await fetchWithTimeout(cancelUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(authHeader ? { Authorization: authHeader } : {}),
      },
      body: JSON.stringify(payload),
    }, HTTP_TIMEOUT_MS);
    const raw = await response.text();
    if (!response.ok) {
      console.warn(`Cancel summary request failed (${response.status}): ${raw || "no response body"}`);
      return;
    }
    console.log(`Canceled active summary job for file_id=${fileId || "unknown"} key=${key || "unknown"}.`);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(`Cancel summary request failed: ${msg}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    printUsage();
    process.exit(1);
  }

  const absoluteRoot = String(args[0] || "").trim();
  if (!path.isAbsolute(absoluteRoot)) {
    throw new Error("first parameter must be an absolute path");
  }

  const requestedLimit = Number.parseInt(String(args[1] || "1"), 10);
  const limit = Number.isFinite(requestedLimit) && requestedLimit >= 0 ? requestedLimit : 1;
  const owner = normalizeOwner(args[2]);
  const recursive = parseRecursiveFlag(args[3]);

  const stat = await fs.stat(absoluteRoot).catch(() => null);
  if (!stat || !stat.isDirectory()) {
    throw new Error(`path does not exist or is not a directory: ${absoluteRoot}`);
  }

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const aiEnvPath = path.resolve(__dirname, "..", "..", "ai-assistant", ".env");
  const mysqlEnvPath = path.resolve(__dirname, "..", "..", "..", "servers", "mysql-docker", ".env");
  const envContent = await fs.readFile(aiEnvPath, "utf8");
  const env = parseEnvFile(envContent);
  const mysqlEnvContent = await fs.readFile(mysqlEnvPath, "utf8").catch(() => "");
  const mysqlEnv = parseEnvFile(mysqlEnvContent);

  const baseHost = normalizeLegacyHost(String(env.BASE_URL || DEFAULT_BASE_HOST).trim() || DEFAULT_BASE_HOST);
  const uploadUrl = ensureUrl(
    normalizeLegacyHost(env.AI_ASSISTANT_UI_UPLOAD_URL || `http://${baseHost}:8599/upload-file`),
  );
  const fileUploadUrl = ensureUrl(
    normalizeLegacyHost(env.FILE_MICRO_SERVICE_URL || `http://${baseHost}:3224/file/upload`),
    "/file/upload",
  );
  const statusUrl = fileUploadUrl ? fileUploadUrl.replace(/\/file\/upload$/i, "/file/status") : "";
  const cancelSummaryUrl = fileUploadUrl ? fileUploadUrl.replace(/\/file\/upload$/i, "/file/cancel-summary") : "";
  const fileBaseUrl = fileUploadUrl ? fileUploadUrl.replace(/\/file\/upload$/i, "") : "";
  const statusAuth = String(env.FILE_MICRO_SERVICE_AUTH || "").trim() ||
    (String(env.WEBHOOK_BEARER_TOKEN || "").trim() ? `Bearer ${String(env.WEBHOOK_BEARER_TOKEN || "").trim()}` : "");
  const vectorEnabled = !["0", "false", "no"].includes(String(trimQuotes(env.BULK_UPLOADER_VECTORIZATION_ENABLED || "true")).toLowerCase());
  const ollamaUrl = ensureUrl(trimQuotes(normalizeLegacyHost(env.OLLAMA_URL || DEFAULT_OLLAMA_URL)));
  const ollamaModel = trimQuotes(env.OLLAMA_MODEL || DEFAULT_OLLAMA_MODEL) || DEFAULT_OLLAMA_MODEL;
  const largeFileBytes = toInt(trimQuotes(env.LARGE_FILE_BYTES), DEFAULT_LARGE_FILE_BYTES);
  const chunkBytes = toInt(trimQuotes(env.CHUNK_BYTES), DEFAULT_CHUNK_BYTES);
  const mysqlHostRaw = trimQuotes(env.MYSQL_HOST || mysqlEnv.VECTORIZER_MYSQL_HOST || mysqlEnv.MYSQL_HOST || "127.0.0.1");
  const mysqlHost = mysqlHostRaw === "%" ? "127.0.0.1" : mysqlHostRaw;
  const mysqlPort = toInt(trimQuotes(env.MYSQL_PORT || mysqlEnv.MYSQL_PORT), 3306);
  const mysqlDatabase = trimQuotes(env.MYSQL_DATABASE || mysqlEnv.MYSQL_DATABASE || "");
  const mysqlUser = trimQuotes(env.MYSQL_USER || mysqlEnv.VECTORIZER_MYSQL_USER || mysqlEnv.MYSQL_USER || "");
  const mysqlPassword = trimQuotes(env.MYSQL_PASSWORD || mysqlEnv.VECTORIZER_MYSQL_PASSWORD || mysqlEnv.MYSQL_PASSWORD || "");

  if (!uploadUrl) {
    throw new Error("unable to resolve AI assistant upload URL");
  }
  if (!statusUrl) {
    throw new Error("unable to resolve file status URL from FILE_MICRO_SERVICE_URL");
  }
  if (!statusAuth) {
    throw new Error("FILE_MICRO_SERVICE_AUTH or WEBHOOK_BEARER_TOKEN is required for status polling");
  }

  const discovered = await collectFiles(absoluteRoot, recursive);
  if (discovered.length === 0) {
    console.log("No supported files found (.jpg/.jpeg/.png/.webp/.bmp/.tif/.tiff/.pdf/.doc/.docx).");
    return;
  }

  const selected = limit === 0 ? discovered : discovered.slice(0, limit);
  console.log(`Owner: ${owner}`);
  console.log(`Recursive: ${recursive ? "true (max depth 3)" : "false (root only)"}`);
  console.log(`Upload endpoint: ${uploadUrl}`);
  console.log(`Status endpoint: ${statusUrl}`);
  console.log(`Cancel endpoint: ${cancelSummaryUrl}`);
  console.log(`Vectorization: ${vectorEnabled ? "enabled" : "disabled"}`);
  if (vectorEnabled) {
    console.log(`Ollama: ${ollamaUrl} model=${ollamaModel}`);
  }
  console.log(`Found ${discovered.length} supported files, processing ${selected.length}.`);

  if (vectorEnabled && (!mysqlDatabase || !mysqlUser || !mysqlPassword)) {
    throw new Error("vectorization enabled but MySQL config is missing (MYSQL_DATABASE, MYSQL_USER, MYSQL_PASSWORD)");
  }

  let vectorConnection = null;
  try {
    if (vectorEnabled) {
      vectorConnection = await mysql.createConnection({
        host: mysqlHost,
        port: mysqlPort,
        user: mysqlUser,
        password: mysqlPassword,
        database: mysqlDatabase,
        charset: "utf8mb4",
      });
      await ensureVectorChunkTable(vectorConnection);
    }

    let successCount = 0;
    let failedCount = 0;
    let stopRequested = false;
    let currentUpload = null;
    const onInterrupt = async () => {
      if (stopRequested) {
        return;
      }
      stopRequested = true;
      console.log("\nCancel requested. Stopping after current operation...");
      if (currentUpload && (currentUpload.fileId || currentUpload.key)) {
        await cancelSummaryJob(
          cancelSummaryUrl,
          statusAuth,
          currentUpload.owner,
          currentUpload.fileId,
          currentUpload.key,
        );
      }
    };
    process.on("SIGINT", () => {
      void onInterrupt();
    });

    for (let i = 0; i < selected.length; i += 1) {
      if (stopRequested) {
        console.log("\nStopped by user.");
        break;
      }
      const fullPath = selected[i];
      const display = path.basename(fullPath);
      console.log(`\n[${i + 1}/${selected.length}] Uploading ${display}`);
      try {
        const uploaded = await uploadViaAssistant(uploadUrl, owner, fullPath);
        currentUpload = {
          owner,
          fileId: uploaded.fileId,
          key: uploaded.key,
          display,
        };
        console.log(`Uploaded ${display} -> file_id=${uploaded.fileId ?? "unknown"}`);
        if (uploaded.duplicate) {
          console.log(`Detected duplicate record for ${display}.`);
        }

        let finalStatus = uploaded.summaryStatus || "";
        let finalSummary = uploaded.summary || "";
        let finalFilename = display;
        let finalContentType = inferMimeType(display);
        let canVectorize = uploaded.fileId && uploaded.fileId > 0;

        if (!uploaded.summaryAsync && uploaded.summaryStatus && uploaded.summaryStatus !== "pending") {
          // already finalized in upload response
        } else if (!uploaded.summaryAsync && uploaded.summaryStatus === "pending") {
          console.log(`Skipping ${display}: status is pending but no async summary job was started.`);
        } else {
          const status = await pollFileCompletion(statusUrl, statusAuth, owner, uploaded.fileId, uploaded.key, display);
          finalStatus = status.status;
          finalSummary = status.summary || "";
          finalFilename = status.filename || finalFilename;
          finalContentType = status.contentType || finalContentType;

          if (status.status === "failed") {
            if (isNonFatalSummaryFailure(status.error)) {
              console.log(`Skipped ${display} due to non-fatal summary issue: ${status.error}`);
            } else {
              throw new Error(`processing failed for ${display}: ${status.error || "unknown error"}`);
            }
          }
          if (status.status === "deleted") {
            canVectorize = false;
          }
        }

        console.log(`Completed ${display} (status=${finalStatus || "unknown"})`);
        console.log(`Summary ${display}: ${finalSummary || "(no summary)"}`);

        if (vectorEnabled) {
          if (!canVectorize) {
            console.log(`Vectorization skipped for ${display}: missing file_id or record deleted.`);
          } else {
            const vectorized = await vectorizeUploadedFile({
              connection: vectorConnection,
              fileBaseUrl,
              statusAuth,
              owner,
              fileId: uploaded.fileId,
              s3Key: uploaded.key,
              filename: finalFilename || display,
              contentType: finalContentType || inferMimeType(display),
              summary: finalSummary || uploaded.summary || "",
              model: ollamaModel,
              ollamaUrl,
              largeFileBytes,
              chunkBytes,
            });
            console.log(
              `Vectorized ${display}: chunks=${vectorized.chunkCount}, embedded=${vectorized.embedded}, skipped=${vectorized.skipped}.`,
            );
          }
        }

        successCount += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`ERROR: ${message}`);
        failedCount += 1;
      } finally {
        currentUpload = null;
      }
    }

    console.log(`\nDone. Successfully processed ${successCount}/${selected.length}. Failed ${failedCount}.`);
    process.exit(failedCount > 0 ? 1 : 0);
  } finally {
    if (vectorConnection) {
      await vectorConnection.end();
    }
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`ERROR: ${message}`);
  process.exit(1);
});
