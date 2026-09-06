# blender-director 配方總線索引

本檔是 `recipes/` 配方庫的總線索引（105 個目錄，六批次）。執行環境契約（Blender 5.2、橋、輸出路徑）見 [../SKILL.md](../SKILL.md)；每份配方 `SKILL.md` 檔頭自帶來源／license／5.2 雷區註釋塊，上游按 3.x/4.x 編寫的 API 命中雷區時以檔頭為準。接委託單後先到本檔按「工藝→風格→運鏡→擬合→特效」對口選配方。

## 節 1：工藝與資產（W1，22）

| 配方名 | 一句話用途 |
| --- | --- |
| blender-modeler | Edit Mode 建模、修改器、集合與場景組織的核心專項 |
| hard-surface | 科幻／工業／載具硬表面建模（boolean、倒角、面板線、greebles） |
| procedural-modeling | Geometry Nodes 與修改器式程序化資產（岩石、地形、植被、管線） |
| sculpting | Dyntopo／多解析度雕刻，重構前的高頻表面細節 |
| retopology | 面向動畫的生產級重拓撲（四邊面、環線、多邊形流） |
| uv-workflow | 生產級 UV 展開（接縫、打包、紋素密度、UDIM、燈光圖 UV） |
| texture-workflow | 生產級紋理流程（貼圖集、AO/曲率/法線/粗糙度烘焙、貼花、顯存優化） |
| materials | PBR 與風格化材質（金屬、木、混凝土、玻璃、鏽蝕、程序化著色器） |
| geometry-nodes | 程序化建模、散佈系統與可重用節點組 |
| asset-optimization | 面數、拓撲、UV 效率、材質數量與命名驗證，導出前優化門禁 |
| lod-pipeline | LOD 生成、命名、螢幕尺寸目標與驗證 |
| collision-proxy | 遊戲碰撞代理（UCX/UHX 命名、凸包、膠囊、簡易碰撞體） |
| character-artist | AAA 角色建模（解剖、風格化、面部拓撲、服裝毛髮、動畫就緒） |
| character-archetypes | 角色原型美術方向（奇幻種族、恐怖生物、職業、mecha/chibi 等體型） |
| creature-artist | AAA 生物建模（奇幻、異形、怪物，肌肉流與骨骼結構） |
| environment-artist | AAA 環境美術（模組化套件、地形、植被、建築、場景構成） |
| prop-artist | 日常與英雄道具建模（傢具、工具、kitbash 部件） |
| vegetation-artist | 植被與樹葉製作（樹木、草地卡、樹冠 LOD、遊戲級葉片貼圖集） |
| vehicle-artist | 載具專項建模（汽車、飛機、船、機甲，比例與遊戲 LOD 意識） |
| hair-groom | 毛髮梳理（曲線、粒子毛髮、幾何節點、遊戲髮卡） |
| cloth-sim | 服裝 blockout、布料模擬、釘固組與烘焙到形狀鍵／快取 |
| physics-sim | 剛體／軟體／破壞設置（約束、cell fracture 碎屑、烘焙快取） |

## 節 2：風格／mood／世界觀（W2，34）

