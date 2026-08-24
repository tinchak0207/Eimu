import { NotOk } from "./error.js";

//#region src/auth/api.ts
async function fetchApi(opts) {
	const x = await fetch(`https://vercel.com/api${opts.endpoint}`, {
		method: opts.method,
		body: opts.body,
		headers: {
			Authorization: `Bearer ${opts.token}`,
			"Content-Type": "application/json"
		}
	});
	if (!x.ok) {
		let message = await x.text();
		try {
			const { error } = JSON.parse(message);
			message = `${error.code.toUpperCase()}: ${error.message}`;
		} catch {}
		throw new NotOk({
			responseText: message,
			statusCode: x.status
		});
	}
	return await x.json();
}

//#endregion
export { fetchApi };
//# sourceMappingURL=api.js.map