import * as Sentry from "@sentry/node";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import type { AudioStore, AudioStorePutOptions } from "./storage.js";

export class SupabaseAudioStore implements AudioStore {
  private readonly client: SupabaseClient;
  private readonly bucket: string;

  constructor(
    supabaseUrl: string,
    supabaseServiceRoleKey: string,
    bucket = "audio",
  ) {
    if (!supabaseUrl) {
      throw new Error("SUPABASE_URL environment variable is not set.");
    }
    if (!supabaseServiceRoleKey) {
      throw new Error("SUPABASE_SERVICE_ROLE_KEY environment variable is not set.");
    }

    this.client = createClient(supabaseUrl, supabaseServiceRoleKey);
    this.bucket = bucket;
  }

  async check(): Promise<void> {
    const { error } = await this.bucketClient().list("", { limit: 1 });
    if (error) {
      captureStorageFailure("supabase_check", error, { bucket: this.bucket });
      throw error;
    }
  }

  async put(
    key: string,
    data: Buffer,
    contentType = "audio/mpeg",
    options?: AudioStorePutOptions,
  ): Promise<string> {
    const { error } = await this.bucketClient().upload(key, data, {
      contentType,
      upsert: options?.overwrite ?? false,
    });
    if (error) {
      captureStorageFailure("supabase_put", error, {
        bucket: this.bucket,
        key,
        overwrite: options?.overwrite ?? false,
      });
      throw error;
    }

    return this.publicUrl(key);
  }

  async head(key: string): Promise<string | null> {
    const url = this.publicUrl(key);

    try {
      const response = await fetch(url, { method: "HEAD" });
      if (response.status === 404) {
        return null;
      }
      if (!response.ok) {
        throw new Error(`Unexpected storage HEAD status ${response.status} for ${key}`);
      }
      return url;
    } catch (error) {
      captureStorageFailure("supabase_head", error, { bucket: this.bucket, key });
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    const { error } = await this.bucketClient().remove([key]);
    if (error) {
      captureStorageFailure("supabase_delete", error, { bucket: this.bucket, key });
      throw error;
    }
  }

  private bucketClient() {
    return this.client.storage.from(this.bucket);
  }

  private publicUrl(key: string): string {
    return this.bucketClient().getPublicUrl(key).data.publicUrl;
  }
}

function captureStorageFailure(
  operation: string,
  error: unknown,
  extra?: Record<string, unknown>,
) {
  Sentry.captureException(error, {
    tags: {
      operation,
      layer: "storage",
    },
    extra,
  });
}
