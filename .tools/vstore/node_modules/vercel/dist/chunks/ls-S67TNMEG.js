import { createRequire as __createRequire } from 'node:module';
import { fileURLToPath as __fileURLToPath } from 'node:url';
import { dirname as __dirname_ } from 'node:path';
const require = __createRequire(import.meta.url);
const __filename = __fileURLToPath(import.meta.url);
const __dirname = __dirname_(__filename);
import {
  repositoryPermissionsPath
} from "./chunk-BEQV3X2L.js";
import {
  emitVcrArgParseError,
  formatRelativeTime,
  handleVcrApiError,
  requireVcrRepository,
  resolveVcrScope,
  validateVcrJsonOutput
} from "./chunk-Z2G6SO5B.js";
import "./chunk-G75NFPIT.js";
import {
  outputError,
  validateOptionalIntegerRange
} from "./chunk-KQRVZWJU.js";
import "./chunk-KXDWXXJH.js";
import {
  permissionsLsSubcommand
} from "./chunk-GFCTRJI5.js";
import "./chunk-R6IGDGX3.js";
import "./chunk-KDL2L4KL.js";
import "./chunk-CYNB6LL4.js";
import {
  AGENT_REASON,
  outputAgentError
} from "./chunk-J5ZEHLFM.js";
import "./chunk-GGP5R3FU.js";
import {
  printError,
  table
} from "./chunk-VAFU7DXZ.js";
import {
  parseArguments
} from "./chunk-XLKFJPMT.js";
import {
  getFlagsSpecification,
  isAPIError
} from "./chunk-SOFC4MLS.js";
import "./chunk-P4QNYOFB.js";
import "./chunk-52QYYTM5.js";
import {
  output_manager_default
} from "./chunk-OX7KI3LF.js";
import {
  require_source
} from "./chunk-S7KYDPEM.js";
import {
  __toESM
} from "./chunk-TZ2YI2VH.js";

// src/commands/vcr/permissions/ls.ts
var import_chalk = __toESM(require_source(), 1);
function printPermissions(list) {
  if (list.permissions.length === 0) {
    output_manager_default.log("This repository has not been shared with any teams.");
    return;
  }
  const headers = ["Team", "Added"].map((h) => import_chalk.default.cyan(h));
  const rows = [
    headers,
    ...list.permissions.map((permission) => [
      import_chalk.default.bold(permission.teamSlug),
      formatRelativeTime(permission.createdAt)
    ])
  ];
  const tableOutput = table(rows, { hsep: 3 }).split("\n").map((line) => line.trimEnd()).join("\n").replace(/^/gm, "  ");
  output_manager_default.print(`
${tableOutput}
`);
  if (list.nextCursor) {
    output_manager_default.log(
      `More results available. Re-run with \`--next ${list.nextCursor}\`.`
    );
  }
}
async function ls(client, argv, telemetry) {
  let parsedArgs;
  try {
    parsedArgs = parseArguments(
      argv,
      getFlagsSpecification(permissionsLsSubcommand.options)
    );
  } catch (err) {
    emitVcrArgParseError(
      client,
      err,
      "vcr permissions <repository> ls --project <name-or-id>"
    );
    printError(err);
    return 1;
  }
  const fr = validateVcrJsonOutput(client, parsedArgs.flags);
  if (typeof fr === "number") {
    return fr;
  }
  const repository = parsedArgs.args[0];
  const project = parsedArgs.flags["--project"];
  const cursor = parsedArgs.flags["--next"] ?? parsedArgs.flags["--cursor"];
  const limitFlag = parsedArgs.flags["--limit"];
  telemetry.trackCliOptionProject(project);
  telemetry.trackCliOptionLimit(limitFlag);
  telemetry.trackCliOptionNext(parsedArgs.flags["--next"]);
  telemetry.trackCliOptionCursor(parsedArgs.flags["--cursor"]);
  telemetry.trackCliOptionFormat(parsedArgs.flags["--format"]);
  const missingRepository = requireVcrRepository(
    client,
    repository,
    fr.jsonOutput,
    "vcr permissions <repository> ls"
  );
  if (typeof missingRepository === "number") {
    return missingRepository;
  }
  const limitResult = validateOptionalIntegerRange(limitFlag, {
    flag: "--limit",
    min: 1,
    max: 100
  });
  if (!limitResult.valid) {
    outputAgentError(
      client,
      {
        status: "error",
        reason: AGENT_REASON.INVALID_ARGUMENTS,
        message: limitResult.message
      },
      1
    );
    return outputError(
      client,
      fr.jsonOutput,
      limitResult.code,
      limitResult.message
    );
  }
  const scope = await resolveVcrScope(client, {
    project,
    jsonOutput: fr.jsonOutput
  });
  if (typeof scope === "number") {
    return scope;
  }
  const path = repositoryPermissionsPath(scope, repository, {
    // A repository can be shared with at most 100 teams, so a full page
    // always contains every permission.
    limit: limitResult.value ?? 100,
    cursor
  });
  output_manager_default.spinner("Fetching repository permissions...");
  try {
    const list = await client.fetch(path);
    if (fr.jsonOutput) {
      client.stdout.write(`${JSON.stringify(list, null, 2)}
`);
    } else {
      printPermissions(list);
    }
    return 0;
  } catch (err) {
    if (isAPIError(err)) {
      return handleVcrApiError(client, err, fr.jsonOutput);
    }
    throw err;
  } finally {
    output_manager_default.stopSpinner();
  }
}
export {
  ls as default
};
