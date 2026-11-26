#!/usr/bin/env python3
"""Assemble a frame-exact, picture-only cinematic timeline from a JSON manifest.

Every shot is normalized to BT.709 limited range, retimed to an explicit output
frame count, and joined with hard cuts. The destination is replaced atomically
only after the temporary encode passes structural and full-decode checks.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from fractions import Fraction
import json
import math
import os
from pathlib import Path
import shlex
import shutil
import subprocess
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


FFMPEG = find_tool("FFMPEG", ["/opt/homebrew/bin/ffmpeg", "ffmpeg"])
FFPROBE = find_tool("FFPROBE", ["/opt/homebrew/bin/ffprobe", "ffprobe"])


@dataclass(frozen=True)
class Shot:
    id: str
    chapter: str
    kind: str
    path: Path
    output_frames: int
    color_assumption: str
    source_in_frame: int = 0
    source_out_frame: int = 0
    motion: str = "hold"

    @property
    def source_frames(self) -> int:
        return self.source_out_frame - self.source_in_frame


@dataclass(frozen=True)
class Timeline:
    fps: int
    width: int
    height: int
    total_frames: int
    background: str
    shots: tuple[Shot, ...]


def run(command: list[str], *, capture: bool = False) -> subprocess.CompletedProcess[str]:
    print("+", " ".join(shlex.quote(part) for part in command), flush=True)
    return subprocess.run(
        command,
        check=True,
        text=True,
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.PIPE if capture else None,
    )


def require_positive_int(value: Any, label: str) -> int:
    if isinstance(value, bool):
        raise SystemExit(f"{label} must be a positive integer.")
    try:
        integer = int(value)
    except (TypeError, ValueError):
        raise SystemExit(f"{label} must be a positive integer.") from None
    if integer <= 0 or integer != value:
        raise SystemExit(f"{label} must be a positive integer.")
    return integer


def seconds_to_frame(value: Any, fps: int, label: str) -> int:
    try:
        seconds = Fraction(str(value))
    except (ValueError, ZeroDivisionError):
        raise SystemExit(f"{label} must be an exact decimal number of seconds.") from None
    frame = seconds * fps
    if frame.denominator != 1:
        raise SystemExit(f"{label}={value!r} is not on a {fps} fps frame boundary.")
    if frame < 0:
        raise SystemExit(f"{label} must not be negative.")
    return frame.numerator


def ratio(value: str | None) -> Fraction | None:
    if not value or value in {"N/A", "0/0"}:
        return None
    try:
        return Fraction(value)
    except (ValueError, ZeroDivisionError):
        return None


def probe_video(path: Path) -> dict[str, Any]:
    result = run(
        [
            FFPROBE,
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            (
                "stream=codec_name,width,height,pix_fmt,r_frame_rate,avg_frame_rate,"
                "nb_frames,duration,color_range,color_space,color_transfer,color_primaries:"
                "format=duration"
            ),
            "-of",
            "json",
            str(path),
        ],
        capture=True,
    )
    info = json.loads(result.stdout)
    streams = info.get("streams", [])
    if len(streams) != 1:
        raise SystemExit(f"Expected one primary video stream in {path}, found {len(streams)}.")
    return info


def media_frame_capacity(info: dict[str, Any], fps: int) -> int:
    stream = info["streams"][0]
    try:
        frames = int(stream.get("nb_frames"))
    except (TypeError, ValueError):
        frames = 0
    if frames > 0:
        return frames
    duration_value = stream.get("duration") or info.get("format", {}).get("duration")
    try:
        duration = Fraction(str(duration_value))
    except (ValueError, ZeroDivisionError):
        raise SystemExit("Could not determine source duration or frame count.") from None
    return math.floor(duration * fps)


def load_timeline(manifest_path: Path) -> Timeline:
    manifest = manifest_path.expanduser().resolve()
    if not manifest.is_file():
        raise SystemExit(f"Missing manifest: {manifest}")
    try:
        data = json.loads(manifest.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise SystemExit(f"Invalid JSON manifest: {exc}") from None
    if data.get("version") != 1:
        raise SystemExit("Manifest version must be 1.")

    canvas = data.get("canvas")
    if not isinstance(canvas, dict):
        raise SystemExit("Manifest canvas must be an object.")
    fps = require_positive_int(canvas.get("fps"), "canvas.fps")
    width = require_positive_int(canvas.get("width"), "canvas.width")
    height = require_positive_int(canvas.get("height"), "canvas.height")
    total_frames = require_positive_int(canvas.get("total_frames"), "canvas.total_frames")
    background = str(canvas.get("background", "0x090D12"))
    if canvas.get("color") != "bt709_limited":
        raise SystemExit("Manifest canvas.color must be bt709_limited.")

    chapters = data.get("chapters")
    if not isinstance(chapters, list) or not chapters:
        raise SystemExit("Manifest chapters must be a non-empty list.")

    manifest_dir = manifest.parent
    shots: list[Shot] = []
    ids: set[str] = set()
    running_frame = 0
    probe_cache: dict[Path, dict[str, Any]] = {}

    for chapter_index, chapter_data in enumerate(chapters):
        if not isinstance(chapter_data, dict):
            raise SystemExit(f"chapters[{chapter_index}] must be an object.")
        chapter_id = str(chapter_data.get("id", "")).strip()
        if not chapter_id:
            raise SystemExit(f"chapters[{chapter_index}].id is required.")
        chapter_start = int(chapter_data.get("start_frame", -1))
        if chapter_start != running_frame:
            raise SystemExit(
                f"Chapter {chapter_id} starts at {chapter_start}, expected contiguous frame {running_frame}."
            )
        chapter_frames = require_positive_int(
            chapter_data.get("output_frames"), f"chapter {chapter_id}.output_frames"
        )
        chapter_shots = chapter_data.get("shots")
        if not isinstance(chapter_shots, list) or not chapter_shots:
            raise SystemExit(f"Chapter {chapter_id} must contain at least one shot.")
        chapter_sum = 0

        for shot_index, shot_data in enumerate(chapter_shots):
            if not isinstance(shot_data, dict):
                raise SystemExit(f"Chapter {chapter_id} shot {shot_index} must be an object.")
            shot_id = str(shot_data.get("id", "")).strip()
            if not shot_id or shot_id in ids:
                raise SystemExit(f"Shot IDs must be present and unique; invalid ID: {shot_id!r}.")
            ids.add(shot_id)
            kind = shot_data.get("kind")
            if kind not in {"video", "still"}:
                raise SystemExit(f"Shot {shot_id} kind must be video or still.")
            path_value = shot_data.get("path")
            if not isinstance(path_value, str) or not path_value.strip():
                raise SystemExit(f"Shot {shot_id} path is required.")
            path = (manifest_dir / path_value).resolve()
            if not path.is_file():
                raise SystemExit(f"Missing source for shot {shot_id}: {path}")
            output_frames = require_positive_int(
                shot_data.get("output_frames"), f"shot {shot_id}.output_frames"
            )
            color_assumption = shot_data.get("color_assumption")
            expected_color = "bt709_limited" if kind == "video" else "srgb_full"
            if color_assumption != expected_color:
                raise SystemExit(
                    f"Shot {shot_id} color_assumption must be {expected_color} for {kind} sources."
                )

            source_in_frame = 0
            source_out_frame = 0
            motion = str(shot_data.get("motion", "hold"))
            if kind == "still":
                if motion != "hold":
                    raise SystemExit(f"Shot {shot_id} currently supports only motion=hold.")
                if path not in probe_cache:
                    probe_cache[path] = probe_video(path)
            else:
                source_in_frame = seconds_to_frame(
                    shot_data.get("source_in_seconds"), fps, f"shot {shot_id}.source_in_seconds"
                )
                source_out_frame = seconds_to_frame(
                    shot_data.get("source_out_seconds"), fps, f"shot {shot_id}.source_out_seconds"
                )
                if source_out_frame <= source_in_frame:
                    raise SystemExit(f"Shot {shot_id} source range must have positive duration.")
                if path not in probe_cache:
                    probe_cache[path] = probe_video(path)
                info = probe_cache[path]
                stream = info["streams"][0]
                source_rate = ratio(stream.get("avg_frame_rate")) or ratio(stream.get("r_frame_rate"))
                if source_rate != Fraction(fps, 1):
                    raise SystemExit(
                        f"Shot {shot_id} source is {source_rate} fps; exact {fps} fps is required."
                    )
                capacity = media_frame_capacity(info, fps)
                if source_out_frame > capacity:
                    raise SystemExit(
                        f"Shot {shot_id} ends at source frame {source_out_frame}, beyond {capacity}."
                    )

            shots.append(
                Shot(
                    id=shot_id,
                    chapter=chapter_id,
                    kind=kind,
                    path=path,
                    output_frames=output_frames,
                    color_assumption=color_assumption,
                    source_in_frame=source_in_frame,
                    source_out_frame=source_out_frame,
                    motion=motion,
                )
            )
            chapter_sum += output_frames

        if chapter_sum != chapter_frames:
            raise SystemExit(
                f"Chapter {chapter_id} shots total {chapter_sum} frames, expected {chapter_frames}."
            )
        running_frame += chapter_frames

    if running_frame != total_frames:
        raise SystemExit(f"Chapters total {running_frame} frames, expected {total_frames}.")
    return Timeline(
        fps=fps,
        width=width,
        height=height,
        total_frames=total_frames,
        background=background,
        shots=tuple(shots),
    )


def frame_time(frame: int, fps: int) -> str:
    return f"{frame / fps:.9f}".rstrip("0").rstrip(".") or "0"


def print_preflight(timeline: Timeline, width: int, height: int) -> None:
    print(
        f"Timeline: {timeline.total_frames} frames / "
        f"{timeline.total_frames / timeline.fps:.3f}s @ {timeline.fps} fps, {width}x{height}"
    )
    print("Timeline frames   Output  Source frames  Chapter / shot")
    start = 0
    for shot in timeline.shots:
        end = start + shot.output_frames
        source = str(shot.source_frames) if shot.kind == "video" else "still"
        print(
            f"{start:04d}-{end:04d}       {shot.output_frames:4d}    "
            f"{source:>6}         {shot.chapter} / {shot.id}"
        )
        start = end


def build_ffmpeg_command(
    timeline: Timeline,
    *,
    width: int,
    height: int,
    output: Path,
    codec: str,
    preset: str,
    crf: float,
    title: str,
) -> list[str]:
    fps = timeline.fps
    command = [FFMPEG, "-hide_banner", "-y"]
    filters: list[str] = []
    labels: list[str] = []

    for index, shot in enumerate(timeline.shots):
        if shot.kind == "still":
            # Decode and color-convert a still only once. The post-fps tpad
            # below holds that converted frame for the requested duration.
            command += ["-i", str(shot.path)]
            color_normalize = (
                "colorspace=ispace=gbr:irange=pc:iprimaries=bt709:itrc=srgb:"
                "space=bt709:range=tv:primaries=bt709:trc=bt709:format=yuv420p"
            )
            retime = "setpts=PTS-STARTPTS"
            pad_frames = shot.output_frames + 1
        else:
            command += [
                "-ss",
                frame_time(shot.source_in_frame, fps),
                "-t",
                frame_time(shot.source_frames, fps),
                "-i",
                str(shot.path),
            ]
            color_normalize = (
                "setparams=range=limited:color_primaries=bt709:"
                "color_trc=bt709:colorspace=bt709"
            )
            retime = (
                f"trim=start_frame=0:end_frame={shot.source_frames},"
                f"settb=expr=AVTB,setpts=(PTS-STARTPTS)*{shot.output_frames}/{shot.source_frames}"
            )
            pad_frames = fps

        label = f"shot{index}"
        labels.append(f"[{label}]")
        filters.append(
            f"[{index}:v:0]{color_normalize},"
            f"scale={width}:{height}:force_original_aspect_ratio=decrease:flags=lanczos:"
            "in_color_matrix=bt709:out_color_matrix=bt709:in_range=limited:out_range=limited,"
            f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color={timeline.background},"
            f"{retime},fps=fps={fps}:start_time=0:round=near,"
            f"tpad=stop_mode=clone:stop={pad_frames},"
            f"trim=start_frame=0:end_frame={shot.output_frames},"
            f"settb=expr=1/{fps},setpts=N,format=yuv420p,setsar=1,"
            "setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709"
            f"[{label}]"
        )

    filters.append(
        "".join(labels)
        + f"concat=n={len(labels)}:v=1:a=0,"
        + f"fps=fps={fps}:start_time=0:round=near,"
        + "tpad=stop_mode=clone:stop_duration=1,"
        + f"trim=start_frame=0:end_frame={timeline.total_frames},"
        + f"settb=expr=1/{fps},setpts=N,format=yuv420p,setsar=1,"
        + "setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709"
        + "[vout]"
    )
    command += [
        "-filter_complex",
        ";".join(filters),
        "-map",
        "[vout]",
        "-an",
        "-map_metadata",
        "-1",
        "-fps_mode",
        "cfr",
        "-r",
        str(fps),
        "-frames:v",
        str(timeline.total_frames),
    ]
    if codec == "h264":
        command += [
            "-c:v",
            "libx264",
            "-preset",
            preset,
            "-crf",
            f"{crf:g}",
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
            preset,
            "-crf",
            f"{crf:g}",
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
        "-metadata",
        f"title={title}",
        "-movflags",
        "+faststart",
        "-max_muxing_queue_size",
        "2048",
        str(output),
    ]
    return command


def verify_output(
    path: Path,
    *,
    timeline: Timeline,
    width: int,
    height: int,
    codec: str,
    full_decode: bool,
) -> dict[str, Any]:
    result = run(
        [
            FFPROBE,
            "-v",
            "error",
            "-count_frames",
            "-show_streams",
            "-show_format",
            "-of",
            "json",
            str(path),
        ],
        capture=True,
    )
    info = json.loads(result.stdout)
    videos = [stream for stream in info.get("streams", []) if stream.get("codec_type") == "video"]
    audios = [stream for stream in info.get("streams", []) if stream.get("codec_type") == "audio"]
    if len(videos) != 1 or audios:
        raise SystemExit("Picture assembly must contain exactly one video stream and no audio streams.")
    video = videos[0]
    expected_codec = "h264" if codec == "h264" else "hevc"
    expected_tag = "avc1" if codec == "h264" else "hvc1"
    expected_pix_fmt = "yuv420p" if codec == "h264" else "yuv420p10le"
    observed_frames = int(video.get("nb_read_frames") or video.get("nb_frames") or 0)
    observed_rate = ratio(video.get("avg_frame_rate")) or ratio(video.get("r_frame_rate"))
    expected_duration = Fraction(timeline.total_frames, timeline.fps)
    try:
        observed_duration = Fraction(str(video.get("duration")))
    except (ValueError, ZeroDivisionError):
        observed_duration = Fraction(str(info.get("format", {}).get("duration", "-1")))

    checks = {
        "resolution": (video.get("width"), video.get("height")) == (width, height),
        "codec": video.get("codec_name") == expected_codec,
        "codec_tag": video.get("codec_tag_string") == expected_tag,
        "pixel_format": video.get("pix_fmt") == expected_pix_fmt,
        "frame_rate": observed_rate == Fraction(timeline.fps, 1),
        "frame_count": observed_frames == timeline.total_frames,
        "duration": abs(observed_duration - expected_duration) <= Fraction(1, 1000),
        "color_range": video.get("color_range") == "tv",
        "color_space": video.get("color_space") == "bt709",
        "color_transfer": video.get("color_transfer") == "bt709",
        "color_primaries": video.get("color_primaries") == "bt709",
    }
    failures = [name for name, passed in checks.items() if not passed]
    if failures:
        raise SystemExit(
            "Temporary encode failed checks: "
            + ", ".join(failures)
            + f" (frames={observed_frames}, duration={float(observed_duration):.6f}s)."
        )
    if full_decode:
        run(
            [
                FFMPEG,
                "-hide_banner",
                "-v",
                "error",
                "-xerror",
                "-i",
                str(path),
                "-map",
                "0:v:0",
                "-f",
                "null",
                "-",
            ]
        )
    return {
        "frames": observed_frames,
        "duration_seconds": float(observed_duration),
        "fps": float(observed_rate) if observed_rate is not None else None,
        "resolution": [video.get("width"), video.get("height")],
        "codec": video.get("codec_name"),
        "pixel_format": video.get("pix_fmt"),
        "color_range": video.get("color_range"),
        "color_space": video.get("color_space"),
        "color_transfer": video.get("color_transfer"),
        "color_primaries": video.get("color_primaries"),
        "full_decode": full_decode,
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Assemble a frame-exact, picture-only cinematic timeline.")
    parser.add_argument(
        "--manifest",
        type=Path,
        default=PROJECT_DIR / "timeline_manifest.json",
        help="Timeline JSON; defaults to the project timeline_manifest.json",
    )
    parser.add_argument("--output", type=Path, help="Destination .mp4; omitted for --preflight-only")
    parser.add_argument("--width", type=int, help="Override manifest width, for example 960")
    parser.add_argument("--height", type=int, help="Override manifest height, for example 540")
    parser.add_argument("--codec", choices=["h264", "h265"], default="h264")
    parser.add_argument(
        "--preset",
        choices=["ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow", "slower", "veryslow"],
        default="medium",
    )
    parser.add_argument("--crf", type=float, help="Defaults to 18 for H.264 or 15 for H.265")
    parser.add_argument("--title", default="Blender Education Video Picture Master")
    parser.add_argument("--force", action="store_true", help="Atomically replace an existing output")
    parser.add_argument("--preflight-only", action="store_true", help="Validate and print the timeline without encoding")
    parser.add_argument("--skip-decode", action="store_true", help="Skip the final full decode test")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    timeline = load_timeline(args.manifest)
    width = args.width if args.width is not None else timeline.width
    height = args.height if args.height is not None else timeline.height
    if width <= 0 or height <= 0 or width % 2 or height % 2:
        raise SystemExit("Output width and height must be positive even integers.")
    print_preflight(timeline, width, height)
    if args.preflight_only:
        return 0
    if args.output is None:
        raise SystemExit("--output is required unless --preflight-only is used.")

    output = args.output.expanduser().resolve()
    if output.suffix.lower() != ".mp4":
        raise SystemExit("Output must use the .mp4 extension.")
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists() and not args.force:
        raise SystemExit(f"Output already exists; use --force to replace atomically: {output}")
    crf = args.crf if args.crf is not None else (18.0 if args.codec == "h264" else 15.0)
    if not math.isfinite(crf) or crf < 0 or crf > 51:
        raise SystemExit("--crf must be between 0 and 51.")

    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{output.stem}.", suffix=".partial.mp4", dir=output.parent
    )
    os.close(descriptor)
    temporary_output = Path(temporary_name)
    try:
        command = build_ffmpeg_command(
            timeline,
            width=width,
            height=height,
            output=temporary_output,
            codec=args.codec,
            preset=args.preset,
            crf=crf,
            title=args.title,
        )
        run(command)
        if not temporary_output.is_file() or temporary_output.stat().st_size < 1024:
            raise SystemExit("Encoder did not create a plausible temporary output.")
        qa = verify_output(
            temporary_output,
            timeline=timeline,
            width=width,
            height=height,
            codec=args.codec,
            full_decode=not args.skip_decode,
        )
        os.chmod(temporary_output, 0o644)
        os.replace(temporary_output, output)
    finally:
        if temporary_output.exists():
            temporary_output.unlink()

    print(f"Created: {output}")
    print(
        f"Verified: {qa['frames']} frames, {qa['duration_seconds']:.3f}s, "
        f"{qa['resolution'][0]}x{qa['resolution'][1]}, {qa['codec']}, "
        f"{qa['color_space']}/{qa['color_range']}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
