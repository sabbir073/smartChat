#!/bin/sh
# The AI container's entrypoint: start Ollama, make sure the two models are present, load the chat
# model into memory, then hand over to the server process.
#
# The models are named by AI_CHAT_MODEL and AI_EMBED_MODEL. The pull is skipped when the model is
# already on the volume, so a restart with no internet still comes up; a first boot with no
# internet cannot, and says so. Loading ("warming") the chat model at start matters: a 2B model
# takes tens of seconds to come off disk on a CPU box, and a visitor should not be the one waiting
# for that. The embedding model is warmed by the worker's first health check, because the CLI has
# no embed command and the image has no curl.
set -eu

: "${AI_CHAT_MODEL:?AI_CHAT_MODEL is required}"
: "${AI_EMBED_MODEL:?AI_EMBED_MODEL is required}"
export OLLAMA_HOST="${OLLAMA_HOST:-0.0.0.0:11434}"
# Whatever loads stays loaded. The server reads this; the warm-up below relies on it.
export OLLAMA_KEEP_ALIVE="${OLLAMA_KEEP_ALIVE:--1}"

ollama serve &
SERVER_PID=$!

# Wait for the API, but not forever.
i=0
until ollama list >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -gt 60 ]; then
    echo "ai: ollama did not start within 60s" >&2
    exit 1
  fi
  sleep 1
done

ensure_model() {
  model="$1"
  if ollama show "$model" >/dev/null 2>&1; then
    echo "ai: $model is present"
  else
    echo "ai: pulling $model"
    ollama pull "$model"
  fi
}

ensure_model "$AI_CHAT_MODEL"
ensure_model "$AI_EMBED_MODEL"

echo "ai: loading $AI_CHAT_MODEL"
echo "Reply with the single word ready." | ollama run "$AI_CHAT_MODEL" >/dev/null 2>&1 || true
echo "ai: ready ($AI_CHAT_MODEL, $AI_EMBED_MODEL)"

wait "$SERVER_PID"
