//#region src/auth/error.d.ts
declare class NotOk extends Error {
  name: string;
  response: {
    statusCode: number;
    responseText: string;
  };
  constructor(response: {
    statusCode: number;
    responseText: string;
  });
}
//#endregion
export { NotOk };
//# sourceMappingURL=error.d.cts.map