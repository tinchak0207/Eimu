/**
 * Converts any thrown value into a message suitable for diagnostics.
 */
export declare function getErrorMessage(error: unknown): string;
/**
 * Returns whether a filesystem error means the requested path is absent.
 */
export declare function isMissingPathError(error: unknown): boolean;
