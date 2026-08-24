import { createRequire as __createRequire } from 'node:module';
import { fileURLToPath as __fileURLToPath } from 'node:url';
import { dirname as __dirname_ } from 'node:path';
const require = __createRequire(import.meta.url);
const __filename = __fileURLToPath(import.meta.url);
const __dirname = __dirname_(__filename);
import {
  AUTH_FAILURE,
  VCR_ENGINES,
  VCR_LOGIN_USERNAME,
  emitVcrArgParseError,
  engineLogin,
  handleVcrApiError,
  isEngineInstalled,
  resolveRegistry,
  resolveVcrScope,
  stderrTail,
  validateVcrChoice,
  validateVcrJsonOutput
} from "./chunk-Z2G6SO5B.js";
import "./chunk-G75NFPIT.js";
import {
  outputError
} from "./chunk-KQRVZWJU.js";
import "./chunk-KXDWXXJH.js";
import {
  loginSubcommand
} from "./chunk-2MF3ZAVW.js";
import "./chunk-WC7IINFV.js";
import "./chunk-RIB4S2IB.js";
import "./chunk-GFCTRJI5.js";
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
  isAPIError
} from "./chunk-SOFC4MLS.js";
import "./chunk-P4QNYOFB.js";
import "./chunk-52QYYTM5.js";
import {
  output_manager_default
} from "./chunk-OX7KI3LF.js";
import "./chunk-S7KYDPEM.js";
import "./chunk-TZ2YI2VH.js";

// src/commands/vcr/login.ts
var LOGIN_VALID_HOURS = 12;
async function login(client, argv, telemetry) {
  let parsedArgs;
  try {
    parsedArgs = parseArguments(
      argv,
      getFlagsSpecification(loginSubcommand.options)
    );
  } catch (err) {
    emitVcrArgParseError(
      client,
      err,
      "vcr login <engine> --project <name-or-id>"
    );
    printError(err);
    return 1;
  }
  const fr = validateVcrJsonOutput(client, parsedArgs.flags);
  if (typeof fr === "number") {
    return fr;
  }
  const engineArg = parsedArgs.args[0];
  const project = parsedArgs.flags["--project"];
  telemetry.trackCliArgumentEngine(engineArg);
  telemetry.trackCliOptionProject(project);
  telemetry.trackCliOptionFormat(parsedArgs.flags["--format"]);
  if (!engineArg) {
    const message = `Missing engine. Choose one of: ${VCR_ENGINES.join(", ")}.`;
    outputAgentError(
      client,
      {
        status: "error",
        reason: AGENT_REASON.MISSING_ARGUMENTS,
        message,
        next: [
          {
            command: buildCommandWithGlobalFlags(
              client.argv,
              "vcr login docker"
            ),
            when: "Replace docker with the container tool you use"
          }
        ]
      },
      1
    );
    return outputError(client, fr.jsonOutput, "MISSING_ARGUMENTS", message);
  }
  const choiceError = validateVcrChoice(
    client,
    "engine",
    engineArg,
    VCR_ENGINES,
    fr.jsonOutput
  );
  if (typeof choiceError === "number") {
    return choiceError;
  }
  const engine = engineArg;
  if (!isEngineInstalled(engine)) {
    const message = `\`${engine}\` is not installed or not on your PATH. Install it and try again.`;
    outputAgentError(
      client,
      {
        status: "error",
        reason: "engine_not_found",
        message
      },
      1
    );
    return outputError(client, fr.jsonOutput, "ENGINE_NOT_FOUND", message);
  }
  const scope = await resolveVcrScope(client, {
    project,
    jsonOutput: fr.jsonOutput
  });
  if (typeof scope === "number") {
    return scope;
  }
  const registry = resolveRegistry();
  output_manager_default.spinner(`Authenticating ${engine} with ${registry}...`);
  try {
    const { token } = await client.fetch(
      `/projects/${scope.projectId}/token`,
      {
        method: "POST",
        accountId: scope.teamId,
        body: JSON.stringify({ source: "vercel-cli" }),
        headers: { "Content-Type": "application/json" }
      }
    );
    const result = await engineLogin(engine, registry, token);
    if (result.exitCode !== 0) {
      const message = AUTH_FAILURE.test(result.stderr) ? `Authentication to ${registry} as "${VCR_LOGIN_USERNAME}" was rejected. The OIDC token may be expired or lack access to this project.` : `\`${engine} login\` failed (exit code ${result.exitCode}).${stderrTail(result.stderr) ? `
${stderrTail(result.stderr)}` : ""}`;
      outputAgentError(
        client,
        {
          status: "error",
          reason: AUTH_FAILURE.test(result.stderr) ? "not_authorized" : "command_failed",
          message,
          next: [
            {
              command: buildCommandWithGlobalFlags(client.argv, "whoami"),
              when: "See current user and team"
            }
          ]
        },
        1
      );
      return outputError(
        client,
        fr.jsonOutput,
        AUTH_FAILURE.test(result.stderr) ? "NOT_AUTHORIZED" : "COMMAND_FAILED",
        message
      );
    }
    if (fr.jsonOutput) {
      client.stdout.write(
        `${JSON.stringify(
          {
            status: "success",
            engine,
            registry,
            username: VCR_LOGIN_USERNAME,
            validForHours: LOGIN_VALID_HOURS
          },
          null,
          2
        )}
`
      );
    } else {
      output_manager_default.success(
        `Logged in to ${registry} as ${VCR_LOGIN_USERNAME} (${engine}).`
      );
      output_manager_default.log(
        `Credentials are valid for ~${LOGIN_VALID_HOURS} hours. Re-run \`${buildCommandWithGlobalFlags(
          client.argv,
          `vcr login ${engine}`
        )}\` to refresh.`
      );
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
  login as default
};
