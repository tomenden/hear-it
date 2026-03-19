import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  uploadMock,
  getPublicUrlMock,
  removeMock,
  listMock,
  fromMock,
  createClientMock,
} = vi.hoisted(() => {
  const uploadMock = vi.fn();
  const getPublicUrlMock = vi.fn();
  const removeMock = vi.fn();
  const listMock = vi.fn();
  const fromMock = vi.fn(() => ({
    upload: uploadMock,
    getPublicUrl: getPublicUrlMock,
    remove: removeMock,
    list: listMock,
  }));
  const createClientMock = vi.fn(() => ({
    storage: {
      from: fromMock,
    },
  }));

  return {
    uploadMock,
    getPublicUrlMock,
    removeMock,
    listMock,
    fromMock,
    createClientMock,
  };
});

vi.mock("@supabase/supabase-js", () => ({
  createClient: createClientMock,
}));

import { SupabaseAudioStore } from "./storage-supabase.js";

describe("SupabaseAudioStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", vi.fn());
    uploadMock.mockResolvedValue({ error: null });
    getPublicUrlMock.mockReturnValue({
      data: { publicUrl: "https://supabase.example/storage/v1/object/public/audio/narrations/test.mp3" },
    });
    removeMock.mockResolvedValue({ error: null });
    listMock.mockResolvedValue({ data: [], error: null });
  });

  it("uploads audio and returns the public URL", async () => {
    const store = new SupabaseAudioStore(
      "https://supabase.example",
      "service-role-key",
      "audio",
    );

    const url = await store.put(
      "narrations/test.mp3",
      Buffer.from("ID3DATA"),
      "audio/mpeg",
      { overwrite: true },
    );

    expect(createClientMock).toHaveBeenCalledWith(
      "https://supabase.example",
      "service-role-key",
    );
    expect(fromMock).toHaveBeenCalledWith("audio");
    expect(uploadMock).toHaveBeenCalledWith(
      "narrations/test.mp3",
      expect.any(Buffer),
      { contentType: "audio/mpeg", upsert: true },
    );
    expect(url).toBe(
      "https://supabase.example/storage/v1/object/public/audio/narrations/test.mp3",
    );
  });

  it("checks whether a key exists via HEAD on the public URL", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    const store = new SupabaseAudioStore(
      "https://supabase.example",
      "service-role-key",
      "audio",
    );

    await expect(store.head("narrations/test.mp3")).resolves.toBe(
      "https://supabase.example/storage/v1/object/public/audio/narrations/test.mp3",
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://supabase.example/storage/v1/object/public/audio/narrations/test.mp3",
      { method: "HEAD" },
    );

    fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }));
    await expect(store.head("narrations/missing.mp3")).resolves.toBeNull();
  });

  it("deletes keys and performs a lightweight connectivity check", async () => {
    const store = new SupabaseAudioStore(
      "https://supabase.example",
      "service-role-key",
      "audio",
    );

    await store.delete("narrations/test.mp3");
    await store.check();

    expect(removeMock).toHaveBeenCalledWith(["narrations/test.mp3"]);
    expect(listMock).toHaveBeenCalledWith("", { limit: 1 });
  });
});
