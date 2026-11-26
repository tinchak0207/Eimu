import type { AgentTemplate } from "./types";

export const shortdramaVisualAssetsCard: AgentTemplate = 
  {
    "id": "agent-shortdrama-visual-assets",
    "name": "剧本视觉化",
    "harnessTemplateId": "shortdrama_visual",
    "note": "剧本到视觉资产工业链：拆场→分镜→主演角色卡→CP剧照→竖屏海报，门禁层层放行",
    "domain": "shortdrama",
    "accent": "from-[#2B0A12] via-[#7A1F3D] to-[#D46A6E]",
    "glow": "#7A1F3D",
    "showcaseVideo": "/showcase/agent-templates/drama-visual-2.mp4",
    "showcaseImage": "/showcase/agent-templates/drama-visual-2.webp",
    "painPoint": "剧本到开拍全靠嘴对齐，导演脑补的和你不是同一部片",
    "pipeline": {
      "summary": "剧本拆场→锁构图分镜→主演角色资产→CP 剧照→竖屏海报的短剧视觉工业链",
      "steps": [
        {
          "name": "拆解剧本",
          "shortName": "剧本",
          "outputKind": "text"
        },
        {
          "name": "铸造主演资产",
          "shortName": "主演卡"
        },
        {
          "name": "锁定分镜",
          "shortName": "分镜",
          "outputKind": "text"
        },
        {
          "name": "3D 白模预演",
          "shortName": "预演",
          "outputKind": "director"
        },
        {
          "name": "渲染关键帧",
          "shortName": "关键帧"
        },
        {
          "name": "合成配音",
          "shortName": "配音",
          "outputKind": "audio"
        },
        {
          "name": "生成镜头视频",
          "shortName": "视频",
          "outputKind": "video"
        },
        {
          "name": "剪辑成片",
          "shortName": "成片",
          "outputKind": "video"
        },
        {
          "name": "产出投放物料",
          "shortName": "物料"
        }
      ]
    }
  }
;
