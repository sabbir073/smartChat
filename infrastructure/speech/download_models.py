#!/usr/bin/env python3
"""
Fill the models directory (SPEECH_MODELS_DIR, default /models) before the server starts.

Every model this service uses is a public, ungated download; nothing is baked into the image,
so the image stays small and the volume carries the ~2 GB of weights across restarts. Each
artifact is fetched only when it is not already in place, checked against the byte size and the
SHA-256 we recorded when it was first verified (set SPEECH_VERIFY_CHECKSUMS=0 to accept an
upstream re-upload at your own risk - the GitHub "asr-models"/"tts-models" releases are rolling
and k2-fsa has replaced files in them before), unpacked, and where upstream ships a model that
sherpa-onnx cannot load as-is (IndicConformer, the piper bn_BD voice) packaged into the form
sherpa-onnx needs. The script is idempotent: a second run on a complete directory does nothing
but print what it found.

Exit status is non-zero, with a plain explanation, when a required model cannot be made
available. The entrypoint runs this before uvicorn, so a broken download never produces a
half-working server.

Usage: python download_models.py [--models-dir DIR] [--fallback omnilingual] [--only NAME ...]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sys
import tarfile
import time
import urllib.error
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from speech.config import Settings  # noqa: E402
from speech.layout import (  # noqa: E402
    COQUI_BN_DIR,
    KOKORO_DIR,
    KOKORO_INT8_DIR,
    OMNILINGUAL_DIR,
    PARAKEET_DIR,
    PIPER_EN_DIR,
    ModelPaths,
)

GITHUB_ASR = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models"
GITHUB_TTS = "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models"
HF = "https://huggingface.co"

USER_AGENT = "getchat-speech/1.0 (+https://getchat.site)"
CHUNK = 1 << 20
RETRIES = 4


# --- fetching -------------------------------------------------------------------------------------


class DownloadError(RuntimeError):
    pass


def log(message: str) -> None:
    print(f"download_models: {message}", flush=True)


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(CHUNK), b""):
            digest.update(block)
    return digest.hexdigest()


def fetch(candidates: tuple[tuple[str, int | None, str | None], ...], dest: Path, verify: bool) -> None:
    """
    Stream one URL (trying the fallbacks in turn) to `dest`, through a `.part` file so an
    interrupted download is never mistaken for a finished one. Each candidate carries its own
    expected size and digest: size is always checked when known, the digest when known and
    verification is on.
    """
    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_name(dest.name + ".part")
    last_error: Exception | None = None
    for url, size, sha256 in candidates:
        for attempt in range(1, RETRIES + 1):
            try:
                _stream(url, part)
                actual_size = part.stat().st_size
                if size is not None and actual_size != size:
                    raise DownloadError(f"{url}: expected {size} bytes, got {actual_size}")
                if sha256 is not None and verify:
                    actual_sha = sha256_of(part)
                    if actual_sha != sha256:
                        raise DownloadError(
                            f"{url}: SHA-256 mismatch (expected {sha256}, got {actual_sha}). Upstream replaced the file; review it, then update the manifest or set SPEECH_VERIFY_CHECKSUMS=0."
                        )
                part.replace(dest)
                return
            except DownloadError as error:
                # A wrong size or digest is not transient: do not hammer the same URL again.
                last_error = error
                log(f"  {error}")
                part.unlink(missing_ok=True)
                break
            except (urllib.error.URLError, OSError, TimeoutError) as error:
                last_error = error
                log(f"  attempt {attempt}/{RETRIES} failed for {url}: {error}")
                part.unlink(missing_ok=True)
                time.sleep(min(30, 2**attempt))
    raise DownloadError(f"could not download {dest.name}: {last_error}")


def _stream(url: str, part: Path) -> None:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    started = time.monotonic()
    with urllib.request.urlopen(request, timeout=60) as response, part.open("wb") as out:
        total = response.headers.get("Content-Length")
        expected = int(total) if total and total.isdigit() else None
        done = 0
        next_report = 100 * CHUNK
        while True:
            block = response.read(CHUNK)
            if not block:
                break
            out.write(block)
            done += len(block)
            if done >= next_report:
                pct = f" ({100 * done // expected}%)" if expected else ""
                log(f"  {part.name}: {done >> 20} MB{pct}")
                next_report += 100 * CHUNK
    log(f"  fetched {part.name}: {done >> 20} MB in {time.monotonic() - started:.0f}s")


def extract_tarball(archive: Path, into: Path, expected_root: str) -> None:
    """Unpack a release tarball under `into`, refusing members that escape it."""
    into.mkdir(parents=True, exist_ok=True)
    with tarfile.open(archive, "r:bz2") as tar:
        for member in tar.getmembers():
            top = member.name.split("/", 1)[0]
            if top != expected_root or member.name.startswith(("/", "..")):
                raise DownloadError(f"{archive.name}: unexpected member {member.name!r}")
        tar.extractall(into, filter="data")


# --- the manifest ---------------------------------------------------------------------------------


@dataclass
class Step:
    name: str
    required: bool
    # The step is complete when every one of these exists.
    expect: list[Path]
    run: Callable[[], None]
    enabled: bool = True
    notes: list[str] = field(default_factory=list)


def build_steps(paths: ModelPaths, settings: Settings, fallback: str, only: set[str] | None) -> list[Step]:
    verify = settings.verify_checksums
    downloads = paths.downloads_dir

    def tarball_step(name: str, url: str, size: int | None, sha: str | None, into: Path, root: str, expect: list[str], required: bool, enabled: bool = True) -> Step:
        target = into / root

        def run() -> None:
            archive = downloads / url.rsplit("/", 1)[1]
            fetch(((url, size, sha),), archive, verify)
            if target.exists():
                shutil.rmtree(target)
            extract_tarball(archive, into, root)
            archive.unlink(missing_ok=True)

        return Step(name, required, [target / f for f in expect], run, enabled)

    steps: list[Step] = []

    # 1. Silero VAD (MIT). The sherpa-onnx copy is v4 (inputs x/h/c); the upstream repo's current
    #    file is v5 (inputs input/state/sr). speech/vad.py handles either.
    steps.append(
        Step(
            "vad",
            True,
            [paths.vad],
            lambda: fetch(
                (
                    (f"{GITHUB_ASR}/silero_vad.onnx", 643854, "9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6"),
                    (
                        "https://raw.githubusercontent.com/snakers4/silero-vad/master/src/silero_vad/data/silero_vad.onnx",
                        2327524,
                        "1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3",
                    ),
                ),
                paths.vad,
                verify,
            ),
        )
    )

    # 2. English STT: NVIDIA Parakeet-TDT 0.6B v3, int8, packaged by k2-fsa (CC-BY-4.0).
    steps.append(
        tarball_step(
            "stt_en",
            f"{GITHUB_ASR}/{PARAKEET_DIR}.tar.bz2",
            487170055,
            "5793d0fd397c5778d2cf2126994d58e9d56b1be7c04d13c7a15bb1b4eafb16bf",
            paths.stt_en_dir.parent,
            PARAKEET_DIR,
            ["encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt"],
            required=True,
        )
    )

    # 3. Bengali STT: AI4Bharat IndicConformer (MIT), CTC branch, from the trysem ONNX mirror,
    #    packaged here with the metadata sherpa-onnx's NeMo CTC loader reads.
    steps.append(Step("stt_bn", True, [paths.stt_bn_dir / "model.onnx", paths.stt_bn_dir / "tokens.txt"], lambda: package_indicconformer(paths, verify)))
    steps.append(
        Step(
            "stt_bn_int8",
            False,
            [paths.stt_bn_model("int8")],
            lambda: quantize_indicconformer(paths),
            enabled=settings.stt_bn_variant == "int8",
        )
    )

    # 3b. Optional one-model fallback: Meta Omnilingual ASR 300M CTC v2 int8 (Apache-2.0).
    omni_tar = f"{OMNILINGUAL_DIR}.tar.bz2"
    steps.append(
        tarball_step(
            "stt_fallback",
            f"{HF}/Edison2ST/sherpa-onnx-omnilingual-asr-1600-languages-ctc-v2/resolve/main/{omni_tar}",
            247417872,
            "b72bef9be75862684098e722d79fefecf9f10fefd3a0b2950738977b4c6b4147",
            paths.stt_fallback_dir.parent,
            OMNILINGUAL_DIR,
            ["model.int8.onnx", "tokens.txt"],
            required=False,
            enabled=fallback == "omnilingual",
        )
    )

    # 4. Language ID: speechbrain VoxLingua107 ECAPA-TDNN (Apache-2.0), the four files
    #    `EncoderClassifier.from_hparams` reads, fetched directly so no HF cache is involved.
    def lid() -> None:
        repo = f"{HF}/speechbrain/lang-id-voxlingua107-ecapa/resolve/0253049ae131d6a4be1c4f0d8b0ff483a0f8c8e9"
        files = {
            "hyperparams.yaml": (1519, None),
            "label_encoder.txt": (2204, None),
            "classifier.ckpt": (762555, "a50d9024ff58d317031c9787d4c6c614d454a87a8ef32f9d36338cd3ff57adbc"),
            "embedding_model.ckpt": (84474355, "ab750d5c06d713477045fa798fab5d33e959dbc0dfe4de510a9a47844c79a19a"),
        }
        for name, (size, sha) in files.items():
            if not (paths.lid_dir / name).exists():
                fetch(((f"{repo}/{name}", size, sha),), paths.lid_dir / name, verify)

    steps.append(Step("lid", True, [paths.lid_dir / n for n in ("hyperparams.yaml", "label_encoder.txt", "classifier.ckpt", "embedding_model.ckpt")], lid))

    # 5. Bengali TTS, voice bn_female: Coqui VITS (Apache-2.0) packaged by k2-fsa.
    steps.append(
        tarball_step(
            "tts_bn_female",
            f"{GITHUB_TTS}/{COQUI_BN_DIR}.tar.bz2",
            108053596,
            "a03292d7da03650e892bb1989b40dc2c62574c0d6c34c8bef185fbb3151417a1",
            paths.tts_dir,
            COQUI_BN_DIR,
            ["model.onnx", "tokens.txt"],
            required=True,
        )
    )

    # 7b. English fallback voice en_piper: piper en_US-libritts_r-medium (CC-BY-4.0 data), whose
    #     tarball also carries the espeak-ng-data every piper-style voice needs. Ordered before
    #     the bn_BD voice, which borrows that directory.
    steps.append(
        tarball_step(
            "tts_en_piper",
            f"{GITHUB_TTS}/{PIPER_EN_DIR}.tar.bz2",
            82038311,
            "10dc268f3e371696d721486123e2705a9fc1faa113491979fde4d88dba1f1b1c",
            paths.tts_dir,
            PIPER_EN_DIR,
            ["en_US-libritts_r-medium.onnx", "tokens.txt", "espeak-ng-data/phontab"],
            required=True,
        )
    )

    # 6. Bengali TTS, voice bn_bd: piper bn_BD-google-medium (16 speakers), packaged here the way
    #    the sherpa-onnx piper page describes (metadata into the ONNX, tokens.txt from the json).
    steps.append(
        Step("tts_bn_bd", True, [paths.piper_bn_dir / "bn_BD-google-medium.onnx", paths.piper_bn_dir / "tokens.txt", paths.piper_bn_dir / ".packaged"], lambda: package_piper_bn(paths, verify))
    )

    # 7. English TTS, voices en_female / en_male: Kokoro v0.19 (Apache-2.0), fp32 or int8.
    steps.append(
        tarball_step(
            "tts_en_kokoro",
            f"{GITHUB_TTS}/{KOKORO_DIR}.tar.bz2",
            319625534,
            "912804855a04745fa77a30be545b3f9a5d15c4d66db00b88cbcd4921df605ac7",
            paths.tts_dir,
            KOKORO_DIR,
            ["model.onnx", "voices.bin", "tokens.txt", "espeak-ng-data/phontab"],
            required=True,
            enabled=settings.kokoro_variant == "fp32",
        )
    )
    steps.append(
        tarball_step(
            "tts_en_kokoro_int8",
            f"{GITHUB_TTS}/{KOKORO_INT8_DIR}.tar.bz2",
            103248205,
            "c9f0dd393615805b0bab050c340834d5e684e732aec91c0e860cd30e982c08bd",
            paths.tts_dir,
            KOKORO_INT8_DIR,
            ["model.int8.onnx", "voices.bin", "tokens.txt", "espeak-ng-data/phontab"],
            required=True,
            enabled=settings.kokoro_variant == "int8",
        )
    )

    if only:
        for step in steps:
            step.enabled = step.enabled and step.name in only
    return steps


# --- packaging steps ------------------------------------------------------------------------------


def package_indicconformer(paths: ModelPaths, verify: bool) -> None:
    """
    The HF mirror ships the raw NeMo export (inputs audio_signal/length, output logprobs) and a
    vocab.json list. sherpa-onnx's NeMo CTC loader needs the vocab size, feature normalisation
    and subsampling factor as ONNX metadata, and a tokens.txt with the blank appended last.
    """
    import onnx

    repo = f"{HF}/trysem/indicconformer-120m-onnx/resolve/2ac405dd8149db2f0fe3ee5354163e85a15f09af/bn"
    target = paths.stt_bn_dir
    target.mkdir(parents=True, exist_ok=True)
    vocab_path = target / "vocab.json"
    raw_model = paths.downloads_dir / "indicconformer-bn-raw.onnx"
    if not vocab_path.exists():
        fetch(((f"{repo}/vocab.json", 68706, None),), vocab_path, verify)
    if not raw_model.exists():
        fetch(((f"{repo}/model.onnx", 493060285, "2f19f179844ac6cfb0d7e940696fc1dc6535fc725d2aacd4d43c6d1f3e9016f8"),), raw_model, verify)

    with vocab_path.open(encoding="utf-8") as handle:
        vocab = json.load(handle)
    if not isinstance(vocab, list) or not vocab:
        raise DownloadError("indicconformer vocab.json is not a list of tokens")
    blank_id = len(vocab)
    with (target / "tokens.txt").open("w", encoding="utf-8") as handle:
        for index, token in enumerate(vocab):
            if not token or any(c.isspace() for c in token):
                raise DownloadError(f"indicconformer vocab has an unusable token at {index}: {token!r}")
            handle.write(f"{token} {index}\n")
        handle.write(f"<blk> {blank_id}\n")

    log("  packaging indicconformer-bn (adding sherpa-onnx metadata)")
    model = onnx.load(str(raw_model), load_external_data=False)
    existing = {prop.key for prop in model.metadata_props}
    for key, value in {
        "vocab_size": str(blank_id + 1),
        "normalize_type": "per_feature",
        "subsampling_factor": "4",
        "model_type": "EncDecHybridRNNTCTCBPEModel",
        "version": "1",
        "model_author": "AI4Bharat",
        "comment": "CTC branch",
    }.items():
        if key in existing:
            continue
        prop = model.metadata_props.add()
        prop.key = key
        prop.value = value
    onnx.save(model, str(target / "model.onnx"))
    raw_model.unlink(missing_ok=True)


def quantize_indicconformer(paths: ModelPaths) -> None:
    """Dynamic int8 quantisation of the packaged fp32 model (opt-in via SPEECH_STT_BN_VARIANT=int8)."""
    from onnxruntime.quantization import QuantType, quantize_dynamic

    source = paths.stt_bn_model("fp32")
    if not source.exists():
        raise DownloadError("indicconformer fp32 model must be packaged before quantising")
    # uint8 weights: the u8s8 MatMulInteger path. Measured on an AVX-512 Xeon, QInt8 weights were
    # three times slower than fp32; QUInt8 is on par with the pre-quantised model (RTF ~0.08).
    log("  quantising indicconformer-bn to int8 (one-off, well under a minute)")
    quantize_dynamic(str(source), str(paths.stt_bn_model("int8")), weight_type=QuantType.QUInt8)


def package_piper_bn(paths: ModelPaths, verify: bool) -> None:
    """The sherpa-onnx piper recipe: tokens.txt from phoneme_id_map, metadata into the ONNX."""
    import onnx

    base = f"{HF}/rhasspy/piper-voices/resolve/c10ece1aade47bb51c153c893d14e5bf8e5b7117/bn/bn_BD/google/medium"
    target = paths.piper_bn_dir
    target.mkdir(parents=True, exist_ok=True)
    model_path = target / "bn_BD-google-medium.onnx"
    config_path = target / "bn_BD-google-medium.onnx.json"
    marker = target / ".packaged"
    if not config_path.exists():
        fetch(((f"{base}/bn_BD-google-medium.onnx.json", 5494, "bc7e5e39e2a874bdad186620576ce18089b5a06c5645e258bcea3d56fdb11c0a"),), config_path, verify)
    if not model_path.exists() or not marker.exists():
        fetch(((f"{base}/bn_BD-google-medium.onnx", 76782515, "f2e7518ed5534a755024a48c71b80bf617efaf12570bbdf3ce255a9526a8afd3"),), model_path, verify)
        marker.unlink(missing_ok=True)

    with config_path.open(encoding="utf-8") as handle:
        config = json.load(handle)
    with (target / "tokens.txt").open("w", encoding="utf-8") as handle:
        for symbol, ids in config["phoneme_id_map"].items():
            # This voice's map carries five diphthong entries ("aɪ", "oʊ", ...) spelled with two
            # code points. piper itself looks phonemes up one code point at a time, so they were
            # never reachable, and sherpa-onnx refuses a tokens.txt that contains them.
            if len(symbol) != 1:
                continue
            handle.write(f"{symbol} {ids[0]}\n")

    log("  packaging piper bn_BD-google-medium (adding sherpa-onnx metadata)")
    model = onnx.load(str(model_path))
    existing = {prop.key for prop in model.metadata_props}
    for key, value in {
        "model_type": "vits",
        "comment": "piper",
        "language": config["language"]["name_english"],
        "voice": config["espeak"]["voice"],
        "has_espeak": 1,
        "n_speakers": config["num_speakers"],
        "sample_rate": config["audio"]["sample_rate"],
    }.items():
        if key in existing:
            continue
        prop = model.metadata_props.add()
        prop.key = key
        prop.value = str(value)
    onnx.save(model, str(model_path))
    if not paths.espeak_data_dir.exists():
        raise DownloadError("espeak-ng-data is missing: the piper English tarball must be unpacked first")
    marker.write_text("ok\n")


# --- main -----------------------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--models-dir", default=None, help="overrides SPEECH_MODELS_DIR")
    parser.add_argument("--fallback", default=None, help="overrides SPEECH_STT_FALLBACK (omnilingual)")
    parser.add_argument("--only", nargs="*", default=None, help="run only these steps (by name)")
    parser.add_argument("--list", action="store_true", help="print the steps and exit")
    args = parser.parse_args(argv)

    if args.models_dir:
        os.environ["SPEECH_MODELS_DIR"] = args.models_dir
    if args.fallback is not None:
        os.environ["SPEECH_STT_FALLBACK"] = args.fallback
    try:
        settings = Settings.from_env()
    except ValueError as error:
        log(f"bad configuration: {error}")
        return 2
    paths = ModelPaths(settings.models_dir)
    steps = build_steps(paths, settings, settings.stt_fallback, set(args.only) if args.only else None)

    if args.list:
        for step in steps:
            print(f"{step.name:20s} required={step.required} enabled={step.enabled}")
        return 0

    try:
        paths.root.mkdir(parents=True, exist_ok=True)
        paths.downloads_dir.mkdir(parents=True, exist_ok=True)
    except OSError as error:
        log(f"models directory {paths.root} is not writable: {error}")
        return 1

    started = time.monotonic()
    failures: list[str] = []
    for step in steps:
        if not step.enabled:
            continue
        if all(p.exists() for p in step.expect):
            log(f"{step.name}: present")
            continue
        log(f"{step.name}: downloading")
        try:
            step.run()
        except (DownloadError, OSError, tarfile.TarError, ValueError, KeyError) as error:
            log(f"{step.name}: FAILED - {error}")
            failures.append(step.name)
            continue
        missing = [str(p) for p in step.expect if not p.exists()]
        if missing:
            log(f"{step.name}: FAILED - files still missing after download: {', '.join(missing)}")
            failures.append(step.name)
        else:
            log(f"{step.name}: ok")

    shutil.rmtree(paths.downloads_dir, ignore_errors=True)
    required_failures = [name for name in failures if any(s.name == name and s.required for s in steps)]
    log(f"finished in {time.monotonic() - started:.0f}s; failures: {failures or 'none'}")
    if required_failures:
        log(f"required models unavailable: {', '.join(required_failures)} - refusing to start")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
