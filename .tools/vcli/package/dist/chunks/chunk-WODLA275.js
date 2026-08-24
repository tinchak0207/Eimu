import { createRequire as __createRequire } from 'node:module';
import { fileURLToPath as __fileURLToPath } from 'node:url';
import { dirname as __dirname_ } from 'node:path';
const require = __createRequire(import.meta.url);
const __filename = __fileURLToPath(import.meta.url);
const __dirname = __dirname_(__filename);
import {
  getGlobalPathConfig,
  highlight
} from "./chunk-JKQWQA2T.js";
import {
  DEFAULT_VERCEL_CONFIG_FILENAME,
  PromptBackError,
  PromptCanceledError,
  VERCEL_CONFIG_EXTENSIONS,
  VERCEL_DIR,
  createPrompt,
  esm_default,
  esm_default2,
  esm_default3,
  getLocalPathConfig,
  humanizePath,
  isBackspaceKey,
  isEnterKey,
  isOAuthError,
  makeTheme,
  onExit,
  performDeviceCodeFlow,
  processTokenResponse,
  refreshTokenRequest,
  require_cli_width,
  require_dist as require_dist2,
  require_lib2 as require_lib,
  require_source as require_source2,
  require_wrap_ansi,
  ua_default,
  useKeypress,
  usePrefix,
  useState
} from "./chunk-KDL2L4KL.js";
import {
  require_load_json_file
} from "./chunk-CYNB6LL4.js";
import {
  require_strip_ansi
} from "./chunk-VAFU7DXZ.js";
import {
  parseArguments
} from "./chunk-XLKFJPMT.js";
import {
  APIError,
  NowError
} from "./chunk-SOFC4MLS.js";
import {
  pkg_default
} from "./chunk-P4QNYOFB.js";
import {
  Headers,
  fetch
} from "./chunk-52QYYTM5.js";
import {
  emoji,
  link_default,
  output_manager_default,
  prependEmoji,
  require_ansi_escapes,
  require_dist
} from "./chunk-OX7KI3LF.js";
import {
  require_source
} from "./chunk-S7KYDPEM.js";
import {
  __commonJS,
  __publicField,
  __require,
  __toESM
} from "./chunk-TZ2YI2VH.js";

// ../../node_modules/.pnpm/yoctocolors-cjs@2.1.3/node_modules/yoctocolors-cjs/index.js
var require_yoctocolors_cjs = __commonJS({
  "../../node_modules/.pnpm/yoctocolors-cjs@2.1.3/node_modules/yoctocolors-cjs/index.js"(exports, module) {
    var tty = __require("tty");
    var hasColors = tty?.WriteStream?.prototype?.hasColors?.() ?? false;
    var format = (open, close) => {
      if (!hasColors) {
        return (input) => input;
      }
      const openCode = `\x1B[${open}m`;
      const closeCode = `\x1B[${close}m`;
      return (input) => {
        const string = input + "";
        let index = string.indexOf(closeCode);
        if (index === -1) {
          return openCode + string + closeCode;
        }
        let result = openCode;
        let lastIndex = 0;
        const reopenOnNestedClose = close === 22;
        const replaceCode = (reopenOnNestedClose ? closeCode : "") + openCode;
        while (index !== -1) {
          result += string.slice(lastIndex, index) + replaceCode;
          lastIndex = index + closeCode.length;
          index = string.indexOf(closeCode, lastIndex);
        }
        result += string.slice(lastIndex) + closeCode;
        return result;
      };
    };
    var colors4 = {};
    colors4.reset = format(0, 0);
    colors4.bold = format(1, 22);
    colors4.dim = format(2, 22);
    colors4.italic = format(3, 23);
    colors4.underline = format(4, 24);
    colors4.overline = format(53, 55);
    colors4.inverse = format(7, 27);
    colors4.hidden = format(8, 28);
    colors4.strikethrough = format(9, 29);
    colors4.black = format(30, 39);
    colors4.red = format(31, 39);
    colors4.green = format(32, 39);
    colors4.yellow = format(33, 39);
    colors4.blue = format(34, 39);
    colors4.magenta = format(35, 39);
    colors4.cyan = format(36, 39);
    colors4.white = format(37, 39);
    colors4.gray = format(90, 39);
    colors4.bgBlack = format(40, 49);
    colors4.bgRed = format(41, 49);
    colors4.bgGreen = format(42, 49);
    colors4.bgYellow = format(43, 49);
    colors4.bgBlue = format(44, 49);
    colors4.bgMagenta = format(45, 49);
    colors4.bgCyan = format(46, 49);
    colors4.bgWhite = format(47, 49);
    colors4.bgGray = format(100, 49);
    colors4.redBright = format(91, 39);
    colors4.greenBright = format(92, 39);
    colors4.yellowBright = format(93, 39);
    colors4.blueBright = format(94, 39);
    colors4.magentaBright = format(95, 39);
    colors4.cyanBright = format(96, 39);
    colors4.whiteBright = format(97, 39);
    colors4.bgRedBright = format(101, 49);
    colors4.bgGreenBright = format(102, 49);
    colors4.bgYellowBright = format(103, 49);
    colors4.bgBlueBright = format(104, 49);
    colors4.bgMagentaBright = format(105, 49);
    colors4.bgCyanBright = format(106, 49);
    colors4.bgWhiteBright = format(107, 49);
    module.exports = colors4;
  }
});

// ../../node_modules/.pnpm/retry@0.10.1/node_modules/retry/lib/retry_operation.js
var require_retry_operation = __commonJS({
  "../../node_modules/.pnpm/retry@0.10.1/node_modules/retry/lib/retry_operation.js"(exports, module) {
    function RetryOperation(timeouts, options) {
      if (typeof options === "boolean") {
        options = { forever: options };
      }
      this._timeouts = timeouts;
      this._options = options || {};
      this._fn = null;
      this._errors = [];
      this._attempts = 1;
      this._operationTimeout = null;
      this._operationTimeoutCb = null;
      this._timeout = null;
      if (this._options.forever) {
        this._cachedTimeouts = this._timeouts.slice(0);
      }
    }
    module.exports = RetryOperation;
    RetryOperation.prototype.stop = function() {
      if (this._timeout) {
        clearTimeout(this._timeout);
      }
      this._timeouts = [];
      this._cachedTimeouts = null;
    };
    RetryOperation.prototype.retry = function(err) {
      if (this._timeout) {
        clearTimeout(this._timeout);
      }
      if (!err) {
        return false;
      }
      this._errors.push(err);
      var timeout = this._timeouts.shift();
      if (timeout === void 0) {
        if (this._cachedTimeouts) {
          this._errors.splice(this._errors.length - 1, this._errors.length);
          this._timeouts = this._cachedTimeouts.slice(0);
          timeout = this._timeouts.shift();
        } else {
          return false;
        }
      }
      var self = this;
      var timer = setTimeout(function() {
        self._attempts++;
        if (self._operationTimeoutCb) {
          self._timeout = setTimeout(function() {
            self._operationTimeoutCb(self._attempts);
          }, self._operationTimeout);
          if (this._options.unref) {
            self._timeout.unref();
          }
        }
        self._fn(self._attempts);
      }, timeout);
      if (this._options.unref) {
        timer.unref();
      }
      return true;
    };
    RetryOperation.prototype.attempt = function(fn, timeoutOps) {
      this._fn = fn;
      if (timeoutOps) {
        if (timeoutOps.timeout) {
          this._operationTimeout = timeoutOps.timeout;
        }
        if (timeoutOps.cb) {
          this._operationTimeoutCb = timeoutOps.cb;
        }
      }
      var self = this;
      if (this._operationTimeoutCb) {
        this._timeout = setTimeout(function() {
          self._operationTimeoutCb();
        }, self._operationTimeout);
      }
      this._fn(this._attempts);
    };
    RetryOperation.prototype.try = function(fn) {
      console.log("Using RetryOperation.try() is deprecated");
      this.attempt(fn);
    };
    RetryOperation.prototype.start = function(fn) {
      console.log("Using RetryOperation.start() is deprecated");
      this.attempt(fn);
    };
    RetryOperation.prototype.start = RetryOperation.prototype.try;
    RetryOperation.prototype.errors = function() {
      return this._errors;
    };
    RetryOperation.prototype.attempts = function() {
      return this._attempts;
    };
    RetryOperation.prototype.mainError = function() {
      if (this._errors.length === 0) {
        return null;
      }
      var counts = {};
      var mainError = null;
      var mainErrorCount = 0;
      for (var i = 0; i < this._errors.length; i++) {
        var error = this._errors[i];
        var message = error.message;
        var count = (counts[message] || 0) + 1;
        counts[message] = count;
        if (count >= mainErrorCount) {
          mainError = error;
          mainErrorCount = count;
        }
      }
      return mainError;
    };
  }
});

