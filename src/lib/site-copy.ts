/**
 * 站点对外介绍的单一真源：layout metadata（含 OG／Twitter／JSON-LD）、首页 tab 标题、
 * PWA manifest 都从这里取，别再各写一份。
 *
 * 2026-09-27 项目负责人纠正：旧文案以「在线生成 GPT Image 2 / Nano Banana Pro 图片」开头
 * ＋一句「不用注册中转站」，站在浏览器分页上被读成「又一个 Image/Banana 镜像站」——
 * 等于自己把产品归类成中转站。定位之争在第一眼就被裁定（见记忆
 * manju-relay-objection-and-demo-onboarding-0922），所以介绍的第一句必须是
 * 我们自己的承诺：一句话 → AI 智能体自己拆解 → 成片。
 *
 * 模型名不是删掉，是降级：关键词与描述尾段仍留著（长尾导流还要用），但不再当标题。
 * 模型清单的权威在 `generation-model-catalog`，这里只描述「一个入口、一套计费」。
 */

export const SITE_TITLE = "Eimu — 一句话到成片的 AI 影像工作台";

export const SITE_DESCRIPTION =
  "说一句想要的画面，AI 智能体自己拆解剧本、角色、分镜，一路跑到成片。" +
  "无限画布看得见每一步，角色锁定一次、跨镜头不换脸；" +
  "图片、视频、配音、剪辑共 57 个模型一个入口、一套计费，失败自动退币。";

/** PWA 安装对话框／manifest 用：同一句话的短版。 */
export const SITE_SHORT_DESCRIPTION =
  "一句话到成片：AI 智能体自己拆解剧本、角色、分镜，一路跑到成片。";

/** JSON-LD featureList：利于搜寻结果的理解，逐条都是真能力。 */
export const SITE_FEATURE_LIST = [
  "一句话生成整张创作图与成片",
  "AI 智能体自动拆解剧本、角色、分镜",
  "角色锁定一次，跨镜头不换脸",
  "图片、视频、配音、剪辑共 57 个模型，一个入口、一套计费",
  "生成失败自动退币",
];
