import type { Server as HttpServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import dotenv from "dotenv";
import { getDatabase } from "./database.js";
import { classifyAndCompile, storeIncomingMessage, storeOutgoingMessage } from "./messageBroker.js";
import { getCodexProcessEnv } from "./codexEnvironment.js";

type ClientMessage = {
  type: "message";
  message: string;
  requestId?: string;
};

type ServerMessage = {
  type: "reply";
  success: boolean;
  code: number;
  msg: string;
  notify?: boolean;
  actions?: {
    type: string;
    label: string;
    text: string;
  }[];
  attachments?: {
    attachmentId?: number;
    filename: string;
    contentType: string;
    dataBase64: string;
  }[];
};

type CancelMessage = {
  type: "cancel";
  requestId: string;
};

type CodexLoginMessage = {
  type: "codex-login";
};

type CodexLoginSaveCallbackMessage = {
  type: "codex-login-save-callback";
  callbackUrl: string;
};

type EventMessage = {
  type: "event";
  title: string;
  detail: string;
};

type LogMessage = {
  type: "log";
  detail: string;
};

type ConfigMessage = {
  type: "config";
  openAiApiEnabled: boolean;
  openAiCodexEnabled: boolean;
  codexAuthAvailable: boolean;
  commandExecutionEnabled: boolean;
  notifyUiEnabled: boolean;
  notifyPushoverEnabled: boolean;
  notifyWhatsappEnabled: boolean;
  consoleMirrorEnabled: boolean;
};

type ConfigSaveMessage = {
  type: "config-save";
  openAiApiEnabled?: boolean;
  openAiCodexEnabled?: boolean;
  openAiEnabled?: boolean;
  commandExecutionEnabled?: boolean;
  notifyUiEnabled?: boolean;
  notifyPushoverEnabled?: boolean;
  notifyWhatsappEnabled?: boolean;
  consoleMirrorEnabled?: boolean;
};

type ReloadMessage = {
  type: "reload";
};

const URL_PATTERN = /https?:\/\/[^\s"'<>]+/i;
const db = getDatabase();

function extractFirstUrl(text: string): string | null {
  const match = text.match(URL_PATTERN);
  return match ? match[0] : null;
}

async function startCodexLogin(timeoutMs = 8000): Promise<{ message: string }> {
  const codexEnv = await getCodexProcessEnv();
  return new Promise((resolve) => {
    let settled = false;
    let output = "";
    let timer: NodeJS.Timeout | null = null;

    const finish = (message: string): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      resolve({ message });
    };

    let child;
    try {
      child = spawn("codex", ["login"], {
        shell: true,
        windowsHide: true,
        env: codexEnv,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : "unknown error";
      finish(`Unable to start Codex login: ${msg}`);
      return;
    }

    const collect = (chunk: Buffer | string): void => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      output += text;
      const url = extractFirstUrl(output);
      if (!url) {
        return;
      }
      child.kill();
      finish(`Open this URL to continue Codex login:\n${url}`);
    };

    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", (error: Error) => {
      const msg = error instanceof Error ? error.message : "unknown error";
      finish(`Unable to start Codex login: ${msg}`);
    });
    child.on("exit", () => {
      if (settled) {
        return;
      }
      const url = extractFirstUrl(output);
      if (url) {
        finish(`Open this URL to continue Codex login:\n${url}`);
        return;
      }
      finish("Codex login did not emit a URL here. Run `codex login` in an interactive terminal.");
    });

    timer = setTimeout(() => {
      if (settled) {
        return;
      }
      const url = extractFirstUrl(output);
      child.kill();
      if (url) {
        finish(`Open this URL to continue Codex login:\n${url}`);
        return;
      }
      finish("Codex login is TTY-only in this environment. Run `codex login` in your terminal.");
    }, timeoutMs);
  });
}

