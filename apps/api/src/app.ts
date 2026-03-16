import * as Sentry from "@sentry/node";
import express from "express";
import rateLimit from "express-rate-limit";
import { join } from "node:path";
import { z } from "zod";

import { ArticleTooLongError, extractArticle } from "./extractor.js";
import { createAuthMiddleware } from "./auth.js";
import { AudioJobService } from "./jobs.js";
import type { AudioStore, JobStore } from "./storage.js";
import { AVAILABLE_VOICES } from "./tts.js";
import type { AudioJob, CreateAudioJobInput, ExtractArticleInput } from "./types.js";

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV ?? "development",
  });
}

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
  jobStore: JobStore;
  audioStore: AudioStore;
  /** Called with a promise that should keep running after the response is sent. */
  onBackgroundWork?: (promise: Promise<void>) => void;
  /** Whether to serve the local /audio directory (local dev only). */
  serveStaticAudio?: string;
  /** Base URL for audio files — included in /api/config for clients that resolve relative URLs. */
  audioPublicBaseUrl?: string;
  /** Supabase project URL — used to verify JWTs via JWKS (ECC/RSA). */
  supabaseUrl?: string;
  /** Supabase JWT secret for HS256 verification (fallback if supabaseUrl is not set). */
  supabaseJwtSecret?: string;
}

// Rate limiting uses the default in-memory store. On Vercel serverless, the
// counter resets on each cold start — acceptable for launch but not watertight.
const rateLimitMessage = { error: "Too many requests. Please try again later." };

const jobCreationLimiter = rateLimit({
  windowMs: 60_000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: rateLimitMessage,
});

const writeEndpointLimiter = rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: rateLimitMessage,
});

export function createApp(options: CreateAppOptions) {
  const { audioJobService, jobStore, audioStore, onBackgroundWork } = options;
  const app = express();
  const serializeJob = (job: AudioJob) => ({
    ...job,
    audioDownloadPath:
      job.status === "completed" && audioJobService.hasNarrationAudio(job.id)
        ? audioJobService.buildNarrationDownloadPath(job.id)
        : null,
  });
  const errorResponse = (
    error: unknown,
    fallbackMessage: string,
  ): {
    status: number;
    body: Record<string, unknown>;
  } => {
    if (error instanceof ArticleTooLongError) {
      return {
        status: error.statusCode,
        body: {
          error: error.message,
          code: error.code,
          details: error.details,
        },
      };
    }

    return {
      status: 422,
      body: {
        error: error instanceof Error ? error.message : fallbackMessage,
      },
    };
  };

  void audioJobService.init().then(() => audioJobService.requeueInterruptedJobs());

  app.use(express.json({ limit: "1mb" }));

  // In local dev, serve audio files from disk and the web prototype.
  // In production (Vercel), audio URLs are absolute blob URLs.
  if (options.serveStaticAudio) {
    app.use("/audio", express.static(options.serveStaticAudio));
    const publicDir = join(import.meta.dirname, "..", "public");
    app.use(express.static(publicDir));
  }

  app.get("/health", async (_req, res) => {
    const dependencies: Record<string, "ok" | "error"> = {
      database: "ok",
      storage: "ok",
    };

    try {
      await jobStore.check();
    } catch {
      dependencies.database = "error";
    }

    try {
      await audioStore.check();
    } catch {
      dependencies.storage = "error";
    }

    const ok = dependencies.database === "ok" && dependencies.storage === "ok";
    res.json({ ok, dependencies });
  });

  app.get("/api/config", (_req, res) => {
    res.json({
      provider: audioJobService.getProviderName(),
      openAiConfigured: Boolean(process.env.OPENAI_API_KEY?.trim()),
      ...(options.audioPublicBaseUrl && { audioPublicBaseUrl: options.audioPublicBaseUrl }),
    });
  });

  // Auth middleware — applied to all /api routes below this point.
  // /health and /api/config above remain public.
  app.use("/api", createAuthMiddleware({
    supabaseUrl: options.supabaseUrl,
    jwtSecret: options.supabaseJwtSecret,
  }));

  app.get("/api/voices", (_req, res) => {
    res.json({
      voices: audioJobService.getAvailableVoices(),
    });
  });

  app.post("/api/voice-previews", writeEndpointLimiter, async (req, res) => {
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

  app.post("/api/extract", writeEndpointLimiter, async (req, res) => {
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
      const response = errorResponse(error, "Article extraction failed.");
      res.status(response.status).json(response.body);
    }
  });

  app.post("/api/jobs", jobCreationLimiter, async (req, res) => {
    const parsedBody = createAudioJobSchema.safeParse(req.body);

    if (!parsedBody.success) {
      res.status(400).json({
        error: "Invalid request body.",
        issues: parsedBody.error.flatten(),
      });
      return;
    }

    try {
      const job = await audioJobService.createJob(
        parsedBody.data as CreateAudioJobInput,
        req.userId,
      );
      res.status(202).json({ job: serializeJob(job) });

      // Process the job in the background — on Vercel this uses waitUntil,
      // in local dev the promise just runs detached.
      const work = audioJobService.processJob(job.id);
      if (onBackgroundWork) {
        onBackgroundWork(work);
      } else {
        void work;
      }
    } catch (error) {
      const response = errorResponse(error, "Failed to create audio job.");
      res.status(response.status).json(response.body);
    }
  });

  app.get("/api/jobs", async (req, res) => {
    res.json({ jobs: (await audioJobService.listJobs(req.userId)).map(serializeJob) });
  });

  app.get("/api/jobs/:jobId", async (req, res) => {
    const job = await audioJobService.getJob(req.params.jobId, req.userId);

    if (!job) {
      res.status(404).json({ error: "Job not found." });
      return;
    }

    res.json({ job: serializeJob(job) });
  });

  app.get("/api/jobs/:jobId/audio", async (req, res) => {
    const job = await audioJobService.getJob(req.params.jobId, req.userId);

    if (!job) {
      res.status(404).json({ error: "Job not found." });
      return;
    }

    if (job.status !== "completed") {
      res.status(409).json({ error: "Narration audio is not ready yet." });
      return;
    }

    const audio = audioJobService.getNarrationAudio(job.id);
    if (!audio) {
      res.status(404).json({
        error: "Narration audio is no longer available for download. Re-create the narration to fetch it again.",
      });
      return;
    }

    res.setHeader("Content-Type", audio.contentType);
    res.setHeader("Cache-Control", "private, no-store, max-age=0");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="narration-${job.id}.mp3"`,
    );
    res.send(audio.buffer);
  });

  app.delete("/api/jobs/:jobId", writeEndpointLimiter, async (req, res) => {
    const deleted = await audioJobService.deleteJob(req.params.jobId as string, req.userId);

    if (!deleted) {
      res.status(404).json({ error: "Job not found." });
      return;
    }

    res.json({ ok: true });
  });

  Sentry.setupExpressErrorHandler(app);

  return app;
}
