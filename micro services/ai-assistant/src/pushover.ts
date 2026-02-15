const DEFAULT_PUSHOVER_URL = "https://api.pushover.net/1/messages.json";
const DEFAULT_TIMEOUT_MS = 15_000;

function resolvePushoverUrl(raw?: string): string {
  const value = (raw || "").trim();
  if (!value) {
    return DEFAULT_PUSHOVER_URL;
  }
  if (value.startsWith("http://") || value.startsWith("https://")) {
    return value;
  }
  return `https://${value}`;
}

function getTimeoutMs(raw?: string): number {
  const parsed = Number(raw ?? "");
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return DEFAULT_TIMEOUT_MS;
}

export async function sendPushoverNotification(message: string): Promise<void> {
  const token = (process.env.PUSHOVER_API_TOKEN ?? "").trim();
  const user = (process.env.PUSHOVER_USER_KEY ?? "").trim();
  const device = (process.env.PUSHOVER_DEVICE ?? "").trim();
  const url = resolvePushoverUrl(process.env.PUSHOVER_API_URL);
  const timeoutMs = getTimeoutMs(process.env.PUSHOVER_TIMEOUT_MS);
  const body = new URLSearchParams();
  body.set("token", token);
  body.set("user", user);
  body.set("message", message);
  if (device) {
    body.set("device", device);
  }

  if (!token || !user) {
    throw new Error("Pushover is not configured (missing PUSHOVER_API_TOKEN or PUSHOVER_USER_KEY)");
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "unknown error";
    throw new Error(`Pushover request failed: ${msg}`);
  }

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Pushover ${response.status} ${response.statusText}: ${text}`);
  }

  try {
    const parsed = JSON.parse(text) as { status?: number; errors?: unknown };
    if (parsed.status !== 1) {
      const errors = Array.isArray(parsed.errors) ? parsed.errors.join(", ") : "unknown error";
      throw new Error(`Pushover rejected request: ${errors}`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Pushover rejected request:")) {
      throw error;
    }
    // Non-JSON or unexpected response body is treated as success if HTTP status is OK.
  }
}

