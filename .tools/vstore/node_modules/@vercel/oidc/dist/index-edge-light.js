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
var index_edge_light_exports = {};
__export(index_edge_light_exports, {
  AccessTokenMissingError: () => import_auth_errors.AccessTokenMissingError,
  RefreshAccessTokenFailedError: () => import_auth_errors.RefreshAccessTokenFailedError,
  exchangeVercelOidcToken: () => import_exchange_vercel_oidc_token2.exchangeVercelOidcToken,
  getContext: () => import_get_context.getContext,
  getVercelOidcToken: () => getVercelOidcToken,
  getVercelOidcTokenSync: () => import_get_vercel_oidc_token_sync2.getVercelOidcTokenSync,
  getVercelToken: () => getVercelToken,
  verifyVercelOidcToken: () => import_verify_vercel_oidc_token.verifyVercelOidcToken
});
module.exports = __toCommonJS(index_edge_light_exports);
var import_exchange_vercel_oidc_token = require("./exchange-vercel-oidc-token");
var import_get_vercel_oidc_token_sync = require("./get-vercel-oidc-token-sync");
var import_get_context = require("./get-context");
var import_verify_vercel_oidc_token = require("./verify-vercel-oidc-token");
var import_auth_errors = require("./auth-errors");
var import_get_vercel_oidc_token_sync2 = require("./get-vercel-oidc-token-sync");
var import_exchange_vercel_oidc_token2 = require("./exchange-vercel-oidc-token");
async function getVercelOidcToken(options) {
  let token = (0, import_get_vercel_oidc_token_sync.getVercelOidcTokenSync)();
  if (options?.audience) {
    token = await (0, import_exchange_vercel_oidc_token.exchangeVercelOidcToken)({
      token,
      audience: options.audience,
      jti: options.jti
    });
  }
  return token;
}
async function getVercelToken() {
  throw new Error("getVercelToken is not supported in Edge Runtime");
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  AccessTokenMissingError,
  RefreshAccessTokenFailedError,
  exchangeVercelOidcToken,
  getContext,
  getVercelOidcToken,
  getVercelOidcTokenSync,
  getVercelToken,
  verifyVercelOidcToken
});
