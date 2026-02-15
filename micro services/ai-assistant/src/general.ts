import type { BrokerResult } from "./messageBroker.js";
import { generalChat } from "./ollamaClient.js";
import { buildLearningsContext, processLearnings } from "./learnings.js";

export async function handleGeneral(uuid: string, message: string): Promise<BrokerResult> {
  const lowered = message.toLowerCase();
  const hasExternalRef =
    lowered.includes("homeassistant") || lowered.includes("hass") || lowered.includes("email");
  let msg = "No response";
  const resolveReply = (reply: string): string => {
    if (!reply) {
      return "No response";
    }
    try {
      const parsed = JSON.parse(reply) as Record<string, unknown>;
      if (typeof parsed.reply === "string" && parsed.reply.trim().length > 0) {
        return parsed.reply.trim();
      }
      return reply;
    } catch {
      return reply;
    }
  };

  if (!hasExternalRef) {
    const learningResult = await processLearnings({ prompt: message });
    if (learningResult.handled && learningResult.message) {
      return { success: true, code: 200, msg: learningResult.message, uuid };
    }
    const context = buildLearningsContext(message, learningResult.learnings);
    const contextText =
      context.length > 0 ? `Additional context:\n${context.map((item) => `- ${item}`).join("\n")}\n\n` : "";
    const reply = await generalChat(`${contextText}${message}`);
    msg = resolveReply(reply);
    return { success: true, code: 200, msg, uuid };
  }

  const reply = await generalChat(message);
  msg = resolveReply(reply);
  return { success: true, code: 200, msg, uuid };
}
