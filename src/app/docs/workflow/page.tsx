import type { Metadata } from "next";
import { getSiteUrlFromEnv } from "@/lib/site-url";
import { Workflow } from "lucide-react";
import { SectionTitle, Specular, Step } from "../DocsShell";

const SITE_URL = getSiteUrlFromEnv();

export const metadata: Metadata = {
  title: "工作流：模板库与画布 | 文档中心 | Eimu",
  alternates: { canonical: `${SITE_URL}/docs/workflow` },
};

// ---- 模板转盘卡面（现场逐字：与首页模板轮盘 8 张卡面一致，domain/name/note 不可改写）----

const TEMPLATE_GALLERY: Array<{ domain: string; name: string; note: string }> = [
  {
    domain: "小说",
    name: "小说影视化",
    note: "小说到成片全链：拆剧本→角色圣经→美术圣经→锁构图分镜→关键帧，工业流水线跑法",
  },
  {
    domain: "小说",
    name: "IP视觉包",
    note: "网文 IP 全案视觉：世界观锚定→主角色卡→名场面组图→封面主视觉一条链出齐",
  },
  {
    domain: "电商",
    name: "新品上市包",
    note: "新品素材流水线：产品锁→场景图→模特图→主视觉→多画幅批量，一次锁定全线一致",
  },
  {
    domain: "电商",
    name: "模特种草线",
    note: "平铺图到种草图流水线：服装提取→虚拟试穿→一致性网格→详情页排版",
  },
  {
    domain: "短剧",
    name: "剧本视觉化",
    note: "剧本到视觉资产工业链：拆场→分镜→主演角色卡→CP剧照→竖屏海报，门禁层层放行",
  },
  {
    domain: "短剧",
    name: "投放海报线",
    note: "短剧投放物料流水线：剧设锚定→主演海报→CP对戏图→信息流切片封面批量",
  },
  {
    domain: "艺术",
    name: "策展式创作",
    note: "主题到个展全链：情绪板→风格锚→成组作品→展陈主视觉，一致性当一等公民",
  },
  {
    domain: "艺术",
    name: "风格深研线",
    note: "艺术家风格深度内化流水线：解构→临摹对拍→变体矩阵→原创成组",
  },
];

const RECIPE_CHIPS: string[] = [
  "3D手办",
  "黏土手作",
  "Q版可爱",
  "胶片质感",
  "水墨插画",
  "水彩插画",
  "赛博朋克",
  "极简主义",
  "电影感",
  "日系动漫",
];

