import { createRequire as __createRequire } from 'node:module';
import { fileURLToPath as __fileURLToPath } from 'node:url';
import { dirname as __dirname_ } from 'node:path';
const require = __createRequire(import.meta.url);
const __filename = __fileURLToPath(import.meta.url);
const __dirname = __dirname_(__filename);
import {
  getSubcommand
} from "./chunk-YPQSDAEW.js";
import {
  AGENT_REASON,
  buildCommandWithGlobalFlags,
  outputAgentError
} from "./chunk-J5ZEHLFM.js";
import "./chunk-SOFC4MLS.js";
import "./chunk-P4QNYOFB.js";
import {
  output_manager_default
} from "./chunk-OX7KI3LF.js";
import "./chunk-S7KYDPEM.js";
import "./chunk-TZ2YI2VH.js";

// src/commands/alerts/rules/index.ts
var RULES_CONFIG = {
  ls: ["ls", "list"],
  schema: ["schema"],
  add: ["add", "create"],
  inspect: ["inspect", "get"],
  rm: ["rm", "remove", "delete"],
  update: ["update", "patch"]
};
async function rules(client, argv) {
  if (argv.length === 0 || argv[0]?.startsWith("-")) {
    const lsFn = (await import("./ls-DL2POAY2.js")).default;
    return lsFn(client, argv);
  }
  const { subcommand, args, subcommandOriginal } = getSubcommand(
    argv,
    RULES_CONFIG
  );
  if (subcommand == null) {
    outputAgentError(
      client,
      {
        status: "error",
        reason: AGENT_REASON.INVALID_ARGUMENTS,
        message: `Unknown "alerts rules" subcommand "${argv[0]}".`,
        next: [
          {
            command: buildCommandWithGlobalFlags(
              client.argv,
              "alerts rules --help"
            ),
            when: "Show valid rules subcommands"
          }
        ]
      },
      1
    );
    output_manager_default.error(
      `Unknown "alerts rules" subcommand "${argv[0]}". Run \`vercel alerts rules --help\`.`
    );
    return 1;
  }
  switch (subcommand) {
    case "ls":
      return (await import("./ls-DL2POAY2.js")).default(client, args);
    case "schema":
      return (await import("./schema-LUVFYPWN.js")).default(client, args);
    case "add":
      return (await import("./add-KOD24LEM.js")).default(client, args);
    case "inspect":
      return (await import("./rule-inspect-FQ2635LY.js")).default(client, args);
    case "rm":
      return (await import("./rm-COV73VE4.js")).default(client, args);
    case "update":
      return (await import("./update-ZIGVLUYG.js")).default(client, args);
    default:
      output_manager_default.error(`Unhandled rules subcommand: ${String(subcommandOriginal)}`);
      return 1;
  }
}
export {
  rules as default
};
