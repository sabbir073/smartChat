# The speech sidecar: VAD, language ID, Bengali/English speech-to-text and text-to-speech on
# CPU, behind one HTTP/WebSocket service (speech/server.py). Built from the plain Python image:
# every engine is a pip wheel (sherpa-onnx bundles its own ONNX Runtime, soundfile its own
# libsndfile, torch its own OpenMP), so no apt packages are needed. Models are not baked in;
# the entrypoint downloads them into the /models volume on first start (download_models.py).
FROM python:3.12-slim-bookworm

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    # torch is used for language ID only and is pinned to two threads in code; this keeps its
    # OpenMP pool from sizing itself to the host's cores before that happens.
    OMP_NUM_THREADS=2 \
    # speechbrain/huggingface_hub must never go to the network at runtime: every file it needs
    # is in /models already.
    HF_HUB_OFFLINE=1 \
    HF_HUB_DISABLE_TELEMETRY=1

WORKDIR /app
COPY requirements.txt ./
# The torch CPU wheel comes from the PyTorch index named inside requirements.txt.
RUN pip install -r requirements.txt \
    && rm -rf /root/.cache

COPY speech ./speech
COPY download_models.py entrypoint.sh ./
RUN chmod +x entrypoint.sh

# A fixed uid so a bind-mounted models directory can be chowned to it on the host; the service
# writes only to /models (downloads) and reads everything else.
RUN groupadd -r -g 10001 speech && useradd --no-log-init -r -u 10001 -g speech -d /home/speech -m speech \
    && mkdir -p /models && chown speech:speech /models
USER speech
ENV PORT=3010 \
    HOME=/home/speech \
    SPEECH_MODELS_DIR=/models \
    SPEECH_THREADS=4 \
    SPEECH_MAX_SESSIONS=8
VOLUME ["/models"]
EXPOSE 3010
# The start period covers a cold first start: ~1.6 GB of model downloads before the server
# even binds, then ~15 s of loading.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15m --retries=3 \
  CMD python -c "import os,urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:%s/health' % os.environ.get('PORT','3010'), timeout=4).status == 200 else 1)"
ENTRYPOINT ["./entrypoint.sh"]
