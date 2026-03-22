#!/usr/bin/env bash
# Fetch the deployed URL for the hear-it-api Render service (or a preview for a given branch).
#
# Usage:
#   ./scripts/get-render-url.sh                  # production URL
#   ./scripts/get-render-url.sh <branch-name>    # preview URL for that branch
#
# Required env var:
#   RENDER_API_KEY  — your Render API key (https://render.com/docs/api#section/Authentication)

set -euo pipefail

BRANCH="${1:-}"
SERVICE_NAME="hear-it-api"
API="https://api.render.com/v1"

if [[ -z "${RENDER_API_KEY:-}" ]]; then
  echo "Error: RENDER_API_KEY is not set." >&2
  exit 1
fi

# Fetch matching services (name-based filter isn't supported, so we fetch all and filter)
RESPONSE=$(curl -sf \
  -H "Authorization: Bearer $RENDER_API_KEY" \
  -H "Accept: application/json" \
  "$API/services?limit=100")

if [[ -z "$RESPONSE" ]]; then
  echo "Error: Empty response from Render API." >&2
  exit 1
fi

if [[ -z "$BRANCH" ]]; then
  # Return the URL of the main (non-preview) service
  URL=$(echo "$RESPONSE" | \
    jq -r --arg name "$SERVICE_NAME" \
      '[.[] | select(.service.name == $name and .service.type == "web_service")][0].service.serviceDetails.url // empty')
else
  # Return the preview URL for the given branch
  # Render names preview services as "<service-name>-pr-<number>" but also exposes the branch
  # in the repo field.  We match on branch name via the repo commit ref.
  URL=$(echo "$RESPONSE" | \
    jq -r --arg name "$SERVICE_NAME" --arg branch "$BRANCH" \
      '[.[] | select(
          (.service.name | startswith($name)) and
          .service.type == "web_service" and
          (.service.repo.branch // "" | test($branch; "i"))
        )][0].service.serviceDetails.url // empty')
fi

if [[ -z "$URL" ]]; then
  echo "Error: Could not find a Render service URL for service='$SERVICE_NAME' branch='${BRANCH:-<production>}'." >&2
  echo "Make sure previewsEnabled is true in render.yaml and a deploy has completed." >&2
  exit 1
fi

echo "$URL"
