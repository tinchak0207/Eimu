import { createRequire as __createRequire } from 'node:module';
import { fileURLToPath as __fileURLToPath } from 'node:url';
import { dirname as __dirname_ } from 'node:path';
const require = __createRequire(import.meta.url);
const __filename = __fileURLToPath(import.meta.url);
const __dirname = __dirname_(__filename);
import {
  import_write_build_result,
  require_get_files,
  require_service_schedules,
  require_write_build_result,
  writeBuildResult
} from "../../chunks/chunk-VTP6WIQA.js";
import {
  importBuilders,
  import_import_builders
} from "../../chunks/chunk-D35JUCTC.js";
import {
  js_yaml_default,
  pullCommandLogic
} from "../../chunks/chunk-YPPWGI3F.js";
import {
  require_semver
} from "../../chunks/chunk-IB5L4LKZ.js";
import {
  readProjectSettings
} from "../../chunks/chunk-ZHRZMQGN.js";
import "../../chunks/chunk-R6IGDGX3.js";
import "../../chunks/chunk-HT2XWSAJ.js";
import {
  stamp_default
} from "../../chunks/chunk-64IF634X.js";
import "../../chunks/chunk-VXYGCOKL.js";
import {
  buildCommand
} from "../../chunks/chunk-7PEQVFHI.js";
import {
  help
} from "../../chunks/chunk-XI6NJLI4.js";
import {
  DEFAULT_VERCEL_CONFIG_FILENAME,
  VERCEL_DIR,
  compileVercelConfig,
  detectExplicitScope,
  ensureLink,
  findSourceVercelConfigFile,
  getLinkedProject,
  getProjectLink,
  parseTarget,
  printProjectNotFoundError,
  pullEnvRecords,
  readJSONFile,
  require_ajv,
  require_dist,
  require_dist2,
  require_dist3,
  require_frameworks,
  require_lib,
  require_main,
  require_minimatch,
  resolveProjectCwd,
  ua_default,
  validateConfig
} from "../../chunks/chunk-KDL2L4KL.js";
import {
  TelemetryClient
} from "../../chunks/chunk-CYNB6LL4.js";
import {
  AGENT_REASON,
  AGENT_STATUS,
  outputAgentError
} from "../../chunks/chunk-J5ZEHLFM.js";
import "../../chunks/chunk-GGP5R3FU.js";
import {
  printError,
  toEnumerableError
} from "../../chunks/chunk-VAFU7DXZ.js";
import {
  parseArguments
} from "../../chunks/chunk-XLKFJPMT.js";
import {
  CantParseJSONFile,
  cmd,
  getCommandName,
  getCommandNamePlain,
  getFlagsSpecification,
  getGlobalFlagsFromArgs,
  packageName,
  require_lib as require_lib2
} from "../../chunks/chunk-SOFC4MLS.js";
import {
  pkg_default
} from "../../chunks/chunk-P4QNYOFB.js";
import "../../chunks/chunk-52QYYTM5.js";
import {
  emoji,
  output_manager_default,
  prependEmoji
} from "../../chunks/chunk-OX7KI3LF.js";
import {
  require_source
} from "../../chunks/chunk-S7KYDPEM.js";
import {
  __commonJS,
  __require,
  __toESM
} from "../../chunks/chunk-TZ2YI2VH.js";

// ../../internals/builder-orchestration/dist/sort-builders.js
var require_sort_builders = __commonJS({
  "../../internals/builder-orchestration/dist/sort-builders.js"(exports, module) {
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
    var sort_builders_exports = {};
    __export(sort_builders_exports, {
      sortBuilders: () => sortBuilders
    });
    module.exports = __toCommonJS(sort_builders_exports);
    var import_frameworks = require_frameworks();
    function sortBuilders(builds) {
      const frameworkRuntimeSet = new Set(
        import_frameworks.frameworkList.map((f) => f.useRuntime?.use || "@vercel/static-build")
      );
      frameworkRuntimeSet.delete("@vercel/go");
      frameworkRuntimeSet.delete("@vercel/python");
      frameworkRuntimeSet.delete("@vercel/ruby");
      frameworkRuntimeSet.delete("@vercel/rust");
      const toNumber = (build) => build.use === "@vercel/go" || build.use === "@vercel/python" || build.use === "@vercel/ruby" || build.use === "@vercel/rust" ? 1 : frameworkRuntimeSet.has(build.use) ? 0 : 2;
      return builds.sort((build1, build2) => {
        return toNumber(build1) - toNumber(build2);
      });
    }
  }
});

// ../../internals/cli-builder-integration/dist/execute-builder.js
var require_execute_builder = __commonJS({
  "../../internals/cli-builder-integration/dist/execute-builder.js"(exports, module) {
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
    var execute_builder_exports = {};
    __export(execute_builder_exports, {
      executeBuilder: () => executeBuilder2,
      sortBuildsForExecution: () => sortBuildsForExecution2
    });
    module.exports = __toCommonJS(execute_builder_exports);
    var import_sort_builders = require_sort_builders();
    async function executeBuilder2({
      builder,
      buildOptions,
      span,
      isFrontendBuilder,
      hasDetectedServices,
      framework
    }) {
      const rawBuildResult = await span.trace(() => builder.build(buildOptions));
      const buildResult = builder.version === -1 ? rawBuildResult.result : rawBuildResult;
      if (!hasDetectedServices && buildOptions.config.zeroConfig && isFrontendBuilder && "output" in buildResult && !buildResult.routes && framework) {
        buildResult.routes = await getFrameworkRoutes(
          framework,
          buildOptions.workPath
        );
      }
      return { buildResult, rawBuildResult };
    }
    var sortBuildsForExecution2 = import_sort_builders.sortBuilders;
    async function getFrameworkRoutes(framework, dirPrefix) {
      if (typeof framework.defaultRoutes === "function") {
        return framework.defaultRoutes(dirPrefix);
      }
      return Array.isArray(framework.defaultRoutes) ? framework.defaultRoutes : [];
    }
  }
});

// ../../internals/cli-builder-integration/dist/backend-rewrite-warning.js
var require_backend_rewrite_warning = __commonJS({
  "../../internals/cli-builder-integration/dist/backend-rewrite-warning.js"(exports, module) {
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
    var backend_rewrite_warning_exports = {};
    __export(backend_rewrite_warning_exports, {
      BACKEND_REWRITE_BEHAVIOR_WARNING: () => BACKEND_REWRITE_BEHAVIOR_WARNING,
      hasBackendRewriteBehaviorChange: () => hasBackendRewriteBehaviorChange
    });
    module.exports = __toCommonJS(backend_rewrite_warning_exports);
    var import_build_utils2 = __require("@vercel/build-utils");
    var BACKEND_REWRITE_BEHAVIOR_WARNING = "Internal rewrites in backend framework projects now route requests using the rewritten destination path. This behavior was previously unsupported and may change which application route handles a request. Review your rewrite configuration to ensure this behavior is expected.";
    function hasInternalPathRewrite(rewrites) {
      return rewrites?.some(
        (rewrite) => typeof rewrite.destination === "string" && rewrite.destination.startsWith("/")
      ) ?? false;
    }
    function isAffectedFramework(framework) {
      return framework === "go" || framework === "container" || (0, import_build_utils2.isPythonFramework)(framework);
    }
    function hasBackendRewriteBehaviorChange({
      projectRewrites,
      builders
    }) {
      return hasInternalPathRewrite(projectRewrites) && (builders ?? []).some(
        (builder) => isAffectedFramework(builder.config?.framework)
      );
    }
  }
});

// ../../internals/cli-builder-integration/dist/service-route-ownership.js
var require_service_route_ownership = __commonJS({
  "../../internals/cli-builder-integration/dist/service-route-ownership.js"(exports, module) {
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
    var service_route_ownership_exports = {};
    __export(service_route_ownership_exports, {
      scopeRoutesToServiceOwnership: () => scopeRoutesToServiceOwnership
    });
    module.exports = __toCommonJS(service_route_ownership_exports);
    var import_routing_utils = require_dist2();
    function isWebServiceWithPrefix(service) {
      return service.type === "web" && typeof service.routePrefix === "string";
    }
    function getWebRoutePrefixes(services) {
      const unique = /* @__PURE__ */ new Set();
      for (const service of services) {
        if (!isWebServiceWithPrefix(service))
          continue;
        unique.add((0, import_routing_utils.normalizeRoutePrefix)(service.routePrefix));
      }
      return Array.from(unique);
    }
    function scopeRoutesToServiceOwnership({
      routes,
      owner,
      allServices
    }) {
      if (!isWebServiceWithPrefix(owner)) {
        return routes;
      }
      const allWebPrefixes = getWebRoutePrefixes(allServices);
      const ownershipGuard = (0, import_routing_utils.getOwnershipGuard)(owner.routePrefix, allWebPrefixes);
      if (!ownershipGuard) {
        return routes;
      }
      return routes.map((route) => {
        if ("handle" in route || typeof route.src !== "string") {
          return route;
        }
        return {
          ...route,
          src: (0, import_routing_utils.scopeRouteSourceToOwnership)(route.src, ownershipGuard)
        };
      });
    }
  }
});

// ../../internals/cli-builder-integration/dist/validate-cron-secret.js
var require_validate_cron_secret = __commonJS({
  "../../internals/cli-builder-integration/dist/validate-cron-secret.js"(exports, module) {
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
    var validate_cron_secret_exports = {};
    __export(validate_cron_secret_exports, {
      validateCronSecret: () => validateCronSecret
    });
    module.exports = __toCommonJS(validate_cron_secret_exports);
    var import_build_utils2 = __require("@vercel/build-utils");
    function validateCronSecret(cronSecret) {
      if (!cronSecret) {
        return null;
      }
      if (cronSecret !== cronSecret.trim()) {
        return new import_build_utils2.NowBuildError({
          code: "INVALID_CRON_SECRET",
          message: "The `CRON_SECRET` environment variable contains leading or trailing whitespace, which is not allowed in HTTP header values.",
          link: "https://vercel.link/securing-cron-jobs",
          action: "Learn More"
        });
      }
      const invalidChars = [];
      for (let i = 0; i < cronSecret.length; i++) {
        const code = cronSecret.charCodeAt(i);
        const isValidChar = code === 9 || // HTAB
        code >= 32 && code <= 126;
        if (!isValidChar) {
          invalidChars.push({
            char: cronSecret[i],
            index: i,
            code
          });
        }
      }
      if (invalidChars.length > 0) {
        const descriptions = invalidChars.slice(0, 3).map(({ code, index }) => {
          if (code < 32) {
            return `control character (0x${code.toString(16).padStart(2, "0")}) at position ${index}`;
          } else if (code === 127) {
            return `DEL character at position ${index}`;
          } else {
            return `non-ASCII character (0x${code.toString(16).padStart(2, "0")}) at position ${index}`;
          }
        });
        const moreCount = invalidChars.length - 3;
        const moreText = moreCount > 0 ? `, and ${moreCount} more` : "";
        return new import_build_utils2.NowBuildError({
          code: "INVALID_CRON_SECRET",
          message: `The \`CRON_SECRET\` environment variable contains characters that are not valid in HTTP headers: ${descriptions.join(", ")}${moreText}. Only visible ASCII characters (letters, digits, symbols), spaces, and tabs are allowed.`,
          link: "https://vercel.link/securing-cron-jobs",
          action: "Learn More"
        });
      }
      return null;
    }
  }
});

// ../../internals/cli-builder-integration/dist/validate-package-manifest.js
var require_validate_package_manifest = __commonJS({
  "../../internals/cli-builder-integration/dist/validate-package-manifest.js"(exports, module) {
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
    var __toESM2 = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
      // If the importer is in node compatibility mode or this is not an ESM
      // file that has been converted to a CommonJS file using a Babel-
      // compatible transform (i.e. "__esModule" has not been set), then set
      // "default" to the CommonJS "module.exports" for node compatibility.
      isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
      mod
    ));
    var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
    var validate_package_manifest_exports = {};
    __export(validate_package_manifest_exports, {
      validatePackageManifest: () => validatePackageManifest
    });
    module.exports = __toCommonJS(validate_package_manifest_exports);
    var import_ajv = __toESM2(require_ajv());
    var import_build_utils2 = __require("@vercel/build-utils");
    var ajv = new import_ajv.default();
    var validate = ajv.compile(import_build_utils2.packageManifestSchema);
    function validatePackageManifest(data) {
      if (validate(data)) {
        return null;
      }
      const errors = validate.errors ?? [];
      return errors.map((e) => `${e.dataPath || "(root)"} ${e.message}`).join("; ");
    }
  }
});

// ../../internals/cli-builder-integration/dist/manifest.js
var require_manifest = __commonJS({
  "../../internals/cli-builder-integration/dist/manifest.js"(exports, module) {
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
    var manifest_exports = {};
    __export(manifest_exports, {
      writeManifests: () => writeManifests
    });
    module.exports = __toCommonJS(manifest_exports);
    var import_path2 = __require("path");
    var import_build_utils2 = __require("@vercel/build-utils");
    async function writeManifests(packageManifests, diagnostics, ops, outputDir) {
      if (packageManifests.length === 0)
        return;
      const projectManifest = {};
      const deployManifestBuilds = {};
      const deployManifestServices = {};
      for (const {
        workspace,
        buildConfig,
        manifest,
        service,
        builderUse
      } of packageManifests) {
        const key = `${builderUse}:${workspace}`;
        const framework = service?.framework ?? buildConfig.framework ?? manifest.framework;
        projectManifest[key] = {
          ...manifest,
          workspace,
          builder: builderUse,
          framework,
          serviceName: service?.name,
          serviceType: service && (0, import_build_utils2.isExperimentalService)(service) ? service.type : void 0,
          routePrefix: service && (0, import_build_utils2.isExperimentalService)(service) ? service.routePrefix : void 0
        };
        const { version: _version, ...manifestWithoutVersion } = manifest;
        deployManifestBuilds[key] = {
          ...manifestWithoutVersion,
          framework,
          root: workspace,
          builder: builderUse
        };
        if (service) {
          const existing = deployManifestServices[service.name];
          if (existing) {
            existing.builds.push(key);
          } else {
            deployManifestServices[service.name] = {
              builds: [key],
              bindings: (0, import_build_utils2.isExperimentalServiceV2)(service) ? service.bindings : void 0
            };
          }
        }
      }
      if (Object.keys(projectManifest).length === 0)
        return;
      const projectManifestBlob = new import_build_utils2.FileBlob({
        data: JSON.stringify(projectManifest)
      });
      diagnostics["project-manifest.json"] = projectManifestBlob;
      ops.push(
        (0, import_build_utils2.downloadFile)(
          projectManifestBlob,
          (0, import_path2.join)(outputDir, "diagnostics", "project-manifest.json")
        ).then(
          () => void 0,
          (err) => err
        )
      );
      const deployManifestBlob = new import_build_utils2.FileBlob({
        data: JSON.stringify({
          manifestVersion: "2.0",
          builds: deployManifestBuilds,
          services: deployManifestServices
        })
      });
      diagnostics["deploy-manifest.json"] = deployManifestBlob;
      ops.push(
        (0, import_build_utils2.downloadFile)(
          deployManifestBlob,
          (0, import_path2.join)(outputDir, "diagnostics", "deploy-manifest.json")
        ).then(
          () => void 0,
          (err) => err
        )
      );
    }
  }
});

