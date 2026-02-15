import { Router } from "express";
import { authMiddleware } from "../middleware/auth";
import { entryPoint, summarizeStatusToMessage } from "../homeAssistant";
const router = Router();

function actionResultHasError(data: unknown): boolean {
  if (!data || typeof data !== "object") {
    return false;
  }
  const record = data as { isError?: boolean; content?: Array<{ isError?: boolean }> };
  if (record.isError === true) {
    return true;
  }
  if (Array.isArray(record.content)) {
    return record.content.some((item) => item?.isError === true);
  }
  return false;
}

router.get("/health", (_req, res) => {
  console.log("GET /health");
  res.status(200).json({ status: "ok" });
});

router.post("/requests", authMiddleware, async (req, res, next) => {
  try {
    console.log("[http] POST /requests", JSON.stringify(req.body));

    const body = req.body as Record<string, unknown>;
    const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";
    const result = typeof body?.result === "string" ? body.result.trim() : "";

    if (prompt === "" || result === "") {
      res.status(400).json({
        error: "Invalid payload",
        required: ["prompt", "result"],
      });
      return;
    }

    const assistantResponse = await entryPoint(body);
    console.log("[http] Assistant response received", assistantResponse ? "yes" : "no");
    if (assistantResponse?.kind === "message") {
      res.status(200).send(assistantResponse.message);
      return;
    }
    if (assistantResponse?.kind === "query") {
      const statusMap = Object.fromEntries(
        assistantResponse.entities.map((e) => [e.entity_id, e.state])
      );
      const skipSummary =
        String(process.env.SKIP_SUMMARY || "").toLowerCase() === "true";
      if (skipSummary) {
        res.status(200).send(`Status: ${JSON.stringify(statusMap)}`);
        return;
      }
      const message = await summarizeStatusToMessage(
        { prompt, result },
        statusMap as Record<string, string>
      );
      if (message) {
        res.status(200).send(message);
        return;
      }
      res.status(200).send(`Status: ${JSON.stringify(statusMap)}`);
      return;
    }

    const actionOk =
      assistantResponse?.kind === "action" &&
      assistantResponse.actionResult?.ok === true &&
      !actionResultHasError(assistantResponse.actionResult?.data);

    const fallbackMessage = actionOk ? "The request completed successfully" : "The request failed";
    const finalMessage =
      assistantResponse?.kind === "action" && assistantResponse.finalMessage
        ? assistantResponse.finalMessage
        : fallbackMessage;

    res.status(200).send(finalMessage);
  } catch (err) {
    next(err);
  }
});

export default router;
