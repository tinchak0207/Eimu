//#region src/api-client/api-error.d.ts
interface Options<ErrorData> {
  message?: string;
  json?: ErrorData;
  text?: string;
  sandboxName?: string;
  sessionId?: string;
}
declare class APIError<ErrorData> extends Error {
  response: Response;
  message: string;
  json?: ErrorData;
  text?: string;
  sandboxName?: string;
  sessionId?: string;
  constructor(response: Response, options?: Options<ErrorData>);
}
/**
 * Error thrown when a stream error is received streaming.
 * This typically occurs when the sandbox is stopped while streaming.
 */
declare class StreamError extends Error {
  code: string;
  sessionId: string;
  constructor(code: string, message: string, sessionId: string);
}
//#endregion
export { APIError, StreamError };
//# sourceMappingURL=api-error.d.ts.map