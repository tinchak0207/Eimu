import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"

// 电商详情页排版清单（2026-08-31 片1 实装）：产品锁 + 卖点清单 → 模块化排版 manifest。
// 纯代码规则引擎（零 LLM 零扣费）：内置详情页模块库 + 卖点关键词→模块映射 + 品类调整。
// 输出每模块的素材需求（类型/数量/画幅），供后续 image_generate 逐模块排产。

interface ModuleDef {
  key: string
  title: string
  purpose: string
  copy_slots: string[]
  assets: { type: string; count: number; aspect: string; note: string }[]
}

const MODULE_LIBRARY: Record<string, ModuleDef> = {
  hero_kv: {
    key: "hero_kv", title: "首屏 KV", purpose: "3 秒内讲清「这是什么、凭什么买」",
    copy_slots: ["主标题（≤12字）", "副标题（≤20字）", "核心利益点角标"],
    assets: [{ type: "image", count: 1, aspect: "3:4", note: "产品主体+背景氛围，750px 宽移动端首屏" }],
  },
  selling_point_grid: {
    key: "selling_point_grid", title: "卖点图组", purpose: "逐条卖点可视化，支撑首屏主张",
    copy_slots: ["卖点标题", "卖点一句话说明"],
    assets: [{ type: "image", count: 3, aspect: "1:1", note: "每张对应一个卖点，风格统一" }],
  },
  detail_closeup: {
    key: "detail_closeup", title: "细节特写", purpose: "材质/工艺/做工近距离证据",
    copy_slots: ["细节标题", "材质/工艺说明"],
    assets: [{ type: "image", count: 3, aspect: "1:1", note: "微距/局部特写，突出质感" }],
  },
  scene_lifestyle: {
    key: "scene_lifestyle", title: "场景图", purpose: "使用情境代入，让买家看见自己",
    copy_slots: ["场景标题", "适用人群/情境说明"],
    assets: [{ type: "image", count: 2, aspect: "4:3", note: "真实使用场景，人物+产品同框" }],
  },
  spec_table: {
    key: "spec_table", title: "参数表", purpose: "规格透明，降低决策成本",
    copy_slots: ["参数名", "参数值"],
    assets: [{ type: "image", count: 1, aspect: "3:4", note: "参数排版图或纯文字表，可不用生图" }],
  },
  size_chart: {
    key: "size_chart", title: "尺码图", purpose: "尺码/尺寸指引，退换货预防",
    copy_slots: ["尺码表头", "测量说明"],
    assets: [{ type: "image", count: 1, aspect: "3:4", note: "平铺尺寸标注图或尺码表" }],
  },
  trust_badges: {
    key: "trust_badges", title: "信任状", purpose: "资质/销量/口碑背书",
    copy_slots: ["认证名称", "保修承诺", "口碑数据"],
    assets: [{ type: "image", count: 2, aspect: "1:1", note: "认证证书/检测报告/荣誉墙版式图" }],
  },
  usage_guide: {
    key: "usage_guide", title: "使用方法", purpose: "用法步骤可视化，降低上手门槛",
    copy_slots: ["步骤标题", "步骤说明"],
    assets: [{ type: "image", count: 3, aspect: "1:1", note: "步骤图（step 1-3）" }],
  },
  package_contents: {
    key: "package_contents", title: "包装清单", purpose: "到货所见即所得，防纠纷",
    copy_slots: ["清单条目"],
    assets: [{ type: "image", count: 1, aspect: "1:1", note: "全家福摆拍图" }],
  },
  faq: {
    key: "faq", title: "常见问题", purpose: "售前疑虑前置消解",
    copy_slots: ["问题", "回答"],
    assets: [{ type: "text_only", count: 0, aspect: "-", note: "纯文字模块，无需素材" }],
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
    "详情页排版清单生成器（纯代码规则引擎，零扣费）。product_lock 填产品锁 JSON 字串（{name,category?,price?}，name 必填），selling_points 填卖点清单（JSON 阵列字串或换行/逗号分隔）。输出电商详情页 manifest：模块库（首屏KV/卖点图/细节特写/场景图/参数表/尺码图/信任状/使用方法/包装清单/FAQ）按卖点关键词与品类规则映射排序，每模块给文案槽位与素材需求（类型/数量/画幅），可直接喂给 image_generate 逐模块排产。只产排版清单，不产文案不产图。",
  args: {
    product_lock: tool.schema.string().describe("产品锁 JSON 字串：{\"name\":\"...\",\"category\":\"...\",\"price\":...}"),
    selling_points: tool.schema.string().describe("卖点清单：JSON 阵列字串或换行/逗号分隔文本"),
  },
  async execute(args) {
    const lockRaw = String(args.product_lock ?? "").trim()
    const pointsRaw = String(args.selling_points ?? "").trim()
    if (!lockRaw) return fail("missing_product_lock", "product_lock 为空：需给 {name,category?,price?} JSON", { title: "输入缺失" })
    if (!pointsRaw) return fail("missing_selling_points", "selling_points 为空：至少给一条卖点", { title: "输入缺失" })

    let lock: Record<string, unknown> = {}
    try {
      const j = JSON.parse(lockRaw)
      if (j && typeof j === "object" && !Array.isArray(j)) lock = j as Record<string, unknown>
      else if (typeof j === "string") lock = { name: j }
    } catch {
      lock = { name: lockRaw.slice(0, 60) }
    }
    const name = typeof lock.name === "string" && lock.name.trim() ? lock.name.trim() : ""
    if (!name) return fail("invalid_product_lock", "product_lock 缺 name 栏位（产品名）", { title: "输入非法" })
    const category = typeof lock.category === "string" ? lock.category : ""
    const points = parseList(pointsRaw)
    if (!points.length) return fail("invalid_selling_points", "selling_points 解析后为空", { title: "输入非法" })

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
      title: `详情页清单：${modules.length} 模块/${totalImages} 张图`,
      product: { name, category: category || null, price: lock.price ?? null },
      manifest: modules,
      faq_questions: FAQ_TEMPLATES.map((f) => f(name)),
      stats: {
        module_count: modules.length,
        total_images_required: totalImages,
        selling_points_total: points.length,
        selling_points_generic_grid: unmapped,
      },
      note: "文案槽位为占位指引非成稿；素材需经 image_generate 逐模块产出后回填。",
    })
  },
})
