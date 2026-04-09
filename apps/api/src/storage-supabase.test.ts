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
      data: { publicUrl: "https://supabase.example/storage/v1/object/public/audio/jobs/test.mp3" },
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
      "jobs/test.mp3",
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
      "jobs/test.mp3",
      expect.any(Buffer),
      { contentType: "audio/mpeg", upsert: true },
    );
    expect(url).toBe(
      "https://supabase.example/storage/v1/object/public/audio/jobs/test.mp3",
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

    await expect(store.head("jobs/test.mp3")).resolves.toBe(
      "https://supabase.example/storage/v1/object/public/audio/jobs/test.mp3",
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://supabase.example/storage/v1/object/public/audio/jobs/test.mp3",
      { method: "HEAD" },
    );

    fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }));
    await expect(store.head("jobs/missing.mp3")).resolves.toBeNull();
  });

  it("deletes keys and performs a lightweight connectivity check", async () => {
    const store = new SupabaseAudioStore(
      "https://supabase.example",
      "service-role-key",
      "audio",
    );

    await store.delete("jobs/test.mp3");
    await store.check();

    expect(removeMock).toHaveBeenCalledWith(["jobs/test.mp3"]);
    expect(listMock).toHaveBeenCalledWith("", { limit: 1 });
  });

  it("recursively deletes nested prefixes for append-only HLS batches", async () => {
    listMock
      .mockResolvedValueOnce({
        data: [
          {
            name: "playlist.m3u8",
            id: "playlist-id",
            updated_at: "2026-04-09T00:00:00.000Z",
            created_at: "2026-04-09T00:00:00.000Z",
            last_accessed_at: null,
            metadata: { size: 123 },
          },
          {
            name: "segments",
            id: null,
            updated_at: null,
            created_at: null,
            last_accessed_at: null,
            metadata: null,
          },
          {
            name: "tmp",
            id: null,
            updated_at: null,
            created_at: null,
            last_accessed_at: null,
            metadata: null,
          },
        ],
        error: null,
      })
      .mockResolvedValueOnce({
        data: [
          {
            name: "batch-0000",
            id: null,
            updated_at: null,
            created_at: null,
            last_accessed_at: null,
            metadata: null,
          },
        ],
        error: null,
      })
      .mockResolvedValueOnce({
        data: [
          {
            name: "init.mp4",
            id: "init-id",
            updated_at: "2026-04-09T00:00:00.000Z",
            created_at: "2026-04-09T00:00:00.000Z",
            last_accessed_at: null,
            metadata: { size: 321 },
          },
          {
            name: "chunk-0000.m4s",
            id: "segment-id",
            updated_at: "2026-04-09T00:00:00.000Z",
            created_at: "2026-04-09T00:00:00.000Z",
            last_accessed_at: null,
            metadata: { size: 456 },
          },
        ],
        error: null,
      })
      .mockResolvedValueOnce({
        data: [
          {
            name: "chunk-0000.mp3",
            id: "tmp-id",
            updated_at: "2026-04-09T00:00:00.000Z",
            created_at: "2026-04-09T00:00:00.000Z",
            last_accessed_at: null,
            metadata: { size: 789 },
          },
        ],
        error: null,
      });

    const store = new SupabaseAudioStore(
      "https://supabase.example",
      "service-role-key",
      "audio",
    );

    await store.deletePrefix("jobs/job-123");

    expect(listMock).toHaveBeenNthCalledWith(1, "jobs/job-123", { limit: 100, offset: 0 });
    expect(listMock).toHaveBeenNthCalledWith(
      2,
      "jobs/job-123/segments",
      { limit: 100, offset: 0 },
    );
    expect(listMock).toHaveBeenNthCalledWith(
      3,
      "jobs/job-123/segments/batch-0000",
      { limit: 100, offset: 0 },
    );
    expect(listMock).toHaveBeenNthCalledWith(
      4,
      "jobs/job-123/tmp",
      { limit: 100, offset: 0 },
    );
    expect(removeMock).toHaveBeenCalledWith([
      "jobs/job-123/playlist.m3u8",
      "jobs/job-123/segments/batch-0000/init.mp4",
      "jobs/job-123/segments/batch-0000/chunk-0000.m4s",
      "jobs/job-123/tmp/chunk-0000.mp3",
    ]);
  });
});
