import { createRequire as __createRequire } from 'node:module';
import { fileURLToPath as __fileURLToPath } from 'node:url';
import { dirname as __dirname_ } from 'node:path';
const require = __createRequire(import.meta.url);
const __filename = __fileURLToPath(import.meta.url);
const __dirname = __dirname_(__filename);
import {
  BUILD_LABEL
} from "./chunks/chunk-GGPE5377.js";
import {
  help
} from "./chunks/chunk-STPH4Y62.js";
import {
  box,
  canAutoUpdate,
  did_you_mean_default,
  executeUpgrade,
  hasAutoUpdatePreference,
  isVersionPinned,
  matchesCliApiTag,
  setAutoUpdate,
  tryOpenApiFallback
} from "./chunks/chunk-KBUCAAG6.js";
import "./chunks/chunk-FGDKMNEN.js";
import {
  getUpdateCommand
} from "./chunks/chunk-ANIKVXGZ.js";
import {
  promptMissingCredentials
} from "./chunks/chunk-CURHMEJX.js";
import {
  require_ci_info
} from "./chunks/chunk-NN2W7WFC.js";
import {
  Client,
  getAuthConfigFilePath,
  getConfigFilePath,
  readAuthConfigFile,
  readConfigFile,
  writeToConfigFile
} from "./chunks/chunk-WODLA275.js";
import {
  getGlobalPathConfig,
  highlight
} from "./chunks/chunk-JKQWQA2T.js";
import {
  shouldPrintVersionBanner,
  wantsMachineReadableOutput
} from "./chunks/chunk-KXDWXXJH.js";
import {
  commandNames,
  commands
} from "./chunks/chunk-7GE2K2WR.js";
import "./chunks/chunk-2MF3ZAVW.js";
import "./chunks/chunk-WC7IINFV.js";
import "./chunks/chunk-RIB4S2IB.js";
import "./chunks/chunk-GFCTRJI5.js";
import "./chunks/chunk-EG5BSAXD.js";
import "./chunks/chunk-M22O6CYY.js";
import "./chunks/chunk-GMWRTZVZ.js";
import "./chunks/chunk-3KNPVXJ3.js";
import "./chunks/chunk-3L2YLLHC.js";
import "./chunks/chunk-UMA66MKW.js";
import "./chunks/chunk-7QVJTI5H.js";
import "./chunks/chunk-O5GNPPTU.js";
import {
  require_semver
} from "./chunks/chunk-IB5L4LKZ.js";
import "./chunks/chunk-7PEQVFHI.js";
import "./chunks/chunk-XI6NJLI4.js";
import {
  getLinkFromDir,
  getScope,
  getTeams,
  getUser,
  getVercelDirectory,
  humanizePath,
  isAppPrincipalEnabled,
  param,
  readJSONFile,
  require_dist as require_dist2,
  require_lib,
  resolveAppTokenScope
} from "./chunks/chunk-KDL2L4KL.js";
import {
  TelemetryClient,
  TelemetryEventStore,
  isNativeBinaryInstall
} from "./chunks/chunk-CYNB6LL4.js";
import "./chunks/chunk-J5ZEHLFM.js";
import "./chunks/chunk-GGP5R3FU.js";
import {
  printError
} from "./chunks/chunk-VAFU7DXZ.js";
import {
  getArgs,
  parseArguments
} from "./chunks/chunk-XLKFJPMT.js";
import {
  APIError,
  CantFindConfig,
  CantParseJSONFile,
  DeprecatedNowJson,
  WorkingDirectoryDoesNotExist,
  cmd,
  getTitleName
} from "./chunks/chunk-SOFC4MLS.js";
import {
  pkg_default
} from "./chunks/chunk-P4QNYOFB.js";
import {
  setFetchDispatcher
} from "./chunks/chunk-52QYYTM5.js";
import {
  output_manager_default,
  require_dist
} from "./chunks/chunk-OX7KI3LF.js";
import {
  require_source
} from "./chunks/chunk-S7KYDPEM.js";
import {
  __commonJS,
  __require,
  __toESM
} from "./chunks/chunk-TZ2YI2VH.js";

// ../../node_modules/.pnpm/epipebomb@1.0.0/node_modules/epipebomb/epipebomb.js
var require_epipebomb = __commonJS({
  "../../node_modules/.pnpm/epipebomb@1.0.0/node_modules/epipebomb/epipebomb.js"(exports, module) {
    module.exports = epipeBomb;
    function epipeBomb(stream, callback) {
      if (stream == null)
        stream = process.stdout;
      if (callback == null)
        callback = process.exit;
      function epipeFilter(err) {
        if (err.code === "EPIPE")
          return callback();
        if (stream.listeners("error").length <= 1) {
          stream.removeAllListeners();
          stream.emit("error", err);
          stream.on("error", epipeFilter);
        }
      }
      stream.on("error", epipeFilter);
    }
  }
});

// ../../node_modules/.pnpm/os-paths@4.4.0/node_modules/os-paths/src/lib/index.js
var require_lib2 = __commonJS({
  "../../node_modules/.pnpm/os-paths@4.4.0/node_modules/os-paths/src/lib/index.js"(exports, module) {
    "use strict";
    var os = __require("os");
    var paths = __require("path");
    var isWinOS = /^win/i.test(process.platform);
    function normalize_path(path2) {
      return paths.normalize(paths.join(path2, "."));
    }
    var base = () => {
      const { env } = process;
      const object = {};
      object.home = () => normalize_path(os.homedir ? os.homedir() : env.HOME);
      object.temp = () => normalize_path(os.tmpdir ? os.tmpdir() : env.TMPDIR || env.TEMP || env.TMP);
      return object;
    };
    var windows = () => {
      const { env } = process;
      const object = {};
      object.home = () => normalize_path(
        os.homedir ? os.homedir() : env.USERPROFILE || paths.join(env.HOMEDRIVE, env.HOMEPATH) || env.HOME
      );
      object.temp = () => normalize_path(
        os.tmpdir ? os.tmpdir() : env.TEMP || env.TMP || paths.join(env.LOCALAPPDATA || env.SystemRoot || env.windir, "Temp")
      );
      return object;
    };
    var _OSPaths = class __OSPaths {
      constructor() {
        const OSPaths = function() {
          return new __OSPaths();
        };
        this._fn = OSPaths;
        const extension = isWinOS ? windows() : base();
        Object.keys(extension).forEach((key) => {
          this._fn[key] = extension[key];
        });
        return this._fn;
      }
    };
    module.exports = new _OSPaths();
  }
});

// ../../node_modules/.pnpm/xdg-portable@7.3.0/node_modules/xdg-portable/src/lib/index.js
var require_lib3 = __commonJS({
  "../../node_modules/.pnpm/xdg-portable@7.3.0/node_modules/xdg-portable/src/lib/index.js"(exports, module) {
    "use strict";
    var path2 = __require("path");
    var osPaths = require_lib2();
    var linux = () => {
      const object = {};
      object.cache = () => process.env.XDG_CACHE_HOME || path2.join(osPaths.home() || osPaths.temp(), ".cache");
      object.config = () => process.env.XDG_CONFIG_HOME || path2.join(osPaths.home() || osPaths.temp(), ".config");
      object.data = () => process.env.XDG_DATA_HOME || path2.join(osPaths.home() || osPaths.temp(), ".local", "share");
      object.runtime = () => process.env.XDG_RUNTIME_DIR || void 0;
      object.state = () => process.env.XDG_STATE_HOME || path2.join(osPaths.home() || osPaths.temp(), ".local", "state");
      return object;
    };
    var macos = () => {
      const object = {};
      object.cache = () => process.env.XDG_CACHE_HOME || path2.join(path2.join(osPaths.home() || osPaths.temp(), "Library"), "Caches");
      object.config = () => process.env.XDG_CONFIG_HOME || path2.join(path2.join(osPaths.home() || osPaths.temp(), "Library"), "Preferences");
      object.data = () => process.env.XDG_DATA_HOME || path2.join(path2.join(osPaths.home() || osPaths.temp(), "Library"), "Application Support");
      object.runtime = () => process.env.XDG_RUNTIME_DIR || void 0;
      object.state = () => process.env.XDG_STATE_HOME || path2.join(path2.join(osPaths.home() || osPaths.temp(), "Library"), "State");
      return object;
    };
    var windows = () => {
      const object = {};
      object.cache = () => {
        const localAppData = process.env.LOCALAPPDATA || path2.join(osPaths.home() || osPaths.temp(), "AppData", "Local");
        return process.env.XDG_CACHE_HOME || path2.join(localAppData, "xdg.cache");
      };
      object.config = () => {
        const appData = process.env.APPDATA || path2.join(osPaths.home() || osPaths.temp(), "AppData", "Roaming");
        return process.env.XDG_CONFIG_HOME || path2.join(appData, "xdg.config");
      };
      object.data = () => {
        const appData = process.env.APPDATA || path2.join(osPaths.home() || osPaths.temp(), "AppData", "Roaming");
        return process.env.XDG_DATA_HOME || path2.join(appData, "xdg.data");
      };
      object.runtime = () => process.env.XDG_RUNTIME_DIR || void 0;
      object.state = () => {
        const localAppData = process.env.LOCALAPPDATA || path2.join(osPaths.home() || osPaths.temp(), "AppData", "Local");
        return process.env.XDG_STATE_HOME || path2.join(localAppData, "xdg.state");
      };
      return object;
    };
    var _XDGPortable = () => {
      const XDGPortable = function() {
        return _XDGPortable();
      };
      let extension = {};
      if (/^darwin$/i.test(process.platform)) {
        extension = macos();
      } else if (/^win/i.test(process.platform)) {
        extension = windows();
      } else {
        extension = linux();
      }
      extension.configDirs = () => {
        const dirs = [];
        dirs.push(extension.config());
        if (process.env.XDG_CONFIG_DIRS) {
          dirs.push(...process.env.XDG_CONFIG_DIRS.split(path2.delimiter));
        }
        return dirs;
      };
      extension.dataDirs = () => {
        const dirs = [];
        dirs.push(extension.data());
        if (process.env.XDG_DATA_DIRS) {
          dirs.push(...process.env.XDG_DATA_DIRS.split(path2.delimiter));
        }
        return dirs;
      };
      Object.keys(extension).forEach((key) => {
        XDGPortable[key] = extension[key];
      });
      return XDGPortable;
    };
    module.exports = _XDGPortable();
  }
});

