// 卡庫索引的修訂號：`@[角色:名稱]` 的行內索引快取住在展示層（entity-chip），
// 而所有卡庫寫入都收斂在資料層（character-card-client）。兩者互相 import 會成環，
// 所以「索引有沒有過期」這件事降到這裡——一個沒有任何 import 的號碼牌。
//
// 資料層存/刪成功後發號（bumpCharacterCardIndexRevision），
// 展示層取號並連同快取的 promise 一起記下（getCharacterCardIndexRevision）：
// 號碼不同＝快取過期，重載。呼叫端因此不可能忘記失效。
let revision = 0;

/** 卡庫內容變更後呼叫（存卡／刪卡成功）。 */
export function bumpCharacterCardIndexRevision(): void {
  revision += 1;
}

/** 展示層取號：與快取時記錄的號碼不同＝快取已過期。 */
export function getCharacterCardIndexRevision(): number {
  return revision;
}
