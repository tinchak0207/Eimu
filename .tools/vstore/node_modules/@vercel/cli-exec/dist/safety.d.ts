/**
 * Explains why a `node_modules` directory should be skipped, or `null` if safe.
 */
export declare function getSkippedNodeModulesReason(nodeModulesDirectory: string, parentDirectories?: string[]): Promise<string | null>;
/**
 * Validates package and file paths for a declared package bin target.
 */
export declare function getUnsafePackageBinReason(nodeModulesDirectory: string, packageDirectory: string, binPath: string): Promise<string | null>;
/**
 * Validates that each package directory segment is safe and under node_modules.
 */
export declare function getUnsafePackageDirectoryReason(nodeModulesDirectory: string, packageDirectory: string): Promise<string | null>;
/**
 * Validates that package file ancestors and the file itself are safe.
 */
export declare function getUnsafePackageFileReason(packageDirectory: string, filePath: string): Promise<string | null>;
/**
 * Reports unsafe ownership or write permissions for a directory path.
 */
export declare function getUnsafeDirectoryReason(directory: string): Promise<string | null>;
/**
 * Reports unsafe ownership or write permissions from filesystem metadata.
 */
export declare function getUnsafeStatsReason(stats: {
    mode: number;
    uid: number;
}): string | null;
