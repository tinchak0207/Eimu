import { AGENT_TEMPLATES } from "../src/lib/agent-templates";
for (const t of AGENT_TEMPLATES) {
  console.log(`===== ${t.id} =====`);
  console.log(`INITIAL: ${t.initialPrompt}`);
  console.log(`DIRECTIVE: ${t.directive}`);
}
