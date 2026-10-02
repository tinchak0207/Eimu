<!--
來源（輪子）: https://github.com/sunxiayi/make-blender-education-video-skill
License: MIT · 原作者: sunxiayi · 僅內部使用
入庫批次: 2026-09-06 對稱差擴容 W5（教育視頻全鏈）。
Blender 5.2 雷區（僅 Blender 類配方適用）：① BLENDER_EEVEE_NEXT 已死，只認 BLENDER_EEVEE/BLENDER_WORKBENCH/CYCLES ② Filmic 已移除，AgX 為默認 ③ action.fcurves 在 4.4+ 移除，走 layers[*].strips[*].channelbags[*].fcurves
正文保留英文原文；MCP 調用表述執行時改走我方 bridge /v1/execute 同構協議。
-->

# GitHub workflow discovery

## Search before building

Search GitHub for reusable Blender work related to the exact topic before designing geometry from scratch. Use several narrow queries rather than one broad search. Combine the subject with terms such as:

- `Blender`, `.blend`, `Geometry Nodes`, `Blender Python`, or `add-on`;
- `animation`, `simulation`, `rig`, `procedural`, `exploded view`, or `visualization`;
- the relevant domain term, standard, species, machine variant, structure, or process.

Look for four kinds of resources:

1. production workflows or procedural techniques;
2. Blender add-ons and scripts;
3. application templates and reusable scene systems;
4. licensed models, data, textures, rigs, or reference assets.

Do not select a repository by stars alone. Inspect its README, license, recent commits or releases, issues, supported Blender versions, dependencies, example output, file structure, and upstream attributions.

## Evaluate every serious candidate

Record each candidate in `brief/github_resource_review.json` with:

- repository name, URL, and exact commit or release;
- intended use in this project;
- resource type and relevant files;
- supported Blender version and required add-ons;
- license, attribution text, share-alike or noncommercial restrictions;
- provenance and license of bundled or derived assets;
- maintenance signals and known limitations;
- dependencies, install steps, and security findings;
- import or compatibility test results;
- decision: `use`, `adapt`, `reference_only`, or `reject`;
- reason for the decision.

Reject reuse when the repository has no clear license, conflicts with the intended distribution, obscures asset provenance, requires unsafe execution, or cannot be tested in a scene copy. A repository-level license may not cover every bundled asset; trace each model, texture, dataset, and audio file to its own source.

## Inspect safely

- Download or clone into a dedicated review directory, not the production scene directory.
- Pin the exact commit or release used.
- Inspect Python, shell scripts, installers, and dependencies before execution.
- Do not enable an add-on, run a startup file, or open active content blindly.
- Import into a disposable Blender scene first. Check units, origin, transforms, topology, normals, naming, materials, rigs, external links, drivers, scripts, and performance.
- Preserve the original files and document every transformation applied during adaptation.

## Separate reuse from truth

GitHub can provide geometry, workflows, and implementation ideas. It is not automatically an authoritative source for factual claims. Verify anatomy, engineering, construction, medicine, and other domain details through authoritative evidence and record them in the claim ledger.

For anatomy, [Z-Anatomy/Models-of-human-anatomy](https://github.com/Z-Anatomy/Models-of-human-anatomy) is a useful candidate because it provides a Blender anatomy application template and models. Its README lists CC BY-SA licensing and several upstream sources with their own conditions. Review the provenance and license of each specific structure before importing or distributing it.

## Report the result

Before modeling, summarize the strongest candidates and state what each could save: research time, modeling time, rigging, simulation setup, labeling, or animation logic. Identify the recommended resource and its constraints. Ask for user confirmation before adopting anything with material attribution, share-alike, noncommercial, compatibility, or visual-direction consequences.
