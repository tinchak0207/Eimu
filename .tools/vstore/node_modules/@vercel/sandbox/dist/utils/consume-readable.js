//#region src/utils/consume-readable.ts
/**
* Consumes a readable entirely concatenating all content in a single Buffer
* @param readable A Readable stream
*/
function consumeReadable(readable) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		readable.on("error", (err) => reject(err));
		readable.on("data", (chunk) => chunks.push(chunk));
		readable.on("end", () => resolve(Buffer.concat(chunks)));
	});
}

//#endregion
export { consumeReadable };
//# sourceMappingURL=consume-readable.js.map