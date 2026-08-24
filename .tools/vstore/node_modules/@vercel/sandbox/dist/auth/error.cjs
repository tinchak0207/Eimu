
//#region src/auth/error.ts
var NotOk = class extends Error {
	constructor(response) {
		super(`HTTP ${response.statusCode}: ${response.responseText}`);
		this.name = "NotOk";
		this.response = response;
	}
};

//#endregion
exports.NotOk = NotOk;
//# sourceMappingURL=error.cjs.map