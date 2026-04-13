import * as Sentry from "@sentry/node";

import type { JobEventType } from "./job-events.js";
import type { JobStore } from "./storage.js";

export interface JobEventRecorder {
  record(
    type: JobEventType,
    payload?: Record<string, unknown> | null,
  ): Promise<void>;
}

export async function createJobEventRecorder(
  jobStore: JobStore,
  jobId: string,
): Promise<JobEventRecorder | null> {
  if (!jobStore.appendEvent) {
    return null;
  }

  let nextSequence = await resolveInitialSequence(jobStore, jobId);

  return {
    async record(type, payload = null) {
      nextSequence += 1;

      try {
        await jobStore.appendEvent?.(jobId, {
          type,
          payload,
          sequenceNumber: nextSequence,
          occurredAt: new Date().toISOString(),
        });
      } catch (error) {
        Sentry.captureException(error, {
          tags: {
            operation: "job_event_append",
            eventType: type,
            jobId,
          },
        });
      }
    },
  };
}

async function resolveInitialSequence(
  jobStore: JobStore,
  jobId: string,
): Promise<number> {
  if (!jobStore.listEvents) {
    return fallbackSequenceSeed();
  }

  try {
    const events = await jobStore.listEvents(jobId);
    const lastSequence = events[events.length - 1]?.sequenceNumber ?? 0;
    return lastSequence > 0 ? lastSequence : fallbackSequenceSeed();
  } catch (error) {
    Sentry.captureException(error, {
      tags: {
        operation: "job_event_list",
        jobId,
      },
    });
    return fallbackSequenceSeed();
  }
}

function fallbackSequenceSeed(): number {
  return Date.now() * 1_000 + Number(process.hrtime.bigint() % 1_000n);
}