// ../../node_modules/.pnpm/xdg-app-paths@5.1.0/node_modules/xdg-app-paths/index.js
var require_xdg_app_paths = __commonJS({
  "../../node_modules/.pnpm/xdg-app-paths@5.1.0/node_modules/xdg-app-paths/index.js"(exports, module) {
    "use strict";
    var path2 = __require("path");
    var os = __require("os");
    var xdg = require_lib3();
    var isWinOS = /^win/i.test(process.platform);
    function _normalizeOptions(options, isolated) {
      options = options || {};
      if (typeof options !== "object") {
        options = { isolated: options };
      }
      options.isolated = options.isolated === void 0 || options.isolated === null ? isolated : options.isolated;
      if (typeof options.isolated !== "boolean") {
        throw new TypeError(`Expected boolean for "isolated" argument, got ${typeof options.isolated}`);
      }
      return options;
    }
    var base = (name, isolated) => {
      const object = {};
      object.cache = (options = { isolated: null }) => {
        options = _normalizeOptions(options, isolated);
        return path2.join(xdg.cache(), options.isolated ? name : "");
      };
      object.config = (options = { isolated: null }) => {
        options = _normalizeOptions(options, isolated);
        return path2.join(xdg.config(), options.isolated ? name : "");
      };
      object.data = (options = { isolated: null }) => {
        options = _normalizeOptions(options, isolated);
        return path2.join(xdg.data(), options.isolated ? name : "");
      };
      object.runtime = (options = { isolated: null }) => {
        options = _normalizeOptions(options, isolated);
        return xdg.runtime() ? path2.join(xdg.runtime(), options.isolated ? name : "") : void 0;
      };
      object.state = (options = { isolated: null }) => {
        options = _normalizeOptions(options, isolated);
        return path2.join(xdg.state(), options.isolated ? name : "");
      };
      object.configDirs = (options = { isolated: null }) => {
        options = _normalizeOptions(options, isolated);
        return xdg.configDirs().map((s) => path2.join(s, options.isolated ? name : ""));
      };
      object.dataDirs = (options = { isolated: null }) => {
        options = _normalizeOptions(options, isolated);
        return xdg.dataDirs().map((s) => path2.join(s, options.isolated ? name : ""));
      };
      return object;
    };
    var windows = (name, isolated) => {
      const { env } = process;
      const homedir2 = os.homedir();
      const tmpdir = os.tmpdir();
      const appData = env.APPDATA || path2.join(homedir2 || tmpdir, "AppData", "Roaming");
      const localAppData = env.LOCALAPPDATA || path2.join(homedir2 || tmpdir, "AppData", "Local");
      const object = {};
      object.cache = (options = { isolated: null }) => {
        options = _normalizeOptions(options, isolated);
        return !options.isolated || env.XDG_CACHE_HOME ? path2.join(xdg.cache(), options.isolated ? name : "") : path2.join(localAppData, options.isolated ? name : "", "Cache");
      };
      object.config = (options = { isolated: null }) => {
        options = _normalizeOptions(options, isolated);
        const config2 = !options.isolated || env.XDG_CONFIG_HOME ? path2.join(xdg.config(), options.isolated ? name : "") : path2.join(appData, options.isolated ? name : "", "Config");
        return config2;
      };
      object.data = (options = { isolated: null }) => {
        options = _normalizeOptions(options, isolated);
        const data = !options.isolated || env.XDG_DATA_HOME ? path2.join(xdg.data(), options.isolated ? name : "") : path2.join(appData, options.isolated ? name : "", "Data");
        return data;
      };
      object.runtime = (options = { isolated: null }) => {
        options = _normalizeOptions(options, isolated);
        return xdg.runtime() ? path2.join(xdg.runtime(), options.isolated ? name : "") : void 0;
      };
      object.state = (options = { isolated: null }) => {
        options = _normalizeOptions(options, isolated);
        return !options.isolated || env.XDG_STATE_HOME ? path2.join(xdg.state(), options.isolated ? name : "") : path2.join(localAppData, options.isolated ? name : "", "State");
      };
      object.configDirs = (options = { isolated: null }) => {
        options = _normalizeOptions(options, isolated);
        const dirs = [object.config(options)];
        if (env.XDG_CONFIG_DIRS) {
          dirs.push(...env.XDG_CONFIG_DIRS.split(path2.delimiter).map((s) => path2.join(s, options.isolated ? name : "")));
        }
        return dirs;
      };
      object.dataDirs = (options = { isolated: null }) => {
        options = _normalizeOptions(options, isolated);
        const dirs = [object.data(options)];
        if (env.XDG_DATA_DIRS) {
          dirs.push(...env.XDG_DATA_DIRS.split(path2.delimiter).map((s) => path2.join(s, options.isolated ? name : "")));
        }
        return dirs;
      };
      return object;
    };
    var _XDGAppPaths = class __XDGAppPaths {
      constructor(options = { name: null, suffix: null, isolated: true }) {
        const XDGAppPaths2 = function(options2 = { name: null, suffix: null, isolated: true }) {
          return new __XDGAppPaths(options2);
        };
        this._fn = XDGAppPaths2;
        options = options || {};
        if (typeof options !== "object") {
          options = { name: options };
        }
        let name = options.name || "";
        if (typeof name !== "string") {
          throw new TypeError(`Expected string for "name" argument, got ${typeof name}`);
        }
        const suffix = options.suffix || "";
        if (typeof suffix !== "string") {
          throw new TypeError(`Expected string for "suffix" argument, got ${typeof suffix}`);
        }
        const isolated = options.isolated === void 0 || options.isolated === null ? true : options.isolated;
        if (typeof isolated !== "boolean") {
          throw new TypeError(`Expected boolean for "isolated" argument, got ${typeof isolated}`);
        }
        if (!name) {
          name = path2.parse(process.pkg ? process.execPath : __require.main ? __require.main.filename : process.argv[0]).name;
        }
        if (suffix) {
          name += suffix;
        }
        this._fn.$name = () => name;
        this._fn.$isolated = () => isolated;
        const extension = isWinOS ? windows(name, isolated) : base(name, isolated);
        Object.keys(extension).forEach((key) => {
          this._fn[key] = extension[key];
        });
        return this._fn;
      }
    };
    module.exports = new _XDGAppPaths();
  }
});

// src/util/get-latest-version/fetch-dist-tags.cjs
var require_fetch_dist_tags = __commonJS({
  "src/util/get-latest-version/fetch-dist-tags.cjs"(exports, module) {
    "use strict";
    var https = __require("https");
    function fetchDistTags2(name, options) {
      const timeout = options && options.timeout || 3e3;
      const agent = new https.Agent({
        keepAlive: true,
        maxSockets: 15
        // See: `npm config get maxsockets`
      });
      const headers = {
        accept: "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*"
      };
      const url = `https://registry.npmjs.org/-/package/${name}/dist-tags`;
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          req.destroy();
          resolve(void 0);
        }, timeout);
        const req = https.get(url, { agent, headers }, (res) => {
          let buf = "";
          res.on("data", (chunk) => {
            buf += chunk;
          });
          res.on("end", () => {
            clearTimeout(timer);
            try {
              if (res.statusCode && res.statusCode >= 400) {
                resolve(void 0);
                return;
              }
              resolve(JSON.parse(buf));
            } catch {
              resolve(void 0);
            }
          });
        });
        req.on("error", () => {
          clearTimeout(timer);
          resolve(void 0);
        });
      });
    }
    module.exports = { fetchDistTags: fetchDistTags2 };
  }
});

// src/index.ts
var import_error_utils3 = __toESM(require_dist(), 1);
var import_fs_extra2 = __toESM(require_lib(), 1);
var import_chalk = __toESM(require_source(), 1);
var import_semver2 = __toESM(require_semver(), 1);
var import_epipebomb = __toESM(require_epipebomb(), 1);
import { join as join2 } from "path";
import { existsSync as existsSync2 } from "fs";

// src/util/get-latest-version/index.ts
var import_semver = __toESM(require_semver(), 1);
var import_xdg_app_paths = __toESM(require_xdg_app_paths(), 1);
var import_fs_extra = __toESM(require_lib(), 1);
import { dirname, parse as parsePath, resolve as resolvePath } from "path";
import { spawn } from "child_process";
var import_fetch_dist_tags = __toESM(require_fetch_dist_tags(), 1);
function getLatestVersion({
  cacheDir = (0, import_xdg_app_paths.default)("com.vercel.cli").cache(),
  distTag = "latest",
  notifyInterval = 1e3 * 60 * 60 * 24 * 3,
  // 3 days
  pkg,
  updateCheckInterval = 1e3 * 60 * 60 * 24,
  // 1 day
  consumeNotification = true
}) {
  if (!pkg || typeof pkg !== "object" || !pkg.name || typeof pkg.name !== "string") {
    throw new TypeError("Expected package to be an object with a package name");
  }
  const cacheFile = resolvePath(
    cacheDir,
    "package-updates",
    `${pkg.name}-${distTag}.json`
  );
  let cache;
  try {
    cache = (0, import_fs_extra.readJSONSync)(cacheFile);
  } catch (err) {
    if (err.code !== "ENOENT") {
      output_manager_default?.debug(`Error reading latest package cache file: ${err}`);
    }
  }
  if (!cache || !cache.expireAt || cache.expireAt <= Date.now()) {
    spawnWorker({
      cacheFile,
      distTag,
      name: pkg.name,
      updateCheckInterval
    });
  }
  if (cache) {
    const shouldNotify = !cache.notifyAt || cache.notifyAt <= Date.now();
    let updateAvailable = false;
    if (cache.version && pkg.version) {
      updateAvailable = import_semver.default.lt(pkg.version, cache.version);
    }
    if (shouldNotify && updateAvailable) {
      if (consumeNotification) {
        cache.notifyAt = Date.now() + notifyInterval;
        (0, import_fs_extra.outputJSONSync)(cacheFile, cache);
      }
      return cache.version;
    }
  }
}
function spawnWorker(payload) {
  let dir = dirname(__filename);
  let script = resolvePath(dir, "dist", "get-latest-worker.cjs");
  const { root } = parsePath(dir);
  while (!(0, import_fs_extra.existsSync)(script)) {
    dir = dirname(dir);
    if (dir === root) {
      output_manager_default?.debug("Failed to find the get latest worker script!");
      return;
    }
    script = resolvePath(dir, "dist", "get-latest-worker.cjs");
  }
  output_manager_default?.debug(`Spawning ${script}`);
  const args = [script];
  if (output_manager_default?.debugEnabled) {
    args.push("--debug");
  }
  const worker = spawn(process.execPath, args, {
    stdio: ["inherit", "inherit", "inherit", "ipc"],
    windowsHide: true
  });
  const workerReadyTimer = setTimeout(() => worker.kill(), 2e3);
  const onClose = (code) => {
    output_manager_default?.debug(`Get latest worker exited (code ${code})`);
  };
  worker.on("close", onClose);
  worker.on("error", (err) => {
    output_manager_default?.log(`Failed to spawn get latest worker: ${err.stack}`);
  });
  worker.once("message", () => {
    clearTimeout(workerReadyTimer);
    worker.removeListener("close", onClose);
    worker.send(payload);
    worker.unref();
  });
}
async function fetchLatestVersion({
  name,
  distTag = "latest",
  timeout = 3e3
}) {
  const tags = await (0, import_fetch_dist_tags.fetchDistTags)(name, { timeout });
  return tags?.[distTag];
}
function updateLatestVersionCache({
  cacheDir = (0, import_xdg_app_paths.default)("com.vercel.cli").cache(),
  distTag = "latest",
  name,
  version,
  updateCheckInterval = 1e3 * 60 * 60 * 24
  // 1 day
}) {
  const cacheFile = resolvePath(
    cacheDir,
    "package-updates",
    `${name}-${distTag}.json`
  );
  let notifyAt;
  try {
    const existing = (0, import_fs_extra.readJSONSync)(cacheFile);
    notifyAt = existing?.notifyAt;
  } catch {
  }
  (0, import_fs_extra.outputJSONSync)(cacheFile, {
    expireAt: Date.now() + updateCheckInterval,
    notifyAt,
    version
  });
}

