import type { Metadata } from "next";
import ImagePlayground from "@/components/ImagePlayground";
import { getAllSuggestions } from "@/lib/suggestions";
import { SITE_DESCRIPTION, SITE_TITLE } from "@/lib/site-copy";
import { getSiteUrlFromEnv } from "@/lib/site-url";

const SITE_URL = getSiteUrlFromEnv();

/**
 * 分页标题＝站点介绍的第一句，也是被误读最狠的一格。
 *
 * 2026-09-27 暴君纠正：旧值「在线生成 GPT Image 2 / Nano Banana Pro 图片 | Eimu」
 * 让人在浏览器分页上读成「又一个 Image/Banana 镜像站」——用模型名开场的介绍，
 * 等于自己认领中转站那个位子。现在整站（layout metadata／本页／manifest／JSON-LD）
 * 都取自 lib/site-copy.ts 单一真源：先讲我们自己的承诺，模型名降级到关键词与
 * 描述尾段（长尾导流照旧，但不再当标题）。
 */
export const metadata: Metadata = {
  title: { absolute: SITE_TITLE },
  description: SITE_DESCRIPTION,
  alternates: { canonical: SITE_URL },
};

export default function Page() {
  return (
    <>
      {/* 首页是工作台本身，版面上没有标题位；H1 给搜索引擎与读屏器认出这页是什么
          （2026-09-27 SEO：先前全页零 H1）。sr-only 不占版面、不改视觉。 */}
      <h1 className="sr-only">Eimu：一句话到成片的 AI 影像工作台——AI 智能体拆解剧本、角色、分镜，生成图片、视频、配音与成片</h1>
      <ImagePlayground suggestions={getAllSuggestions()} />
    </>
  );
}
