import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(import.meta.dirname, "../../../.env") });

import { randomUUID } from "node:crypto";

import { createApp } from "./app.js";
import { AudioJobService } from "./jobs.js";
import {
  FinalizationRepairer,
  HlsRetentionCleaner,
  JobReconciler,
  startMaintenanceWorker,
} from "./maintenance.js";
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
const maintenanceLeaseOwner =
  process.env.MAINTENANCE_LEASE_OWNER?.trim() ||
  `api-${process.pid}-${randomUUID().slice(0, 8)}`;

const app = createApp({
  audioJobService,
  jobStore,
  audioStore,
  recoverInterruptedJobsOnStartup: false,
  supabaseUrl,
  supabaseJwtSecret: process.env.SUPABASE_JWT_SECRET,
});

void audioJobService
  .init()
  .then(() =>
    startMaintenanceWorker({
      jobStore,
      leaseOwner: maintenanceLeaseOwner,
      intervalMs: Number(process.env.MAINTENANCE_INTERVAL_MS ?? 60_000),
      leaseDurationMs: Number(process.env.MAINTENANCE_LEASE_MS ?? 55_000),
      services: [
        new FinalizationRepairer({ jobStore, audioStore }),
        new JobReconciler({ jobStore, audioStore }),
        new HlsRetentionCleaner({ jobStore, audioStore }),
      ],
      onError: (error) => {
        console.error("Maintenance worker failed", error);
      },
    }),
  )
  .catch((error) => {
    console.error("Failed to start maintenance worker", error);
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
