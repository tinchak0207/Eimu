/**
 * Replace comments and string / template literals with single spaces, leaving
 * only the code structure behind.
 *
 * Comments and literals are matched by one alternation. Because a literal is
 * matched as a single token, the engine consumes it whole before it can look
 * inside — so a comment-like sequence that appears inside a string (for
 * example an `Accept` header value containing a wildcard media range, or a URL
 * with `//`) is never treated as the start of a comment. Literals are blanked
 * rather than preserved so their contents cannot be misread as code either.
 *
 * This is intentionally not aware of regex literals: an unescaped `/` cannot
 * appear inside a regex body, so a comment-opening slash-star sequence cannot
 * occur there, and callers only test the result for plain code-level tokens.
 */
export declare function stripCommentsAndLiterals(content: string): string;
