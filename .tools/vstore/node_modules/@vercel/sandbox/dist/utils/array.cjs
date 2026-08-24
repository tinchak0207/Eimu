
//#region src/utils/array.ts
/**
* Returns an array from the given item. If the  item is an array it will be
* returned as a it is, otherwise it will be returned as a single item array.
* If the item is undefined or null an empty array will be returned.
*
* @param item The item to convert to an array.
* @returns An array.
*/
function array(item) {
	return item !== void 0 && item !== null ? Array.isArray(item) ? item : [item] : [];
}

//#endregion
exports.array = array;
//# sourceMappingURL=array.cjs.map