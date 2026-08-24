p = "/opt/agent-harness/gateway/index.ts"
s = open(p).read()
anchor1 = "// 會話記憶補注：resume/switch 的老會話（建號時記憶為空或當時還沒這功能）"
assert s.count(anchor1) == 1, "memory-patch anchor: " + str(s.count(anchor1))
directive = "// L0 畫像 onboarding：賬戶還沒有任何確認過的畫像時，引導 agent 用 question 工具\n// 以選擇題採集畫像（PM 原則：別讓用戶動腦寫表單）。答案存 pendingProfile，\n// 下次建會話時作為臨時畫像注入（站點 DB 落庫前的過渡方案）。\nconst PROFILE_ONBOARDING_DIRECTIVE = [\n  \"這個賬戶還沒有畫像記錄。開場先讓用戶賓至如歸，但別囉嗦：\",\n  \"1. 第一條回覆：簡短歡迎一句，然後立刻用 question 工具問選擇題採集畫像（一次一道，別一次全問）：\",\n  \"   - 行業：電商／自媒體／廣告設計／攝影／其他\",\n  \"   - 常做什麼素材：商品主圖／社群貼圖／海報Banner／影片封面／人像寫真／其他\",\n  \"   - 風格偏好：簡約商務／日系清新／賽博朋克／插畫手繪／其他\",\n  \"2. 每道題給 4-6 個選項，用戶點選即可，不要讓用戶打字。\",\n  \"3. 全部問完後用一句話總結你記住的畫像，然後問用戶今天想做什麼。\",\n  \"4. 若用戶明顯趕時間（直接說了任務），跳過採集先幹活，下次再採集。\",\n  \"5. 若用戶回答了選項之外的自由文本，照樣記住。\",\n].join(\"\\n\")"
s = s.replace(anchor1, directive + "\n" + anchor1)
open(p, "w").write(s)
print("ONBOARDING DIRECTIVE OK")
