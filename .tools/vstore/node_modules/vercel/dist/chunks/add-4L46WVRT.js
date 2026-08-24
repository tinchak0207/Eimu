import { createRequire as __createRequire } from 'node:module';
import { fileURLToPath as __fileURLToPath } from 'node:url';
import { dirname as __dirname_ } from 'node:path';
const require = __createRequire(import.meta.url);
const __filename = __fileURLToPath(import.meta.url);
const __dirname = __dirname_(__filename);
import {
  MAX_CONCURRENT_REQUESTS,
  parseTeamRefs,
  require_async_sema,
  teamRefBody
} from "./chunk-3ZE5CFVM.js";
import {
  repositoryPermissionsPath
} from "./chunk-BEQV3X2L.js";
import {
  emitVcrArgParseError,
  resolveVcrScope,
  validateVcrJsonOutput
} from "./chunk-Z2G6SO5B.js";
import "./chunk-G75NFPIT.js";
import {
  outputError
} from "./chunk-KQRVZWJU.js";
import "./chunk-KXDWXXJH.js";
import {
  permissionsAddSubcommand
} from "./chunk-GFCTRJI5.js";
import "./chunk-R6IGDGX3.js";
import "./chunk-KDL2L4KL.js";
import "./chunk-CYNB6LL4.js";
import {
  AGENT_REASON,
  buildCommandWithGlobalFlags,
  outputAgentError
} from "./chunk-J5ZEHLFM.js";
import "./chunk-GGP5R3FU.js";
import {
  printError
} from "./chunk-VAFU7DXZ.js";
import {
  parseArguments
} from "./chunk-XLKFJPMT.js";
import {
  getFlagsSpecification,
  isAPIError,
  packageName
} from "./chunk-SOFC4MLS.js";
import "./chunk-P4QNYOFB.js";
import "./chunk-52QYYTM5.js";
import {
  output_manager_default
} from "./chunk-OX7KI3LF.js";
import "./chunk-S7KYDPEM.js";
import {
  __toESM
} from "./chunk-TZ2YI2VH.js";

// src/commands/vcr/permissions/add.ts
var import_async_sema = __toESM(require_async_sema(), 1);
var USAGE = "vcr permissions <repository> add <team>[,<team>...]";
async function add(client, argv, telemetry) {
  let parsedArgs;
  try {
    parsedArgs = parseArguments(
      argv,
      getFlagsSpecification(permissionsAddSubcommand.options)
    );
  } catch (err) {
    emitVcrArgParseError(client, err, USAGE);
    printError(err);
    return 1;
  }
  const fr = validateVcrJsonOutput(client, parsedArgs.flags);
  if (typeof fr === "number") {
    return fr;
  }
  const repository = parsedArgs.args[0];
  const teamRefs = parseTeamRefs(parsedArgs.args.slice(2));
  const project = parsedArgs.flags["--project"];
  telemetry.trackCliOptionProject(project);
  telemetry.trackCliOptionFormat(parsedArgs.flags["--format"]);
  if (teamRefs.length === 0) {
    outputAgentError(
      client,
      {
        status: "error",
        reason: AGENT_REASON.MISSING_ARGUMENTS,
        message: `Missing team. Example: ${packageName} vcr permissions ${repository} add team_1a2b3c4d`,
        next: [
          {
            command: buildCommandWithGlobalFlags(client.argv, USAGE),
            when: "Replace <team> with a team id or slug (comma-separate multiple teams)"
          }
        ]
      },
      1
    );
    return outputError(
      client,
      fr.jsonOutput,
      "MISSING_ARGUMENTS",
      `Usage: \`vercel ${USAGE}\``
    );
  }
  const scope = await resolveVcrScope(client, {
    project,
    jsonOutput: fr.jsonOutput
  });
  if (typeof scope === "number") {
    return scope;
  }
  const path = repositoryPermissionsPath(scope, repository);
  const added = [];
  const failed = [];
  output_manager_default.spinner(
    `Sharing ${repository} with ${teamRefs.length === 1 ? teamRefs[0] : `${teamRefs.length} teams`}...`
  );
  const sema = new import_async_sema.default(MAX_CONCURRENT_REQUESTS);
  let results;
  try {
    results = await Promise.all(
      teamRefs.map(async (team) => {
        await sema.acquire();
        try {
          const result = await client.fetch(path, {
            method: "POST",
            body: teamRefBody(team)
          });
          return { ok: true, team, permission: result.permission };
        } catch (err) {
          if (!isAPIError(err)) {
            throw err;
          }
          const message = err.serverMessage || `API error (${err.status}).`;
          return {
            ok: false,
            team,
            failure: { team, code: err.code || "API_ERROR", message }
          };
        } finally {
          sema.release();
        }
      })
    );
  } finally {
    output_manager_default.stopSpinner();
  }
  for (const result of results) {
    if (result.ok) {
      added.push(result.permission);
      if (!fr.jsonOutput) {
        output_manager_default.success(
          `Shared ${repository} with ${result.permission?.teamSlug ?? result.team}`
        );
      }
    } else {
      failed.push(result.failure);
      if (!fr.jsonOutput) {
        output_manager_default.error(
          `Failed to share ${repository} with ${result.team}: ${result.failure.message}`
        );
      }
    }
  }
  if (failed.length > 0) {
    outputAgentError(
      client,
      {
        status: "error",
        reason: AGENT_REASON.API_ERROR,
        message: `Failed to share ${repository} with ${failed.map((f) => `${f.team} (${f.message})`).join(", ")}`
      },
      1
    );
  }
  if (fr.jsonOutput) {
    client.stdout.write(
      `${JSON.stringify({ permissions: added, failed }, null, 2)}
`
    );
  }
  return failed.length > 0 ? 1 : 0;
}
export {
  add as default
};
