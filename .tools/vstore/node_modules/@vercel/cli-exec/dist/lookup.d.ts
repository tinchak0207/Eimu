import type { LocalBinSearchDiagnostics, ResolutionDiagnostics } from './diagnostics';
import type { FindVercelCliOptions, VercelCliInvocation } from './types';
/**
 * Successful CLI lookup result with diagnostics preserved for callers upstream.
 */
interface ResolvedVercelCliInvocation extends VercelCliInvocation {
    found: true;
    diagnostics: ResolutionDiagnostics;
}
/**
 * Trusted local bin directories and the diagnostics collected while finding them.
 */
interface LocalBinSearch {
    directories: string[];
    diagnostics: LocalBinSearchDiagnostics;
}
/**
 * Resolves the Vercel CLI from the nearest `node_modules/.bin` directories
 * first, then falls back to the provided `PATH`.
 *
 * Returns `null` when no usable CLI executable can be found.
 */
export declare function findVercelCli(options?: FindVercelCliOptions): Promise<VercelCliInvocation | null>;
/**
 * Resolves and caches the full CLI resolution, including miss diagnostics.
 */
export declare function resolveCachedCliInvocation(cwd: string, pathValue: string): Promise<ResolvedVercelCliInvocation | {
    found: false;
    diagnostics: ResolutionDiagnostics;
}>;
/**
 * Removes internal resolution diagnostics from a successful CLI lookup result.
 */
export declare function toVercelCliInvocation(resolution: ResolvedVercelCliInvocation): VercelCliInvocation;
/**
 * Clears cached positive and negative CLI resolutions.
 *
 * Call this after installing or removing the CLI in a long-lived process that
 * needs to re-resolve the executable from disk.
 */
export declare function clearVercelCliLookupCache(): void;
/**
 * Clears one cached CLI resolution for retry after a stale executable failed.
 */
export declare function clearCachedCliInvocation(cwd: string, pathValue: string): void;
/**
 * Builds the trusted local `.bin` directories to prepend before scanning PATH.
 * Unsafe ancestor `node_modules` directories are rejected at this discovery
 * phase and kept as diagnostics for not-found errors.
 */
export declare function getLocalBinSearch(cwd: string): Promise<LocalBinSearch>;
export {};
