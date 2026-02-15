import type { Request, Response, NextFunction } from "express";

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const expected = process.env.AUTH ?? "";

  if (expected.trim() === "") {
    console.log("AUTH bypassed (empty AUTH env)");
    next();
    return;
  }

  const incoming = req.header("Authorization") ?? "";

  if (incoming === expected) {
    console.log("AUTH success");
    next();
    return;
  }

  console.log("AUTH failed");
  res.status(401).json({ error: "Unauthorized" });
}