// src/index.ts
import { URL } from "url";

// src/util/get-sentry.ts
var sentry;
async function getSentry() {
  if (!sentry) {
    const [SentryModule, { SENTRY_DSN }, { default: pkg }] = await Promise.all([
      import("./chunks/cjs-DV4RM7XU.js"),
      import("./chunks/constants-YMCRE6IG.js"),
      import("./chunks/pkg-56KRLZ5K.js")
    ]);
    const Sentry = "init" in SentryModule ? SentryModule : SentryModule.default;
    Sentry.init({
      dsn: SENTRY_DSN,
      release: `vercel-cli@${pkg.version}`,
      environment: "stable",
      autoSessionTracking: false
    });
    sentry = Sentry;
  }
  return sentry;
}

// src/util/handle-command-typo.ts
function handleCommandTypo({
  command,
  availableCommands,
  threshold = 0.7
}) {
  if (!command || command.startsWith("-")) {
    return false;
  }
  const suggestion = did_you_mean_default(command, availableCommands, threshold);
  if (suggestion) {
    output_manager_default.error(
      `${param(command)} is not a valid target directory or subcommand. Did you mean ${param(suggestion)}?`
    );
    return true;
  }
  return false;
}

// src/util/report-error.ts
var import_error_utils = __toESM(require_dist(), 1);
async function reportError(sentry2, client2, error) {
  if (ignoreError(error)) {
    return;
  }
  let user;
  let team;
  let scopeError;
  try {
    ({ user, team } = await getScope(client2));
  } catch (err) {
    if ((0, import_error_utils.isError)(err)) {
      scopeError = err;
    }
  }
  sentry2.withScope((scope) => {
    if (user) {
      const spec = {
        email: user.email,
        id: user.id,
        username: user.username,
        name: user.name
      };
      scope.setUser(spec);
    }
    if (team) {
      scope.setTag("currentTeam", team.id);
    }
    if (scopeError) {
      scope.setExtra("scopeError", {
        name: scopeError.name,
        message: scopeError.message,
        stack: scopeError.stack
      });
    }
    let args;
    let argsError;
    try {
      args = getArgs(process.argv.slice(2), {});
    } catch (err) {
      if ((0, import_error_utils.isError)(err)) {
        argsError = err;
      }
    }
    if (args) {
      const flags = ["--env", "--build-env", "--token"];
      for (const flag of flags) {
        if (args[flag])
          args[flag] = "REDACTED";
      }
      if (args._.length >= 4 && args._[0].startsWith("secret") && args._[1] === "add") {
        args._[3] = "REDACTED";
      }
      scope.setExtra("args", args);
    } else {
      let msg = "Unable to parse args";
      if (argsError) {
        msg += `: ${argsError}`;
      }
      scope.setExtra("args", msg);
    }
    scope.setExtra("node", {
      execPath: process.execPath,
      version: process.version,
      platform: process.platform
    });
    sentry2.captureException(error);
  });
  const sentryClient = sentry2.getCurrentHub().getClient();
  if (sentryClient) {
    await sentryClient.close();
  }
}
function ignoreError(error) {
  return (0, import_error_utils.isError)(error) && error.message.includes("uv_cwd");
}

// src/util/get-config.ts
var import_client = __toESM(require_dist2(), 1);
import path from "path";
var import_error_utils2 = __toESM(require_dist(), 1);
var config;
async function earlyGetConfig(configFile) {
  if (config) {
    return config;
  }
  let localPath;
  try {
    localPath = process.cwd();
  } catch (err) {
    if ((0, import_error_utils2.isErrnoException)(err) && err.code === "ENOENT") {
      return new WorkingDirectoryDoesNotExist();
    }
    throw err;
  }
  if (configFile) {
    const localFilePath = path.resolve(localPath, configFile);
    output_manager_default.debug(
      `Found config in provided --local-config path ${localFilePath}`
    );
    const localConfig = await readJSONFile(localFilePath);
    if (localConfig instanceof CantParseJSONFile) {
      return localConfig;
    }
    if (localConfig === null) {
      return new CantFindConfig([humanizePath(localFilePath)]);
    }
    config = localConfig;
    config[import_client.fileNameSymbol] = configFile;
    return config;
  }
  const vercelFilePath = path.resolve(localPath, "vercel.json");
  const nowFilePath = path.resolve(localPath, "now.json");
  const [vercelConfig, nowConfig] = await Promise.all([
    readJSONFile(vercelFilePath),
    readJSONFile(nowFilePath)
  ]);
  if (vercelConfig instanceof CantParseJSONFile) {
    return vercelConfig;
  }
  if (nowConfig instanceof CantParseJSONFile) {
    return nowConfig;
  }
  if (vercelConfig !== null) {
    output_manager_default.debug(`Found config in file "${vercelFilePath}"`);
    config = vercelConfig;
    config[import_client.fileNameSymbol] = "vercel.json";
    return config;
  }
  if (nowConfig !== null) {
    return new DeprecatedNowJson(nowFilePath);
  }
  return new CantFindConfig([vercelFilePath].map(humanizePath));
}

// src/index.ts
import { getDefaultAuthConfig, defaultGlobalConfig } from "@vercel/cli-config";

