<!--
來源（輪子）: https://github.com/sunxiayi/make-blender-education-video-skill
License: MIT · 原作者: sunxiayi · 僅內部使用
入庫批次: 2026-09-06 對稱差擴容 W5（教育視頻全鏈）。
Blender 5.2 雷區（僅 Blender 類配方適用）：① BLENDER_EEVEE_NEXT 已死，只認 BLENDER_EEVEE/BLENDER_WORKBENCH/CYCLES ② Filmic 已移除，AgX 為默認 ③ action.fcurves 在 4.4+ 移除，走 layers[*].strips[*].channelbags[*].fcurves
正文保留英文原文；MCP 調用表述執行時改走我方 bridge /v1/execute 同構協議。
-->

# Visual Quality

## Build readable hierarchy

Establish primary forms, secondary mechanisms or layers, and tertiary details. Make primary forms legible at thumbnail size. Reveal tertiary detail only when the camera and narration require it.

Preserve plausible scale, thickness, edge radius, spacing, joint, and contact relationships. Use real geometry for silhouette, parallax, contact shadow, deformation, and close-up features. Use textures, decals, and shaders for sub-pixel information.

## Avoid the toy look

- Vary edge radii according to material and manufacturing or biological role.
- Vary thickness, height, spacing, and surface response instead of scaling all details uniformly.
- Add contact, fastening, layering, seams, or transition detail where parts meet.
- Break perfect uniformity through roughness and normal variation before color noise.
- Preserve detail in dark materials; avoid featureless black.
- Use joints, fasteners, grain, pores, strata, or other domain-appropriate scale cues. Labels are never required and should be omitted unless the user explicitly requests them.
- Avoid excessive saturation, bloom, glow, and miniature-like depth of field.

High detail does not require photorealism. A stylized film can remain precise when shape, hierarchy, motion, and visual encoding are consistent.

## Match materials to the subject

Create a restrained material family with clearly different response for metal, glass, wood, concrete, soil, polymer, fluid, tissue, stone, ceramic, paint, or composite materials as needed.

Use microtexture to shape highlights rather than display obvious procedural noise. Keep printed or engraved labels sharp at delivery resolution. Add dirt, wear, moisture, scratches, or biological irregularity only when they support the explanation.

## Run a physical-plausibility gate

Before rendering the approval frame, review every salient visible element:

1. Name what the element represents.
2. Identify its real-world counterpart or evidence source.
3. Confirm that its scale, material, thickness, attachment, and location are plausible.
4. Classify it as literal, inferred, or conceptual.
5. Remove it if an ordinary viewer could mistake an unsupported abstraction for a real object.

Reject the frame when:

- a visible hose, tube, strand, particle, arrow, or decorative mechanism has no real-world counterpart;
- microscopic structures appear at macroscopic scale without a separate, disclosed scale transition;
- an opaque real object has been changed into glass merely to expose its interior;
- transparent materials use visible screen-door or alpha-dither noise;
- metal has uniform color and roughness with no believable highlight response;
- repeated objects have perfectly identical color, edge shape, or surface response;
- an animated curve, instance, or mesh scales around the wrong origin and moves outside its intended vessel or mechanism;
- parts float, intersect, or lack believable joints, seals, fasteners, contact shadows, or supporting structure.

Prefer a section cut through the real material over a glass substitute. For invisible or microscopic processes, use a dedicated conceptual inset, scale-matched cut, or isolated teaching view instead of inserting literal-looking rods, wires, particles, or tubes into a real-scale scene.

## Light for explanation

Use broad controlled lights to reveal form and material. Keep the background separate from the subject. Preserve readable shadows and highlight rolloff. Add localized accents only to clarify an object or stage.

Do not copy light coordinates across unrelated subjects. Place lights by observing reflections, silhouette, volume, and the current learning objective.

## Use the camera as a teaching tool

Establish orientation before close-ups. Use focal length and camera distance to control perspective rather than relying on extreme depth of field. Keep the explanatory subject sharp.

Use deliberate moves: overview orbit, dolly, top-down reveal, section transition, track through a flow, or scale-matched cut. Avoid constant drifting and unexplained rotation.

Camera movement supports subject animation; it never replaces it. A moving crop of a still frame, including a Ken Burns pan/zoom or 2.5D parallax pass, does not demonstrate a process.

## Animate readable change

Use one dominant visual action per sentence. Every narrated dynamic shot must contain a meaningful subject-space change: material moves, a mechanism operates, geometry deforms, a flow propagates, components assemble, a biological state develops, or another relevant transformation occurs. Establish the start state, animate its driver, show an intermediate state, and land on a visibly different end state.

Use consistent easing and highlight colors. Reserve dramatic motion for meaningful transitions. If the user explicitly requested optional labels, keep them attached to their targets without covering them.

When motion is conceptual, make it visually distinct from literal mechanical or biological motion.

Do not count camera transforms, focus pulls, light changes, crossfades, or shader-only glints as the dominant process action. Brief still holds may establish context or create emphasis, but they cannot occupy the explanatory core of a process shot.

## Approve before scaling

Render exactly one 4K style frame containing the hardest material, finest readable detail, darkest region, brightest highlight, and intended depth of field. Labels, legends, chapter cards, and teaching overlays are never required; omit them unless the user explicitly requested them. Include one sample burned-in subtitle unless the user explicitly opted out of subtitles/captions. A request for “no text in the picture,” no labels, or no legend does not remove the subtitle. Inspect at 100% and thumbnail size.

Show that frame to the user and ask whether to modify the style, detail, composition, lighting, or subtitle treatment. Ask about scene-text treatment only when the user explicitly requested it. If revisions are requested, render one replacement frame. Do not render any motion sample, frame sequence, chapter, or full video until the user explicitly approves the current frame.

The approval frame confirms appearance only. It provides no evidence of animation quality and must never be repurposed into a static or Ken Burns-style final sequence.

Use Eevee for rapid style iteration or approved real-time results. Use Cycles when reflections, transmission, volume, close-up shadows, or global illumination materially improve the learning result and render budget permits.
