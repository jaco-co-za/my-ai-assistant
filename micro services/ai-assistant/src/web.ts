import type { BrokerResult } from "./messageBroker.js";
import { generalChat, getLlmProviderLabel } from "./ollamaClient.js";
import { promises as fs } from "node:fs";
import path from "node:path";

type PromptTemplate = {
  name?: string;
  version?: number;
  instructions: string | string[];
  output_schema?: Record<string, unknown>;
};

type WebBinary = {
  path: string;
  filename?: string;
  content_type?: string;
  purpose?: string;
};

type WebResponsePayload = {
  reply: string;
  binaries?: WebBinary[];
  follow_up_question?: string;
};

const WEB_RESPONSE_TIMEOUT_MS = Number(process.env.WEB_RESPONSE_TIMEOUT_MS ?? "") > 0
  ? Number(process.env.WEB_RESPONSE_TIMEOUT_MS)
  : 0;
const WEB_PROMPT_NAME = "web";
const promptCache = new Map<string, PromptTemplate>();
const WEB_RUNTIME_PREAMBLE = [
  "Use Codex internal web capabilities/tools to fulfill this web request end-to-end.",
  "Do not answer web tasks from theory only: execute the required web steps.",
  "Do not leave background processes running; finish the requested run before replying.",
  "Return ONLY the required JSON contract.",
].join("\n");

function normalizeInstructions(instructions: string | string[]): string {
  if (Array.isArray(instructions)) {
    return instructions.join("\n");
  }
  return instructions;
}

