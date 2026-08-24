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
  PERMISSIONS_ACTIONS,
  permissionsClearSubcommand,
  permissionsLsSubcommand
} from "./chunk-GFCTRJI5.js";
import {
  AGENT_REASON,
  buildCommandWithGlobalFlags,
  outputAgentError
} from "./chunk-J5ZEHLFM.js";
import {
  parseArguments
} from "./chunk-XLKFJPMT.js";
import {
  getFlagsSpecification
} from "./chunk-SOFC4MLS.js";
import "./chunk-P4QNYOFB.js";
import {
  output_manager_default
} from "./chunk-OX7KI3LF.js";
import "./chunk-S7KYDPEM.js";
import "./chunk-TZ2YI2VH.js";

// src/commands/vcr/permissions/index.ts
var USAGE = "vcr permissions <repository> <ls|add|rm|clear>";
var ROUTING_OPTIONS = [
  ...permissionsLsSubcommand.options,
  ...permissionsClearSubcommand.options
];
async function permissions(client, argv, telemetry) {
  let positionals;
  try {
    const parsed = parseArguments(
      argv,
      getFlagsSpecification(ROUTING_OPTIONS),
      { permissive: true }
    );
    positionals = parsed.args;
  } catch {
    positionals = argv.filter((arg) => !arg.startsWith("-"));
  }
  const repository = positionals[0];
  const { subcommand } = getSubcommand(
    positionals.slice(1),
    PERMISSIONS_ACTIONS
  );
  if (!repository || subcommand == null) {
    const message = !repository ? `Missing repository. Usage: \`vercel ${USAGE}\`.` : positionals.length < 2 ? `Please specify an action. Usage: \`vercel ${USAGE}\`.` : `Unknown "vcr permissions" action "${positionals[1]}". Usage: \`vercel ${USAGE}\`.`;
    outputAgentError(
      client,
      {
        status: "error",
        reason: AGENT_REASON.INVALID_ARGUMENTS,
        message,
        next: [
          {
            command: buildCommandWithGlobalFlags(
              client.argv,
              "vcr permissions --help"
            ),
            when: "Show valid permissions actions"
          }
        ]
      },
      1
    );
    output_manager_default.error(`${message} Run \`vercel vcr permissions --help\`.`);
    return 1;
  }
  switch (subcommand) {
    case "ls":
      return (await import("./ls-S67TNMEG.js")).default(client, argv, telemetry);
    case "add":
      return (await import("./add-4L46WVRT.js")).default(client, argv, telemetry);
    case "rm":
      return (await import("./rm-BCPJUK2C.js")).default(client, argv, telemetry);
    case "clear":
      return (await import("./clear-2DMDKLWZ.js")).default(client, argv, telemetry);
    default:
      output_manager_default.error(`Unhandled permissions action: ${subcommand}`);
      return 1;
  }
}
export {
  permissions as default
};
