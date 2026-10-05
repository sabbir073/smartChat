# speech — the voice agent's ears and mouth

A self-hosted, CPU-only speech sidecar for the voice-call agent. One container does four things:

| Job | Engine | Model |
|---|---|---|
| Voice activity + endpointing | onnxruntime | Silero VAD v4 (sherpa-onnx build) |
| Spoken language ID (bn vs en) | speechbrain / torch CPU | VoxLingua107 ECAPA-TDNN |
| Speech to text, Bengali | sherpa-onnx | AI4Bharat IndicConformer-bn 120M (CTC) |
| Speech to text, English | sherpa-onnx | NVIDIA Parakeet-TDT 0.6B v3, int8 |
| Text to speech, Bengali | sherpa-onnx | Coqui VITS female (`bn_female`), piper bn_BD (`bn_bd`, 16 speakers) |
| Text to speech, English | sherpa-onnx | Kokoro v0.19 (`en_female`, `en_male`), piper LibriTTS-R (`en_piper`) |

It listens to a live 16 kHz (or 48 kHz) PCM stream over a WebSocket, tells the agent the moment
the caller starts and stops talking, identifies the language of each utterance, transcribes it
with the right model, and synthesises replies sentence by sentence over HTTP so playback starts
before the whole reply is rendered. Everything runs on CPU; the target is ~4 vCPU and ~3.5 GB RAM.

## Running it

```sh
# build
docker build -t getchat-speech infrastructure/speech

# first start downloads ~1.6 GB of models into the volume, then serves
docker run --rm -p 3010:3010 -v speech-models:/models -e SPEECH_TOKEN=change-me getchat-speech

curl -s localhost:3010/health
```

Locally, without Docker (Python 3.12 or 3.13):

```sh
cd infrastructure/speech
pip install -r requirements-dev.txt
export SPEECH_MODELS_DIR=$HOME/speech-models
python download_models.py          # idempotent; ~4 min on a fast link
python -m speech.server            # http://localhost:3010
pytest                             # unit tests only when SPEECH_MODELS_DIR is unset/empty
pytest -m models -s                # the end-to-end tests, with timings printed
python tools/make_samples.py --out ./samples   # one WAV per voice
```

The server answers `/health` with 503 while the models load (about 15 s) and refuses to start,
with the reason in the log, if a required model is missing or broken. `download_models.py`
checks sizes and SHA-256 digests, so a damaged or silently replaced upstream file is caught
before it is ever loaded.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3010` | Listen port (always `0.0.0.0`). |
| `SPEECH_TOKEN` | *(empty)* | When set, every request and WebSocket must send `Authorization: Bearer <token>`; `401` otherwise. `/health` stays open. |
| `SPEECH_MODELS_DIR` | `/models` | Where the models live (a volume). |
| `SPEECH_THREADS` | `4` | CPU budget: the inference thread pool has this many workers; each recogniser, the TTS voices and torch get `min(2, SPEECH_THREADS)` intra-op threads. |
| `SPEECH_MAX_SESSIONS` | `8` | Concurrent `/v1/listen` sessions; the handshake is refused with `503` beyond that. |
| `SPEECH_STT_FALLBACK` | *(empty)* | `omnilingual` downloads and loads Meta's Omnilingual ASR 300M CTC v2 (int8), used for Bengali if IndicConformer cannot be loaded. Not downloaded otherwise. |
| `SPEECH_DEFAULT_LANGUAGE` | `en` | The sticky language a session starts with when `start.sticky` is absent. |
| `SPEECH_PROVIDER` | `cpu` | sherpa-onnx execution provider; see *GPU later*. |
| `SPEECH_STT_BN_VARIANT` | `fp32` | `int8` quantises IndicConformer at download time (saves ~350 MB RSS; measured slower and one more error on the reference clips, see below). |
| `SPEECH_KOKORO_VARIANT` | `fp32` | `int8` downloads the int8 Kokoro instead (saves ~500 MB RSS; measured 2.5x *slower* on an AVX-512 Xeon, RTF 1.5, so not the default). |
| `SPEECH_VERIFY_CHECKSUMS` | `1` | `0` accepts an upstream re-upload whose SHA-256 differs (size is still checked). |
| `SPEECH_LOG_LEVEL` | `info` | JSON-lines log level. |

## API

All responses are JSON unless noted; errors are `{"error": "..."}` with a 4xx/5xx status and
never a stack trace.

### `GET /health`

```json
{"status":"ok","models":{"vad":true,"stt_bn":true,"stt_en":true,"lid":true,
 "tts":["bn_female","bn_bd","en_female","en_male","en_piper"]},
 "threads":4,"sessions":0,"maxSessions":8,"rssMb":2334,"loadSeconds":14.06}
