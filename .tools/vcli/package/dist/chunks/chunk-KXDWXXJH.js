import { createRequire as __createRequire } from 'node:module';
import { fileURLToPath as __fileURLToPath } from 'node:url';
import { dirname as __dirname_ } from 'node:path';
const require = __createRequire(import.meta.url);
const __filename = __fileURLToPath(import.meta.url);
const __dirname = __dirname_(__filename);

// src/util/output-format.ts
var OUTPUT_FORMATS = ["json"];
function parseOutputFormat(value) {
  const normalized = value.toLowerCase();
  if (OUTPUT_FORMATS.includes(normalized)) {
    return normalized;
  }
  throw new Error(
    `Invalid output format: "${value}". Valid formats: ${OUTPUT_FORMATS.join(", ")}`
  );
}
function getOutputFormat(flags) {
  const formatFlag = flags["--format"];
  const jsonFlag = flags["--json"];
  if (formatFlag) {
    return parseOutputFormat(formatFlag);
  }
  if (jsonFlag) {
    return "json";
  }
  return void 0;
}
function isJsonOutput(flags) {
  return getOutputFormat(flags) === "json";
}
function validateJsonOutput(flags) {
  try {
    const jsonOutput = isJsonOutput(flags);
    return { valid: true, jsonOutput };
  } catch (err) {
    return { valid: false, error: err.message };
  }
}
function wantsMachineReadableOutput(subcommand, argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    return false;
  }
  if (subcommand === "api") {
    return true;
  }
  if (argv.includes("--json")) {
    return true;
  }
  for (const arg of argv) {
    if (arg.toLowerCase() === "--format=json") {
      return true;
    }
  }
  const formatIdx = argv.indexOf("--format");
  if (formatIdx !== -1 && argv[formatIdx + 1]?.toLowerCase() === "json") {
    return true;
  }
  return false;
}
function shouldPrintVersionBanner(subcommand, argv) {
  return !wantsMachineReadableOutput(subcommand, argv);
}

export {
  validateJsonOutput,
  wantsMachineReadableOutput,
  shouldPrintVersionBanner
};
