#!/usr/bin/env bash
set -euo pipefail

SESSION_NAME="${1:-hear-it-codex}"

if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
  echo "Session already exists: $SESSION_NAME"
else
  tmux new-session -d -s "$SESSION_NAME" -c "$(pwd)"
  echo "Created session: $SESSION_NAME"
fi

echo "Attach with: tmux attach -t $SESSION_NAME"
