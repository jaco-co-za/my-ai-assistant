#!/usr/bin/env node
import process from "node:process";
import path from "node:path";
import { promises as fs } from "node:fs";
import mysql from "mysql2/promise";

const DEFAULT_HOST = "192.168.55.113";
const DEFAULT_OLLAMA_URL = `http://${DEFAULT_HOST}:11434`;
const DEFAULT_MODEL = "qwen3-embedding";
const DEFAULT_OWNER = "sonja";

function usage() {
  console.log("Usage: node src/search.mjs --query \"bees\" [--top 20] [--candidate-limit 2000]");
  console.log("       [--grade N] [--subject math] [--educational 0|1] [--owner sonja]");
}

function parseArgs(argv) {
  const out = {
    query: "",
    top: 20,
    candidateLimit: 2000,
    grade: null,
    subject: "",
    educational: null,
    owner: DEFAULT_OWNER,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i] || "").trim();
    const next = argv[i + 1];
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }
    if (arg === "--query") {
      out.query = String(next || "").trim();
      i += 1;
      continue;
    }
    if (arg === "--top") {
      const v = Number.parseInt(String(next || ""), 10);
      if (Number.isFinite(v) && v > 0) out.top = v;
      i += 1;
      continue;
    }
    if (arg === "--candidate-limit") {
      const v = Number.parseInt(String(next || ""), 10);
      if (Number.isFinite(v) && v > 0) out.candidateLimit = v;
      i += 1;
      continue;
    }
    if (arg === "--grade") {
      const v = Number.parseInt(String(next || ""), 10);
      if (Number.isFinite(v) && v >= 0 && v <= 12) out.grade = v;
      i += 1;
      continue;
    }
    if (arg === "--subject") {
      out.subject = String(next || "").trim().toLowerCase();
      i += 1;
      continue;
    }
    if (arg === "--educational") {
      const v = Number.parseInt(String(next || ""), 10);
      if (v === 0 || v === 1) out.educational = v;
      i += 1;
      continue;
    }
    if (arg === "--owner") {
      out.owner = String(next || DEFAULT_OWNER).trim().toLowerCase() || DEFAULT_OWNER;
      i += 1;
      continue;
    }
  }
  return out;
}

function normalizeHeaderToken(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return /^bearer\s+/i.test(raw) ? raw : `Bearer ${raw}`;
}

async function loadEnvFromFile(filePath) {
  const content = await fs.readFile(filePath, "utf8").catch(() => "");
  if (!content) return {};
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
  const mysqlEnv = await loadEnvFromFile(path.resolve(repoRoot, "servers", "mysql-docker", ".env"));
  const mysqlHostRaw = String(
    process.env.MYSQL_HOST || localEnv.MYSQL_HOST || mysqlEnv.VECTORIZER_MYSQL_HOST || mysqlEnv.MYSQL_HOST || "127.0.0.1",
  ).trim();
  return {
    ollamaUrl: String(process.env.OLLAMA_URL || localEnv.OLLAMA_URL || DEFAULT_OLLAMA_URL).replace(/\/+$/, ""),
    model: String(process.env.OLLAMA_MODEL || localEnv.OLLAMA_MODEL || DEFAULT_MODEL).trim() || DEFAULT_MODEL,
    mysqlHost: mysqlHostRaw === "%" ? "127.0.0.1" : mysqlHostRaw,
    mysqlPort:
      Number.parseInt(String(process.env.MYSQL_PORT || localEnv.MYSQL_PORT || mysqlEnv.MYSQL_PORT || "3306"), 10) || 3306,
    mysqlDatabase: String(process.env.MYSQL_DATABASE || localEnv.MYSQL_DATABASE || mysqlEnv.MYSQL_DATABASE || "").trim(),
    mysqlUser: String(
      process.env.MYSQL_USER || localEnv.MYSQL_USER || mysqlEnv.VECTORIZER_MYSQL_USER || mysqlEnv.MYSQL_USER || "",
    ).trim(),
    mysqlPassword: String(
      process.env.MYSQL_PASSWORD ||
        localEnv.MYSQL_PASSWORD ||
        mysqlEnv.VECTORIZER_MYSQL_PASSWORD ||
        mysqlEnv.MYSQL_PASSWORD ||
        "",
    ).trim(),
  };
}

function tokenizeQuery(query) {
  const stop = new Set(["the", "and", "for", "with", "about", "from", "file", "files", "document", "documents"]);
  return Array.from(
    new Set(
      String(query || "")
        .toLowerCase()
        .split(/[^a-z0-9]+/g)
        .map((x) => x.trim())
        .filter((x) => x.length >= 3 && !stop.has(x)),
    ),
  ).slice(0, 6);
}

