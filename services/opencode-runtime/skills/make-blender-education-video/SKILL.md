---
name: make-blender-education-video
description: 用 Blender 制作英文科教类电影级动画（科学/工程/建筑）。仅当用户明确要「英文科普/教学动画长片」时使用；一般 3D 需求走 blender-director。
---
<!--
来源（轮子）: https://github.com/sunxiayi/make-blender-education-video-skill
License: MIT · 原作者: sunxiayi · 仅内部使用
入库批次: 2026-09-06 对称差扩容 W5（教育视频全链）。
Blender 5.2 雷区（仅 Blender 类配方适用）：① BLENDER_EEVEE_NEXT 已死，只认 BLENDER_EEVEE/BLENDER_WORKBENCH/CYCLES ② Filmic 已移除，AgX 为默认 ③ action.fcurves 在 4.4+ 移除，走 layers[*].strips[*].channelbags[*].fcurves
正文保留英文原文；MCP 调用表述执行时改走我方 bridge /v1/execute 同构协议。
-->


# Make Blender Education Video

**先查库**：接到任务先 `asset_search` 查 blender-3d-assets（场景/模型）、cmu-mocap/mhr（人物动作）包（免费），命中先复用再搭景，查空才自造。

Create an English cinematic explainer that teaches a correct mental model and meets an explicit visual-quality reference.

## Prerequisite: the Blender toolchain must be reachable

Blender rendering runs through this harness's Blender toolchain (`blender_exec`, `blender_render`, `blender_export_gltf`, backed by the Blender bridge). Before creating scenes, running Blender Python, or rendering any frame, confirm the toolchain is reachable and reports a Blender version. If the toolchain is unavailable, report the environment gap honestly and look for a viable alternative path before escalating to the user; never stop production merely by asking the user to install Blender themselves. Report the detected Blender version before proceeding.

## Non-negotiable output

- Produce English narration and burned-in English subtitles. Preserve official names, formulas, symbols, and necessary technical terms. Labels, legends, chapter cards, and teaching overlays are universally optional: never make them an intake, approval, production, QA, or delivery requirement. Omit them by default and add them only when the user explicitly requests them.
- Generate all narration with **Kokoro-82M** (`hexgrad/Kokoro-82M`). Do not substitute a system voice, another local TTS model, a cloud TTS service, or a differently sized Kokoro model. If Kokoro-82M cannot be loaded, stop and report the dependency problem instead of silently falling back.
- Voice selection is not a user-approval gate. Unless the user explicitly asks to audition or choose voices, select a suitable English Kokoro-82M voice autonomously, generate the production narration, and continue without presenting a voice sample or pausing for voice approval. Default to `af_heart` when the brief provides no contrary voice direction.
- Interpret requests such as “no text in the picture,” “no on-screen text,” or “remove the labels/legend” as removing scene text, labels, legends, chapter cards, and teaching overlays only. These requests do **not** remove subtitles. Omit subtitles only when the user explicitly says “no subtitles,” “no captions,” or otherwise names subtitles/captions directly.
- Produce a cinematic explainer only. Do not create a Blender UI tutorial, cursor recording, or hybrid tutorial.
- Treat the single approval frame as approval of the **visual system only**: materials, lighting, composition, detail, depth of field, and subtitle treatment. It does not approve motion design, animation quality, pacing, process coverage, or explanatory completeness.
- Animate the subject and the process for real in Blender. Every narrated process shot must show a meaningful frame-to-frame change in the relevant material, object, mechanism, flow, or system state, including the cause and visible effect. Camera movement alone does not count as process animation.
- Never substitute a still image, slideshow, repeated frame, Ken Burns pan/zoom, 2.5D drift, or crossfade montage for an animation that is supposed to explain manufacturing, operation, construction, transformation, biological change, transport, or another dynamic process. Brief still holds are allowed only for establishing context, transitions, or emphasis; they must not carry the process explanation.
- Burn English subtitles into the final picture using the required subtitle style below unless the user explicitly opts out of subtitles or captions.
- Default delivery to 16:9, 1920x1080, and 30 fps unless the user requests different specifications. Match the resolution to the delivery target; use 4K (3840x2160) only when the user explicitly asks for it.
- Never speed up, slow down, time-stretch, or time-compress generated narration, including micro-adjustments made only to fit shot boundaries. Treat native-speed narration as timing authority: regenerate it at the intended original speed when needed, then rearrange, extend, or retime the picture edit and rebuild subtitle timings around the resulting waveform.
- Treat physical plausibility as a hard approval requirement. Every salient object, material, interface, and motion shown in a literal scene must have a real-world counterpart or authoritative reference at the depicted scale. Reject decorative or conceptual stand-ins that could be mistaken for literal equipment, material, or process behavior.
- Never represent microscopic fibers, molecules, forces, field lines, flow, or other invisible phenomena as macroscopic solid rods, tubes, wires, or particles inside an otherwise literal scene. When such teaching imagery is necessary, isolate it in a clearly disclosed conceptual inset or scale-transition shot.
- Preserve the real material of equipment in cutaways. Reveal an opaque vessel, housing, body, wall, or shell with a section cut, transparency treatment, or removable surface; do not replace it with a glass object unless the real object is made of glass.
- Before showing an approval frame, inspect it at 100% and reject it for flat materials, alpha-dither noise, plastic-looking metal, unsupported visible objects, implausible scale, floating parts, missing contacts, or geometry that leaves its intended enclosure because of an incorrect transform origin.

