import { config } from "dotenv";
import { resolve } from "node:path";

// Load .env from the repo root (monorepo convention)
config({ path: resolve(import.meta.dirname, "../../../.env") });
config({ path: resolve(import.meta.dirname, "../../../.env.local"), override: true });

import { createApp } from "./app.js";
import { AudioJobService } from "./jobs.js";
import { resolveLocalServerConfig } from "./local-server-config.js";
import { FileJobStore, FileAudioStore } from "./storage-fs.js";

const port = Number(process.env.PORT ?? 3000);
const localServerConfig = resolveLocalServerConfig();
const audioStore = new FileAudioStore();
const jobStore = new FileJobStore();
const audioJobService = new AudioJobService({ jobStore, audioStore });

const app = createApp({
  audioJobService,
  jobStore,
  audioStore,
  recoverInterruptedJobsOnStartup: true,
  serveStaticAudio: audioStore.getOutputDir(),
  audioPublicBaseUrl: "/audio",
  supabaseUrl: localServerConfig.supabaseUrl,
  supabaseJwtSecret: localServerConfig.supabaseJwtSecret,
  allowJwtSecretFallback: localServerConfig.allowJwtSecretFallback,
});

app.listen(port, () => {
  console.log(`Hear It API listening on http://localhost:${port}`);
});