// ../../internals/cli-builder-integration/dist/build-embedding.js
var require_build_embedding = __commonJS({
  "../../internals/cli-builder-integration/dist/build-embedding.js"(exports, module) {
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
    var build_embedding_exports = {};
    __export(build_embedding_exports, {
      shouldEmbedFlagsDefinitions: () => shouldEmbedFlagsDefinitions
    });
    module.exports = __toCommonJS(build_embedding_exports);
    var import_build_utils2 = __require("@vercel/build-utils");
    function isFlagsEmbedOption(input) {
      return input === "force-on" || input === "force-off";
    }
    var SDK_KEY_REGEX = /^vf_(?:server|client)_/;
    function envHasSdkKey() {
      for (const value of Object.values(process.env)) {
        if (typeof value === "string" && SDK_KEY_REGEX.test(value)) {
          return true;
        }
      }
    }
    async function shouldEmbedFlagsDefinitions(cwd) {
      if (process.env.VERCEL_FLAGS_DISABLE_DEFINITION_EMBEDDING === "1") {
        return false;
      }
      if (isFlagsEmbedOption(process.env.VERCEL_FLAGS_EMBED_DEFINITIONS)) {
        return process.env.VERCEL_FLAGS_EMBED_DEFINITIONS === "force-on";
      }
      if (envHasSdkKey()) {
        return true;
      }
      const hasVercelFlags = await (0, import_build_utils2.isPackageInstalled)("@flags-sdk/vercel", cwd);
      const hasFlagsCore = await (0, import_build_utils2.isPackageInstalled)("@vercel/flags-core", cwd);
      if (hasVercelFlags || hasFlagsCore) {
        return true;
      }
      return false;
    }
  }
});

// ../../internals/cli-builder-integration/dist/validate-build-output.js
var require_validate_build_output = __commonJS({
  "../../internals/cli-builder-integration/dist/validate-build-output.js"(exports, module) {
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
    var __toESM2 = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
      // If the importer is in node compatibility mode or this is not an ESM
      // file that has been converted to a CommonJS file using a Babel-
      // compatible transform (i.e. "__esModule" has not been set), then set
      // "default" to the CommonJS "module.exports" for node compatibility.
      isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
      mod
    ));
    var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
    var validate_build_output_exports = {};
    __export(validate_build_output_exports, {
      reportBuildOutputProblems: () => reportBuildOutputProblems,
      validateBuildOutput: () => validateBuildOutput
    });
    module.exports = __toCommonJS(validate_build_output_exports);
    var import_fs_extra2 = __toESM2(require_lib());
    var import_path2 = __require("path");
    var import_build_utils2 = __require("@vercel/build-utils");
    function logDebug(message, output) {
      output?.debug(message);
      (0, import_build_utils2.debug)(message);
    }
    async function validateBuildOutput(outputDir, output) {
      const problems = [];
      logDebug(`Validating build output at "${outputDir}"`, output);
      try {
        const configPath = (0, import_path2.join)(outputDir, "config.json");
        const configExists = await import_fs_extra2.default.pathExists(configPath);
        if (!configExists) {
          problems.push({
            severity: "error",
            message: "Build output is missing config.json."
          });
        } else {
          let config;
          try {
            config = await import_fs_extra2.default.readJSON(configPath);
          } catch (err) {
            problems.push({
              severity: "error",
              message: `Build output config.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}.`
            });
          }
          if (config && config.version !== 3) {
            problems.push({
              severity: "warning",
              message: `Build output config.json has unexpected version "${config.version}" (expected 3).`
            });
          }
        }
        const [hasFunctions, hasStatic] = await Promise.all([
          import_fs_extra2.default.pathExists((0, import_path2.join)(outputDir, "functions")),
          import_fs_extra2.default.pathExists((0, import_path2.join)(outputDir, "static"))
        ]);
        if (!hasFunctions && !hasStatic) {
          problems.push({
            severity: "warning",
            message: 'Build output contains no "functions" or "static" directory; the build may not have produced any deployable output.'
          });
        }
        logDebug(
          `Build output validation found ${problems.length} problem(s)` + (problems.length ? `: ${problems.map((p) => `${p.severity}: ${p.message}`).join("; ")}` : ""),
          output
        );
        return problems;
      } catch (err) {
        return [
          {
            severity: "error",
            message: `Unexpected error while validating build output: ${err instanceof Error ? err.message : String(err)}.`
          }
        ];
      }
    }
    function reportBuildOutputProblems(problems, output) {
      for (const problem of problems) {
        if (problem.severity === "error") {
          output.error(problem.message);
        } else {
          output.warn(problem.message);
        }
      }
    }
  }
});

// ../../internals/cli-builder-integration/dist/framework-detection.js
var require_framework_detection = __commonJS({
  "../../internals/cli-builder-integration/dist/framework-detection.js"(exports, module) {
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
    var framework_detection_exports = {};
    __export(framework_detection_exports, {
      detectAllFrameworks: () => detectAllFrameworks,
      detectFirstDeploymentFramework: () => detectFirstDeploymentFramework,
      isFirstDeployment: () => isFirstDeployment,
      isFrameworkDetectionEnabled: () => isFrameworkDetectionEnabled,
      warnIfFrameworkMismatch: () => warnIfFrameworkMismatch
    });
    module.exports = __toCommonJS(framework_detection_exports);
    var import_fs_detectors = require_dist3();
    var import_frameworks = require_frameworks();
    var import_build_utils2 = __require("@vercel/build-utils");
    function logDebug(message, output) {
      output?.debug(message);
      (0, import_build_utils2.debug)(message);
    }
    function isFrameworkDetectionEnabled(output) {
      const raw = process.env.VERCEL_FRAMEWORK_DETECTION;
      const enabled = raw === "1";
      logDebug(
        `Framework detection: VERCEL_FRAMEWORK_DETECTION=${raw === void 0 ? "<unset>" : JSON.stringify(raw)} -> ${enabled ? "enabled" : "disabled"}`,
        output
      );
      return enabled;
    }
    function isFirstDeployment(output) {
      const raw = process.env.VERCEL_FIRST_DEPLOYMENT;
      const result = raw === "1";
      logDebug(
        `isFirstDeployment: VERCEL_FIRST_DEPLOYMENT=${raw === void 0 ? "<unset>" : JSON.stringify(raw)} -> ${result}`,
        output
      );
      return result;
    }
    async function detectFirstDeploymentFramework(options) {
      const { workPath, projectSettings, output } = options;
      logDebug(
        `First deployment: evaluating framework detection (workPath="${workPath}", configuredFramework=${projectSettings.framework ? `"${projectSettings.framework}"` : "<none>"})`,
        output
      );
      if (!isFirstDeployment(output)) {
        logDebug(
          "First deployment: skipping framework detection because this is not a first deployment",
          output
        );
        return { status: "skipped" };
      }
      if (projectSettings.framework) {
        logDebug(
          `First deployment: skipping framework detection because a framework is already configured ("${projectSettings.framework}")`,
          output
        );
        return { status: "skipped" };
      }
      logDebug(
        `First deployment: no framework configured; detecting from source at "${workPath}"`,
        output
      );
      const detected = await (0, import_fs_detectors.detectFrameworkRecord)({
        fs: new import_fs_detectors.LocalFileSystemDetector(workPath),
        frameworkList: import_frameworks.frameworkList
      });
      if (!detected || !detected.slug) {
        logDebug(
          "First deployment: no framework detected from source code",
          output
        );
        return { status: "not-detected" };
      }
      const { slug } = detected;
      projectSettings.framework = slug;
      logDebug(
        `First deployment: detected framework "${slug}"${detected.detectedVersion ? ` (version ${detected.detectedVersion})` : ""}; applied to project settings for this build`,
        output
      );
      return {
        status: "detected",
        slug,
        ...detected.detectedVersion && { version: detected.detectedVersion }
      };
    }
    async function detectAllFrameworks(workPath, customFrameworkList, output) {
      logDebug(
        `Framework cross-check: detecting frameworks at "${workPath}"`,
        output
      );
      const frameworks = await (0, import_fs_detectors.detectFrameworks)({
        fs: new import_fs_detectors.LocalFileSystemDetector(workPath),
        frameworkList: customFrameworkList ?? import_frameworks.frameworkList
      });
      const slugs = frameworks.map((f) => f.slug).filter((slug) => Boolean(slug));
      logDebug(
        `Framework cross-check: detected [${slugs.join(", ") || "<none>"}]`,
        output
      );
      return slugs;
    }
    function isHighConfidenceDetection(slug) {
      const record = import_frameworks.frameworkList.find((f) => f.slug === slug);
      return record?.detectionConfidence !== "weak";
    }
    function warnIfFrameworkMismatch(options, output) {
      const {
        configuredFramework,
        detectedFrameworks,
        usedBuilders = [],
        usedFrameworks = []
      } = options;
      if (detectedFrameworks.length === 0) {
        logDebug(
          "Framework cross-check: nothing detected from source; skipping validation",
          output
        );
        return "none-detected";
      }
      const confidentFrameworks = detectedFrameworks.filter(
        isHighConfidenceDetection
      );
      if (configuredFramework) {
        if (detectedFrameworks.includes(configuredFramework)) {
          logDebug(
            `Framework cross-check: configured framework "${configuredFramework}" matches detected frameworks; no mismatch`,
            output
          );
          return "match";
        }
        if (confidentFrameworks.length === 0) {
          logDebug(
            `Framework cross-check: configured framework "${configuredFramework}" not among detected [${detectedFrameworks.join(
              ", "
            )}], but all detections are low-confidence; skipping warning`,
            output
          );
          return "low-confidence";
        }
        logDebug(
          `Framework cross-check: configured framework "${configuredFramework}" not among detected [${confidentFrameworks.join(
            ", "
          )}]; warning`,
          output
        );
        output?.warn(
          `Your project is configured to use the "${configuredFramework}" framework, but the source code looks like it's for: ${confidentFrameworks.join(
            ", "
          )}. This may be a misconfiguration.`,
          null,
          "https://vercel.com/docs/project-configuration",
          "Learn More"
        );
        return "configured-mismatch";
      }
      const buildUsedDetectedFramework = detectedFrameworks.some((slug) => {
        if (usedFrameworks.includes(slug)) {
          return true;
        }
        const record = import_frameworks.frameworkList.find((f) => f.slug === slug);
        const expectedBuilder = record?.useRuntime?.use;
        if (!expectedBuilder) {
          return false;
        }
        return usedBuilders.some(
          (use) => use === expectedBuilder || use.startsWith(`${expectedBuilder}@`)
        );
      });
      if (buildUsedDetectedFramework) {
        logDebug(
          `Framework cross-check: no framework configured, but the build used one of the detected frameworks [${detectedFrameworks.join(
            ", "
          )}]; no mismatch`,
          output
        );
        return "match";
      }
      const warnableFrameworks = confidentFrameworks.filter((slug) => {
        const record = import_frameworks.frameworkList.find((f) => f.slug === slug);
        return Boolean(record?.useRuntime?.use);
      });
      if (warnableFrameworks.length === 0) {
        logDebug(
          `Framework cross-check: no framework configured and detections [${detectedFrameworks.join(
            ", "
          )}] are low-confidence or have no dedicated runtime builder; skipping warning`,
          output
        );
        return "low-confidence";
      }
      logDebug(
        `Framework cross-check: no framework configured and the build did not use any of the detected frameworks [${warnableFrameworks.join(
          ", "
        )}] (used builders: [${usedBuilders.join(", ") || "<none>"}]); warning`,
        output
      );
      output?.warn(
        `The source code looks like it's for: ${warnableFrameworks.join(
          ", "
        )}, but no framework is configured for this project and the build did not use ${warnableFrameworks.length === 1 ? "its builder" : "their builders"}. Set the framework in your Project Settings if this is unexpected.`,
        null,
        "https://vercel.com/docs/project-configuration",
        "Learn More"
      );
      return "unused-mismatch";
    }
  }
});

// ../../internals/cli-builder-integration/dist/monorepo.js
var require_monorepo = __commonJS({
  "../../internals/cli-builder-integration/dist/monorepo.js"(exports, module) {
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
    var __toESM2 = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
      // If the importer is in node compatibility mode or this is not an ESM
      // file that has been converted to a CommonJS file using a Babel-
      // compatible transform (i.e. "__esModule" has not been set), then set
      // "default" to the CommonJS "module.exports" for node compatibility.
      isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
      mod
    ));
    var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
    var monorepo_exports = {};
    __export(monorepo_exports, {
      setMonorepoDefaultSettings: () => setMonorepoDefaultSettings
    });
    module.exports = __toCommonJS(monorepo_exports);
    var import_path2 = __require("path");
    var import_fs_detectors = require_dist3();
    var import_title = __toESM2(require_lib2());
    var import_build_utils2 = __require("@vercel/build-utils");
    async function setMonorepoDefaultSettings(cwd, workPath, projectSettings, output) {
      const localFileSystem = new import_fs_detectors.LocalFileSystemDetector(cwd);
      const projectName = (0, import_path2.basename)(workPath);
      const relativeToRoot = (0, import_path2.relative)(workPath, cwd);
      const setCommand = (command, value) => {
        if (projectSettings[command]) {
          (0, import_build_utils2.debug)(
            `Skipping auto-assignment of ${command} as it is already set via project settings or configuration overrides.`
          );
        } else {
          projectSettings[command] = value;
        }
      };
      try {
        const result = await (0, import_fs_detectors.getMonorepoDefaultSettings)(
          projectName,
          (0, import_path2.relative)(cwd, workPath),
          relativeToRoot,
          localFileSystem
        );
        if (result === null) {
          return;
        }
        projectSettings.monorepoManager = result.monorepoManager;
        const { monorepoManager, ...commands } = result;
        output.log(
          `Detected ${(0, import_title.default)(monorepoManager)}. Adjusting default settings...`
        );
        if (commands.buildCommand) {
          setCommand("buildCommand", commands.buildCommand);
        }
        if (commands.installCommand) {
          setCommand("installCommand", commands.installCommand);
        }
        if (commands.commandForIgnoringBuildStep) {
          setCommand(
            "commandForIgnoringBuildStep",
            commands.commandForIgnoringBuildStep
          );
        }
      } catch (error) {
        if (error instanceof import_fs_detectors.MissingBuildPipeline || error instanceof import_fs_detectors.MissingBuildTarget) {
          output.warn(`${error.message} Skipping automatic setting assignment.`);
          return;
        }
        throw error;
      }
    }
  }
});

// ../../internals/cli-builder-integration/dist/corepack.js
var require_corepack = __commonJS({
  "../../internals/cli-builder-integration/dist/corepack.js"(exports, module) {
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
    var __toESM2 = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
      // If the importer is in node compatibility mode or this is not an ESM
      // file that has been converted to a CommonJS file using a Babel-
      // compatible transform (i.e. "__esModule" has not been set), then set
      // "default" to the CommonJS "module.exports" for node compatibility.
      isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
      mod
    ));
    var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
    var corepack_exports = {};
    __export(corepack_exports, {
      cleanupCorepack: () => cleanupCorepack,
      initCorepack: () => initCorepack
    });
    module.exports = __toCommonJS(corepack_exports);
    var import_path2 = __require("path");
    var import_build_utils2 = __require("@vercel/build-utils");
    var import_fs_extra2 = __toESM2(require_lib());
    async function initCorepack({
      repoRootPath,
      output,
      readJSONFile: readJSONFile2,
      isCantParseJSONFile
    }) {
      if (process.env.ENABLE_EXPERIMENTAL_COREPACK !== "1") {
        return null;
      }
      const pkg = await readJSONFile2(
        (0, import_path2.join)(repoRootPath, "package.json")
      );
      if (isCantParseJSONFile(pkg)) {
        output.warn(
          "Warning: Could not enable corepack because package.json is invalid JSON",
          pkg.meta?.parseErrorLocation ?? pkg.message
        );
      } else if (!pkg?.packageManager) {
        output.warn(
          'Warning: Could not enable corepack because package.json is missing "packageManager" property'
        );
      } else {
        output.log(
          `Detected ENABLE_EXPERIMENTAL_COREPACK=1 and "${pkg.packageManager}" in package.json`
        );
        const corepackRootDir = (0, import_path2.join)(repoRootPath, ".vercel", "cache", "corepack");
        const corepackHomeDir = (0, import_path2.join)(corepackRootDir, "home");
        const corepackShimDir = (0, import_path2.join)(corepackRootDir, "shim");
        await import_fs_extra2.default.mkdirp(corepackHomeDir);
        await import_fs_extra2.default.mkdirp(corepackShimDir);
        process.env.COREPACK_HOME = corepackHomeDir;
        process.env.PATH = `${corepackShimDir}${import_path2.delimiter}${process.env.PATH}`;
        const pkgManagerName = pkg.packageManager.split("@")[0];
        await (0, import_build_utils2.spawnAsync)(
          "corepack",
          ["enable", pkgManagerName, "--install-directory", corepackShimDir],
          {
            prettyCommand: `corepack enable ${pkgManagerName}`
          }
        );
        return corepackShimDir;
      }
      return null;
    }
    function cleanupCorepack(corepackShimDir) {
      if (process.env.COREPACK_HOME) {
        delete process.env.COREPACK_HOME;
      }
      if (process.env.PATH) {
        process.env.PATH = process.env.PATH.replace(
          `${corepackShimDir}${import_path2.delimiter}`,
          ""
        );
      }
    }
  }
});

