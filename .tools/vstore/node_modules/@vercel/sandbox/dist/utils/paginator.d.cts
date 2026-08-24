//#region src/utils/paginator.d.ts
type CursorPaginationMeta = {
  count: number;
  next: string | null;
};
type HasPagination = {
  pagination: CursorPaginationMeta;
};
type ItemOf<Page, Key extends keyof Page> = Page[Key] extends Array<infer Item> ? Item : never;
type Paginator<Page extends HasPagination, Key extends keyof Page> = Page & AsyncIterable<ItemOf<Page, Key>> & {
  pages(): AsyncIterable<Page>;
  toArray(): Promise<ItemOf<Page, Key>[]>;
};
//#endregion
export { Paginator };
//# sourceMappingURL=paginator.d.cts.map