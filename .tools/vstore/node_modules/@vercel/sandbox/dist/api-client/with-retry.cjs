const require_rolldown_runtime = require('../_virtual/rolldown_runtime.cjs');
const require_api_error = require('./api-error.cjs');
let async_retry = require("async-retry");
async_retry = require_rolldown_runtime.__toESM(async_retry);

//#region src/api-client/with-retry.ts
/**
* Wraps a fetch function with retry logic. The retry logic will retry
* on network errors, 429 responses and 5xx responses. The retry logic
* will not retry on 4xx responses.
*
* @param rawFetch The fetch function to wrap.
* @returns The wrapped fetch function.
*/
function withRetry(rawFetch) {
	return async (url, opts = {}) => {
		/**
		* Timeouts by default will be [400, 800]
		* before randomization is added.
		*/
		const retryOpts = Object.assign({
			minTimeout: 400,
			retries: 2,
			factor: 2
		}, opts.retry);
		if (opts.onRetry) retryOpts.onRetry = (error, attempts) => {
			opts.onRetry(error, opts);
			if (opts.retry && opts.retry.onRetry) opts.retry.onRetry(error, attempts);
		};
		try {
			return await (0, async_retry.default)(async (bail, attempt) => {
				try {
					if (opts.signal?.aborted) return bail(opts.signal.reason || /* @__PURE__ */ new Error("Request aborted"));
					const response = await rawFetch(url, opts);
					if (response.status === 429) {
						const retryAfter = Number(response.headers.get("Retry-After"));
						if (retryAfter > 20) return bail(new require_api_error.APIError(response));
						const hasRetriesRemaining = retryOpts.forever || attempt <= retryOpts.retries;
						if (retryAfter > 0 && hasRetriesRemaining) await waitForRetry(retryAfter * 1e3, opts.signal);
						throw new require_api_error.APIError(response);
					}
					/**
					* If the response is a a retryable error, we throw in
					* order to retry.
					*/
					if (response.status >= 500 && response.status < 600) throw new require_api_error.APIError(response);
					return response;
				} catch (error) {
					/**
					* If the request was aborted using the AbortController
					* we bail from retrying throwing the original error.
					*/
					if (isAbortError(error)) return bail(error);
					/**
					* If the signal was aborted meanwhile we were
					* waiting, we bail from retrying.
					*/
					if (opts.signal?.aborted) return bail(opts.signal.reason || /* @__PURE__ */ new Error("Request aborted"));
					throw error;
				}
			}, retryOpts);
		} catch (error) {
			/**
			* The ResponseError is only intended for retries so in case we
			* ran out of attempts we will respond with the last response
			* we obtained.
			*/
			if (error instanceof require_api_error.APIError) return error.response;
			throw error;
		}
	};
}
async function waitForRetry(delay, signal) {
	if (signal?.aborted) throw signal.reason || /* @__PURE__ */ new Error("Request aborted");
	await new Promise((resolve, reject) => {
		const onAbort = () => {
			clearTimeout(timeout);
			reject(signal?.reason || /* @__PURE__ */ new Error("Request aborted"));
		};
		const timeout = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve(null);
		}, delay);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
function isAbortError(error) {
	return error !== void 0 && error !== null && error.name === "AbortError";
}

//#endregion
exports.withRetry = withRetry;
//# sourceMappingURL=with-retry.cjs.map