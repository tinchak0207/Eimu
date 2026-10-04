// B 端生成请求的**数量上限**常数单点（对称差 D23／P1-7 能力契约）。
//
// 这里是「每次请求最多几个／最多几张」的唯一真源，而且是**叶模组**：零 import、
// 不碰 `node:` 内建／DB／catalog。理由＝`generation-model-catalog/capabilities.ts`
// 会被前端 bundle 拉进去（P1-4 教训），能力投射要在 client 端算得出来，
// 就不能透过它把服务端模组拖进 bundle。曾经的病灶是同一颗数字在执行端各写一份
// （route 的 `MAX_N`、`biz-image-references` 的 `MAX_REFERENCE_IMAGES`），
// 揭露出去的值与真的挡人的值可以各自漂移——D23 修的就是这个「揭露与行为脱节」。
//
// 语义（与能力投射同一条铁律）：**能力宣告 ≠ 一定能提交**。
// 这里的数字＝执行端此刻真的会挡人的那一颗；但它是**全站共同上限**，
// 模型本身可能另有更严格的限制（例如某模型根本不收参考图、某上游只吃单张），
// 所以在上限内不保证成功。

/** 一次 `/v1/images|videos/generations` 请求最多几个（`n` 的合法区间上限）→ 400 `invalid_n`。 */
export const MAX_REQUEST_BATCH_COUNT = 4;

/** 一次生图请求最多带几张参考图（`reference_images` 合计上限）→ 400 `invalid_reference_images`。 */
export const MAX_REQUEST_REFERENCE_IMAGES = 5;