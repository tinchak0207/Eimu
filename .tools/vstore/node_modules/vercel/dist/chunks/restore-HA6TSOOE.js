import { createRequire as __createRequire } from 'node:module';
import { fileURLToPath as __fileURLToPath } from 'node:url';
import { dirname as __dirname_ } from 'node:path';
const require = __createRequire(import.meta.url);
const __filename = __fileURLToPath(import.meta.url);
const __dirname = __dirname_(__filename);
import {
  updateRouteVersion
} from "./chunk-PMSMUMUO.js";
import {
  getRouteVersions
} from "./chunk-AHU7WNL2.js";
import {
  confirmAction,
  findVersionById,
  getRoutes,
  parseSubcommandArgs,
  printDiffSummary,
  requireProjectContext,
  validateRequiredArguments,
  withGlobalFlags
} from "./chunk-P3BFTZXW.js";
import {
  restoreSubcommand
} from "./chunk-M22O6CYY.js";
import {
  stamp_default
} from "./chunk-64IF634X.js";
import "./chunk-VXYGCOKL.js";
import "./chunk-KDL2L4KL.js";
import "./chunk-CYNB6LL4.js";
import {
  outputAgentError
} from "./chunk-J5ZEHLFM.js";
import "./chunk-GGP5R3FU.js";
import "./chunk-VAFU7DXZ.js";
import "./chunk-XLKFJPMT.js";
import "./chunk-SOFC4MLS.js";
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

// src/commands/routes/restore.ts
var import_chalk = __toESM(require_source(), 1);
async function restore(client, argv) {
  const parsed = await parseSubcommandArgs(argv, restoreSubcommand, client);
  if (typeof parsed === "number")
    return parsed;
  const error = validateRequiredArguments(parsed.args, ["version-id"]);
  if (error) {
    if (client.nonInteractive) {
      outputAgentError(client, {
        status: "error",
        reason: "missing_arguments",
        message: error,
        next: [
          {
            command: withGlobalFlags(
              client,
              "routes restore <version-id> --yes"
            )
          },
          { command: withGlobalFlags(client, "routes list-versions") }
        ]
      });
      process.exit(1);
      return 1;
    }
    output_manager_default.error(error);
    return 1;
  }
  const link = await requireProjectContext(
    client,
    "routes",
    parsed.flags["--project"]
  );
  if (typeof link === "number")
    return link;
  const { project, org } = link;
  const teamId = org.type === "team" ? org.id : void 0;
  const [versionIdentifier] = parsed.args;
  output_manager_default.spinner(`Fetching route versions for ${import_chalk.default.bold(project.name)}`);
  const { versions } = await getRouteVersions(client, project.id, { teamId });
  const result = findVersionById(client, versions, versionIdentifier);
  if (result.error) {
    if (client.nonInteractive) {
      outputAgentError(client, {
        status: "error",
        reason: "invalid_arguments",
        message: result.error,
        next: [{ command: withGlobalFlags(client, "routes list-versions") }]
      });
      process.exit(1);
      return 1;
    }
    output_manager_default.error(result.error);
    return 1;
  }
  const version = result.version;
  if (!version) {
    if (client.nonInteractive) {
      outputAgentError(client, {
        status: "error",
        reason: "not_found",
        message: "Version not found.",
        next: [{ command: withGlobalFlags(client, "routes list-versions") }]
      });
      process.exit(1);
      return 1;
    }
    output_manager_default.error("Version not found.");
    return 1;
  }
  if (version.isLive) {
    const liveMsg = `Version ${version.id.slice(0, 12)} is currently live. You cannot restore the live version. Run ${withGlobalFlags(client, "routes list-versions")} to see previous versions you can restore.`;
    if (client.nonInteractive) {
      outputAgentError(client, {
        status: "error",
        reason: "invalid_arguments",
        message: liveMsg,
        next: [{ command: withGlobalFlags(client, "routes list-versions") }]
      });
      process.exit(1);
      return 1;
    }
    output_manager_default.error(
      `Version ${import_chalk.default.bold(
        version.id.slice(0, 12)
      )} is currently live. You cannot restore the live version.
Run ${import_chalk.default.cyan(
        withGlobalFlags(client, "routes list-versions")
      )} to see previous versions you can restore.`
    );
    return 1;
  }
  if (version.isStaging) {
    const stagingMsg = `Version ${version.id.slice(0, 12)} is staged. Use ${withGlobalFlags(client, "routes publish")} to publish it instead.`;
    if (client.nonInteractive) {
      outputAgentError(client, {
        status: "error",
        reason: "invalid_arguments",
        message: stagingMsg,
        next: [{ command: withGlobalFlags(client, "routes publish --yes") }]
      });
      process.exit(1);
      return 1;
    }
    output_manager_default.error(
      `Version ${import_chalk.default.bold(
        version.id.slice(0, 12)
      )} is staged. Use ${import_chalk.default.cyan(
        withGlobalFlags(client, "routes publish")
      )} to publish it instead.`
    );
    return 1;
  }
  output_manager_default.spinner("Fetching changes");
  const { routes: diffRoutes } = await getRoutes(client, project.id, {
    teamId,
    versionId: version.id,
    diff: true
  });
  const changedRoutes = diffRoutes.filter((r) => r.action !== void 0);
  if (changedRoutes.length > 0) {
    output_manager_default.print(`
${import_chalk.default.bold("Changes to be restored:")}

`);
    printDiffSummary(changedRoutes);
    output_manager_default.print("\n");
  } else {
    output_manager_default.print(
      `
${import_chalk.default.gray("No changes detected from current production version.")}

`
    );
  }
  const confirmed = await confirmAction(
    client,
    parsed.flags["--yes"],
    `Restore version ${import_chalk.default.bold(version.id.slice(0, 12))} to production?`,
    `This will replace the current live routes for ${import_chalk.default.bold(project.name)}.`
  );
  if (!confirmed) {
    output_manager_default.log("Canceled");
    return 0;
  }
  const updateStamp = stamp_default();
  output_manager_default.spinner(`Restoring version ${import_chalk.default.bold(version.id.slice(0, 12))}`);
  try {
    const { version: newVersion } = await updateRouteVersion(
      client,
      project.id,
      version.id,
      "restore",
      { teamId }
    );
    output_manager_default.log(
      `${import_chalk.default.cyan("Success!")} Version ${import_chalk.default.bold(
        newVersion.id.slice(0, 12)
      )} restored to production ${import_chalk.default.gray(updateStamp())}`
    );
    if (newVersion.ruleCount !== void 0) {
      output_manager_default.print(
        `  ${import_chalk.default.bold("Active routes:")} ${newVersion.ruleCount}
`
      );
    }
    return 0;
  } catch (e) {
    const error2 = e;
    const msg = error2.message || "Failed to restore version";
    if (client.nonInteractive) {
      outputAgentError(client, {
        status: "error",
        reason: "api_error",
        message: msg,
        next: [
          {
            command: withGlobalFlags(
              client,
              `routes restore ${versionIdentifier} --yes`
            )
          }
        ]
      });
      process.exit(1);
      return 1;
    }
    output_manager_default.error(msg);
    return 1;
  }
}
export {
  restore as default
};