```

`503` with `"status":"loading"` and a `missing` list until every model is loaded; `"status":"error"`
with the message if loading failed (the process then exits so the orchestrator restarts it).

### `GET /v1/voices`

```json
{"voices":[
 {"id":"bn_female","language":"bn","name":"Bengali female (studio)","speakers":1,"sampleRate":22050,"engine":"vits-coqui","licence":"Apache-2.0"},
 {"id":"bn_bd","language":"bn","name":"Bengali, Bangladesh (Piper, 16 speakers)","speakers":16,"sampleRate":22050,"engine":"vits-piper","licence":"CC-BY-SA-4.0 data / MIT"},
 {"id":"en_female","language":"en","name":"English female (Kokoro af_bella)","speakers":1,"sampleRate":24000,"engine":"kokoro","licence":"Apache-2.0"},
 {"id":"en_male","language":"en","name":"English male (Kokoro am_michael)","speakers":1,"sampleRate":24000,"engine":"kokoro","licence":"Apache-2.0"},
 {"id":"en_piper","language":"en","name":"English, US (Piper LibriTTS-R, 904 speakers)","speakers":904,"sampleRate":22050,"engine":"vits-piper","licence":"CC-BY-4.0 data / MIT"}]}
```

### `WS /v1/listen` — one socket per call leg

1. Client sends a JSON text frame:
   ```json
   {"type":"start","sampleRate":16000,"language":"auto","sticky":"en",
    "minSilenceMs":550,"minSpeechMs":250,"maxSpeechMs":30000,"prefixPaddingMs":300,"callId":"..."}
   ```
   Everything but `type` is optional, defaults as shown. `sampleRate` is 16000 or 48000 (48 kHz is
   resampled with libsoxr). `language` is `auto`, `bn` or `en`; `bn`/`en` force that recogniser and
   skip language ID. `sticky` is the language assumed until LID confidently says otherwise
   (default `SPEECH_DEFAULT_LANGUAGE`).
2. Server answers `{"type":"ready"}`.
3. Client sends binary frames of PCM16LE mono at `sampleRate`, any size (10–200 ms typical), and
   control text frames:
   - `{"type":"stop"}` — flush the open utterance, deliver the remaining transcripts, close (1000).
   - `{"type":"mute"}` / `{"type":"unmute"}` — while muted the audio is read but VAD is not run
     (an utterance open at mute time is ended first); the time base keeps running.
   - `{"type":"set","language":"bn"}` — set the sticky language now (in forced mode, switch the model).
4. Server sends JSON text frames (`t` = milliseconds of audio since the first frame):
   - `{"type":"speech_start","t":672}` as soon as the VAD opens — it does not wait for `minSpeechMs`.
   - `{"type":"speech_cancel","t":1312}` if that start turned out shorter than `minSpeechMs`
     (sent after 200 ms of silence, so a cough costs the agent only a short pause).
   - `{"type":"speech_end","t":6368,"durationMs":5120}` after `minSilenceMs` of silence.
   - `{"type":"transcript","text":"...","language":"bn","languageConfidence":1.0,"durationMs":5120,
     "latencyMs":1569,"lid":{"bn":1.0,"en":0.0},"model":"indicconformer-bn","t":6368,"startMs":672,"cut":false}`
     — always sent, with `"text":""` when the recogniser heard nothing. `latencyMs` is measured
     from the `speech_end` event to this frame (so the caller-perceived delay is `minSilenceMs` + it).
     `cut` is true for the pieces of an utterance longer than `maxSpeechMs`, which is cut and
     transcribed in pieces (each piece gets its own `speech_end`/`speech_start`).
   - `{"type":"error","message":"..."}` for problems that do not end the session (bad control
     frame, a failed recognition).

   Recognition policy in `auto` mode: after `speech_end`, LID and the sticky language's recogniser
   run in parallel; if LID puts the other language at ≥ 0.80 on an utterance ≥ 1 s, the other
   recogniser runs instead (started as soon as LID answers) and that language becomes sticky for
   the session. In forced mode `lid` is `{"bn":1,"en":0}`/`{"bn":0,"en":1}` and `languageConfidence` is 1.

   Handshake refusals carry an HTTP status (`401` bad token, `503` loading or `SPEECH_MAX_SESSIONS`
   reached). The first frame must be `start` within 10 s. If more than 10 s of audio is queued
   (the session has fallen behind real time) further audio frames are dropped — control frames
   never are — and the drop is logged.

### `POST /v1/tts` — chunked PCM

Request `{"text":"...","language":"bn"|"en","voice":null|"bn_female"|"bn_bd"|"en_female"|"en_male"|"en_piper",
"speakerId":0,"speed":1.0,"sampleRate":24000}` (`speed` 0.5–2.0; `sampleRate` one of 8000, 16000,
22050, 24000, 44100, 48000; `speakerId` applies to `bn_bd` (0–15) and `en_piper` (0–903)).

Response `200 audio/pcm`, PCM16LE mono at `sampleRate`, `Transfer-Encoding: chunked`, one chunk
per sentence so playback can start after the first sentence. Headers: `X-Sample-Rate`, `X-Voice`,
`X-Sentences`, `X-Cache: hit|miss` (hit = every sentence of this exact request was already
synthesised) and, only on a hit, `X-Duration-Ms`. Empty text (or text that is only emoji) is a
`200` with an empty body and `X-Sentences: 0`.

Text preprocessing before synthesis: markdown stripped (`**`, `_`, backticks, headings, bullets,
links keep their text), URLs → "our website" / "আমাদের ওয়েবসাইট", `#1500` → "number 1500" /
"নম্বর ১৫০০", emoji dropped, whitespace collapsed; split into sentences at `।`, `.`, `?`, `!` and
newlines (sentences ≥ 2 characters, capped at ~300 characters by splitting at commas); each
sentence split into runs of Bengali vs Latin script, each run synthesised by the voice for its
language (the requested voice for the request language, the default voice for the other), joined
with 120 ms of silence, with 160 ms between sentences. Bengali runs have every number spelled
out (`১৫০০` → "এক হাজার পাঁচশো", `৳250` → "দুইশো পঞ্চাশ টাকা", `12%` → "বারো শতাংশ", `1.5` →
"এক দশমিক পাঁচ", `10:30` → "দশটা ত্রিশ", phone numbers digit by digit); English runs keep digits
for the model and get `৳`/`BDT`/`Tk` written as "taka". Every run is loudness-matched (-22 dBFS
RMS, peak ≤ 0.95) so voices switching inside a sentence stay level. Synthesised runs are cached
per (voice, speaker, speed, normalised text) in an LRU of 200 entries / 50 MB, so greetings and
"one moment please" cost nothing after the first call.

