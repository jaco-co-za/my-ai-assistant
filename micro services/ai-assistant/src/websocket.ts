import type { Server as HttpServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { promises as fs, readFileSync } from "node:fs";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import dotenv from "dotenv";
import { classifyAndCompile, storeIncomingMessage, storeOutgoingMessage } from "./messageBroker.js";
import { getCodexLaunchSpec, resolveProjectCodexHome } from "./codexEnvironment.js";

type ClientMessage = {
  type: "message";
  message: string;
  requestId?: string;
  skipCache?: boolean;
};

type ServerMessage = {
  type: "reply";
  success: boolean;
  code: number;
  msg: string;
  notify?: boolean;
  payload?: Record<string, unknown>;
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
const CODEX_LOGIN_URL_WAIT_MS = 15_000;
const CODEX_LOGIN_FINISH_WAIT_MS = 30_000;

function extractFirstUrl(text: string): string | null {
  const match = text.match(URL_PATTERN);
  return match ? match[0] : null;
}

function tail(text: string, max = 1200): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) {
    return trimmed;
  }
  return trimmed.slice(-max);
}

type CodexLoginSession = {
  child: ChildProcessWithoutNullStreams;
  completion: Promise<{ ok: boolean; message: string }>;
  waitForAuthUrl: (timeoutMs?: number) => Promise<string>;
};

const codexLoginSessions = new WeakMap<WebSocket, CodexLoginSession>();

function cleanupCodexLoginSession(socket: WebSocket): void {
  const session = codexLoginSessions.get(socket);
  if (!session) {
    return;
  }
  if (!session.child.killed && session.child.exitCode === null) {
    try {
      session.child.kill();
    } catch {
      // ignore
    }
  }
  codexLoginSessions.delete(socket);
}

async function startCodexLoginSession(socket: WebSocket): Promise<CodexLoginSession> {
  cleanupCodexLoginSession(socket);
  const codexLaunch = await getCodexLaunchSpec();
  const child = spawn(codexLaunch.command, [...codexLaunch.prefixArgs, "login"], {
    shell: false,
    windowsHide: true,
    env: codexLaunch.env,
  });

  let output = "";
  let authUrl: string | null = null;
  let urlResolver: ((value: string) => void) | null = null;
  let urlRejecter: ((reason: Error) => void) | null = null;

  const waitForAuthUrl = (timeoutMs = CODEX_LOGIN_URL_WAIT_MS): Promise<string> => {
    if (authUrl) {
      return Promise.resolve(authUrl);
    }
    return new Promise((resolve, reject) => {
      urlResolver = resolve;
      urlRejecter = reject;
      const timer = setTimeout(() => {
        if (urlRejecter === reject) {
          urlResolver = null;
          urlRejecter = null;
        }
        reject(new Error("Codex login did not emit an auth URL in time."));
      }, timeoutMs);
      const wrappedResolve = (value: string): void => {
        clearTimeout(timer);
        if (urlResolver === wrappedResolve) {
          urlResolver = null;
          urlRejecter = null;
        }
        resolve(value);
      };
      const wrappedReject = (reason: Error): void => {
        clearTimeout(timer);
        if (urlRejecter === wrappedReject) {
          urlResolver = null;
          urlRejecter = null;
        }
        reject(reason);
      };
      urlResolver = wrappedResolve;
      urlRejecter = wrappedReject;
    });
  };

  const collect = (chunk: Buffer | string): void => {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    output += text;
    if (!authUrl) {
      const extracted = extractFirstUrl(output);
      if (extracted) {
        authUrl = extracted;
        if (urlResolver) {
          const resolve = urlResolver;
          urlResolver = null;
          urlRejecter = null;
          resolve(extracted);
        }
      }
    }
  };

  child.stdout.on("data", collect);
  child.stderr.on("data", collect);

  const completion = new Promise<{ ok: boolean; message: string }>((resolve) => {
    child.on("error", (error: Error) => {
      const msg = error instanceof Error ? error.message : "unknown error";
      if (urlRejecter) {
        const reject = urlRejecter;
        urlResolver = null;
        urlRejecter = null;
        reject(new Error(`Unable to start Codex login: ${msg}`));
      }
      resolve({ ok: false, message: `Codex login failed: ${msg}` });
    });
    child.on("exit", (code) => {
      const logs = tail(output);
      if (!authUrl && urlRejecter) {
        const reject = urlRejecter;
        urlResolver = null;
        urlRejecter = null;
        reject(new Error("Codex login exited before emitting an auth URL."));
      }
      if (code === 0) {
        resolve({ ok: true, message: logs || "Codex login complete." });
        return;
      }
      resolve({ ok: false, message: logs || `Codex login exited with code ${code}` });
    });
  });

  const session: CodexLoginSession = {
    child,
    completion,
    waitForAuthUrl,
  };
  codexLoginSessions.set(socket, session);
  return session;
}

