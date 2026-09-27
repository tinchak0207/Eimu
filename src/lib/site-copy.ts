/**
 * 站點對外介紹的單一真源：layout metadata（含 OG／Twitter／JSON-LD）、首頁 tab 標題、
 * PWA manifest 都從這裡取，別再各寫一份。
 *
 * 2026-09-27 暴君糾正：舊文案以「在线生成 GPT Image 2 / Nano Banana Pro 图片」開頭
 * ＋一句「不用注册中转站」，站在瀏覽器分頁上被讀成「又一个 Image/Banana 镜像站」——
 * 等於自己把產品歸類成中轉站。定位之爭在第一眼就被裁定（見記憶
 * manju-relay-objection-and-demo-onboarding-0922），所以介紹的第一句必須是
 * 我們自己的承諾：一句話 → AI 智能體自己拆解 → 成片。
 *
 * 模型名不是刪掉，是降級：關鍵詞與描述尾段仍留著（長尾導流還要用），但不再當標題。
 * 模型清單的權威在 `generation-model-catalog`，這裡只描述「一個入口、一套計費」。
 */

export const SITE_TITLE = "Eimu — 一句话到成片的 AI 影像工作台";

export const SITE_DESCRIPTION =
  "说一句想要的画面，AI 智能体自己拆解剧本、角色、分镜，一路跑到成片。" +
  "无限画布看得见每一步，角色锁定一次、跨镜头不换脸；" +
  "图片、视频、配音、剪辑共 57 个模型一个入口、一套计费，失败自动退币。";

/** PWA 安裝對話框／manifest 用：同一句話的短版。 */
export const SITE_SHORT_DESCRIPTION =
  "一句话到成片：AI 智能体自己拆解剧本、角色、分镜，一路跑到成片。";

/** JSON-LD featureList：利於搜尋結果的理解，逐條都是真能力。 */
export const SITE_FEATURE_LIST = [
  "一句话生成整张创作图与成片",
  "AI 智能体自动拆解剧本、角色、分镜",
  "角色锁定一次，跨镜头不换脸",
  "图片、视频、配音、剪辑共 57 个模型，一个入口、一套计费",
  "生成失败自动退币",
];