### `POST /v1/tts/info`

Same request body; synthesises (and caches) without returning audio:
`{"sentences":[...],"units":[[{"voice","language","text"}...]...],"durationMs":9321,"cache":"hit|miss",...}`.

### `POST /v1/transcribe?language=auto|bn|en[&sticky=bn|en]`

Body: raw `audio/wav` (anything libsndfile reads, any rate, ≤ 32 MB, ≤ 10 min) or multipart with a
`file` part. Response
`{"text","language","languageConfidence","lid":{"bn","en"},"durationMs","latencyMs","model"}`.

## Logs

JSON lines on stdout. One line per utterance:

```json
{"at":"2026-10-05T14:40:21.675Z","level":"info","logger":"speech.listen","msg":"utterance","event":"utterance",
 "session":"a1b2c3d4","callId":"...","language":"bn","lid":{"bn":1.0,"en":0.0},"lidSkipped":false,"switched":true,
 "model":"indicconformer-bn","durationMs":5120,"latencyMs":1569,"modelMs":1560,
 "timings":{"lid_ms":423,"stt_ms":876,"switch_stt_ms":462},"chars":78,"cut":false}
```

plus `session_start`/`session_end` (frames, dropped frames, utterances), `tts` (sentences, cache
hits, synthesis ms, first-chunk ms), `transcribe`, `model_loaded` with RSS after each model, and
`ready` with the total load time and RSS.

## Measured (sandbox: 2 vCPU Xeon @ 2.1 GHz, AVX-512; the target has 4 vCPUs of a faster EPYC Genoa, so inference numbers should improve and the parallel LID + STT step more so)

- Load: 12.7–15.2 s for everything (five runs); RSS after load 2.33–2.45 GB (Parakeet int8
  ~770 MB, IndicConformer fp32 ~540 MB, torch + ECAPA ~300 MB, Kokoro fp32 ~400 MB, the three
  VITS voices ~280 MB). With the optional Omnilingual fallback loaded: 2.69 GB.
- STT, 2 intra-op threads, warm, one call at a time: IndicConformer-bn RTF 0.056–0.067 (386–462 ms
  for a 6.9 s clip); Parakeet-TDT int8 RTF 0.10–0.14 (492–942 ms for 3.9–6.9 s). IndicConformer
  int8 (opt-in): RTF ~0.08, 350 MB less RSS, one more error on the three reference clips.
- LID (ECAPA, 2 torch threads, on at most 4 s of the utterance): 380–550 ms. Two seconds of
  audio already give a confident, correct answer on all five test clips; one second does not.
