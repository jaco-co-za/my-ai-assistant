import express from "express";
import dotenv from "dotenv";
import { registerEndpoints } from "./endpoints.js";
import { authMiddleware } from "./middleware/auth.js";
import { testOllamaOnStartup } from "./ollamaClient.js";
import { registerWebsocket, broadcastReload, broadcastLog, markStartupReload } from "./websocket.js";
import { applyCodexHomeToProcessEnv } from "./codexEnvironment.js";

dotenv.config();
const codexHome = applyCodexHomeToProcessEnv();

const app = express();
const originalLog = console.log.bind(console);
const originalWarn = console.warn.bind(console);
const originalError = console.error.bind(console);

console.log = (...args: unknown[]) => {
  originalLog(...args);
  broadcastLog(args.map(String).join(" "));
};
console.warn = (...args: unknown[]) => {
  originalWarn(...args);
  broadcastLog(args.map(String).join(" "));
};
console.error = (...args: unknown[]) => {
  originalError(...args);
  broadcastLog(args.map(String).join(" "));
};
const port = Number(process.env.WEBHOOK_PORT) || 3350;
const bodyLimit = (process.env.WEBHOOK_BODY_LIMIT || "100mb").trim() || "100mb";

const ui = express();
const queuePort = 8599;

ui.use(express.urlencoded({ extended: false }));
ui.use(express.json({ limit: bodyLimit }));
ui.use("/assets", express.static("node_modules/bootstrap/dist/css"));
ui.use((req, _res, next) => {
  const startedAt = Date.now();
  console.log(`[ui-req] ${req.method} ${req.originalUrl} ip=${req.ip}`);
  _res.on("finish", () => {
    console.log(`[ui-res] ${req.method} ${req.originalUrl} ${_res.statusCode} ${Date.now() - startedAt}ms`);
  });
  next();
});

app.use(express.json({ limit: bodyLimit }));
app.use(express.urlencoded({ extended: true, limit: bodyLimit }));
app.use((req, _res, next) => {
  const startedAt = Date.now();
  console.log(`[req] ${req.method} ${req.originalUrl} ip=${req.ip}`);
  _res.on("finish", () => {
    console.log(`[res] ${req.method} ${req.originalUrl} ${_res.statusCode} ${Date.now() - startedAt}ms`);
  });
  next();
});
app.use(authMiddleware);
  registerEndpoints(app, ui);

void (async () => {
  const openAiEnabled = (process.env.OPEN_AI_ENABLED ?? "").trim().toLowerCase();
  const openAiCodexEnabled = (process.env.OPEN_AI_CODEX_ENABLED ?? "").trim().toLowerCase();
  const openAiToken = (process.env.OPENAI_TOKEN ?? "").trim();
  if (openAiCodexEnabled === "true" || openAiCodexEnabled === "1" || openAiCodexEnabled === "yes") {
    console.log("[codex] Enabled. Skipping Ollama startup check.");
    return;
  }
  if (openAiToken && (openAiEnabled === "true" || openAiEnabled === "1" || openAiEnabled === "yes")) {
    console.log("[openai] Enabled. Skipping Ollama startup check.");
    return;
  }

  const status = await testOllamaOnStartup();
  if (!status.ok) {
    console.warn(`[ollama] Startup check failed: ${status.error}`);
    return;
  }

  if (status.models.length === 0) {
    console.warn("[ollama] Connected but no models found. Pull a model to enable requests.");
    return;
  }

  if (!status.models.includes(status.configuredModel)) {
    console.warn(
      `[ollama] Connected. Configured model "${status.configuredModel}" not found. Available: ${status.models.join(", ")}`,
    );
    return;
  }

  console.log(`[ollama] Connected. Using model "${status.configuredModel}".`);
})();

const server = app.listen(port, () => {
  console.log(`Webhook server listening on port ${port}`);
  console.log(`[codex] CODEX_HOME=${codexHome}`);
});

ui.listen(queuePort, () => {
  console.log(`Message queue UI listening on port ${queuePort}`);
});

markStartupReload();
registerWebsocket(server);
broadcastReload();

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const entityTooLarge =
    !!err &&
    typeof err === "object" &&
    (((err as { type?: unknown }).type === "entity.too.large") ||
      ((err as { status?: unknown }).status === 413));
  if (entityTooLarge) {
    const detail = `Payload too large. Increase WEBHOOK_BODY_LIMIT (current: ${bodyLimit}).`;
    console.error(`[error] ${detail}`);
    res.status(413).json({ error: detail });
    return;
  }
  const message = err instanceof Error ? err.message : "unknown error";
  console.error(`[error] ${message}`);
  res.status(500).json({ error: "internal server error" });
});