// ../../internals/cli-builder-integration/dist/do-build.js
var require_do_build = __commonJS({
  "../../internals/cli-builder-integration/dist/do-build.js"(exports, module) {
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
    var __toESM2 = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
      // If the importer is in node compatibility mode or this is not an ESM
      // file that has been converted to a CommonJS file using a Babel-
      // compatible transform (i.e. "__esModule" has not been set), then set
      // "default" to the CommonJS "module.exports" for node compatibility.
      isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
      mod
    ));
    var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
    var do_build_exports = {};
    __export(do_build_exports, {
      doBuild: () => doBuild3
    });
    module.exports = __toCommonJS(do_build_exports);
    var import_fs_extra2 = __toESM2(require_lib());
    var import_minimatch2 = __toESM2(require_minimatch());
    var import_path2 = __require("path");
    var import_semver = __toESM2(require_semver());
    var import_build_utils2 = __require("@vercel/build-utils");
    var import_client = require_dist();
    var import_frameworks = require_frameworks();
    var import_fs_detectors = require_dist3();
    var import_routing_utils = require_dist2();
    var import_write_build_result3 = require_write_build_result();
    var import_execute_builder = require_execute_builder();
    var import_backend_rewrite_warning = require_backend_rewrite_warning();
    var import_service_route_ownership = require_service_route_ownership();
    var import_service_schedules = require_service_schedules();
    var import_validate_cron_secret = require_validate_cron_secret();
    var import_validate_package_manifest = require_validate_package_manifest();
    var import_manifest = require_manifest();
    var import_build_embedding = require_build_embedding();
    var import_get_files = require_get_files();
    var import_validate_build_output = require_validate_build_output();
    var import_framework_detection = require_framework_detection();
    var import_monorepo = require_monorepo();
    var import_corepack = require_corepack();
    function pickOverrides(config) {
      const overrides = {};
      for (const property of [
        "buildCommand",
        "devCommand",
        "framework",
        "ignoreCommand",
        "installCommand",
        "outputDirectory"
      ]) {
        if (config[property] !== void 0) {
          overrides[property === "ignoreCommand" ? "commandForIgnoringBuildStep" : property] = config[property];
        }
      }
      return overrides;
    }
    var SERVICE_BUILD_IMMUTABLE_ENV_VARS = [
      "VERCEL_IMMUTABLE_STATIC_FILES_ENABLED"
    ];
    function hasNonEmptyObject(value) {
      return value != null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length > 0;
    }
    function unsetServiceBuildImmutableEnvVars(restoreEnv) {
      for (const key of SERVICE_BUILD_IMMUTABLE_ENV_VARS) {
        if (!restoreEnv.has(key))
          restoreEnv.set(key, process.env[key]);
        delete process.env[key];
      }
    }
    function getGeneratedServiceAlreadyBuiltWarning(service) {
      const framework = service.framework ?? "unknown";
      const entrypoint = service.entrypoint ?? service.builder.src ?? "unknown";
      return `Detected already-built service "${service.name}" from lazily generated \`.vercel/output/config.json\` (framework: ${framework}, entrypoint: ${entrypoint}). It will not be treated as a service because its build output already exists at the top level. Configure it in \`vercel.json\` as a \`services\` entry to remove this warning.`;
    }
    async function doBuild3(request, dependencies) {
      const {
        project,
        buildsJson,
        cwd,
        outputDir,
        span,
        standalone = false,
        localConfigPath,
        cliVersion,
        userAgent
      } = request;
      const {
        output,
        importBuilders: importBuilders2,
        formatResolvedBuilders: formatResolvedBuilders2,
        writeBuildResult: writeBuildResult2,
        toEnumerableError: toEnumerableError2,
        readJSONFile: readJSONFile2,
        isCantParseJSONFile,
        validateConfig: validateConfig2,
        compileVercelConfig: compileVercelConfig2,
        findSourceVercelConfigFile: findSourceVercelConfigFile2,
        defaultVercelConfigFilename,
        startBuildTiming
      } = dependencies;
      const VALID_DEPLOYMENT_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
      const workPath = (0, import_path2.join)(cwd, project.settings.rootDirectory || ".");
      const repoRootPath = cwd;
      const sourceConfigFile = await findSourceVercelConfigFile2(workPath);
      let corepackShimDir;
      if (sourceConfigFile) {
        corepackShimDir = await (0, import_corepack.initCorepack)({
          repoRootPath,
          output,
          readJSONFile: readJSONFile2,
          isCantParseJSONFile
        });
        const installDepsSpan = span.child("vc.installDeps");
        let installRan = false;
        try {
          const installCommand = project.settings.installCommand;
          if (typeof installCommand === "string") {
            if (installCommand.trim()) {
              output.log(`Running install command before config compilation...`);
              installRan = await (0, import_build_utils2.runCustomInstallCommand)({
                destPath: workPath,
                installCommand,
                spawnOpts: { env: process.env },
                projectCreatedAt: project.settings.createdAt
              });
            } else {
              output.debug("Skipping empty install command");
            }
          } else {
            output.log(`Installing dependencies before config compilation...`);
            installRan = await (0, import_build_utils2.runNpmInstall)(
              workPath,
              [],
              { env: process.env },
              void 0,
              project.settings.createdAt
            );
          }
        } finally {
          installDepsSpan.stop();
        }
        if (installRan) {
          const { packageJsonPath } = await (0, import_build_utils2.scanParentDirs)(workPath, false);
          if (packageJsonPath) {
            process.env.VERCEL_INSTALL_COMPLETED_PATH = packageJsonPath;
          }
          process.env.VERCEL_INSTALL_COMPLETED = "1";
        }
      }
      const compileResult = await span.child("vc.compileVercelConfig").trace(() => compileVercelConfig2(workPath));
      const vercelConfigPath = localConfigPath || compileResult.configPath || (0, import_path2.join)(workPath, "vercel.json");
      const [pkg, vercelConfig, hasInstrumentation] = await span.child("vc.readConfigInputs").trace(
        () => Promise.all([
          readJSONFile2((0, import_path2.join)(workPath, "package.json")),
          readJSONFile2(vercelConfigPath),
          (0, import_fs_detectors.detectInstrumentation)(new import_fs_detectors.LocalFileSystemDetector(workPath))
        ])
      );
      if (isCantParseJSONFile(pkg))
        throw pkg;
      if (isCantParseJSONFile(vercelConfig))
        throw vercelConfig;
      if (hasInstrumentation) {
        output.debug(
          "OpenTelemetry instrumentation detected. Automatic fetch instrumentation will be disabled."
        );
        process.env.VERCEL_TRACING_DISABLE_AUTOMATIC_FETCH_INSTRUMENTATION = "1";
      }
      if (vercelConfig) {
        vercelConfig[import_client.fileNameSymbol] = compileResult.wasCompiled ? compileResult.sourceFile || defaultVercelConfigFilename : "vercel.json";
      }
      const localConfig = vercelConfig || {};
      const validateError = validateConfig2(localConfig);
      if (validateError) {
        throw validateError;
      }
      if (localConfig.crons && localConfig.crons.length > 0) {
        const cronSecretError = (0, import_validate_cron_secret.validateCronSecret)(process.env.CRON_SECRET);
        if (cronSecretError) {
          throw cronSecretError;
        }
      }
      const projectSettings = {
        ...project.settings,
        ...pickOverrides(localConfig)
      };
      buildsJson.detectedFramework = await span.child("vc.detectFirstDeploymentFramework", {
        firstDeployment: String(process.env.VERCEL_FIRST_DEPLOYMENT === "1"),
        configuredFramework: projectSettings.framework ?? void 0
      }).trace(async (s) => {
        const result = await (0, import_framework_detection.detectFirstDeploymentFramework)({
          workPath,
          projectSettings,
          output
        });
        s.setAttributes({
          detectionStatus: result.status,
          detectedFramework: result.slug,
          detectedFrameworkVersion: result.version
        });
        return result;
      });
      if (process.env.VERCEL_BUILD_MONOREPO_SUPPORT === "1" && pkg?.scripts?.["vercel-build"] === void 0 && projectSettings.rootDirectory !== null && projectSettings.rootDirectory !== ".") {
        await span.child("vc.setMonorepoDefaultSettings").trace(
          () => (0, import_monorepo.setMonorepoDefaultSettings)(cwd, workPath, projectSettings, output)
        );
      }
      await span.child("vc.prepareFlagsDefinitions").trace(async (s) => {
        const shouldEmbed = await (0, import_build_embedding.shouldEmbedFlagsDefinitions)(cwd);
        s.setAttributes({ shouldEmbed: String(shouldEmbed) });
        if (!shouldEmbed) {
          return;
        }
        const { prepareFlagsDefinitions } = await import("@vercel/prepare-flags-definitions");
        await prepareFlagsDefinitions({
          cwd,
          env: process.env,
          userAgentSuffix: userAgent,
          output
        });
      });
      const files = await span.child("vc.getFiles").trace(async (s) => {
        const result = (await (0, import_get_files.staticFiles)(workPath, {}, output)).map(
          (f) => (0, import_build_utils2.normalizePath)((0, import_path2.relative)(workPath, f))
        );
        s.setAttributes({ fileCount: String(result.length) });
        return result;
      });
      const detectedFrameworksPromise = span.child("vc.detectAllFrameworks", {
        enabled: String((0, import_framework_detection.isFrameworkDetectionEnabled)(output))
      }).trace(async (s) => {
        if (!(0, import_framework_detection.isFrameworkDetectionEnabled)(output)) {
          return [];
        }
        try {
          const slugs = await (0, import_framework_detection.detectAllFrameworks)(workPath, void 0, output);
          s.setAttributes({
            detectedFrameworks: slugs.join(",") || void 0,
            detectedFrameworkCount: String(slugs.length)
          });
          return slugs;
        } catch (err) {
          output.debug(`Framework cross-check detection failed: ${err}`);
          s.setAttributes({
            error: err instanceof Error ? err.message : String(err)
          });
          return [];
        }
      });
      const routesResult = (0, import_routing_utils.getTransformedRoutes)(localConfig);
      if (routesResult.error) {
        throw routesResult.error;
      }
      if (localConfig.builds && localConfig.functions) {
        throw new import_build_utils2.NowBuildError({
          code: "bad_request",
          message: "The `functions` property cannot be used in conjunction with the `builds` property. Please remove one of them.",
          link: "https://vercel.link/functions-and-builds"
        });
      }
      let builds = localConfig.builds || [];
      let zeroConfigRoutes = [];
      let zeroConfigFallbackRoutes = [];
      let detectedServices;
      let detectedResolvedServices;
      let servicesToRecord;
      const hasExperimentalServicesV1ConfiguredInVercelConfig = hasNonEmptyObject(
        localConfig.experimentalServices
      );
      const hasExperimentalServicesV2ConfiguredInVercelConfig = hasNonEmptyObject(
        localConfig.services ?? localConfig.experimentalServicesV2
      );
      const configuredExperimentalServicesV2 = hasExperimentalServicesV2ConfiguredInVercelConfig && (localConfig.services ?? localConfig.experimentalServicesV2) ? localConfig.services ?? localConfig.experimentalServicesV2 : void 0;
      let nestExperimentalServicesV2Output = hasExperimentalServicesV2ConfiguredInVercelConfig;
      let detectedExperimentalServicesV1Config;
      let detectedExperimentalServicesV2Config = configuredExperimentalServicesV2;
      let detectedExperimentalServicesV2RootRoutes;
      let isZeroConfig = false;
      if (builds.length > 0) {
        output.warn(
          "Due to `builds` existing in your configuration file, the Build and Development Settings defined in your Project Settings will not apply. Learn More: https://vercel.link/unused-build-settings"
        );
        builds = builds.flatMap((b) => expandBuild(files, b));
      } else {
        isZeroConfig = true;
        const detectedBuilders = await span.child("vc.detectBuilders").trace(
          () => (0, import_fs_detectors.detectBuilders)(files, pkg, {
            ...localConfig,
            services: void 0,
            experimentalServicesV2: configuredExperimentalServicesV2,
            projectSettings,
            ignoreBuildScript: true,
            featHandleMiss: true,
            workPath
          })
        );
        if (detectedBuilders.errors && detectedBuilders.errors.length > 0) {
          throw detectedBuilders.errors[0];
        }
        for (const w of detectedBuilders.warnings) {
          output.warn(w.message, null, w.link, w.action || "Learn More");
        }
        if (detectedBuilders.builders) {
          builds = detectedBuilders.builders;
        } else {
          builds = [{ src: "**", use: "@vercel/static" }];
        }
        detectedResolvedServices = detectedBuilders.services;
        servicesToRecord = detectedResolvedServices;
        detectedServices = detectedBuilders.services?.filter(import_build_utils2.isExperimentalService);
        const autoDetectedV2Config = detectedBuilders.experimentalServicesV2;
        if (!hasExperimentalServicesV2ConfiguredInVercelConfig && autoDetectedV2Config) {
          nestExperimentalServicesV2Output = true;
          detectedExperimentalServicesV2Config = autoDetectedV2Config;
        }
        if (detectedBuilders.useImplicitEnvInjection && detectedServices && detectedServices.length > 0) {
          const serviceUrlEnvVars = (0, import_build_utils2.getExperimentalServiceUrlEnvVars)({
            services: detectedServices,
            frameworkList: import_frameworks.frameworkList,
            currentEnv: process.env,
            deploymentUrl: process.env.VERCEL_URL
          });
          for (const [key, value] of Object.entries(serviceUrlEnvVars)) {
            process.env[key] = value;
            output.debug(`Injected service URL env var: ${key}=${value}`);
          }
        }
        const serviceRewrites = detectedBuilders.serviceRewrites;
        const serviceRewriteRoutes = serviceRewrites && serviceRewrites.length > 0 ? (0, import_routing_utils.convertRewrites)(serviceRewrites) : null;
        zeroConfigRoutes.push(...detectedBuilders.redirectRoutes || []);
        const detectedHostRewriteRoutes = detectedBuilders.hostRewriteRoutes;
        zeroConfigRoutes = (0, import_routing_utils.appendRoutesToPhase)({
          routes: zeroConfigRoutes,
          newRoutes: detectedHostRewriteRoutes ?? null,
          phase: null
        });
        const detectedServiceRewriteRoutes = nestExperimentalServicesV2Output ? [] : detectedBuilders.rewriteRoutes;
        zeroConfigRoutes.push(
          ...(0, import_routing_utils.appendRoutesToPhase)({
            routes: [],
            newRoutes: [
              ...detectedServiceRewriteRoutes || [],
              ...serviceRewriteRoutes || []
            ],
            phase: "filesystem"
          })
        );
        zeroConfigRoutes = (0, import_routing_utils.appendRoutesToPhase)({
          routes: zeroConfigRoutes,
          newRoutes: detectedBuilders.errorRoutes,
          phase: "error"
        });
        if (!nestExperimentalServicesV2Output) {
          zeroConfigRoutes.push(...detectedBuilders.defaultRoutes || []);
          zeroConfigFallbackRoutes = detectedBuilders.fallbackRoutes || [];
        }
      }
      if ((0, import_backend_rewrite_warning.hasBackendRewriteBehaviorChange)({
        projectRewrites: localConfig.rewrites,
        builders: builds
      })) {
        output.warn(import_backend_rewrite_warning.BACKEND_REWRITE_BEHAVIOR_WARNING);
      }
      const builderSpecs = new Set(builds.map((b) => b.use));
      let buildersWithPkgs = await span.child("vc.importBuilders").trace(async (s) => {
        const builders = await importBuilders2(builderSpecs, cwd, span);
        s.setAttributes({ resolved: formatResolvedBuilders2(builders) });
        return builders;
      });
      const filesMap = await span.child("vc.populateFilesMap").trace(async (s) => {
        const map = {};
        for (const path of files) {
          const fsPath = (0, import_path2.join)(workPath, path);
          const { mode } = await import_fs_extra2.default.stat(fsPath);
          map[path] = new import_build_utils2.FileFsRef({ mode, fsPath });
        }
        s.setAttributes({ fileCount: String(files.length) });
        return map;
      });
      const buildStamp = startBuildTiming();
      await import_fs_extra2.default.mkdirp(outputDir);
      const ops = [];
      const buildsJsonBuilds = /* @__PURE__ */ new Map();
      const ensureBuildersImported = async (buildsToImport) => {
        const missingBuilderSpecs = new Set(
          buildsToImport.map((build) => build.use).filter((builderSpec) => !buildersWithPkgs.has(builderSpec))
        );
        if (missingBuilderSpecs.size === 0)
          return;
        const importedBuilders = await span.child("vc.importBuilders").trace(async (s) => {
          const builders = await importBuilders2(missingBuilderSpecs, cwd, span);
          s.setAttributes({ resolved: formatResolvedBuilders2(builders) });
          return builders;
        });
        buildersWithPkgs = new Map([
          ...buildersWithPkgs.entries(),
          ...importedBuilders.entries()
        ]);
      };
      const addBuildsToBuildJson = async (buildsToAdd) => {
        await ensureBuildersImported(buildsToAdd);
        for (const build of buildsToAdd) {
          if (buildsJsonBuilds.has(build))
            continue;
          const builderWithPkg = buildersWithPkgs.get(build.use);
          if (!builderWithPkg) {
            throw new Error(`Failed to load Builder "${build.use}"`);
          }
          const { builder, pkg: builderPkg } = builderWithPkg;
          buildsJsonBuilds.set(build, {
            require: builderPkg.name,
            requirePath: builderWithPkg.path,
            apiVersion: builder.version,
            ...build
          });
        }
        buildsJson.builds = Array.from(buildsJsonBuilds.values());
        await writeBuildJson(buildsJson, outputDir);
      };
      const meta = {
        skipDownload: true,
        cliVersion
      };
      const executedBuilds = [];
      const buildResults = /* @__PURE__ */ new Map();
      const overrides = [];
      if (!corepackShimDir) {
        corepackShimDir = await (0, import_corepack.initCorepack)({
          repoRootPath,
          output,
          readJSONFile: readJSONFile2,
          isCantParseJSONFile
        });
      }
      const diagnostics = {};
      const packageManifests = [];
      const apiDirFrameworkDetector = createApiDirFrameworkDetector(
        (workPath2, frameworks) => (0, import_framework_detection.detectAllFrameworks)(workPath2, frameworks, output)
      );
      const getHasDetectedServices = () => detectedResolvedServices !== void 0 && detectedResolvedServices.length > 0;
      const synthesizedServiceCrons = [];
      const serviceByBuilder = /* @__PURE__ */ new Map();
      const serviceFileOverrides = /* @__PURE__ */ new Map();
      if (getHasDetectedServices()) {
        for (const service of detectedResolvedServices) {
          serviceByBuilder.set(service.builder, service);
        }
      }
      const preDeployEntries = [];
      const runBuilders = async (buildsToRun) => {
        await addBuildsToBuildJson(buildsToRun);
        for (const build of (0, import_execute_builder.sortBuildsForExecution)(buildsToRun)) {
          if (typeof build.src !== "string")
            continue;
          const builderWithPkg = buildersWithPkgs.get(build.use);
          if (!builderWithPkg) {
            throw new Error(`Failed to load Builder "${build.use}"`);
          }
          try {
            const { builder, pkg: builderPkg } = builderWithPkg;
            const service = getHasDetectedServices() ? serviceByBuilder.get(build) : void 0;
            const legacyExperimentalService = service && (0, import_build_utils2.isExperimentalService)(service) ? service : void 0;
            const serviceWorkspace = service ? (0, import_build_utils2.isExperimentalService)(service) ? service.workspace : service.root : void 0;
            const stripServiceRoutePrefix = !!legacyExperimentalService?.routePrefix && legacyExperimentalService.routePrefix !== "/";
            let buildWorkPath = workPath;
            let buildEntrypoint = build.src;
            let buildFiles = filesMap;
            if (service && serviceWorkspace && serviceWorkspace !== ".") {
              const wsPrefix = serviceWorkspace + "/";
              buildWorkPath = (0, import_path2.join)(workPath, serviceWorkspace);
              buildEntrypoint = build.src.startsWith(wsPrefix) ? build.src.slice(wsPrefix.length) : build.src;
              buildFiles = {};
              for (const [filePath, file] of Object.entries(filesMap)) {
                if (filePath.startsWith(wsPrefix)) {
                  buildFiles[filePath.slice(wsPrefix.length)] = file;
                }
              }
              output.debug(
                `Service "${service.name}": workspace-rooted build at "${buildWorkPath}", entrypoint "${buildEntrypoint}" (original: "${build.src}")`
              );
            }
            const settingsForEnv = service ? {
              buildCommand: service.buildCommand ?? void 0,
              installCommand: service.installCommand ?? void 0,
              outputDirectory: projectSettings.outputDirectory ?? void 0,
              nodeVersion: projectSettings.nodeVersion ?? void 0
            } : projectSettings;
            for (const key of [
              "buildCommand",
              "installCommand",
              "outputDirectory",
              "nodeVersion"
            ]) {
              const value = settingsForEnv[key];
              const envKey = `VERCEL_PROJECT_SETTINGS_` + key.replace(/[A-Z]/g, (letter) => `_${letter}`).toUpperCase();
              if (typeof value === "string") {
                process.env[envKey] = value;
                output.debug(`Setting env ${envKey} to "${value}"`);
              } else {
                delete process.env[envKey];
              }
            }
            const isFrontendBuilder = build.config && "framework" in build.config;
            const builderFramework = build.config?.framework ?? projectSettings.framework;
            const apiDirFramework = isZeroConfig && !service && !isFrontendBuilder ? await apiDirFrameworkDetector.detect(
              build.use ?? "",
              buildWorkPath
            ) : void 0;
            let buildConfig;
            if (isZeroConfig) {
              if (service) {
                buildConfig = {
                  ...build.config,
                  // `service.functions` isn't on `build.config`, so builders that
                  // read `config.functions` (e.g. Next.js) would otherwise miss it;
                  // `serviceName` scopes the derived v2beta consumer.
                  ...(0, import_build_utils2.isExperimentalServiceV2)(service) && service.functions ? { functions: service.functions, serviceName: service.name } : void 0,
                  // Override project-level settings with service-specific ones.
                  // The project-level framework is "services" which must NOT be
                  // propagated to individual builders.
                  projectSettings: {
                    ...projectSettings,
                    framework: service.framework ?? null,
                    buildCommand: service.buildCommand ?? null,
                    installCommand: service.installCommand ?? null
                  },
                  installCommand: service.installCommand ?? void 0,
                  buildCommand: service.buildCommand ?? void 0,
                  preDeployCommand: legacyExperimentalService?.preDeployCommand ?? void 0,
                  framework: builderFramework,
                  nodeVersion: projectSettings.nodeVersion,
                  bunVersion: localConfig.bunVersion ?? void 0
                };
              } else {
                buildConfig = {
                  outputDirectory: projectSettings.outputDirectory ?? void 0,
                  ...build.config,
                  projectSettings,
                  installCommand: projectSettings.installCommand ?? void 0,
                  devCommand: projectSettings.devCommand ?? void 0,
                  buildCommand: projectSettings.buildCommand ?? void 0,
                  framework: isFrontendBuilder ? projectSettings.framework : void 0,
                  nodeVersion: projectSettings.nodeVersion,
                  bunVersion: localConfig.bunVersion ?? void 0
                };
              }
            } else {
              buildConfig = {
                ...build.config || {},
                bunVersion: localConfig.bunVersion ?? void 0
              };
            }
            const builderSpan = span.child("vc.builder", {
              "builder.name": builderPkg.name,
              "builder.version": builderPkg.version,
              "builder.dynamicallyInstalled": String(
                builderWithPkg.dynamicallyInstalled
              )
            });
            const serviceRoutePrefix = build.config?.routePrefix;
            const serviceConfigWorkspace = build.config?.workspace;
            const preDeployCmd = legacyExperimentalService?.preDeployCommand?.trim();
            const preDeployEntry = preDeployCmd && service ? { service: service.name } : void 0;
            if (preDeployEntry) {
              preDeployEntries.push(preDeployEntry);
            }
            const buildOptions = {
              files: buildFiles,
              entrypoint: buildEntrypoint,
              workPath: buildWorkPath,
              repoRootPath,
              config: buildConfig,
              meta,
              span: builderSpan,
              ...preDeployCmd ? {
                registerPreDeploy: (callback) => {
                  preDeployEntry.callback = callback;
                }
              } : void 0,
              ...service ? {
                service: {
                  name: service.name,
                  ...legacyExperimentalService ? {
                    type: legacyExperimentalService.type,
                    trigger: legacyExperimentalService.trigger
                  } : void 0,
                  routePrefix: typeof serviceRoutePrefix === "string" ? serviceRoutePrefix : void 0,
                  workspace: typeof serviceConfigWorkspace === "string" ? serviceConfigWorkspace : serviceWorkspace,
                  ...legacyExperimentalService ? { schedule: legacyExperimentalService.schedule } : void 0
                }
              } : void 0
            };
            output.debug(
              `Building entrypoint "${build.src}" with "${builderPkg.name}"`
            );
            const restoreEnv = /* @__PURE__ */ new Map();
            if (detectedServices && legacyExperimentalService?.env) {
              const perServiceEnv = (0, import_build_utils2.getServiceUrlEnvVars)({
                requestedEnv: legacyExperimentalService.env,
                consumerService: legacyExperimentalService,
                services: detectedServices,
                frameworkList: import_frameworks.frameworkList,
                currentEnv: process.env,
                deploymentUrl: process.env.VERCEL_URL
              });
              for (const [key, value] of Object.entries(perServiceEnv)) {
                if (key in process.env)
                  continue;
                restoreEnv.set(key, process.env[key]);
                process.env[key] = value;
                output.debug(`Injected service URL env var: ${key}=${value}`);
              }
            }
            if (service) {
              unsetServiceBuildImmutableEnvVars(restoreEnv);
            }
            let buildResult;
            let rawBuildResult;
            try {
              ({ buildResult, rawBuildResult } = await (0, import_execute_builder.executeBuilder)({
                builder,
                buildOptions,
                span: builderSpan,
                isFrontendBuilder,
                hasDetectedServices: getHasDetectedServices(),
                framework: import_frameworks.frameworkList.find(
                  (framework2) => framework2.slug === buildConfig.framework
                )
              }));
            } finally {
              for (const [key, prior] of restoreEnv) {
                if (prior === void 0) {
                  delete process.env[key];
                } else {
                  process.env[key] = prior;
                }
              }
              try {
                const builderDiagnostics = await builderSpan.child("vc.builder.diagnostics").trace(async () => {
                  return await builder.diagnostics?.(buildOptions);
                });
                if (builderDiagnostics) {
                  const prefix = service && serviceWorkspace && serviceWorkspace !== "." ? serviceWorkspace + "/" + builderPkg.name + "/" : "";
                  for (const [key, value] of Object.entries(builderDiagnostics)) {
                    const fullKey = prefix + key;
                    if (key.endsWith("package-manifest.json")) {
                      try {
                        let data;
                        if (value.type === "FileBlob") {
                          data = value.data.toString();
                        } else {
                          data = await streamToString(value.toStream());
                        }
                        const packageManifest = JSON.parse(data);
                        const validationError = (0, import_validate_package_manifest.validatePackageManifest)(packageManifest);
                        if (validationError) {
                          output.warn(
                            `Invalid package-manifest.json from ${fullKey}: ${validationError}`
                          );
                        } else {
                          const workspace = service && serviceWorkspace && serviceWorkspace !== "." ? serviceWorkspace : ".";
                          const alreadyPushed = packageManifests.some(
                            (m) => m.builderUse === builderPkg.name && m.workspace === workspace
                          );
                          if (!alreadyPushed) {
                            packageManifests.push({
                              workspace,
                              key: fullKey,
                              buildConfig,
                              manifest: {
                                ...packageManifest,
                                framework: packageManifest.framework ?? apiDirFramework
                              },
                              service,
                              builderUse: builderPkg.name
                            });
                          }
                        }
                      } catch (e) {
                        output.debug(
                          `Failed to parse ${fullKey}: ${e instanceof Error ? e.message : String(e)}`
                        );
                      }
                    } else {
                      diagnostics[fullKey] = value;
                    }
                  }
                }
              } catch (error) {
                output.error("Collecting diagnostics failed");
                output.debug(error);
              }
            }
            if (buildResult && "output" in buildResult && "runtime" in buildResult.output && "type" in buildResult.output && buildResult.output.type === "Lambda") {
              const lambdaRuntime = buildResult.output.runtime;
              if ((0, import_build_utils2.getDiscontinuedNodeVersions)().some((o) => o.runtime === lambdaRuntime)) {
                throw new import_build_utils2.NowBuildError({
                  code: "NODEJS_DISCONTINUED_VERSION",
                  message: `The Runtime "${build.use}" is using "${lambdaRuntime}", which is discontinued. Please upgrade your Runtime to a more recent version or consult the author for more details.`,
                  link: "https://vercel.link/function-runtimes"
                });
              }
            }
            if ("output" in buildResult && buildResult.output && ((0, import_build_utils2.isBackendBuilder)(build) || build.use === "@vercel/python")) {
              const routesJsonPath = (0, import_path2.join)(buildWorkPath, ".vercel", "routes.json");
              if ((0, import_fs_extra2.existsSync)(routesJsonPath)) {
                try {
                  const routesJson = await readJSONFile2(routesJsonPath);
                  if (routesJson && typeof routesJson === "object" && "routes" in routesJson && Array.isArray(routesJson.routes)) {
                    const indexLambda = "index" in buildResult.output ? buildResult.output["index"] : void 0;
                    const convertedRoutes = [];
                    const convertedOutputs = indexLambda ? { index: indexLambda } : {};
                    for (const route of routesJson.routes) {
                      if (typeof route.source !== "string") {
                        continue;
                      }
                      const { src } = (0, import_routing_utils.sourceToRegex)(route.source);
                      const newRoute = {
                        src,
                        dest: route.source
                      };
                      if (route.methods) {
                        newRoute.methods = route.methods;
                      }
                      if (route.source === "/") {
                        continue;
                      }
                      if (indexLambda) {
                        convertedOutputs[route.source] = indexLambda;
                      }
                      convertedRoutes.push(newRoute);
                    }
                    buildResult.routes = [
                      { handle: "filesystem" },
                      ...convertedRoutes,
                      { src: "/(.*)", dest: "/" }
                    ];
                    if (indexLambda) {
                      buildResult.output = convertedOutputs;
                    }
                  }
                } catch (error) {
                  output.error(`Failed to read routes.json: ${error}`);
                }
              }
            }
            if (getHasDetectedServices() && service && legacyExperimentalService && "routes" in buildResult && Array.isArray(buildResult.routes) && detectedServices) {
              buildResult.routes = (0, import_service_route_ownership.scopeRoutesToServiceOwnership)({
                routes: buildResult.routes,
                owner: legacyExperimentalService,
                allServices: detectedServices
              });
            }
            if (legacyExperimentalService && (0, import_build_utils2.isQueueBackedService)(legacyExperimentalService) && "output" in buildResult) {
              attachQueueServiceTrigger(
                buildResult.output,
                legacyExperimentalService
              );
            }
            if (legacyExperimentalService && (0, import_build_utils2.isScheduleTriggeredService)(legacyExperimentalService) && !("crons" in buildResult && buildResult.crons?.length)) {
              const staticSchedules = (0, import_service_schedules.getStaticServiceSchedules)(
                legacyExperimentalService.schedule
              );
              if (typeof legacyExperimentalService.runtime === "string" && staticSchedules.length > 0) {
                const cronEntrypoint = legacyExperimentalService.entrypoint || legacyExperimentalService.builder.src || "index";
                for (const schedule of staticSchedules) {
                  synthesizedServiceCrons.push({
                    path: (0, import_build_utils2.getInternalServiceCronPath)(
                      legacyExperimentalService.name,
                      cronEntrypoint,
                      legacyExperimentalService.handlerFunction || "cron"
                    ),
                    schedule
                  });
                }
              } else {
                throw new import_build_utils2.NowBuildError({
                  code: "CRON_SERVICE_NO_CRONS",
                  message: `Scheduled service "${legacyExperimentalService.name}" did not produce any cron entries. The builder "${builderPkg.name}" may not support scheduled services.`
                });
              }
            }
            let mergedBuildResult = buildResult;
            if ("buildOutputPath" in buildResult) {
              const buildOutputConfigPath = (0, import_path2.join)(
                buildResult.buildOutputPath,
                "config.json"
              );
              const buildOutputConfig = await readJSONFile2(
                buildOutputConfigPath
              );
              if (isCantParseJSONFile(buildOutputConfig)) {
                throw buildOutputConfig;
              }
              if (buildOutputConfig) {
                if (!hasExperimentalServicesV1ConfiguredInVercelConfig && !hasExperimentalServicesV2ConfiguredInVercelConfig) {
                  const outputConfigPath = (0, import_path2.join)(outputDir, "config.json");
                  const outputConfig = await readJSONFile2(outputConfigPath);
                  if (isCantParseJSONFile(outputConfig)) {
                    throw outputConfig;
                  }
                  let shouldMergeGeneratedOutputRoutes = false;
                  if (hasNonEmptyObject(outputConfig?.experimentalServices) && !hasNonEmptyObject(buildOutputConfig.experimentalServices)) {
                    buildOutputConfig.experimentalServices = outputConfig.experimentalServices;
                    shouldMergeGeneratedOutputRoutes = true;
                  }
                  if (hasNonEmptyObject(outputConfig?.experimentalServicesV2) && !hasNonEmptyObject(buildOutputConfig.experimentalServicesV2)) {
                    buildOutputConfig.experimentalServicesV2 = outputConfig.experimentalServicesV2;
                    shouldMergeGeneratedOutputRoutes = true;
                  }
                  if (hasGeneratedServicesConfig(outputConfig) && !hasGeneratedServicesConfig(buildOutputConfig)) {
                    buildOutputConfig.services = outputConfig.services;
                    shouldMergeGeneratedOutputRoutes = true;
                  }
                  if (shouldMergeGeneratedOutputRoutes && Array.isArray(outputConfig?.routes)) {
                    buildOutputConfig.routes = prependMissingBuildOutputRoutes(
                      outputConfig.routes,
                      buildOutputConfig.routes
                    );
                  }
                  if (hasNonEmptyObject(buildOutputConfig.experimentalServices) || hasNonEmptyObject(buildOutputConfig.experimentalServicesV2) || hasGeneratedServicesConfig(buildOutputConfig)) {
                    await import_fs_extra2.default.writeJSON(buildOutputConfigPath, buildOutputConfig, {
                      spaces: 2
                    });
                  }
                }
                if (getHasDetectedServices() && service && legacyExperimentalService && Array.isArray(buildOutputConfig.routes) && detectedServices) {
                  buildOutputConfig.routes = (0, import_service_route_ownership.scopeRoutesToServiceOwnership)({
                    routes: buildOutputConfig.routes,
                    owner: legacyExperimentalService,
                    allServices: detectedServices
                  });
                }
                mergedBuildResult = buildOutputConfig;
              }
            }
            buildResults.set(build, mergedBuildResult);
            executedBuilds.push(build);
            let buildOutputLength = 0;
            if ("output" in buildResult) {
              buildOutputLength = Array.isArray(buildResult.output) ? buildResult.output.length : 1;
            }
            const writeBuildResultPromise = builderSpan.child("vc.builder.writeBuildResult", {
              buildOutputLength: String(buildOutputLength)
            }).trace(
              () => writeBuildResult2({
                repoRootPath,
                outputDir,
                buildResult: rawBuildResult,
                build,
                builder,
                builderPkg,
                vercelConfig: localConfig,
                standalone,
                workPath: buildWorkPath,
                service,
                nestServiceOutput: nestExperimentalServicesV2Output,
                stripServiceRoutePrefix
              })
            );
            if (service && nestExperimentalServicesV2Output) {
              const override = await writeBuildResultPromise;
              if (override)
                serviceFileOverrides.set(build, override);
            } else {
              ops.push(
                writeBuildResultPromise.then(
                  (override) => {
                    if (override)
                      overrides.push(override);
                  },
                  (err) => err
                )
              );
            }
          } catch (err) {
            const buildJsonBuild = buildsJsonBuilds.get(build);
            if (buildJsonBuild) {
              buildJsonBuild.error = toEnumerableError2(err);
            }
            throw err;
          } finally {
            ops.push(
              (0, import_build_utils2.download)(diagnostics, (0, import_path2.join)(outputDir, "diagnostics")).then(
                () => void 0,
                (err) => err
              )
            );
          }
        }
      };
      const flushOps = async () => {
        const errors = await Promise.all(ops.splice(0));
        for (const error of errors) {
          if (error) {
            throw error;
          }
        }
      };
      const normalizeBuilderSrc = (src) => typeof src === "string" ? (0, import_build_utils2.normalizePath)(src).replace(/^\.\//, "") : void 0;
      const getBuilderIdentity = (build) => {
        const normalizedSrc = normalizeBuilderSrc(build.src);
        return normalizedSrc ? `${build.use}:${normalizedSrc}` : void 0;
      };
      const getAlreadyExecutedBuild = (candidate) => {
        const candidateIdentity = getBuilderIdentity(candidate);
        if (!candidateIdentity)
          return void 0;
        return executedBuilds.find(
          (build) => getBuilderIdentity(build) === candidateIdentity
        );
      };
      const appendExperimentalServicesV1Routes = (services) => {
        const serviceRoutes = (0, import_fs_detectors.generateServicesRoutes)(services);
        zeroConfigRoutes = (0, import_routing_utils.appendRoutesToPhase)({
          routes: zeroConfigRoutes,
          newRoutes: serviceRoutes.hostRewrites.length ? serviceRoutes.hostRewrites : null,
          phase: null
        });
        const serviceRewriteRoutes = nestExperimentalServicesV2Output ? [] : [
          ...serviceRoutes.rewrites,
          ...serviceRoutes.workers,
          ...serviceRoutes.crons
        ];
        zeroConfigRoutes.push(
          ...(0, import_routing_utils.appendRoutesToPhase)({
            routes: [],
            newRoutes: serviceRewriteRoutes,
            phase: "filesystem"
          })
        );
        if (!nestExperimentalServicesV2Output) {
          zeroConfigRoutes.push(...serviceRoutes.defaults);
          zeroConfigFallbackRoutes.push(...serviceRoutes.fallbacks);
        }
      };
      await runBuilders(builds);
      await flushOps();
      if (!hasExperimentalServicesV1ConfiguredInVercelConfig && !hasExperimentalServicesV2ConfiguredInVercelConfig) {
        const generatedConfigPath = (0, import_path2.join)(outputDir, "config.json");
        const generatedConfig = await readJSONFile2(generatedConfigPath);
        if (isCantParseJSONFile(generatedConfig)) {
          throw generatedConfig;
        }
        const defaultGeneratedOutputDir = (0, import_path2.join)(workPath, import_write_build_result3.OUTPUT_DIR);
        const generatedConfigs = [generatedConfig];
        if ((0, import_path2.resolve)(outputDir) !== (0, import_path2.resolve)(defaultGeneratedOutputDir)) {
          const defaultGeneratedConfig = await readJSONFile2(
            (0, import_path2.join)(defaultGeneratedOutputDir, "config.json")
          );
          if (isCantParseJSONFile(defaultGeneratedConfig)) {
            throw defaultGeneratedConfig;
          }
          generatedConfigs.push(defaultGeneratedConfig);
        }
        const generatedServicesConfig = getGeneratedServicesConfig([
          ...generatedConfigs,
          ...buildResults.values()
        ]);
        const generatedExperimentalServicesV1Config = getGeneratedExperimentalServicesV1Config([
          ...generatedConfigs,
          ...buildResults.values()
        ]);
        if (generatedServicesConfig || generatedExperimentalServicesV1Config) {
          if (generatedServicesConfig) {
            nestExperimentalServicesV2Output = true;
          }
          detectedExperimentalServicesV1Config = generatedExperimentalServicesV1Config;
          detectedExperimentalServicesV2Config = generatedServicesConfig;
          detectedExperimentalServicesV2RootRoutes = generatedServicesConfig ? generatedConfigs.find(
            (config2) => (hasGeneratedServicesConfig(config2) || hasNonEmptyObject(config2?.experimentalServicesV2)) && Array.isArray(config2?.routes)
          )?.routes : void 0;
          const generatedBuilders = await span.child("vc.detectGeneratedServices").trace(
            () => (0, import_fs_detectors.detectBuilders)(files, pkg, {
              ...localConfig,
              ...generatedServicesConfig ? {
                services: generatedServicesConfig,
                experimentalServicesV2: void 0
              } : {
                experimentalServicesV2: void 0,
                experimentalServices: generatedExperimentalServicesV1Config
              },
              projectSettings,
              ignoreBuildScript: true,
              featHandleMiss: true,
              workPath
            })
          );
          if (generatedBuilders.errors && generatedBuilders.errors.length > 0) {
            throw generatedBuilders.errors[0];
          }
          for (const w of generatedBuilders.warnings) {
            output.warn(w.message, null, w.link, w.action || "Learn More");
          }
          detectedResolvedServices = generatedBuilders.services;
          if (!detectedResolvedServices || detectedResolvedServices.length === 0) {
            detectedResolvedServices = void 0;
            detectedServices = void 0;
          } else {
            detectedServices = detectedResolvedServices.filter(
              import_build_utils2.isExperimentalService
            );
            if (detectedServices.length > 0) {
              appendExperimentalServicesV1Routes(detectedServices);
            }
          }
          if (detectedServices && detectedServices.length > 0 && generatedBuilders.useImplicitEnvInjection) {
            const serviceUrlEnvVars = (0, import_build_utils2.getExperimentalServiceUrlEnvVars)({
              services: detectedServices,
              frameworkList: import_frameworks.frameworkList,
              currentEnv: process.env,
              deploymentUrl: process.env.VERCEL_URL
            });
            for (const [key, value] of Object.entries(serviceUrlEnvVars)) {
              process.env[key] = value;
              output.debug(`Injected service URL env var: ${key}=${value}`);
            }
          }
          const buildsToRun = [];
          const seenBuildsToRun = /* @__PURE__ */ new Set();
          const recordedServices = [];
          for (const service of detectedResolvedServices || []) {
            const alreadyExecutedBuild = getAlreadyExecutedBuild(service.builder);
            if (alreadyExecutedBuild) {
              if (generatedServicesConfig) {
                output.warn(getGeneratedServiceAlreadyBuiltWarning(service));
                continue;
              }
              serviceByBuilder.set(alreadyExecutedBuild, service);
              recordedServices.push(service);
              continue;
            }
            const serviceBuilderIdentity = getBuilderIdentity(service.builder);
            if (serviceBuilderIdentity && !seenBuildsToRun.has(serviceBuilderIdentity)) {
              serviceByBuilder.set(service.builder, service);
              seenBuildsToRun.add(serviceBuilderIdentity);
              buildsToRun.push(service.builder);
            }
            recordedServices.push(service);
          }
          servicesToRecord = recordedServices.length > 0 ? recordedServices : void 0;
          if (buildsToRun.length > 0) {
            await runBuilders(buildsToRun);
          }
        }
      }
      for (const entry of preDeployEntries) {
        if (entry.callback) {
          await entry.callback();
        } else {
          output.warn(
            `Service "${entry.service}" has a preDeployCommand but its builder does not support it. The command was not executed.`
          );
        }
      }
      await (0, import_manifest.writeManifests)(packageManifests, diagnostics, ops, outputDir);
      if (corepackShimDir) {
        (0, import_corepack.cleanupCorepack)(corepackShimDir);
      }
      const collectSpan = span.child("vc.finalizeBuildOutput");
      await flushOps();
      let needBuildsJsonOverride = false;
      const speedInsightsVersion = await (0, import_build_utils2.getInstalledPackageVersion)(
        "@vercel/speed-insights"
      );
      if (speedInsightsVersion) {
        buildsJson.features = {
          ...buildsJson.features ?? {},
          speedInsightsVersion
        };
        needBuildsJsonOverride = true;
      }
      const webAnalyticsVersion = await (0, import_build_utils2.getInstalledPackageVersion)("@vercel/analytics");
      if (webAnalyticsVersion) {
        buildsJson.features = {
          ...buildsJson.features ?? {},
          webAnalyticsVersion
        };
        needBuildsJsonOverride = true;
      }
      if (needBuildsJsonOverride) {
        await writeBuildJson(buildsJson, outputDir);
      }
      const configPath = (0, import_path2.join)(outputDir, "config.json");
      const existingConfig = await readJSONFile2(configPath);
      if (isCantParseJSONFile(existingConfig)) {
        throw existingConfig;
      }
      if (existingConfig) {
        if ("deploymentId" in existingConfig && typeof existingConfig.deploymentId === "string") {
          const deploymentId = existingConfig.deploymentId;
          if (deploymentId.length > 32) {
            throw new import_build_utils2.NowBuildError({
              code: "INVALID_DEPLOYMENT_ID",
              message: `The deploymentId "${deploymentId}" must be 32 characters or less. Please choose a shorter deploymentId in your config.`,
              link: "https://vercel.com/docs/skew-protection#custom-skew-protection-deployment-id"
            });
          }
          if (!VALID_DEPLOYMENT_ID_PATTERN.test(deploymentId)) {
            throw new import_build_utils2.NowBuildError({
              code: "INVALID_DEPLOYMENT_ID",
              message: `The deploymentId "${deploymentId}" contains invalid characters. Only alphanumeric characters (a-z, A-Z, 0-9), hyphens (-), and underscores (_) are allowed.`,
              link: "https://vercel.com/docs/skew-protection#custom-skew-protection-deployment-id"
            });
          }
        }
        if (existingConfig.overrides && !nestExperimentalServicesV2Output) {
          overrides.push(existingConfig.overrides);
        }
      }
      const topLevelBuildResults = nestExperimentalServicesV2Output ? new Map(
        Array.from(buildResults.entries()).filter(
          ([build]) => !serviceByBuilder.has(build)
        )
      ) : buildResults;
      const builderRoutes = Array.from(
        topLevelBuildResults.entries()
      ).filter((b) => "routes" in b[1] && Array.isArray(b[1].routes)).map((b) => {
        const build = b[0];
        const buildResult = b[1];
        let entrypoint = build.src;
        if (getHasDetectedServices() && typeof build.src === "string") {
          const service = serviceByBuilder.get(build);
          if (service && (0, import_build_utils2.isExperimentalService)(service) && service.type === "web" && typeof service.routePrefix === "string") {
            entrypoint = getServicesMergeEntrypoint(service, build.src);
          }
        }
        return {
          use: build.use,
          entrypoint,
          routes: buildResult.routes
        };
      });
      if (zeroConfigRoutes.length) {
        builderRoutes.unshift({
          use: "@vercel/zero-config-routes",
          entrypoint: "/",
          routes: zeroConfigRoutes
        });
      }
      let mergedRoutes = (0, import_routing_utils.mergeRoutes)({
        userRoutes: routesResult.routes,
        builds: builderRoutes
      });
      if (zeroConfigFallbackRoutes.length) {
        mergedRoutes = (0, import_routing_utils.appendRoutesToPhase)({
          routes: mergedRoutes,
          newRoutes: zeroConfigFallbackRoutes,
          phase: "filesystem"
        });
      }
      const mergedImages = mergeImages(
        localConfig.images,
        topLevelBuildResults.values()
      );
      const mergedCrons = mergeCrons(
        [...localConfig.crons || [], ...synthesizedServiceCrons],
        buildResults.values()
      );
      const mergedWildcard = mergeWildcard(topLevelBuildResults.values());
      const mergedDeploymentId = await mergeDeploymentId(
        existingConfig?.deploymentId,
        topLevelBuildResults.values(),
        workPath,
        readJSONFile2,
        isCantParseJSONFile
      );
      if (mergedDeploymentId) {
        if (mergedDeploymentId.length > 32) {
          throw new import_build_utils2.NowBuildError({
            code: "INVALID_DEPLOYMENT_ID",
            message: `The deploymentId "${mergedDeploymentId}" must be 32 characters or less. Please choose a shorter deploymentId in your config.`,
            link: "https://vercel.com/docs/skew-protection#custom-skew-protection-deployment-id"
          });
        }
        if (!VALID_DEPLOYMENT_ID_PATTERN.test(mergedDeploymentId)) {
          throw new import_build_utils2.NowBuildError({
            code: "INVALID_DEPLOYMENT_ID",
            message: `The deploymentId "${mergedDeploymentId}" contains invalid characters. Only alphanumeric characters (a-z, A-Z, 0-9), hyphens (-), and underscores (_) are allowed.`,
            link: "https://vercel.com/docs/skew-protection#custom-skew-protection-deployment-id"
          });
        }
      }
      const topLevelBuildResultOverrides = Array.from(topLevelBuildResults.values()).map((result) => "overrides" in result ? result.overrides : void 0).filter((value) => Boolean(value));
      const mergedOverrides = overrides.length > 0 || topLevelBuildResultOverrides.length > 0 ? Object.assign({}, ...overrides, ...topLevelBuildResultOverrides) : void 0;
      const framework = topLevelBuildResults.size > 0 ? await getFramework(workPath, topLevelBuildResults) : void 0;
      const explicitRootRoutes = appendBuildOutputRouteTables(
        routesResult.routes,
        detectedExperimentalServicesV2RootRoutes ?? existingConfig?.routes
      );
      const mergedRoutesWithGeneratedServicesV2Routes = nestExperimentalServicesV2Output ? appendBuildOutputRouteTables(
        mergedRoutes,
        detectedExperimentalServicesV2RootRoutes ?? existingConfig?.routes
      ) : mergedRoutes;
      const config = {
        version: 3,
        routes: mergedRoutesWithGeneratedServicesV2Routes ?? explicitRootRoutes,
        images: mergedImages,
        wildcard: mergedWildcard,
        overrides: mergedOverrides,
        framework,
        crons: mergedCrons,
        ...detectedExperimentalServicesV1Config && Object.keys(detectedExperimentalServicesV1Config).length > 0 && {
          experimentalServices: detectedExperimentalServicesV1Config
        },
        ...detectedExperimentalServicesV2Config && Object.keys(detectedExperimentalServicesV2Config).length > 0 && {
          experimentalServicesV2: detectedExperimentalServicesV2Config
        },
        ...!detectedExperimentalServicesV1Config && servicesToRecord && servicesToRecord.length > 0 && {
          services: servicesToRecord
        },
        ...mergedDeploymentId && { deploymentId: mergedDeploymentId }
      };
      await import_fs_extra2.default.writeJSON((0, import_path2.join)(outputDir, "config.json"), config, { spaces: 2 });
      if (nestExperimentalServicesV2Output) {
        await writeServiceConfigs(
          outputDir,
          buildResults,
          serviceByBuilder,
          serviceFileOverrides,
          detectedExperimentalServicesV2Config,
          readJSONFile2,
          isCantParseJSONFile
        );
      }
      await writeFlagsJSON(buildResults.values(), outputDir, output);
      await span.child("vc.frameworkCrossCheck").trace(async (s) => {
        const detectedFrameworks = await detectedFrameworksPromise;
        const executedBuilders = Array.from(buildResults.keys());
        const usedBuilders = executedBuilders.map((b) => b.use).filter((use) => Boolean(use));
        const mismatchResult = (0, import_framework_detection.warnIfFrameworkMismatch)(
          {
            configuredFramework: projectSettings.framework,
            detectedFrameworks,
            usedBuilders,
            usedFrameworks: executedBuilders.map((b) => b.config?.framework)
          },
          output
        );
        s.setAttributes({
          result: mismatchResult,
          configuredFramework: projectSettings.framework ?? void 0,
          detectedFrameworks: detectedFrameworks.join(",") || void 0,
          usedBuilders: usedBuilders.join(",") || void 0
        });
      });
      await span.child("vc.validateBuildOutput").trace(async (s) => {
        const outputProblems = await (0, import_validate_build_output.validateBuildOutput)(outputDir, output);
        s.setAttributes({
          problemCount: String(outputProblems.length),
          problems: outputProblems.map((p) => `${p.severity}: ${p.message}`).join("; ") || void 0
        });
        (0, import_validate_build_output.reportBuildOutputProblems)(outputProblems, output);
      });
      collectSpan.stop();
      return { buildDuration: buildStamp() };
    }
    async function getFramework(cwd, buildResults) {
      const detectedFramework = await (0, import_fs_detectors.detectFrameworkRecord)({
        fs: new import_fs_detectors.LocalFileSystemDetector(cwd),
        frameworkList: import_frameworks.frameworkList
      });
      if (!detectedFramework) {
        return;
      }
      if (detectedFramework.useRuntime) {
        for (const [build, buildResult] of buildResults.entries()) {
          if ("framework" in buildResult && build.use === detectedFramework.useRuntime.use) {
            return buildResult.framework ? {
              slug: buildResult.framework.slug,
              version: buildResult.framework.version
            } : void 0;
          }
        }
      }
      if (detectedFramework.slug) {
        if (detectedFramework.detectedVersion && import_semver.default.valid(detectedFramework.detectedVersion)) {
          return {
            slug: detectedFramework.slug,
            version: detectedFramework.detectedVersion
          };
        }
        const frameworkVersion = (0, import_fs_detectors.detectFrameworkVersion)(detectedFramework);
        if (frameworkVersion) {
          return {
            slug: detectedFramework.slug,
            version: frameworkVersion
          };
        }
      }
    }
    function expandBuild(files, build) {
      if (!build.use) {
        throw new import_build_utils2.NowBuildError({
          code: `invalid_build_specification`,
          message: "Field `use` is missing in build specification",
          link: "https://vercel.com/docs/concepts/projects/project-configuration#builds",
          action: "View Documentation"
        });
      }
      let src = (0, import_path2.normalize)(build.src || "**").split(import_path2.sep).join("/");
      if (src === "." || src === "./") {
        throw new import_build_utils2.NowBuildError({
          code: `invalid_build_specification`,
          message: "A build `src` path resolves to an empty string",
          link: "https://vercel.com/docs/concepts/projects/project-configuration#builds",
          action: "View Documentation"
        });
      }
      if (src[0] === "/") {
        src = src.substring(1);
      }
      const matches = files.filter(
        (name) => name === src || (0, import_minimatch2.default)(name, src, { dot: true })
      );
      return matches.map((m) => {
        return {
          ...build,
          src: m
        };
      });
    }
    function mergeImages(images, buildResults) {
      for (const result of buildResults) {
        if ("images" in result && result.images) {
          images = Object.assign({}, images, result.images);
        }
      }
      return images;
    }
    function mergeCrons(crons = [], buildResults) {
      for (const result of buildResults) {
        if ("crons" in result && result.crons) {
          crons = crons.concat(result.crons);
        }
      }
      return crons;
    }
    function mergeWildcard(buildResults) {
      let wildcard = void 0;
      for (const result of buildResults) {
        if ("wildcard" in result && result.wildcard) {
          if (!wildcard)
            wildcard = [];
          wildcard.push(...result.wildcard);
        }
      }
      return wildcard;
    }
    function appendBuildOutputRouteTables(...routeTables) {
      let routes = [];
      for (const routeTable of routeTables) {
        if (!Array.isArray(routeTable) || routeTable.length === 0)
          continue;
        let phase = null;
        let phaseRoutes = [];
        const flushPhase = () => {
          if (phaseRoutes.length === 0)
            return;
          routes = (0, import_routing_utils.appendRoutesToPhase)({
            routes,
            newRoutes: phaseRoutes,
            phase
          });
          phaseRoutes = [];
        };
        for (const route of routeTable) {
          if ((0, import_routing_utils.isHandler)(route)) {
            flushPhase();
            phase = route.handle;
          } else {
            phaseRoutes.push(route);
          }
        }
        flushPhase();
      }
      return routes.length > 0 ? routes : void 0;
    }
    function prependMissingBuildOutputRoutes(routesToPrepend, existingRoutes) {
      if (!Array.isArray(routesToPrepend) || routesToPrepend.length === 0) {
        return existingRoutes;
      }
      const existingRouteKeys = new Set(
        (existingRoutes ?? []).map((route) => JSON.stringify(route))
      );
      const missingRoutes = routesToPrepend.filter(
        (route) => !existingRouteKeys.has(JSON.stringify(route))
      );
      return appendBuildOutputRouteTables(missingRoutes, existingRoutes);
    }
    async function writeServiceConfigs(outputDir, buildResults, serviceByBuilder, serviceFileOverrides, experimentalServicesV2, readJSONFile2, isCantParseJSONFile) {
      const serviceResults = /* @__PURE__ */ new Map();
      const serviceOverrides = /* @__PURE__ */ new Map();
      for (const [build, buildResult] of buildResults) {
        const service = serviceByBuilder.get(build);
        if (!service)
          continue;
        const results = serviceResults.get(service.name) || [];
        results.push(buildResult);
        serviceResults.set(service.name, results);
        const fileOverrides = serviceFileOverrides.get(build);
        if (fileOverrides) {
          const overrides = serviceOverrides.get(service.name) || [];
          overrides.push(fileOverrides);
          serviceOverrides.set(service.name, overrides);
        }
      }
      await Promise.all(
        Array.from(serviceResults.entries()).map(async ([serviceName, results]) => {
          const configPath = (0, import_path2.join)(
            outputDir,
            "services",
            serviceName,
            "config.json"
          );
          const existingConfig = await readJSONFile2(configPath);
          if (isCantParseJSONFile(existingConfig)) {
            throw existingConfig;
          }
          const routes = results.flatMap(
            (result) => "routes" in result && Array.isArray(result.routes) ? result.routes : []
          );
          const existingRoutes = routes.length > 0 ? void 0 : existingConfig?.routes;
          const existingCrons = results.some(
            (result) => "crons" in result && result.crons?.length
          ) ? void 0 : existingConfig?.crons;
          const configuredRoutes = experimentalServicesV2?.[serviceName] ? getExperimentalServicesV2Routes(experimentalServicesV2[serviceName]) : [];
          const overrides = [
            ...results.map((result) => "overrides" in result ? result.overrides : void 0).filter(
              (value) => Boolean(value)
            ),
            ...serviceOverrides.get(serviceName) || []
          ];
          const framework = results.find(
            (result) => "framework" in result && Boolean(result.framework)
          )?.framework;
          const mergedRoutes = appendBuildOutputRouteTables(
            configuredRoutes,
            routes,
            existingRoutes
          );
          const config = {
            ...existingConfig,
            version: 3,
            routes: mergedRoutes,
            images: mergeImages(existingConfig?.images, results),
            wildcard: mergeWildcard(results) || existingConfig?.wildcard,
            overrides: overrides.length > 0 ? Object.assign({}, existingConfig?.overrides, ...overrides) : existingConfig?.overrides,
            framework: framework || existingConfig?.framework,
            crons: mergeCrons(existingCrons, results),
            services: void 0,
            experimentalServices: void 0,
            experimentalServicesV2: void 0
          };
          await import_fs_extra2.default.writeJSON(configPath, config, { spaces: 2 });
        })
      );
    }
    function getExperimentalServicesV2Routes(serviceConfig) {
      const routesResult = (0, import_routing_utils.getTransformedRoutes)({
        routes: serviceConfig.routes,
        cleanUrls: serviceConfig.cleanUrls,
        trailingSlash: serviceConfig.trailingSlash,
        headers: serviceConfig.headers,
        redirects: serviceConfig.redirects,
        rewrites: serviceConfig.rewrites
      });
      if (routesResult.error) {
        throw routesResult.error;
      }
      return routesResult.routes ?? [];
    }
    function getGeneratedExperimentalServicesV1Config(buildResults) {
      for (const result of buildResults) {
        if (result && "experimentalServices" in result && hasNonEmptyObject(result.experimentalServices)) {
          return result.experimentalServices;
        }
      }
      return void 0;
    }
    function hasGeneratedServicesConfig(result) {
      return result != null && "services" in result && hasNonEmptyObject(result.services);
    }
    function getGeneratedServicesConfig(buildResults) {
      for (const result of buildResults) {
        if (hasGeneratedServicesConfig(result)) {
          return result.services;
        }
        if (result && "experimentalServicesV2" in result && hasNonEmptyObject(result.experimentalServicesV2)) {
          return result.experimentalServicesV2;
        }
      }
      return void 0;
    }
    async function mergeDeploymentId(existingDeploymentId, buildResults, workPath, readJSONFile2, isCantParseJSONFile) {
      if (existingDeploymentId) {
        return existingDeploymentId;
      }
      for (const result of buildResults) {
        if ("deploymentId" in result && result.deploymentId) {
          return result.deploymentId;
        }
      }
      try {
        const routesManifestPath = (0, import_path2.join)(workPath, ".next", "routes-manifest.json");
        if (await import_fs_extra2.default.pathExists(routesManifestPath)) {
          const routesManifest = await readJSONFile2(
            routesManifestPath
          );
          if (routesManifest && !isCantParseJSONFile(routesManifest)) {
            if (routesManifest.deploymentId) {
              return routesManifest.deploymentId;
            }
          }
        }
      } catch {
      }
      return void 0;
    }
    async function writeFlagsJSON(buildResults, outputDir, output) {
      const flagsFilePath = (0, import_path2.join)(outputDir, "flags.json");
      let hasFlags = true;
      const flags = await import_fs_extra2.default.readJSON(flagsFilePath).catch((error) => {
        if (error.code === "ENOENT") {
          hasFlags = false;
          return { definitions: {} };
        }
        throw error;
      });
      for (const result of buildResults) {
        if (!("flags" in result) || !result.flags || !result.flags.definitions)
          continue;
        for (const [key, definition] of Object.entries(result.flags.definitions)) {
          if (result.flags.definitions[key]) {
            output.warn(
              `The flag "${key}" was found multiple times. Only its first occurrence will be considered.`
            );
            continue;
          }
          hasFlags = true;
          flags.definitions[key] = definition;
        }
      }
      if (hasFlags) {
        await import_fs_extra2.default.writeJSON(flagsFilePath, flags, { spaces: 2 });
      }
    }
    function createApiDirFrameworkDetector(detectAllFrameworks2) {
      const cache = /* @__PURE__ */ new Map();
      return {
        detect(builderUse, workPath) {
          const cacheKey = `${builderUse}:${workPath}`;
          let cached = cache.get(cacheKey);
          if (!cached) {
            cached = detectApiDirFramework(
              builderUse,
              workPath,
              detectAllFrameworks2
            );
            cache.set(cacheKey, cached);
          }
          return cached;
        }
      };
    }
    async function detectApiDirFramework(builderUse, workPath, detectAllFrameworks2) {
      const runtimeFrameworks = import_fs_detectors.builderToFrameworks.get(builderUse) ?? [];
      if (runtimeFrameworks.length === 0)
        return void 0;
      const detectedSlugs = await detectAllFrameworks2(
        workPath,
        runtimeFrameworks
      ).catch(() => []);
      return detectedSlugs.length === 1 ? detectedSlugs[0] : void 0;
    }
    async function writeBuildJson(buildsJson, outputDir) {
      await import_fs_extra2.default.writeJSON((0, import_path2.join)(outputDir, "builds.json"), buildsJson, { spaces: 2 });
    }
    function normalizeServiceRoutePrefix(routePrefix) {
      let prefix = routePrefix.startsWith("/") ? routePrefix : `/${routePrefix}`;
      if (prefix !== "/" && prefix.endsWith("/")) {
        prefix = prefix.slice(0, -1);
      }
      return prefix;
    }
    function getServicesMergeEntrypoint(service, buildSrc) {
      const routePrefix = typeof service.routePrefix === "string" ? service.routePrefix : "/";
      const normalized = normalizeServiceRoutePrefix(routePrefix);
      const sortKey = String(1e4 - normalized.length).padStart(5, "0");
      return `svc:${sortKey}:${normalized}:${service.name}:${buildSrc}`;
    }
    function attachQueueServiceTrigger(buildOutput, service) {
      const topics = (0, import_build_utils2.getServiceQueueTopicConfigs)(service);
      const consumer = (0, import_build_utils2.sanitizeConsumerName)(
        (0, import_build_utils2.getInternalServiceFunctionPath)(service.name)
      );
      if (service.builder.use !== "@vercel/python" && topics.length > 1) {
        throw new Error(
          `Worker service "${service.name}" has ${topics.length} topics, but multiple topics are only supported for Python workers.`
        );
      }
      for (const topicConfig of topics) {
        const trigger = {
          type: "queue/v2beta",
          topic: topicConfig.topic,
          consumer
        };
        if (topicConfig.retryAfterSeconds !== void 0) {
          trigger.retryAfterSeconds = topicConfig.retryAfterSeconds;
        }
        if (topicConfig.initialDelaySeconds !== void 0) {
          trigger.initialDelaySeconds = topicConfig.initialDelaySeconds;
        }
        if ((0, import_write_build_result3.isLambda)(buildOutput)) {
          appendTrigger(buildOutput, trigger);
        } else {
          for (const output of Object.values(buildOutput)) {
            if ((0, import_write_build_result3.isLambda)(output)) {
              appendTrigger(output, trigger);
            }
          }
        }
      }
    }
    function triggerMatches(trigger, existingTrigger) {
      if (trigger.type === "schedule/v1beta") {
        return trigger.type === existingTrigger.type;
      }
      return trigger.type === existingTrigger.type && trigger.topic === existingTrigger.topic && trigger.consumer === existingTrigger.consumer;
    }
    function appendTrigger(lambda, trigger) {
      const existingTriggers = Array.isArray(lambda.experimentalTriggers) ? lambda.experimentalTriggers : [];
      const alreadyConfigured = existingTriggers.some(
        (existing) => triggerMatches(trigger, existing)
      );
      if (!alreadyConfigured) {
        lambda.experimentalTriggers = [...existingTriggers, trigger];
      }
    }
    async function streamToString(stream) {
      const chunks = [];
      for await (const chunk of stream) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        chunks.push(Uint8Array.from(buffer));
      }
      return Buffer.concat(chunks).toString("utf-8");
    }
  }
});