async function runCodexSmokeTest(timeoutMs = 45_000): Promise<{ ok: boolean; message: string }> {
  const codexEnv = await getCodexProcessEnv();
  const outputPath = path.resolve(process.cwd(), "data", `codex-smoke-${Date.now()}.txt`);
  try {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
  } catch {
    // continue
  }

  return new Promise((resolve) => {
    let settled = false;
    let output = "";
    let timer: NodeJS.Timeout | null = null;

    const finish = async (result: { ok: boolean; message: string }): Promise<void> => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      try {
        await fs.unlink(outputPath);
      } catch {
        // ignore cleanup errors
      }
      resolve(result);
    };

    let child;
    try {
      child = spawn(
        "codex",
        [
          "exec",
          "--skip-git-repo-check",
          "--output-last-message",
          outputPath,
          "-",
        ],
        {
          shell: true,
          windowsHide: true,
          env: codexEnv,
        },
      );
      child.stdin.write("Reply with exactly: Codex auth OK\n");
      child.stdin.end();
    } catch (error) {
      const msg = error instanceof Error ? error.message : "unknown error";
      void finish({ ok: false, message: `Codex smoke test failed to start: ${msg}` });
      return;
    }

    const collect = (chunk: Buffer | string): void => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      output += text;
    };

    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", (error: Error) => {
      const msg = error instanceof Error ? error.message : "unknown error";
      void finish({ ok: false, message: `Codex smoke test failed: ${msg}` });
    });
    child.on("exit", async (code) => {
      if (settled) {
        return;
      }
      let lastMessage = "";
      try {
        lastMessage = (await fs.readFile(outputPath, "utf8")).trim();
      } catch {
        lastMessage = "";
      }

      if (lastMessage) {
        await finish({ ok: true, message: lastMessage });
        return;
      }

      const trimmed = output.trim();
      const fallback = trimmed.length > 0 ? trimmed.slice(-500) : "No response captured from codex exec.";
      if (code === 0) {
        await finish({ ok: true, message: fallback });
        return;
      }
      await finish({ ok: false, message: fallback });
    });

    timer = setTimeout(() => {
      if (settled) {
        return;
      }
      child.kill();
      void finish({ ok: false, message: "Codex smoke test timed out." });
    }, timeoutMs);
  });
}