export default function DocsWorkflowPage() {
  return (
    <div className="flex flex-col gap-6">
      <a
        href="/docs"
        className="text-ios-footnote text-[rgba(0,0,0,0.48)] lg-transition hover:text-[#007AFF]"
      >
        ← 文档中心
      </a>

      {/* ================= 工作流：模板库与画布 ================= */}
      <section id="workflow" className="scroll-mt-28">
        <SectionTitle icon={Workflow}>工作流：模板库与画布</SectionTitle>
        <p className="mt-3 max-w-2xl text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.58)]">
          一句话太小，它自己拆；工程太大，别自己拆——模板库里有现成的流水线。
        </p>
        <div className="mt-4 lg-card overflow-hidden rounded-ios-3xl sm:rounded-ios-4xl">
          <Specular />
          <div className="divide-y divide-[rgba(0,0,0,0.06)]">
            <Step
              n="1"
              title="模板转盘：四条成熟产线摆在那"
              note={
                <>
                  首轮对话前，右侧是一台 3D 卡片转盘，4 个领域 8 条产线都摆在那。点整张卡会弹确认窗，按「使用完整模板」全部环节开跑；也可以只点卡面下缘的环节 chip 挑着跑——
                  <strong className="font-semibold text-[rgba(0,0,0,0.72)]">勾选 = 全部执行 · 单击环节开/关 · 按住拖过 = 只跑扫过的</strong>
                  ，再按「按所选环节开工」。选定后右侧画布立刻铺出工序骨架，助理照单施工。
                </>
              }
            />
            <div className="grid gap-3 px-5 pb-5 sm:grid-cols-2 sm:px-7 sm:pb-7">
              {TEMPLATE_GALLERY.map((template) => (
                <div key={template.name} className="rounded-ios-2xl bg-[rgba(0,122,255,0.06)] p-4">
                  <div className="flex items-center gap-2">
                    <span className="inline-flex shrink-0 items-center rounded-full bg-[#007AFF] px-2.5 py-0.5 text-ios-caption1 font-semibold text-white">
                      {template.domain}
                    </span>
                    <p className="text-ios-footnote font-semibold text-[rgba(0,0,0,0.85)]">{template.name}</p>
                  </div>
                  <p className="mt-1.5 text-ios-caption1 leading-relaxed text-[rgba(0,0,0,0.52)]">{template.note}</p>
                </div>
              ))}
            </div>
            <Step
              n="2"
              title="画布是工作台，不是画廊"
              note={
                <>
                  每张节点卡悬浮就有一排动作：<strong className="font-semibold text-[rgba(0,0,0,0.72)]">「编辑提示词」「重新生成」</strong>
                  （只重跑这一个环节，不整链重来）、<strong className="font-semibold text-[rgba(0,0,0,0.72)]">「连线到其他节点」</strong>、
                  <strong className="font-semibold text-[rgba(0,0,0,0.72)]">「高清放大」「设为主图」「编辑图片（裁剪/切图/抠除/旋转）」「存入素材库」「下载」</strong>
                  ；右键另有<strong className="font-semibold text-[rgba(0,0,0,0.72)]">「存为卡并锁定」</strong>（角色卡/场景卡/风格卡）、
                  <strong className="font-semibold text-[rgba(0,0,0,0.72)]">「转为参考图节点」「对齐与排列」「下载全部子图 (zip)」</strong>
                  。手势：拖空白平移、Shift/Ctrl+拖框选、Delete 删除、拖节点边缘圆点连线，图片文件直接拖进画布即上传。
                </>
              }
            />
            <Step
              n="3"
              title="续写靠嘴，不靠学按钮"
              note={
                <>
                  成品落进历史与画布之后，接着打一句「再来一组」「微调一下」就行；重型多环节需求，把
                  <a
                    href="/docs/assistant"
                    className="font-semibold text-[#007AFF] lg-transition hover:underline"
                  >
                    助理设定
                  </a>
                  里的
                  <a
                    href="/docs/assistant#beast-mode"
                    className="font-semibold text-[#007AFF] lg-transition hover:underline"
                  >
                    野兽模式
                  </a>
                  打开，它会自动套成熟模板的工序结构当导演派活（详见
                  <a
                    href="/docs/assistant#beast-mode"
                    className="font-semibold text-[#007AFF] lg-transition hover:underline"
                  >
                    野兽模式
                  </a>
                  ）。
                </>
              }
            />
            <Step
              n="4"
              title="配方模板：现成的风格起点"
              note={
                <>
                  画布右键 →「提示词库 / 素材」→「配方模板」分页，10 个内建风格一键起稿：{" "}
                  {RECIPE_CHIPS.map((chip) => (
                    <span
                      key={chip}
                      className="mr-1.5 mt-1.5 inline-block rounded-full bg-[rgba(0,122,255,0.08)] px-2.5 py-0.5 text-ios-caption1 font-semibold text-[#007AFF]"
                    >
                      {chip}
                    </span>
                  ))}
                  <span className="mt-2 block">
                    官方口径：
                    <strong className="font-semibold text-[rgba(0,0,0,0.72)]">「点击即把六槽配方摊开进表单，可改可撤销，不会直接生成。」</strong>
                  </span>
                </>
              }
            />
          </div>
        </div>
      </section>
    </div>
  );
}
