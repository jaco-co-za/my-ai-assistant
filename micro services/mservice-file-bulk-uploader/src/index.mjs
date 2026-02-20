#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const KNOWN_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
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
const DEFAULT_BASE_HOST = "192.168.55.113";
const LEGACY_BASE_HOST = "192.168.55.73";

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
  return raw.split(LEGACY_BASE_HOST).join(DEFAULT_BASE_HOST);
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
  const response = await fetch(uploadUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      owner,
      filename,
      mimeType,
      dataBase64: fileBuffer.toString("base64"),
      caption: "",
    }),
  });
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
  };
}

async function pollFileCompletion(statusUrl, authHeader, owner, fileId, key) {
  const started = Date.now();
  let notFoundCount = 0;
  while (Date.now() - started <= FILE_WAIT_TIMEOUT_MS) {
    const params = new URLSearchParams();
    params.set("owner", owner);
    if (fileId && fileId > 0) {
      params.set("id", String(fileId));
    } else if (key) {
      params.set("key", key);
    }
    const response = await fetch(`${statusUrl}?${params.toString()}`, {
      headers: authHeader ? { Authorization: authHeader } : {},
    });

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
  const envContent = await fs.readFile(aiEnvPath, "utf8");
  const env = parseEnvFile(envContent);

  const baseHost = normalizeLegacyHost(String(env.BASE_URL || DEFAULT_BASE_HOST).trim() || DEFAULT_BASE_HOST);
  const uploadUrl = ensureUrl(
    normalizeLegacyHost(env.AI_ASSISTANT_UI_UPLOAD_URL || `http://${baseHost}:8599/upload-file`),
  );
  const fileUploadUrl = ensureUrl(
    normalizeLegacyHost(env.FILE_MICRO_SERVICE_URL || `http://${baseHost}:3224/file/upload`),
    "/file/upload",
  );
  const statusUrl = fileUploadUrl ? fileUploadUrl.replace(/\/file\/upload$/i, "/file/status") : "";
  const statusAuth = String(env.FILE_MICRO_SERVICE_AUTH || "").trim() ||
    (String(env.WEBHOOK_BEARER_TOKEN || "").trim() ? `Bearer ${String(env.WEBHOOK_BEARER_TOKEN || "").trim()}` : "");

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
    console.log("No supported files found (.jpg/.jpeg/.webp/.bmp/.tif/.tiff/.pdf/.doc/.docx).");
    return;
  }

  const selected = limit === 0 ? discovered : discovered.slice(0, limit);
  console.log(`Owner: ${owner}`);
  console.log(`Recursive: ${recursive ? "true (max depth 3)" : "false (root only)"}`);
  console.log(`Upload endpoint: ${uploadUrl}`);
  console.log(`Status endpoint: ${statusUrl}`);
  console.log(`Found ${discovered.length} supported files, processing ${selected.length}.`);

  let successCount = 0;
  let failedCount = 0;
  for (let i = 0; i < selected.length; i += 1) {
    const fullPath = selected[i];
    const display = path.basename(fullPath);
    console.log(`\n[${i + 1}/${selected.length}] Uploading ${display}`);
    try {
      const uploaded = await uploadViaAssistant(uploadUrl, owner, fullPath);
      console.log(`Uploaded ${display} -> file_id=${uploaded.fileId ?? "unknown"}`);

      const status = await pollFileCompletion(statusUrl, statusAuth, owner, uploaded.fileId, uploaded.key);
      if (status.status === "completed" || status.status === "skipped") {
        console.log(`Completed ${display} (status=${status.status})`);
        console.log(`Summary ${display}: ${status.summary || "(no summary)"}`);
        successCount += 1;
        continue;
      }
      if (status.status === "deleted") {
        console.log(`Completed ${display} (status=deleted)`);
        console.log(`Summary ${display}: ${status.summary || "(no summary)"}`);
        successCount += 1;
        continue;
      }

      if (status.status === "failed") {
        if (isNonFatalSummaryFailure(status.error)) {
          console.log(`Skipped ${display} due to non-fatal summary issue: ${status.error}`);
          console.log(`Summary ${display}: ${status.summary || "(no summary)"}`);
          successCount += 1;
          continue;
        }
        throw new Error(`processing failed for ${display}: ${status.error || "unknown error"}`);
      }

      console.log(`Finished ${display} with status=${status.status}`);
      successCount += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`ERROR: ${message}`);
      failedCount += 1;
    }
  }

  console.log(`\nDone. Successfully processed ${successCount}/${selected.length}. Failed ${failedCount}.`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`ERROR: ${message}`);
  process.exit(1);
});
