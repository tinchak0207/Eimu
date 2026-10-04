<!--
来源（轮子）: https://github.com/sunxiayi/make-blender-education-video-skill
License: MIT · 原作者: sunxiayi · 仅内部使用
入库批次: 2026-09-06 对称差扩容 W5（教育视频全链）。
Blender 5.2 雷区（仅 Blender 类配方适用）：① BLENDER_EEVEE_NEXT 已死，只认 BLENDER_EEVEE/BLENDER_WORKBENCH/CYCLES ② Filmic 已移除，AgX 为默认 ③ action.fcurves 在 4.4+ 移除，走 layers[*].strips[*].channelbags[*].fcurves
正文保留英文原文；MCP 调用表述执行时改走我方 bridge /v1/execute 同构协议。
-->

# Evidence and Explanation

## Define the truth level

Record every factual detail in a claim ledger, including narration, any optional labels, geometry, materials, proportions, sequence, motion, numbers, and causal relationships:

| Status | Meaning | Treatment |
|---|---|---|
| `verified` | Supported by authoritative evidence | State directly and retain the source |
| `inferred` | Reasonable conclusion from evidence | Qualify the language |
| `conceptual` | Teaching abstraction | Disclose in narration/subtitles and distinguish visually as conceptual, schematic, compressed, or not to scale |

Prefer primary sources: official documentation, standards, codes, papers, museum or institutional records, manufacturer diagrams, engineering drawings, or direct observation. Use secondary sources to locate evidence or establish context.

Fact-check the outline, storyboard, narration, any optional on-screen text, and final imagery against the ledger. Never add a plausible detail simply because it looks or sounds right. Remove any detail that cannot be verified, or disclose it clearly as inferred or conceptual through narration/subtitles and visual treatment. User-provided references are required inputs when supplied, but they do not override contradictory primary evidence.

## Separate four kinds of accuracy

- **Factual accuracy:** names, numbers, sequence, material, function, and causal claims.
- **Geometric accuracy:** shape, scale, position, construction, and spatial relationships.
- **Temporal accuracy:** real-time motion versus slowed, accelerated, reordered, or compressed events.
- **Visual encoding accuracy:** what colors, arrows, transparency, particles, or highlights mean.

Declare limitations in the visual language rather than hiding them in a final disclaimer.

## Build explanations around causality

For each object, stage, or mechanism, answer:

1. What is it?
2. What changes, moves, enters, or leaves?
3. What causes that change?
4. Why does it matter to the whole system?

Prefer “because” and “therefore” over lists of parts. Show the cause before the result whenever possible.

## Handle domain-specific risk

- For construction and architecture, specify location, structural system, code context, and whether the sequence is typical or required.
- For medicine and biology, distinguish normal variation, simplified anatomy, cellular scale, and clinical advice.
- For machines and manufacturing, specify variant, operating state, omitted guards, and whether motion is slowed or sectioned.
- For physics and energy, define what field lines, particles, colors, and vector arrows represent.
- For historical reconstruction, distinguish surviving evidence, scholarly interpretation, and artistic completion.

Do not turn a visualization into actionable professional guidance unless the user explicitly requests that scope and appropriate authoritative sources support it.

## Write narration that matches the image

Narrate only what the viewer can see or what the visual clearly prepares them to infer. Remove claims whose corresponding object, step, or causal link is absent.

Keep separate English `display` and `tts` strings. Use consistent terminology. Preserve official names, formulas, and symbols. Expand ambiguous acronyms and units in TTS text.

## Final evidence review

Verify that:

- every factual detail and every numerical or safety-relevant claim has a source;
- every optional concept label matches its visual target;
- symbolic colors and flows are clearly introduced through narration/subtitles or visual context; a legend is optional and used only when explicitly requested;
- compressed time and nonliteral motion are disclosed;
- no decorative detail is presented as evidence;
- the final summary preserves the original qualifications.
