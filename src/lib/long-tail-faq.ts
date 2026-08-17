export interface FaqItem {
  question: string;
  answer: string;
}

export const FAQ_ITEMS: FaqItem[] = [
  {
    question: "GPT Image 2 中转站是什么？我需要申请 API Key 吗？",
    answer:
      "中转站是开发者转发 GPT Image 2、Nano Banana Pro 官方接口的服务，通常要自己申请 API Key、写代码调用。如果你只是想生成图片，不需要这一步：登录 Eimu 就能直接在网页里用这些模型生成图片，生成完直接下载，不用注册中转站，也不用申请 API Key。",
  },
  {
    question: "Nano Banana Pro 中转站哪里买？多少钱？",
    answer:
      "如果目的只是出图，不用买中转站额度。Eimu 的充值方案从 ¥9.9 起，登录后直接选择 Nano Banana Pro 或 GPT Image 2 生成，按张计费，比自建中转站更省心。",
  },
  {
    question: "AI生图和普通的图片生成器有什么区别？",
    answer:
      "AI生图特指用 GPT Image 2、Nano Banana Pro 这类大模型根据文字描述直接生成画面，不需要素材拼贴或手绘基础。在 Eimu 里，AI生图和传统在线设计工具最大的区别是：你只写一句话描述，剩下的构图、光影、细节都交给模型。",
  },
  {
    question: "GPT Image 2 和 Nano Banana Pro 哪个效果更好？",
    answer:
      "两者风格不同：GPT Image 2 在文字排版、复杂构图上更稳，Nano Banana Pro 在人像质感和光影细节上更突出。Eimu 同时接入了两个模型，同一个提示词可以分别试一次再选效果更好的下载，不用为了对比再去找第二个中转站。",
  },
  {
    question: "生图中转站稳定吗？会不会突然不能用？",
    answer:
      "自建或第三方中转站依赖上游账号和网络链路，遇到限流、封号或余额问题时会突然中断。Eimu 直接维护模型接入和账号池，登录后即用，不需要自己盯着中转站的可用状态。",
  },
  {
    question: "中转站便宜到底安不安全？有没有实测数据？",
    answer:
      "德国 CISPA 亥姆霍兹信息安全中心 2026 年 3 月发布的审计论文，用模型指纹识别技术对 17 家主流 AI 中转站做了系统检测：在医疗问答等高风险基准上，官方接口调用 Gemini-2.5-flash 的准确率是 83.82%，同一模型经中转站转发后，被测中转站的平均准确率只剩约 37%。论文还核算了 GPQA 数据集上 1273 次 GPT-5 查询的费用：用户按官方费率支付了 14.84 美元，但实际拿到的 Token 产出价值只有 5.70–7.77 美元，差价被中转站在计费环节悄悄拿走。这不是个别案例，而是审计样本里的普遍现象——中转站的低价，前提是你愿意承担模型被偷换、结果打折的风险。Eimu 直接对接官方模型接口生成图片，不经过第三方转发这一层，价格和结果都可以直接核对。",
  },
  {
    question: "新手不会写代码，怎么用 GPT Image 2 生成图片？",
    answer:
      "不需要写代码。打开 image.tinchak0207.xyz，登录后在输入框描述你想要的画面，选择 GPT Image 2 或 Nano Banana Pro 模型，点击生成，几十秒后就能在页面里下载图片。",
  },
];

export const FAQ_SOURCE_CITATION = {
  label: "数据来源：CISPA Helmholtz Center for Information Security，2026 年 3 月，17 家 AI 中转站模型指纹审计论文",
  url: "https://m.36kr.com/p/3807583717416456",
};
