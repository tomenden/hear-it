import { waitUntil } from "@vercel/functions";

import { createApp } from "./app.js";
import { AudioJobService } from "./jobs.js";
import { VercelJobStore, VercelAudioStore } from "./storage-vercel.js";

const audioStore = new VercelAudioStore();
const jobStore = new VercelJobStore();
const audioJobService = new AudioJobService({ jobStore, audioStore });

const app = createApp({
  audioJobService,
  onBackgroundWork: (promise) => waitUntil(promise),
});

export default app;
