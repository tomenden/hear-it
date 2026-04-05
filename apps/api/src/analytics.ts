import { PostHog } from "posthog-node";

let client: PostHog | null = null;

function getClient(): PostHog | null {
  if (client) return client;

  const apiKey = process.env.POSTHOG_API_KEY;
  if (!apiKey) return null;

  client = new PostHog(apiKey, {
    host: process.env.POSTHOG_HOST || "https://us.i.posthog.com",
    flushAt: 20,
    flushInterval: 10_000,
  });

  return client;
}

export function trackEvent(
  event: string,
  properties: Record<string, unknown> = {},
): void {
  try {
    getClient()?.capture({
      distinctId: "server",
      event,
      properties,
    });
  } catch {
    // Analytics should never break the app
  }
}

export async function shutdownAnalytics(): Promise<void> {
  try {
    await client?.shutdown();
  } catch {
    // Ignore shutdown errors
  }
}
