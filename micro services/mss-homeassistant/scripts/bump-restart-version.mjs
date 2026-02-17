import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const versionPath = path.resolve(__dirname, "..", "restart.version");

async function main() {
  let current = "1.000";
  try {
    current = (await fs.readFile(versionPath, "utf8")).trim() || current;
  } catch {
    // fallback to default if file doesn't exist yet
  }

  const numeric = Number.parseFloat(current);
  const next = Number.isFinite(numeric) ? (numeric + 0.001).toFixed(3) : "1.000";
  await fs.writeFile(versionPath, `${next}\n`, "utf8");
  console.log(`[restart] mss-homeassistant restart.version ${current} -> ${next}`);
}

main().catch((error) => {
  const msg = error instanceof Error ? error.message : String(error);
  console.error(`[restart] failed: ${msg}`);
  process.exit(1);
});
