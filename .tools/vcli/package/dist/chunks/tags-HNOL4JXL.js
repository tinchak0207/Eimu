import { createRequire as __createRequire } from 'node:module';
import { fileURLToPath as __fileURLToPath } from 'node:url';
import { dirname as __dirname_ } from 'node:path';
const require = __createRequire(import.meta.url);
const __filename = __fileURLToPath(import.meta.url);
const __dirname = __dirname_(__filename);
import {
  getInvalidSubcommand
} from "./chunk-VGIMO3ZK.js";
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

// src/commands/vcr/tags/index.ts
var TAGS_CONFIG = {
  ls: ["ls", "list"],
  inspect: ["inspect", "get"]
};
async function tags(client, argv, telemetry) {
  const { subcommand, args } = getSubcommand(argv, TAGS_CONFIG);
  if (subcommand == null) {
    const message = argv.length === 0 ? getInvalidSubcommand(TAGS_CONFIG) : `Unknown "vcr tag" subcommand "${argv[0]}".`;
    outputAgentError(
      client,
      {
        status: "error",
        reason: AGENT_REASON.INVALID_ARGUMENTS,
        message,
        next: [
          {
            command: buildCommandWithGlobalFlags(client.argv, "vcr tag --help"),
            when: "Show valid tag subcommands"
          }
        ]
      },
      1
    );
    output_manager_default.error(`${message} Run \`vercel vcr tag --help\`.`);
    return 1;
  }
  switch (subcommand) {
    case "ls":
      return (await import("./ls-YHS5IEBJ.js")).default(client, args, telemetry);
    case "inspect":
      return (await import("./inspect-REJXLWLL.js")).default(client, args, telemetry);
    default:
      output_manager_default.error(`Unhandled tags subcommand: ${subcommand}`);
      return 1;
  }
}
export {
  tags as default
};
