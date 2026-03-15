import "dotenv/config";

import { createApp } from "./app.js";
import { AudioJobService } from "./jobs.js";
import { FileJobStore, FileAudioStore } from "./storage-fs.js";

const port = Number(process.env.PORT ?? 3000);
const audioStore = new FileAudioStore();
const jobStore = new FileJobStore();
const audioJobService = new AudioJobService({ jobStore, audioStore });

const app = createApp({
  audioJobService,
  jobStore,
  audioStore,
  serveStaticAudio: audioStore.getOutputDir(),
  audioPublicBaseUrl: "/audio",
  supabaseJwtSecret: process.env.SUPABASE_JWT_SECRET,
});

app.listen(port, () => {
  console.log(`Hear It API listening on http://localhost:${port}`);
});
