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
var exchange_vercel_oidc_token_exports = {};
__export(exchange_vercel_oidc_token_exports, {
  exchangeVercelOidcToken: () => exchangeVercelOidcToken
});
module.exports = __toCommonJS(exchange_vercel_oidc_token_exports);
var import_version = require("./version");
class TokenCache {
  constructor(maxEntries) {
    this.maxEntries = maxEntries;
    this.entries = /* @__PURE__ */ new Map();
  }
  /**
   * Returns a cached token for the key when present and unexpired, refreshing
   * its recency for LRU eviction. Expired entries are removed on access.
   */
  get(key) {
    const entry = this.entries.get(key);
    if (entry === void 0) {
      return void 0;
    }
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return void 0;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.token;
  }
  /**
   * Stores a token under the key and evicts the least-recently-used entries
   * once the cache exceeds its size limit.
   */
  set({
    key,
    token,
    expiresAt
  }) {
    this.entries.delete(key);
    this.entries.set(key, { token, expiresAt });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === void 0) {
        break;
      }
      this.entries.delete(oldest);
    }
  }
}
const MAX_CACHE_ENTRIES = 1e3;
const tokenCache = new TokenCache(MAX_CACHE_ENTRIES);
async function getCacheKey(options) {
  const input = JSON.stringify([options.token, options.audience, options.jti]);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input)
  );
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function exchangeVercelOidcToken(options) {
  const cacheKey = await getCacheKey(options);
  if (!options.skipCache) {
    const cached = tokenCache.get(cacheKey);
    if (cached !== void 0) {
      return cached;
    }
  }
  const response = await fetch("https://oidc.vercel.com/~token", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": `@vercel/oidc@${import_version.version}`
    },
    body: JSON.stringify({
      token: options.token,
      aud: options.audience,
      ...options.jti ? { jti: options.jti } : void 0
    })
  });
  if (!response.ok) {
    throw new Error(
      `Failed to exchange token: ${await readErrorMessage(response)}`
    );
  }
  let data;
  try {
    data = await response.json();
  } catch (_error) {
    throw new Error("Failed to exchange token: response was not valid JSON");
  }
  if (!data || typeof data !== "object" || !("token" in data) || typeof data.token !== "string") {
    throw new Error(
      "Failed to exchange token: response did not contain a token"
    );
  }
  const { token } = data;
  const expiry = "expiry" in data && typeof data.expiry === "number" ? data.expiry : void 0;
  if (expiry !== void 0) {
    const expiresAt = expiry * 1e3;
    if (expiresAt > Date.now()) {
      tokenCache.set({ key: cacheKey, token, expiresAt });
    }
  }
  return token;
}
async function readErrorMessage(response) {
  try {
    const data = await response.json();
    if (data && typeof data === "object" && "error" in data && typeof data.error === "string") {
      return data.error;
    }
  } catch (_error) {
  }
  return response.statusText || `HTTP ${response.status}`;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  exchangeVercelOidcToken
});