## Run the required intake first

Before researching, planning, opening Blender, or creating an artifact, ask the user to confirm all of the following in one concise intake message. Prefill details already supplied, but always request explicit confirmation.

1. **Duration:** How long should the finished video be?
2. **Audience:** Who are the target viewers, and what can they already be expected to know?
3. **Learning outcome:** What should viewers be able to explain after watching?
4. **Visual reference:** Ask the user to upload or link an example video for quality, detailing, camera, lighting, and pacing reference, or describe the desired style in concrete terms. Require one of these before continuing.
5. **Research approach:** Ask whether the agent should research the subject, the user will supply reference articles, URLs, or files, or both. Ask the user to attach or link every source they want used.

Also confirm any choice that changes factual content, such as jurisdiction, construction system, species, machine variant, historical period, or required level of abstraction. Wait for the user's answers before continuing.

## Read the supporting references

- Read [evidence-and-explanation.md](references/evidence-and-explanation.md) before research, outlining, labeling, or narration.
- Read [github-workflow-discovery.md](references/github-workflow-discovery.md) before searching for, downloading, importing, or executing a GitHub resource.
- Read [story-patterns.md](references/story-patterns.md) before storyboarding. Select one primary pattern and at most two supporting patterns.
- Read [visual-quality.md](references/visual-quality.md) before modeling, shading, lighting, camera work, or rendering.
- Read [production-workflow.md](references/production-workflow.md) before narration, editing, or delivery.

## Resolve tools and paths

Resolve this skill's installed directory as an absolute path before invoking bundled scripts. Do not assume the current working directory is the skill directory.

After the intake and before production, verify the Blender toolchain is still reachable, then verify that Python 3.9 or newer, FFmpeg, and FFprobe are available. Confirm that FFmpeg provides the required H.264 or H.265 encoder and ASS/libass subtitle filter. Verify that the Kokoro-82M runtime can load `hexgrad/Kokoro-82M` and synthesize the selected English voice at native speed. Record the exact Kokoro-82M model revision and voice used. If a dependency is missing, report it before creating scenes or renders; do not substitute another TTS engine. Never attempt Blender production through a web substitute when the Blender toolchain is unavailable. Confirm that the selected subtitle font is installed; if Arial is unavailable, use a metrically suitable sans-serif substitute and visually recheck wrapping and safe margins.

## Follow the workflow

### 1. Establish the evidence boundary

Use the research approach chosen by the user. When the agent researches, use authoritative primary sources for every factual detail. Treat user-provided sources as required inputs, but do not assume they are correct; cross-check them when the user permits outside research. If the user restricts research to supplied material, omit or clearly flag anything those materials cannot verify.

