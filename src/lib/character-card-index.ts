// 卡库索引的修订号：`@[角色:名称]` 的行内索引快取住在展示层（entity-chip），
// 而所有卡库写入都收敛在资料层（character-card-client）。两者互相 import 会成环，
// 所以「索引有没有过期」这件事降到这里——一个没有任何 import 的号码牌。
//
// 资料层存/删成功后发号（bumpCharacterCardIndexRevision），
// 展示层取号并连同快取的 promise 一起记下（getCharacterCardIndexRevision）：
// 号码不同＝快取过期，重载。呼叫端因此不可能忘记失效。
let revision = 0;

/** 卡库内容变更后呼叫（存卡／删卡成功）。 */
export function bumpCharacterCardIndexRevision(): void {
  revision += 1;
}

/** 展示层取号：与快取时记录的号码不同＝快取已过期。 */
export function getCharacterCardIndexRevision(): number {
  return revision;
}
