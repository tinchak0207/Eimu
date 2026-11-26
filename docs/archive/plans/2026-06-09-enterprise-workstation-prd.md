# Enterprise Image Workstation PRD And Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Turn the current professional mode into an enterprise-grade image workstation layer with workflow provenance, queue observability, parameter recall, and a clearer production UI.

**Architecture:** Keep the normal mobile-first path lightweight and dynamically load the workstation on desktop. Treat professional mode as a workflow orchestration layer over the existing authenticated `/api/generate-images` route, preserving quota, fallback, cache, and server history behavior.

**Tech Stack:** Next.js app router, React client components, existing OpenAI-compatible image API, local/server history, `react-dropzone`, `browser-image-compression`, `react-virtuoso`, `react-hotkeys-hook`, and scoped CSS in `src/app/globals.css`.

---

## Timer

- Start: 2026-06-09 14:40 Asia/Hong_Kong
- Target work block: 2 hours of iterative polishing across product, UI, frontend, backend, verification, and deploy.

## Open-Source Evidence

- InvokeAI: unified canvas, workflow management, gallery metadata recall, drag/drop image reuse. Safe primary source because Apache-2.0.
- StableStudio: plugin-like web studio shell and provider abstraction. Safe secondary source because MIT.
- ComfyUI / ComfyUI Frontend: queue/history sidebar, workflow JSON, app/simple mode, customizable layout, partial re-execution. Product-reference only due GPL.
- Fooocus: prompt-first flow, image prompt roles, prompt weights, negative prompt, low-friction advanced settings. Product-reference only due GPL.
- AUTOMATIC1111: PNG Info restore, Styles, live token validation, prompt editing, batch processing, parameter import/export. Product-reference only due AGPL.

## Issue-Derived Product Risks

- Hardware and dependency problems dominate local workstations. Our cloud product should surface zero-install reliability and fallback state instead of local engine controls.
- Queue requests appear repeatedly in prompt-first tools. Professional mode needs visible queued/running/succeeded/failed slots, not only a spinner.
- Advanced UIs become hard to operate. Use a compact "Studio / Queue / Provenance" model instead of a fake full node graph.
- Memory/performance issues are common in local tools. Keep professional mode dynamically imported and avoid adding heavy graph/canvas libraries until backend supports them.
- Users need parameter recall. History/cache should preserve workflow metadata and UI should offer copy/restore surfaces.

## Requirements

1. Workflow presets must become structured enterprise presets with labels, notes, prompt hints, negative hints, output use cases, and default reference roles.
2. The workflow metadata sent to the API and history must include `presetLabel`, `promptHint`, `negativeHint`, `estimatedCredits`, and a stable workflow schema version.
3. Professional queue UI must show slot counts, concurrency, estimate, endpoint/fallback state, and failed slot count from current results.
4. Gallery cards must expose provenance: model, endpoint, reference names/roles, workflow preset, and quick prompt/config recall.
5. Prompt Lab must support one-click preset application without replacing typed prompt blindly.
6. The backend route must keep upstream requests compatible while preserving enriched metadata in server history.
7. Normal mode must stay fast: professional workstation stays dynamically imported; homepage first-load JS should not materially exceed the current 168 kB baseline.
8. Tests must cover enriched workflow metadata, route history persistence, and workstation UI affordances.

## Task 1: Product Contract Tests

**Files:**
- Modify: `src/components/ProfessionalWorkstation.test.ts`
- Modify: `src/hooks/use-image-generation.test.ts`
- Modify: `src/app/api/generate-images/route.test.ts`
- Modify: `src/lib/generation-cache.test.ts`

**Steps:**

1. Add assertions for `WORKFLOW_SCHEMA_VERSION`, structured `WORKFLOW_PRESETS`, `promptHint`, `negativeHint`, `estimatedCredits`, `Queue Inspector`, and `Provenance`.
2. Add assertions that the hook persists `workflow` with schema version and preset label.
3. Add assertions that the route saves `workflow` into `saveGeneratedHistoryEntry`.
4. Run focused tests and confirm they fail before implementation.

## Task 2: Workflow Metadata Core

**Files:**
- Modify: `src/lib/image-types.ts`
- Modify: `src/lib/generation-workflow.ts`
- Modify: `src/lib/api-types.ts`
- Modify: `src/lib/generation-cache.ts`
- Modify: `src/lib/server-history-store.ts`

**Steps:**

1. Add schema version and enriched workflow fields.
2. Normalize presets and credit estimates in `createGenerationWorkflow`.
3. Keep `buildWorkflowPrompt` deterministic and upstream-compatible.
4. Preserve metadata through local cache and server history.

## Task 3: API And Queue Semantics

**Files:**
- Modify: `src/app/api/generate-images/route.ts`
- Modify: `src/hooks/use-image-generation.ts`

**Steps:**

1. Continue forwarding only supported image fields upstream.
2. Save final prompt plus enriched workflow metadata to history.
3. Return endpoint label for queue/provenance UI.
4. Keep refund path unchanged for all-endpoint failure.

## Task 4: Professional Workstation UI

**Files:**
- Modify: `src/components/pro-workstation/InvokeInspiredWorkstation.tsx`
- Modify: `src/components/ImagePlayground.tsx`
- Modify: `src/app/globals.css`

**Steps:**

1. Add preset application with prompt/negative hints.
2. Add Queue Inspector with slots, concurrency, running/done/failed, and fallback labels.
3. Add Provenance cards for model, endpoint, preset, references, and recall copy.
4. Improve visual hierarchy while keeping Liquid Glass style and compact enterprise density.

## Verification

- `node --test src/components/ProfessionalWorkstation.test.ts`
- `node --test src/hooks/use-image-generation.test.ts`
- `node --test src/app/api/generate-images/route.test.ts`
- `node --test src/lib/generation-cache.test.ts`
- `node --test`
- `npx tsc --noEmit`
- `npm run build`
- Browser desktop: upload references, apply preset, toggle professional mode, inspect queue/provenance, verify previews persist.
- Browser mobile: no professional toggle, normal reference upload still works, no horizontal overflow.
