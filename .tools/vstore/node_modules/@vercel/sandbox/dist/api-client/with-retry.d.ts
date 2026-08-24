import { Options } from "async-retry";

//#region src/api-client/with-retry.d.ts
interface RequestOptions {
  onRetry?(error: any, options: RequestOptions): void;
  retry?: Partial<Options>;
}
//#endregion
export { RequestOptions };
//# sourceMappingURL=with-retry.d.ts.map