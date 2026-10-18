/**
 * OpenUI 富展示示范程序（2026-10-18）——唯一真源：
 *   - tools/gen-openui-prompt.mts 把 TASK_ID 占位版写进网关提示词；
 *   - src/app/openui-demo 用 demo task_id 版做演示；
 *   - 单测逐条断言 repair 恒等 + 解析 0 错误。
 * `{{ID1}}`…`{{ID4}}` 为占位符，由 fillRichExample 替换。
 */
export type RichExample = { key: string; title: string; kind: "image" | "video" | "audio"; code: string };

export const RICH_EXAMPLES: RichExample[] = [
  {
    key: "delivery-gallery",
    title: "交付卡 + 画廊（真实元数据徽章 + 分页签）",
    kind: "image",
    code: `root = Card([hdr, facts, tabs])
hdr = CardHeader("海报四版已交付", "主视觉 + 三张延展")
m1 = Query("artifact", {taskId: "{{ID1}}"})
facts = Row([Badge(m1.model, "info"), Badge(m1.resolution), Badge(m1.cost)], 2, "center", "start", true)
tabs = Tabs([TabItem("画廊", [gal]), TabItem("交付", [deliver])])
gal = ImageGallery(["{{ID1}}", "{{ID2}}", "{{ID3}}", "{{ID4}}"], "点缩略图切换主图", "hero")
deliver = DeliverableCard("本次交付", ["{{ID1}}", "{{ID2}}", "{{ID3}}", "{{ID4}}"], "每张都可下载、再来一版或存图库")`,
  },
  {
    key: "album",
    title: "专辑（播放器 + 歌词片段 + 曲目表与曲长图，数字全来自 Query）",
    kind: "audio",
    code: `root = Card([hdr, lead, album, info])
hdr = CardHeader("专辑《把灯留着》", "三首成曲")
lead = AudioPlayer("{{ID1}}", "主打歌", "lyrics")
album = AlbumPlayer("把灯留着", ["{{ID1}}", "{{ID2}}", "{{ID3}}"], "点曲目可打开滚动歌词播放器")
arts = Query("artifacts", {kind: "audio"})
info = Tabs([TabItem("曲目", [tracks]), TabItem("曲长", [lens])])
tracks = Table([Col("曲序", arts.rows.trackNo), Col("歌名", arts.rows.title), Col("时长", arts.rows.duration)])
lens = BarChart(arts.rows.title, [Series("时长（秒）", arts.rows.durationSec)])`,
  },
  {
    key: "ab-compare",
    title: "A/B 对比（前后滑块 + 并排卡片）",
    kind: "image",
    code: `root = Card([hdr, slide, side])
hdr = CardHeader("A/B 对比", "同一需求两种风格")
slide = CompareView(["{{ID1}}", "{{ID2}}"], "slider", "拖动分界线看差异")
side = CompareView(["{{ID1}}", "{{ID2}}"], "side")`,
  },
  {
    key: "process-timeline",
    title: "过程时间线（成片封面帧 + 本轮真实步骤回顾）",
    kind: "video",
    code: `root = Card([hdr, facts, player, steps, more])
hdr = CardHeader("成片已交付", "竖屏短片")
v = Query("artifact", {taskId: "{{ID1}}"})
facts = Row([Badge(v.duration, "info"), Badge(v.resolution), Badge(v.cost)], 2, "center", "start", true)
player = VideoPlayer("{{ID1}}", "终版成片", 1.5)
steps = List([ListItem("写分镜", "按你的一句话拆成镜头"), ListItem("逐镜出片", "每镜生成后自检"), ListItem("剪接成片", "配乐与转场"), ListItem("独立评审", "通过后交付")], "none", true)
more = Carousel([VideoPlayer("{{ID2}}", "备选剪辑")])`,
  },
  {
    key: "series-masonry",
    title: "系列图瀑布流 + 参数表（表格只读 Query）",
    kind: "image",
    code: `root = Card([hdr, gal, specs])
hdr = CardHeader("系列插画已出", "同一世界观的不同场景")
gal = ImageGallery(["{{ID1}}", "{{ID2}}", "{{ID3}}", "{{ID4}}"], null, "masonry")
arts = Query("artifacts", {kind: "image"})
specs = Box([Title("每张的参数", "sm"), Table([Col("模型", arts.rows.model), Col("尺寸", arts.rows.size), Col("分辨率", arts.rows.resolution)])], null, "soft")`,
  },
  {
    key: "blind-pick",
    title: "多图盲选（只标方案 A/B/C/D，回传所选 task_id）",
    kind: "image",
    code: `root = Card([hdr, pick])
hdr = CardHeader("四版海报已出", "先盲选，再看参数")
pick = CompareView(["{{ID1}}", "{{ID2}}", "{{ID3}}", "{{ID4}}"], "blind", "哪一版最接近你想要的？")`,
  },
];

export function fillRichExample(code: string, ids: readonly string[]): string {
  return code.replace(/\{\{ID(\d)\}\}/g, (_, n: string) => ids[Number(n) - 1] ?? `TASK_ID_${n}`);
}
