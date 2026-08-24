import type { ResolutionDiagnostics } from './diagnostics';
import type { VercelCliErrorCode, VercelCliInvocation } from './types';
/**
 * Error returned when CLI resolution or execution fails.
 *
 * `code` is always set. The remaining fields are populated when the failure
 * happened after a CLI invocation was resolved or started.
 */
export declare class VercelCliError extends Error {
    /**
     * Stable machine-readable error code.
     */
    code: VercelCliErrorCode;
    /**
     * Resolved CLI command and arguments, when available.
     */
    invocation?: VercelCliInvocation;
    /**
     * Captured standard output from the failed process, when available.
     */
    stdout?: string;
    /**
     * Captured standard error from the failed process, when available.
     */
    stderr?: string;
    /**
     * Process exit code for non-zero exits, when available.
     */
    exitCode?: number;
    constructor(options: {
        code: VercelCliErrorCode;
        message: string;
        invocation?: VercelCliInvocation;
        stdout?: string;
        stderr?: string;
        exitCode?: number;
        cause?: unknown;
    });
}
/**
 * Builds a not-found error message with diagnostics from local bin resolution.
 */
export declare function getCliNotFoundMessage(diagnostics: ResolutionDiagnostics): string;
/**
 * Verifies that the resolved working directory exists and is a directory.
 */
export declare function assertValidCwd(cwd: string): Promise<void>;
/**
 * Converts errors from `execa` into stable `VercelCliError` instances.
 */
export declare function toVercelCliError(invocation: VercelCliInvocation, error: unknown): VercelCliError;