async function loadPromptTemplate(name: string): Promise<PromptTemplate> {
  const cached = promptCache.get(name);
  if (cached) {
    return cached;
  }
  const promptPath = path.resolve(process.cwd(), "prompts", `${name}.json`);
  const content = await fs.readFile(promptPath, "utf8");
  const parsed = JSON.parse(content) as PromptTemplate;
  promptCache.set(name, parsed);
  return parsed;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`web response timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

function inferContentType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return "application/octet-stream";
}

function parseWebResponse(raw: string): WebResponsePayload | null {
  if (!raw || !raw.trim()) {
    return null;
  }
  const tryParse = (input: string): WebResponsePayload | null => {
    try {
      const parsed = JSON.parse(input) as Record<string, unknown>;
      const reply = typeof parsed.reply === "string" ? parsed.reply.trim() : "";
      const followUpQuestion =
        typeof parsed.follow_up_question === "string" ? parsed.follow_up_question.trim() : "";
      const binariesRaw = Array.isArray(parsed.binaries) ? parsed.binaries : [];
      const binaries: WebBinary[] = binariesRaw
        .map((item) => (item && typeof item === "object" ? (item as Record<string, unknown>) : null))
        .filter((item): item is Record<string, unknown> => Boolean(item))
        .map((item) => {
          const pathValue = typeof item.path === "string" ? item.path.trim() : "";
          const filenameValue = typeof item.filename === "string" ? item.filename.trim() : "";
          const contentTypeValue = typeof item.content_type === "string" ? item.content_type.trim() : "";
          const purposeValue = typeof item.purpose === "string" ? item.purpose.trim() : "";
          return {
            path: pathValue,
            filename: filenameValue || undefined,
            content_type: contentTypeValue || undefined,
            purpose: purposeValue || undefined,
          };
        })
        .filter((item) => item.path.length > 0);

      if (!reply && !followUpQuestion) {
        return null;
      }
      return {
        reply,
        binaries,
        follow_up_question: followUpQuestion || undefined,
      };
    } catch {
      return null;
    }
  };

  const direct = tryParse(raw.trim());
  if (direct) {
    return direct;
  }

  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch && fenceMatch[1]) {
    const fenced = tryParse(fenceMatch[1].trim());
    if (fenced) {
      return fenced;
    }
  }

  const firstBrace = raw.indexOf("{");
  const lastBrace = raw.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const sliced = tryParse(raw.slice(firstBrace, lastBrace + 1).trim());
    if (sliced) {
      return sliced;
    }
  }

  // Try each balanced object segment and accept the first valid payload.
  const text = raw;
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== "{") {
      continue;
    }
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i += 1) {
      const ch = text[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === "\"") {
        inString = !inString;
        continue;
      }
      if (inString) {
        continue;
      }
      if (ch === "{") {
        depth += 1;
      } else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          const candidate = tryParse(text.slice(start, i + 1).trim());
          if (candidate) {
            return candidate;
          }
          break;
        }
      }
    }
  }

  return null;
}

async function buildBinaryAttachments(binaries: WebBinary[]): Promise<BrokerResult["attachments"]> {
  if (!binaries.length) {
    return undefined;
  }
  const attachments: NonNullable<BrokerResult["attachments"]> = [];
  for (const binary of binaries) {
    const normalized = binary.path.replaceAll("\\", path.sep).replaceAll("/", path.sep);
    const absolutePath = path.resolve(process.cwd(), normalized);
    try {
      const data = await fs.readFile(absolutePath);
      const filename = binary.filename && binary.filename.trim().length > 0
        ? binary.filename.trim()
        : path.basename(absolutePath);
      const contentType = binary.content_type && binary.content_type.trim().length > 0
        ? binary.content_type.trim()
        : inferContentType(filename);
      attachments.push({
        filename,
        contentType,
        dataBase64: data.toString("base64"),
      });
    } catch {
      // Ignore unreadable binaries and keep valid ones.
    }
  }
  return attachments.length > 0 ? attachments : undefined;
}

export async function handleWeb(uuid: string, message: string): Promise<BrokerResult> {
  const text = message.trim();
  if (!text) {
    return { success: false, code: 400, msg: "Empty web request.", uuid };
  }
  const provider = getLlmProviderLabel();
  if (provider !== "codex") {
    return {
      success: false,
      code: 400,
      msg: "Web requests are only supported when OpenAI Codex is enabled.",
      uuid,
    };
  }

  let instruction = "";
  try {
    const template = await loadPromptTemplate(WEB_PROMPT_NAME);
    const normalized = normalizeInstructions(template.instructions).trim();
    if (normalized) {
      instruction = normalized;
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : "unknown error";
    return {
      success: false,
      code: 500,
      msg: `Web prompt load failed: ${msg}`,
      uuid,
    };
  }
  if (!instruction) {
    return {
      success: false,
      code: 500,
      msg: "Web prompt is empty. Check prompts/web.json.",
      uuid,
    };
  }

  const prompt = `${WEB_RUNTIME_PREAMBLE}\n\n${instruction}\n\nUser request:\n${text}`;
  try {
    const rawReply = WEB_RESPONSE_TIMEOUT_MS > 0
      ? await withTimeout(generalChat(prompt), WEB_RESPONSE_TIMEOUT_MS)
      : await generalChat(prompt);
    const parsed = parseWebResponse(rawReply);
    if (!parsed) {
      const fallbackReply = (rawReply || "").trim();
      if (fallbackReply) {
        return {
          success: true,
          code: 200,
          msg: fallbackReply,
          followUpRoute: /\?\s*$/.test(fallbackReply) ? "web" : undefined,
          uuid,
        };
      }
      return {
        success: false,
        code: 502,
        msg:
          "Web request returned invalid JSON. Expected {\"reply\":\"string\",\"binaries\":[],\"follow_up_question\":\"string optional\"} from prompts/web.json contract.",
        uuid,
      };
    }
    const followUpQuestion = (parsed.follow_up_question ?? "").trim();
    if (followUpQuestion) {
      return {
        success: true,
        code: 200,
        msg: followUpQuestion,
        followUpRoute: "web",
        uuid,
      };
    }
    if (!parsed.reply || !parsed.reply.trim()) {
      return {
        success: false,
        code: 502,
        msg: "Web request returned no reply text.",
        uuid,
      };
    }
    const attachments = await buildBinaryAttachments(parsed.binaries ?? []);
    return { success: true, code: 200, msg: parsed.reply, attachments, uuid };
  } catch (error) {
    const msg = error instanceof Error ? error.message : "unknown error";
    return {
      success: false,
      code: 504,
      msg: `Web request timed out: ${msg}`,
      uuid,
    };
  }
}
