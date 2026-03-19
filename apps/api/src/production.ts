import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(import.meta.dirname, "../../../.env") });

import { createApp } from "./app.js";
import { AudioJobService } from "./jobs.js";
import { PostgresJobStore } from "./storage-postgres.js";
import { SupabaseAudioStore } from "./storage-supabase.js";

const port = Number(process.env.PORT ?? 3000);
const supabaseUrl = getRequiredEnv("SUPABASE_URL");
const supabaseServiceRoleKey = getRequiredEnv("SUPABASE_SERVICE_ROLE_KEY");
const jobStore = new PostgresJobStore();
const audioStore = new SupabaseAudioStore(
  supabaseUrl,
  supabaseServiceRoleKey,
  process.env.SUPABASE_STORAGE_BUCKET ?? "audio",
);
const audioJobService = new AudioJobService({ jobStore, audioStore });

const app = createApp({
  audioJobService,
  jobStore,
  audioStore,
  recoverInterruptedJobsOnStartup: true,
  supabaseUrl,
  supabaseJwtSecret: process.env.SUPABASE_JWT_SECRET,
});

app.listen(port, () => {
  console.log(`Hear It API listening on http://0.0.0.0:${port}`);
});

function getRequiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} environment variable is not set.`);
  }

  return value;
}