async function completeCodexLoginWithCallback(socket: WebSocket, callbackUrl: string): Promise<{ ok: boolean; message: string }> {
  const session = codexLoginSessions.get(socket);
  if (!session) {
    return { ok: false, message: "No active Codex login session. Click Codex Login first." };
  }

  let parsed: URL;
  try {
    parsed = new URL((callbackUrl || "").trim());
  } catch {
    return { ok: false, message: "Invalid callback URL." };
  }

  try {
    await fetch(parsed.toString(), {
      method: "GET",
      redirect: "manual",
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "unknown error";
    return { ok: false, message: `Failed to send callback to local login server: ${msg}` };
  }

  const result = await Promise.race([
    session.completion,
    new Promise<{ ok: boolean; message: string }>((resolve) => {
      setTimeout(() => resolve({ ok: false, message: "Codex login did not finish after callback." }), CODEX_LOGIN_FINISH_WAIT_MS);
    }),
  ]);

  codexLoginSessions.delete(socket);
  if (!session.child.killed && session.child.exitCode === null) {
    try {
      session.child.kill();
    } catch {
      // ignore
    }
  }
  return result;
}

async function runCodexSmokeTest(timeoutMs = 45_000): Promise<{ ok: boolean; message: string }> {
  const codexLaunch = await getCodexLaunchSpec();
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
        codexLaunch.command,
        [
          ...codexLaunch.prefixArgs,
          "exec",
          "--skip-git-repo-check",
          "--output-last-message",
          outputPath,
        ],
        {
          shell: false,
          windowsHide: true,
          env: codexLaunch.env,
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

function hasCodexAuthToken(): boolean {
  const codexHome = resolveProjectCodexHome();
  const authPath = path.resolve(codexHome, "auth.json");
  try {
    const raw = readFileSync(authPath, "utf8");
    const parsed = JSON.parse(raw) as {
      OPENAI_API_KEY?: unknown;
      tokens?: {
        access_token?: unknown;
        refresh_token?: unknown;
      };
    };

    const apiKeyDirect = typeof parsed.OPENAI_API_KEY === "string" ? parsed.OPENAI_API_KEY.trim() : "";
    const tokens = parsed.tokens ?? {};
    const accessToken = typeof tokens.access_token === "string" ? tokens.access_token.trim() : "";
    const refreshToken = typeof tokens.refresh_token === "string" ? tokens.refresh_token.trim() : "";
    return apiKeyDirect.length > 0 || accessToken.length > 0 || refreshToken.length > 0;
  } catch {
    return false;
  }
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
          try {
            const session = await startCodexLoginSession(socket);
            const authUrl = await session.waitForAuthUrl();
            const reply: ServerMessage = {
              type: "reply",
              success: true,
              code: 200,
              msg:
                `Open this URL to continue Codex login:\n${authUrl}\n\n` +
                "After login, paste the full callback URL and click Save Callback Token.",
            };
            socket.send(JSON.stringify(reply));
          } catch (error) {
            const msg = error instanceof Error ? error.message : "unknown error";
            const reply: ServerMessage = {
              type: "reply",
              success: false,
              code: 500,
              msg: `Unable to start Codex login: ${msg}`,
            };
            socket.send(JSON.stringify(reply));
          }
        }
        if (parsed && parsed.type === "codex-login-save-callback") {
          const loginResult = await completeCodexLoginWithCallback(socket, parsed.callbackUrl);
          if (!loginResult.ok) {
            const reply: ServerMessage = {
              type: "reply",
              success: false,
              code: 400,
              msg: loginResult.message,
            };
            socket.send(JSON.stringify(reply));
            socket.send(JSON.stringify(currentConfig()));
            return;
          }

          const smoke = await runCodexSmokeTest();
          const reply: ServerMessage = {
            type: "reply",
            success: smoke.ok,
            code: smoke.ok ? 200 : 500,
            msg: `Codex login completed via callback URL.\nCodex test response: ${smoke.message}`,
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
      const skipCache = Boolean((parsed as ClientMessage).skipCache);
      const result = await classifyAndCompile("queue-ui", message, stored.id, { skipCache });
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
        payload: result.payload,
        actions: result.uiActions,
        attachments: result.attachments,
      };
      socket.send(JSON.stringify(reply));
    });

    socket.on("close", () => {
      cleanupCodexLoginSession(socket);
      clients.delete(socket);
    });

    socket.on("error", (error: Error) => {
      const msg = error instanceof Error ? error.message : "unknown error";
      console.warn(`[ws] error: ${msg}`);
    });
  });
}