// ../../node_modules/.pnpm/retry@0.10.1/node_modules/retry/lib/retry.js
var require_retry = __commonJS({
  "../../node_modules/.pnpm/retry@0.10.1/node_modules/retry/lib/retry.js"(exports) {
    var RetryOperation = require_retry_operation();
    exports.operation = function(options) {
      var timeouts = exports.timeouts(options);
      return new RetryOperation(timeouts, {
        forever: options && options.forever,
        unref: options && options.unref
      });
    };
    exports.timeouts = function(options) {
      if (options instanceof Array) {
        return [].concat(options);
      }
      var opts = {
        retries: 10,
        factor: 2,
        minTimeout: 1 * 1e3,
        maxTimeout: Infinity,
        randomize: false
      };
      for (var key in options) {
        opts[key] = options[key];
      }
      if (opts.minTimeout > opts.maxTimeout) {
        throw new Error("minTimeout is greater than maxTimeout");
      }
      var timeouts = [];
      for (var i = 0; i < opts.retries; i++) {
        timeouts.push(this.createTimeout(i, opts));
      }
      if (options && options.forever && !timeouts.length) {
        timeouts.push(this.createTimeout(i, opts));
      }
      timeouts.sort(function(a, b) {
        return a - b;
      });
      return timeouts;
    };
    exports.createTimeout = function(attempt, opts) {
      var random = opts.randomize ? Math.random() + 1 : 1;
      var timeout = Math.round(random * opts.minTimeout * Math.pow(opts.factor, attempt));
      timeout = Math.min(timeout, opts.maxTimeout);
      return timeout;
    };
    exports.wrap = function(obj, options, methods) {
      if (options instanceof Array) {
        methods = options;
        options = null;
      }
      if (!methods) {
        methods = [];
        for (var key in obj) {
          if (typeof obj[key] === "function") {
            methods.push(key);
          }
        }
      }
      for (var i = 0; i < methods.length; i++) {
        var method = methods[i];
        var original = obj[method];
        obj[method] = function retryWrapper() {
          var op = exports.operation(options);
          var args = Array.prototype.slice.call(arguments);
          var callback = args.pop();
          args.push(function(err) {
            if (op.retry(err)) {
              return;
            }
            if (err) {
              arguments[0] = op.mainError();
            }
            callback.apply(this, arguments);
          });
          op.attempt(function() {
            original.apply(obj, args);
          });
        };
        obj[method].options = options;
      }
    };
  }
});

// ../../node_modules/.pnpm/retry@0.10.1/node_modules/retry/index.js
var require_retry2 = __commonJS({
  "../../node_modules/.pnpm/retry@0.10.1/node_modules/retry/index.js"(exports, module) {
    module.exports = require_retry();
  }
});

// ../../node_modules/.pnpm/async-retry@1.1.3/node_modules/async-retry/dist/index.js
var require_dist3 = __commonJS({
  "../../node_modules/.pnpm/async-retry@1.1.3/node_modules/async-retry/dist/index.js"(exports, module) {
    "use strict";
    var retrier = require_retry2();
    module.exports = function(fn, opts) {
      opts = opts || {};
      return new Promise(function(resolve2, reject) {
        var op = retrier.operation(opts);
        var bail = function bail2(err) {
          return reject(err || new Error("Aborted"));
        };
        var onError = function onError2(err) {
          if (err.bail) {
            return bail(err);
          }
          if (!op.retry(err)) {
            reject(op.mainError());
          } else if (opts.onRetry) {
            opts.onRetry(err);
          }
        };
        op.attempt(function(num) {
          var val = void 0;
          try {
            val = fn(bail, num);
          } catch (err) {
            return onError(err);
          }
          Promise.resolve(val).then(resolve2, onError);
        });
      });
    };
  }
});

// src/util/config/files.ts
var import_load_json_file = __toESM(require_load_json_file(), 1);
var import_error_utils = __toESM(require_dist(), 1);
var import_client = __toESM(require_dist2(), 1);
import { join, basename, dirname } from "path";
import { accessSync, constants } from "fs";
import * as config from "@vercel/cli-config";
import {
  persistCliAuthConfig,
  readCliAuthConfig
} from "@vercel/cli-auth/credentials-store.js";
var VERCEL_DIR2 = getGlobalPathConfig();
var CONFIG_FILE_PATH = config.getConfigFilePath(VERCEL_DIR2);
var AUTH_CONFIG_FILE_PATH = config.getAuthConfigFilePath(VERCEL_DIR2);
var readConfigFile = () => {
  return config.readGlobalConfigFile(CONFIG_FILE_PATH);
};
var writeToConfigFile = (stuff) => {
  try {
    config.writeGlobalConfigFile(CONFIG_FILE_PATH, stuff);
  } catch (err) {
    if ((0, import_error_utils.isErrnoException)(err)) {
      if ((0, import_error_utils.isErrnoException)(err) && err.code === "EPERM") {
        output_manager_default.error(
          `Not able to create ${highlight(
            CONFIG_FILE_PATH
          )} (operation not permitted).`
        );
        process.exit(1);
      } else if (err.code === "EBADF") {
        output_manager_default.error(
          `Not able to create ${highlight(
            CONFIG_FILE_PATH
          )} (bad file descriptor).`
        );
        process.exit(1);
      }
    }
    throw err;
  }
};
var readAuthConfigFile = (_globalConfig) => {
  return {
    ...config.getDefaultAuthConfig(),
    ...readCliAuthConfig(VERCEL_DIR2)
  };
};
var persistAuthConfig = (authConfig, _globalConfig) => {
  try {
    return persistCliAuthConfig(VERCEL_DIR2, authConfig);
  } catch (err) {
    const wrappedError = new Error(
      `Not able to create ${humanizePath(AUTH_CONFIG_FILE_PATH)} (${(0, import_error_utils.errorToStringFriendly)(
        err
      )}).`
    );
    wrappedError.cause = err;
    throw wrappedError;
  }
};
function getConfigFilePath2() {
  return CONFIG_FILE_PATH;
}
function getAuthConfigFilePath2() {
  return AUTH_CONFIG_FILE_PATH;
}
function readLocalConfig(prefix = process.cwd()) {
  let config2 = void 0;
  let target = "";
  try {
    target = getLocalPathConfig(prefix);
  } catch (err) {
    if (err instanceof NowError) {
      output_manager_default.error(err.message);
      process.exit(1);
    } else {
      throw err;
    }
  }
  if (!target) {
    return;
  }
  try {
    accessSync(target, constants.F_OK);
    config2 = import_load_json_file.default.sync(target);
  } catch (err) {
    if ((0, import_error_utils.isErrnoException)(err) && err.code === "ENOENT") {
    } else if ((0, import_error_utils.isError)(err) && err.name === "JSONError") {
      output_manager_default.error(err.message);
      process.exit(1);
    } else if ((0, import_error_utils.isErrnoException)(err)) {
      const code = err.code ? ` (${err.code})` : "";
      output_manager_default.error(`Failed to read config file: ${target}${code}`);
      process.exit(1);
    } else {
      output_manager_default.prettyError(err);
      process.exit(1);
    }
  }
  if (!config2) {
    return;
  }
  const isCompiledConfig = basename(target) === "vercel.json" && basename(dirname(target)) === VERCEL_DIR;
  if (isCompiledConfig) {
    const workPath = dirname(dirname(target));
    let sourceFile = null;
    for (const ext of VERCEL_CONFIG_EXTENSIONS) {
      const configPath = join(workPath, `vercel.${ext}`);
      try {
        accessSync(configPath, constants.F_OK);
        sourceFile = basename(configPath);
        break;
      } catch {
      }
    }
    if (!sourceFile) {
      const tomlPath = join(workPath, "vercel.toml");
      try {
        accessSync(tomlPath, constants.F_OK);
        sourceFile = "vercel.toml";
      } catch {
      }
    }
    config2[import_client.fileNameSymbol] = sourceFile || DEFAULT_VERCEL_CONFIG_FILENAME;
  } else {
    config2[import_client.fileNameSymbol] = basename(target);
  }
  return config2;
}

// src/util/client.ts
var import_chalk4 = __toESM(require_source(), 1);

// ../../node_modules/.pnpm/@inquirer+confirm@3.1.2/node_modules/@inquirer/confirm/dist/esm/index.mjs
var esm_default4 = createPrompt((config2, done) => {
  const { transformer = (answer) => answer ? "yes" : "no" } = config2;
  const [status, setStatus] = useState("pending");
  const [value, setValue] = useState("");
  const theme = makeTheme(config2.theme);
  const prefix = usePrefix({ theme });
  useKeypress((key, rl) => {
    if (isEnterKey(key)) {
      let answer = config2.default !== false;
      if (/^(y|yes)/i.test(value))
        answer = true;
      else if (/^(n|no)/i.test(value))
        answer = false;
      setValue(transformer(answer));
      setStatus("done");
      done(answer);
    } else {
      setValue(rl.line);
    }
  });
  let formattedValue = value;
  let defaultValue = "";
  if (status === "done") {
    formattedValue = theme.style.answer(value);
  } else {
    defaultValue = ` ${theme.style.defaultAnswer(config2.default === false ? "y/N" : "Y/n")}`;
  }
  const message = theme.style.message(config2.message);
  return `${prefix} ${message}${defaultValue} ${formattedValue}`;
});

