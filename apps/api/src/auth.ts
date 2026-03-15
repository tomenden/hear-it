import { jwtVerify } from "jose";
import type { Request, Response, NextFunction } from "express";

export function createAuthMiddleware(jwtSecret?: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    // Pass-through mode when no secret is configured (gradual rollout)
    if (!jwtSecret) {
      next();
      return;
    }

    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      res.status(401).json({ error: "Missing or invalid Authorization header." });
      return;
    }

    const token = authHeader.slice(7);

    try {
      const secret = new TextEncoder().encode(jwtSecret);
      const { payload } = await jwtVerify(token, secret, {
        algorithms: ["HS256"],
      });

      if (!payload.sub) {
        res.status(401).json({ error: "Token missing subject claim." });
        return;
      }

      req.userId = payload.sub;
      next();
    } catch {
      res.status(401).json({ error: "Invalid or expired token." });
    }
  };
}
