#!/usr/bin/env python3
"""Verify codec, 4K geometry, timing, audio mapping, metadata, and decode."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import sys
from typing import Any


def find_tool(env_name: str, candidates: list[str]) -> str:
    configured = os.environ.get(env_name)
    if configured:
        path = shutil.which(configured) or (configured if Path(configured).is_file() else None)
        if path:
            return str(path)
    for candidate in candidates:
        path = shutil.which(candidate) or (candidate if Path(candidate).is_file() else None)
        if path:
            return str(path)
    raise SystemExit(f"Could not find {env_name}.")


FFMPEG = find_tool("FFMPEG", ["/opt/homebrew/opt/ffmpeg@6/bin/ffmpeg", "/opt/homebrew/bin/ffmpeg", "ffmpeg"])
FFPROBE = find_tool("FFPROBE", ["/opt/homebrew/opt/ffmpeg@6/bin/ffprobe", "/opt/homebrew/bin/ffprobe", "ffprobe"])


def ratio(value: str | None) -> float:
    if not value or value in {"N/A", "0/0"}:
        return math.nan
    if "/" in value:
        numerator, denominator = value.split("/", 1)
        return float(numerator) / float(denominator) if float(denominator) else math.nan
    return float(value)


def numeric(value: Any) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return math.nan


def add_check(checks: list[dict[str, Any]], name: str, ok: bool, observed: Any, expected: Any) -> None:
    checks.append({"name": name, "ok": bool(ok), "observed": observed, "expected": expected})


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Deep-QA a rendered Blender cinematic explainer.")
    parser.add_argument("file", type=Path)
    parser.add_argument("--expected-codec", choices=["auto", "h264", "h265"], default="auto")
    parser.add_argument("--expected-fps", type=float, default=30.0)
    parser.add_argument("--expected-duration", type=float)
    parser.add_argument("--duration-tolerance", type=float, default=0.20)
    parser.add_argument("--skip-decode", action="store_true")
    parser.add_argument("--report", type=Path)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    path = args.file.expanduser().resolve()
    if not path.is_file():
        raise SystemExit(f"Missing output: {path}")
    probe_command = [
        FFPROBE,
        "-v",
        "error",
        "-count_frames",
        "-show_streams",
        "-show_format",
        "-of",
        "json",
        str(path),
    ]
    probe_result = subprocess.run(probe_command, check=True, text=True, stdout=subprocess.PIPE)
    info = json.loads(probe_result.stdout)
    videos = [s for s in info.get("streams", []) if s.get("codec_type") == "video"]
    audios = [s for s in info.get("streams", []) if s.get("codec_type") == "audio"]
    checks: list[dict[str, Any]] = []
    add_check(checks, "one_video_stream", len(videos) == 1, len(videos), 1)
    add_check(checks, "one_audio_stream", len(audios) == 1, len(audios), 1)

    video = videos[0] if videos else {}
    audio = audios[0] if audios else {}
    add_check(checks, "resolution", (video.get("width"), video.get("height")) == (3840, 2160), [video.get("width"), video.get("height")], [3840, 2160])
    observed_fps = ratio(video.get("avg_frame_rate") or video.get("r_frame_rate"))
    add_check(checks, "frame_rate", math.isfinite(observed_fps) and abs(observed_fps - args.expected_fps) <= 0.01, observed_fps, args.expected_fps)

    expected_codec = {"h264": "h264", "h265": "hevc"}.get(args.expected_codec)
    if expected_codec:
        add_check(checks, "video_codec", video.get("codec_name") == expected_codec, video.get("codec_name"), expected_codec)
        expected_tag = "avc1" if args.expected_codec == "h264" else "hvc1"
        add_check(checks, "video_tag", video.get("codec_tag_string") == expected_tag, video.get("codec_tag_string"), expected_tag)
        expected_pix_fmt = "yuv420p" if args.expected_codec == "h264" else "yuv420p10le"
        add_check(checks, "pixel_format", video.get("pix_fmt") == expected_pix_fmt, video.get("pix_fmt"), expected_pix_fmt)

    add_check(checks, "color_range", video.get("color_range") == "tv", video.get("color_range"), "tv")
    add_check(checks, "color_space", video.get("color_space") == "bt709", video.get("color_space"), "bt709")
    add_check(checks, "color_transfer", video.get("color_transfer") == "bt709", video.get("color_transfer"), "bt709")
    add_check(checks, "color_primaries", video.get("color_primaries") == "bt709", video.get("color_primaries"), "bt709")

    add_check(checks, "audio_codec", audio.get("codec_name") == "aac", audio.get("codec_name"), "aac")
    add_check(checks, "audio_sample_rate", audio.get("sample_rate") == "48000", audio.get("sample_rate"), "48000")
    add_check(checks, "audio_channels", audio.get("channels") == 2, audio.get("channels"), 2)

    format_duration = numeric(info.get("format", {}).get("duration"))
    video_duration = numeric(video.get("duration"))
    audio_duration = numeric(audio.get("duration"))
    observed_duration = video_duration if math.isfinite(video_duration) else format_duration
    if args.expected_duration is not None:
        add_check(
            checks,
            "duration",
            math.isfinite(observed_duration) and abs(observed_duration - args.expected_duration) <= args.duration_tolerance,
            observed_duration,
            f"{args.expected_duration:.3f} ± {args.duration_tolerance:.3f}s",
        )
    if math.isfinite(video_duration) and math.isfinite(audio_duration):
        add_check(checks, "audio_video_sync_duration", abs(video_duration - audio_duration) <= 0.10, abs(video_duration - audio_duration), "<= 0.10s")

    frames_value = video.get("nb_read_frames") or video.get("nb_frames")
    try:
        frames = int(frames_value)
    except (TypeError, ValueError):
        frames = 0
    expected_frames = round(observed_duration * observed_fps) if math.isfinite(observed_duration) and math.isfinite(observed_fps) else 0
    add_check(checks, "frame_count", frames > 0 and abs(frames - expected_frames) <= 2, frames, f"{expected_frames} ± 2")

    decode_ok = None
    decode_error = ""
    if not args.skip_decode and videos and audios:
        print("Running full video+audio decode...", flush=True)
        decode = subprocess.run(
            [FFMPEG, "-hide_banner", "-v", "error", "-xerror", "-i", str(path), "-map", "0:v:0", "-map", "0:a:0", "-f", "null", "-"],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        decode_ok = decode.returncode == 0
        decode_error = decode.stderr.strip()
        add_check(checks, "full_decode", decode_ok, decode_error or "clean", "clean")

    passed = all(check["ok"] for check in checks)
    report: dict[str, Any] = {
        "file": str(path),
        "checked_at_utc": datetime.now(timezone.utc).isoformat(),
        "passed": passed,
        "size_bytes": path.stat().st_size,
        "duration_seconds": observed_duration,
        "video": video,
        "audio": audio,
        "checks": checks,
    }
    if args.report:
        report_path = args.report.expanduser().resolve()
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"QA report: {report_path}")

    for check in checks:
        marker = "PASS" if check["ok"] else "FAIL"
        print(f"[{marker}] {check['name']}: {check['observed']} (expected {check['expected']})")
    print("QA PASS" if passed else "QA FAIL")
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
