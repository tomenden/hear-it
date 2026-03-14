import express from "express";
import { join } from "node:path";
import { z } from "zod";

import { extractArticle } from "./extractor.js";
import { AudioJobService } from "./jobs.js";
import { AVAILABLE_VOICES } from "./tts.js";

export const extractRequestSchema = z.object({
  url: z.string().url(),
  html: z.string().min(1).optional(),
});

export const createAudioJobSchema = extractRequestSchema.extend({
  speechOptions: z
    .object({
      voice: z.enum(AVAILABLE_VOICES).optional(),
    })
    .optional(),
});

const voicePreviewSchema = z.object({
  voice: z.enum(AVAILABLE_VOICES),
});

export function createApp(options?: { audioJobService?: AudioJobService }) {
  const app = express();
  const audioJobService = options?.audioJobService ?? new AudioJobService();
  const publicDir = join(import.meta.dirname, "..", "public");
  void audioJobService.init().then(() => audioJobService.requeueInterruptedJobs());

  app.use(express.json({ limit: "1mb" }));
  app.use("/audio", express.static(audioJobService.getAudioOutputDir()));
  app.use(express.static(publicDir));

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/api/config", (_req, res) => {
    res.json({
      provider: audioJobService.getProviderName(),
      audioPublicBaseUrl: audioJobService.getAudioPublicBaseUrl(),
      openAiConfigured: Boolean(process.env.OPENAI_API_KEY?.trim()),
    });
  });

  app.get("/api/voices", (_req, res) => {
    res.json({
      voices: audioJobService.getAvailableVoices(),
    });
  });

  app.post("/api/voice-previews", async (req, res) => {
    const parsedBody = voicePreviewSchema.safeParse(req.body);

    if (!parsedBody.success) {
      res.status(400).json({
        error: "Invalid request body.",
        issues: parsedBody.error.flatten(),
      });
      return;
    }

    try {
      const preview = await audioJobService.getOrCreateVoicePreview(parsedBody.data.voice);
      res.json({ preview });
    } catch (error) {
      res.status(422).json({
        error: error instanceof Error ? error.message : "Failed to generate voice preview.",
      });
    }
  });

  app.post("/api/extract", async (req, res) => {
    const parsedBody = extractRequestSchema.safeParse(req.body);

    if (!parsedBody.success) {
      res.status(400).json({
        error: "Invalid request body.",
        issues: parsedBody.error.flatten(),
      });
      return;
    }

    try {
      const article = await extractArticle(parsedBody.data);
      res.json({ article });
    } catch (error) {
      res.status(422).json({
        error:
          error instanceof Error ? error.message : "Article extraction failed.",
      });
    }
  });

  app.post("/api/jobs", async (req, res) => {
    const parsedBody = createAudioJobSchema.safeParse(req.body);

    if (!parsedBody.success) {
      res.status(400).json({
        error: "Invalid request body.",
        issues: parsedBody.error.flatten(),
      });
      return;
    }

    try {
      const job = await audioJobService.createJob(parsedBody.data);
      res.status(202).json({ job });
    } catch (error) {
      res.status(422).json({
        error: error instanceof Error ? error.message : "Failed to create audio job.",
      });
    }
  });

  app.get("/api/jobs", (_req, res) => {
    res.json({ jobs: audioJobService.listJobs() });
  });

  app.get("/api/jobs/:jobId", (req, res) => {
    const job = audioJobService.getJob(req.params.jobId);

    if (!job) {
      res.status(404).json({ error: "Job not found." });
      return;
    }

    res.json({ job });
  });

  return app;
}
