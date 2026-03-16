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

  // Build a verify function: prefer JWKS (asymmetric), fall back to HS256 shared secret.
  // Using per-strategy closures avoids jose's overload resolution issues with union key types.
  type VerifyFn = (token: string) => Promise<string>;
  let doVerify: VerifyFn | null = null;

  if (supabaseUrl) {
    const JWKS = createRemoteJWKSet(new URL("/auth/v1/.well-known/jwks.json", supabaseUrl));
    doVerify = async (token) => {
      const { payload } = await jwtVerify(token, JWKS);
      if (!payload.sub) throw new Error("Token missing subject claim.");
      return payload.sub;
    };
  } else if (jwtSecret) {
    const secret = new TextEncoder().encode(jwtSecret);
    doVerify = async (token) => {
      const { payload } = await jwtVerify(token, secret, { algorithms: ["HS256"] });
      if (!payload.sub) throw new Error("Token missing subject claim.");
      return payload.sub;
    };
  }

  return async (req: Request, res: Response, next: NextFunction) => {
    // Pass-through mode when neither secret nor URL is configured (gradual rollout)
    if (!doVerify) {
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
      req.userId = await doVerify(token);
      next();
    } catch {
      res.status(401).json({ error: "Invalid or expired token." });
    }
  };
}
