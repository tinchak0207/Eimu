import { AGENT_TEMPLATES_FULL } from "../src/lib/agent-templates-payload";
for (const t of AGENT_TEMPLATES_FULL) {
  console.log(`===== ${t.id} =====`);
  console.log(`INITIAL: ${t.initialPrompt}`);
  console.log(`DIRECTIVE: ${t.directive}`);
}
