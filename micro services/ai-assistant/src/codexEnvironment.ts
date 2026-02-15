import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const SEED_MARKER = ".seeded-from-user-codex";

function isTruthy(value: string | undefined): boolean {
  const normalized = (value ?? "").trim().toLowerCase();
  return TRUE_VALUES.has(normalized);
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export function resolveProjectCodexHome(): string {
  const configured = (process.env.APP_CODEX_HOME ?? "").trim();
  if (configured.length > 0) {
    return path.isAbsolute(configured) ? configured : path.resolve(process.cwd(), configured);
  }
  return path.resolve(process.cwd(), ".codex");
}

function resolveUserCodexHome(): string | null {
  const homeRoot = (process.env.USERPROFILE ?? process.env.HOME ?? os.homedir() ?? "").trim();
  if (!homeRoot) {
    return null;
  }
  return path.resolve(homeRoot, ".codex");
}

async function seedFromUserCodexHome(targetHome: string): Promise<void> {
  if (!isTruthy(process.env.APP_CODEX_HOME_SEED_FROM_USER)) {
    return;
  }
  const markerPath = path.join(targetHome, SEED_MARKER);
  if (await pathExists(markerPath)) {
    return;
  }
  const sourceHome = resolveUserCodexHome();
  if (!sourceHome) {
    return;
  }
  if (path.resolve(sourceHome).toLowerCase() === path.resolve(targetHome).toLowerCase()) {
    return;
  }
  if (!(await pathExists(sourceHome))) {
    return;
  }

  const entries = ["config.toml", "skills", "mcp"];
  for (const entry of entries) {
    const src = path.join(sourceHome, entry);
    const dst = path.join(targetHome, entry);
    if (!(await pathExists(src)) || (await pathExists(dst))) {
      continue;
    }
    await fs.cp(src, dst, { recursive: true });
  }
  await fs.writeFile(markerPath, new Date().toISOString(), "utf8");
}

async function ensureProjectCodexHome(targetHome: string): Promise<void> {
  await fs.mkdir(targetHome, { recursive: true });
  await seedFromUserCodexHome(targetHome);
}

export function applyCodexHomeToProcessEnv(): string {
  const codexHome = resolveProjectCodexHome();
  process.env.CODEX_HOME = codexHome;
  return codexHome;
}

export async function getCodexProcessEnv(): Promise<NodeJS.ProcessEnv> {
  const codexHome = resolveProjectCodexHome();
  await ensureProjectCodexHome(codexHome);
  return {
    ...process.env,
    CODEX_HOME: codexHome,
  };
}