// ../../node_modules/.pnpm/@inquirer+expand@2.1.2/node_modules/@inquirer/expand/dist/esm/index.mjs
var import_chalk = __toESM(require_source2(), 1);
var helpChoice = {
  key: "h",
  name: "Help, list all options",
  value: void 0
};
function getChoiceKey(choice, key) {
  if (key === "name") {
    if ("name" in choice)
      return choice.name;
    return choice.value;
  }
  if ("value" in choice)
    return choice.value;
  return choice.name;
}
var esm_default5 = createPrompt((config2, done) => {
  const { choices, default: defaultKey = "h", expanded: defaultExpandState = false } = config2;
  const [status, setStatus] = useState("pending");
  const [value, setValue] = useState("");
  const [expanded, setExpanded] = useState(defaultExpandState);
  const [errorMsg, setError] = useState(void 0);
  const theme = makeTheme(config2.theme);
  const prefix = usePrefix({ theme });
  useKeypress((event, rl) => {
    if (isEnterKey(event)) {
      const answer = (value || defaultKey).toLowerCase();
      if (answer === "h" && !expanded) {
        setExpanded(true);
      } else {
        const selectedChoice = choices.find(({ key }) => key === answer);
        if (selectedChoice) {
          const finalValue = getChoiceKey(selectedChoice, "value");
          setValue(finalValue);
          setStatus("done");
          done(finalValue);
        } else if (value === "") {
          setError("Please input a value");
        } else {
          setError(`"${import_chalk.default.red(value)}" isn't an available option`);
        }
      }
    } else {
      setValue(rl.line);
      setError(void 0);
    }
  });
  const message = theme.style.message(config2.message);
  if (status === "done") {
    return `${prefix} ${message} ${theme.style.answer(value)}`;
  }
  const allChoices = expanded ? choices : [...choices, helpChoice];
  let longChoices = "";
  let shortChoices = allChoices.map((choice) => {
    if (choice.key === defaultKey) {
      return choice.key.toUpperCase();
    }
    return choice.key;
  }).join("");
  shortChoices = ` ${theme.style.defaultAnswer(shortChoices)}`;
  if (expanded) {
    shortChoices = "";
    longChoices = allChoices.map((choice) => {
      const line = `  ${choice.key}) ${getChoiceKey(choice, "name")}`;
      if (choice.key === value.toLowerCase()) {
        return theme.style.highlight(line);
      }
      return line;
    }).join("\n");
  }
  let helpTip = "";
  const currentOption = allChoices.find(({ key }) => key === value.toLowerCase());
  if (currentOption) {
    helpTip = `${import_chalk.default.cyan(">>")} ${getChoiceKey(currentOption, "name")}`;
  }
  let error = "";
  if (errorMsg) {
    error = theme.style.error(errorMsg);
  }
  return [
    `${prefix} ${message}${shortChoices} ${value}`,
    [longChoices, helpTip, error].filter(Boolean).join("\n")
  ];
});

// ../../node_modules/.pnpm/@inquirer+input@2.1.2/node_modules/@inquirer/input/dist/esm/index.mjs
var esm_default6 = createPrompt((config2, done) => {
  const { validate = () => true } = config2;
  const theme = makeTheme(config2.theme);
  const [status, setStatus] = useState("pending");
  const [defaultValue = "", setDefaultValue] = useState(config2.default);
  const [errorMsg, setError] = useState(void 0);
  const [value, setValue] = useState("");
  const isLoading = status === "loading";
  const prefix = usePrefix({ isLoading, theme });
  useKeypress(async (key, rl) => {
    if (status !== "pending") {
      return;
    }
    if (isEnterKey(key)) {
      const answer = value || defaultValue;
      setStatus("loading");
      const isValid = await validate(answer);
      if (isValid === true) {
        setValue(answer);
        setStatus("done");
        done(answer);
      } else {
        rl.write(value);
        setError(isValid || "You must provide a valid value");
        setStatus("pending");
      }
    } else if (isBackspaceKey(key) && !value) {
      setDefaultValue(void 0);
    } else if (key.name === "tab" && !value) {
      setDefaultValue(void 0);
      rl.clearLine(0);
      rl.write(defaultValue);
      setValue(defaultValue);
    } else {
      setValue(rl.line);
      setError(void 0);
    }
  });
  const message = theme.style.message(config2.message);
  let formattedValue = value;
  if (typeof config2.transformer === "function") {
    formattedValue = config2.transformer(value, { isFinal: status === "done" });
  } else if (status === "done") {
    formattedValue = theme.style.answer(value);
  }
  let defaultStr;
  if (defaultValue && status !== "done" && !value) {
    defaultStr = theme.style.defaultAnswer(defaultValue);
  }
  let error = "";
  if (errorMsg) {
    error = theme.style.error(errorMsg);
  }
  return [
    [prefix, message, defaultStr, formattedValue].filter((v) => v !== void 0).join(" "),
    error
  ];
});

// ../../node_modules/.pnpm/@inquirer+password@2.1.2/node_modules/@inquirer/password/dist/esm/index.mjs
var import_ansi_escapes = __toESM(require_ansi_escapes(), 1);
var esm_default7 = createPrompt((config2, done) => {
  const { validate = () => true } = config2;
  const theme = makeTheme(config2.theme);
  const [status, setStatus] = useState("pending");
  const [errorMsg, setError] = useState(void 0);
  const [value, setValue] = useState("");
  const isLoading = status === "loading";
  const prefix = usePrefix({ isLoading, theme });
  useKeypress(async (key, rl) => {
    if (status !== "pending") {
      return;
    }
    if (isEnterKey(key)) {
      const answer = value;
      setStatus("loading");
      const isValid = await validate(answer);
      if (isValid === true) {
        setValue(answer);
        setStatus("done");
        done(answer);
      } else {
        rl.write(value);
        setError(isValid || "You must provide a valid value");
        setStatus("pending");
      }
    } else {
      setValue(rl.line);
      setError(void 0);
    }
  });
  const message = theme.style.message(config2.message);
  let formattedValue = "";
  let helpTip;
  if (config2.mask) {
    const maskChar = typeof config2.mask === "string" ? config2.mask : "*";
    formattedValue = maskChar.repeat(value.length);
  } else if (status !== "done") {
    helpTip = `${theme.style.help("[input is masked]")}${import_ansi_escapes.default.cursorHide}`;
  }
  if (status === "done") {
    formattedValue = theme.style.answer(formattedValue);
  }
  let error = "";
  if (errorMsg) {
    error = theme.style.error(errorMsg);
  }
  return [[prefix, message, formattedValue, helpTip].filter(Boolean).join(" "), error];
});

// ../../node_modules/.pnpm/@inquirer+core@9.2.1/node_modules/@inquirer/core/dist/esm/lib/key.mjs
var isEnterKey2 = (key) => key.name === "enter" || key.name === "return";

// ../../node_modules/.pnpm/@inquirer+core@9.2.1/node_modules/@inquirer/core/dist/esm/lib/errors.mjs
var AbortPromptError = class extends Error {
  constructor(options) {
    super();
    __publicField(this, "name", "AbortPromptError");
    __publicField(this, "message", "Prompt was aborted");
    this.cause = options?.cause;
  }
};
var CancelPromptError = class extends Error {
  constructor() {
    super(...arguments);
    __publicField(this, "name", "CancelPromptError");
    __publicField(this, "message", "Prompt was canceled");
  }
};
var ExitPromptError = class extends Error {
  constructor() {
    super(...arguments);
    __publicField(this, "name", "ExitPromptError");
  }
};
var HookError = class extends Error {
  constructor() {
    super(...arguments);
    __publicField(this, "name", "HookError");
  }
};
var ValidationError = class extends Error {
  constructor() {
    super(...arguments);
    __publicField(this, "name", "ValidationError");
  }
};

// ../../node_modules/.pnpm/@inquirer+core@9.2.1/node_modules/@inquirer/core/dist/esm/lib/use-prefix.mjs
import { AsyncResource as AsyncResource2 } from "async_hooks";

