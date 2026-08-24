"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
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
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var exec_exports = {};
__export(exec_exports, {
  execVercelCli: () => execVercelCli
});
module.exports = __toCommonJS(exec_exports);
var import_node_path = __toESM(require("node:path"));
var import_execa = __toESM(require("execa"));
var import_envpath = require("./envpath");
var import_errors = require("./errors");
var import_lookup = require("./lookup");
async function execVercelCli(args, options = {}) {
  const cwd = import_node_path.default.resolve(options.cwd ?? process.cwd());
  await (0, import_errors.assertValidCwd)(cwd);
  const env = mergeExecEnv(options.env);
  const pathValue = (0, import_envpath.getEnvPath)(env);
  try {
    return await execResolvedVercelCli(args, options, cwd, env, pathValue);
  } catch (error) {
    if (error instanceof import_errors.VercelCliError && error.code === "VERCEL_CLI_NOT_FOUND") {
      (0, import_lookup.clearCachedCliInvocation)(cwd, pathValue);
      return await execResolvedVercelCli(args, options, cwd, env, pathValue);
    }
    throw error;
  }
}
async function execResolvedVercelCli(args, options, cwd, env, pathValue) {
  const invocation = await resolveInvocationOrThrow(cwd, pathValue);
  try {
    const execaOptions = {
      input: options.input,
      stdio: options.stdio,
      stdin: options.stdin,
      stdout: options.stdout,
      stderr: options.stderr,
      timeout: options.timeout,
      cwd,
      env: await prependLocalBinsToEnvPath(cwd, env),
      windowsHide: true
    };
    if (options.signal) {
      execaOptions.signal = options.signal;
    }
    const { stdout, stderr } = await (0, import_execa.default)(
      invocation.command,
      [...invocation.commandArgs, ...args],
      execaOptions
    );
    return { stdout, stderr, invocation };
  } catch (error) {
    throw (0, import_errors.toVercelCliError)(invocation, error);
  }
}
async function resolveInvocationOrThrow(cwd, pathValue) {
  const resolution = await (0, import_lookup.resolveCachedCliInvocation)(cwd, pathValue);
  if (!resolution.found) {
    throw new import_errors.VercelCliError({
      code: "VERCEL_CLI_NOT_FOUND",
      message: (0, import_errors.getCliNotFoundMessage)(resolution.diagnostics)
    });
  }
  return (0, import_lookup.toVercelCliInvocation)(resolution);
}
function mergeExecEnv(env) {
  if (!env) {
    return process.env;
  }
  return { ...process.env, ...env };
}
async function prependLocalBinsToEnvPath(cwd, env = process.env) {
  const localPath = await prependLocalBinsToPath(cwd, (0, import_envpath.getEnvPath)(env));
  return (0, import_envpath.setEnvPath)(
    env,
    (0, import_envpath.prependPathEntries)(localPath, [import_node_path.default.dirname(process.execPath)])
  );
}
async function prependLocalBinsToPath(cwd, pathValue = "") {
  return (0, import_envpath.prependPathEntries)(
    pathValue,
    (await (0, import_lookup.getLocalBinSearch)(cwd)).directories
  );
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  execVercelCli
});
//# sourceMappingURL=exec.js.map
