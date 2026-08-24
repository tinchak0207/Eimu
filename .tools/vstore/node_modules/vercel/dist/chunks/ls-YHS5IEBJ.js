import { createRequire as __createRequire } from 'node:module';
import { fileURLToPath as __fileURLToPath } from 'node:url';
import { dirname as __dirname_ } from 'node:path';
const require = __createRequire(import.meta.url);
const __filename = __fileURLToPath(import.meta.url);
const __dirname = __dirname_(__filename);
import {
  repositoryTagsPath
} from "./chunk-BEQV3X2L.js";
import {
  emitVcrArgParseError,
  formatBytes,
  formatDigest,
  formatRelativeTime,
  handleVcrApiError,
  requireVcrRepository,
  resolveVcrScope,
  validateVcrChoice,
  validateVcrJsonOutput
} from "./chunk-Z2G6SO5B.js";
import "./chunk-G75NFPIT.js";
import {
  outputError,
  validateOptionalIntegerRange
} from "./chunk-KQRVZWJU.js";
import "./chunk-KXDWXXJH.js";
import {
  TAGS_SORT_BY_CHOICES,
  TAGS_SORT_ORDER_CHOICES,
  tagsLsSubcommand
} from "./chunk-WC7IINFV.js";
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

// src/commands/vcr/tags/ls.ts
var import_chalk = __toESM(require_source(), 1);
function printTags(list) {
  if (list.tags.length === 0) {
    output_manager_default.log("No tags found.");
    return;
  }
  const headers = ["Tag", "Image ID", "Digest", "Arch", "Size", "Created"].map(
    (h) => import_chalk.default.cyan(h)
  );
  const rows = [
    headers,
    ...list.tags.map((tag) => [
      import_chalk.default.bold(tag.tag),
      import_chalk.default.dim(tag.imageId),
      import_chalk.default.dim(formatDigest(tag.manifestDigest)),
      tag.arch ?? "-",
      formatBytes(tag.sizeInBytes),
      formatRelativeTime(tag.createdAt)
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
      getFlagsSpecification(tagsLsSubcommand.options)
    );
  } catch (err) {
    emitVcrArgParseError(
      client,
      err,
      "vcr tag ls <repository> --project <name-or-id>"
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
  const sortBy = parsedArgs.flags["--sort-by"];
  const sortOrder = parsedArgs.flags["--sort-order"];
  telemetry.trackCliOptionProject(project);
  telemetry.trackCliOptionLimit(limitFlag);
  telemetry.trackCliOptionNext(parsedArgs.flags["--next"]);
  telemetry.trackCliOptionCursor(parsedArgs.flags["--cursor"]);
  telemetry.trackCliOptionSortBy(sortBy);
  telemetry.trackCliOptionSortOrder(sortOrder);
  telemetry.trackCliOptionFormat(parsedArgs.flags["--format"]);
  const missingRepository = requireVcrRepository(
    client,
    repository,
    fr.jsonOutput,
    "vcr tag ls <repository>"
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
  const sortByError = validateVcrChoice(
    client,
    "--sort-by",
    sortBy,
    TAGS_SORT_BY_CHOICES,
    fr.jsonOutput
  );
  if (typeof sortByError === "number") {
    return sortByError;
  }
  const sortOrderError = validateVcrChoice(
    client,
    "--sort-order",
    sortOrder,
    TAGS_SORT_ORDER_CHOICES,
    fr.jsonOutput
  );
  if (typeof sortOrderError === "number") {
    return sortOrderError;
  }
  const scope = await resolveVcrScope(client, {
    project,
    jsonOutput: fr.jsonOutput
  });
  if (typeof scope === "number") {
    return scope;
  }
  const path = repositoryTagsPath(scope, repository, {
    limit: limitResult.value,
    cursor,
    sortBy,
    sortOrder
  });
  output_manager_default.spinner("Fetching tags...");
  try {
    const list = await client.fetch(path);
    if (fr.jsonOutput) {
      client.stdout.write(`${JSON.stringify(list, null, 2)}
`);
    } else {
      printTags(list);
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
