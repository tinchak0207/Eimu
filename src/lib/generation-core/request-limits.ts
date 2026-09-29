// B 端生成請求的**數量上限**常數單點（對稱差 D23／P1-7 能力契約）。
//
// 這裡是「每次請求最多幾個／最多幾張」的唯一真源，而且是**葉模組**：零 import、
// 不碰 `node:` 內建／DB／catalog。理由＝`generation-model-catalog/capabilities.ts`
// 會被前端 bundle 拉進去（P1-4 教訓），能力投射要在 client 端算得出來，
// 就不能透過它把服務端模組拖進 bundle。曾經的病灶是同一顆數字在執行端各寫一份
// （route 的 `MAX_N`、`biz-image-references` 的 `MAX_REFERENCE_IMAGES`），
// 揭露出去的值與真的擋人的值可以各自漂移——D23 修的就是這個「揭露與行為脫節」。
//
// 語義（與能力投射同一條鐵律）：**能力宣告 ≠ 一定能提交**。
// 這裡的數字＝執行端此刻真的會擋人的那一顆；但它是**全站共同上限**，
// 模型本身可能另有更嚴格的限制（例如某模型根本不收參考圖、某上游只吃單張），
// 所以在上限內不保證成功。

/** 一次 `/v1/images|videos/generations` 請求最多幾個（`n` 的合法區間上限）→ 400 `invalid_n`。 */
export const MAX_REQUEST_BATCH_COUNT = 4;

/** 一次生圖請求最多帶幾張參考圖（`reference_images` 合計上限）→ 400 `invalid_reference_images`。 */
export const MAX_REQUEST_REFERENCE_IMAGES = 5;