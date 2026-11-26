/**
 * Single source of truth for new-api quota arithmetic.
 *
 * Deliberately dependency-free and side-effect-free so that it can be imported
 * from both server routes (src/app/api/**) and client components without
 * dragging in the browser-only storage helpers that live in new-api-client.ts
 * (localStorage / document.cookie / window.location).
 *
 * new-api-client.ts re-exports QUOTA_PER_COIN, so the pre-existing
 * `import { QUOTA_PER_COIN } from "@/lib/new-api-client"` call sites keep working.
 */

/** new-api quota unit → approximate coins (1 coin ≈ 500,000 quota units) */
export const QUOTA_PER_COIN = 500_000;