| 配方名 | 一句話用途 |
| --- | --- |
| archviz | 建築可視化（室內外、真實比例、相機構圖、PBR、靜幀與動畫交付） |
| isometric-style | 等距／策略遊戲美術方向（透視模型盒框景、真等距相機、瓦片規則） |
| lowpoly-style | 低多邊形美術方向（PS1/PS2、Lethal Company 系：可讀剪影、少面數） |
| pixel-art-style | 像素藝術／紋素約束美術方向（低解析度紋理、HD-2D 鄰近讀感） |
| stylized-style | 風格化美術方向（形狀語言、誇張、色彩和諧、NPR 渲染） |
| painterly-style | 繪畫感美術方向（水彩／油畫、柔邊、顏料質感、插畫光） |
| hand-painted-style | 手繪紋理美術方向（筆觸 albedo、柔和明度過渡、風格化 PBR 節制） |
| vector-style | 向量扁平美術方向（平塗、銳利剪影、UI 級圖形清晰度） |
| minimalist-style | 極簡／抽象美術方向（簡化形體、有限色板、負空間） |
| anime-style | 動畫／賽璐璐著色美術方向（硬色階斷裂、toon shader、乾淨剪影） |
| manga-style | 漫畫美術方向（單色明度設計、速度線、網點感、分格構圖） |
| cartoon-style | 卡通美術方向（擠壓拉伸可讀形狀、大膽配色、圖形化剪影） |
| chibi-style | Q 版／SD 比例美術方向（大頭、簡化解剖、可愛剪影規則） |
| comic-book-style | 美漫／圖像小說美術方向（墨線強調、半色調提示、高對比框景） |
| voxel-style | 體素／Minecraft 系美術方向（方塊網格建模、有限色板、chunk 友好） |
| hd-2d-style | HD-2D 美術方向（像素角色與 3D 場景結合、景深、舞台燈光） |
| stop-motion-craft-style | 定格動畫／手工藝質感（黏土動畫、紙藝、實物材料提示） |
| realistic-style | 照寫實 AAA 美術方向（攝影測量清理、真實比例、高模流程、PBR 精度） |
| cozy-wholesome-mood | 溫馨治癒系 mood 方向（可愛、放鬆、平和） |
| dark-gritty-mood | 陰暗粗糲 mood 方向（鏽蝕、廢墟、工業、孤寂、頹敗） |
| dream-surreal-mood | 夢境超現實 mood 方向（神秘、詭譎、希望與混沌） |
| dream-weirdcore-style | dreamcore／weirdcore 美術方向（閾限空間、錯位懷舊、超現實童年場景） |
| brutalist-mood | 粗野主義 mood 方向（原始混凝土、紀念碑尺度、冷峻構圖） |
| noir-style | 黑色電影美術方向（高對比燈光、濕街道、剪影、單色或限色調色） |
| frutiger-aero-style | Frutiger Aero 美術方向（光澤擬物、水感 UI、2000 年代科技樂觀主義） |
| neon-retrofuturism | 霓虹復古未來 mood（合成波、鉻、格線地平線、暮色色板） |
| retro-8bit-style | 8-bit 復古美術方向（NES 時代像素／低解析度約束） |
| retro-16bit-style | 16-bit 復古美術方向（SNES/MD 時代色彩豐富度、抖動提示、精靈感） |
| visual-console-eras | 主機世代視覺風格（PS1–PS5、街機、DOS、CRT、VHS、膠片顆粒） |
| apocalypse-worlds | 末世／反烏托邦世界觀資產語言（喪屍、外星入侵、後人類、烏托邦對照） |
| biome-worlds | 群系與環境世界觀（水下、沙漠、極地、叢林、地下、浮島） |
| fantasy-worlds | 奇幻世界觀資產語言（中世紀、高奇幻、黑暗奇幻、都市奇幻） |
| sci-fi-punk-worlds | 科幻／龐克世界觀（賽博、蒸汽、柴油、原子、太陽能、生物、發條龐克） |
| historical-worlds | 歷史時代世界觀（海盜、武士／忍者、維京、古埃及／希臘／羅馬、維多利亞、軍事） |

## 節 3：產品片運鏡／Polyhaven／圖轉 3D（W3，16）

| 配方名 | 一句話用途 |
| --- | --- |
| blender-toolkit | 自動化 Blender 任務（建 3D 形、材質管理、Mixamo 動畫重定向） |
| crane-shot | 升降鏡頭：低位起升揭示完整產品，戲劇性揭幕 |
| dolly-rotate | 前推＋環繞複合運鏡，比直線變焦更動感 |
| dynamic-full-loop | 帶變速節奏的動感全環繞循環（各面慢揭示、快速甩鏡，含頂底面） |
| perfect-loop | 首尾幀完全匹配的無縫 360° 循環轉台 |
| slow-zoom | 電影感緩慢推入英雄細部，營造揭示效果 |
| turntable | 經典 360° 產品轉台環繞動畫 |
| image-to-3d | 單張照片經 Meshy API 轉 3D 並匯入 Blender |
| multi-image-to-3d | 1–4 張多角度照片經 Meshy API 轉高精度 3D 並匯入 |
| threejs-export | 場景匯出 GLB 並生成即用 Three.js 檢視器網頁（軌道控制、自動旋轉） |
| product-polish | 匯入 GLB 模型套棚拍打光，出光澤產品照質感 |
| polyhaven-hdri-showcase | 同一產品跨多個 HDRI 環境渲染，輸出對比網格 |
| polyhaven-material-swap | 產品輪換多種 PolyHaven 材質逐版渲染，展示色彩／表面選項 |
| polyhaven-scene-builder | 用 PolyHaven 資產搭建完整產品場景（HDRI 環境、地面／基座、道具） |
| polyhaven-studio-setup | 用 PolyHaven HDRI 與 PBR 地材搭建專業棚拍／展示廳場景 |
| polyhaven-texture-apply | 給任意物件套用 PolyHaven 寫實 PBR 紋理（金屬、木、混凝土、布料） |

## 節 4：參考圖→3D 擬合管線／品質門禁（W4，20）