// ../../node_modules/.pnpm/@inquirer+core@9.2.1/node_modules/@inquirer/core/dist/esm/lib/hook-engine.mjs
import { AsyncLocalStorage, AsyncResource } from "async_hooks";
var hookStorage = new AsyncLocalStorage();
function createStore(rl) {
  const store = {
    rl,
    hooks: [],
    hooksCleanup: [],
    hooksEffect: [],
    index: 0,
    handleChange() {
    }
  };
  return store;
}
function withHooks(rl, cb) {
  const store = createStore(rl);
  return hookStorage.run(store, () => {
    function cycle(render) {
      store.handleChange = () => {
        store.index = 0;
        render();
      };
      store.handleChange();
    }
    return cb(cycle);
  });
}
function getStore() {
  const store = hookStorage.getStore();
  if (!store) {
    throw new HookError("[Inquirer] Hook functions can only be called from within a prompt");
  }
  return store;
}
function readline() {
  return getStore().rl;
}
function withUpdates(fn) {
  const wrapped = (...args) => {
    const store = getStore();
    let shouldUpdate = false;
    const oldHandleChange = store.handleChange;
    store.handleChange = () => {
      shouldUpdate = true;
    };
    const returnValue = fn(...args);
    if (shouldUpdate) {
      oldHandleChange();
    }
    store.handleChange = oldHandleChange;
    return returnValue;
  };
  return AsyncResource.bind(wrapped);
}
function withPointer(cb) {
  const store = getStore();
  const { index } = store;
  const pointer = {
    get() {
      return store.hooks[index];
    },
    set(value) {
      store.hooks[index] = value;
    },
    initialized: index in store.hooks
  };
  const returnValue = cb(pointer);
  store.index++;
  return returnValue;
}
function handleChange() {
  getStore().handleChange();
}
var effectScheduler = {
  queue(cb) {
    const store = getStore();
    const { index } = store;
    store.hooksEffect.push(() => {
      store.hooksCleanup[index]?.();
      const cleanFn = cb(readline());
      if (cleanFn != null && typeof cleanFn !== "function") {
        throw new ValidationError("useEffect return value must be a cleanup function or nothing.");
      }
      store.hooksCleanup[index] = cleanFn;
    });
  },
  run() {
    const store = getStore();
    withUpdates(() => {
      store.hooksEffect.forEach((effect) => {
        effect();
      });
      store.hooksEffect.length = 0;
    })();
  },
  clearAll() {
    const store = getStore();
    store.hooksCleanup.forEach((cleanFn) => {
      cleanFn?.();
    });
    store.hooksEffect.length = 0;
    store.hooksCleanup.length = 0;
  }
};

// ../../node_modules/.pnpm/@inquirer+core@9.2.1/node_modules/@inquirer/core/dist/esm/lib/use-state.mjs
function useState2(defaultValue) {
  return withPointer((pointer) => {
    const setFn = (newValue) => {
      if (pointer.get() !== newValue) {
        pointer.set(newValue);
        handleChange();
      }
    };
    if (pointer.initialized) {
      return [pointer.get(), setFn];
    }
    const value = typeof defaultValue === "function" ? defaultValue() : defaultValue;
    pointer.set(value);
    return [value, setFn];
  });
}

// ../../node_modules/.pnpm/@inquirer+core@9.2.1/node_modules/@inquirer/core/dist/esm/lib/use-effect.mjs
function useEffect(cb, depArray) {
  withPointer((pointer) => {
    const oldDeps = pointer.get();
    const hasChanged = !Array.isArray(oldDeps) || depArray.some((dep, i) => !Object.is(dep, oldDeps[i]));
    if (hasChanged) {
      effectScheduler.queue(cb);
    }
    pointer.set(depArray);
  });
}

// ../../node_modules/.pnpm/@inquirer+core@9.2.1/node_modules/@inquirer/core/dist/esm/lib/theme.mjs
var import_yoctocolors_cjs = __toESM(require_yoctocolors_cjs(), 1);
var defaultTheme = {
  prefix: {
    idle: import_yoctocolors_cjs.default.blue("?"),
    // TODO: use figure
    done: import_yoctocolors_cjs.default.green(esm_default.tick)
  },
  spinner: {
    interval: 80,
    frames: ["\u280B", "\u2819", "\u2839", "\u2838", "\u283C", "\u2834", "\u2826", "\u2827", "\u2807", "\u280F"].map((frame) => import_yoctocolors_cjs.default.yellow(frame))
  },
  style: {
    answer: import_yoctocolors_cjs.default.cyan,
    message: import_yoctocolors_cjs.default.bold,
    error: (text) => import_yoctocolors_cjs.default.red(`> ${text}`),
    defaultAnswer: (text) => import_yoctocolors_cjs.default.dim(`(${text})`),
    help: import_yoctocolors_cjs.default.dim,
    highlight: import_yoctocolors_cjs.default.cyan,
    key: (text) => import_yoctocolors_cjs.default.cyan(import_yoctocolors_cjs.default.bold(`<${text}>`))
  }
};

// ../../node_modules/.pnpm/@inquirer+core@9.2.1/node_modules/@inquirer/core/dist/esm/lib/make-theme.mjs
function isPlainObject(value) {
  if (typeof value !== "object" || value === null)
    return false;
  let proto = value;
  while (Object.getPrototypeOf(proto) !== null) {
    proto = Object.getPrototypeOf(proto);
  }
  return Object.getPrototypeOf(value) === proto;
}
function deepMerge(...objects) {
  const output = {};
  for (const obj of objects) {
    for (const [key, value] of Object.entries(obj)) {
      const prevValue = output[key];
      output[key] = isPlainObject(prevValue) && isPlainObject(value) ? deepMerge(prevValue, value) : value;
    }
  }
  return output;
}
function makeTheme2(...themes) {
  const themesToMerge = [
    defaultTheme,
    ...themes.filter((theme) => theme != null)
  ];
  return deepMerge(...themesToMerge);
}

// ../../node_modules/.pnpm/@inquirer+core@9.2.1/node_modules/@inquirer/core/dist/esm/lib/use-prefix.mjs
function usePrefix2({ status = "idle", theme }) {
  const [showLoader, setShowLoader] = useState2(false);
  const [tick, setTick] = useState2(0);
  const { prefix, spinner } = makeTheme2(theme);
  useEffect(() => {
    if (status === "loading") {
      let tickInterval;
      let inc = -1;
      const delayTimeout = setTimeout(AsyncResource2.bind(() => {
        setShowLoader(true);
        tickInterval = setInterval(AsyncResource2.bind(() => {
          inc = inc + 1;
          setTick(inc % spinner.frames.length);
        }), spinner.interval);
      }), 300);
      return () => {
        clearTimeout(delayTimeout);
        clearInterval(tickInterval);
      };
    } else {
      setShowLoader(false);
    }
  }, [status]);
  if (showLoader) {
    return spinner.frames[tick];
  }
  const iconName = status === "loading" ? "idle" : status;
  return typeof prefix === "string" ? prefix : prefix[iconName];
}

// ../../node_modules/.pnpm/@inquirer+core@9.2.1/node_modules/@inquirer/core/dist/esm/lib/use-memo.mjs
function useMemo(fn, dependencies) {
  return withPointer((pointer) => {
    const prev = pointer.get();
    if (!prev || prev.dependencies.length !== dependencies.length || prev.dependencies.some((dep, i) => dep !== dependencies[i])) {
      const value = fn();
      pointer.set({ value, dependencies });
      return value;
    }
    return prev.value;
  });
}

// ../../node_modules/.pnpm/@inquirer+core@9.2.1/node_modules/@inquirer/core/dist/esm/lib/use-ref.mjs
function useRef(val) {
  return useState2({ current: val })[0];
}

// ../../node_modules/.pnpm/@inquirer+core@9.2.1/node_modules/@inquirer/core/dist/esm/lib/use-keypress.mjs
function useKeypress2(userHandler) {
  const signal = useRef(userHandler);
  signal.current = userHandler;
  useEffect((rl) => {
    let ignore = false;
    const handler = withUpdates((_input, event) => {
      if (ignore)
        return;
      void signal.current(event, rl);
    });
    rl.input.on("keypress", handler);
    return () => {
      ignore = true;
      rl.input.removeListener("keypress", handler);
    };
  }, []);
}

// ../../node_modules/.pnpm/@inquirer+core@9.2.1/node_modules/@inquirer/core/dist/esm/lib/utils.mjs
var import_cli_width = __toESM(require_cli_width(), 1);
var import_wrap_ansi = __toESM(require_wrap_ansi(), 1);
function breakLines(content, width) {
  return content.split("\n").flatMap((line) => (0, import_wrap_ansi.default)(line, width, { trim: false, hard: true }).split("\n").map((str) => str.trimEnd())).join("\n");
}
function readlineWidth() {
  return (0, import_cli_width.default)({ defaultWidth: 80, output: readline().output });
}

