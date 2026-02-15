import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const root = process.cwd();
const markerPath = path.resolve(root, "data", ".playwright-skills-installed");
const skillsPath = path.resolve(root, ".claude", "skills", "playwright-cli");

function markerExists() {
  return fs.existsSync(markerPath);
}

function skillsExist() {
  return fs.existsSync(skillsPath);
}

function writeMarker() {
  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  const payload = JSON.stringify({ installedAt: new Date().toISOString() }, null, 2);
  fs.writeFileSync(markerPath, payload, "utf8");
}

function runInstall() {
  try {
    execSync("npx playwright-cli install --skills", {
      stdio: "inherit",
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[playwright-skills] install failed: ${msg}`);
    process.exit(1);
  }
}

if (markerExists() && skillsExist()) {
  process.exit(0);
}

runInstall();
writeMarker();
