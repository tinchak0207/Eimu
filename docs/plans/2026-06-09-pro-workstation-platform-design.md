# Professional Image Workstation Platform Design

## Goal

Build desktop-only professional mode as a production workflow layer for `image.tinchak0207.xyz`, not as a separate clone of ComfyUI/A1111. Normal mode remains the fast mobile-friendly path. Professional mode must improve paid image production by integrating reference images, context, prompt reuse, batch/queue controls, history recall, quota awareness, and fallback-safe generation.

## Current Platform Constraints

- The site already has login, quota/CDK, pricing, docs, local/server history, primary/fallback upstreams, and Vercel runtime limits.
- The current image backend is OpenAI-compatible `/images/generations` and `/images/edits`; it is not a local Stable Diffusion node engine.
- Professional mode must send requests through the existing authenticated `/api/generate-images` route so billing, refunds, history, progress timing, and fallback behavior stay consistent.
- Mobile should keep normal mode. Desktop can load professional mode dynamically to preserve first-load speed.
- Reference image previews must not revoke `blob:` URLs when the upload widget remounts; cleanup belongs to explicit removal or a deliberate clear action.

## Open-Source Workstation Matrix

| Source | License | Product Capability To Adapt | Integration Rule |
| --- | --- | --- | --- |
| `invoke-ai/InvokeAI` | Apache-2.0 | Unified Canvas, Control Layers, boards/gallery, prompt/settings recall, workflow management | Safe primary design reference. Adapt concepts and compatible patterns. |
| `Stability-AI/StableStudio` | MIT | Web studio shell, plugin-like backend abstraction, generate/edit flow | Safe secondary reference for provider abstraction and panel layout. |
| `Comfy-Org/ComfyUI_frontend` | GPL-3.0 | Node library, queue/history sidebar, keybindings, graph UX | Product-reference only unless license obligations are accepted. |
| `comfyanonymous/ComfyUI` | GPL-3.0 | Node graph, async queue, workflow JSON, partial re-execution, PNG workflow recall | Product-reference only; do not copy code into this proprietary/commercial site. |
| `lllyasviel/Fooocus` | GPL-3.0 | Low-friction prompt-first UX, Image Prompt, style presets, variation/upscale/inpaint mental model | Product-reference only. Recreate behavior through our prompt/workflow config. |
| `AUTOMATIC1111/stable-diffusion-webui` | AGPL-3.0 | txt2img/img2img/inpaint tabs, scripts, batch processing, PNG Info parameter restore, styles | Product-reference only. Avoid code copying because network-service obligations are high. |

## Recommended Product Shape

Professional mode should be a docked desktop workstation with six areas:

1. Prompt Lab: main prompt, negative prompt, style preset, prompt library, prompt fragments, and recent prompt recall.
2. Project Context: persistent context block for brand, character, product, scene, and constraints.
3. Reference Board: multi-image upload with per-image role metadata: style, character, composition, product, face, and general reference.
4. Workflow Plan: a readable node-like plan that maps current capabilities to actual API inputs. It can show graph concepts, but should not claim unsupported ComfyUI execution.
5. Queue: copies, concurrency, retry/fallback status, progress estimate, quota estimate, and cancellation state where available.
6. Board/Gallery: current outputs, reference metadata, prompt/config recall, and links into `/history`.

## Platform Integration

- Generation remains `startGeneration(prompt, ["image_tinchak"], modelMap, options)`.
- `options` should grow from the current `{ referenceImages, contextPrompt, copies, concurrency }` toward `{ negativePrompt, referenceImageRoles, workflowPreset, aspectRatio, seedHint }`.
- The API route should only forward fields that the upstream supports. Unsupported professional metadata should be stored in history/cache for recall, not sent blindly.
- Billing should reserve quota per requested output slot, or the UI must constrain professional batch size to the current one-credit-per-run behavior until server-side batch billing is implemented.
- History entries should persist prompt, context, reference image names/roles, workflow preset, model, endpoint label, and timing.
- Progress should keep the existing 50s normal / 80s fallback timing model, interrupt immediately on errors, and expose queue-level status in professional mode.

## Phased Implementation

### Phase 0: Stabilize Current WIP

- Keep multi-reference upload dynamic and mobile-compatible.
- Fix preview lifecycle so uploaded previews survive normal/pro toggle and dynamic remounts.
- Keep professional mode dynamic-imported and hidden on mobile.
- Verify typecheck, focused tests, build, and browser preview.

### Phase 1: Honest Professional MVP

- Rename the current `InvokeInspiredWorkstation` to a neutral professional workstation component.
- Add source matrix data in code and surface it subtly as internal metadata, not marketing copy.
- Add negative prompt, reference image role selection, context prompt, copies, concurrency, prompt library, and current-result board.
- Make the workflow panel show a truthful plan: `Prompt -> Context Merge -> Reference Images -> Image Edits/Generation -> Fallback -> History`.
- Keep API forwarding limited to supported fields, while preserving extra metadata locally.

### Phase 2: Production Workflow Layer

- Add saved local presets: product shot, character consistency, poster/banner, ecommerce background swap, social post variants.
- Add history recall: load prompt/context/reference metadata from recent generations.
- Add quota estimate before run and per-slot queue status.
- Add retry only failed slots and fallback endpoint labeling in the board.
- Add lightweight keyboard shortcuts inspired by ComfyUI/A1111 without copying their code.

### Phase 3: Real Advanced Backend Optional

- Only after the product proves value, add a separate worker/service for ComfyUI-compatible workflows or other image engines.
- Treat that as a backend project with queue storage, signed uploads, job polling, quota reservation per slot, and failure refunds.
- Do not put local SD workflow complexity inside the Vercel route.

## Performance Requirements

- Do not increase normal homepage first-load JS materially; professional mode and upload/compression stay dynamic.
- Use client-side image compression before upload.
- Avoid base64 localStorage cache bloat; keep large images as server history URLs or bounded cache records.
- Login/auth checks should avoid blocking initial render where possible and refresh quota after generation only once.
- Generation API must prefer fast primary timeout and fallback long timeout without exceeding Vercel max duration.

## Verification Gates

- `node --test src/components/ReferenceImageUpload.test.ts`
- `node --test src/components/ProfessionalWorkstation.test.ts`
- `node --test src/hooks/use-image-generation.test.ts`
- `node --test src/app/api/generate-images/route.test.ts`
- `npx tsc --noEmit`
- `npm run build`
- Browser check on desktop: normal/pro toggle, reference images survive toggling, professional batch queue renders.
- Browser check on mobile: no professional toggle, reference upload works, no horizontal overflow.

## Non-Goals For The First Implementation

- No copied GPL/AGPL frontend code.
- No fake node execution engine.
- No full canvas painting/inpainting UI until the backend can use it.
- No local model management UI.
- No new paid-tier gating unless product strategy requires it later.
