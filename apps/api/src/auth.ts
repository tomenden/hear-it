import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Request, Response, NextFunction } from "express";

export interface AuthMiddlewareOptions {
  /** Supabase project URL — used to fetch JWKS for ECC/RSA token verification. */
  supabaseUrl?: string;
  /** Legacy HS256 shared secret (fallback if supabaseUrl is not set). */
  jwtSecret?: string;
}

export function createAuthMiddleware(options: AuthMiddlewareOptions) {
  const { supabaseUrl, jwtSecret } = options;

  // Build the key source: prefer JWKS (asymmetric), fall back to HS256 shared secret
  let keySource: Parameters<typeof jwtVerify>[1] | null = null;
  let algorithms: string[] | undefined;

  if (supabaseUrl) {
    const jwksUrl = new URL("/auth/v1/.well-known/jwks.json", supabaseUrl);
    keySource = createRemoteJWKSet(jwksUrl);
    // Let jose auto-detect the algorithm from the JWKS
    algorithms = undefined;
  } else if (jwtSecret) {
    keySource = new TextEncoder().encode(jwtSecret);
    algorithms = ["HS256"];
  }

  return async (req: Request, res: Response, next: NextFunction) => {
    // Pass-through mode when neither secret nor URL is configured (gradual rollout)
    if (!keySource) {
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
      const { payload } = await jwtVerify(token, keySource, {
        ...(algorithms && { algorithms }),
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
