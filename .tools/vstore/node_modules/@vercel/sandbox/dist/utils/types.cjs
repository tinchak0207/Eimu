
//#region src/utils/types.ts
/**
* Extract private parameters out of an object.
*/
const getPrivateParams = (params) => {
	const privateEntries = Object.entries(params ?? {}).filter(([k]) => k.startsWith("__"));
	return Object.fromEntries(privateEntries);
};

//#endregion
exports.getPrivateParams = getPrivateParams;
//# sourceMappingURL=types.cjs.map