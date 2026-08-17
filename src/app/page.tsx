import type { Metadata } from "next";
import { ImagePlayground } from "@/components/ImagePlayground";
import { getAllSuggestions } from "@/lib/suggestions";

export const metadata: Metadata = {
  title: "在线生成 GPT Image 2 / Nano Banana Pro 图片 | Eimu",
  description:
    "打字就能出图，登录即用。内置 GPT Image 2、Nano Banana Pro 等主流模型，不用配置中转站、不用申请 API Key，生成完直接下载。",
};

export default function Page() {
  return <ImagePlayground suggestions={getAllSuggestions()} />;
}
