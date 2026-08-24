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
var verify_vercel_oidc_token_exports = {};
__export(verify_vercel_oidc_token_exports, {
  verifyVercelOidcToken: () => verifyVercelOidcToken
});
module.exports = __toCommonJS(verify_vercel_oidc_token_exports);
var import_jose = require("jose");
const VERCEL_OIDC_ISSUER = "https://oidc.vercel.com";
const VERCEL_OIDC_JWKS_URL = new URL(
  "https://oidc.vercel.com/.well-known/jwks"
);
const DEFAULT_ALGORITHMS = ["RS256"];
const VERCEL_OIDC_JWKS = (0, import_jose.createRemoteJWKSet)(VERCEL_OIDC_JWKS_URL);
async function verifyVercelOidcToken(token, options) {
  const {
    algorithms,
    projectId = process.env.VERCEL_PROJECT_ID,
    environment = process.env.VERCEL_TARGET_ENV || process.env.VERCEL_ENV,
    ownerId,
    ...verifyOptions
  } = options ?? {};
  if (projectId === "*" && ownerId === void 0 && !hasAudienceVerification(verifyOptions.audience)) {
    throw new TypeError(
      "Expected ownerId or audience to be provided when projectId is '*'."
    );
  }
  const result = await (0, import_jose.jwtVerify)(token, VERCEL_OIDC_JWKS, {
    ...verifyOptions,
    algorithms: algorithms ?? DEFAULT_ALGORITHMS
  });
  validateIssuer(result.payload.iss);
  validateClaim({
    actual: result.payload.project_id,
    claim: "project_id",
    env: "VERCEL_PROJECT_ID",
    expected: projectId,
    option: "projectId"
  });
  validateClaim({
    actual: result.payload.environment,
    claim: "environment",
    env: "VERCEL_TARGET_ENV or VERCEL_ENV",
    expected: environment,
    option: "environment"
  });
  validateOptionalClaim({
    actual: result.payload.owner_id,
    claim: "owner_id",
    expected: ownerId
  });
  return result;
}
function hasAudienceVerification(audience) {
  return Array.isArray(audience) ? audience.length > 0 : audience !== void 0;
}
function validateIssuer(actual) {
  if (actual !== VERCEL_OIDC_ISSUER && (typeof actual !== "string" || !actual.startsWith(`${VERCEL_OIDC_ISSUER}/`))) {
    throw new TypeError(
      `Expected Vercel OIDC token iss claim to be "${VERCEL_OIDC_ISSUER}" or to start with "${VERCEL_OIDC_ISSUER}/".`
    );
  }
}
function validateClaim({
  actual,
  claim,
  env,
  expected,
  option
}) {
  if (expected === "*") {
    return;
  }
  if (expected === void 0 || expected.length === 0) {
    throw new TypeError(
      `Expected ${env} to be set or ${option} to be provided. Pass ${option}: '*' to allow any ${claim} claim.`
    );
  }
  if (Array.isArray(expected) && typeof actual === "string" && expected.includes(actual)) {
    return;
  }
  if (actual !== expected) {
    throw new TypeError(
      Array.isArray(expected) ? `Expected Vercel OIDC token ${claim} claim to be one of: ${expected.map((value) => `"${value}"`).join(", ")}.` : `Expected Vercel OIDC token ${claim} claim to be "${expected}".`
    );
  }
}
function validateOptionalClaim({
  actual,
  claim,
  expected
}) {
  if (expected === void 0) {
    return;
  }
  if (actual !== expected) {
    throw new TypeError(
      `Expected Vercel OIDC token ${claim} claim to be "${expected}".`
    );
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  verifyVercelOidcToken
});