// ../../internals/cli-builder-integration/dist/index.js
var require_dist4 = __commonJS({
  "../../internals/cli-builder-integration/dist/index.js"(exports, module) {
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
      doBuild: () => import_do_build.doBuild,
      executeBuilder: () => import_execute_builder.executeBuilder,
      sortBuildsForExecution: () => import_execute_builder.sortBuildsForExecution
    });
    module.exports = __toCommonJS(src_exports);
    var import_execute_builder = require_execute_builder();
    var import_do_build = require_do_build();
  }
});

// src/commands/build/index.ts
var import_chalk = __toESM(require_source(), 1);
var import_dotenv = __toESM(require_main(), 1);
var import_fs_extra = __toESM(require_lib(), 1);
import { dirname as dirname2, join as join2, relative as relative2, resolve } from "path";
import { readdirSync, statSync } from "fs";
import {
  normalizePath,
  NowBuildError,
  resetCustomInstallCommandSet,
  Span,
  validateNpmrc,
  glob
} from "@vercel/build-utils";
var import_cli_builder_integration = __toESM(require_dist4(), 1);

// src/util/build/scrub-argv.ts
function scrubArgv(argv) {
  const clonedArgv = [...argv];
  const tokenRE = /^(-[A-Za-z]*[bet]|--(?:build-env|env|token))(=.*)?$/;
  for (let i = 0, len = clonedArgv.length; i < len; i++) {
    const m = clonedArgv[i].match(tokenRE);
    if (m?.[2]) {
      clonedArgv[i] = `${m[1]}=REDACTED`;
    } else if (m && i + 1 < len) {
      clonedArgv[++i] = "REDACTED";
    }
  }
  return clonedArgv;
}

