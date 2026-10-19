<!--
来源（轮子）: https://github.com/sunxiayi/make-blender-education-video-skill
License: MIT · 原作者: sunxiayi · 仅内部使用
入库批次: 2026-09-06 对称差扩容 W5（教育视频全链）。
Blender 5.2 雷区（仅 Blender 类配方适用）：① BLENDER_EEVEE_NEXT 已死，只认 BLENDER_EEVEE/BLENDER_WORKBENCH/CYCLES ② Filmic 已移除，AgX 为默认 ③ action.fcurves 在 4.4+ 移除，走 layers[*].strips[*].channelbags[*].fcurves
正文保留英文原文；MCP 调用表述执行时改走我方 bridge /v1/execute 同构协议。
-->

# Production Workflow

## Project layout

Use `brief/`, `sources/`, `scene/`, `renders/`, `audio/`, `overlays/`, `review/`, `qa/`, and `deliverables/`. Keep raw sources immutable and save descriptive Blender milestones.

## Approval gates

1. Confirm duration, audience, learning outcome, visual reference or style description, and research approach.
2. Review topic-specific GitHub candidates, licenses, provenance, compatibility, and proposed use.
3. Approve the English learning outcome, scope, claim ledger, storyboard, and visual grammar.
4. Approve exactly one style frame at the target delivery resolution containing a representative subtitle unless the user explicitly opted out of subtitles/captions. Labels, legends, chapter cards, and teaching overlays are never required in this frame; include them only when the user explicitly requested them. This approves visual treatment only, never motion design or animation quality.
5. Pass final evidence, visual, subtitle, audio, metadata, sync, and decode QA.

Do not render a motion sample or any full-video frames before the user explicitly approves the single style frame. If the user requests style changes, render one replacement frame and ask again. After approval, do not use the approved still as a video source or infer that static storytelling is approved; create genuine subject and process animation.

Voice selection is not an approval gate. Do not present a voice sample, ask for voice approval, or pause production after narration synthesis unless the user explicitly requested a voice audition or comparison.

## Blender strategy

Search GitHub for topic-specific Blender workflows and assets before modeling. Record candidates in `brief/github_resource_review.json`; review licenses, provenance, compatibility, dependencies, and code safety before use. Use scripts, Geometry Nodes, instancing, keyframes, rigs, shape keys, simulations, particles, deformers, or material animation as appropriate. Preserve real scale and coordinate conventions. Build reusable systems for exploded views, section cuts, highlights, and flows. Do not build label, legend, chapter-card, or teaching-overlay systems unless the user explicitly requested them. Produce a cinematic explainer rather than recording Blender UI operations.

For every narrated process shot, document the subject’s start state, animation driver, intermediate state, and end state. Camera animation is a separate layer and cannot satisfy the subject-animation requirement. Still images with pan, zoom, orbit, parallax, light sweeps, or crossfades are not acceptable substitutes for process motion.

## Narration

Copy `assets/narration_plan.template.json` after the required intake is complete. Keep cue boundaries on exact frames when practical. Maintain separate English display and TTS text plus a pronunciation dictionary.

Use `hexgrad/Kokoro-82M` exclusively for narration. Verify the model can load before production, select a suitable English voice autonomously, record its exact revision and voice identifier, and synthesize at native speed. Default to `af_heart` when the brief provides no contrary voice direction. Continue directly into production without seeking voice approval unless the user explicitly requested an audition. Do not substitute an operating-system voice, cloud service, another local TTS model, or a differently sized Kokoro model if Kokoro-82M is unavailable.

Generate a 48 kHz WAV master. Measure the encoded final audio, not only the source. Target approximately −16 LUFS integrated and no true peak above −1.5 dBTP unless the destination requires a different standard.

Treat native-speed narration as the timing master. Never change narration duration to force it into pre-existing shot windows, even by a small amount. Prohibit tempo or rate filters, pitch-preserving time stretching, sample interpolation, and NLE speed controls on generated speech. When timing does not fit:

1. Revise the script if the requested total duration is strict, then regenerate the narration at the intended original TTS speed.
2. Lock the regenerated waveform without duration-changing processing.
3. Measure the real cue and section durations.
4. Rearrange, extend, hold, or visually retime the shots to those measurements.
5. Regenerate subtitle timings and any explicitly requested optional scene-text timings from the same audio timeline.
6. Verify each source cue duration equals its placed duration and record that no post-generation time stretch was used.

Allow sample-rate conversion only when it preserves duration and pitch. Loudness normalization, EQ, compression, and limiting may be applied if they do not alter speech timing.

## Picture, subtitles, and optional scene text

Copy `assets/timeline_manifest.template.json`. Select only clean, genuinely animated source ranges. Exclude errors, wrong values, stalls, unintended repeated frames, static-image motion substitutes, black frames, blocking dialogs, and unstable renders.

Create captions from `assets/subtitle.template.ass` and burn them into the picture unless the user explicitly opted out of subtitles/captions. “No text in the picture,” “no on-screen text,” and requests to remove labels or legends affect optional scene text only; subtitles remain required. Labels, legends, chapter cards, and teaching overlays are universally optional and omitted by default. Use ASS overlays only when the user explicitly requests them. Use large white sans-serif subtitles centered near the bottom, with a dark outline, subtle shadow, no opaque box, generous side margins, and no more than two lines. Inspect exact subtitle frames and any requested overlay frames visually.

Run `assemble_picture.py` in preflight mode, then assemble the final-quality picture. Use motivated cuts and transitions for scale, section, or process changes.

## Composition

Use `compose_tutorial.py` to combine picture, narration, burned-in subtitles, and optional overlays. Always set the audio language to `eng`. The script requires either `--captions` or the explicit `--no-captions` opt-out flag. Prefer H.264/`avc1` for compatibility and H.265/`hvc1` Main10 for supported high-quality archives.

## QA

Use `verify_output.py` to require one video and one audio stream, the target delivery resolution (1920×1080 by default), requested constant frame rate, correct codec tag and pixel format, BT.709 metadata, AAC 48 kHz stereo, expected duration, correct frame count, synchronized streams, and clean full decode.

Create entry/middle/exit frame triplets for every narrated process shot, plus a contact sheet at chapter boundaries. Confirm that the subject state changes across the triplet even when camera motion is ignored, and that cause precedes effect. Reject still-image pans, zooms, orbits, parallax passes, crossfade montages, repeated frames, and light-only changes when they carry a process explanation.

Copy `assets/motion_qa.template.json` to `qa/motion_qa.json` and complete it for every narrated process shot. Each entry must pass `subject_change_visible_without_camera_motion` and `cause_precedes_effect`, and must set `static_substitute_detected` to false. Inspect section cuts, transparency, black regions, subtitle readability and collisions, aliasing, render noise, and temporal artifacts. Inspect labels, legends, chapter cards, or teaching overlays only when the user explicitly requested and included them. Recheck every visible detail against the claim ledger. Structural QA never replaces evidence, temporal, or visual QA.
