import type { VercelRequest, VercelResponse } from "@vercel/node";

// Lazy-load the Express app to avoid top-level initialization issues.
let app: ((req: VercelRequest, res: VercelResponse) => void) | null = null;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!app) {
    const mod = await import("../apps/api/src/vercel.js");
    app = mod.default;
  }
  return app(req, res);
}
