
//#region src/api-client/api-error.ts
var APIError = class APIError extends Error {
	constructor(response, options) {
		super(response.statusText);
		if (Error.captureStackTrace) Error.captureStackTrace(this, APIError);
		this.response = response;
		this.message = options?.message ?? "";
		this.json = options?.json;
		this.text = options?.text;
		this.sandboxName = options?.sandboxName;
		this.sessionId = options?.sessionId;
	}
};
/**
* Error thrown when a stream error is received streaming.
* This typically occurs when the sandbox is stopped while streaming.
*/
var StreamError = class StreamError extends Error {
	constructor(code, message, sessionId) {
		super(message);
		this.name = "StreamError";
		this.code = code;
		this.sessionId = sessionId;
		if (Error.captureStackTrace) Error.captureStackTrace(this, StreamError);
	}
};

//#endregion
exports.APIError = APIError;
exports.StreamError = StreamError;
//# sourceMappingURL=api-error.cjs.map