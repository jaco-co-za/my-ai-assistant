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
const HTTP_TIMEOUT_MS = 120_000;

function usage() {
  console.log("Usage: node src/index.mjs [--limit N] [--dry-run]");
  console.log("");
  console.log("Env:");
  console.log("  FILE_SERVICE_URL       default http://192.168.55.113:3224");
  console.log("  FILE_SERVICE_AUTH      bearer token value or full header value");
  console.log("  OLLAMA_URL             default http://192.168.55.113:11434");
  console.log("  OLLAMA_MODEL           default qwen3-embedding");
  console.log("  VECTOR_OWNER           default sonja");
  console.log("  LARGE_FILE_BYTES       default 1048576 (1MB)");
  console.log("  CHUNK_BYTES            default 256000 (250KB)");
  console.log("  MYSQL_HOST             default 127.0.0.1");
  console.log("  MYSQL_PORT             default 3306");
  console.log("  MYSQL_DATABASE         required");
  console.log("  MYSQL_USER             required");
  console.log("  MYSQL_PASSWORD         required");
}

function parseArgs(argv) {
  const out = { limit: 0, dryRun: false };
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

function parseGrade(text) {
  const normalized = String(text || "").toLowerCase();
  const match = normalized.match(/\b(?:grade|graad)\s*(\d{1,2})\b/);
  if (!match) {
    return null;
  }
  const grade = Number(match[1]);
  return Number.isFinite(grade) && grade >= 0 && grade <= 12 ? grade : null;
}

function parseSubject(text) {
  const v = String(text || "").toLowerCase();
  if (/\b(math|maths|mathematics|wiskunde|algebra|geometry|fractions?)\b/.test(v)) return "math";
  if (/\b(afrikaans)\b/.test(v)) return "afrikaans";
  if (/\b(english)\b/.test(v)) return "english";
  if (/\b(science|natuurwetenskap)\b/.test(v)) return "science";
  if (/\b(history|geskiedenis)\b/.test(v)) return "history";
  if (/\b(geography|aardrykskunde)\b/.test(v)) return "geography";
  if (/\b(technology|tegnologie)\b/.test(v)) return "technology";
  if (/\b(life orientation|lewensorientering)\b/.test(v)) return "life-orientation";
  return "unknown";
}

function parseEducational(text, filename) {
  const value = `${String(text || "")} ${String(filename || "")}`.toLowerCase();
  if (
    /\b(bank statement|credit facility|quotation|invoice|tax invoice|payment advice|proof of payment|salary slip|payslip|policy schedule)\b/.test(
      value,
    )
  ) {
    return 0;
  }
  return 1;
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
  const fileEnv = await loadEnvFromFile(path.resolve(repoRoot, "micro services", "mservice-file", ".env"));
  const mysqlEnv = await loadEnvFromFile(path.resolve(repoRoot, "servers", "mysql-docker", ".env"));

  const fileServiceUrl = String(process.env.FILE_SERVICE_URL || DEFAULT_FILE_SERVICE_URL).replace(/\/+$/, "");
  const fileServiceAuth = normalizeHeaderToken(
    process.env.FILE_SERVICE_AUTH || fileEnv.AUTH_BEARER_TOKEN || fileEnv.FILE_MICRO_SERVICE_AUTH || "",
  );
  const ollamaUrl = String(process.env.OLLAMA_URL || DEFAULT_OLLAMA_URL).replace(/\/+$/, "");
  const model = String(process.env.OLLAMA_MODEL || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  const owner = String(process.env.VECTOR_OWNER || DEFAULT_OWNER).trim().toLowerCase() || DEFAULT_OWNER;
  const largeFileBytes = toInt(process.env.LARGE_FILE_BYTES, DEFAULT_LARGE_FILE_BYTES);
  const chunkBytes = toInt(process.env.CHUNK_BYTES, DEFAULT_CHUNK_BYTES);

  const mysqlHost = String(process.env.MYSQL_HOST || mysqlEnv.VECTORIZER_MYSQL_HOST || mysqlEnv.MYSQL_HOST || "127.0.0.1").trim();
  const mysqlPort = toInt(process.env.MYSQL_PORT || mysqlEnv.MYSQL_PORT, 3306);
  const mysqlDatabase = String(process.env.MYSQL_DATABASE || mysqlEnv.MYSQL_DATABASE || "").trim();
  const mysqlUser = String(process.env.MYSQL_USER || mysqlEnv.VECTORIZER_MYSQL_USER || mysqlEnv.MYSQL_USER || "").trim();
  const mysqlPassword = String(process.env.MYSQL_PASSWORD || mysqlEnv.VECTORIZER_MYSQL_PASSWORD || mysqlEnv.MYSQL_PASSWORD || "").trim();

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
    mysqlHost,
    mysqlPort,
    mysqlDatabase,
    mysqlUser,
    mysqlPassword,
  };
}

async function listSonjaFiles(config) {
  const url = `${config.fileServiceUrl}/file/records?owner=${encodeURIComponent(config.owner)}`;
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
  return Array.isArray(parsed.files) ? parsed.files : [];
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
    throw new Error(`Ollama embed failed (${response.status}): ${raw}`);
  }
  let parsed = {};
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = {};
  }
  if (Array.isArray(parsed.embeddings) && Array.isArray(parsed.embeddings[0])) {
    return parsed.embeddings[0];
  }
  if (Array.isArray(parsed.embedding)) {
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

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const config = await resolveConfig();
  console.log(`File service: ${config.fileServiceUrl}`);
  console.log(`Ollama: ${config.ollamaUrl} model=${config.model}`);
  console.log(`Owner: ${config.owner}`);
  console.log(`Chunk rule: >${config.largeFileBytes} bytes -> ${config.chunkBytes} byte chunks`);

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
    let processedFiles = 0;
    let embeddedChunks = 0;

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
      const grade = parseGrade(summary);
      const subject = parseSubject(summary);
      const educational = parseEducational(summary, filename);

      console.log(`[${i + 1}/${selected.length}] ${filename} (id=${fileId})`);
      const downloaded = await downloadFile(config, fileId);
      const payloadBuffer = downloaded.buffer;
      const contentType = downloaded.contentType || baseContentType;
      const shouldChunk = payloadBuffer.length > config.largeFileBytes;
      const chunks = shouldChunk ? splitBuffer(payloadBuffer, config.chunkBytes) : [payloadBuffer];

      for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
        const chunk = chunks[chunkIndex];
        const contentHash = createHash("sha256").update(chunk).digest("hex");
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
            owner: config.owner,
            fileId,
            chunkIndex,
            chunkCount: chunks.length,
            chunkSizeBytes: chunk.length,
            s3Key,
            filename,
            contentType,
            summary,
            grade,
            subject,
            educational,
            embeddingModel: config.model,
            embeddingDim: embedding.length,
            embedding,
            contentHash,
            metadata: {
              source: "sonja-file-vectorizer",
              chunking_rule: {
                large_file_bytes: config.largeFileBytes,
                chunk_bytes: config.chunkBytes,
              },
            },
          });
        }
        embeddedChunks += 1;
      }
      processedFiles += 1;
    }

    console.log(
      options.dryRun
        ? `Dry run complete. Processed files=${processedFiles}, chunks embedded=${embeddedChunks}, db writes skipped.`
        : `Done. Processed files=${processedFiles}, chunks embedded=${embeddedChunks}.`,
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
