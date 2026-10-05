#!/bin/sh
# Fill the models volume (idempotent, skips what is present, exits non-zero if a required model
# cannot be made available), then hand the process over to the server so signals reach uvicorn.
set -eu

# Cap glibc's per-thread heaps (also set in the image; repeated here for a bare `docker run`
# with its own environment). See speech/memory.py for why.
export MALLOC_ARENA_MAX="${MALLOC_ARENA_MAX:-2}"

echo "speech: checking models in ${SPEECH_MODELS_DIR:-/models}"
python /app/download_models.py

exec python -m speech.server
