import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"

// 電商詳情頁排版清單（2026-08-31 片1 實裝）：產品鎖 + 賣點清單 → 模塊化排版 manifest。
// 純代碼規則引擎（零 LLM 零扣費）：內置詳情頁模塊庫 + 賣點關鍵詞→模塊映射 + 品類調整。
// 輸出每模塊的素材需求（類型/數量/畫幅），供後續 image_generate 逐模塊排產。

interface ModuleDef {
  key: string
  title: string
  purpose: string
  copy_slots: string[]
  assets: { type: string; count: number; aspect: string; note: string }[]
}

const MODULE_LIBRARY: Record<string, ModuleDef> = {
  hero_kv: {
    key: "hero_kv", title: "首屏 KV", purpose: "3 秒內講清「這是什麼、憑什麼買」",
    copy_slots: ["主標題（≤12字）", "副標題（≤20字）", "核心利益點角標"],
    assets: [{ type: "image", count: 1, aspect: "3:4", note: "產品主體+背景氛圍，750px 寬移動端首屏" }],
  },
  selling_point_grid: {
    key: "selling_point_grid", title: "賣點圖組", purpose: "逐條賣點可視化，支撐首屏主張",
    copy_slots: ["賣點標題", "賣點一句話說明"],
    assets: [{ type: "image", count: 3, aspect: "1:1", note: "每張對應一個賣點，風格統一" }],
  },
  detail_closeup: {
    key: "detail_closeup", title: "細節特寫", purpose: "材質/工藝/做工近距離證據",
    copy_slots: ["細節標題", "材質/工藝說明"],
    assets: [{ type: "image", count: 3, aspect: "1:1", note: "微距/局部特寫，突出質感" }],
  },
  scene_lifestyle: {
    key: "scene_lifestyle", title: "場景圖", purpose: "使用情境代入，讓買家看見自己",
    copy_slots: ["場景標題", "適用人群/情境說明"],
    assets: [{ type: "image", count: 2, aspect: "4:3", note: "真實使用場景，人物+產品同框" }],
  },
  spec_table: {
    key: "spec_table", title: "參數表", purpose: "規格透明，降低決策成本",
    copy_slots: ["參數名", "參數值"],
    assets: [{ type: "image", count: 1, aspect: "3:4", note: "參數排版圖或純文字表，可不用生圖" }],
  },
  size_chart: {
    key: "size_chart", title: "尺碼圖", purpose: "尺碼/尺寸指引，退換貨預防",
    copy_slots: ["尺碼表頭", "測量說明"],
    assets: [{ type: "image", count: 1, aspect: "3:4", note: "平鋪尺寸標註圖或尺碼表" }],
  },
  trust_badges: {
    key: "trust_badges", title: "信任狀", purpose: "資質/銷量/口碑背書",
    copy_slots: ["認證名稱", "保修承諾", "口碑數據"],
    assets: [{ type: "image", count: 2, aspect: "1:1", note: "認證證書/檢測報告/榮譽牆版式圖" }],
  },
  usage_guide: {
    key: "usage_guide", title: "使用方法", purpose: "用法步驟可視化，降低上手門檻",
    copy_slots: ["步驟標題", "步驟說明"],
    assets: [{ type: "image", count: 3, aspect: "1:1", note: "步驟圖（step 1-3）" }],
  },
  package_contents: {
    key: "package_contents", title: "包裝清單", purpose: "到貨所見即所得，防糾紛",
    copy_slots: ["清單條目"],
    assets: [{ type: "image", count: 1, aspect: "1:1", note: "全家福擺拍圖" }],
  },
  faq: {
    key: "faq", title: "常見問題", purpose: "售前疑慮前置消解",
    copy_slots: ["問題", "回答"],
    assets: [{ type: "text_only", count: 0, aspect: "-", note: "純文字模塊，無需素材" }],
  },
}

const BASE_ORDER = ["hero_kv", "selling_point_grid", "detail_closeup", "scene_lifestyle", "spec_table", "trust_badges", "usage_guide", "faq"]

const RULES: { re: RegExp; module: string }[] = [
  { re: /材质|面料|工艺|做工|细节|纹理|质感|皮革|棉|钢|陶瓷|手工/, module: "detail_closeup" },
  { re: /尺寸|尺码|参数|规格|容量|重量|功率|续航|分辨率|克重/, module: "spec_table" },
  { re: /认证|专利|质检|质保|保修|销量|好评|品牌|检测|报告|资质|旗舰/, module: "trust_badges" },
  { re: /场景|适用|户外|通勤|居家|旅行|办公|送礼|车载|运动|露营/, module: "scene_lifestyle" },
  { re: /用法|使用|步骤|安装|教程|操作|清洗|保养/, module: "usage_guide" },
  { re: /包装|配件|清单|全家福|赠品/, module: "package_contents" },
  { re: /尺码|身高|体重|码数/, module: "size_chart" },
]

