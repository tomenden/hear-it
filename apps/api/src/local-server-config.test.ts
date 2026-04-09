import { describe, expect, it } from "vitest";

import { resolveLocalServerConfig } from "./local-server-config.js";

describe("resolveLocalServerConfig", () => {
  it("keeps pass-through auth when no local auth environment is configured", () => {
    expect(resolveLocalServerConfig({})).toEqual({
      supabaseUrl: undefined,
      supabaseJwtSecret: undefined,
      allowJwtSecretFallback: false,
    });
  });

  it("uses the production Supabase project URL as a JWKS fallback when only a local JWT secret is configured", () => {
    expect(
      resolveLocalServerConfig({
        SUPABASE_JWT_SECRET: "test-secret",
      }),
    ).toEqual({
      supabaseUrl: "https://qnvsdeshcxjnzlgrrhxd.supabase.co",
      supabaseJwtSecret: "test-secret",
      allowJwtSecretFallback: true,
    });
  });

  it("prefers an explicit SUPABASE_URL when provided", () => {
    expect(
      resolveLocalServerConfig({
        SUPABASE_URL: "https://custom.supabase.co",
        SUPABASE_JWT_SECRET: "test-secret",
      }),
    ).toEqual({
      supabaseUrl: "https://custom.supabase.co",
      supabaseJwtSecret: "test-secret",
      allowJwtSecretFallback: false,
    });
  });
});
