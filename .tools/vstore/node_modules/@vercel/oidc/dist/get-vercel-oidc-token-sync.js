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
var get_vercel_oidc_token_sync_exports = {};
__export(get_vercel_oidc_token_sync_exports, {
  getVercelOidcTokenSync: () => getVercelOidcTokenSync
});
module.exports = __toCommonJS(get_vercel_oidc_token_sync_exports);
var import_get_context = require("./get-context");
function getVercelOidcTokenSync() {
  const token = (0, import_get_context.getContext)().headers?.["x-vercel-oidc-token"] ?? process.env.VERCEL_OIDC_TOKEN;
  if (!token) {
    throw new Error(
      `The 'x-vercel-oidc-token' header is missing from the request.`
    );
  }
  return token;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  getVercelOidcTokenSync
});
