# Toonflow + Topview 競品分析與反制（2026-08-22）

## Toonflow（開源短劇工廠，14.3k stars）
- 源碼實讀證偽宣稱：三層Agent=序列tool-call；事件圖譜=扁平章節摘要；向量記憶=ONNX MiniLM全表掃描無ANN；vm2供應商=RCE負債；零測試；issue全是可靠性痛點。真護城河=data/skills 150+ md（Apache-2.0可吸納附NOTICE）。
- 我方決策：閉源護城河方向（durable控制面/B端API/測試覆蓋/雲端零配置），不做桌面/BYOK/小說管線。

## Topview（公開執行層偵察，docs/recon-topview-tool-map.md）
- 我方已有且更強：capabilities/uploads/query/boards/credit（OpenAI形狀+quote→reserve→refund）。
- 真缺口：TTS/avatar/lipsync節點、營銷SKU、批量API→均已派工實作中。
- 借鑑模式：中間產物直鏈不落盤；長口播按句分段鎖參數並行submit；模板=文本契約+固定調用順序；timeout≠fail禁盲目重提；部分成功只重試失敗項；未經用戶同意不得換模型。
- Won't do：情報域/發布採集/再做聊天殼。

## 輸入側反思（PM）
- 專業用戶帶創作資本來（角色版/情緒版/劇本PDF/LoRA）；LoRA待遇已對（持久可檢索資產），其他都是易耗品。缺口=持久語義資產層→角色卡/場景卡（P2 subagent 45549dac 實作中）。
