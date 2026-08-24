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
var ruby_diagnostics_exports = {};
__export(ruby_diagnostics_exports, {
  generateRubyProjectManifest: () => generateRubyProjectManifest,
  parseGemfileLock: () => parseGemfileLock
});
module.exports = __toCommonJS(ruby_diagnostics_exports);
var import_fs = __toESM(require("fs"));
var import_package_manifest = require("./package-manifest");
const GEM_SPEC_PATTERN = /^(\S+) \(([^)]+)\)$/;
const DEPENDENCY_PATTERN = /^([^\s!]+)(!?)(?:\s+\(([^)]+)\))?$/;
var GemSource = /* @__PURE__ */ ((GemSource2) => {
  GemSource2["REGISTRY"] = "registry";
  GemSource2["GIT"] = "git";
  GemSource2["PLUGIN"] = "plugin";
  return GemSource2;
})(GemSource || {});
function parseGemfileLock(content) {
  const gems = /* @__PURE__ */ new Map();
  const pathGems = /* @__PURE__ */ new Set();
  const directGems = /* @__PURE__ */ new Map();
  let Section;
  ((Section2) => {
    Section2["GEM"] = "gem";
    Section2["GIT"] = "git";
    Section2["PATH"] = "path";
    Section2["PLUGIN"] = "plugin";
    Section2["DEPENDENCIES"] = "dependencies";
  })(Section || (Section = {}));
  let SubSection;
  ((SubSection2) => {
    SubSection2["SPECS"] = "specs";
  })(SubSection || (SubSection = {}));
  let section = null;
  let subSection = null;
  let currentRemote = "";
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trimEnd();
    if (!line)
      continue;
    if (!line.startsWith(" ")) {
      currentRemote = "";
      if (line === "GEM")
        section = "gem" /* GEM */;
      else if (line === "GIT")
        section = "git" /* GIT */;
      else if (line === "PATH")
        section = "path" /* PATH */;
      else if (line === "PLUGIN SOURCE")
        section = "plugin" /* PLUGIN */;
      else if (line === "DEPENDENCIES")
        section = "dependencies" /* DEPENDENCIES */;
      else
        section = null;
      subSection = null;
      continue;
    }
    const indent = line.length - line.trimStart().length;
    const text = line.trimStart();
    if (section === "gem" /* GEM */ || section === "git" /* GIT */ || section === "plugin" /* PLUGIN */) {
      if (indent === 2) {
        if (text.startsWith("remote:")) {
          currentRemote = text.slice("remote:".length).trim();
          subSection = null;
        } else if (text === "specs:") {
          subSection = "specs" /* SPECS */;
        }
      } else if (indent === 4 && subSection === "specs" /* SPECS */) {
        const m = text.match(GEM_SPEC_PATTERN);
        if (!m)
          continue;
        const [, name, version] = m;
        let gem;
        if (section === "git" /* GIT */) {
          gem = { version, source: "git" /* GIT */, sourceUrl: currentRemote };
        } else if (section === "plugin" /* PLUGIN */) {
          gem = { version, source: "plugin" /* PLUGIN */, sourceUrl: currentRemote };
        } else {
          let sourceUrl = currentRemote;
          try {
            sourceUrl = new URL(currentRemote).origin;
          } catch {
          }
          gem = { version, source: "registry" /* REGISTRY */, sourceUrl };
        }
        if (gems.has(name)) {
          const existing = gems.get(name);
          const isPlatformVariant = /-[a-zA-Z]/.test(version);
          const existingIsPlatformVariant = /-[a-zA-Z]/.test(existing.version);
          if (isPlatformVariant)
            continue;
          if (existing.source === gem.source && !existingIsPlatformVariant)
            continue;
          if (gem.source !== "registry" /* REGISTRY */)
            continue;
        }
        gems.set(name, gem);
      }
    }
    if (section === "path" /* PATH */) {
      if (indent === 2 && text === "specs:") {
        subSection = "specs" /* SPECS */;
      } else if (indent === 4 && subSection === "specs" /* SPECS */) {
        const m = text.match(GEM_SPEC_PATTERN);
        if (!m)
          continue;
        const [, name] = m;
        pathGems.add(name);
      }
    }
    if (section === "dependencies" /* DEPENDENCIES */) {
      if (indent === 2) {
        const m = text.match(DEPENDENCY_PATTERN);
        if (!m)
          continue;
        const [, name, , version] = m;
        directGems.set(name, version);
      }
    }
  }
  for (const name of pathGems) {
    directGems.delete(name);
  }
  return { gems, directGems };
}
async function generateRubyProjectManifest({
  workPath,
  gemfileLockPath,
  framework,
  serviceType,
  outputRuntime = "ruby"
}) {
  try {
    if (!gemfileLockPath)
      return;
    let content;
    try {
      content = await import_fs.default.promises.readFile(gemfileLockPath, "utf-8");
    } catch {
      return;
    }
    const { gems, directGems } = parseGemfileLock(content);
    const directEntries = [];
    const transitiveEntries = [];
    for (const [name, version] of directGems) {
      const gem = gems.get(name);
      const entry = {
        name,
        type: "direct",
        scopes: ["prod"],
        ...version ? { requested: version } : {},
        resolved: gem?.version ?? ""
      };
      if (gem?.source)
        entry.source = gem.source;
      if (gem?.sourceUrl)
        entry.sourceUrl = gem.sourceUrl;
      directEntries.push(entry);
    }
    for (const [name, gem] of gems) {
      if (directGems.has(name))
        continue;
      const entry = {
        name,
        type: "transitive",
        scopes: ["prod"],
        resolved: gem.version
      };
      if (gem.source)
        entry.source = gem.source;
      if (gem.sourceUrl)
        entry.sourceUrl = gem.sourceUrl;
      transitiveEntries.push(entry);
    }
    const manifest = {
      version: import_package_manifest.MANIFEST_VERSION,
      runtime: "ruby",
      ...framework ? { framework } : {},
      ...serviceType ? { serviceType } : {},
      dependencies: [
        ...directEntries.sort((a, b) => a.name.localeCompare(b.name)),
        ...transitiveEntries.sort((a, b) => a.name.localeCompare(b.name))
      ]
    };
    await (0, import_package_manifest.writeProjectManifest)(manifest, workPath, outputRuntime);
  } catch {
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  generateRubyProjectManifest,
  parseGemfileLock
});
