import { describe, expect, it } from "vitest";

import { isBlobMissingError } from "./storage-vercel.js";

describe("vercel storage helpers", () => {
  it("treats blob not-found responses as healthy for storage checks", () => {
    expect(isBlobMissingError(Object.assign(new Error("missing"), { name: "BlobNotFoundError" }))).toBe(true);
    expect(isBlobMissingError(new Error("Vercel Blob: The requested blob does not exist"))).toBe(true);
    expect(isBlobMissingError(new Error("connect ECONNREFUSED"))).toBe(false);
  });
});