- TTS RTF (2 threads): `bn_bd` 0.08–0.10, `en_piper` 0.07–0.09, `bn_female` 0.43–0.58, Kokoro
  `en_female`/`en_male` 0.54–0.66. First chunk of a three-sentence reply: piper voices
  160–320 ms, Coqui and Kokoro 1.0–1.8 s; a cache hit returns the whole reply in ~65–85 ms.
- WebSocket end to end (clip streamed in 20 ms frames + 1 s silence, sticky `en`, LID switches to
  `bn`, so three model calls run): transcript 1.57–1.79 s after `speech_end`, one session at a
  time. Four sessions ending their utterances at the same moment on this 2-vCPU box: 1.9–3.3 s
  each, all transcripts correct, no drops.

## Model licences and attribution

| Model | Licence | Source |
|---|---|---|
| IndicConformer-bn (AI4Bharat) | MIT | ONNX export via huggingface.co/trysem/indicconformer-120m-onnx; packaged for sherpa-onnx by `download_models.py` |
| Parakeet-TDT 0.6B v3 (NVIDIA) | CC-BY-4.0 — *"This service uses NVIDIA Parakeet-TDT-0.6B-v3 (https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3), licensed under CC-BY-4.0, converted by k2-fsa/sherpa-onnx."* | github.com/k2-fsa/sherpa-onnx releases, `asr-models` |
| Omnilingual ASR 300M CTC v2 (Meta), optional | Apache-2.0 | huggingface.co/Edison2ST/sherpa-onnx-omnilingual-asr-1600-languages-ctc-v2 |
| VoxLingua107 ECAPA-TDNN (speechbrain) | Apache-2.0 | huggingface.co/speechbrain/lang-id-voxlingua107-ecapa |
| Silero VAD | MIT | github.com/snakers4/silero-vad (sherpa-onnx build) |
| Coqui VITS Bengali female (`bn_female`) | Apache-2.0 | github.com/k2-fsa/sherpa-onnx releases, `tts-models` (vits-coqui-bn-custom_female) |
| piper bn_BD-google-medium (`bn_bd`) | voice data CC-BY-SA-4.0 (OpenSLR 37) + CMU Indic licence; piper code MIT | huggingface.co/rhasspy/piper-voices |
| piper en_US-libritts_r-medium (`en_piper`) | LibriTTS-R data CC-BY-4.0; piper code MIT | github.com/k2-fsa/sherpa-onnx releases, `tts-models` |
| Kokoro v0.19 (`en_female`, `en_male`) | Apache-2.0 | github.com/k2-fsa/sherpa-onnx releases, `tts-models` |
| espeak-ng data (piper/Kokoro phonemisation) | GPL-3.0 (data files, used unmodified by the sherpa-onnx wheel) | shipped inside the piper tarball |
| sherpa-onnx, onnxruntime | Apache-2.0 / MIT | pip |

## GPU later

sherpa-onnx takes an execution provider per model; this service passes `SPEECH_PROVIDER` to every
recogniser and voice. To move to a GPU: use a CUDA base image, replace `sherpa-onnx` with the
CUDA build of the wheel (`pip install sherpa-onnx==<ver> -f https://k2-fsa.github.io/sherpa/onnx/cuda.html`,
plus the matching onnxruntime-gpu/cuDNN), set `SPEECH_PROVIDER=cuda`, and raise
`SPEECH_MAX_SESSIONS`. The VAD and LID are cheap enough to stay on CPU (LID would need
`run_opts={"device":"cuda"}` in `speech/lid.py` if ever desired). Nothing in the API changes.

## Layout

```
infrastructure/speech/
  Dockerfile, entrypoint.sh, requirements.txt, requirements-dev.txt, pytest.ini
  download_models.py        fills SPEECH_MODELS_DIR, verifies, packages IndicConformer and piper bn_BD
  speech/
    server.py               FastAPI routes (health, voices, listen, tts, tts/info, transcribe)
    session.py              the /v1/listen protocol state machine
    engine.py               model registry, loading, the recognition policy
    vad.py                  Silero VAD wrapper + the endpointer (speech_start/cancel/end, max cut)
    stt.py, lid.py, tts.py  sherpa-onnx recognisers, speechbrain LID, the TTS pipeline + cache
    audio.py                PCM/float conversion, libsoxr resampling, WAV decoding
    text/                   clean.py (markdown/URLs/emoji), sentences.py (sentences, script runs),
                            bn_numbers.py (Bengali number words)
    config.py, layout.py, logs.py
  tools/make_samples.py     one WAV per voice through the real pipeline
  tests/                    90 unit tests (no models) + 19 end-to-end tests (`-m models`)
```
