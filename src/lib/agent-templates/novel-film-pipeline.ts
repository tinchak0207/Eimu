import type { AgentTemplate } from "./types";

export const novelFilmPipelineCard: AgentTemplate = 
  {
    "id": "agent-novel-film-pipeline",
    "name": "小说影视化",
    "harnessTemplateId": "novel_film",
    "note": "小说到成片全链：拆剧本→角色圣经→美术圣经→锁构图分镜→关键帧，工业流水线跑法",
    "domain": "novel",
    "accent": "from-[#1a1c23] via-[#3B2F4A] to-[#8B7355]",
    "glow": "#3B2F4A",
    "showcaseVideo": "/showcase/agent-templates/novel-film-3.mp4",
    "showcaseImage": "/showcase/agent-templates/novel-film-3.webp",
    "painPoint": "文本到分镜全靠逐条，断点在情绪连续性和角色漂移",
    "pipeline": {
      "summary": "小说文本→结构化剧本JSON→资产先行→锁构图分镜→成组关键帧的影视化流水线",
      "steps": [
        {
          "name": "拆解剧本",
          "shortName": "剧本",
          "outputKind": "text"
        },
        {
          "name": "建角色圣经",
          "shortName": "角色卡"
        },
        {
          "name": "定美术圣经",
          "shortName": "美术卡"
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
          "name": "合成镜头视频",
          "shortName": "视频",
          "outputKind": "video"
        },
        {
          "name": "配音配乐",
          "shortName": "配音",
          "outputKind": "audio"
        },
        {
          "name": "组装成片",
          "shortName": "成片",
          "outputKind": "video"
        }
      ]
    }
  }
;