Create a claim ledger covering narration, any optional on-screen text, geometry, materials, proportions, sequence, motion, causal relationships, numbers, and symbolic visual encodings. Each entry must include its source and one of these statuses:

- `verified`: directly supported by authoritative evidence;
- `inferred`: a necessary conclusion supported by evidence and explicitly qualified;
- `conceptual`: a teaching abstraction disclosed as conceptual, schematic, compressed, or not to scale through narration/subtitles and distinct visual treatment.

Fact-check the outline, storyboard, narration, any optional labels, and final visuals against this ledger. Never guess, fill gaps with plausible details, or present decorative choices as facts. If a detail cannot be verified, remove it or disclose its uncertainty.

### 2. Search GitHub for reusable Blender resources

After the required intake, always search GitHub for existing workflows, application templates, add-ons, scripts, Geometry Nodes setups, `.blend` files, and appropriately licensed 3D assets related to the exact topic. Follow [github-workflow-discovery.md](references/github-workflow-discovery.md).

Create `brief/github_resource_review.json` from [github_resource_review.template.json](assets/github_resource_review.template.json). Record the search queries, repository URL, exact commit or release, intended use, Blender compatibility, license, upstream asset provenance, dependencies, security review, and accept/reject decision for every serious candidate.

Treat GitHub resources as production accelerators, not factual authorities. Verify all scientific, medical, engineering, and historical claims independently through the evidence workflow. Never execute repository code or import active-content files before inspecting them. Do not reuse a repository without a clear compatible license and required attribution terms.

