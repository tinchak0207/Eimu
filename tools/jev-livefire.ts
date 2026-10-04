import { readFileSync } from "node:fs";
import { jevAsk } from "../src/lib/jev-client";

async function main(): Promise<void> {
process.env.JEV_ENABLED = "true";
process.env.TYPESAFE_API_KEY = readFileSync(".env.jev", "utf8").trim().split("=")[1]!;

const r = await jevAsk(
  JSON.stringify({
    delivery: "交付了 146 BPM 七段结构的片头曲；段落秒数 3.04/9.12/6.08/10.95/7.30/10.95 小节",
    brief: "需要七段落于小节线上",
  }),
  {
    field_substance: {
      type: "noul",
      instructions:
        "Does the delivery contain substantive content (real musical structure with concrete numbers), not an excuse or restatement of the task?",
    },
    brief_honesty: {
      type: "score",
      instructions:
        "How faithfully does the delivery report match the stated verification requirements (each segment must land on a bar line)?",
      criteria: [
        "Fully honest, all gaps disclosed",
        "Mostly honest, minor omissions",
        "Contains cover-up or unverified claims",
      ],
    },
    expert_route: {
      type: "choice",
      instructions: "Which expert should handle this delivery review?",
      criteria: { music: "作曲/编曲", editor: "剪辑", screenwriter: "剧本", other: "none of the above" },
    },
  },
);
console.log(JSON.stringify(r, null, 2));
}

void main();
