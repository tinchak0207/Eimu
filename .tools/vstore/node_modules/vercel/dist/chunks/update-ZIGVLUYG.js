import { createRequire as __createRequire } from 'node:module';
import { fileURLToPath as __fileURLToPath } from 'node:url';
import { dirname as __dirname_ } from 'node:path';
const require = __createRequire(import.meta.url);
const __filename = __fileURLToPath(import.meta.url);
const __dirname = __dirname_(__filename);
import {
  parseCustomAlertQueryBody,
  resolveCustomAlertProjectName,
  setMissingCustomAlertProjectScope
} from "./chunk-QKO2DGWR.js";
import {
  emitRulesArgParseError,
  handleRulesApiError,
  parseRulesFlagsAndScope,
  rulesItemPath
} from "./chunk-Q6QCRFTC.js";
import "./chunk-6GWLC2IP.js";
import "./chunk-KQRVZWJU.js";
import "./chunk-WODLA275.js";
import "./chunk-JKQWQA2T.js";
import {
  validateJsonOutput
} from "./chunk-KXDWXXJH.js";
import {
  rulesUpdateSubcommand
} from "./chunk-UMA66MKW.js";
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
import "./chunk-TZ2YI2VH.js";

// src/commands/alerts/rules/update.ts
import { readFileSync } from "fs";
import { resolve } from "path";
async function update(client, argv) {
  let parsedArgs;
  try {
    parsedArgs = parseArguments(
      argv,
      getFlagsSpecification(rulesUpdateSubcommand.options)
    );
  } catch (e) {
    emitRulesArgParseError(
      client,
      e,
      "alerts rules update <ruleId> --project <name-or-id> --body <path>"
    );
    printError(e);
    return 1;
  }
  const ruleId = parsedArgs.args[0];
  const fr = validateJsonOutput(parsedArgs.flags);
  if (!fr.valid) {
    outputAgentError(
      client,
      {
        status: "error",
        reason: AGENT_REASON.INVALID_ARGUMENTS,
        message: fr.error
      },
      1
    );
    output_manager_default.error(fr.error);
    return 1;
  }
  if (!ruleId) {
    outputAgentError(
      client,
      {
        status: "error",
        reason: AGENT_REASON.MISSING_ARGUMENTS,
        message: `Missing rule id. Example: ${packageName} alerts rules update <ruleId> --body <file>`,
        next: [
          {
            command: buildCommandWithGlobalFlags(
              client.argv,
              "alerts rules update <ruleId> --body <file>"
            ),
            when: "Replace <ruleId> and <file> with id and JSON patch path"
          }
        ]
      },
      1
    );
    output_manager_default.error("Usage: `vercel alerts rules update <ruleId> --body <PATH>`");
    return 1;
  }
  const bodyPath = parsedArgs.flags["--body"];
  if (!bodyPath) {
    outputAgentError(
      client,
      {
        status: "error",
        reason: AGENT_REASON.MISSING_ARGUMENTS,
        message: `Missing required flag --body. Example: ${packageName} alerts rules update ${ruleId} --body <file>`,
        next: [
          {
            command: buildCommandWithGlobalFlags(
              client.argv,
              `alerts rules update ${ruleId} --body <file>`
            ),
            when: "Replace <file> with a path to JSON patch payload"
          }
        ]
      },
      1
    );
    output_manager_default.error("Missing required flag: --body <PATH> (JSON patch payload).");
    return 1;
  }
  const scope = await parseRulesFlagsAndScope(
    client,
    {
      "--project": parsedArgs.flags["--project"],
      "--all": parsedArgs.flags["--all"]
    },
    fr.jsonOutput,
    `alerts rules update ${ruleId}`
  );
  if (typeof scope === "number") {
    return scope;
  }
  let raw;
  try {
    raw = readFileSync(resolve(client.cwd, bodyPath), "utf8");
  } catch {
    outputAgentError(
      client,
      {
        status: "error",
        reason: AGENT_REASON.INVALID_ARGUMENTS,
        message: `Could not read --body file: ${bodyPath}`
      },
      1
    );
    output_manager_default.error(`Could not read --body file: ${bodyPath}`);
    return 1;
  }
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    outputAgentError(
      client,
      {
        status: "error",
        reason: AGENT_REASON.INVALID_ARGUMENTS,
        message: "Invalid JSON in --body file."
      },
      1
    );
    output_manager_default.error("Invalid JSON in --body file.");
    return 1;
  }
  const parsedCustomAlertQuery = parseCustomAlertQueryBody(client, body);
  if (typeof parsedCustomAlertQuery === "number") {
    return parsedCustomAlertQuery;
  }
  delete body.id;
  delete body.teamId;
  const path = rulesItemPath(scope, ruleId);
  output_manager_default.spinner("Updating alert rule...");
  try {
    if (parsedCustomAlertQuery && !Object.hasOwn(parsedCustomAlertQuery.query, "scope")) {
      let projectId = typeof body.projectId === "string" ? body.projectId : void 0;
      if (!projectId) {
        const rule = await client.fetch(path);
        projectId = rule.projectId;
      }
      if (projectId) {
        const projectName = await resolveCustomAlertProjectName(
          client,
          scope,
          projectId
        );
        setMissingCustomAlertProjectScope(
          parsedCustomAlertQuery,
          scope.teamId,
          projectId,
          projectName
        );
      }
    }
    const updated = await client.fetch(path, {
      method: "PATCH",
      body
    });
    if (fr.jsonOutput) {
      client.stdout.write(`${JSON.stringify({ rule: updated }, null, 2)}
`);
    } else {
      output_manager_default.success(`Updated alert rule ${ruleId}`);
    }
    return 0;
  } catch (err) {
    if (isAPIError(err)) {
      return handleRulesApiError(client, err, fr.jsonOutput);
    }
    throw err;
  } finally {
    output_manager_default.stopSpinner();
  }
}
export {
  update as default
};
