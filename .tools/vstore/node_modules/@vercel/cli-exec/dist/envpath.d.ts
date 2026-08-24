/**
 * Prepends path entries while preserving existing entries and order.
 */
export declare function prependPathEntries(pathValue: string, directories: string[]): string;
/**
 * Splits a PATH value into non-empty directory entries.
 */
export declare function splitPath(pathValue: string): string[];
/**
 * Reads PATH from an environment object with Windows casing compatibility.
 */
export declare function getEnvPath(env?: NodeJS.ProcessEnv): string;
/**
 * Writes PATH to an environment object with normalized Windows casing.
 */
export declare function setEnvPath(env: NodeJS.ProcessEnv | undefined, pathValue: string): NodeJS.ProcessEnv;
