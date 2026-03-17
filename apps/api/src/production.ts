import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(import.meta.dirname, "../../../.env") });

import { createApp } from "./app.js";
import { AudioJobService } from "./jobs.js";
import { PostgresJobStore } from "./storage-postgres.js";
import { SupabaseAudioStore } from "./storage-supabase.js";

const port = Number(process.env.PORT ?? 3000);
const jobStore = new PostgresJobStore();
const audioStore = new SupabaseAudioStore(
  process.env.SUPABASE_URL ?? "",
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
  process.env.SUPABASE_STORAGE_BUCKET ?? "audio",
);
const audioJobService = new AudioJobService({ jobStore, audioStore });

const app = createApp({
  audioJobService,
  jobStore,
  audioStore,
  recoverInterruptedJobsOnStartup: true,
  supabaseUrl: process.env.SUPABASE_URL,
  supabaseJwtSecret: process.env.SUPABASE_JWT_SECRET,
});

app.listen(port, () => {
  console.log(`Hear It API listening on http://0.0.0.0:${port}`);
});