| 配方名 | 一句話用途 |
| --- | --- |
| animation-quality-gate | 動畫驗收門禁：接觸表渲染、剪影穩定性、閃爍、構圖、主體佔比檢查 |
| atlas-uv-fitting | 偵測紋理貼圖集區域，把各源部件 1:1 映射到各自的 UV 矩形／投影面 |
| blender-pro-workflow | 端到端生產工序（block-out→相機→燈光→形體→材質→細節→渲染→合成→導出）與批判協議 |
| blender-skill-harmonizer | 多 skill 協調成連貫管線：啟用優先級、交接產物、依賴門禁、衝突裁決 |
| closed-surface-uv-coverage | 確保紋理／貼花覆蓋封閉面全部可見表面（背蓋、側牆），不靠局部投影 |
| contour-to-mesh | 從提取的 2D 輪廓／遮罩直接建網格面（1:1 吉祥物／logo 重建、浮雕） |
| fit-repair-optimizer | 把擬合報告轉成有序修復佇列，迭代修線框／紋理／燈光／投影錯位 |
| landmark-fit-repair | 用命名地標（葉尖、殼角、眼睛、微笑、邊框厚度）校驗修復源鎖定模型 |
| mascot-logo-reconstruction | 門禁式源鎖定吉祥物／logo／品牌頭像重建編排，要求 1:1 而非近似 |
| multiview-constraint-solver | 判定前／側／背／頂模板能否由單一剛體模型滿足，選真源策略並出約束 |
| multiview-fit-loop | 對照四視圖模板與原圖的閉環「比較—調整—復驗」擬合流程 |
| orbital-hud-motion | 圍繞主體的圓形／HUD 光環動畫（弧線、軌道標記，與 logo／吉祥物關聯） |
| orthographic-registration | 把前／側／背／頂正交參考視圖註冊到共享 Blender 座標契約 |
| quality-refinement-autoloop | 結果不佳時的自我精修循環：診斷缺口→修復產物或補技能→消毒沉澱 |
| reference-analysis-validator | 宣告 1:1 之前對參考圖／線框／貼圖集／渲染成品做量測驗證 |
| reference-look-calibration | 對照原圖用可量測統計校準材質、燈光、裁切、發光、色彩管理 |
| reference-to-3d | 從參考圖集／正交四視圖／品牌模板重建高保真 Blender 模型 |
| source-part-segmentation | 重建前從源圖／線框／貼圖集分割接觸或重疊的視覺部件 |
| texture-driven-mesh-fitting | 反向擬合：讓網格邊界貼合紋理輪廓 1:1（模型遷就紋理而非拉伸紋理） |
| text-to-blender | 自然語言驅動 Blender 的總編排：轉 bpy 代碼並分派鏈載入專項子技能 |

## 節 5：特效（W6，1）

| 配方名 | 一句話用途 |
| --- | --- |
| vfx-fx | 電影與遊戲特效（煙、火、粒子、拖尾、Geometry Nodes FX 設置） |

## 節 6：基礎 12 份（07-18 片B 首批）

| 配方名 | 一句話用途 |
| --- | --- |
| animation | 遊戲級動畫（走／跑／待機循環、戰鬥、機械、相機動畫、Graph Editor、NLA） |
| camera-cinematography | 電影感鏡頭工作（取景、鏡頭、構圖、相機動畫、鏡頭語言） |
| compositing | 合成器工作流（美板堆疊、渲染通道、調色、輝光、交付輸出） |
| export-pipeline | 生產級導出（FBX、GLTF、OBJ、USD、Alembic＋比例軸向法線驗證） |
| lighting | 電影感與遊戲燈光（三點布光、HDRI、體積光、輪廓光、情緒照明） |
| lookdev | 資產外觀開發循環（材質×燈光×相機截圖對比直到著色達標） |
| qa-review | 資產生產 QA 門禁（視口截圖、驗證清單、命名審計、ship/no-ship 裁決） |
| rendering | Cycles 與 Eevee 渲染（採樣、降噪、渲染通道、色彩管理、優化） |
| rigging | 生產級綁定（骨架、IK/FK、約束、權重繪製、機械與面部綁定、驅動器） |
| scene-assembly | 大型場景布局（集合組織、連結、重載、流式友好的結構化組裝） |
| set-dressing | 場景陳設與環境敘事擺位（道具密度、敘事簇、可讀性規則） |
| references/ | 共享參考檔：9 份規範（asset-pipeline、mcp-integration、mcp-tools、naming-conventions、polycount-budgets、reference-analysis-template、reference-image-match、validation-checklist、visual-match-checklist）＋2 份 roble3 文檔（roble3-BLENDER_BEST_PRACTICES、roble3-SKILL_FOUNDATION） |

## 姐妹 skill 域

- [../../make-blender-education-video/SKILL.md](../../make-blender-education-video/SKILL.md) — Blender 教育視頻全鏈：科學／工程／建築主題的電影級教育動畫製作
- [../../motion-design/](../../motion-design/) — 動態設計域（四 skill：motion-design 動效原理、blender-motion、aftereffects-motion、motion-design-critique 評審）
- [../../astra-ad-studio/SKILL.md](../../astra-ad-studio/SKILL.md) — Astra 廣告工作室：創意方向到成品廣告戰役的全鏈製作
- [../../web-3d-awwwards/SKILL.md](../../web-3d-awwwards/SKILL.md) — Awwwards 級捲動驅動 3D 網站（Active Theory、Lusion 等視覺語言）
- [../../blender-agent-os/](../../blender-agent-os/) — agent 執行合同域（四 skill：blender-agent-core 契約先行紀律、blender-image-to-3d、blender-knowledge-workbench、img2threejs，附 knowledge 知識庫與 system-architecture.md）
