#!/bin/sh
# Fill the models volume (idempotent, skips what is present, exits non-zero if a required model
# cannot be made available), then hand the process over to the server so signals reach uvicorn.
set -eu

echo "speech: checking models in ${SPEECH_MODELS_DIR:-/models}"
python /app/download_models.py

exec python -m speech.server
