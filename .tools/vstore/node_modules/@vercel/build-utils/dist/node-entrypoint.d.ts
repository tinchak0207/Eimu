import type FileFsRef from './file-fs-ref';
/**
 * Check if a Node.js/TypeScript file is a valid API entrypoint by detecting
 * the handler export shapes supported by `@vercel/node`:
 * - Default export (`(req, res)` handler, Web handler, or object of handlers)
 * - Named HTTP method exports (`GET`, `POST`, …) or a `fetch` export
 * - `module.exports = <fn>`
 * - A server that calls `.listen()`
 *
 * Returns `true` on error as a safe default — if we can't read or confidently
 * analyze the file, let the existing build pipeline handle it rather than risk
 * dropping a real Vercel Function.
 */
export declare function isNodeEntrypoint(file: FileFsRef | {
    fsPath?: string;
}): Promise<boolean>;
