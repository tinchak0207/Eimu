"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var errors_exports = {};
__export(errors_exports, {
  VercelCliError: () => VercelCliError,
  assertValidCwd: () => assertValidCwd,
  getCliNotFoundMessage: () => getCliNotFoundMessage,
  toVercelCliError: () => toVercelCliError
});
module.exports = __toCommonJS(errors_exports);
var import_promises = require("node:fs/promises");
class VercelCliError extends Error {
  constructor(options) {
    super(options.message);
    this.name = "VercelCliError";
    this.code = options.code;
    this.invocation = options.invocation;
    this.stdout = options.stdout;
    this.stderr = options.stderr;
    this.exitCode = options.exitCode;
    if (options.cause !== void 0) {
      this.cause = options.cause;
    }
  }
}
function getCliNotFoundMessage(diagnostics) {
  const details = [];
  const { localBinSearch } = diagnostics;
  if (localBinSearch.stopReason === "project-root-marker") {
    details.push(
      `Local bin lookup stopped at ${JSON.stringify(localBinSearch.stoppedAt)} (${JSON.stringify(localBinSearch.markerPath)}).`
    );
  } else if (localBinSearch.stopReason === "filesystem-root") {
    details.push(
      `No project root marker was found from ${JSON.stringify(localBinSearch.searchRoot)}; local bin lookup reached the filesystem root.`
    );
  }
  for (const skippedNodeModules of localBinSearch.skippedNodeModules) {
    details.push(
      `Skipped ${JSON.stringify(skippedNodeModules.directory)}: ${skippedNodeModules.reason}.`
    );
  }
  for (const skippedLocalBin of diagnostics.skippedLocalBins) {
    details.push(
      `Skipped ${JSON.stringify(skippedLocalBin.candidate)}: ${skippedLocalBin.reason}.`
    );
  }
  if (details.length === 0) {
    return "Unable to find a usable Vercel CLI installation.";
  }
  return ["Unable to find a usable Vercel CLI installation.", ...details].join(
    "\n"
  );
}
async function assertValidCwd(cwd) {
  try {
    if (!(await (0, import_promises.stat)(cwd)).isDirectory()) {
      throw new Error("not a directory");
    }
  } catch {
    throw new VercelCliError({
      code: "VERCEL_CLI_INVALID_CWD",
      message: `Working directory ${JSON.stringify(cwd)} does not exist or is not a directory.`
    });
  }
}
function toVercelCliError(invocation, error) {
  if (typeof error === "object" && error !== null) {
    const execaError = error;
    if (execaError.code === "ENOENT") {
      return new VercelCliError({
        code: "VERCEL_CLI_NOT_FOUND",
        message: `Unable to find Vercel CLI command ${JSON.stringify(invocation.command)}.`,
        invocation,
        cause: error
      });
    }
    if (execaError.code === "EACCES" || execaError.code === "EPERM") {
      return new VercelCliError({
        code: "VERCEL_CLI_PERMISSION_DENIED",
        message: `Permission denied while executing Vercel CLI command ${JSON.stringify(invocation.command)}.`,
        invocation,
        cause: error
      });
    }
    if (execaError.timedOut) {
      return new VercelCliError({
        code: "VERCEL_CLI_TIMED_OUT",
        message: `Timed out while executing Vercel CLI command ${JSON.stringify(invocation.command)}.`,
        invocation,
        stdout: execaError.stdout,
        stderr: execaError.stderr,
        cause: error
      });
    }
    if (execaError.isCanceled) {
      return new VercelCliError({
        code: "VERCEL_CLI_CANCELED",
        message: `Canceled while executing Vercel CLI command ${JSON.stringify(invocation.command)}.`,
        invocation,
        stdout: execaError.stdout,
        stderr: execaError.stderr,
        cause: error
      });
    }
    if (execaError.signal) {
      return new VercelCliError({
        code: "VERCEL_CLI_SIGNALED",
        message: `Vercel CLI command ${JSON.stringify(invocation.command)} exited due to signal ${execaError.signal}.`,
        invocation,
        stdout: execaError.stdout,
        stderr: execaError.stderr,
        cause: error
      });
    }
    if (typeof execaError.exitCode === "number") {
      return new VercelCliError({
        code: "VERCEL_CLI_ERRORED",
        message: execaError.shortMessage ?? execaError.message ?? `Vercel CLI command ${JSON.stringify(invocation.command)} exited with code ${execaError.exitCode}.`,
        invocation,
        stdout: execaError.stdout,
        stderr: execaError.stderr,
        exitCode: execaError.exitCode,
        cause: error
      });
    }
  }
  return new VercelCliError({
    code: "VERCEL_CLI_EXEC_FAILED",
    message: `Could not execute Vercel CLI command ${JSON.stringify(invocation.command)}.`,
    invocation,
    cause: error
  });
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  VercelCliError,
  assertValidCwd,
  getCliNotFoundMessage,
  toVercelCliError
});
//# sourceMappingURL=errors.js.map
