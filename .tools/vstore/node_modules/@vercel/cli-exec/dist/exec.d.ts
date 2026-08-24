import type { ExecVercelCliOptions, ExecVercelCliResult } from './types';
/**
 * Resolves and executes the Vercel CLI with the provided arguments.
 *
 * The execution environment is adjusted so local `node_modules/.bin`
 * directories and the current Node executable remain available even when a
 * caller passes a sanitized `PATH`.
 */
export declare function execVercelCli(args: string[], options?: ExecVercelCliOptions): Promise<ExecVercelCliResult>;
