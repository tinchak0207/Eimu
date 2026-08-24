//#region src/utils/types.d.ts
/**
 * Utility type that extends a type to accept private parameters.
 *
 * The private parameters can then be extracted out of the object using
 * `getPrivateParams`.
 */
type WithPrivate<T> = T & { [K in `__${string}`]?: unknown };
//#endregion
export { WithPrivate };
//# sourceMappingURL=types.d.cts.map