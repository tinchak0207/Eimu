//#region src/utils/paginator.ts
function attachPaginator(firstPage, options) {
	const { itemsKey, fetchNext, signal } = options;
	async function* iteratePages() {
		throwIfAborted(signal);
		let page = firstPage;
		yield page;
		while (page.pagination.next !== null) {
			throwIfAborted(signal);
			page = await fetchNext(page.pagination.next);
			yield page;
		}
	}
	async function* iterateItems() {
		for await (const page of iteratePages()) {
			const items = page[itemsKey];
			for (const item of items) {
				throwIfAborted(signal);
				yield item;
			}
		}
	}
	return {
		...firstPage,
		[Symbol.asyncIterator]: iterateItems,
		pages: iteratePages,
		toArray: async () => {
			const all = [];
			for await (const item of iterateItems()) all.push(item);
			return all;
		}
	};
}
function throwIfAborted(signal) {
	if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
}

//#endregion
export { attachPaginator };
//# sourceMappingURL=paginator.js.map