// src/util/telemetry/commands/build/index.ts
var BuildTelemetryClient = class extends TelemetryClient {
  trackCliOptionOutput(path) {
    if (path) {
      this.trackCliOption({
        option: "output",
        value: this.redactedValue
      });
    }
  }
  trackCliOptionTarget(option) {
    if (option) {
      this.trackCliOption({
        option: "target",
        value: this.redactedTargetName(option)
      });
    }
  }
  trackCliFlagProd(flag) {
    if (flag) {
      this.trackCliFlag("prod");
    }
  }
  trackCliFlagYes(flag) {
    if (flag) {
      this.trackCliFlag("yes");
    }
  }
  trackCliFlagStandalone(flag) {
    if (flag) {
      this.trackCliFlag("standalone");
    }
  }
  trackCliOptionId(id) {
    if (id) {
      this.trackCliOption({
        option: "id",
        value: this.redactedValue
      });
    }
  }
};

// src/util/build/repo-root.ts
import { existsSync, readFileSync } from "fs";
import { dirname, join, parse, relative } from "path";
var import_minimatch = __toESM(require_minimatch(), 1);
function findWorkspaceRootCandidates(startDir) {
  const { root } = parse(startDir);
  const candidates = [];
  let dir = startDir;
  for (let i = 0; i < 64; i++) {
    const type = workspaceTypeOf(dir);
    if (type) {
      candidates.unshift({ dir, type });
    }
    if (dir === root)
      break;
    const parent = dirname(dir);
    if (parent === dir)
      break;
    dir = parent;
  }
  return candidates;
}
function workspaceTypeOf(dir) {
  if (existsSync(join(dir, "pnpm-workspace.yaml"))) {
    return "pnpm";
  }
  const pkgPath = join(dir, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      const { workspaces } = pkg;
      if (Array.isArray(workspaces) && workspaces.length > 0 || workspaces && typeof workspaces === "object" && Array.isArray(workspaces.packages) && workspaces.packages.length > 0) {
        return "npm";
      }
    } catch {
    }
  }
  return null;
}
function readWorkspacePatterns(candidate) {
  try {
    if (candidate.type === "pnpm") {
      const doc = js_yaml_default.load(
        readFileSync(join(candidate.dir, "pnpm-workspace.yaml"), "utf8")
      );
      const packages2 = doc?.packages;
      return Array.isArray(packages2) ? packages2.filter((p) => typeof p === "string") : null;
    }
    const pkg = JSON.parse(
      readFileSync(join(candidate.dir, "package.json"), "utf8")
    );
    const { workspaces } = pkg;
    const packages = Array.isArray(workspaces) ? workspaces : workspaces?.packages;
    return Array.isArray(packages) ? packages.filter((p) => typeof p === "string") : null;
  } catch {
    return null;
  }
}
function workspaceClaims(candidate, memberDir) {
  const rel = normalizeRelative(relative(candidate.dir, memberDir));
  if (rel === "") {
    return false;
  }
  const patterns = readWorkspacePatterns(candidate);
  if (!patterns || patterns.length === 0) {
    return false;
  }
  const positives = [];
  const negatives = [];
  for (const pattern of patterns) {
    if (pattern.startsWith("!")) {
      negatives.push(normalizeRelative(pattern.slice(1)));
    } else {
      positives.push(normalizeRelative(pattern));
    }
  }
  const matches = (pattern) => (0, import_minimatch.default)(rel, pattern, { dot: false });
  if (!positives.some(matches) || negatives.some(matches)) {
    return false;
  }
  return existsSync(join(memberDir, "package.json"));
}
function resolvePerDirectoryLinkRoot(anchorDir, rootDirectorySetting) {
  let repoRoot = anchorDir;
  for (const candidate of findWorkspaceRootCandidates(anchorDir)) {
    if (workspaceClaims(candidate, anchorDir)) {
      repoRoot = candidate.dir;
      break;
    }
  }
  const linkLocation = normalizeRelative(relative(repoRoot, anchorDir));
  if (linkLocation === "") {
    return { repoRoot, resolvedRootDirectory: "" };
  }
  const setting = normalizeRelative(rootDirectorySetting ?? "");
  if (setting === "") {
    return { repoRoot, resolvedRootDirectory: linkLocation };
  }
  if (existsSync(join(anchorDir, setting))) {
    return {
      repoRoot,
      resolvedRootDirectory: normalizeRelative(
        relative(repoRoot, join(anchorDir, setting))
      )
    };
  }
  return {
    repoRoot,
    resolvedRootDirectory: linkLocation,
    advisory: `Ignoring "rootDirectory" setting "${setting}" for the project linked in "${anchorDir}": "${join(anchorDir, setting)}" does not exist, so the build will use the linked directory "${linkLocation}" instead. Remove the "rootDirectory" setting, or configure it at the repository root.`
  };
}
function normalizeRelative(p) {
  const normalized = p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "").replace(/\/+$/, "");
  return normalized === "." ? "" : normalized;
}