const CATEGORY_HINTS: { re: RegExp; add: string[] }[] = [
  { re: /服装|服饰|鞋|包|内衣|童装|穿戴/, add: ["size_chart"] },
  { re: /数码|电子|家电|手机|电脑|耳机|相机/, add: ["package_contents", "spec_table"] },
  { re: /美妆|护肤|个护|洗护|香水/, add: ["usage_guide"] },
  { re: /食品|生鲜|零食|茶|咖啡|酒/, add: ["package_contents", "usage_guide"] },
  { re: /家具|家居|收纳|厨具|家纺/, add: ["scene_lifestyle", "size_chart"] },
]

const FAQ_TEMPLATES = [
  (name: string) => `${name}适合什么人群/场景？`,
  () => "发货时间与物流方式？",
  () => "支持七天无理由退换吗？",
  () => "保修/质保政策是什么？",
  (name: string) => `${name}与同类产品的核心差异？`,
]

function parseList(v: string): string[] {
  const t = v.trim()
  if (!t) return []
  try {
    const j = JSON.parse(t)
    if (Array.isArray(j)) return j.map((x) => String(x).trim()).filter(Boolean)
    if (typeof j === "string") return [j]
  } catch {
    /* 分隔符回退 */
  }
  return t.split(/[\n，,、;；]+/).map((s) => s.trim()).filter(Boolean)
}

export default tool({
  description:
    "詳情頁排版清單生成器（純代碼規則引擎，零扣費）。product_lock 填產品鎖 JSON 字串（{name,category?,price?}，name 必填），selling_points 填賣點清單（JSON 陣列字串或換行/逗號分隔）。輸出電商詳情頁 manifest：模塊庫（首屏KV/賣點圖/細節特寫/場景圖/參數表/尺碼圖/信任狀/使用方法/包裝清單/FAQ）按賣點關鍵詞與品類規則映射排序，每模塊給文案槽位與素材需求（類型/數量/畫幅），可直接餵給 image_generate 逐模塊排產。只產排版清單，不產文案不產圖。",
  args: {
    product_lock: tool.schema.string().describe("產品鎖 JSON 字串：{\"name\":\"...\",\"category\":\"...\",\"price\":...}"),
    selling_points: tool.schema.string().describe("賣點清單：JSON 陣列字串或換行/逗號分隔文本"),
  },
  async execute(args) {
    const lockRaw = String(args.product_lock ?? "").trim()
    const pointsRaw = String(args.selling_points ?? "").trim()
    if (!lockRaw) return fail("missing_product_lock", "product_lock 為空：需給 {name,category?,price?} JSON", { title: "輸入缺失" })
    if (!pointsRaw) return fail("missing_selling_points", "selling_points 為空：至少給一條賣點", { title: "輸入缺失" })

    let lock: Record<string, unknown> = {}
    try {
      const j = JSON.parse(lockRaw)
      if (j && typeof j === "object" && !Array.isArray(j)) lock = j as Record<string, unknown>
      else if (typeof j === "string") lock = { name: j }
    } catch {
      lock = { name: lockRaw.slice(0, 60) }
    }
    const name = typeof lock.name === "string" && lock.name.trim() ? lock.name.trim() : ""
    if (!name) return fail("invalid_product_lock", "product_lock 缺 name 欄位（產品名）", { title: "輸入非法" })
    const category = typeof lock.category === "string" ? lock.category : ""
    const points = parseList(pointsRaw)
    if (!points.length) return fail("invalid_selling_points", "selling_points 解析後為空", { title: "輸入非法" })

    const used = new Set<string>(["hero_kv", "faq"])
    const pointMapping: { point: string; module: string }[] = []
    for (const p of points) {
      const hit = RULES.find((r) => r.re.test(p))
      const mod = hit ? hit.module : "selling_point_grid"
      used.add(mod)
      pointMapping.push({ point: p, module: mod })
    }
    for (const hint of CATEGORY_HINTS) {
      if (hint.re.test(category)) hint.add.forEach((m) => used.add(m))
    }

    const orderedKeys = [...BASE_ORDER.filter((k) => used.has(k)), ...[...used].filter((k) => !BASE_ORDER.includes(k))]
    const modules = orderedKeys.map((k, i) => {
      const def = MODULE_LIBRARY[k]
      const mapped = pointMapping.filter((m) => m.module === k).map((m) => m.point)
      return {
        order: i + 1,
        module: def.key,
        title: def.title,
        purpose: def.purpose,
        copy_slots: def.copy_slots,
        selling_points_covered: mapped,
        assets_required: def.assets,
      }
    })

    const totalImages = modules.reduce((sum, m) => sum + m.assets_required.reduce((s, a) => s + a.count, 0), 0)
    const unmapped = pointMapping.filter((m) => m.module === "selling_point_grid").length

    return ok({
      title: `詳情頁清單：${modules.length} 模塊/${totalImages} 張圖`,
      product: { name, category: category || null, price: lock.price ?? null },
      manifest: modules,
      faq_questions: FAQ_TEMPLATES.map((f) => f(name)),
      stats: {
        module_count: modules.length,
        total_images_required: totalImages,
        selling_points_total: points.length,
        selling_points_generic_grid: unmapped,
      },
      note: "文案槽位為佔位指引非成稿；素材需經 image_generate 逐模塊產出後回填。",
    })
  },
})