For human anatomy projects, evaluate [Z-Anatomy/Models-of-human-anatomy](https://github.com/Z-Anatomy/Models-of-human-anatomy) as one candidate. Review the license and provenance of each specific model before use because the repository includes material derived from multiple upstream sources.

### 3. Design the explanation

Define the exact learning outcome, audience assumptions, duration, technical scope, and truth level of the visuals. Select an explanatory pattern from [story-patterns.md](references/story-patterns.md), then create a shot table with one teaching objective, one narration idea, one subject-state change, and one causal visual action per shot. Record the start state, motion driver, intermediate state, and end state. Prefer 6–12 second shots and a clear causal order.

### 4. Translate the visual reference into a style brief

Inspect the supplied example video or style description. Record the intended level of detail, realism, material treatment, lighting, palette, camera language, motion pace, depth of field, subtitle treatment, and overall density. Record typography or label behavior only when the user explicitly requests optional scene text. Use the reference as a quality and style target without copying distinctive frames or protected creative elements literally. Track optional scene text and subtitles as separate decisions; omitting the former does not disable the latter.

### 5. Create a safe project

Work in a dedicated directory and preserve source files and unrelated `.blend` files. Initialize the project with:

```bash
python3 /ABS/PATH/TO/SKILL/scripts/init_blender_education_project.py /ABS/PATH/project-name
```

Keep the brief, sources, scene files, renders, audio, overlays, reviews, QA, and deliverables separate.

### 6. Build the visual system

Use Blender Python, Geometry Nodes, or instancing for repeated or dense structures. Preserve plausible scale relationships. Add geometry where silhouette, parallax, contact, deformation, or close-up readability requires it. Use textures, decals, and shaders for sub-pixel information. Build reusable highlight, cutaway, exploded-view, and flow systems before animating individual shots. Do not build label, legend, chapter-card, or teaching-overlay systems unless the user explicitly requested them.

### 7. Render exactly one approval frame and stop

Apply [visual-quality.md](references/visual-quality.md). Render exactly one representative frame at the target delivery resolution containing the hardest material, finest readable detail, darkest region, brightest highlight, and intended depth of field. Do not require a label, legend, chapter card, or teaching overlay in the approval frame. Include optional scene text only when the user explicitly requested it. Include one sample burned-in subtitle unless the user explicitly opted out of subtitles/captions.

Show the frame to the user and ask: **"Would you like to modify the style, level of detail, composition, lighting, or subtitle treatment before I create the full video?"** If the user explicitly requested optional scene text, also ask about its treatment. Wait for an explicit response.

If the user requests changes, revise the scene and render one replacement frame for the next approval round. Do not render a motion sample, frame sequence, chapter, or full video until the user explicitly approves the current frame. This is a hard production gate.

Approval of this frame authorizes use of its visual language only. Never infer that the user has approved static storytelling, limited animation, motion quality, process choreography, camera pacing, or the finished explanation. After frame approval, build the real motion plan and animate the process; do not turn the approved image itself into the video.

### 8. Animate the approved visual system

After explicit frame approval, animate the full cinematic explainer as genuine continuous Blender motion. Use one dominant visual action per sentence, reveal structure in causal order, and preserve orientation between wide views and close-ups. Use keyframed mechanisms, rigs, shape keys, simulations, particles, Geometry Nodes, material-state animation, deforming geometry, or other appropriate techniques so the subject visibly changes across frames.

For every narrated process shot:

1. establish the relevant start state;
2. animate the physical, biological, chemical, informational, or conceptual driver;
3. show the resulting motion or transformation;
4. end on a visibly different state that prepares the next shot.

The subject-space change must remain meaningful even if the camera transform is ignored. A dolly, orbit, zoom, parallax pass, rack focus, light sweep, or crossfade may support the action but cannot be the action. Do not build a process sequence from animated crops of still renders.

Use transparency, isolation, section cuts, exploded views, color highlights, particles, arrows, or field lines only when each has a defined meaning.

Distinguish literal motion from teaching motion. Disclose impossible camera travel, compressed time, symbolic color, and conceptual flow wherever viewers could mistake them for reality. By default, make the disclosure through narration, subtitles, and distinct visual treatment. Never require a label, legend, or teaching overlay for this disclosure.

### 9. Write English narration and burned-in subtitles

Explain each object, stage, or mechanism through four questions: what it is, what changes or moves, what causes the change, and why it matters to the whole system.

Maintain separate `display` and `tts` strings in English. `display` is the subtitle text; `tts` is the pronunciation-friendly input sent to Kokoro-82M. Create a pronunciation map for acronyms, units, formulas, and product names.

Generate the narration exclusively with `hexgrad/Kokoro-82M`. Select an English Kokoro voice that matches the supplied visual/voice reference or stated tone; when neither supplies voice direction, use `af_heart`. Voice selection is an internal production decision unless the user explicitly requests an audition. Do not ask for voice approval or pause production after synthesis. Keep the model at native speaking speed, and record the model revision, voice identifier, and synthesis settings in the project notes. Do not use an operating-system voice or another TTS engine as a preview or production fallback. Target approximately -16 LUFS integrated, no true peak above -1.5 dBTP, 48 kHz audio, and exact timeline duration.

Generate narration at the intended native TTS speed and lock its waveform before final picture timing. Do not use `atempo`, `asetrate`, Rubber Band, phase-vocoder stretching, sample interpolation, NLE rate controls, or any other duration-changing process on narration. If the spoken material does not fit the requested duration, revise the script and regenerate it at native speed; otherwise let the finished duration change. To restore synchronization, rebuild shot boundaries, holds, transitions, subtitle cues, and any explicitly requested optional overlays from the regenerated audio. Sample-rate conversion such as 24 kHz to 48 kHz is allowed only when it preserves the narration's duration and pitch.

Unless the user explicitly opted out of subtitles/captions, author captions as ASS using [subtitle.template.ass](assets/subtitle.template.ass) and burn them into every narrated scene. A request for no text, labels, legends, chapter cards, or teaching overlays is not a subtitle opt-out. Match the supplied reference image:

- large white or very light gray sans-serif text;
- centered near the bottom of the frame;
- dark outline plus a subtle shadow for readability on any background;
- no opaque caption box;
- generous left and right safe margins;
- one line when readable and no more than two lines;
- natural sentence case, synchronized to the spoken phrase.

At 1920x1080, start with 46 px Arial, a 3 px dark outline, a 1 px shadow, 60 px horizontal margins, and a 45 px bottom margin. Scale these values proportionally when the delivery resolution differs. Adjust only when required for legibility while preserving the same visual treatment.

### 10. Assemble and verify

Copy [timeline_manifest.template.json](assets/timeline_manifest.template.json), list only approved source ranges, and preflight before encoding:

```bash
python3 /ABS/PATH/TO/SKILL/scripts/assemble_picture.py \
  --manifest /ABS/PATH/timeline_manifest.json --preflight-only
```

Lock timing, then burn the required ASS subtitles. Labels, legends, chapter cards, and teaching overlays are not required; add the optional `--overlay` argument only when the user explicitly requested scene text:

```bash
python3 /ABS/PATH/TO/SKILL/scripts/compose_tutorial.py \
  --video /ABS/PATH/picture-master.mp4 \
  --narration /ABS/PATH/narration.wav \
  --captions /ABS/PATH/captions.ass \
  --output /ABS/PATH/final.mp4 \
  --resolution 1920x1080 \
  --audio-language eng \
  --codec h264 --preset slow --crf 14 --fps 30
```

If the user explicitly opted out of subtitles/captions, replace `--captions ...` with `--no-captions`. This explicit flag prevents a vague “no text” request from accidentally producing an uncaptioned video.

Run structural and full-decode QA:

```bash
python3 /ABS/PATH/TO/SKILL/scripts/verify_output.py /ABS/PATH/final.mp4 \
  --expected-codec h264 --expected-fps 30 \
  --expected-resolution 1920x1080 \
  --expected-duration EXPECTED_SECONDS \
  --report /ABS/PATH/final.qa.json
```

Extract entry, intermediate, and exit frames from every process shot and inspect them as a temporal sequence; a single representative contact sheet is insufficient for motion QA. Verify that the subject or process state changes independently of camera motion, that the stated cause precedes its effect, and that the end state prepares the next shot. Reject any process shot that is only a still, repeated frame, pan, zoom, orbit, crossfade, or lighting change.

Create `qa/motion_qa.json` from [motion_qa.template.json](assets/motion_qa.template.json). Complete one entry for every narrated process shot with the teaching action, animation driver, start-state time/frame, intermediate-state time/frame, end-state time/frame, observed subject change, and explicit static-substitute checks. Every process shot must pass `subject_change_visible_without_camera_motion` and `cause_precedes_effect`, with `static_substitute_detected` set to false. Verify every visible factual detail against the claim ledger. Check subtitle readability, timing, safe margins, line wrapping, collisions, and consistency. Structural QA does not replace evidence, temporal, or visual review.

## Delivery requirements

Deliver the final MP4 with burned-in English subtitles, a safe `.blend` file, the ASS subtitle file, source and claim notes, the GitHub resource review with licenses and attributions, and QA JSON. The subtitle file may be omitted only after an explicit subtitle/caption opt-out. Report the real resolution, frame rate, duration, codec, loudness, synchronization, Kokoro-82M model revision and voice, third-party resources, and every conceptual or symbolic visualization.

Do not call the film complete while any narrated process is represented only by camera movement over a static image, repeated frames, a slideshow, a crossfade montage, or another substitute for real process animation. Also reject any unsupported claim, invented detail, misleading scale, unreadable or clipped subtitle, unexplained abstraction, black frame, color-tag error, audio drift, or decode failure.

## Bundled resources

- `scripts/init_blender_education_project.py`: create a non-destructive project and copy templates.
- `scripts/assemble_picture.py`: create a frame-exact BT.709 picture master.
- `scripts/compose_tutorial.py`: combine picture, narration, burned-in subtitles, and optional user-requested overlays.
- `scripts/verify_output.py`: verify resolution geometry, codec, tags, timing, audio, frames, and full decode.
- `assets/timeline_manifest.template.json`: starting point for edit decisions.
- `assets/narration_plan.template.json`: starting point for English narration and claim status.
- `assets/github_resource_review.template.json`: record GitHub candidates, compatibility, provenance, license, and safety decisions.
- `assets/motion_qa.template.json`: required per-shot evidence that the subject or process genuinely changes across frames.
- `assets/subtitle.template.ass`: required burned-in subtitle treatment.
- `assets/teaching_overlay.template.ass`: optional starting point when the user explicitly requests English chapter cards or teaching labels.
