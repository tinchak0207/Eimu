import { createRequire as __createRequire } from 'node:module';
import { fileURLToPath as __fileURLToPath } from 'node:url';
import { dirname as __dirname_ } from 'node:path';
const require = __createRequire(import.meta.url);
const __filename = __fileURLToPath(import.meta.url);
const __dirname = __dirname_(__filename);
import "./chunk-TZ2YI2VH.js";

// src/util/fetch-proxy.ts
import { Agent, ProxyAgent } from "undici";
var DEFAULT_PORTS = {
  "http:": 80,
  "https:": 443
};
function getEnv(name) {
  return process.env[name.toLowerCase()] || process.env[name.toUpperCase()];
}
function normalizeProxyUrl(value) {
  const proxyUrl = value.includes("://") ? value : `http://${value}`;
  const protocol = new URL(proxyUrl).protocol;
  if (protocol !== "http:" && protocol !== "https:") {
    throw new TypeError(`Unsupported proxy protocol: ${protocol}`);
  }
  return proxyUrl;
}
var EnvProxyDispatcher = class {
  constructor(options = {}) {
    this.noProxyValue = "";
    this.noProxyEntries = [];
    const createProxyAgent = options.createProxyAgent || ((url) => new ProxyAgent(url));
    const allProxy = getEnv("all_proxy");
    const httpProxy = getEnv("http_proxy") || allProxy;
    const httpsProxy = getEnv("https_proxy") || httpProxy || allProxy;
    this.directAgent = options.directAgent || new Agent();
    this.httpAgent = httpProxy ? createProxyAgent(normalizeProxyUrl(httpProxy)) : this.directAgent;
    this.httpsAgent = httpsProxy ? createProxyAgent(normalizeProxyUrl(httpsProxy)) : this.httpAgent;
    this.parseNoProxy();
  }
  dispatch(options, handler) {
    const url = new URL(String(options.origin));
    return this.getAgent(url).dispatch(options, handler);
  }
  async close() {
    await Promise.all([...this.agents()].map((agent) => agent.close()));
  }
  async destroy(error) {
    await Promise.all(
      [...this.agents()].map((agent) => agent.destroy(error || null))
    );
  }
  agents() {
    return /* @__PURE__ */ new Set([this.directAgent, this.httpAgent, this.httpsAgent]);
  }
  getAgent(url) {
    if (this.noProxyValue !== (getEnv("no_proxy") || "")) {
      this.parseNoProxy();
    }
    const hostname = url.hostname.toLowerCase();
    const port = Number.parseInt(url.port, 10) || DEFAULT_PORTS[url.protocol];
    if (!this.shouldProxy(hostname, port)) {
      return this.directAgent;
    }
    return url.protocol === "https:" ? this.httpsAgent : this.httpAgent;
  }
  shouldProxy(hostname, port) {
    if (this.noProxyEntries.length === 0) {
      return true;
    }
    if (this.noProxyValue === "*") {
      return false;
    }
    for (const entry of this.noProxyEntries) {
      if (entry.port && entry.port !== port) {
        continue;
      }
      if (!entry.hostname.startsWith(".") && !entry.hostname.startsWith("*")) {
        if (hostname === entry.hostname) {
          return false;
        }
      } else if (hostname.endsWith(entry.hostname.replace(/^\*/, ""))) {
        return false;
      }
    }
    return true;
  }
  parseNoProxy() {
    this.noProxyValue = getEnv("no_proxy") || "";
    this.noProxyEntries = this.noProxyValue.toLowerCase().split(/[,\s]/).filter(Boolean).map((value) => {
      const parsed = value.match(/^(.+):(\d+)$/);
      return {
        hostname: parsed ? parsed[1] : value,
        port: parsed ? Number.parseInt(parsed[2], 10) : 0
      };
    });
  }
};
export {
  EnvProxyDispatcher
};