// src/util/telemetry/root.ts
var import_ci_info = __toESM(require_ci_info(), 1);
var RootTelemetryClient = class extends TelemetryClient {
  trackCliExtension() {
    this.trackExtension();
  }
  trackCliDefaultDeploy(defaultDeploy) {
    if (defaultDeploy) {
      this.trackDefaultDeploy();
    }
  }
  trackCliCommandAgent(actual) {
    this.trackCliCommand({
      command: "agent",
      value: actual
    });
  }
  trackCliCommandAgentRuns(actual) {
    this.trackCliCommand({
      command: "agent-runs",
      value: actual
    });
  }
  trackCliCommandAiGateway(actual) {
    this.trackCliCommand({
      command: "ai-gateway",
      value: actual
    });
  }
  trackCliCommandAlias(actual) {
    this.trackCliCommand({
      command: "alias",
      value: actual
    });
  }
  trackCliCommandActivity(actual) {
    this.trackCliCommand({
      command: "activity",
      value: actual
    });
  }
  trackCliCommandAlerts(actual) {
    this.trackCliCommand({
      command: "alerts",
      value: actual
    });
  }
  trackCliCommandApi(actual) {
    this.trackCliCommand({
      command: "api",
      value: actual
    });
  }
  trackCliCommandBisect(actual) {
    this.trackCliCommand({
      command: "bisect",
      value: actual
    });
  }
  trackCliCommandBlob(actual) {
    this.trackCliCommand({
      command: "blob",
      value: actual
    });
  }
  trackCliCommandBuild(actual) {
    this.trackCliCommand({
      command: "build",
      value: actual
    });
  }
  trackCliCommandBuy(actual) {
    this.trackCliCommand({
      command: "buy",
      value: actual
    });
  }
  trackCliCommandCache(actual) {
    this.trackCliCommand({
      command: "cache",
      value: actual
    });
  }
  trackCliCommandCerts(actual) {
    this.trackCliCommand({
      command: "certs",
      value: actual
    });
  }
  trackCliCommandChangelog(actual) {
    this.trackCliCommand({
      command: "changelog",
      value: actual
    });
  }
  trackCliCommandComments(actual) {
    this.trackCliCommand({
      command: "comments",
      value: actual
    });
  }
  trackCliCommandConnex(actual) {
    this.trackCliCommand({
      command: "connect",
      value: actual
    });
  }
  trackCliCommandContract(actual) {
    this.trackCliCommand({
      command: "contract",
      value: actual
    });
  }
  trackCliCommandCrons(actual) {
    this.trackCliCommand({
      command: "crons",
      value: actual
    });
  }
  trackCliCommandCurl(actual) {
    this.trackCliCommand({
      command: "curl",
      value: actual
    });
  }
  trackCliCommandDeploy(actual) {
    this.trackCliCommand({
      command: "deploy",
      value: actual
    });
  }
  trackCliCommandDeployHooks(actual) {
    this.trackCliCommand({
      command: "deploy-hooks",
      value: actual
    });
  }
  trackCliCommandDev(actual) {
    this.trackCliCommand({
      command: "dev",
      value: actual
    });
  }
  trackCliCommandDomains(actual) {
    this.trackCliCommand({
      command: "domains",
      value: actual
    });
  }
  trackCliCommandDns(actual) {
    this.trackCliCommand({
      command: "dns",
      value: actual
    });
  }
  trackCliCommandEnv(actual) {
    this.trackCliCommand({
      command: "env",
      value: actual
    });
  }
  trackCliCommandFirewall(actual) {
    this.trackCliCommand({
      command: "firewall",
      value: actual
    });
  }
  trackCliCommandFlags(actual) {
    this.trackCliCommand({
      command: "flags",
      value: actual
    });
  }
  trackCliCommandGit(actual) {
    this.trackCliCommand({
      command: "git",
      value: actual
    });
  }
  trackCliCommandGlobalConfig(actual) {
    this.trackCliCommand({
      command: "global-config",
      value: actual
    });
  }
  trackCliCommandGuidance(actual) {
    this.trackCliCommand({
      command: "guidance",
      value: actual
    });
  }
  trackCliCommandHelp(actual) {
    this.trackCliCommand({
      command: "help",
      value: actual
    });
  }
  trackCliCommandHttpstat(actual) {
    this.trackCliCommand({
      command: "httpstat",
      value: actual
    });
  }
  trackCliCommandInit(actual) {
    this.trackCliCommand({
      command: "init",
      value: actual
    });
  }
  trackCliCommandInspect(actual) {
    this.trackCliCommand({
      command: "inspect",
      value: actual
    });
  }
  trackCliCommandInstall(actual) {
    this.trackCliCommand({
      command: "install",
      value: actual
    });
  }
  trackCliCommandIntegration(actual) {
    this.trackCliCommand({
      command: "integration",
      value: actual
    });
  }
  trackCliCommandIntegrationResource(actual) {
    this.trackCliCommand({
      command: "integration-resource",
      value: actual
    });
  }
  trackCliCommandKms(actual) {
    this.trackCliCommand({
      command: "kms",
      value: actual
    });
  }
  trackCliCommandLink(actual) {
    this.trackCliCommand({
      command: "link",
      value: actual
    });
  }
  trackCliCommandList(actual) {
    this.trackCliCommand({
      command: "list",
      value: actual
    });
  }
  trackCliCommandLogin(actual) {
    this.trackCliCommand({
      command: "login",
      value: actual
    });
  }
  trackCliCommandLogout(actual) {
    this.trackCliCommand({
      command: "logout",
      value: actual
    });
  }
  trackCliCommandLogs(actual) {
    this.trackCliCommand({
      command: "logs",
      value: actual
    });
  }
  trackCliCommandMetrics(actual) {
    this.trackCliCommand({
      command: "metrics",
      value: actual
    });
  }
  trackCliCommandMicrofrontends(actual) {
    this.trackCliCommand({
      command: "microfrontends",
      value: actual
    });
  }
  trackCliCommandOpen(actual) {
    this.trackCliCommand({
      command: "open",
      value: actual
    });
  }
  trackCliCommandProject(actual) {
    this.trackCliCommand({
      command: "project",
      value: actual
    });
  }
  trackCliCommandPromote(actual) {
    this.trackCliCommand({
      command: "promote",
      value: actual
    });
  }
  trackCliCommandPull(actual) {
    this.trackCliCommand({
      command: "pull",
      value: actual
    });
  }
  trackCliCommandRollback(actual) {
    this.trackCliCommand({
      command: "rollback",
      value: actual
    });
  }
  trackCliCommandRollingRelease(actual) {
    this.trackCliCommand({
      command: "rolling-release",
      value: actual
    });
  }
  trackCliCommandRedeploy(actual) {
    this.trackCliCommand({
      command: "redeploy",
      value: actual
    });
  }
  trackCliCommandRedirects(actual) {
    this.trackCliCommand({
      command: "redirects",
      value: actual
    });
  }
  trackCliCommandRoutes(actual) {
    this.trackCliCommand({
      command: "routes",
      value: actual
    });
  }
  trackCliCommandRemove(actual) {
    this.trackCliCommand({
      command: "remove",
      value: actual
    });
  }
  trackCliCommandSkills(actual) {
    this.trackCliCommand({
      command: "skills",
      value: actual
    });
  }
  trackCliCommandSandbox(actual) {
    this.trackCliCommand({
      command: "sandbox",
      value: actual
    });
  }
  trackCliCommandSecurity(actual) {
    this.trackCliCommand({
      command: "security",
      value: actual
    });
  }
  trackCliCommandTarget(actual) {
    this.trackCliCommand({
      command: "target",
      value: actual
    });
  }
  trackCliCommandTeams(actual) {
    this.trackCliCommand({
      command: "teams",
      value: actual
    });
  }
  trackCliCommandTokens(actual) {
    this.trackCliCommand({
      command: "tokens",
      value: actual
    });
  }
  trackCliCommandTelemetry(actual) {
    this.trackCliCommand({
      command: "telemetry",
      value: actual
    });
  }
  trackCliCommandTraces(actual) {
    this.trackCliCommand({
      command: "traces",
      value: actual
    });
  }
  trackCliCommandWhoami(actual) {
    this.trackCliCommand({
      command: "whoami",
      value: actual
    });
  }
  trackCliCommandUpgrade(actual) {
    this.trackCliCommand({
      command: "upgrade",
      value: actual
    });
  }
  trackCliCommandVersion(actual) {
    this.trackCliCommand({
      command: "version",
      value: actual
    });
  }
  trackCliCommandWebhooks(actual) {
    this.trackCliCommand({
      command: "webhooks",
      value: actual
    });
  }
  trackCliCommandUsage(actual) {
    this.trackCliCommand({
      command: "usage",
      value: actual
    });
  }
  trackCliCommandVcr(actual) {
    this.trackCliCommand({
      command: "vcr",
      value: actual
    });
  }
  trackCPUs() {
    super.trackCPUs();
  }
  trackAgenticUse(agent) {
    super.trackAgenticUse(agent);
  }
  trackArch() {
    super.trackArch();
  }
  trackPlatform() {
    super.trackPlatform();
  }
  trackCIVendorName() {
    this.trackCI(import_ci_info.default.id);
  }
  trackStdinIsTTY(isTTY2) {
    super.trackStdinIsTTY(isTTY2);
  }
  trackVersion(version) {
    super.trackVersion(version);
  }
  trackProjectId(projectId) {
    super.trackProjectId(projectId);
  }
  trackInvocationId(invocationId) {
    super.trackInvocationId(invocationId);
  }
  trackDeviceId(deviceId) {
    super.trackDeviceId(deviceId);
  }
  trackVercelPluginActiveSession() {
    super.trackVercelPluginActiveSession();
  }
  trackVercelPluginVersion(version) {
    super.trackVercelPluginVersion(version);
  }
  trackErrorStatus(status) {
    super.trackErrorStatus(status);
  }
  trackErrorCode(code) {
    super.trackErrorCode(code);
  }
  trackErrorSlug(slug) {
    super.trackErrorSlug(slug);
  }
  trackErrorAction(action) {
    super.trackErrorAction(action);
  }
  trackErrorServerMessage(serverMessage) {
    super.trackErrorServerMessage(serverMessage);
  }
  trackCliOptionCwd(cwd) {
    if (cwd) {
      this.trackCliOption({ option: "cwd", value: this.redactedValue });
    }
  }
  trackCliOptionLocalConfig(localConfig) {
    if (localConfig) {
      this.trackCliOption({
        option: "local-config",
        value: this.redactedValue
      });
    }
  }
  trackCliOptionGlobalConfig(globalConfig) {
    if (globalConfig) {
      this.trackCliOption({
        option: "global-config",
        value: this.redactedValue
      });
    }
  }
  trackCliOptionScope(scope) {
    if (scope) {
      this.trackCliOption({
        option: "scope",
        value: this.redactedValue
      });
    }
  }
  trackCliOptionToken(token) {
    if (token) {
      this.trackCliOption({
        option: "token",
        value: this.redactedValue
      });
    }
  }
  trackCliOptionTeam(team) {
    if (team) {
      this.trackCliOption({
        option: "team",
        value: this.redactedValue
      });
    }
  }
  trackCliOptionApi(api) {
    if (api) {
      this.trackCliOption({
        option: "api",
        value: this.redactedValue
      });
    }
  }
  trackCliFlagDebug(debug) {
    if (debug) {
      this.trackCliFlag("debug");
    }
  }
  trackCliFlagNoColor(noColor) {
    if (noColor) {
      this.trackCliFlag("no-color");
    }
  }
};

// src/util/telemetry/vercel-plugin.ts
import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
var ACTIVE_SESSION_MARKER_PATH = join(
  homedir(),
  ".config",
  "vercel-plugin",
  "active-session.json"
);
var SEMVERISH_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
function isRecord(value) {
  return typeof value === "object" && value !== null;
}
function readVercelPluginActiveSessionMarker(opts = {}) {
  const filePath = opts.filePath ?? ACTIVE_SESSION_MARKER_PATH;
  const now = opts.now?.() ?? Date.now();
  try {
    const marker = JSON.parse(readFileSync(filePath, "utf-8"));
    if (!isRecord(marker)) {
      return null;
    }
    if (marker.schema !== 1 || marker.active !== true) {
      return null;
    }
    if (typeof marker.expiresAt !== "number" || marker.expiresAt <= now) {
      return null;
    }
    if (typeof marker.pluginVersion !== "string" || !SEMVERISH_RE.test(marker.pluginVersion)) {
      return null;
    }
    return {
      pluginVersion: marker.pluginVersion
    };
  } catch {
    return null;
  }
}

// src/util/telemetry/check-status.ts
function checkTelemetryStatus({ config: config2 }) {
  if (config2.telemetry) {
    return;
  }
  if (process.env.VERCEL_TELEMETRY_DISABLED) {
    return;
  }
  output_manager_default.note(
    "The Vercel CLI now collects telemetry regarding usage of the CLI."
  );
  output_manager_default.log(
    "This information is used to shape the CLI roadmap and prioritize features."
  );
  output_manager_default.log(
    "You can learn more, including how to opt-out if you'd not like to participate in this program, by visiting the following URL:"
  );
  output_manager_default.log("https://vercel.com/docs/cli/about-telemetry");
  config2.telemetry = {
    enabled: true
  };
  writeToConfigFile(config2);
}

// src/util/guidance/check-status.ts
function checkGuidanceStatus({ config: config2 }) {
  if (!process.env.FF_GUIDANCE_MODE) {
    return;
  }
  if (process.env.CI) {
    return;
  }
  if (process.env.VERCEL_GUIDANCE_DISABLED) {
    return;
  }
  if (config2.guidance) {
    return;
  }
  output_manager_default.note(
    "The Vercel CLI can suggest common follow-up commands and steps to help guide new users."
  );
  output_manager_default.log("You can disable this feature by running:");
  output_manager_default.log("vercel guidance disable");
  output_manager_default.log("or by setting VERCEL_GUIDANCE_DISABLED=1");
  config2.guidance = {
    enabled: true
  };
  writeToConfigFile(config2);
}

