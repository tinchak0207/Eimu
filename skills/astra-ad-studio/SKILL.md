---
name: astra-ad-studio
description: "Create finished advertising campaigns directly in the current workspace: develop distinct creative directions, generate or compose polished static ads and motion previews, produce platform variants, and save the campaign assets plus a native Markdown report. Use when the user wants actual ads for a product, app, startup, launch, feature, or offer rather than only ad copy or a strategy document."
---
<!--
来源（轮子）: https://github.com/Kappaemme-git/astra-ad-studio
License: MIT · 原作者: Kappaemme-git · 仅内部使用
入库批次: 2026-09-06 对称差扩容 W5（Astra 广告创意系统）。
Blender 5.2 雷区（仅 Blender 类配方适用）：① BLENDER_EEVEE_NEXT 已死，只认 BLENDER_EEVEE/BLENDER_WORKBENCH/CYCLES ② Filmic 已移除，AgX 为默认 ③ action.fcurves 在 4.4+ 移除，走 layers[*].strips[*].channelbags[*].fcurves
正文保留英文原文；MCP 调用表述执行时改走我方 bridge /v1/execute 同构协议。
-->


# Astra Ad Studio

**Asset reuse first:** 接到任务先 `asset_search` 查 video-gen-prompts/seedance-prompts/nano-banana-prompts 包（免费），命中先复用原文再创作，查空才自编 prompt。

Turn a product, URL, repository, screenshot, or short brief into finished advertising assets inside the current workspace. Let the current model act as the creative and production lead, then use the image generation and local file tools available in this domain to build reviewable outputs.

## Core outcome

Deliver ads the user can open, inspect, and publish—not a long answer describing what an ad could look like. Every complete run should leave:

- three meaningfully different creative directions;
- at least one finished ad asset for each selected direction;
- platform-ready variants requested by the user;
- a compact Markdown campaign report with clickable asset paths;
- source files that keep copy editable.

## Intake

Use existing context before asking questions. Ask at most three short questions only for information that materially changes the creative:

1. What is being promoted, and what action should the viewer take?
2. Who is the ad for?
3. Which platform or format matters most?

Infer missing brand colors, tone, and dimensions when safe. Clearly label invented positioning or sample claims as creative assumptions. Never invent customers, testimonials, prices, results, awards, or product capabilities.

## Load references only when needed

- Read [references/creative-system.md](references/creative-system.md) before developing or scoring creative directions.
- Read [references/production.md](references/production.md) before generating or composing final assets.
- Read [references/campaign-schema.md](references/campaign-schema.md) only when using the included campaign renderer.

## Workflow

### 1. Establish the campaign brief

Identify the product, audience, desired action, offer, proof available, brand constraints, platform, and deliverables. Inspect a supplied URL or repository when it contains the evidence needed to make the ads accurate.

Keep verified facts separate from creative language. Treat every quantitative claim as unverified until supported by supplied or inspected evidence.

### 2. Develop three creative directions

Create three territories that differ in idea, emotional mechanism, composition, and hook—not three color variants. For each direction provide:

- a short name;
- one-sentence concept;
- primary hook;
- visual idea;
- body copy or voiceover premise;
- CTA;
- why it should work for the audience.

Score them using the rubric in `references/creative-system.md`. Recommend a winner, but build all three when the user requests exploration or a demo pack.

### 3. Produce the visual layer

Choose the simplest medium that delivers the concept:

- Use native image generation for photography, illustration, product scenes, stylized worlds, or other raster visuals. Make one call per distinct visual direction.
- Use SVG, HTML, CSS, or canvas for typography-led ads, UI-led product ads, charts, diagrams, and motion graphics.
- When a raster visual will carry ad copy, generate the scene without baked-in text and add exact copy during composition. This prevents spelling errors and preserves editability.
- If the user supplies a product image, screenshot, logo, or brand asset, preserve it accurately. Never redraw a real interface or logo when the supplied asset can be composed directly.

Move every project-bound generated asset into the campaign output folder. Do not leave a required asset only in a tool cache or temporary location.

### 4. Compose finished ads

For deterministic text, layout, variants, and an animated preview, create a campaign JSON file and run:

```bash
node <skill-directory>/scripts/render_campaign.mjs <campaign.json> <output-directory>
```

The renderer creates editable SVG ads, a gallery preview, a motion preview, and a Markdown campaign report. Use it as a production helper, not as a substitute for creative judgment. Modify the generated source or build a custom layout when the concept requires it.

For bitmap delivery, render the final SVG or HTML through an available browser/screenshot workflow after visual inspection. For a requested MP4, first build and inspect the motion preview, then render it with an available browser/video workflow. If no local renderer is available, deliver the working motion HTML and state that MP4 export remains pending.

### 5. Review and revise

Open or render every final asset. Check:

- the hook is understandable within roughly two seconds;
- the product and desired action are obvious;
- all copy is exact, readable, and inside safe areas;
- visual hierarchy survives mobile size;
- the directions are genuinely distinct;
- claims are supported;
- branding is consistent without making every variant identical;
- motion timing leaves enough time to read each scene.

Make one focused revision pass for concrete issues. Do not endlessly regenerate merely to explore taste.

### 6. Deliver in the workspace

Default campaign folder:

```text
outputs/<campaign-slug>/
```

The final chat response should be short: identify the recommended direction, list the finished assets, and link to `ASTRA-AD-STUDIO-REPORT.md` with an absolute path so it opens directly in the workspace.

## Rules

- Default to English ad copy and reporting unless the user requests another language.
- Create actual assets; do not stop after concepts, prompts, or copy.
- Preserve exact product facts and supplied brand assets.
- Avoid fake social proof, unverifiable urgency, deceptive before/after claims, and imitation of a living artist's style.
- Use no third-party creative service unless the user explicitly requests one.
- Do not claim that the skill itself changes the active model or unlocks video generation.
- Keep generated source files editable and final outputs non-destructive.

## Example invocations

```text
Use $astra-ad-studio to create three launch ads for this product: https://example.com
```

```text
Use $astra-ad-studio to turn this app screenshot into a 15-second vertical motion ad.
```

```text
Use $astra-ad-studio to create an X ad, an Instagram story, and a LinkedIn ad for this repository.
```