// ../../node_modules/.pnpm/@inquirer+core@9.2.1/node_modules/@inquirer/core/dist/esm/lib/pagination/lines.mjs
function split(content, width) {
  return breakLines(content, width).split("\n");
}
function rotate(count, items) {
  const max = items.length;
  const offset = (count % max + max) % max;
  return [...items.slice(offset), ...items.slice(0, offset)];
}
function lines({ items, width, renderItem, active, position: requested, pageSize }) {
  const layouts = items.map((item, index) => ({
    item,
    index,
    isActive: index === active
  }));
  const layoutsInPage = rotate(active - requested, layouts).slice(0, pageSize);
  const renderItemAt = (index) => layoutsInPage[index] == null ? [] : split(renderItem(layoutsInPage[index]), width);
  const pageBuffer = Array.from({ length: pageSize });
  const activeItem = renderItemAt(requested).slice(0, pageSize);
  const position = requested + activeItem.length <= pageSize ? requested : pageSize - activeItem.length;
  pageBuffer.splice(position, activeItem.length, ...activeItem);
  let bufferPointer = position + activeItem.length;
  let layoutPointer = requested + 1;
  while (bufferPointer < pageSize && layoutPointer < layoutsInPage.length) {
    for (const line of renderItemAt(layoutPointer)) {
      pageBuffer[bufferPointer++] = line;
      if (bufferPointer >= pageSize)
        break;
    }
    layoutPointer++;
  }
  bufferPointer = position - 1;
  layoutPointer = requested - 1;
  while (bufferPointer >= 0 && layoutPointer >= 0) {
    for (const line of renderItemAt(layoutPointer).reverse()) {
      pageBuffer[bufferPointer--] = line;
      if (bufferPointer < 0)
        break;
    }
    layoutPointer--;
  }
  return pageBuffer.filter((line) => typeof line === "string");
}

// ../../node_modules/.pnpm/@inquirer+core@9.2.1/node_modules/@inquirer/core/dist/esm/lib/pagination/position.mjs
function finite({ active, pageSize, total }) {
  const middle = Math.floor(pageSize / 2);
  if (total <= pageSize || active < middle)
    return active;
  if (active >= total - middle)
    return active + pageSize - total;
  return middle;
}
function infinite({ active, lastActive, total, pageSize, pointer }) {
  if (total <= pageSize)
    return active;
  if (lastActive < active && active - lastActive < pageSize) {
    return Math.min(Math.floor(pageSize / 2), pointer + active - lastActive);
  }
  return pointer;
}

// ../../node_modules/.pnpm/@inquirer+core@9.2.1/node_modules/@inquirer/core/dist/esm/lib/pagination/use-pagination.mjs
function usePagination({ items, active, renderItem, pageSize, loop = true }) {
  const state = useRef({ position: 0, lastActive: 0 });
  const position = loop ? infinite({
    active,
    lastActive: state.current.lastActive,
    total: items.length,
    pageSize,
    pointer: state.current.position
  }) : finite({
    active,
    total: items.length,
    pageSize
  });
  state.current.position = position;
  state.current.lastActive = active;
  return lines({
    items,
    width: readlineWidth(),
    renderItem,
    active,
    position,
    pageSize
  }).join("\n");
}

// ../../node_modules/.pnpm/@inquirer+core@9.2.1/node_modules/@inquirer/core/dist/esm/lib/create-prompt.mjs
var import_mute_stream = __toESM(require_lib(), 1);
import * as readline2 from "readline";
import { AsyncResource as AsyncResource3 } from "async_hooks";

// ../../node_modules/.pnpm/@inquirer+core@9.2.1/node_modules/@inquirer/core/dist/esm/lib/screen-manager.mjs
var import_strip_ansi = __toESM(require_strip_ansi(), 1);
var import_ansi_escapes2 = __toESM(require_ansi_escapes(), 1);
var height = (content) => content.split("\n").length;
var lastLine = (content) => content.split("\n").pop() ?? "";
function cursorDown(n) {
  return n > 0 ? import_ansi_escapes2.default.cursorDown(n) : "";
}
var ScreenManager = class {
  constructor(rl) {
    __publicField(this, "rl");
    // These variables are keeping information to allow correct prompt re-rendering
    __publicField(this, "height", 0);
    __publicField(this, "extraLinesUnderPrompt", 0);
    __publicField(this, "cursorPos");
    this.rl = rl;
    this.rl = rl;
    this.cursorPos = rl.getCursorPos();
  }
  write(content) {
    this.rl.output.unmute();
    this.rl.output.write(content);
    this.rl.output.mute();
  }
  render(content, bottomContent = "") {
    const promptLine = lastLine(content);
    const rawPromptLine = (0, import_strip_ansi.default)(promptLine);
    let prompt = rawPromptLine;
    if (this.rl.line.length > 0) {
      prompt = prompt.slice(0, -this.rl.line.length);
    }
    this.rl.setPrompt(prompt);
    this.cursorPos = this.rl.getCursorPos();
    const width = readlineWidth();
    content = breakLines(content, width);
    bottomContent = breakLines(bottomContent, width);
    if (rawPromptLine.length % width === 0) {
      content += "\n";
    }
    let output = content + (bottomContent ? "\n" + bottomContent : "");
    const promptLineUpDiff = Math.floor(rawPromptLine.length / width) - this.cursorPos.rows;
    const bottomContentHeight = promptLineUpDiff + (bottomContent ? height(bottomContent) : 0);
    if (bottomContentHeight > 0)
      output += import_ansi_escapes2.default.cursorUp(bottomContentHeight);
    output += import_ansi_escapes2.default.cursorTo(this.cursorPos.cols);
    this.write(cursorDown(this.extraLinesUnderPrompt) + import_ansi_escapes2.default.eraseLines(this.height) + output);
    this.extraLinesUnderPrompt = bottomContentHeight;
    this.height = height(output);
  }
  checkCursorPos() {
    const cursorPos = this.rl.getCursorPos();
    if (cursorPos.cols !== this.cursorPos.cols) {
      this.write(import_ansi_escapes2.default.cursorTo(cursorPos.cols));
      this.cursorPos = cursorPos;
    }
  }
  done({ clearContent }) {
    this.rl.setPrompt("");
    let output = cursorDown(this.extraLinesUnderPrompt);
    output += clearContent ? import_ansi_escapes2.default.eraseLines(this.height) : "\n";
    output += import_ansi_escapes2.default.cursorShow;
    this.write(output);
    this.rl.close();
  }
};

// ../../node_modules/.pnpm/@inquirer+core@9.2.1/node_modules/@inquirer/core/dist/esm/lib/promise-polyfill.mjs
var PromisePolyfill = class extends Promise {
  // Available starting from Node 22
  // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise/withResolvers
  static withResolver() {
    let resolve2;
    let reject;
    const promise = new Promise((res, rej) => {
      resolve2 = res;
      reject = rej;
    });
    return { promise, resolve: resolve2, reject };
  }
};

// ../../node_modules/.pnpm/@inquirer+core@9.2.1/node_modules/@inquirer/core/dist/esm/lib/create-prompt.mjs
function createPrompt2(view) {
  const prompt = (config2, context = {}) => {
    const { input = process.stdin, signal } = context;
    const cleanups = /* @__PURE__ */ new Set();
    const output = new import_mute_stream.default();
    output.pipe(context.output ?? process.stdout);
    const rl = readline2.createInterface({
      terminal: true,
      input,
      output
    });
    const screen = new ScreenManager(rl);
    const { promise, resolve: resolve2, reject } = PromisePolyfill.withResolver();
    const cancel = () => reject(new CancelPromptError());
    if (signal) {
      const abort = () => reject(new AbortPromptError({ cause: signal.reason }));
      if (signal.aborted) {
        abort();
        return Object.assign(promise, { cancel });
      }
      signal.addEventListener("abort", abort);
      cleanups.add(() => signal.removeEventListener("abort", abort));
    }
    cleanups.add(onExit((code, signal2) => {
      reject(new ExitPromptError(`User force closed the prompt with ${code} ${signal2}`));
    }));
    const checkCursorPos = () => screen.checkCursorPos();
    rl.input.on("keypress", checkCursorPos);
    cleanups.add(() => rl.input.removeListener("keypress", checkCursorPos));
    return withHooks(rl, (cycle) => {
      const hooksCleanup = AsyncResource3.bind(() => effectScheduler.clearAll());
      rl.on("close", hooksCleanup);
      cleanups.add(() => rl.removeListener("close", hooksCleanup));
      cycle(() => {
        try {
          const nextView = view(config2, (value) => {
            setImmediate(() => resolve2(value));
          });
          const [content, bottomContent] = typeof nextView === "string" ? [nextView] : nextView;
          screen.render(content, bottomContent);
          effectScheduler.run();
        } catch (error) {
          reject(error);
        }
      });
      return Object.assign(promise.then((answer) => {
        effectScheduler.clearAll();
        return answer;
      }, (error) => {
        effectScheduler.clearAll();
        throw error;
      }).finally(() => {
        cleanups.forEach((cleanup) => cleanup());
        screen.done({ clearContent: Boolean(context?.clearPromptOnDone) });
        output.end();
      }).then(() => promise), { cancel });
    });
  };
  return prompt;
}