// src/index.ts
import { determineAgent } from "@vercel/detect-agent";
import {
  getPlatformEnv,
  Span
} from "@vercel/build-utils";
import { mkdir, writeFile } from "fs/promises";
try {
  process.cwd();
} catch (err) {
  if ((0, import_error_utils3.isError)(err) && err.message.includes("uv_cwd")) {
    console.error("Error: The current working directory does not exist.");
    process.exit(1);
  }
}
{
  const SILENCED_ERRORS = [
    "DeprecationWarning: The `punycode` module is deprecated. Please use a userland alternative instead."
  ];
  const originalError = console.error;
  console.error = (msg) => {
    const isSilencedError = SILENCED_ERRORS.some(
      (error) => typeof msg === "string" && msg.includes(error)
    );
    if (isSilencedError) {
      return;
    }
    originalError(msg);
  };
}
var VERCEL_DIR = getGlobalPathConfig();
var VERCEL_CONFIG_PATH = getConfigFilePath();
var VERCEL_AUTH_CONFIG_PATH = getAuthConfigFilePath();
var GLOBAL_COMMANDS = /* @__PURE__ */ new Set(["help"]);
function hasProxyConfig() {
  return [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "http_proxy",
    "https_proxy",
    "ALL_PROXY",
    "all_proxy"
  ].some((v) => process.env[v]);
}
(0, import_epipebomb.default)();
var client;
var resolvedCommandForUpdate;
var handleRejection = async (err) => {
  if (err) {
    if (err instanceof Error) {
      await handleUnexpected(err);
    } else {
      output_manager_default.error(`An unexpected rejection occurred
  ${err}`);
      await reportError(await getSentry(), client, err);
    }
  } else {
    output_manager_default.error("An unexpected empty rejection occurred");
  }
  process.exit(1);
};
var handleUnexpected = async (err) => {
  const { message } = err;
  if (message.includes("sentry") && message.includes("ENOTFOUND")) {
    output_manager_default.debug(`Sentry is not reachable: ${err}`);
    return;
  }
  output_manager_default.error(`An unexpected error occurred!
${err.stack}`);
  await reportError(await getSentry(), client, err);
  process.exit(1);
};
process.on("unhandledRejection", handleRejection);
process.on("uncaughtException", handleUnexpected);
if (process.env.CLAUDECODE) {
  process.stderr.write(
    '<claude-code-hint v="1" type="plugin" value="vercel@claude-plugins-official" />\n'
  );
}
var SHOULD_CHECK_FOR_UPDATES = !process.env.NO_UPDATE_NOTIFIER && !process.env.VERCEL;
var { isTTY } = process.stdout;
var apiUrl = "https://api.vercel.com";
var InMemoryReporter = class {
  constructor() {
    this.events = [];
  }
  report(event) {
    this.events.push(event);
  }
};
var main = async () => {
  const traceReporter = new InMemoryReporter();
  const rootSpan = new Span({ name: "vc.cli", reporter: traceReporter });
  const isTelemetryFlushCommand = process.argv[2] === "telemetry" && process.argv[3] === "flush";
  if (process.env.FORCE_TTY === "1") {
    isTTY = true;
    process.stdout.isTTY = true;
    process.stdin.isTTY = true;
  }
  const parseInitialArgs = () => parseArguments(
    process.argv,
    {
      "--version": Boolean,
      "-v": "--version",
      "--changelog": Boolean,
      "--non-interactive": Boolean
    },
    { permissive: true }
  );
  let parsedArgs;
  try {
    parsedArgs = parseInitialArgs();
    const isDebugging = parsedArgs.flags["--debug"];
    const isNoColor = parsedArgs.flags["--no-color"];
    output_manager_default.initialize({
      debug: isDebugging,
      noColor: isNoColor
    });
  } catch (err) {
    printError(err);
    return 1;
  }
  const localConfigPath = parsedArgs.flags["--local-config"];
  let localConfig = await earlyGetConfig(localConfigPath);
  if (localConfig instanceof CantParseJSONFile) {
    output_manager_default.error(`Couldn't parse JSON file ${localConfig.meta.file}.`);
    return 1;
  }
  if (localConfig instanceof CantFindConfig) {
    if (localConfigPath) {
      output_manager_default.error(
        `Couldn't find a project configuration file at 
    ${localConfig.meta.paths.join(
          " or\n    "
        )}`
      );
      return 1;
    } else {
      localConfig = void 0;
    }
  }
  if (localConfig instanceof Error) {
    output_manager_default.prettyError(localConfig);
    return 1;
  }
  const targetOrSubcommand = parsedArgs.args[2] || (parsedArgs.flags["--changelog"] ? "changelog" : void 0);
  const subSubCommand = parsedArgs.args[3];
  const betaCommands = ["api", "crons", "curl", "kms", "webhooks"];
  const shortBuildLabel = BUILD_LABEL ? ` (${BUILD_LABEL.split(" ")[0]})` : "";
  const versionBanner = isNativeBinaryInstall() ? `${getTitleName()} CLI ${pkg_default.version}${shortBuildLabel}` : `${getTitleName()} CLI ${pkg_default.version}${shortBuildLabel} (Node.js ${process.versions.node})`;
  const msg = targetOrSubcommand && betaCommands.includes(targetOrSubcommand) ? `${versionBanner} | ${targetOrSubcommand} is in beta \u2014 https://vercel.com/feedback` : versionBanner;
  if (shouldPrintVersionBanner(targetOrSubcommand, process.argv)) {
    output_manager_default.print(`${import_chalk.default.dim(msg)}
`);
  }
  if (!targetOrSubcommand && parsedArgs.flags["--version"]) {
    console.log(pkg_default.version);
    return 0;
  }
  const bareHelpOption = !targetOrSubcommand && parsedArgs.flags["--help"];
  const bareHelpSubcommand = targetOrSubcommand === "help" && !subSubCommand;
  if (bareHelpOption || bareHelpSubcommand) {
    output_manager_default.print(help());
    return 0;
  }
  try {
    await (0, import_fs_extra2.mkdirp)(VERCEL_DIR);
  } catch (err) {
    output_manager_default.error(
      `An unexpected error occurred while trying to create the global directory "${humanizePath(
        VERCEL_DIR
      )}" ${(0, import_error_utils3.errorToString)(err)}`
    );
    return 1;
  }
  let config2;
  try {
    config2 = readConfigFile();
  } catch (err) {
    if ((0, import_error_utils3.isErrnoException)(err) && err.code === "ENOENT") {
      config2 = defaultGlobalConfig;
      try {
        writeToConfigFile(config2);
      } catch (err2) {
        output_manager_default.error(
          `An unexpected error occurred while trying to save the config to "${humanizePath(
            VERCEL_CONFIG_PATH
          )}" ${(0, import_error_utils3.errorToString)(err2)}`
        );
        return 1;
      }
    } else {
      output_manager_default.error(
        `An unexpected error occurred while trying to read the config in "${humanizePath(
          VERCEL_CONFIG_PATH
        )}" ${(0, import_error_utils3.errorToString)(err)}`
      );
      return 1;
    }
  }
  let tokenSource;
  let explicitToken;
  if (typeof parsedArgs.flags["--token"] === "string") {
    explicitToken = parsedArgs.flags["--token"];
    tokenSource = "flag";
  } else if (process.env.VERCEL_TOKEN) {
    explicitToken = process.env.VERCEL_TOKEN;
    tokenSource = "env";
  }
  let authConfig;
  if (tokenSource) {
    authConfig = getDefaultAuthConfig();
  } else {
    try {
      authConfig = readAuthConfigFile(config2);
    } catch (err) {
      if ((0, import_error_utils3.isErrnoException)(err) && err.code === "ENOENT") {
        authConfig = getDefaultAuthConfig();
      } else {
        output_manager_default.error(
          `An unexpected error occurred while trying to read the auth config in "${humanizePath(
            VERCEL_AUTH_CONFIG_PATH
          )}" ${(0, import_error_utils3.errorToString)(err)}`
        );
        return 1;
      }
    }
  }
  const telemetryEventStore = new TelemetryEventStore({
    isDebug: process.env.VERCEL_TELEMETRY_DEBUG === "1",
    config: config2.telemetry,
    cliDevice: isTelemetryFlushCommand ? void 0 : {
      filePath: join2(VERCEL_DIR, "telemetry-device.json")
    },
    cliSession: isTelemetryFlushCommand ? void 0 : {
      filePath: join2(VERCEL_DIR, "telemetry-session.json")
    }
  });
  checkTelemetryStatus({
    config: config2
  });
  if (process.env.FF_GUIDANCE_MODE) {
    checkGuidanceStatus({
      config: config2
    });
  }
  const telemetry = new RootTelemetryClient({
    opts: {
      store: telemetryEventStore
    }
  });
  const { isAgent, agent: detectedAgent } = await determineAgent();
  telemetry.trackInvocationId(telemetryEventStore.currentInvocationId);
  telemetry.trackDeviceId(telemetryEventStore.currentDeviceId);
  const vercelPluginMarker = readVercelPluginActiveSessionMarker();
  if (vercelPluginMarker) {
    telemetry.trackVercelPluginActiveSession();
    telemetry.trackVercelPluginVersion(vercelPluginMarker.pluginVersion);
  }
  telemetry.trackAgenticUse(detectedAgent?.name);
  telemetry.trackCPUs();
  telemetry.trackPlatform();
  telemetry.trackArch();
  telemetry.trackCIVendorName();
  telemetry.trackStdinIsTTY(process.stdin?.isTTY === true);
  telemetry.trackVersion(pkg_default.version);
  telemetry.trackCliOptionCwd(parsedArgs.flags["--cwd"]);
  telemetry.trackCliOptionLocalConfig(parsedArgs.flags["--local-config"]);
  telemetry.trackCliOptionGlobalConfig(parsedArgs.flags["--global-config"]);
  telemetry.trackCliFlagDebug(parsedArgs.flags["--debug"]);
  telemetry.trackCliFlagNoColor(parsedArgs.flags["--no-color"]);
  telemetry.trackCliOptionScope(parsedArgs.flags["--scope"]);
  telemetry.trackCliOptionToken(parsedArgs.flags["--token"]);
  telemetry.trackCliOptionTeam(parsedArgs.flags["--team"]);
  telemetry.trackCliOptionApi(parsedArgs.flags["--api"]);
  let earlyGetUserPromise;
  let telemetrySaved = false;
  const getStringProperty = (value, key) => {
    if (typeof value === "object" && value !== null && key in value) {
      const property = value[key];
      if (typeof property === "string") {
        return property;
      }
    }
    return void 0;
  };
  const getNumberProperty = (value, key) => {
    if (typeof value === "object" && value !== null && key in value) {
      const property = value[key];
      if (typeof property === "number") {
        return property;
      }
    }
    return void 0;
  };
  const trackAgenticErrorTelemetry = (err) => {
    if (!isAgent) {
      return;
    }
    telemetry.trackErrorStatus(getNumberProperty(err, "status"));
    telemetry.trackErrorCode(getStringProperty(err, "code"));
    telemetry.trackErrorSlug(getStringProperty(err, "slug"));
    telemetry.trackErrorAction(getStringProperty(err, "action"));
    const serverMessage = getStringProperty(err, "serverMessage") ?? ((0, import_error_utils3.isError)(err) ? err.message : void 0);
    telemetry.trackErrorServerMessage(serverMessage);
  };
  const saveTelemetry = async () => {
    if (telemetrySaved) {
      return;
    }
    const postCommandSpan = rootSpan.child("vc.postCommand");
    telemetryEventStore.updateTeamId(
      client?.config.currentTeam ?? config2.currentTeam
    );
    telemetryEventStore.updateUserId(
      client?.authConfig.userId ?? authConfig.userId
    );
    if (!telemetryEventStore.hasUserId) {
      const getUserSpan = postCommandSpan.child("vc.postCommand.getUser");
      try {
        const user = await earlyGetUserPromise;
        if (user) {
          telemetryEventStore.updateUserId(user.id);
        }
      } catch {
      } finally {
        getUserSpan.stop();
      }
    }
    try {
      const envProjectId = getPlatformEnv("PROJECT_ID");
      if (envProjectId) {
        telemetryEventStore.updateProjectId(envProjectId);
      } else {
        const cwdForProjectId = client?.cwd || (typeof parsedArgs.flags["--cwd"] === "string" ? parsedArgs.flags["--cwd"] : process.cwd());
        const link = await getLinkFromDir(getVercelDirectory(cwdForProjectId));
        if (link) {
          telemetryEventStore.updateProjectId(link.projectId);
        }
      }
    } catch {
    }
    telemetry.trackProjectId(telemetryEventStore.currentProjectId);
    await telemetryEventStore.save();
    postCommandSpan.stop();
    telemetrySaved = true;
  };
  const finishWithExitCode = async (code) => {
    await saveTelemetry();
    return code;
  };
  if (typeof parsedArgs.flags["--api"] === "string") {
    apiUrl = parsedArgs.flags["--api"];
  } else if (config2 && config2.api) {
    apiUrl = config2.api;
  }
  try {
    new URL(apiUrl);
  } catch (_err) {
    output_manager_default.error(`Please provide a valid URL instead of ${highlight(apiUrl)}.`);
    return finishWithExitCode(1);
  }
  const stdinIsTTY = process.stdin?.isTTY === true;
  const nonInteractiveFlag = parsedArgs.flags["--non-interactive"] === true;
  const argv = process.argv;
  const explicitNonInteractiveFalse = argv.includes("--non-interactive=false") || argv.includes("--non-interactive") && argv[argv.indexOf("--non-interactive") + 1] === "false";
  const nonInteractive = explicitNonInteractiveFalse ? false : nonInteractiveFlag || isAgent && !stdinIsTTY;
  output_manager_default.debug(
    `Agent/TTY/nonInteractive: isAgent=${isAgent} agentName=${detectedAgent?.name ?? "none"} stdin.isTTY=${String(process.stdin?.isTTY)} --non-interactive=${nonInteractiveFlag} explicitFalse=${explicitNonInteractiveFalse} => nonInteractive=${nonInteractive}`
  );
  if (hasProxyConfig()) {
    const { EnvProxyDispatcher } = await import("./chunks/fetch-proxy-R3JZNXBZ.js");
    setFetchDispatcher(new EnvProxyDispatcher());
  }
  client = new Client({
    apiUrl,
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: output_manager_default.stream,
    config: config2,
    authConfig,
    localConfig,
    localConfigPath,
    argv: process.argv,
    telemetryEventStore,
    isAgent,
    agentName: detectedAgent?.name,
    nonInteractive
  });
  client.rootSpan = rootSpan;
  if (parsedArgs.flags["--cwd"]) {
    client.cwd = parsedArgs.flags["--cwd"];
  }
  const { cwd } = client;
  let defaultDeploy = false;
  let subcommand = void 0;
  let userSuppliedSubCommand = "";
  if (targetOrSubcommand) {
    const targetPath = join2(cwd, targetOrSubcommand);
    const targetPathExists = existsSync2(targetPath);
    const subcommandExists = GLOBAL_COMMANDS.has(targetOrSubcommand) || commands.has(targetOrSubcommand);
    if (targetPathExists && subcommandExists && !parsedArgs.flags["--cwd"] && !process.env.NOW_BUILDER && !wantsMachineReadableOutput(targetOrSubcommand, process.argv)) {
      output_manager_default.warn(
        `Did you mean to deploy the subdirectory "${targetOrSubcommand}"? Use \`vc --cwd ${targetOrSubcommand}\` instead.`
      );
    }
    if (subcommandExists) {
      output_manager_default.debug(`user supplied known subcommand: "${targetOrSubcommand}"`);
      subcommand = targetOrSubcommand;
      userSuppliedSubCommand = targetOrSubcommand;
    } else {
      output_manager_default.debug(
        "user supplied a possible target for deployment or an extension"
      );
      if (process.env.VERCEL_AUTO_API && await matchesCliApiTag(targetOrSubcommand)) {
        output_manager_default.debug(
          `first token "${targetOrSubcommand}" matches an OpenAPI tag; routing to api`
        );
        const tag = targetOrSubcommand;
        const result = await tryOpenApiFallback(
          client,
          parsedArgs.args.slice(3),
          async () => tag
        );
        return finishWithExitCode(result ?? 1);
      } else if (targetPathExists) {
        subcommand = "deploy";
        userSuppliedSubCommand = targetOrSubcommand;
        output_manager_default.debug(
          `first token "${targetOrSubcommand}" is an existing path; routing to deploy`
        );
      }
    }
  } else {
    output_manager_default.debug("user supplied no target, defaulting to deploy");
    subcommand = "deploy";
    defaultDeploy = true;
  }
  if (subcommand === "help") {
    telemetry.trackCliCommandHelp("help");
    subcommand = subSubCommand || "deploy";
    client.argv.push("-h");
  }
  const subcommandsWithoutToken = [
    "login",
    "logout",
    "help",
    "init",
    "build",
    "changelog",
    "deploy",
    "sandbox",
    "telemetry",
    "upgrade",
    "version",
    "skills",
    "agent",
    "whoami"
  ];
  if (process.env.FF_GUIDANCE_MODE) {
    subcommandsWithoutToken.push("guidance");
  }
  if (subcommand === "dev" && (client.argv.includes("--local") || client.argv.includes("-L"))) {
    subcommandsWithoutToken.push("dev");
  }
  if (subcommand === "flags" && subSubCommand === "prepare") {
    subcommandsWithoutToken.push("flags");
  }
  if (tokenSource === "env" && explicitToken) {
    parsedArgs.flags["--token"] = explicitToken;
  }
  if ((!authConfig || !authConfig.token) && !client.argv.includes("-h") && !client.argv.includes("--help") && typeof parsedArgs.flags["--token"] !== "string" && subcommand && !subcommandsWithoutToken.includes(subcommand)) {
    const result = await promptMissingCredentials(
      client,
      trackAgenticErrorTelemetry
    );
    if (result !== 0) {
      return finishWithExitCode(result);
    }
  }
  if (typeof parsedArgs.flags["--token"] === "string" && subcommand === "switch") {
    output_manager_default.prettyError({
      message: `This command doesn't work with ${param(
        "--token"
      )}. Please use ${param("--scope")}.`,
      link: "https://err.sh/vercel/no-token-allowed"
    });
    return finishWithExitCode(1);
  }
  if (typeof parsedArgs.flags["--token"] === "string") {
    const token = parsedArgs.flags["--token"];
    if (token.length === 0) {
      output_manager_default.prettyError({
        message: `You defined ${param("--token")}, but it's missing a value`,
        link: "https://err.sh/vercel/missing-token-value"
      });
      return finishWithExitCode(1);
    }
    const invalid = token.match(/(\W)/g);
    if (invalid) {
      const notContain = Array.from(new Set(invalid)).sort();
      output_manager_default.prettyError({
        message: `You defined ${param(
          "--token"
        )}, but its contents are invalid. Must not contain: ${notContain.map((c) => JSON.stringify(c)).join(", ")}`,
        link: "https://err.sh/vercel/invalid-token-value"
      });
      return finishWithExitCode(1);
    }
    client.authConfig = { token, skipWrite: true, tokenSource };
    if (client.config && client.config.currentTeam) {
      delete client.config.currentTeam;
    }
  }
  if (parsedArgs.flags["--team"]) {
    output_manager_default.warn(
      `The ${param("--team")} option is deprecated. Please use ${param(
        "--scope"
      )} instead.`
    );
  }
  let targetCommand = typeof subcommand === "string" ? commands.get(subcommand) : void 0;
  const scope = parsedArgs.flags["--scope"] || parsedArgs.flags["--team"] || localConfig?.scope;
  const separatorIndex = client.argv.indexOf("--");
  const cliArgs = separatorIndex === -1 ? client.argv : client.argv.slice(0, separatorIndex);
  const buildNeedsRemoteProjectScope = targetCommand === "build" && cliArgs.some((arg) => arg === "--project" || arg.startsWith("--project="));
  if (typeof scope === "string" && targetCommand !== "login" && (targetCommand !== "build" || buildNeedsRemoteProjectScope) && targetCommand !== "sandbox") {
    let user = null;
    try {
      user = await getUser(client);
      telemetryEventStore.updateUserId(user.id);
    } catch (err) {
      if (err instanceof Error) {
        output_manager_default.debug(err.stack || err.toString());
      }
      const appTokenScopeResolved = (0, import_error_utils3.isErrnoException)(err) && err.code === "NOT_AUTHORIZED" && isAppPrincipalEnabled() && await resolveAppTokenScope(client, scope);
      if (!appTokenScopeResolved) {
        if ((0, import_error_utils3.isErrnoException)(err) && err.code === "NOT_AUTHORIZED") {
          output_manager_default.prettyError({
            message: `You do not have access to the specified account`,
            link: "https://err.sh/vercel/scope-not-accessible"
          });
          trackAgenticErrorTelemetry(err);
          return finishWithExitCode(1);
        }
        output_manager_default.error(
          `Not able to load user because of unexpected error: ${(0, import_error_utils3.errorToString)(err)}`
        );
        trackAgenticErrorTelemetry(err);
        return finishWithExitCode(1);
      }
    }
    if (user) {
      const scopeMatchesUserIdentity = user.id === scope || user.email === scope || user.username === scope;
      let teams = [];
      try {
        teams = await getTeams(client);
      } catch (err) {
        if (scopeMatchesUserIdentity) {
          output_manager_default.debug(
            `Ignoring failure to load teams; scope matches the current user's identity`
          );
        } else if ((0, import_error_utils3.isErrnoException)(err) && err.code === "not_authorized") {
          output_manager_default.prettyError({
            message: `You do not have access to the specified team`,
            link: "https://err.sh/vercel/scope-not-accessible"
          });
          trackAgenticErrorTelemetry(err);
          return finishWithExitCode(1);
        } else if ((0, import_error_utils3.isErrnoException)(err) && err.code === "rate_limited") {
          output_manager_default.prettyError({
            message: "Rate limited. Too many requests to the same endpoint: /teams"
          });
          trackAgenticErrorTelemetry(err);
          return finishWithExitCode(1);
        } else {
          output_manager_default.error("Not able to load teams");
          trackAgenticErrorTelemetry(err);
          return finishWithExitCode(1);
        }
      }
      const related = teams && teams.find((team) => team.id === scope || team.slug === scope);
      if (related) {
        client.config.currentTeam = related.id;
      } else if (scopeMatchesUserIdentity) {
        if (user.version === "northstar") {
          output_manager_default.error("You cannot set your Personal Account as the scope.");
          return finishWithExitCode(1);
        }
        delete client.config.currentTeam;
      } else {
        output_manager_default.prettyError({
          message: "The specified scope does not exist",
          link: "https://err.sh/vercel/scope-not-existent"
        });
        return finishWithExitCode(1);
      }
    }
  }
  let exitCode;
  try {
    if (!targetCommand) {
      targetCommand = parsedArgs.args[2];
      try {
        const { execExtension } = await import("./chunks/exec-CNBOV577.js");
        exitCode = await execExtension(
          client,
          targetCommand,
          parsedArgs.args.slice(3),
          cwd
        );
        telemetry.trackCliExtension();
      } catch (err) {
        if ((0, import_error_utils3.isErrnoException)(err) && err.code === "ENOENT") {
          if (handleCommandTypo({
            command: targetCommand,
            availableCommands: commandNames
          })) {
            return 1;
          }
          targetCommand = subcommand = "deploy";
        } else {
          throw err;
        }
      }
    }
    if (subcommand) {
      let func;
      switch (targetCommand) {
        case "deploy":
          telemetry.trackCliCommandDeploy(userSuppliedSubCommand);
          telemetry.trackCliDefaultDeploy(defaultDeploy);
          func = (await import("./commands/deploy/index.js")).default;
          break;
        case "dev":
          telemetry.trackCliCommandDev(userSuppliedSubCommand);
          func = (await import("./commands/dev/index.js")).default;
          break;
        case "env":
          telemetry.trackCliCommandEnv(userSuppliedSubCommand);
          func = (await import("./commands/env/index.js")).default;
          break;
        case "build":
          telemetry.trackCliCommandBuild(userSuppliedSubCommand);
          func = (await import("./commands/build/index.js")).default;
          break;
        case "list":
          telemetry.trackCliCommandList(userSuppliedSubCommand);
          func = (await import("./commands/list/index.js")).default;
          break;
        case "link":
          telemetry.trackCliCommandLink(userSuppliedSubCommand);
          func = (await import("./commands/link/index.js")).default;
          break;
        case "agent":
          telemetry.trackCliCommandAgent(userSuppliedSubCommand);
          func = (await import("./commands-bulk.js")).agent;
          break;
        case "agent-runs":
          telemetry.trackCliCommandAgentRuns(userSuppliedSubCommand);
          func = (await import("./commands-bulk.js")).agentRuns;
          break;
        case "ai-gateway":
          telemetry.trackCliCommandAiGateway(userSuppliedSubCommand);
          func = (await import("./commands-bulk.js")).aiGateway;
          break;
        case "alias":
          telemetry.trackCliCommandAlias(userSuppliedSubCommand);
          func = (await import("./commands-bulk.js")).alias;
          break;
        case "activity":
          telemetry.trackCliCommandActivity(userSuppliedSubCommand);
          func = (await import("./commands-bulk.js")).activity;
          break;
        case "alerts":
          telemetry.trackCliCommandAlerts(userSuppliedSubCommand);
          func = (await import("./commands-bulk.js")).alerts;
          break;
        case "api":
          telemetry.trackCliCommandApi(userSuppliedSubCommand);
          func = (await import("./commands-bulk.js")).api;
          break;
        case "bisect":
          telemetry.trackCliCommandBisect(userSuppliedSubCommand);
          func = (await import("./commands-bulk.js")).bisect;
          break;
        case "blob":
          telemetry.trackCliCommandBlob(userSuppliedSubCommand);
          func = (await import("./commands-bulk.js")).blob;
          break;
        case "buy":
          telemetry.trackCliCommandBuy(userSuppliedSubCommand);
          func = (await import("./commands-bulk.js")).buy;
          break;
        case "init":
          telemetry.trackCliCommandInit(userSuppliedSubCommand);
          func = (await import("./commands-bulk.js")).init;
          break;
        case "cache":
          telemetry.trackCliCommandCache(userSuppliedSubCommand);
          func = (await import("./commands-bulk.js")).cache;
          break;
        case "connect":
          telemetry.trackCliCommandConnex(userSuppliedSubCommand);
          func = (await import("./commands-bulk.js")).connex;
          break;
        case "contract":
          telemetry.trackCliCommandContract(userSuppliedSubCommand);
          func = (await import("./commands-bulk.js")).contract;
          break;
        case "certs":
          telemetry.trackCliCommandCerts(userSuppliedSubCommand);
          func = (await import("./commands-bulk.js")).certs;
          break;
        case "changelog":
          telemetry.trackCliCommandChangelog(userSuppliedSubCommand);
          func = (await import("./commands-bulk.js")).changelog;
          break;
        case "comments":
          telemetry.trackCliCommandComments(userSuppliedSubCommand);
          func = (await import("./commands-bulk.js")).comments;
          break;
        case "crons":
        case "cron":
          telemetry.trackCliCommandCrons(userSuppliedSubCommand);
          func = (await import("./commands-bulk.js")).crons;
          break;
        case "curl":
          telemetry.trackCliCommandCurl(userSuppliedSubCommand);
          func = (await import("./commands-bulk.js")).curl;
          break;
        case "dns":
          telemetry.trackCliCommandDns(userSuppliedSubCommand);
          func = (await import("./commands-bulk.js")).dns;
          break;
        case "deploy-hooks":
        case "deploy-hook":
          telemetry.trackCliCommandDeployHooks(userSuppliedSubCommand);
          func = (await import("./commands-bulk.js")).deployHooks;
          break;
        case "global-config":
          telemetry.trackCliCommandGlobalConfig(userSuppliedSubCommand);
          func = (await import("./commands-bulk.js")).globalConfig;
          break;
        case "domains":
          telemetry.trackCliCommandDomains(userSuppliedSubCommand);
          func = (await import("./commands-bulk.js")).domains;
          break;
        case "firewall":
          telemetry.trackCliCommandFirewall(userSuppliedSubCommand);
          func = (await import("./commands-bulk.js")).firewall;
          break;
        case "flags":
          telemetry.trackCliCommandFlags(userSuppliedSubCommand);
          func = (await import("./commands-bulk.js")).flags;
          break;
        case "git":
          telemetry.trackCliCommandGit(userSuppliedSubCommand);
          func = (await import("./commands-bulk.js")).git;
          break;
        case "guidance":
          if (process.env.FF_GUIDANCE_MODE) {
            telemetry.trackCliCommandGuidance(userSuppliedSubCommand);
            func = (await import("./commands-bulk.js")).guidance;
            break;
          } else {
            func = null;
            break;
          }
        case "httpstat":
          telemetry.trackCliCommandHttpstat(userSuppliedSubCommand);
          func = (await import("./commands-bulk.js")).httpstat;
          break;
        case "install":
          telemetry.trackCliCommandInstall(userSuppliedSubCommand);
          func = (await import("./commands-bulk.js")).install;
          break;
        case "integration":
          telemetry.trackCliCommandIntegration(userSuppliedSubCommand);
          func = (await import("./commands-bulk.js")).integration;
          break;
        case "integration-resource":
          telemetry.trackCliCommandIntegrationResource(userSuppliedSubCommand);
          func = (await import("./commands-bulk.js")).integrationResource;
          break;
        case "kms":
          telemetry.trackCliCommandKms(userSuppliedSubCommand);
          func = (await import("./commands-bulk.js")).kms;
          break;
        case "mcp":
          func = (await import("./commands-bulk.js")).mcp;
          break;
        case "logout":
          telemetry.trackCliCommandLogout(userSuppliedSubCommand);
          func = (await import("./commands-bulk.js")).logout;
          break;
        case "login":
          telemetry.trackCliCommandLogin(userSuppliedSubCommand);
          func = (c) => import("./commands-bulk.js").then(
            (m) => m.login(c, { shouldParseArgs: true })
          );
          break;
        case "inspect":
          telemetry.trackCliCommandInspect(userSuppliedSubCommand);
          func = (await import("./commands-bulk.js")).inspect;
          break;
        case "logs":
          telemetry.trackCliCommandLogs(userSuppliedSubCommand);
          func = (await import("./commands-bulk.js")).logs;
          break;
        case "metrics":
          telemetry.trackCliCommandMetrics(userSuppliedSubCommand);
          func = (await import("./commands-bulk.js")).metrics;
          break;
        case "microfrontends":
          telemetry.trackCliCommandMicrofrontends(userSuppliedSubCommand);
          func = (await import("./commands-bulk.js")).microfrontends;
          break;
        case "open":
          telemetry.trackCliCommandOpen(userSuppliedSubCommand);
          func = (await import("./commands-bulk.js")).open;
          break;
        case "project":
          telemetry.trackCliCommandProject(userSuppliedSubCommand);
          func = (await import("./commands-bulk.js")).project;
          break;
        case "promote":
          telemetry.trackCliCommandPromote(userSuppliedSubCommand);
          func = (await import("./commands-bulk.js")).promote;
          break;
        case "pull":
          telemetry.trackCliCommandPull(userSuppliedSubCommand);
          func = (await import("./commands-bulk.js")).pull;
          break;
        case "redeploy":
          telemetry.trackCliCommandRedeploy(userSuppliedSubCommand);
          func = (await import("./commands-bulk.js")).redeploy;
          break;
        case "redirects":
          telemetry.trackCliCommandRedirects(userSuppliedSubCommand);
          func = (await import("./commands-bulk.js")).redirects;
          break;
        case "routes":
          telemetry.trackCliCommandRoutes(userSuppliedSubCommand);
          func = (await import("./commands-bulk.js")).routes;
          break;
        case "remove":
          telemetry.trackCliCommandRemove(userSuppliedSubCommand);
          func = (await import("./commands-bulk.js")).remove;
          break;
        case "rollback":
          telemetry.trackCliCommandRollback(userSuppliedSubCommand);
          func = (await import("./commands-bulk.js")).rollback;
          break;
        case "rr":
        case "release":
        case "rolling-release":
          telemetry.trackCliCommandRollingRelease(userSuppliedSubCommand);
          func = (await import("./commands-bulk.js")).rollingRelease;
          break;
        case "sandbox":
          telemetry.trackCliCommandSandbox(userSuppliedSubCommand);
          func = (await import("./commands-bulk.js")).sandbox;
          break;
        case "security":
          telemetry.trackCliCommandSecurity(userSuppliedSubCommand);
          func = (await import("./commands-bulk.js")).security;
          break;
        case "skills":
          telemetry.trackCliCommandSkills(userSuppliedSubCommand);
          func = (await import("./commands-bulk.js")).skills;
          break;
        case "target":
          telemetry.trackCliCommandTarget(userSuppliedSubCommand);
          func = (await import("./commands-bulk.js")).target;
          break;
        case "teams":
          telemetry.trackCliCommandTeams(userSuppliedSubCommand);
          func = (await import("./commands-bulk.js")).teams;
          break;
        case "tokens":
          telemetry.trackCliCommandTokens(userSuppliedSubCommand);
          func = (await import("./commands-bulk.js")).tokens;
          break;
        case "telemetry":
          telemetry.trackCliCommandTelemetry(userSuppliedSubCommand);
          func = (await import("./commands-bulk.js")).telemetry;
          break;
        case "traces":
          telemetry.trackCliCommandTraces(userSuppliedSubCommand);
          func = (await import("./commands-bulk.js")).traces;
          break;
        case "upgrade":
          telemetry.trackCliCommandUpgrade(userSuppliedSubCommand);
          func = (await import("./commands-bulk.js")).upgrade;
          break;
        case "version":
          telemetry.trackCliCommandVersion(userSuppliedSubCommand);
          func = (await import("./commands-bulk.js")).version;
          break;
        case "webhooks":
          telemetry.trackCliCommandWebhooks(userSuppliedSubCommand);
          func = (await import("./commands-bulk.js")).webhooks;
          break;
        case "usage":
          telemetry.trackCliCommandUsage(userSuppliedSubCommand);
          func = (await import("./commands-bulk.js")).usage;
          break;
        case "vcr":
          telemetry.trackCliCommandVcr(userSuppliedSubCommand);
          func = (await import("./commands-bulk.js")).vcr;
          break;
        case "whoami":
          telemetry.trackCliCommandWhoami(userSuppliedSubCommand);
          func = (await import("./commands-bulk.js")).whoami;
          break;
        default:
          func = null;
          break;
      }
      if (!func || !targetCommand) {
        if (!handleCommandTypo({
          command: subcommand,
          availableCommands: commandNames
        })) {
          output_manager_default.error(`The ${param(subcommand)} subcommand does not exist`);
        }
        return 1;
      }
      if (func.default) {
        func = func.default;
      }
      if (!telemetryEventStore.hasUserId && !client.authConfig.userId) {
        earlyGetUserPromise = getUser(client).catch(() => void 0);
      }
      resolvedCommandForUpdate = targetCommand;
      exitCode = await rootSpan.child("vc.cli.command", { command: subcommand || "deploy" }).trace(() => func(client));
    }
  } catch (err) {
    trackAgenticErrorTelemetry(err);
    if ((0, import_error_utils3.isErrnoException)(err) && err.code === "ENOTFOUND") {
      const matches = /getaddrinfo ENOTFOUND (.*)$/.exec(err.message || "");
      if (matches && matches[1]) {
        const hostname = matches[1];
        output_manager_default.error(
          `The hostname ${highlight(
            hostname
          )} could not be resolved. Please verify your internet connectivity and DNS configuration.`
        );
      }
      if (typeof err.stack === "string") {
        output_manager_default.debug(err.stack);
      }
      return finishWithExitCode(1);
    }
    if ((0, import_error_utils3.isErrnoException)(err) && err.code === "ECONNRESET") {
      const matches = /request to https:\/\/(.*?)\//.exec(err.message || "");
      const hostname = matches?.[1];
      if (hostname) {
        output_manager_default.error(
          `Connection to ${highlight(
            hostname
          )} interrupted. Please verify your internet connectivity and DNS configuration.`
        );
      }
      return finishWithExitCode(1);
    }
    if ((0, import_error_utils3.isErrnoException)(err) && (err.code === "NOT_AUTHORIZED" || err.code === "TEAM_DELETED")) {
      output_manager_default.prettyError(err);
      return finishWithExitCode(1);
    }
    if (err instanceof APIError && 400 <= err.status && err.status <= 499) {
      err.message = err.serverMessage;
      output_manager_default.prettyError(err);
      return finishWithExitCode(1);
    }
    if ((0, import_error_utils3.isErrnoException)(err)) {
      if (typeof err.stack === "string") {
        output_manager_default.debug(err.stack);
      }
      output_manager_default.prettyError(err);
    } else {
      await reportError(await getSentry(), client, err);
      output_manager_default.error(`An unexpected error occurred in ${subcommand}: ${err}`);
    }
    return finishWithExitCode(1);
  }
  await saveTelemetry();
  rootSpan.stop();
  if (client.traceDiagnosticsPath) {
    try {
      await mkdir(join2(client.traceDiagnosticsPath, ".."), { recursive: true });
      await writeFile(
        client.traceDiagnosticsPath,
        JSON.stringify(traceReporter.events)
      );
    } catch (err) {
      output_manager_default.error("Failed to write diagnostics trace file");
      output_manager_default.prettyError(err);
    }
  }
  return exitCode;
};
var cachedLatest;
var freshLookupPromise;
if (SHOULD_CHECK_FOR_UPDATES && !isNativeBinaryInstall()) {
  cachedLatest = getLatestVersion({ pkg: pkg_default, consumeNotification: false });
  if (cachedLatest) {
    output_manager_default.debug("Update may be available, fetching fresh version...");
    freshLookupPromise = fetchLatestVersion({
      name: pkg_default.name,
      timeout: 3e3
    }).catch(() => void 0);
  }
}
async function promptAndUpgrade(client2, targetVersion) {
  try {
    const shouldUpgrade = await client2.input.confirm(
      "Would you like to upgrade now?",
      true
    );
    if (!shouldUpgrade)
      return;
    const upgradeExitCode = await executeUpgrade(targetVersion);
    if (upgradeExitCode === 0 && !hasAutoUpdatePreference(client2.config)) {
      const enableAutoUpdates = await client2.input.confirm(
        "Enable automatic CLI updates for future releases?",
        false
      );
      setAutoUpdate(client2, enableAutoUpdates);
    }
    return upgradeExitCode;
  } catch (err) {
    if (err instanceof Error && err.message.includes("User force closed the prompt")) {
      return;
    }
    throw err;
  }
}
main().then(async (exitCode) => {
  if (cachedLatest && resolvedCommandForUpdate !== "upgrade" && !await isVersionPinned()) {
    const originalExitCode = typeof exitCode === "number" ? exitCode : 0;
    const fresh = freshLookupPromise ? await freshLookupPromise : void 0;
    output_manager_default.debug(`Fresh lookup result: ${fresh ?? "failed"}`);
    let latest;
    let userUpToDate = false;
    if (fresh) {
      updateLatestVersionCache({ name: pkg_default.name, version: fresh });
      if (import_semver2.default.lt(pkg_default.version, fresh)) {
        latest = fresh;
      } else {
        userUpToDate = true;
      }
    }
    getLatestVersion({ pkg: pkg_default });
    if (!userUpToDate && await canAutoUpdate(
      client,
      originalExitCode,
      resolvedCommandForUpdate
    )) {
      const upgradeExitCode = await executeUpgrade();
      process.exitCode = originalExitCode;
      if (upgradeExitCode !== 0) {
        output_manager_default.log(
          `Automatic update failed. Continuing with original exit code ${originalExitCode}.`
        );
      }
      return;
    }
    if (latest) {
      const changelog = `https://github.com/vercel/vercel/releases/tag/vercel%40${latest}`;
      if (isTTY) {
        const errorMsg = exitCode && exitCode !== 2 ? import_chalk.default.magenta(
          ` The latest update ${import_chalk.default.italic(
            "may"
          )} fix any errors that occurred.`
        ) : "";
        output_manager_default.print(
          `
Update available for Vercel CLI (${import_chalk.default.gray(
            `v${pkg_default.version}`
          )} \u2192 ${import_chalk.default.green(`v${latest}`)})${errorMsg}
`
        );
        output_manager_default.print(
          `Changelog: ${output_manager_default.link(changelog, changelog, { fallback: false })}
`
        );
        const upgradeExitCode = await promptAndUpgrade(client, latest);
        if (upgradeExitCode !== void 0) {
          process.exitCode = upgradeExitCode;
          return;
        }
      } else {
        const errorMsg = exitCode && exitCode !== 2 ? import_chalk.default.magenta(
          `

The latest update ${import_chalk.default.italic(
            "may"
          )} fix any errors that occurred.`
        ) : "";
        output_manager_default.print(
          box(
            `Update available! ${import_chalk.default.gray(`v${pkg_default.version}`)} \u226B ${import_chalk.default.green(
              `v${latest}`
            )}
Changelog: ${output_manager_default.link(changelog, changelog, { fallback: false })}
Run ${import_chalk.default.cyan(cmd(await getUpdateCommand()))} to update.${errorMsg}`
          )
        );
        output_manager_default.print("\n");
      }
    } else if (!fresh) {
      if (isTTY) {
        output_manager_default.print("\nA newer version of Vercel CLI may be available.\n");
        const upgradeExitCode = await promptAndUpgrade(client);
        if (upgradeExitCode !== void 0) {
          process.exitCode = upgradeExitCode;
          return;
        }
      } else {
        output_manager_default.print(
          box(
            `A newer version of Vercel CLI may be available.
Run ${import_chalk.default.cyan(cmd(await getUpdateCommand()))} to update.`
          )
        );
        output_manager_default.print("\n");
      }
    }
  }
  process.exitCode = exitCode;
}).catch(handleUnexpected);
