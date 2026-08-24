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
var src_exports = {};
__export(src_exports, {
  AccessTokenMissingError: () => import_auth_errors.AccessTokenMissingError,
  RefreshAccessTokenFailedError: () => import_auth_errors.RefreshAccessTokenFailedError,
  exchangeVercelOidcToken: () => import_exchange_vercel_oidc_token.exchangeVercelOidcToken,
  getContext: () => import_get_context.getContext,
  getVercelOidcToken: () => import_get_vercel_oidc_token_with_refresh.getVercelOidcToken,
  getVercelOidcTokenSync: () => import_get_vercel_oidc_token_sync.getVercelOidcTokenSync,
  getVercelToken: () => import_token_util.getVercelToken,
  verifyVercelOidcToken: () => import_verify_vercel_oidc_token.verifyVercelOidcToken
});
module.exports = __toCommonJS(src_exports);
var import_get_vercel_oidc_token_with_refresh = require("./get-vercel-oidc-token-with-refresh");
var import_get_vercel_oidc_token_sync = require("./get-vercel-oidc-token-sync");
var import_get_context = require("./get-context");
var import_verify_vercel_oidc_token = require("./verify-vercel-oidc-token");
var import_auth_errors = require("./auth-errors");
var import_exchange_vercel_oidc_token = require("./exchange-vercel-oidc-token");
var import_token_util = require("./token-util");
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