// ../../node_modules/.pnpm/@inquirer+core@9.2.1/node_modules/@inquirer/core/dist/esm/lib/Separator.mjs
var import_yoctocolors_cjs2 = __toESM(require_yoctocolors_cjs(), 1);
var Separator = class {
  constructor(separator) {
    __publicField(this, "separator", import_yoctocolors_cjs2.default.dim(Array.from({ length: 15 }).join(esm_default.line)));
    __publicField(this, "type", "separator");
    if (separator) {
      this.separator = separator;
    }
  }
  static isSeparator(choice) {
    return Boolean(choice && typeof choice === "object" && "type" in choice && choice.type === "separator");
  }
};

// ../../node_modules/.pnpm/@inquirer+search@2.0.1/node_modules/@inquirer/search/dist/esm/index.mjs
var import_yoctocolors_cjs3 = __toESM(require_yoctocolors_cjs(), 1);
var searchTheme = {
  icon: { cursor: esm_default.pointer },
  style: {
    disabled: (text) => import_yoctocolors_cjs3.default.dim(`- ${text}`),
    searchTerm: (text) => import_yoctocolors_cjs3.default.cyan(text),
    description: (text) => import_yoctocolors_cjs3.default.cyan(text)
  },
  helpMode: "auto"
};
function isSelectable(item) {
  return !Separator.isSeparator(item) && !item.disabled;
}
function normalizeChoices(choices) {
  return choices.map((choice) => {
    if (Separator.isSeparator(choice))
      return choice;
    if (typeof choice === "string") {
      return {
        value: choice,
        name: choice,
        short: choice,
        disabled: false
      };
    }
    const name = choice.name ?? String(choice.value);
    return {
      value: choice.value,
      name,
      description: choice.description,
      short: choice.short ?? name,
      disabled: choice.disabled ?? false
    };
  });
}
var esm_default8 = createPrompt2((config2, done) => {
  const { pageSize = 7, validate = () => true } = config2;
  const theme = makeTheme2(searchTheme, config2.theme);
  const firstRender = useRef(true);
  const [status, setStatus] = useState2("loading");
  const [searchTerm, setSearchTerm] = useState2("");
  const [searchResults, setSearchResults] = useState2([]);
  const [searchError, setSearchError] = useState2();
  const prefix = usePrefix2({ status, theme });
  const bounds = useMemo(() => {
    const first = searchResults.findIndex(isSelectable);
    const last = searchResults.findLastIndex(isSelectable);
    return { first, last };
  }, [searchResults]);
  const [active = bounds.first, setActive] = useState2();
  useEffect(() => {
    const controller = new AbortController();
    setStatus("loading");
    setSearchError(void 0);
    const fetchResults = async () => {
      try {
        const results = await config2.source(searchTerm || void 0, {
          signal: controller.signal
        });
        if (!controller.signal.aborted) {
          setActive(void 0);
          setSearchError(void 0);
          setSearchResults(normalizeChoices(results));
          setStatus("idle");
        }
      } catch (error2) {
        if (!controller.signal.aborted && error2 instanceof Error) {
          setSearchError(error2.message);
        }
      }
    };
    void fetchResults();
    return () => {
      controller.abort();
    };
  }, [searchTerm]);
  const selectedChoice = searchResults[active];
  useKeypress2(async (key, rl) => {
    if (isEnterKey2(key)) {
      if (selectedChoice) {
        setStatus("loading");
        const isValid = await validate(selectedChoice.value);
        setStatus("idle");
        if (isValid === true) {
          setStatus("done");
          done(selectedChoice.value);
        } else if (selectedChoice.name === searchTerm) {
          setSearchError(isValid || "You must provide a valid value");
        } else {
          rl.write(selectedChoice.name);
          setSearchTerm(selectedChoice.name);
        }
      } else {
        rl.write(searchTerm);
      }
    } else if (key.name === "tab" && selectedChoice) {
      rl.clearLine(0);
      rl.write(selectedChoice.name);
      setSearchTerm(selectedChoice.name);
    } else if (status !== "loading" && (key.name === "up" || key.name === "down")) {
      rl.clearLine(0);
      if (key.name === "up" && active !== bounds.first || key.name === "down" && active !== bounds.last) {
        const offset = key.name === "up" ? -1 : 1;
        let next = active;
        do {
          next = (next + offset + searchResults.length) % searchResults.length;
        } while (!isSelectable(searchResults[next]));
        setActive(next);
      }
    } else {
      setSearchTerm(rl.line);
    }
  });
  const message = theme.style.message(config2.message, status);
  if (active > 0) {
    firstRender.current = false;
  }
  let helpTip = "";
  if (searchResults.length > 1 && (theme.helpMode === "always" || theme.helpMode === "auto" && firstRender.current)) {
    helpTip = searchResults.length > pageSize ? `
${theme.style.help("(Use arrow keys to reveal more choices)")}` : `
${theme.style.help("(Use arrow keys)")}`;
  }
  const page = usePagination({
    items: searchResults,
    active,
    renderItem({ item, isActive }) {
      if (Separator.isSeparator(item)) {
        return ` ${item.separator}`;
      }
      if (item.disabled) {
        const disabledLabel = typeof item.disabled === "string" ? item.disabled : "(disabled)";
        return theme.style.disabled(`${item.name} ${disabledLabel}`);
      }
      const color = isActive ? theme.style.highlight : (x) => x;
      const cursor = isActive ? theme.icon.cursor : ` `;
      return color(`${cursor} ${item.name}`);
    },
    pageSize,
    loop: false
  });
  let error;
  if (searchError) {
    error = theme.style.error(searchError);
  } else if (searchResults.length === 0 && searchTerm !== "" && status === "idle") {
    error = theme.style.error("No results found");
  }
  let searchStr;
  if (status === "done" && selectedChoice) {
    const answer = selectedChoice.short ?? selectedChoice.name;
    return `${prefix} ${message} ${theme.style.answer(answer)}`;
  } else {
    searchStr = theme.style.searchTerm(searchTerm);
  }
  const choiceDescription = selectedChoice?.description ? `
${theme.style.description(selectedChoice.description)}` : ``;
  return [
    [prefix, message, searchStr].filter(Boolean).join(" "),
    `${error ?? page}${helpTip}${choiceDescription}`
  ];
});

// src/util/client.ts
var import_async_retry = __toESM(require_dist3(), 1);
import { join as join2, resolve } from "path";
import { EventEmitter } from "events";
import { URL } from "url";
import {
  getGlobalPathConfig as getSharedGlobalPathConfig,
  readConfigFile as readSharedConfigFile,
  writeConfigFile as writeSharedConfigFile
} from "@vercel/cli-config";

// src/util/response-error.ts
async function responseError(res, fallbackMessage = null, parsedBody = {}) {
  let bodyError;
  if (!res.ok) {
    let body;
    try {
      body = await res.json();
    } catch (_err) {
      body = parsedBody;
    }
    bodyError = body.error || body.err || body;
  }
  const msg = bodyError?.message || fallbackMessage || "Response Error";
  return new APIError(msg, res, bodyError);
}

// src/util/print-indications.ts
var import_chalk2 = __toESM(require_source(), 1);
function printIndications(res) {
  const indications = /* @__PURE__ */ new Set(["warning", "notice", "tip"]);
  const regex = /^x-(?:vercel|now)-(warning|notice|tip)-(.*)$/;
  for (const [name, payload] of res.headers) {
    const match = name.match(regex);
    if (match) {
      const [, type, identifier] = match;
      const action = res.headers.get(`x-vercel-action-${identifier}`);
      const link = res.headers.get(`x-vercel-link-${identifier}`);
      if (indications.has(type)) {
        const newline = "\n";
        const message = prependEmoji(import_chalk2.default.dim(payload), emoji(type)) + newline;
        let finalLink = "";
        if (link) {
          finalLink = import_chalk2.default.dim(`${action || "Learn More"}: ${link_default(link)}`) + newline;
        }
        output_manager_default.print(message + finalLink);
      }
    }
  }
}

