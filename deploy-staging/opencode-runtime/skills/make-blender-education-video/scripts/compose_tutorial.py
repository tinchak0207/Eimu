#!/usr/bin/env python3
"""Safely assemble a 4K Blender cinematic education video."""

from __future__ import annotations

import argparse
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
from typing import Any


SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_DIR = SCRIPT_DIR.parent


def find_tool(env_name: str, candidates: list[str]) -> str:
    configured = os.environ.get(env_name)
    if configured:
        path = shutil.which(configured) or (configured if Path(configured).is_file() else None)
        if path:
            return str(path)
        raise SystemExit(f"{env_name} points to a missing executable: {configured}")
    for candidate in candidates:
        path = shutil.which(candidate) or (candidate if Path(candidate).is_file() else None)
        if path:
            return str(path)
    raise SystemExit(f"Could not find {env_name.lower()}. Set {env_name} explicitly.")


FFMPEG = find_tool(
    "FFMPEG",
    [
        "/opt/homebrew/opt/ffmpeg@6/bin/ffmpeg",
        "/opt/homebrew/bin/ffmpeg",
        "ffmpeg",
    ],
)
FFPROBE = find_tool(
    "FFPROBE",
    [
        "/opt/homebrew/opt/ffmpeg@6/bin/ffprobe",
        "/opt/homebrew/bin/ffprobe",
        "ffprobe",
    ],
)


def run(command: list[str], *, capture: bool = False) -> subprocess.CompletedProcess[str]:
    print("+", " ".join(shlex_quote(part) for part in command), flush=True)
    return subprocess.run(
        command,
        check=True,
        text=True,
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.PIPE if capture else None,
    )


def shlex_quote(value: str) -> str:
    import shlex

    return shlex.quote(value)


def require_file(path: Path, label: str) -> Path:
    resolved = path.expanduser().resolve()
    if not resolved.is_file():
        raise SystemExit(f"Missing {label}: {resolved}")
    return resolved


def probe(path: Path, *, count_frames: bool = False) -> dict[str, Any]:
    command = [FFPROBE, "-v", "error"]
    if count_frames:
        command.append("-count_frames")
    command += ["-show_streams", "-show_format", "-of", "json", str(path)]
    result = run(command, capture=True)
    return json.loads(result.stdout)


def media_duration(info: dict[str, Any], stream_type: str | None = None) -> float:
    if stream_type:
        for stream in info.get("streams", []):
            if stream.get("codec_type") == stream_type:
                try:
                    duration = float(stream.get("duration", "nan"))
                except (TypeError, ValueError):
                    duration = math.nan
                if math.isfinite(duration) and duration > 0:
                    return duration
    try:
        duration = float(info.get("format", {}).get("duration", "nan"))
    except (TypeError, ValueError):
        duration = math.nan
    if not math.isfinite(duration) or duration <= 0:
        raise SystemExit("Could not determine a positive media duration with ffprobe.")
    return duration


def has_stream(info: dict[str, Any], stream_type: str) -> bool:
    return any(stream.get("codec_type") == stream_type for stream in info.get("streams", []))


