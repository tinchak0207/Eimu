//#region src/auth/error.ts
var NotOk = class extends Error {
	constructor(response) {
		super(`HTTP ${response.statusCode}: ${response.responseText}`);
		this.name = "NotOk";
		this.response = response;
	}
};

//#endregion
export { NotOk };
//# sourceMappingURL=error.js.map