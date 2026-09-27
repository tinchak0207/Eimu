import type { Metadata } from "next";
import { ImagePlayground } from "@/components/ImagePlayground";
import { getAllSuggestions } from "@/lib/suggestions";
import { SITE_DESCRIPTION, SITE_TITLE } from "@/lib/site-copy";

/**
 * 分頁標題＝站點介紹的第一句，也是被誤讀最狠的一格。
 *
 * 2026-09-27 暴君糾正：舊值「在线生成 GPT Image 2 / Nano Banana Pro 图片 | Eimu」
 * 讓人在瀏覽器分頁上讀成「又一个 Image/Banana 镜像站」——用模型名開場的介紹，
 * 等於自己認領中轉站那個位子。現在整站（layout metadata／本頁／manifest／JSON-LD）
 * 都取自 lib/site-copy.ts 單一真源：先講我們自己的承諾，模型名降級到關鍵詞與
 * 描述尾段（長尾導流照舊，但不再當標題）。
 */
export const metadata: Metadata = {
  title: SITE_TITLE,
  description: SITE_DESCRIPTION,
};

export default function Page() {
  return <ImagePlayground suggestions={getAllSuggestions()} />;
}
