import { createRequire as __createRequire } from 'node:module';
import { fileURLToPath as __fileURLToPath } from 'node:url';
import { dirname as __dirname_ } from 'node:path';
const require = __createRequire(import.meta.url);
const __filename = __fileURLToPath(import.meta.url);
const __dirname = __dirname_(__filename);
import {
  imagePath,
  repositoryPath
} from "./chunk-BEQV3X2L.js";
import {
  emitVcrArgParseError,
  formatBytes,
  formatImageReference,
  formatImageStatus,
  formatRelativeTime,
  handleVcrApiError,
  requireVcrRepositoryAndImageId,
  resolveVcrScope,
  validateVcrJsonOutput
} from "./chunk-Z2G6SO5B.js";
import "./chunk-G75NFPIT.js";
import "./chunk-KQRVZWJU.js";
import "./chunk-KXDWXXJH.js";
import {
  imageInspectSubcommand
} from "./chunk-RIB4S2IB.js";
import "./chunk-R6IGDGX3.js";
import "./chunk-KDL2L4KL.js";
import "./chunk-CYNB6LL4.js";
import "./chunk-J5ZEHLFM.js";
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
import {
  require_source
} from "./chunk-S7KYDPEM.js";
import {
  __toESM
} from "./chunk-TZ2YI2VH.js";

// src/commands/vcr/image/inspect.ts
var import_chalk = __toESM(require_source(), 1);
function printImage(image, scope, repository) {
  output_manager_default.print("\n");
  output_manager_default.print(`  ${import_chalk.default.cyan("ID")}			${image.id}
`);
  output_manager_default.print(`  ${import_chalk.default.cyan("Digest")}		${image.manifestDigest}
`);
  output_manager_default.print(
    `  ${import_chalk.default.cyan("Image")}			${formatImageReference(
      scope.teamSlug,
      scope.projectName,
      repository.name,
      image.manifestDigest
    )}
`
  );
  output_manager_default.print(`  ${import_chalk.default.cyan("Type")}			${image.kind}
`);
  output_manager_default.print(`  ${import_chalk.default.cyan("Arch")}			${image.arch ?? "-"}
`);
  output_manager_default.print(`  ${import_chalk.default.cyan("Platform")}		${image.platform ?? "-"}
`);
  output_manager_default.print(
    `  ${import_chalk.default.cyan("Size")}			${formatBytes(image.sizeInBytes)}
`
  );
  output_manager_default.print(
    `  ${import_chalk.default.cyan("Status")}		${formatImageStatus(image.status)}
`
  );
  output_manager_default.print(
    `  ${import_chalk.default.cyan("Created")}		${formatRelativeTime(image.createdAt)}
`
  );
  output_manager_default.print(
    `  ${import_chalk.default.cyan("Tags")}			${image.tags?.length ? image.tags.join(", ") : "-"}
`
  );
  output_manager_default.print("\n");
}
async function inspect(client, argv, telemetry) {
  let parsedArgs;
  try {
    parsedArgs = parseArguments(
      argv,
      getFlagsSpecification(imageInspectSubcommand.options)
    );
  } catch (err) {
    emitVcrArgParseError(
      client,
      err,
      "vcr image inspect <repository> <imageId> --project <name-or-id>"
    );
    printError(err);
    return 1;
  }
  const fr = validateVcrJsonOutput(client, parsedArgs.flags);
  if (typeof fr === "number") {
    return fr;
  }
  const repository = parsedArgs.args[0];
  const imageId = parsedArgs.args[1];
  const project = parsedArgs.flags["--project"];
  telemetry.trackCliOptionProject(project);
  telemetry.trackCliOptionFormat(parsedArgs.flags["--format"]);
  const missingArgs = requireVcrRepositoryAndImageId(
    client,
    repository,
    imageId,
    fr.jsonOutput,
    "vcr image inspect <repository> <imageId>"
  );
  if (typeof missingArgs === "number") {
    return missingArgs;
  }
  const scope = await resolveVcrScope(client, {
    project,
    jsonOutput: fr.jsonOutput
  });
  if (typeof scope === "number") {
    return scope;
  }
  const path = imagePath(scope, repository, imageId);
  output_manager_default.spinner("Fetching image...");
  try {
    if (fr.jsonOutput) {
      const result = await client.fetch(path);
      client.stdout.write(`${JSON.stringify(result.image, null, 2)}
`);
    } else {
      const [imageResult, repositoryResult] = await Promise.all([
        client.fetch(path),
        client.fetch(
          repositoryPath(scope, repository)
        )
      ]);
      output_manager_default.log(`${import_chalk.default.bold("Image")} ${import_chalk.default.cyan(imageId)}`);
      printImage(imageResult.image, scope, repositoryResult.repository);
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
  inspect as default
};