function saveAppSetting(key: string, value: string): void {
  db.prepare(
    `INSERT INTO app_settings (key, value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, new Date().toISOString());
}

function getAppSetting(key: string): string {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = ? LIMIT 1").get(key) as { value?: string } | undefined;
  return typeof row?.value === "string" ? row.value : "";
}

function hasCodexAuthToken(): boolean {
  return getAppSetting("openaioauthtoken").trim().length > 0;
}

function extractIdTokenFromCallbackUrl(rawCallbackUrl: string): string | null {
  const input = (rawCallbackUrl || "").trim();
  if (!input) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return null;
  }
  const fromQuery = parsed.searchParams.get("id_token");
  if (fromQuery && fromQuery.trim()) {
    return fromQuery.trim();
  }
  const hash = parsed.hash.startsWith("#") ? parsed.hash.slice(1) : parsed.hash;
  if (!hash) {
    return null;
  }
  const hashParams = new URLSearchParams(hash);
  const fromHash = hashParams.get("id_token");
  if (fromHash && fromHash.trim()) {
    return fromHash.trim();
  }
  return null;
}

const clients = new Set<WebSocket>();
let consoleMirrorEnabled = false;
let startupReloadPending = true;

export function setConsoleMirrorEnabled(enabled: boolean): void {
  consoleMirrorEnabled = enabled;
}

async function upsertEnvValue(key: string, value: string): Promise<void> {
  const envPath = path.resolve(process.cwd(), ".env");
  let content = "";
  try {
    content = await fs.readFile(envPath, "utf-8");
  } catch {
    content = "";
  }
  const line = `${key}=${value}`;
  const keyPattern = new RegExp(`^${key}=.*$`, "m");
  if (keyPattern.test(content)) {
    content = content.replace(keyPattern, line);
  } else {
    if (content.length > 0 && !content.endsWith("\n")) {
      content += "\n";
    }
    content += `${line}\n`;
  }
  await fs.writeFile(envPath, content, "utf-8");
}

function currentConfig(): ConfigMessage {
  const apiValue = (process.env.OPEN_AI_ENABLED ?? "").trim().toLowerCase();
  const codexValue = (process.env.OPEN_AI_CODEX_ENABLED ?? "").trim().toLowerCase();
  const cmdExecValue = (process.env.ALLOW_COMMAND_EXECUTION ?? "false").trim().toLowerCase();
  const notifyUiValue = (process.env.NOTIFY_UI_ENABLED ?? "true").trim().toLowerCase();
  const notifyPushoverValue = (process.env.NOTIFY_PUSHOVER_ENABLED ?? "true").trim().toLowerCase();
  const notifyWhatsappValue = (process.env.NOTIFY_WHATSAPP_ENABLED ?? "true").trim().toLowerCase();
  const apiEnabled = apiValue === "true" || apiValue === "1" || apiValue === "yes";
  const codexEnabled = codexValue === "true" || codexValue === "1" || codexValue === "yes";
  const commandExecutionEnabled = cmdExecValue === "true" || cmdExecValue === "1" || cmdExecValue === "yes";
  const notifyUiEnabled =
    notifyUiValue === "true" || notifyUiValue === "1" || notifyUiValue === "yes";
  const notifyPushoverEnabled =
    notifyPushoverValue === "true" || notifyPushoverValue === "1" || notifyPushoverValue === "yes";
  const notifyWhatsappEnabled =
    notifyWhatsappValue === "true" || notifyWhatsappValue === "1" || notifyWhatsappValue === "yes";
  const codexAuthAvailable = hasCodexAuthToken();
  return {
    type: "config",
    openAiApiEnabled: apiEnabled && !codexEnabled,
    openAiCodexEnabled: codexEnabled,
    codexAuthAvailable,
    commandExecutionEnabled,
    notifyUiEnabled,
    notifyPushoverEnabled,
    notifyWhatsappEnabled,
    consoleMirrorEnabled,
  };
}

export function broadcastEvent(title: string, detail: string): void {
  const payload: EventMessage = { type: "event", title, detail };
  const data = JSON.stringify(payload);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}

export function broadcastLog(detail: string): void {
  if (!consoleMirrorEnabled) {
    return;
  }
  const payload: LogMessage = { type: "log", detail };
  const data = JSON.stringify(payload);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}

export function broadcastReload(): void {
  const payload: ReloadMessage = { type: "reload" };
  const data = JSON.stringify(payload);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}

export function markStartupReload(): void {
  startupReloadPending = true;
}

export function registerWebsocket(server: HttpServer): void {
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (socket: WebSocket) => {
    clients.add(socket);
    socket.send(JSON.stringify(currentConfig()));
    if (startupReloadPending) {
      socket.send(JSON.stringify({ type: "reload" }));
      startupReloadPending = false;
      return;
    }
    const pending = new Map<string, AbortController>();
    const cancelled = new Set<string>();
    socket.on("message", async (data: WebSocket.RawData) => {
      const raw = typeof data === "string" ? data : data.toString();
      let parsed:
        | ClientMessage
        | ConfigSaveMessage
        | CancelMessage
        | CodexLoginMessage
        | CodexLoginSaveCallbackMessage
        | null = null;
      try {
        parsed = JSON.parse(raw) as
          | ClientMessage
          | ConfigSaveMessage
          | CancelMessage
          | CodexLoginMessage
          | CodexLoginSaveCallbackMessage;
      } catch {
        return;
      }
      if (!parsed || parsed.type !== "message") {
        if (parsed && parsed.type === "config-save") {
          if (typeof parsed.consoleMirrorEnabled === "boolean") {
            setConsoleMirrorEnabled(parsed.consoleMirrorEnabled);
          }
          const requestedApi =
            typeof parsed.openAiApiEnabled === "boolean"
              ? parsed.openAiApiEnabled
              : typeof parsed.openAiEnabled === "boolean"
                ? parsed.openAiEnabled
                : undefined;
          const requestedCodex =
            typeof parsed.openAiCodexEnabled === "boolean" ? parsed.openAiCodexEnabled : undefined;
          const requestedNotifyUi =
            typeof parsed.notifyUiEnabled === "boolean" ? parsed.notifyUiEnabled : undefined;
          const requestedNotifyPushover =
            typeof parsed.notifyPushoverEnabled === "boolean" ? parsed.notifyPushoverEnabled : undefined;
          const requestedNotifyWhatsapp =
            typeof parsed.notifyWhatsappEnabled === "boolean" ? parsed.notifyWhatsappEnabled : undefined;
          const requestedCommandExecution =
            typeof parsed.commandExecutionEnabled === "boolean" ? parsed.commandExecutionEnabled : undefined;
          if (
            typeof requestedApi === "boolean" ||
            typeof requestedCodex === "boolean" ||
            typeof requestedCommandExecution === "boolean" ||
            typeof requestedNotifyUi === "boolean" ||
            typeof requestedNotifyPushover === "boolean" ||
            typeof requestedNotifyWhatsapp === "boolean"
          ) {
            const codexAuthAvailable = hasCodexAuthToken();
            const nextApi = Boolean(requestedApi) && !Boolean(requestedCodex);
            const nextCodex = Boolean(requestedCodex) && codexAuthAvailable && !Boolean(requestedApi);
            await upsertEnvValue("OPEN_AI_ENABLED", nextApi ? "true" : "false");
            await upsertEnvValue("OPEN_AI_CODEX_ENABLED", nextCodex ? "true" : "false");
            if (typeof requestedCommandExecution === "boolean") {
              await upsertEnvValue("ALLOW_COMMAND_EXECUTION", requestedCommandExecution ? "true" : "false");
            }
            if (typeof requestedNotifyUi === "boolean") {
              await upsertEnvValue("NOTIFY_UI_ENABLED", requestedNotifyUi ? "true" : "false");
            }
            if (typeof requestedNotifyPushover === "boolean") {
              await upsertEnvValue("NOTIFY_PUSHOVER_ENABLED", requestedNotifyPushover ? "true" : "false");
            }
            if (typeof requestedNotifyWhatsapp === "boolean") {
              await upsertEnvValue("NOTIFY_WHATSAPP_ENABLED", requestedNotifyWhatsapp ? "true" : "false");
            }
            dotenv.config({ override: true });
            broadcastReload();
          } else {
            socket.send(JSON.stringify(currentConfig()));
          }
        }
        if (parsed && parsed.type === "cancel") {
          const controller = pending.get(parsed.requestId);
          if (controller) {
            controller.abort();
            pending.delete(parsed.requestId);
          }
          cancelled.add(parsed.requestId);
        }
        if (parsed && parsed.type === "codex-login") {
          const result = await startCodexLogin();
          const reply: ServerMessage = {
            type: "reply",
            success: true,
            code: 200,
            msg: result.message,
          };
          socket.send(JSON.stringify(reply));
        }
        if (parsed && parsed.type === "codex-login-save-callback") {
          const token = extractIdTokenFromCallbackUrl(parsed.callbackUrl);
          if (!token) {
            const reply: ServerMessage = {
              type: "reply",
              success: false,
              code: 400,
              msg: "Could not find id_token in callback URL.",
            };
            socket.send(JSON.stringify(reply));
            return;
          }
          saveAppSetting("openaioauthtoken", token);
          saveAppSetting("openaioauthcallbackurl", parsed.callbackUrl.trim());
          const smoke = await runCodexSmokeTest();
          const reply: ServerMessage = {
            type: "reply",
            success: smoke.ok,
            code: smoke.ok ? 200 : 500,
            msg: `OAuth callback saved. id_token stored in database as openaioauthtoken.\nCodex test response: ${smoke.message}`,
          };
          socket.send(JSON.stringify(reply));
          socket.send(JSON.stringify(currentConfig()));
        }
        return;
      }
      const message = typeof parsed.message === "string" ? parsed.message.trim() : "";
      if (!message) {
        return;
      }
      const requestId = typeof (parsed as ClientMessage).requestId === "string"
        ? (parsed as ClientMessage & { requestId: string }).requestId
        : "";
      const controller = new AbortController();
      if (requestId) {
        pending.set(requestId, controller);
      }
      const stored = storeIncomingMessage({ from: "queue-ui", message });
      const result = await classifyAndCompile("queue-ui", message, stored.id);
      storeOutgoingMessage({ inmessageId: stored.id, message: result.msg });
      if (requestId) {
        pending.delete(requestId);
      }
      if (requestId && cancelled.has(requestId)) {
        cancelled.delete(requestId);
        return;
      }
      const reply: ServerMessage = {
        type: "reply",
        success: result.success,
        code: result.code,
        msg: result.msg,
        notify: result.notify,
        actions: result.uiActions,
        attachments: result.attachments,
      };
      socket.send(JSON.stringify(reply));
    });

    socket.on("close", () => {
      clients.delete(socket);
    });

    socket.on("error", (error: Error) => {
      const msg = error instanceof Error ? error.message : "unknown error";
      console.warn(`[ws] error: ${msg}`);
    });
  });
}
