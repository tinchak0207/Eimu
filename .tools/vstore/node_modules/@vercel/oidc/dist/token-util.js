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
var token_util_exports = {};
__export(token_util_exports, {
  assertVercelOidcTokenResponse: () => assertVercelOidcTokenResponse,
  findProjectInfo: () => findProjectInfo,
  getTokenPayload: () => getTokenPayload,
  getVercelOidcToken: () => getVercelOidcToken,
  getVercelOidcTokenFromCli: () => getVercelOidcTokenFromCli,
  getVercelToken: () => getVercelToken,
  isExpired: () => isExpired,
  loadToken: () => loadToken,
  saveToken: () => saveToken
});
module.exports = __toCommonJS(token_util_exports);
var path = __toESM(require("path"));
var fs = __toESM(require("fs"));
var import_cli_exec = require("@vercel/cli-exec");
var import_cli_config = require("@vercel/cli-config");
var import_token_error = require("./token-error");
var import_token_io = require("./token-io");
var import_oauth = require("./oauth");
var import_auth_errors = require("./auth-errors");
async function getVercelToken(options) {
  const configDir = (0, import_cli_config.getGlobalPathConfig)();
  const authConfig = (0, import_cli_config.tryReadAuthConfig)(configDir);
  if (!authConfig || !authConfig.token && !authConfig.refreshToken) {
    throw new import_auth_errors.AccessTokenMissingError();
  }
  if (isValidAccessToken(authConfig, options?.expirationBufferMs)) {
    return authConfig.token;
  }
  if (!authConfig.refreshToken) {
    (0, import_cli_config.writeAuthConfig)(configDir, {});
    throw new import_auth_errors.RefreshAccessTokenFailedError("No refresh token available");
  }
  try {
    const tokenResponse = await (0, import_oauth.refreshTokenRequest)({
      refresh_token: authConfig.refreshToken
    });
    const [tokensError, tokens] = await (0, import_oauth.processTokenResponse)(tokenResponse);
    if (tokensError || !tokens) {
      (0, import_cli_config.writeAuthConfig)(configDir, {});
      throw new import_auth_errors.RefreshAccessTokenFailedError(tokensError);
    }
    const updatedConfig = {
      token: tokens.access_token,
      expiresAt: Math.floor(Date.now() / 1e3) + tokens.expires_in,
      refreshToken: tokens.refresh_token
    };
    (0, import_cli_config.writeAuthConfig)(configDir, updatedConfig);
    return updatedConfig.token;
  } catch (error) {
    (0, import_cli_config.writeAuthConfig)(configDir, {});
    if (error instanceof import_auth_errors.AccessTokenMissingError || error instanceof import_auth_errors.RefreshAccessTokenFailedError) {
      throw error;
    }
    throw new import_auth_errors.RefreshAccessTokenFailedError(error);
  }
}
function isValidAccessToken(authConfig, expirationBufferMs = 0) {
  if (!authConfig.token)
    return false;
  if (typeof authConfig.expiresAt !== "number")
    return true;
  const nowInSeconds = Math.floor(Date.now() / 1e3);
  const bufferInSeconds = expirationBufferMs / 1e3;
  return authConfig.expiresAt >= nowInSeconds + bufferInSeconds;
}
async function getVercelOidcTokenFromCli(projectId, teamId) {
  const args = ["project", "token", projectId, "--format=json"];
  if (teamId) {
    args.push("--scope", teamId);
  }
  try {
    const { stdout } = await (0, import_cli_exec.execVercelCli)(args);
    let parsedOutput;
    if (typeof stdout !== "string") {
      throw new import_token_error.VercelOidcTokenError(
        "Failed to refresh OIDC token: `vercel project token` did not return stdout"
      );
    }
    try {
      parsedOutput = JSON.parse(stdout);
    } catch {
      throw new import_token_error.VercelOidcTokenError(
        "Failed to refresh OIDC token: `vercel project token` returned invalid JSON: " + stdout
      );
    }
    assertVercelOidcTokenResponse(parsedOutput);
    return parsedOutput;
  } catch (error) {
    if (error instanceof import_token_error.VercelOidcTokenError) {
      throw error;
    }
    let message = error instanceof Error ? error.message : "";
    const stderr = error instanceof import_cli_exec.VercelCliError ? error.stderr?.trim() : void 0;
    if (stderr && !message.includes(stderr)) {
      message = `${message}
${stderr}`.trim();
    }
    throw new import_token_error.VercelOidcTokenError(
      message ? `Failed to refresh OIDC token with the Vercel CLI: ${message}` : "Failed to refresh OIDC token with the Vercel CLI"
    );
  }
}
async function getVercelOidcToken(authToken, projectId, teamId) {
  const url = `https://api.vercel.com/v1/projects/${projectId}/token?source=vercel-oidc-refresh${teamId ? `&teamId=${teamId}` : ""}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${authToken}`
    }
  });
  if (!res.ok) {
    throw new import_token_error.VercelOidcTokenError(
      `Failed to refresh OIDC token: ${res.statusText}`
    );
  }
  const tokenRes = await res.json();
  assertVercelOidcTokenResponse(tokenRes);
  return tokenRes;
}
function assertVercelOidcTokenResponse(res) {
  if (!res || typeof res !== "object") {
    throw new TypeError("Vercel OIDC token is malformed. Expected an object.");
  }
  if (!("token" in res) || typeof res.token !== "string") {
    throw new TypeError(
      "Vercel OIDC token is malformed. Expected a string-valued token property."
    );
  }
}
function findProjectInfo() {
  const dir = (0, import_token_io.findRootDir)();
  if (!dir) {
    throw new import_token_error.VercelOidcTokenError(
      "Unable to find project root directory. Have you linked your project with `vc link?`"
    );
  }
  const prjPath = path.join(dir, ".vercel", "project.json");
  if (!fs.existsSync(prjPath)) {
    throw new import_token_error.VercelOidcTokenError(
      "project.json not found, have you linked your project with `vc link?`"
    );
  }
  const prj = JSON.parse(fs.readFileSync(prjPath, "utf8"));
  if (typeof prj.projectId !== "string" && typeof prj.orgId !== "string") {
    throw new TypeError(
      "Expected a string-valued projectId property. Try running `vc link` to re-link your project."
    );
  }
  return { projectId: prj.projectId, teamId: prj.orgId };
}
function saveToken(token, projectId) {
  const dir = (0, import_token_io.getUserDataDir)();
  if (!dir) {
    throw new import_token_error.VercelOidcTokenError(
      "Unable to find user data directory. Please reach out to Vercel support."
    );
  }
  const tokenPath = path.join(dir, "com.vercel.token", `${projectId}.json`);
  const tokenJson = JSON.stringify(token);
  fs.mkdirSync(path.dirname(tokenPath), { mode: 504, recursive: true });
  fs.writeFileSync(tokenPath, tokenJson);
  fs.chmodSync(tokenPath, 432);
  return;
}
function loadToken(projectId) {
  const dir = (0, import_token_io.getUserDataDir)();
  if (!dir) {
    throw new import_token_error.VercelOidcTokenError(
      "Unable to find user data directory. Please reach out to Vercel support."
    );
  }
  const tokenPath = path.join(dir, "com.vercel.token", `${projectId}.json`);
  if (!fs.existsSync(tokenPath)) {
    return null;
  }
  const token = JSON.parse(fs.readFileSync(tokenPath, "utf8"));
  assertVercelOidcTokenResponse(token);
  return token;
}
function getTokenPayload(token) {
  const tokenParts = token.split(".");
  if (tokenParts.length !== 3) {
    throw new import_token_error.VercelOidcTokenError("Invalid token.");
  }
  const base64 = tokenParts[1].replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(
    base64.length + (4 - base64.length % 4) % 4,
    "="
  );
  return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
}
function isExpired(token, bufferMs = 0) {
  return token.exp * 1e3 < Date.now() + bufferMs;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  assertVercelOidcTokenResponse,
  findProjectInfo,
  getTokenPayload,
  getVercelOidcToken,
  getVercelOidcTokenFromCli,
  getVercelToken,
  isExpired,
  loadToken,
  saveToken
});