def analyze_loudness(narration: Path) -> dict[str, str] | None:
    command = [
        FFMPEG,
        "-hide_banner",
        "-nostats",
        "-i",
        str(narration),
        "-map",
        "0:a:0",
        "-af",
        "loudnorm=I=-16:TP=-1.5:LRA=7:print_format=json",
        "-f",
        "null",
        "-",
    ]
    print("Analyzing narration loudness (pass 1/2)...", flush=True)
    result = subprocess.run(command, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode != 0:
        print(result.stderr, file=sys.stderr)
        raise SystemExit("Narration loudness analysis failed.")
    matches = re.findall(r"\{\s*\"input_i\".*?\}", result.stderr, flags=re.DOTALL)
    if not matches:
        print("Warning: loudnorm did not return measurements; using dynamic normalization.", file=sys.stderr)
        return None
    data = json.loads(matches[-1])
    required = ["input_i", "input_tp", "input_lra", "input_thresh", "target_offset"]
    if any(key not in data for key in required):
        return None
    for key in required:
        try:
            if not math.isfinite(float(data[key])):
                return None
        except (TypeError, ValueError):
            return None
    return {key: str(data[key]) for key in required}


def narration_filter(measurements: dict[str, str] | None, normalize: bool) -> str:
    if not normalize:
        return "aresample=48000"
    if measurements is None:
        return "loudnorm=I=-16:TP=-1.5:LRA=7,aresample=48000"
    return (
        "loudnorm=I=-16:TP=-1.5:LRA=7"
        f":measured_I={measurements['input_i']}"
        f":measured_TP={measurements['input_tp']}"
        f":measured_LRA={measurements['input_lra']}"
        f":measured_thresh={measurements['input_thresh']}"
        f":offset={measurements['target_offset']}"
        ":linear=true:print_format=summary,aresample=48000"
    )


def shallow_output_check(path: Path, codec: str, fps: int) -> None:
    info = probe(path, count_frames=False)
    videos = [s for s in info.get("streams", []) if s.get("codec_type") == "video"]
    audios = [s for s in info.get("streams", []) if s.get("codec_type") == "audio"]
    if len(videos) != 1 or len(audios) != 1:
        raise SystemExit("Encoded temporary file must contain exactly one video and one audio stream.")
    video = videos[0]
    expected_codec = "hevc" if codec == "h265" else "h264"
    if video.get("codec_name") != expected_codec:
        raise SystemExit(f"Temporary output codec is {video.get('codec_name')}, expected {expected_codec}.")
    if (video.get("width"), video.get("height")) != (3840, 2160):
        raise SystemExit("Temporary output is not 3840x2160.")
    rate = video.get("avg_frame_rate", "0/1")
    numerator, denominator = (float(part) for part in rate.split("/", 1))
    observed_fps = numerator / denominator if denominator else 0
    if abs(observed_fps - fps) > 0.01:
        raise SystemExit(f"Temporary output is {observed_fps:.3f} fps, expected {fps} fps.")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Compose a Blender cinematic explainer with narration, burned-in captions, and optional teaching cards."
    )
    parser.add_argument("--video", type=Path, required=True, help="Cinematic Blender picture master in MP4/MOV")
    parser.add_argument("--narration", type=Path, required=True, help="Narration WAV/AIFF/MP3")
    caption_group = parser.add_mutually_exclusive_group(required=True)
    caption_group.add_argument("--captions", type=Path, help="Required English ASS captions to burn in")
    caption_group.add_argument(
        "--no-captions",
        action="store_true",
        help="Explicitly omit captions only when the user directly opted out of subtitles/captions",
    )
    parser.add_argument("--overlay", type=Path, help="Optional ASS title, section, and teaching cards")
    parser.add_argument("--output", type=Path, required=True, help="Final .mp4 path")
    parser.add_argument("--codec", choices=["h264", "h265"], default="h265")
    parser.add_argument(
        "--preset",
        choices=["ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow", "slower", "veryslow"],
        default="slow",
    )
    parser.add_argument("--crf", type=float, default=15.0)
    parser.add_argument("--fps", type=int, choices=[24, 25, 30, 50, 60], default=30)
    parser.add_argument("--audio-language", choices=["eng"], required=True, help="ISO 639-2 audio language; this skill requires eng")
    parser.add_argument("--mix-source-audio", action="store_true", help="Mix source ambience below narration")
    parser.add_argument("--source-audio-db", type=float, default=-26.0, help="Source ambience gain when mixed")
    parser.add_argument("--no-loudnorm", action="store_true", help="Skip EBU R128 narration normalization")
    parser.add_argument("--allow-narration-trim", action="store_true", help="Permit narration longer than the video")
    parser.add_argument("--title", default="Blender Education Video")
    parser.add_argument("--force", action="store_true", help="Atomically replace an existing output")
    parser.add_argument("--skip-verify", action="store_true", help="Do not run the final verifier")
    parser.add_argument("--skip-decode", action="store_true", help="Skip the verifier's full decode pass")
    parser.add_argument("--qa-report", type=Path, help="QA JSON path; defaults beside output")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    video = require_file(args.video, "Blender picture master")
    narration = require_file(args.narration, "narration")
    captions = require_file(args.captions, "English ASS captions") if args.captions else None
    overlay = require_file(args.overlay, "ASS overlay") if args.overlay else None
    if captions and captions.suffix.lower() != ".ass":
        raise SystemExit("Burned-in captions must use the required English .ass template.")
    if overlay and overlay.suffix.lower() != ".ass":
        raise SystemExit("The optional teaching overlay must be an .ass file.")

    output = args.output.expanduser().resolve()
    if output.suffix.lower() != ".mp4":
        raise SystemExit("Output must use the .mp4 extension.")
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists() and not args.force:
        raise SystemExit(f"Output already exists (use --force to replace atomically): {output}")

    video_info = probe(video)
    narration_info = probe(narration)
    if not has_stream(video_info, "video"):
        raise SystemExit("Picture master input has no video stream.")
    if not has_stream(narration_info, "audio"):
        raise SystemExit("Narration input has no audio stream.")
    video_duration = media_duration(video_info, "video")
    narration_duration = media_duration(narration_info, "audio")
    source_video = next(stream for stream in video_info["streams"] if stream.get("codec_type") == "video")
    source_color_fields = {
        "color_space": source_video.get("color_space"),
        "color_transfer": source_video.get("color_transfer"),
        "color_primaries": source_video.get("color_primaries"),
    }
    incompatible_color = {
        name: value
        for name, value in source_color_fields.items()
        if value not in {None, "unknown", "bt709"}
    }
    if incompatible_color:
        raise SystemExit(
            "Picture master input is not tagged BT.709; refusing to retag it without a deliberate "
            f"color conversion: {incompatible_color}"
        )
    if any(value in {None, "unknown"} for value in source_color_fields.values()):
        print("Warning: source color metadata is incomplete; assuming BT.709.", file=sys.stderr)
    if narration_duration > video_duration + 0.50 and not args.allow_narration_trim:
        raise SystemExit(
            f"Narration ({narration_duration:.3f}s) is longer than video ({video_duration:.3f}s). "
            "Extend/retime the real recording, or explicitly use --allow-narration-trim."
        )

    source_has_audio = has_stream(video_info, "audio")
    mix_source_audio = args.mix_source_audio and source_has_audio
    if args.mix_source_audio and not source_has_audio:
        print("Warning: picture master has no source audio; composing narration only.", file=sys.stderr)

    measurements = None if args.no_loudnorm else analyze_loudness(narration)
    narrate = narration_filter(measurements, not args.no_loudnorm)

    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{output.stem}.", suffix=".partial.mp4", dir=output.parent
    )
    os.close(descriptor)
    temp_output = Path(temporary_name)

    try:
        with tempfile.TemporaryDirectory(prefix="blender_education_") as temporary:
            temp_dir = Path(temporary)
            staged_captions: Path | None = None
            staged_overlay: Path | None = None
            if captions:
                staged_captions = temp_dir / "captions.ass"
                shutil.copy2(captions, staged_captions)
            if overlay:
                staged_overlay = temp_dir / "teaching_overlay.ass"
                shutil.copy2(overlay, staged_overlay)

            video_filters = [
                "scale=3840:2160:force_original_aspect_ratio=decrease:flags=lanczos",
                "pad=3840:2160:(ow-iw)/2:(oh-ih)/2:color=0x090D12",
                "setsar=1",
                f"fps={args.fps}",
            ]
            if staged_captions:
                video_filters.append(f"ass=filename={staged_captions.as_posix()}")
            if staged_overlay:
                video_filters.append(f"ass=filename={staged_overlay.as_posix()}")
            video_chain = f"[0:v:0]{','.join(video_filters)}[vout]"

            if mix_source_audio:
                source_chain = (
                    f"[0:a:0]aresample=48000,volume={args.source_audio_db:.2f}dB,apad[src]"
                )
                narration_chain = f"[1:a:0]{narrate},apad[narr]"
                mix_chain = (
                    "[src][narr]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0,"
                    "alimiter=limit=0.840:level=false[aout]"
                )
                filter_complex = ";".join([video_chain, source_chain, narration_chain, mix_chain])
            else:
                audio_chain = f"[1:a:0]{narrate},apad,alimiter=limit=0.840:level=false[aout]"
                filter_complex = ";".join([video_chain, audio_chain])

            command = [
                FFMPEG,
                "-hide_banner",
                "-y",
                "-i",
                str(video),
                "-i",
                str(narration),
                "-filter_complex",
                filter_complex,
                "-map",
                "[vout]",
                "-map",
                "[aout]",
                "-map_metadata",
                "-1",
                "-fps_mode",
                "cfr",
                "-r",
                str(args.fps),
            ]
            if args.codec == "h264":
                command += [
                    "-c:v",
                    "libx264",
                    "-preset",
                    args.preset,
                    "-crf",
                    f"{args.crf:g}",
                    "-profile:v",
                    "high",
                    "-level:v",
                    "5.1",
                    "-pix_fmt",
                    "yuv420p",
                    "-tag:v",
                    "avc1",
                ]
            else:
                command += [
                    "-c:v",
                    "libx265",
                    "-preset",
                    args.preset,
                    "-crf",
                    f"{args.crf:g}",
                    "-pix_fmt",
                    "yuv420p10le",
                    "-tag:v",
                    "hvc1",
                    "-x265-params",
                    "colorprim=bt709:transfer=bt709:colormatrix=bt709:range=limited",
                ]
            command += [
                "-color_range",
                "tv",
                "-color_primaries",
                "bt709",
                "-color_trc",
                "bt709",
                "-colorspace",
                "bt709",
                "-c:a",
                "aac",
                "-b:a",
                "256k",
                "-ar",
                "48000",
                "-ac",
                "2",
                "-metadata",
                f"title={args.title}",
                "-metadata:s:a:0",
                f"language={args.audio_language}",
                "-movflags",
                "+faststart",
                "-max_muxing_queue_size",
                "2048",
                "-t",
                f"{video_duration:.6f}",
                str(temp_output),
            ]
            run(command)

        if not temp_output.is_file() or temp_output.stat().st_size < 1024:
            raise SystemExit("Encoder did not create a plausible temporary output.")
        shallow_output_check(temp_output, args.codec, args.fps)
        os.replace(temp_output, output)
    finally:
        if temp_output.exists():
            temp_output.unlink()

    print(f"Created: {output}")
    if not args.skip_verify:
        verifier = SCRIPT_DIR / "verify_output.py"
        qa_report = (
            args.qa_report.expanduser().resolve()
            if args.qa_report
            else output.with_suffix(".qa.json")
        )
        verify_command = [
            sys.executable,
            str(verifier),
            str(output),
            "--expected-codec",
            args.codec,
            "--expected-fps",
            str(args.fps),
            "--expected-duration",
            f"{video_duration:.6f}",
            "--report",
            str(qa_report),
        ]
        if args.skip_decode:
            verify_command.append("--skip-decode")
        run(verify_command)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
