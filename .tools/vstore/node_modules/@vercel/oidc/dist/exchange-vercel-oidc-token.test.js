"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
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
var import_vitest = require("vitest");
function jsonResponse(body, ok = true) {
  return {
    ok,
    status: ok ? 200 : 400,
    statusText: ok ? "OK" : "Bad Request",
    json: async () => body
  };
}
function futureExpiry(secondsFromNow = 3600) {
  return Math.floor(Date.now() / 1e3) + secondsFromNow;
}
(0, import_vitest.describe)("exchangeVercelOidcToken", () => {
  let fetchMock;
  (0, import_vitest.beforeEach)(() => {
    import_vitest.vi.resetModules();
    fetchMock = import_vitest.vi.fn();
    import_vitest.vi.stubGlobal("fetch", fetchMock);
  });
  (0, import_vitest.afterEach)(() => {
    import_vitest.vi.unstubAllGlobals();
    import_vitest.vi.useRealTimers();
  });
  async function loadExchange() {
    const mod = await import("./exchange-vercel-oidc-token");
    return mod.exchangeVercelOidcToken;
  }
  (0, import_vitest.it)("reuses the cached token when the API returns an expiry", async () => {
    const exchange = await loadExchange();
    fetchMock.mockResolvedValue(
      jsonResponse({ token: "exchanged", expiry: futureExpiry() })
    );
    const first = await exchange({
      token: "t",
      audience: "https://a.example.com"
    });
    const second = await exchange({
      token: "t",
      audience: "https://a.example.com"
    });
    (0, import_vitest.expect)(first).toBe("exchanged");
    (0, import_vitest.expect)(second).toBe("exchanged");
    (0, import_vitest.expect)(fetchMock).toHaveBeenCalledTimes(1);
  });
  (0, import_vitest.it)("does not cache when the API omits the expiry", async () => {
    const exchange = await loadExchange();
    fetchMock.mockResolvedValue(jsonResponse({ token: "exchanged" }));
    await exchange({ token: "t", audience: "https://a.example.com" });
    await exchange({ token: "t", audience: "https://a.example.com" });
    (0, import_vitest.expect)(fetchMock).toHaveBeenCalledTimes(2);
  });
  (0, import_vitest.it)("skipCache bypasses the cache but still refreshes it", async () => {
    const exchange = await loadExchange();
    fetchMock.mockResolvedValue(
      jsonResponse({ token: "exchanged", expiry: futureExpiry() })
    );
    await exchange({ token: "t", audience: "https://a.example.com" });
    await exchange({
      token: "t",
      audience: "https://a.example.com",
      skipCache: true
    });
    await exchange({ token: "t", audience: "https://a.example.com" });
    (0, import_vitest.expect)(fetchMock).toHaveBeenCalledTimes(2);
  });
  (0, import_vitest.it)("re-exchanges once the cached token has expired", async () => {
    import_vitest.vi.useFakeTimers();
    import_vitest.vi.setSystemTime(/* @__PURE__ */ new Date("2025-01-01T00:00:00Z"));
    const exchange = await loadExchange();
    fetchMock.mockResolvedValue(
      jsonResponse({ token: "exchanged", expiry: futureExpiry(60) })
    );
    await exchange({ token: "t", audience: "https://a.example.com" });
    import_vitest.vi.advanceTimersByTime(61e3);
    await exchange({ token: "t", audience: "https://a.example.com" });
    (0, import_vitest.expect)(fetchMock).toHaveBeenCalledTimes(2);
  });
  (0, import_vitest.it)("keys the cache by token, audience, and jti", async () => {
    const exchange = await loadExchange();
    fetchMock.mockResolvedValue(
      jsonResponse({ token: "exchanged", expiry: futureExpiry() })
    );
    await exchange({ token: "t", audience: "https://a.example.com" });
    await exchange({ token: "t", audience: "https://b.example.com" });
    await exchange({ token: "t", audience: "https://a.example.com", jti: "x" });
    await exchange({ token: "u", audience: "https://a.example.com" });
    (0, import_vitest.expect)(fetchMock).toHaveBeenCalledTimes(4);
  });
  (0, import_vitest.it)("evicts the least-recently-used entry beyond the size limit", async () => {
    const exchange = await loadExchange();
    fetchMock.mockResolvedValue(
      jsonResponse({ token: "exchanged", expiry: futureExpiry() })
    );
    for (let i = 0; i <= 1e3; i++) {
      await exchange({
        token: `token-${i}`,
        audience: "https://a.example.com"
      });
    }
    (0, import_vitest.expect)(fetchMock).toHaveBeenCalledTimes(1001);
    await exchange({ token: "token-0", audience: "https://a.example.com" });
    (0, import_vitest.expect)(fetchMock).toHaveBeenCalledTimes(1002);
    await exchange({ token: "token-1000", audience: "https://a.example.com" });
    (0, import_vitest.expect)(fetchMock).toHaveBeenCalledTimes(1002);
  });
});