function dot(a, b) {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i += 1) s += a[i] * b[i];
  return s;
}

function norm(a) {
  return Math.sqrt(dot(a, a));
}

function cosine(a, b, na, nb) {
  if (!na || !nb) return 0;
  return dot(a, b) / (na * nb);
}

async function embedQuery(config, query) {
  const response = await fetch(`${config.ollamaUrl}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ model: config.model, input: query }),
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`Ollama embed failed (${response.status}): ${raw}`);
  const parsed = JSON.parse(raw);
  const vec = Array.isArray(parsed.embeddings) ? parsed.embeddings[0] : parsed.embedding;
  if (!Array.isArray(vec) || vec.length === 0) throw new Error("No embedding array returned");
  return vec.map((x) => Number(x));
}

async function fetchCandidates(connection, opts) {
  const where = ["owner = ?"];
  const params = [opts.owner];
  if (opts.grade !== null) {
    where.push("grade = ?");
    params.push(opts.grade);
  }
  if (opts.subject) {
    where.push("subject = ?");
    params.push(opts.subject);
  }
  if (opts.educational !== null) {
    where.push("educational = ?");
    params.push(opts.educational);
  }
  const tokens = tokenizeQuery(opts.query);
  if (tokens.length > 0) {
    const tokenClauses = [];
    for (const token of tokens) {
      tokenClauses.push("(LOWER(COALESCE(filename,'')) LIKE ? OR LOWER(COALESCE(summary,'')) LIKE ?)");
      const like = `%${token}%`;
      params.push(like, like);
    }
    where.push(`(${tokenClauses.join(" OR ")})`);
  }
  params.push(opts.candidateLimit);
  const sql = `
    SELECT id, file_id, filename, chunk_index, grade, subject, educational, embedding_json
    FROM sonja_file_embedding_chunks
    WHERE ${where.join(" AND ")}
    ORDER BY updated_at DESC
    LIMIT ?
  `;
  const [rows] = await connection.execute(sql, params);
  return Array.isArray(rows) ? rows : [];
}

function rankByFile(rows, queryVec) {
  const qn = norm(queryVec);
  const bestByFile = new Map();
  for (const row of rows) {
    const embRaw = row.embedding_json;
    let emb;
    try {
      emb = typeof embRaw === "string" ? JSON.parse(embRaw) : embRaw;
    } catch {
      continue;
    }
    if (!Array.isArray(emb) || emb.length === 0) continue;
    const vec = emb.map((x) => Number(x));
    const score = cosine(vec, queryVec, norm(vec), qn);
    const key = String(row.file_id);
    const existing = bestByFile.get(key);
    if (!existing || score > existing.score) {
      bestByFile.set(key, {
        file_id: row.file_id,
        filename: row.filename,
        chunk_index: row.chunk_index,
        grade: row.grade,
        subject: row.subject,
        educational: row.educational,
        score,
      });
    }
  }
  return Array.from(bestByFile.values()).sort((a, b) => b.score - a.score);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.query) {
    usage();
    process.exit(1);
  }
  const config = await resolveConfig();
  if (!config.mysqlDatabase || !config.mysqlUser || !config.mysqlPassword) {
    throw new Error("Missing MySQL configuration");
  }
  console.log(`Embedding query with model=${config.model}...`);
  const qvec = await embedQuery(config, opts.query);
  console.log(`Query embedding dim=${qvec.length}`);
  const connection = await mysql.createConnection({
    host: config.mysqlHost,
    port: config.mysqlPort,
    user: config.mysqlUser,
    password: config.mysqlPassword,
    database: config.mysqlDatabase,
    charset: "utf8mb4",
  });
  try {
    const candidates = await fetchCandidates(connection, opts);
    console.log(`Candidates fetched=${candidates.length}`);
    const ranked = rankByFile(candidates, qvec).slice(0, opts.top);
    if (ranked.length === 0) {
      console.log("No matches.");
      return;
    }
    console.table(
      ranked.map((r) => ({
        file_id: r.file_id,
        score: Number(r.score.toFixed(6)),
        grade: r.grade,
        subject: r.subject,
        educational: r.educational,
        filename: r.filename,
        chunk_index: r.chunk_index,
      })),
    );
  } finally {
    await connection.end();
  }
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`ERROR: ${msg}`);
  process.exit(1);
});
