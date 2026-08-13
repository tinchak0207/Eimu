<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## Time discipline (user-mandated 2026-08-02, applies to EVERY new session)

Golden time only: decide what to change → edit code → deploy → write memory pointer.

Garbage time. Minimize ruthlessly. NEVER perform:
- **No self UI checks.** The user owns aesthetics. Dev server / Playwright / screenshots to verify layout, ratios, or appearance = garbage. Finish the edit, deploy, and let the user look.
- **No self-invented helper scripts/tools** (deploy.ps1, check scripts, etc.) unless the user explicitly names them.
- **Cooking order:** do non-waiting work first (rules, memory, local edits), waiting work LAST (deploy, long verifications, external calls). Deploy is always the final step.
- **Stop guessing:** after 3 reads/probes without producing a code change, ask the user one question. Never guess-screen sizes, states, or intentions from files.
- **Grep-first for research:** locate evidence with targeted grep/Select-String, do NOT full-read large files (>200 lines) unless the task requires holistic understanding. Full-read pollutes context and is slower than 3 greps.
- **No self-narration:** never output lines like "I will now read...", "analysis complete". Output decisions, evidence, and results only.
- **Never re-run a completed closed loop** ("run it again to see").
- **Memory discipline:** every finished usable tool, solved recurring problem, or user-corrected behavior MUST be written to memory the same session (`C:\Users\lenovo\.codex\memories\extensions\ad_hoc\notes\` note + `memory_summary.md` update). Not writing it = intelligence reset next session.
- **Harness iteration loop (2026-08-02):** when the user reports a harness effect (time still being wasted, a rule not taking effect), fix the corresponding rule/flow IMMEDIATELY, before any other work, same session. Every user report is one compression.
- Respond in Traditional Chinese; run commands with Windows PowerShell syntax.

## First-principles mainline

- Define the final user outcome, primitive system, dominant bottleneck, highest-leverage action, and proof before using project workflows.
- Skills and checklists are subordinate tools; skip any ritual that does not change a mainline decision.

## Coding execution rule

- **Delegate coding to subagents.** Any code change task with 2+ files, or a single file > 50 lines of diff, MUST be dispatched to a subagent. The orchestrating agent only: identifies the target files, writes the diff spec, dispatches, then collects and verifies.
- The orchestrator never writes code directly when a subagent can do it in parallel or independently.
- If only one small targeted edit is needed (< 5 lines, single file), the orchestrator may apply it inline to avoid the spawn overhead.

## Verification rule

- Never intentionally run a test that is expected to fail.
- Implement the change first, then run only verification that is expected to pass.
- If a verification fails unexpectedly, diagnose it, fix the cause, and rerun it; do not create a deliberate red-test phase.
- When the user explicitly takes over visual verification after a production push, stop after the Vercel deployment is READY and the production alias is confirmed. Report visual verification as pending user acceptance; do not continue browser automation or claim that the visual result was verified.
- When Adobe2API is the target, trace its direct request and upstream response before changing authentication or routing; do not modify or restart relay services.
- Do not infer a scope or token failure from HTTP 408. Reserve that diagnosis for direct 401/403, `invalid_ims_scope`, `x-access-error`, or claim evidence.

## Authentication rule

- Never use a headless browser or automation-marked Chromium for Adobe, Google, or similar interactive identity authentication.
- If an identity provider reports that the browser or app may not be secure, stop that browser path immediately and use a standard user-controlled Chrome session.
- Resume automation only after user-controlled authentication completes. Never expose passwords, OTPs, cookies, or access tokens in logs or task output; store tokens only in the application's intended token store.
- Do not replay stale IMS authorization URLs containing dynamic state or device context.
- Production must not depend on an open Chrome tab. Chrome is bootstrap/recovery only; normal Adobe2API renewal must come from an enabled server-side refresh profile and active `auto_refresh` token.
- Never schedule Chrome memory/process scanning as the production renewal path. Keep browser token extraction manual and preserve the last working renewable server token until its replacement is accepted.

## Product decision doctrine

- Start from friction observed in the real creation workflow, not from a generic feature inventory. Name the affected user, task stage, blocked outcome, and observable evidence before proposing work.
- Treat the professional workspace as a task-state machine. Allocate attention and screen space according to whether the user is preparing, generating, reviewing, or reusing an asset; do not keep every panel equally prominent at all times.
- Readability, comprehension, and reliable operation outrank fitting everything into one viewport. Preserve visual quality, but never use beauty or zero-scroll as a reason to shrink text, targets, previews, or feedback below comfortable use.
- Remove duplicate mental models before adding another surface. If two modules transform substantially the same fields, merge them behind one authoritative entry and preserve undo rather than teaching two names for one action.
- UI claims must match real capability. Do not label plain prompt concatenation as regional editing, expose decorative percentages as real control, or imply an upstream/model path is available without generation evidence.
- Prefer closed loops over isolated features: an action should lead to a visible result, a recoverable state, and the next reuse action without making the user hunt across queue, canvas, gallery, and history.
- Convert repeated manual intervention into an interface or state transition only after the decision is stable. Automate deterministic work; keep ambiguous visual judgment with the user when they explicitly own final acceptance.
- Search for and extend the existing owner of state, persistence, billing, model capability, or UI responsibility. Do not create a second queue, history store, capability catalog, or task system without an explicit migration plan.
- Rank product work by expected movement of the user outcome per unit of time, implementation risk, operational risk, and future reuse. Feature count and architectural novelty are not value.
- State important beliefs as `FACT`, `INFERENCE`, or `HYPOTHESIS`. Each accepted issue must name the dominant bottleneck, smallest useful intervention, acceptance evidence, and what remains out of scope.
- Verification depth is a product decision. Use expected-pass contract tests, type checks, and production builds by default; add browser automation only when its result can change a decision. If the user takes over visual acceptance, report it as pending and stop after the agreed deploy boundary.
- When implementation is requested and expected-pass gates succeed, Image Studio changes default to production deployment unless the user explicitly limits the task to research, planning, documentation, or local-only work.
