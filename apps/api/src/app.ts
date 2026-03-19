import * as Sentry from "@sentry/node";
import express from "express";
import rateLimit from "express-rate-limit";
import { join } from "node:path";
import { z } from "zod";

import {
  ArticleFetchTimeoutError,
  ArticleTooLongError,
  extractArticle,
} from "./extractor.js";
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
      language: z.string().min(1).max(64).optional(),
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
  /** Whether to run interrupted-job recovery when the process starts. */
  recoverInterruptedJobsOnStartup?: boolean;
  /** Whether to serve the local /audio directory (local dev only). */
  serveStaticAudio?: string;
  /** Base URL for audio files — included in /api/config for clients that resolve relative URLs. */
  audioPublicBaseUrl?: string;
  /** Supabase project URL — used to verify JWTs via JWKS (ECC/RSA). */
  supabaseUrl?: string;
  /** Supabase JWT secret for HS256 verification (fallback if supabaseUrl is not set). */
  supabaseJwtSecret?: string;
  /** Preview-only auth escape hatch for direct API debugging with locally minted test JWTs. */
  allowJwtSecretFallback?: boolean;
}

// Rate limiting uses the default in-memory store. It is intentionally simple for
// the current single-service deployment, but counters reset on process restarts.
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
  const { audioJobService, jobStore, audioStore } = options;
  const app = express();
  const serializeJob = (job: AudioJob) => ({
    ...job,
    audioDownloadPath: null,
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

    if (error instanceof ArticleFetchTimeoutError) {
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

  if (options.recoverInterruptedJobsOnStartup ?? false) {
    void audioJobService.init().then(() => audioJobService.requeueInterruptedJobs());
  }

  app.use(express.json({ limit: "1mb" }));

  // Local dev serves disk-backed audio files and the static prototype.
  // Production audio is resolved from the configured storage backend.
  if (options.serveStaticAudio) {
    app.use("/audio", express.static(options.serveStaticAudio));
    const publicDir = join(import.meta.dirname, "..", "public");
    app.use(express.static(publicDir));
  }

  app.get("/privacy", (_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Hear It — Privacy Policy</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; max-width: 640px; margin: 40px auto; padding: 0 20px; line-height: 1.6; color: #222; }
  h1 { color: #3D8A5A; }
  h2 { margin-top: 1.5em; }
</style>
</head>
<body>
<h1>Hear It — Privacy Policy</h1>
<p><strong>Effective date:</strong> March 19, 2026</p>

<h2>What Hear It Does</h2>
<p>Hear It converts web articles into audio so you can listen on the go. You sign in with your email, paste a link, and the app generates a spoken version of the article.</p>

<h2>Data We Collect</h2>
<ul>
  <li><strong>Account info</strong> — your email address, used solely for authentication (managed by Supabase Auth).</li>
  <li><strong>Article URLs</strong> — the links you submit, used to fetch and convert articles. We store the URL and extracted text on our server while the audio job is active.</li>
  <li><strong>Generated audio</strong> — stored on your device so you can listen offline. The audio is generated server-side and downloaded to your device; we do not retain it on our servers after delivery.</li>
  <li><strong>Analytics events</strong> — anonymous product-interaction data (e.g. screens viewed, features used) sent to PostHog to help us improve the app. No personally identifiable information is included.</li>
  <li><strong>Crash &amp; performance data</strong> — sent to Sentry so we can fix bugs. This may include device model and OS version but not personal content.</li>
</ul>

<h2>Data We Do Not Collect</h2>
<ul>
  <li>We do not track you across other apps or websites.</li>
  <li>We do not sell, rent, or share your data with third parties for advertising.</li>
  <li>We do not use your data to build advertising profiles.</li>
</ul>

<h2>Third-Party Services</h2>
<ul>
  <li><strong>Supabase</strong> — authentication and database hosting.</li>
  <li><strong>OpenAI</strong> — text-to-speech generation. Article text is sent to OpenAI's API to produce audio. See <a href="https://openai.com/policies/privacy-policy">OpenAI's privacy policy</a>.</li>
  <li><strong>PostHog</strong> — anonymous product analytics.</li>
  <li><strong>Sentry</strong> — error and performance monitoring.</li>
  <li><strong>Render</strong> — server hosting.</li>
</ul>

<h2>Data Retention</h2>
<p>Your account and generated audio persist until you delete them. You can delete individual articles from the app at any time. If you want your account fully removed, contact us.</p>

<h2>Your Rights</h2>
<p>You can request access to, correction of, or deletion of your personal data at any time by emailing us.</p>

<h2>Contact</h2>
<p>Questions? Email <a href="mailto:tom.enden@gmail.com">tom.enden@gmail.com</a>.</p>

<h2>Changes</h2>
<p>We may update this policy from time to time. The latest version will always be available at this URL.</p>
</body>
</html>`);
  });

  app.get("/health", async (_req, res) => {
    const dependencies: Record<string, "ok" | "error"> = {
      database: "ok",
      storage: "ok",
    };
    const dependencyErrors: Record<string, string | null> = {
      database: null,
      storage: null,
    };

    try {
      await jobStore.check();
    } catch (error) {
      dependencies.database = "error";
      dependencyErrors.database = error instanceof Error ? error.message : String(error);
    }

    try {
      await audioStore.check();
    } catch (error) {
      dependencies.storage = "error";
      dependencyErrors.storage = error instanceof Error ? error.message : String(error);
    }

    const ok = dependencies.database === "ok" && dependencies.storage === "ok";
    res.json({ ok, dependencies, dependencyErrors });
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
    allowJwtSecretFallback: options.allowJwtSecretFallback,
  }));

  // Set Sentry user context after auth so errors are associated with the user.
  app.use("/api", (req, _res, next) => {
    if (req.userId) {
      Sentry.setUser({ id: req.userId });
    }
    next();
  });

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

      void audioJobService.processJob(job.id);
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