// src/commands/build/index.ts
function buildCommandWithGlobalFlags(baseSubcommand, argv) {
  const globalFlags = getGlobalFlagsFromArgs(argv.slice(2));
  const full = globalFlags.length ? `${baseSubcommand} ${globalFlags.join(" ")}` : baseSubcommand;
  return getCommandNamePlain(full);
}
async function main(client) {
  const telemetryClient = new BuildTelemetryClient({
    opts: {
      store: client.telemetryEventStore
    }
  });
  const rootSpan = client.rootSpan?.child("vc") ?? new Span({ name: "vc" });
  let { cwd } = client;
  cwd = await resolveProjectCwd(cwd);
  if (process.env.__VERCEL_BUILD_RUNNING) {
    output_manager_default.error(
      `${cmd(
        `${packageName} build`
      )} must not recursively invoke itself. Check the Build Command in the Project Settings or the ${cmd(
        "build"
      )} script in ${cmd("package.json")}`
    );
    output_manager_default.error(
      `Learn More: https://vercel.link/recursive-invocation-of-commands`
    );
    return 1;
  } else {
    process.env.__VERCEL_BUILD_RUNNING = "1";
  }
  let parsedArgs = null;
  const flagsSpecification = getFlagsSpecification(buildCommand.options);
  try {
    parsedArgs = parseArguments(client.argv.slice(2), flagsSpecification);
    telemetryClient.trackCliOptionOutput(parsedArgs.flags["--output"]);
    telemetryClient.trackCliOptionTarget(parsedArgs.flags["--target"]);
    telemetryClient.trackCliFlagProd(parsedArgs.flags["--prod"]);
    telemetryClient.trackCliFlagYes(parsedArgs.flags["--yes"]);
    telemetryClient.trackCliFlagStandalone(parsedArgs.flags["--standalone"]);
    telemetryClient.trackCliOptionId(parsedArgs.flags["--id"]);
    telemetryClient.trackCliOptionProject(parsedArgs.flags["--project"]);
  } catch (error) {
    printError(error);
    return 1;
  }
  if (parsedArgs.flags["--help"]) {
    telemetryClient.trackCliFlagHelp("build");
    output_manager_default.print(help(buildCommand, { columns: client.stderr.columns }));
    return 2;
  }
  const target = parseTarget({
    flagName: "target",
    flags: parsedArgs.flags
  }) || "preview";
  const yes = Boolean(parsedArgs.flags["--yes"]);
  const hasDeprecatedEnvVar = process.env.VERCEL_EXPERIMENTAL_STANDALONE_BUILD === "1";
  if (hasDeprecatedEnvVar) {
    output_manager_default.warn(
      "The VERCEL_EXPERIMENTAL_STANDALONE_BUILD environment variable is deprecated. Please use the --standalone flag instead."
    );
  }
  const standalone = Boolean(
    parsedArgs.flags["--standalone"] || hasDeprecatedEnvVar
  );
  try {
    await validateNpmrc(cwd);
  } catch (err) {
    output_manager_default.prettyError(err);
    return 1;
  }
  const projectNameOrId = parsedArgs.flags["--project"];
  const hasExplicitScope = Boolean(projectNameOrId) && detectExplicitScope(client);
  let link = hasExplicitScope ? null : await rootSpan.child("vc.getProjectLink").trace(() => getProjectLink(client, cwd, projectNameOrId, true));
  if (projectNameOrId && !link) {
    const linkedFromApi = await getLinkedProject(client, {
      cwd,
      projectName: projectNameOrId,
      projectNameIsExplicit: true,
      scopeIsExplicit: hasExplicitScope
    });
    if (linkedFromApi.status === "linked") {
      link = {
        projectId: linkedFromApi.project.id,
        orgId: linkedFromApi.org.id,
        repoRoot: linkedFromApi.repoRoot,
        projectRootDirectory: linkedFromApi.projectRootDirectory
      };
    } else if (linkedFromApi.status === "error") {
      return linkedFromApi.exitCode;
    } else {
      await printProjectNotFoundError(
        client,
        projectNameOrId,
        "build",
        linkedFromApi.orgId
      );
      return 1;
    }
  }
  const invokedCwd = cwd;
  const hasRepoLevelLink = Boolean(link?.repoRoot);
  let projectRootDirectory = link?.projectRootDirectory ?? "";
  if (link?.repoRoot) {
    cwd = client.cwd = link.repoRoot;
  }
  const vercelDir = join2(cwd, projectRootDirectory, VERCEL_DIR);
  let project = await rootSpan.child("vc.readProjectSettings").trace(() => readProjectSettings(vercelDir));
  const isTTY = process.stdin.isTTY;
  while (!project?.settings) {
    let confirmed = yes;
    if (!confirmed) {
      if (client.nonInteractive) {
        outputAgentError(
          client,
          {
            status: AGENT_STATUS.ERROR,
            reason: AGENT_REASON.PROJECT_SETTINGS_REQUIRED,
            message: "No project settings found locally. Run pull to retrieve them, or re-run with --yes to pull automatically.",
            next: [
              {
                command: buildCommandWithGlobalFlags(
                  `pull --yes --environment ${target}`,
                  client.argv
                ),
                when: "retrieve project settings"
              },
              {
                command: buildCommandWithGlobalFlags(
                  "build --yes",
                  client.argv
                ),
                when: "re-run build after pull"
              }
            ]
          },
          1
        );
        return 1;
      }
      if (!isTTY) {
        output_manager_default.print(
          `No Project Settings found locally. Run ${getCommandName(
            "pull --yes"
          )} to retrieve them. In non-interactive mode, set VERCEL_TOKEN for authentication.`
        );
        return 1;
      }
      if (!link) {
        const ensured = await ensureLink("build", client, cwd, {
          projectName: projectNameOrId,
          failIfNotFound: !!projectNameOrId,
          pullEnv: false
        });
        if (typeof ensured === "number") {
          return ensured;
        }
        link = await getProjectLink(client, cwd, projectNameOrId, true);
      }
      confirmed = await client.input.confirm(
        `No Project Settings found locally. Run ${getCommandName(
          "pull"
        )} for retrieving them?`,
        true
      );
    }
    if (!confirmed) {
      if (!client.nonInteractive)
        output_manager_default.print(`Canceled. No Project Settings retrieved.
`);
      return 0;
    }
    const { argv: originalArgv } = client;
    client.cwd = join2(cwd, projectRootDirectory);
    client.setArgv([
      ...originalArgv.slice(0, 2),
      "pull",
      `--environment`,
      target
    ]);
    const result = await pullCommandLogic(
      client,
      client.cwd,
      Boolean(parsedArgs.flags["--yes"]),
      target,
      parsedArgs.flags,
      projectNameOrId
    );
    if (result !== 0) {
      return result;
    }
    client.cwd = cwd;
    client.setArgv(originalArgv);
    project = await readProjectSettings(vercelDir);
  }
  if (!link) {
    link = await getProjectLink(client, cwd, projectNameOrId, true);
  }
  if (!hasRepoLevelLink && link && project?.settings) {
    const resolved = resolvePerDirectoryLinkRoot(
      invokedCwd,
      project.settings.rootDirectory
    );
    if (resolved.advisory) {
      output_manager_default.warn(resolved.advisory);
    }
    if (resolved.resolvedRootDirectory !== "") {
      projectRootDirectory = resolved.resolvedRootDirectory;
      project.settings.rootDirectory = resolved.resolvedRootDirectory;
      cwd = client.cwd = resolved.repoRoot;
    }
  }
  const defaultOutputDir = join2(cwd, projectRootDirectory, import_write_build_result.OUTPUT_DIR);
  const outputDir = parsedArgs.flags["--output"] ? resolve(parsedArgs.flags["--output"]) : defaultOutputDir;
  client.traceDiagnosticsPath = join2(
    outputDir,
    "diagnostics",
    "cli_traces.json"
  );
  await Promise.all([
    import_fs_extra.default.remove(outputDir),
    // Also delete `.vercel/output`, in case the script is targeting Build Output API directly
    outputDir !== defaultOutputDir ? import_fs_extra.default.remove(defaultOutputDir) : void 0
  ]);
  const buildsJson = {
    "//": "This file was generated by the `vercel build` command. It is not part of the Build Output API.",
    target,
    argv: scrubArgv(process.argv),
    cliVersion: pkg_default.version
  };
  const deploymentId = parsedArgs.flags["--id"];
  if (!process.env.VERCEL_BUILD_IMAGE && !deploymentId && !client.nonInteractive) {
    output_manager_default.warn(
      "Build not running on Vercel. System environment variables will not be available."
    );
  }
  const envToUnset = /* @__PURE__ */ new Set(["VERCEL", "NOW_BUILDER"]);
  try {
    const loadEnvSpan = rootSpan.child("vc.loadEnv");
    try {
      if (deploymentId) {
        if (link?.orgId?.startsWith("team_")) {
          client.config.currentTeam = link.orgId;
        }
        output_manager_default.debug(
          `Fetching environment variables for deployment ${deploymentId}`
        );
        const { buildEnv } = await fetchDeploymentBuildEnv(
          client,
          deploymentId
        );
        for (const [key, value] of Object.entries(buildEnv)) {
          envToUnset.add(key);
          process.env[key] = value;
        }
        output_manager_default.debug(
          `Loaded ${Object.keys(buildEnv).length} environment variables from deployment ${deploymentId}`
        );
      } else {
        const envPath = join2(
          cwd,
          projectRootDirectory,
          VERCEL_DIR,
          `.env.${target}.local`
        );
        const dotenvResult = import_dotenv.default.config({
          path: envPath,
          debug: output_manager_default.isDebugEnabled()
        });
        if (dotenvResult.error) {
          output_manager_default.debug(
            `Failed loading environment variables: ${dotenvResult.error}`
          );
        } else if (dotenvResult.parsed) {
          for (const key of Object.keys(dotenvResult.parsed)) {
            envToUnset.add(key);
          }
          output_manager_default.debug(`Loaded environment variables from "${envPath}"`);
        }
      }
    } finally {
      loadEnvSpan.stop();
    }
    if (project.settings.analyticsId) {
      envToUnset.add("VERCEL_ANALYTICS_ID");
      process.env.VERCEL_ANALYTICS_ID = project.settings.analyticsId;
    }
    process.env.VERCEL = "1";
    process.env.NOW_BUILDER = "1";
    let buildResult;
    try {
      buildResult = await rootSpan.child("vc.doBuild").trace(
        (span) => (0, import_cli_builder_integration.doBuild)(
          {
            project,
            buildsJson,
            cwd,
            outputDir,
            span,
            standalone,
            localConfigPath: client.localConfigPath,
            cliVersion: pkg_default.version,
            userAgent: ua_default
          },
          {
            output: output_manager_default,
            importBuilders,
            formatResolvedBuilders: import_import_builders.formatResolvedBuilders,
            writeBuildResult,
            toEnumerableError: (error) => toEnumerableError(error),
            readJSONFile,
            isCantParseJSONFile: (value) => value instanceof CantParseJSONFile,
            validateConfig,
            compileVercelConfig,
            findSourceVercelConfigFile,
            defaultVercelConfigFilename: DEFAULT_VERCEL_CONFIG_FILENAME,
            startBuildTiming: stamp_default
          }
        )
      );
    } finally {
      await rootSpan.stop();
    }
    if (!client.nonInteractive) {
      const relOutputDir = relative2(cwd, outputDir);
      output_manager_default.print(
        `${prependEmoji(
          `Build Completed in ${import_chalk.default.bold(
            relOutputDir.startsWith("..") ? outputDir : relOutputDir
          )} ${import_chalk.default.gray(buildResult.buildDuration)}`,
          emoji("success")
        )}
`
      );
    }
    if (process.env.VERCEL_ANALYZE_BUILD_OUTPUT === "1") {
      await analyzeVcConfigFiles(cwd, outputDir);
    }
    if (client.nonInteractive) {
      const relOutputDir = relative2(cwd, outputDir);
      client.stdout.write(
        `${JSON.stringify(
          {
            status: AGENT_STATUS.OK,
            outputDir,
            outputDirRelative: relOutputDir.startsWith("..") ? outputDir : relOutputDir,
            target,
            message: "Build completed successfully.",
            next: [
              {
                command: buildCommandWithGlobalFlags("deploy", client.argv),
                when: "Deploy the build output"
              }
            ]
          },
          null,
          2
        )}
`
      );
    }
    return 0;
  } catch (err) {
    if (client.nonInteractive) {
      client.stdout.write(
        `${JSON.stringify(
          {
            status: AGENT_STATUS.ERROR,
            reason: "build_failed",
            message: err?.message ?? String(err),
            next: [
              {
                command: buildCommandWithGlobalFlags("pull --yes", client.argv),
                when: "Ensure project settings are present"
              },
              {
                command: buildCommandWithGlobalFlags(
                  "build --yes",
                  client.argv
                ),
                when: "re-run build"
              }
            ]
          },
          null,
          2
        )}
`
      );
    }
    output_manager_default.prettyError(err);
    buildsJson.error = toEnumerableError(err);
    const buildsJsonPath = join2(outputDir, "builds.json");
    const configJsonPath = join2(outputDir, "config.json");
    await import_fs_extra.default.outputJSON(buildsJsonPath, buildsJson, {
      spaces: 2
    });
    await import_fs_extra.default.writeJSON(configJsonPath, { version: 3 }, { spaces: 2 });
    return 1;
  } finally {
    for (const key of envToUnset) {
      delete process.env[key];
    }
    delete process.env.VERCEL_INSTALL_COMPLETED;
    delete process.env.VERCEL_INSTALL_COMPLETED_PATH;
    resetCustomInstallCommandSet();
  }
}
function getFunctionUrlPath(vcConfigPath, outputDir) {
  const funcPath = normalizePath(relative2(outputDir, vcConfigPath)).replace(/^functions\//, "").replace(/\/\.vc-config\.json$/, "").replace(/\.func$/, "");
  return "/" + funcPath.split("/").filter((part) => part && part !== "index").join("/");
}
var LAMBDA_SIZE_LIMIT_MB = 250;
var CLOSE_TO_LIMIT_MB = LAMBDA_SIZE_LIMIT_MB - 5;
function printFileSizeBreakdown(files) {
  const dependencies = /* @__PURE__ */ new Map();
  for (const [bundlePath, sizeMB] of files.entries()) {
    const depKey = bundlePath.split("/").slice(0, 3).join("/");
    dependencies.set(depKey, (dependencies.get(depKey) || 0) + sizeMB);
  }
  const sortedDeps = Array.from(dependencies.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10);
  if (sortedDeps.length > 0) {
    output_manager_default.print(import_chalk.default.yellow("Large dependencies:\n"));
    for (const [dep, size] of sortedDeps) {
      if (size >= 0.5) {
        output_manager_default.print(
          `    ${import_chalk.default.gray("\u2022")} ${dep}: ${import_chalk.default.bold(size.toFixed(2))} MB
`
        );
      }
    }
    output_manager_default.print("\n");
  }
}
async function analyzeVcConfigFiles(cwd, outputDir) {
  const filesObject = await glob("**/.vc-config.json", {
    cwd: outputDir
  });
  const vcConfigFiles = Object.keys(filesObject).filter((relativePath) => !relativePath.includes(".rsc.func")).map((relativePath) => join2(outputDir, relativePath));
  if (vcConfigFiles.length === 0) {
    output_manager_default.print("No functions to analyze.\n");
    return;
  }
  output_manager_default.print(
    `
Analyzing ${vcConfigFiles.length} function${vcConfigFiles.length === 1 ? "" : "s"}...
`
  );
  const results = await Promise.all(
    vcConfigFiles.map((file) => analyzeSingleFunction(file, cwd, outputDir))
  );
  const validResults = results.filter(
    (r) => r !== null
  );
  const sortedResults = validResults.sort((a, b) => b.size - a.size);
  output_manager_default.print(import_chalk.default.bold(`
Serverless function size info:
`));
  let numExceeded = 0;
  for (const result of sortedResults) {
    const exceeded = result.size >= LAMBDA_SIZE_LIMIT_MB;
    const close = result.size >= CLOSE_TO_LIMIT_MB && !exceeded;
    if (exceeded) {
      numExceeded++;
      output_manager_default.print(
        import_chalk.default.yellow(
          `
\u26A0\uFE0F  Max serverless function size of ${LAMBDA_SIZE_LIMIT_MB} MB uncompressed reached
`
        )
      );
    } else if (close) {
      output_manager_default.print(
        import_chalk.default.yellow(
          `
\u26A0\uFE0F  Max serverless function size of ${LAMBDA_SIZE_LIMIT_MB} MB uncompressed almost reached
`
        )
      );
    }
    output_manager_default.print(
      `${import_chalk.default.cyan("Function :")} ${import_chalk.default.cyan.bold(result.path)}
${import_chalk.default.cyan("Size     :")} ${import_chalk.default.cyan.bold(result.size.toFixed(2))} MB
`
    );
    printFileSizeBreakdown(result.files);
  }
  if (numExceeded > 0) {
    throw new NowBuildError({
      code: "NOW_SANDBOX_WORKER_MAX_LAMBDA_SIZE",
      message: `${numExceeded} function${numExceeded === 1 ? "" : "s"} exceeded the uncompressed maximum size of ${LAMBDA_SIZE_LIMIT_MB} MB.`,
      link: "https://vercel.link/serverless-function-size",
      action: "Learn More"
    });
  }
}
async function analyzeSingleFunction(file, cwd, outputDir) {
  try {
    const content = await import_fs_extra.default.readFile(file, "utf8");
    const parsed = JSON.parse(content);
    const funcDir = dirname2(file);
    const funcDirStats = getDirectorySizeInMB(funcDir);
    const filePathMap = parsed.filePathMap && typeof parsed.filePathMap === "object" ? Object.entries(parsed.filePathMap).filter(
      (entry) => typeof entry[1] === "string"
    ).map(([bundlePath, sourcePath]) => ({
      bundlePath,
      sourcePath: join2(cwd, sourcePath)
    })) : [];
    const fsRefStats = getTotalFileSizeInMB(filePathMap);
    const totalSize = funcDirStats.size + fsRefStats.size;
    const allFiles = new Map([...funcDirStats.files, ...fsRefStats.files]);
    const functionUrlPath = getFunctionUrlPath(file, outputDir);
    return {
      path: functionUrlPath,
      size: totalSize,
      files: allFiles
    };
  } catch (error) {
    output_manager_default.warn(`Failed to analyze ${file}: ${error}`);
    return null;
  }
}
function getTotalFileSizeInMB(files) {
  let size = 0;
  const filesSizeMap = /* @__PURE__ */ new Map();
  for (const { bundlePath, sourcePath } of files) {
    try {
      const stats = statSync(sourcePath);
      if (stats.isFile()) {
        const fileSizeMB = stats.size / (1024 * 1024);
        size += fileSizeMB;
        filesSizeMap.set(bundlePath, fileSizeMB);
      }
    } catch {
    }
  }
  return { size, files: filesSizeMap };
}
function getDirectorySizeInMB(dir) {
  let size = 0;
  const filesSizeMap = /* @__PURE__ */ new Map();
  try {
    const entries = readdirSync(dir, { recursive: true });
    for (const entry of entries) {
      const entryPath = typeof entry === "string" ? entry : entry.toString();
      const fullPath = join2(dir, entryPath);
      try {
        const stats = statSync(fullPath);
        if (stats.isFile()) {
          const fileSizeMB = stats.size / (1024 * 1024);
          size += fileSizeMB;
          filesSizeMap.set(normalizePath(entryPath), fileSizeMB);
        }
      } catch {
      }
    }
  } catch {
  }
  return { size, files: filesSizeMap };
}
var INTEGRATIONS_POLL_INTERVAL_MS = 5e3;
var INTEGRATIONS_POLL_TIMEOUT_MS = 3 * 60 * 1e3;
async function fetchDeploymentBuildEnv(client, deploymentId) {
  const deadline = Date.now() + INTEGRATIONS_POLL_TIMEOUT_MS;
  let isPolling = false;
  while (Date.now() < deadline) {
    try {
      return await pullEnvRecords(client, deploymentId, "vercel-cli:pull");
    } catch (err) {
      if (err && typeof err === "object" && "integrationsStatus" in err && err.integrationsStatus === "pending") {
        if (!isPolling) {
          output_manager_default.spinner(
            "Waiting for deployment integrations to finish provisioning..."
          );
          isPolling = true;
        }
        await new Promise(
          (resolve2) => setTimeout(resolve2, INTEGRATIONS_POLL_INTERVAL_MS)
        );
        continue;
      }
      throw err;
    }
  }
  throw new Error(
    "Timed out waiting for deployment integrations to complete provisioning."
  );
}
export {
  main as default
};
