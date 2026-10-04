from __future__ import annotations

import importlib.metadata as metadata
import logging
import math
import threading
import time
from typing import Any, Mapping

from .audio import CanonicalAudio
from .config import ServiceConfig
from .models import asr_path, use_local_resources_only
from .resources import UnpreparedResourceError

logger = logging.getLogger("eimu.asr")

PINNED_FASTER_WHISPER_VERSION = "1.2.1"


class InferenceInputError(ValueError):
    pass


class InferenceBusyError(RuntimeError):
    pass


def normalize_language(value: object) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError("language must be a string")
    language = value.strip().lower()
    if not language or language in {"auto", "detect", "und", "unknown"}:
        return None
    if len(language) > 32 or not all(character.isalnum() or character in {"-", "_"} for character in language):
        raise ValueError("language is invalid")
    return language


def _finite(value: object) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = float(value)
    return number if math.isfinite(number) else None


def normalize_alignment(language: str, raw: Mapping[str, Any]) -> dict[str, object]:
    raw_segments = raw.get("segments", [])
    if not isinstance(raw_segments, list):
        raise RuntimeError("ASR returned a non-array segments value")
    segments: list[dict[str, object]] = []
    for raw_segment in raw_segments:
        if not isinstance(raw_segment, Mapping):
            raise RuntimeError("ASR returned an invalid segment")
        raw_words = raw_segment.get("words", [])
        if not isinstance(raw_words, list):
            raise RuntimeError("ASR returned a non-array words value")
        words: list[dict[str, object]] = []
        for raw_word in raw_words:
            if not isinstance(raw_word, Mapping):
                raise RuntimeError("ASR returned an invalid word")
            value = raw_word.get("word", raw_word.get("text", ""))
            text = value.strip() if isinstance(value, str) else ""
            if not text:
                continue
            start = _finite(raw_word.get("start"))
            end = _finite(raw_word.get("end"))
            score = _finite(raw_word.get("score"))
            word: dict[str, object] = {"text": text}
            # Missing or partial acoustic evidence stays missing. Never manufacture a tick.
            if start is not None and end is not None and 0 <= start <= end:
                word.update(start=start, end=end)
            if score is not None and 0 <= score <= 1:
                word["score"] = score
            words.append(word)
        if not words:
            continue
        segment_text = raw_segment.get("text")
        segment: dict[str, object] = {
            "text": segment_text.strip() if isinstance(segment_text, str) else " ".join(
                str(word["text"]) for word in words
            ),
            "words": words,
        }
        start = _finite(raw_segment.get("start"))
        end = _finite(raw_segment.get("end"))
        if start is not None and end is not None and 0 <= start <= end:
            segment.update(start=start, end=end)
        segments.append(segment)
    return {"language": language, "segments": segments}


def _raw_segments(transcription_segments: Any, max_no_speech_prob: float | None = None) -> list[dict[str, object]]:
    """Lower faster-whisper's segment objects into the wire-neutral mapping the
    aligner normalizes. Word timing comes from word_timestamps=True; a word the
    acoustic model did not time stays untimed."""
    result: list[dict[str, object]] = []
    for segment in transcription_segments:
        if max_no_speech_prob is not None and (getattr(segment, "no_speech_prob", 0.0) or 0.0) > max_no_speech_prob:
            continue
        words: list[dict[str, object]] = []
        for word in getattr(segment, "words", None) or []:
            words.append({
                "word": getattr(word, "word", ""),
                "start": getattr(word, "start", None),
                "end": getattr(word, "end", None),
                "score": getattr(word, "probability", None),
            })
        result.append({
            "start": getattr(segment, "start", None),
            "end": getattr(segment, "end", None),
            "text": getattr(segment, "text", ""),
            "words": words,
        })
    return result


