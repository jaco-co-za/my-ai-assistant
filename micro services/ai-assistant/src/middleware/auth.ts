import type { Request, Response, NextFunction } from "express";

const TRUE_VALUES = new Set(["1", "true", "yes", "y", "on"]);

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const skipAuth = TRUE_VALUES.has((process.env.SKIP_AUTH ?? "").toLowerCase());
  if (skipAuth) {
    next();
    return;
  }

  const expectedToken = process.env.WEBHOOK_BEARER_TOKEN ?? "";
  const chronicleToken = process.env.CHRONICLE_BEARER_TOKEN ?? "";
  if (!expectedToken) {
    res.status(500).json({ error: "Server auth token not configured" });
    return;
  }

  const header = req.header("authorization") ?? "";
  const [scheme, token] = header.split(" ");
  const isBearer = scheme?.toLowerCase() === "bearer";
  if (isBearer && chronicleToken && token === chronicleToken) {
    next();
    return;
  }
  if (!isBearer || token !== expectedToken) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  next();
}
