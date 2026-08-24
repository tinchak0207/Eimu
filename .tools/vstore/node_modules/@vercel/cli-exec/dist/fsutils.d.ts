import type { Stats } from 'node:fs';
/**
 * Result of reading filesystem metadata for a path that may not exist.
 */
type MaybeStatsResult = {
    stats: Stats;
} | {
    missing: true;
} | {
    reason: string;
};
/**
 * Resolves a path through symlinks, falling back to the original path on miss.
 */
export declare function getCanonicalPath(filePath: string): Promise<string>;
/**
 * Returns the inclusive directory chain from `parent` to `child`.
 */
export declare function getDirectoriesBetween(parent: string, child: string): string[];
/**
 * Reads stat metadata while distinguishing absent paths from inspection errors.
 */
export declare function statIfExists(filePath: string): Promise<MaybeStatsResult>;
/**
 * Returns whether a resolved executable should be invoked through Node.
 */
export declare function isNodeScript(filePath: string): boolean;
/**
 * Returns whether `child` is equal to or nested below `parent`.
 */
export declare function isSubpath(parent: string, child: string): boolean;
/**
 * Strips Windows executable extensions before matching package bin names.
 */
export declare function getCommandBase(command: string): string;
export {};
