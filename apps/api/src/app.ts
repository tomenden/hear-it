import express from "express";
import { join } from "node:path";
import { z } from "zod";

import { extractArticle } from "./extractor.js";
import { AudioJobService } from "./jobs.js";
import { AVAILABLE_VOICES } from "./tts.js";
import type { CreateAudioJobInput, ExtractArticleInput } from "./types.js";

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

export interface CreateAppOptions {
  audioJobService: AudioJobService;
  /** Called with a promise that should keep running after the response is sent. */
  onBackgroundWork?: (promise: Promise<void>) => void;
  /** Whether to serve the local /audio directory (local dev only). */
  serveStaticAudio?: string;
  /** Base URL for audio files — included in /api/config for clients that resolve relative URLs. */
  audioPublicBaseUrl?: string;
}

export function createApp(options: CreateAppOptions) {
  const { audioJobService, onBackgroundWork } = options;
  const app = express();

  void audioJobService.init().then(() => audioJobService.requeueInterruptedJobs());

  app.use(express.json({ limit: "1mb" }));

  // In local dev, serve audio files from disk and the web prototype.
  // In production (Vercel), audio URLs are absolute blob URLs.
  if (options.serveStaticAudio) {
    app.use("/audio", express.static(options.serveStaticAudio));
    const publicDir = join(import.meta.dirname, "..", "public");
    app.use(express.static(publicDir));
  }

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/api/config", (_req, res) => {
    res.json({
      provider: audioJobService.getProviderName(),
      openAiConfigured: Boolean(process.env.OPENAI_API_KEY?.trim()),
      ...(options.audioPublicBaseUrl && { audioPublicBaseUrl: options.audioPublicBaseUrl }),
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
      const article = await extractArticle(parsedBody.data as ExtractArticleInput);
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
      const job = await audioJobService.createJob(parsedBody.data as CreateAudioJobInput);
      res.status(202).json({ job });

      // Process the job in the background — on Vercel this uses waitUntil,
      // in local dev the promise just runs detached.
      const work = audioJobService.processJob(job.id);
      if (onBackgroundWork) {
        onBackgroundWork(work);
      } else {
        void work;
      }
    } catch (error) {
      res.status(422).json({
        error: error instanceof Error ? error.message : "Failed to create audio job.",
      });
    }
  });

  app.get("/api/jobs", async (_req, res) => {
    res.json({ jobs: await audioJobService.listJobs() });
  });

  app.get("/api/jobs/:jobId", async (req, res) => {
    const job = await audioJobService.getJob(req.params.jobId);

    if (!job) {
      res.status(404).json({ error: "Job not found." });
      return;
    }

    res.json({ job });
  });

  app.delete("/api/jobs/:jobId", async (req, res) => {
    const deleted = await audioJobService.deleteJob(req.params.jobId);

    if (!deleted) {
      res.status(404).json({ error: "Job not found." });
      return;
    }

    res.json({ ok: true });
  });

  return app;
}