class EimuAsrEngine:
    def __init__(self, config: ServiceConfig):
        use_local_resources_only()
        try:
            import numpy as numpy_module
            from faster_whisper import WhisperModel as whisper_model_class
        except ImportError as error:
            raise RuntimeError(
                "faster-whisper runtime is unavailable; run services/asr/prepare.sh"
            ) from error
        installed = metadata.version("faster-whisper")
        if installed != PINNED_FASTER_WHISPER_VERSION:
            raise RuntimeError(
                f"expected faster-whisper {PINNED_FASTER_WHISPER_VERSION}, got {installed}"
            )
        self._numpy = numpy_module
        self._whisper_model_class = whisper_model_class
        self._config = config
        self._inference_lock = threading.Lock()
        self._asr: object | None = None
        self._faster_whisper_version = installed
        # Warm start. A missing prepared resource must not kill the process: the
        # service stays diagnosable and /transcribe reports RESOURCE_NOT_PREPARED
        # with the explicit prepare command until it is prepared.
        try:
            self._ensure_model()
        except UnpreparedResourceError as error:
            logger.error(
                "ASR resources are not prepared; /transcribe will report RESOURCE_NOT_PREPARED: %s",
                error,
            )

    def _ensure_model(self) -> object:
        if self._asr is not None:
            return self._asr
        started = time.monotonic()
        logger.info("loading prepared ASR model=%s", self._config.model)
        self._asr = self._whisper_model_class(
            asr_path(self._config),
            device=self._config.device,
            compute_type=self._config.compute,
            cpu_threads=self._config.cpu_threads,
            num_workers=1,
        )
        logger.info("ASR model ready in %.1fs", time.monotonic() - started)
        return self._asr

    def identity(self) -> dict[str, object]:
        return {
            "model": self._config.model,
            "device": self._config.device,
            "compute": self._config.compute,
            "batchSize": self._config.batch_size,
            "fasterWhisperVersion": self._faster_whisper_version,
        }

    def transcribe(self, audio: CanonicalAudio, language: str | None) -> dict[str, object]:
        if self._config.model.endswith(".en") and language not in {None, "en"}:
            raise InferenceInputError(
                f"model {self._config.model!r} is English-only and cannot transcribe {language!r}"
            )
        samples = self._numpy.frombuffer(audio.pcm_s16le, dtype="<i2").astype(self._numpy.float32)
        samples /= 32768.0
        samples = self._numpy.ascontiguousarray(samples)
        if not self._inference_lock.acquire(blocking=False):
            raise InferenceBusyError("the warm ASR model is already executing one request")
        try:
            model = self._ensure_model()
            started = time.monotonic()
            logger.info("transcribing %.2fs of audio, language=%s", audio.duration_sec, language or "auto")
            segments, info = model.transcribe(
                samples,
                language=language,
                word_timestamps=True,
                vad_filter=self._config.vad_filter,
                beam_size=1,
                # WhisperX's own default is a single float 0.0: a temperature *list*
                # would let the decoder fall back to sampling, so the same evidence
                # would not always measure the same words.
                temperature=0.0,
                condition_on_previous_text=False,
            )
            raw = _raw_segments(segments)
            if not raw and self._config.vad_filter:
                # 2026-10-02：Silero VAD 把「伴奏上的歌声」整段判成非语音（OP 歌 152s
                # 实测 VAD=0 段、关 VAD 有完整歌词）→ 音乐素材恒报 no_speech。VAD 全空时
                # 关 VAD 重转一次，丢掉 no_speech_prob 高的段（纯器乐前奏的幻觉字）。
                logger.info("VAD kept no speech; retrying without VAD (sung vocals over music)")
                segments, info = model.transcribe(
                    samples,
                    language=language,
                    word_timestamps=True,
                    vad_filter=False,
                    beam_size=1,
                    temperature=0.0,
                    condition_on_previous_text=False,
                )
                raw = _raw_segments(segments, max_no_speech_prob=0.6)
            logger.info("transcription completed in %.1fs", time.monotonic() - started)
            detected = getattr(info, "language", None) or language
            if not isinstance(detected, str) or not detected.strip():
                raise RuntimeError("ASR did not return a valid language")
            if not raw:
                logger.info("no speech segments; nothing to time")
                return {"language": detected, "segments": []}
            return normalize_alignment(detected, {"segments": raw})
        finally:
            self._inference_lock.release()