// src/util/login/reauthenticate.ts
var import_chalk3 = __toESM(require_source(), 1);
async function reauthenticate(client, error) {
  const { tokenSource } = client.authConfig;
  const reauthAction = error.enforced ? "SAML re-authentication is required" : "Re-authentication is required";
  if (tokenSource === "flag") {
    throw new Error(
      `${reauthAction} for ${(0, import_chalk3.bold)(error.scope)} scope, but the token provided via \`--token\` does not have access. Provide a token that is authorized for that scope.`
    );
  }
  if (tokenSource === "env") {
    throw new Error(
      `${reauthAction} for ${(0, import_chalk3.bold)(error.scope)} scope, but the token provided via the VERCEL_TOKEN environment variable does not have access. Set VERCEL_TOKEN to a token that is authorized for that scope.`
    );
  }
  if (!client.stdin.isTTY && process.env.CI) {
    throw new Error(
      `${reauthAction} for ${(0, import_chalk3.bold)(error.scope)} scope, but the current environment is non-interactive so the device-code flow cannot be completed. Run \`vercel login\` in an interactive shell, or set VERCEL_TOKEN / pass \`--token\` with a token that is authorized for that scope.`
    );
  }
  if (error.teamId && error.enforced) {
    output_manager_default.log(
      `You must re-authenticate with SAML to use ${(0, import_chalk3.bold)(error.scope)} scope.`
    );
  } else {
    output_manager_default.log(`You must re-authenticate to use ${(0, import_chalk3.bold)(error.scope)} scope.`);
  }
  const tokens = await performDeviceCodeFlow(client, {
    teamId: error.teamId || void 0
  });
  if (!tokens) {
    return 1;
  }
  client.updateAuthConfig({
    token: tokens.access_token,
    userId: void 0,
    expiresAt: Math.floor(Date.now() / 1e3) + tokens.expires_in,
    refreshToken: tokens.refresh_token
  });
  client.persistAuthConfig();
  output_manager_default.success(`Authentication complete for ${(0, import_chalk3.bold)(error.scope)} scope.`);
  return { token: tokens.access_token, email: "" };
}

// src/util/promise.ts
function sharedPromise(fn) {
  let promise = null;
  return function(...args) {
    if (!promise) {
      promise = fn.apply(this, args);
      promise.finally(() => {
        promise = null;
      });
    }
    return promise;
  };
}

// src/util/client.ts
var import_error_utils2 = __toESM(require_dist(), 1);

// src/util/sleep.ts
function sleep(ms) {
  return new Promise((resolve2) => {
    setTimeout(resolve2, ms);
  });
}

// src/util/client.ts
var DOMAINS_API_PATH = /^\/v\d+\/(?:domains|registrar)(?:\/|$)/;
var isSAMLError = (v) => {
  return v && v.saml;
};
var isJSONObject = (v) => {
  return v && typeof v == "object" && v.constructor === Object;
};
function isValidAccessToken(authConfig) {
  if (!authConfig.token)
    return false;
  if (typeof authConfig.expiresAt !== "number")
    return true;
  const nowInSeconds = Math.floor(Date.now() / 1e3);
  return authConfig.expiresAt >= nowInSeconds;
}
function hasRefreshToken(authConfig) {
  return "refreshToken" in authConfig;
}
var Client = class extends EventEmitter {
  constructor(opts) {
    super();
    this._argv = [];
    /** Track if we've already logged the token source debug message */
    this._loggedTokenSource = false;
    this.escapePromptCancellationDepth = 0;
    this.promptBackNavigationDepth = 0;
    this.reauthenticate = sharedPromise(async function(error) {
      const result = await reauthenticate(this, error);
      if (typeof result === "number") {
        if (error instanceof APIError) {
          output_manager_default.prettyError(error);
        } else {
          output_manager_default.error(
            `Failed to re-authenticate for ${(0, import_chalk4.bold)(error.scope)} scope`
          );
        }
        throw error;
      }
    });
    this._onRetry = (error) => {
      output_manager_default.debug(`Retrying: ${error}
${error.stack}`);
    };
    this.setArgv(opts.argv);
    this.apiUrl = opts.apiUrl;
    this.authConfig = opts.authConfig;
    this.stdin = opts.stdin;
    this.stdout = opts.stdout;
    this.stderr = opts.stderr;
    this.config = opts.config;
    this.localConfig = opts.localConfig;
    this.localConfigPath = opts.localConfigPath;
    this.requestIdCounter = 1;
    this.telemetryEventStore = opts.telemetryEventStore;
    this.isAgent = opts.isAgent ?? false;
    this.agentName = opts.agentName;
    this.nonInteractive = opts.nonInteractive ?? this.isAgent;
    this.dangerouslySkipPermissions = opts.dangerouslySkipPermissions ?? false;
    const theme = {
      prefix: (0, import_chalk4.gray)("?"),
      style: { answer: import_chalk4.gray }
    };
    this.input = {
      text: (opts2) => this.runPrompt(
        esm_default6({ theme, ...opts2 }, { input: this.stdin, output: this.stderr })
      ),
      password: (opts2) => this.runPrompt(
        esm_default7(
          { theme, ...opts2 },
          { input: this.stdin, output: this.stderr }
        )
      ),
      checkbox: (opts2) => this.runPrompt(
        esm_default2(
          { theme, ...opts2 },
          { input: this.stdin, output: this.stderr }
        )
      ),
      expand: (opts2) => this.runPrompt(
        esm_default5({ theme, ...opts2 }, { input: this.stdin, output: this.stderr })
      ),
      confirm: (message, default_value) => this.runPrompt(
        esm_default4(
          { theme, message, default: default_value },
          { input: this.stdin, output: this.stderr }
        )
      ),
      select: (opts2) => this.runPrompt(
        esm_default3(
          { theme, ...opts2 },
          { input: this.stdin, output: this.stderr }
        )
      ),
      search: (opts2) => this.runPrompt(
        esm_default8(
          { theme, ...opts2 },
          { input: this.stdin, output: this.stderr }
        )
      )
    };
  }
  async withEscapePromptCancellation(run) {
    this.escapePromptCancellationDepth++;
    try {
      return await run();
    } finally {
      this.escapePromptCancellationDepth--;
    }
  }
  async withPromptBackNavigation(run) {
    this.promptBackNavigationDepth++;
    try {
      return await run();
    } finally {
      this.promptBackNavigationDepth--;
    }
  }
  runPrompt(prompt) {
    const escapeCancellationEnabled = this.escapePromptCancellationDepth > 0;
    const backNavigationEnabled = this.promptBackNavigationDepth > 0;
    if (!escapeCancellationEnabled && !backNavigationEnabled || !this.stdin.isTTY || !prompt.cancel) {
      return prompt;
    }
    let cancellation;
    const onKeypress = (_input, key) => {
      if (key?.name === "escape" && escapeCancellationEnabled && !cancellation) {
        cancellation = "escape";
        prompt.cancel?.();
      } else if (key?.name === "up" && backNavigationEnabled && !cancellation) {
        cancellation = "back";
        prompt.cancel?.();
      }
    };
    this.stdin.on("keypress", onKeypress);
    return prompt.catch((error) => {
      if (cancellation === "escape") {
        throw new PromptCanceledError();
      }
      if (cancellation === "back") {
        throw new PromptBackError();
      }
      throw error;
    }).finally(() => {
      this.stdin.off("keypress", onKeypress);
    });
  }
  get argv() {
    return this._argv;
  }
  setArgv(argvOrFirst, ...rest) {
    const argv = Array.isArray(argvOrFirst) ? argvOrFirst : [argvOrFirst, ...rest];
    this._argv = argv;
    this._parsedArgsCache = void 0;
  }
  getParsedArgs() {
    if (!this._parsedArgsCache) {
      this._parsedArgsCache = parseArguments(
        this.argv.slice(2),
        {},
        {
          permissive: true
        }
      );
    }
    return this._parsedArgsCache;
  }
  retry(fn, { retries = 3, maxTimeout = Infinity } = {}) {
    return (0, import_async_retry.default)(fn, {
      retries,
      maxTimeout,
      onRetry: this._onRetry
    });
  }
  /**
   * This method silently tries to refresh the access_token if it is expired.
   *
   * If the refresh_token is also expired, it will not attempt to refresh it.
   * If there is any error during the refresh process, it will not throw an error.
   */
  async ensureAuthorized() {
    const { authConfig } = this;
    if (isValidAccessToken(authConfig)) {
      if (!this._loggedTokenSource) {
        if (authConfig.tokenSource === "flag") {
          output_manager_default.debug(
            "Using token from `--token` argument, skipping token refresh."
          );
        } else if (authConfig.tokenSource === "env") {
          output_manager_default.debug(
            "Using token from VERCEL_TOKEN environment variable, skipping token refresh."
          );
        } else {
          output_manager_default.debug("Valid access token, skipping token refresh.");
        }
        this._loggedTokenSource = true;
      }
      return;
    }
    if (!hasRefreshToken(authConfig)) {
      output_manager_default.debug("No refresh token found, emptying auth config.");
      this.emptyAuthConfig();
      this.persistAuthConfig();
      return;
    }
    const tokenResponse = await refreshTokenRequest({
      refresh_token: authConfig.refreshToken
    });
    const [tokensError, tokens] = await processTokenResponse(tokenResponse);
    if (isOAuthError(tokensError) && tokensError.code === "invalid_grant" && !authConfig.tokenSource && this.stdin.isTTY && !this.nonInteractive) {
      output_manager_default.debug(
        `Stored session refresh failed: ${tokensError.cause.message}`
      );
      output_manager_default.log("Couldn't refresh the saved login. Starting a new login.");
      const recoveredTokens = await performDeviceCodeFlow(this);
      if (recoveredTokens) {
        this.updateAuthConfig({
          token: recoveredTokens.access_token,
          userId: void 0,
          expiresAt: Math.floor(Date.now() / 1e3) + recoveredTokens.expires_in,
          refreshToken: recoveredTokens.refresh_token
        });
        this.persistAuthConfig();
        return;
      }
    }
    if (tokensError) {
      output_manager_default.debug("Error refreshing token, emptying auth config.");
      this.emptyAuthConfig();
      this.persistAuthConfig();
      return;
    }
    this.updateAuthConfig({
      token: tokens.access_token,
      expiresAt: Math.floor(Date.now() / 1e3) + tokens.expires_in
    });
    if (tokens.refresh_token) {
      this.updateAuthConfig({ refreshToken: tokens.refresh_token });
    }
    this.persistAuthConfig();
    this.writeToConfigFile();
    output_manager_default.debug("Tokens refreshed successfully.");
  }
  getGlobalPathConfig() {
    const confFlag = this.getParsedArgs().flags["--global-config"];
    if (typeof confFlag === "string") {
      return resolve(this.cwd, confFlag);
    }
    return getSharedGlobalPathConfig();
  }
  async readConfig(fileName, schema) {
    const filePath = join2(this.getGlobalPathConfig(), fileName);
    return readSharedConfigFile(filePath, schema);
  }
  async maybeReadConfig(fileName, schema) {
    try {
      return await this.readConfig(fileName, schema);
    } catch {
      return null;
    }
  }
  async writeConfig(fileName, schema, value) {
    const filePath = join2(this.getGlobalPathConfig(), fileName);
    writeSharedConfigFile(filePath, schema, value);
  }
  updateConfig(config2) {
    this.config = { ...this.config, ...config2 };
  }
  writeToConfigFile() {
    writeToConfigFile(this.config);
  }
  updateAuthConfig(authConfig) {
    if (authConfig.token && authConfig.token !== this.authConfig.token) {
      this.user = void 0;
      this.userPromise = void 0;
      this.teams = void 0;
      this.teamsPromise = void 0;
    }
    this.authConfig = { ...this.authConfig, ...authConfig };
  }
  emptyAuthConfig() {
    this.user = void 0;
    this.userPromise = void 0;
    this.teams = void 0;
    this.teamsPromise = void 0;
    this.authConfig = this.authConfig.skipWrite ? { skipWrite: true } : {};
  }
  persistAuthConfig() {
    persistAuthConfig(this.authConfig, this.config);
  }
  /**
   * Confirms DELETE operations with the user.
   *
   * - DELETE operations always require confirmation (unless --dangerously-skip-permissions is used)
   * - When running under an AI agent with --dangerously-skip-permissions,
   *   a warning is displayed for visibility
   *
   * @returns true if the operation should proceed, false if canceled
   */
  async confirmMutatingOperation(url, method) {
    const normalizedMethod = (method || "GET").toUpperCase();
    const isDelete = normalizedMethod === "DELETE";
    if (!isDelete) {
      return true;
    }
    if (this.isAgent && this.dangerouslySkipPermissions) {
      const agentInfo = this.agentName ? ` (${this.agentName})` : "";
      output_manager_default.print("\n");
      output_manager_default.print(
        (0, import_chalk4.bgRed)((0, import_chalk4.white)((0, import_chalk4.bold)(" \u26A0 WARNING "))) + (0, import_chalk4.red)((0, import_chalk4.bold)(" AGENT MODE - DELETE CONFIRMATION BYPASSED\n"))
      );
      output_manager_default.print(
        (0, import_chalk4.yellow)(
          `  An AI agent${agentInfo} is executing a ${(0, import_chalk4.bold)("DELETE")} request with --dangerously-skip-permissions flag.
`
        )
      );
      output_manager_default.print((0, import_chalk4.yellow)(`  This operation will delete data: ${(0, import_chalk4.bold)(url)}
`));
      output_manager_default.print(
        (0, import_chalk4.yellow)(
          `  The --dangerously-skip-permissions flag has bypassed the confirmation prompt.

`
        )
      );
    }
    if (this.dangerouslySkipPermissions) {
      return true;
    }
    if (!this.stdin.isTTY) {
      output_manager_default.error(
        `DELETE operations require confirmation. Use ${(0, import_chalk4.bold)("--dangerously-skip-permissions")} to skip confirmation in non-interactive mode.`
      );
      return false;
    }
    const message = `You are about to perform a ${(0, import_chalk4.red)((0, import_chalk4.bold)("DELETE"))} operation on:
  ${(0, import_chalk4.bold)(url)}

Are you sure you want to proceed?`;
    output_manager_default.print("\n");
    const confirmed = await this.input.confirm(message, false);
    output_manager_default.print("\n");
    if (!confirmed) {
      output_manager_default.log("Operation canceled by user.");
    }
    return confirmed;
  }
  async _fetch(_url, opts = {}) {
    const url = new URL(_url, this.apiUrl);
    if (opts.accountId || opts.useCurrentTeam !== false) {
      if (opts.accountId) {
        if (opts.accountId.startsWith("team_")) {
          url.searchParams.set("teamId", opts.accountId);
        } else {
          url.searchParams.delete("teamId");
        }
      } else if (opts.useCurrentTeam !== false && this.config.currentTeam && !url.searchParams.has("teamId")) {
        url.searchParams.set("teamId", this.config.currentTeam);
      }
    }
    const headers = new Headers(opts.headers);
    headers.set("user-agent", ua_default);
    if (DOMAINS_API_PATH.test(url.pathname)) {
      headers.set("x-vercel-cli-version", pkg_default.version);
    }
    if (this.agentName) {
      headers.set("x-ai-agent", this.agentName);
    }
    headers.set(
      "x-vercel-cli-session-id",
      this.telemetryEventStore.currentSessionId
    );
    headers.set(
      "x-vercel-cli-invocation-id",
      this.telemetryEventStore.currentInvocationId
    );
    await this.ensureAuthorized();
    if (this.authConfig.token) {
      headers.set("authorization", `Bearer ${this.authConfig.token}`);
    }
    let body;
    if (isJSONObject(opts.body)) {
      body = JSON.stringify(opts.body);
      headers.set("content-type", "application/json; charset=utf-8");
    } else {
      body = opts.body;
    }
    const requestId = this.requestIdCounter++;
    return output_manager_default.time(
      (res) => {
        if (res) {
          return `#${requestId} \u2190 ${res.status} ${res.statusText}: ${res.headers.get("x-vercel-id")}`;
        } else {
          return `#${requestId} \u2192 ${opts.method || "GET"} ${url.href}`;
        }
      },
      fetch(url, { ...opts, headers, body })
    );
  }
  fetch(url, opts = {}) {
    return this.retry(async (bail) => {
      let res;
      try {
        res = await this._fetch(url, opts);
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          return bail(err);
        }
        throw err;
      }
      printIndications(res);
      if (!res.ok) {
        if (opts.redirect === "manual" && res.status >= 300 && res.status < 400) {
          return res;
        }
        const error = await responseError(res);
        if (isSAMLError(error) && error.teamId) {
          try {
            await this.reauthenticate(error);
          } catch (reauthError) {
            return bail((0, import_error_utils2.normalizeError)(reauthError));
          }
        } else if (res.status === 429 && opts.bailOn429) {
          return bail(error);
        } else if (typeof error.retryAfterMs === "number") {
          const randomSkewMs = 3e4 * Math.random();
          await sleep(error.retryAfterMs + randomSkewMs);
        } else if (res.status >= 400 && res.status < 500) {
          return bail(error);
        }
        throw error;
      }
      if (opts.json === false) {
        return res;
      }
      const contentType = res.headers.get("content-type");
      if (!contentType) {
        return null;
      }
      return contentType.includes("application/json") ? res.json() : res;
    }, opts.retry);
  }
  async *fetchPaginated(url, opts) {
    const endpoint = typeof url === "string" ? new URL(url, this.apiUrl) : new URL(url.href);
    if (!endpoint.searchParams.has("limit")) {
      endpoint.searchParams.set("limit", "100");
    }
    let next;
    do {
      if (next) {
        await sleep(100);
        endpoint.searchParams.set("until", String(next));
      }
      const res = await this.fetch(
        endpoint.href,
        opts
      );
      yield res;
      next = res.pagination?.next;
    } while (next);
  }
  get cwd() {
    return process.cwd();
  }
  set cwd(v) {
    process.chdir(v);
  }
};

export {
  require_dist3 as require_dist,
  printIndications,
  readConfigFile,
  writeToConfigFile,
  readAuthConfigFile,
  persistAuthConfig,
  getConfigFilePath2 as getConfigFilePath,
  getAuthConfigFilePath2 as getAuthConfigFilePath,
  readLocalConfig,
  sleep,
  isJSONObject,
  Client
};
