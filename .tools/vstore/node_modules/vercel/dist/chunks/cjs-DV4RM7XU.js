import { createRequire as __createRequire } from 'node:module';
import { fileURLToPath as __fileURLToPath } from 'node:url';
import { dirname as __dirname_ } from 'node:path';
const require = __createRequire(import.meta.url);
const __filename = __fileURLToPath(import.meta.url);
const __dirname = __dirname_(__filename);
import {
  __commonJS,
  __require
} from "./chunk-TZ2YI2VH.js";

// ../../node_modules/.pnpm/@sentry+utils@7.120.1/node_modules/@sentry/utils/cjs/is.js
var require_is = __commonJS({
  "../../node_modules/.pnpm/@sentry+utils@7.120.1/node_modules/@sentry/utils/cjs/is.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var objectToString = Object.prototype.toString;
    function isError(wat) {
      switch (objectToString.call(wat)) {
        case "[object Error]":
        case "[object Exception]":
        case "[object DOMException]":
          return true;
        default:
          return isInstanceOf(wat, Error);
      }
    }
    function isBuiltin(wat, className) {
      return objectToString.call(wat) === `[object ${className}]`;
    }
    function isErrorEvent(wat) {
      return isBuiltin(wat, "ErrorEvent");
    }
    function isDOMError(wat) {
      return isBuiltin(wat, "DOMError");
    }
    function isDOMException(wat) {
      return isBuiltin(wat, "DOMException");
    }
    function isString(wat) {
      return isBuiltin(wat, "String");
    }
    function isParameterizedString(wat) {
      return typeof wat === "object" && wat !== null && "__sentry_template_string__" in wat && "__sentry_template_values__" in wat;
    }
    function isPrimitive(wat) {
      return wat === null || isParameterizedString(wat) || typeof wat !== "object" && typeof wat !== "function";
    }
    function isPlainObject(wat) {
      return isBuiltin(wat, "Object");
    }
    function isEvent(wat) {
      return typeof Event !== "undefined" && isInstanceOf(wat, Event);
    }
    function isElement(wat) {
      return typeof Element !== "undefined" && isInstanceOf(wat, Element);
    }
    function isRegExp(wat) {
      return isBuiltin(wat, "RegExp");
    }
    function isThenable(wat) {
      return Boolean(wat && wat.then && typeof wat.then === "function");
    }
    function isSyntheticEvent(wat) {
      return isPlainObject(wat) && "nativeEvent" in wat && "preventDefault" in wat && "stopPropagation" in wat;
    }
    function isNaN2(wat) {
      return typeof wat === "number" && wat !== wat;
    }
    function isInstanceOf(wat, base) {
      try {
        return wat instanceof base;
      } catch (_e) {
        return false;
      }
    }
    function isVueViewModel(wat) {
      return !!(typeof wat === "object" && wat !== null && (wat.__isVue || wat._isVue));
    }
    exports.isDOMError = isDOMError;
    exports.isDOMException = isDOMException;
    exports.isElement = isElement;
    exports.isError = isError;
    exports.isErrorEvent = isErrorEvent;
    exports.isEvent = isEvent;
    exports.isInstanceOf = isInstanceOf;
    exports.isNaN = isNaN2;
    exports.isParameterizedString = isParameterizedString;
    exports.isPlainObject = isPlainObject;
    exports.isPrimitive = isPrimitive;
    exports.isRegExp = isRegExp;
    exports.isString = isString;
    exports.isSyntheticEvent = isSyntheticEvent;
    exports.isThenable = isThenable;
    exports.isVueViewModel = isVueViewModel;
  }
});

// ../../node_modules/.pnpm/@sentry+utils@7.120.1/node_modules/@sentry/utils/cjs/string.js
var require_string = __commonJS({
  "../../node_modules/.pnpm/@sentry+utils@7.120.1/node_modules/@sentry/utils/cjs/string.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var is = require_is();
    function truncate(str, max = 0) {
      if (typeof str !== "string" || max === 0) {
        return str;
      }
      return str.length <= max ? str : `${str.slice(0, max)}...`;
    }
    function snipLine(line, colno) {
      let newLine = line;
      const lineLength = newLine.length;
      if (lineLength <= 150) {
        return newLine;
      }
      if (colno > lineLength) {
        colno = lineLength;
      }
      let start = Math.max(colno - 60, 0);
      if (start < 5) {
        start = 0;
      }
      let end = Math.min(start + 140, lineLength);
      if (end > lineLength - 5) {
        end = lineLength;
      }
      if (end === lineLength) {
        start = Math.max(end - 140, 0);
      }
      newLine = newLine.slice(start, end);
      if (start > 0) {
        newLine = `'{snip} ${newLine}`;
      }
      if (end < lineLength) {
        newLine += " {snip}";
      }
      return newLine;
    }
    function safeJoin(input, delimiter) {
      if (!Array.isArray(input)) {
        return "";
      }
      const output = [];
      for (let i = 0; i < input.length; i++) {
        const value = input[i];
        try {
          if (is.isVueViewModel(value)) {
            output.push("[VueViewModel]");
          } else {
            output.push(String(value));
          }
        } catch (e) {
          output.push("[value cannot be serialized]");
        }
      }
      return output.join(delimiter);
    }
    function isMatchingPattern(value, pattern, requireExactStringMatch = false) {
      if (!is.isString(value)) {
        return false;
      }
      if (is.isRegExp(pattern)) {
        return pattern.test(value);
      }
      if (is.isString(pattern)) {
        return requireExactStringMatch ? value === pattern : value.includes(pattern);
      }
      return false;
    }
    function stringMatchesSomePattern(testString, patterns = [], requireExactStringMatch = false) {
      return patterns.some((pattern) => isMatchingPattern(testString, pattern, requireExactStringMatch));
    }
    exports.isMatchingPattern = isMatchingPattern;
    exports.safeJoin = safeJoin;
    exports.snipLine = snipLine;
    exports.stringMatchesSomePattern = stringMatchesSomePattern;
    exports.truncate = truncate;
  }
});

// ../../node_modules/.pnpm/@sentry+utils@7.120.1/node_modules/@sentry/utils/cjs/aggregate-errors.js
var require_aggregate_errors = __commonJS({
  "../../node_modules/.pnpm/@sentry+utils@7.120.1/node_modules/@sentry/utils/cjs/aggregate-errors.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var is = require_is();
    var string = require_string();
    function applyAggregateErrorsToEvent(exceptionFromErrorImplementation, parser, maxValueLimit = 250, key, limit, event, hint) {
      if (!event.exception || !event.exception.values || !hint || !is.isInstanceOf(hint.originalException, Error)) {
        return;
      }
      const originalException = event.exception.values.length > 0 ? event.exception.values[event.exception.values.length - 1] : void 0;
      if (originalException) {
        event.exception.values = truncateAggregateExceptions(
          aggregateExceptionsFromError(
            exceptionFromErrorImplementation,
            parser,
            limit,
            hint.originalException,
            key,
            event.exception.values,
            originalException,
            0
          ),
          maxValueLimit
        );
      }
    }
    function aggregateExceptionsFromError(exceptionFromErrorImplementation, parser, limit, error, key, prevExceptions, exception, exceptionId) {
      if (prevExceptions.length >= limit + 1) {
        return prevExceptions;
      }
      let newExceptions = [...prevExceptions];
      if (is.isInstanceOf(error[key], Error)) {
        applyExceptionGroupFieldsForParentException(exception, exceptionId);
        const newException = exceptionFromErrorImplementation(parser, error[key]);
        const newExceptionId = newExceptions.length;
        applyExceptionGroupFieldsForChildException(newException, key, newExceptionId, exceptionId);
        newExceptions = aggregateExceptionsFromError(
          exceptionFromErrorImplementation,
          parser,
          limit,
          error[key],
          key,
          [newException, ...newExceptions],
          newException,
          newExceptionId
        );
      }
      if (Array.isArray(error.errors)) {
        error.errors.forEach((childError, i) => {
          if (is.isInstanceOf(childError, Error)) {
            applyExceptionGroupFieldsForParentException(exception, exceptionId);
            const newException = exceptionFromErrorImplementation(parser, childError);
            const newExceptionId = newExceptions.length;
            applyExceptionGroupFieldsForChildException(newException, `errors[${i}]`, newExceptionId, exceptionId);
            newExceptions = aggregateExceptionsFromError(
              exceptionFromErrorImplementation,
              parser,
              limit,
              childError,
              key,
              [newException, ...newExceptions],
              newException,
              newExceptionId
            );
          }
        });
      }
      return newExceptions;
    }
    function applyExceptionGroupFieldsForParentException(exception, exceptionId) {
      exception.mechanism = exception.mechanism || { type: "generic", handled: true };
      exception.mechanism = {
        ...exception.mechanism,
        ...exception.type === "AggregateError" && { is_exception_group: true },
        exception_id: exceptionId
      };
    }
    function applyExceptionGroupFieldsForChildException(exception, source, exceptionId, parentId) {
      exception.mechanism = exception.mechanism || { type: "generic", handled: true };
      exception.mechanism = {
        ...exception.mechanism,
        type: "chained",
        source,
        exception_id: exceptionId,
        parent_id: parentId
      };
    }
    function truncateAggregateExceptions(exceptions, maxValueLength) {
      return exceptions.map((exception) => {
        if (exception.value) {
          exception.value = string.truncate(exception.value, maxValueLength);
        }
        return exception;
      });
    }
    exports.applyAggregateErrorsToEvent = applyAggregateErrorsToEvent;
  }
});

// ../../node_modules/.pnpm/@sentry+utils@7.120.1/node_modules/@sentry/utils/cjs/worldwide.js
var require_worldwide = __commonJS({
  "../../node_modules/.pnpm/@sentry+utils@7.120.1/node_modules/@sentry/utils/cjs/worldwide.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    function isGlobalObj(obj) {
      return obj && obj.Math == Math ? obj : void 0;
    }
    var GLOBAL_OBJ = typeof globalThis == "object" && isGlobalObj(globalThis) || // eslint-disable-next-line no-restricted-globals
    typeof window == "object" && isGlobalObj(window) || typeof self == "object" && isGlobalObj(self) || typeof global == "object" && isGlobalObj(global) || function() {
      return this;
    }() || {};
    function getGlobalObject() {
      return GLOBAL_OBJ;
    }
    function getGlobalSingleton(name, creator, obj) {
      const gbl = obj || GLOBAL_OBJ;
      const __SENTRY__ = gbl.__SENTRY__ = gbl.__SENTRY__ || {};
      const singleton = __SENTRY__[name] || (__SENTRY__[name] = creator());
      return singleton;
    }
    exports.GLOBAL_OBJ = GLOBAL_OBJ;
    exports.getGlobalObject = getGlobalObject;
    exports.getGlobalSingleton = getGlobalSingleton;
  }
});

// ../../node_modules/.pnpm/@sentry+utils@7.120.1/node_modules/@sentry/utils/cjs/browser.js
var require_browser = __commonJS({
  "../../node_modules/.pnpm/@sentry+utils@7.120.1/node_modules/@sentry/utils/cjs/browser.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var is = require_is();
    var worldwide = require_worldwide();
    var WINDOW = worldwide.getGlobalObject();
    var DEFAULT_MAX_STRING_LENGTH = 80;
    function htmlTreeAsString(elem, options = {}) {
      if (!elem) {
        return "<unknown>";
      }
      try {
        let currentElem = elem;
        const MAX_TRAVERSE_HEIGHT = 5;
        const out = [];
        let height = 0;
        let len = 0;
        const separator = " > ";
        const sepLength = separator.length;
        let nextStr;
        const keyAttrs = Array.isArray(options) ? options : options.keyAttrs;
        const maxStringLength = !Array.isArray(options) && options.maxStringLength || DEFAULT_MAX_STRING_LENGTH;
        while (currentElem && height++ < MAX_TRAVERSE_HEIGHT) {
          nextStr = _htmlElementAsString(currentElem, keyAttrs);
          if (nextStr === "html" || height > 1 && len + out.length * sepLength + nextStr.length >= maxStringLength) {
            break;
          }
          out.push(nextStr);
          len += nextStr.length;
          currentElem = currentElem.parentNode;
        }
        return out.reverse().join(separator);
      } catch (_oO) {
        return "<unknown>";
      }
    }
    function _htmlElementAsString(el, keyAttrs) {
      const elem = el;
      const out = [];
      let className;
      let classes;
      let key;
      let attr;
      let i;
      if (!elem || !elem.tagName) {
        return "";
      }
      if (WINDOW.HTMLElement) {
        if (elem instanceof HTMLElement && elem.dataset && elem.dataset["sentryComponent"]) {
          return elem.dataset["sentryComponent"];
        }
      }
      out.push(elem.tagName.toLowerCase());
      const keyAttrPairs = keyAttrs && keyAttrs.length ? keyAttrs.filter((keyAttr) => elem.getAttribute(keyAttr)).map((keyAttr) => [keyAttr, elem.getAttribute(keyAttr)]) : null;
      if (keyAttrPairs && keyAttrPairs.length) {
        keyAttrPairs.forEach((keyAttrPair) => {
          out.push(`[${keyAttrPair[0]}="${keyAttrPair[1]}"]`);
        });
      } else {
        if (elem.id) {
          out.push(`#${elem.id}`);
        }
        className = elem.className;
        if (className && is.isString(className)) {
          classes = className.split(/\s+/);
          for (i = 0; i < classes.length; i++) {
            out.push(`.${classes[i]}`);
          }
        }
      }
      const allowedAttrs = ["aria-label", "type", "name", "title", "alt"];
      for (i = 0; i < allowedAttrs.length; i++) {
        key = allowedAttrs[i];
        attr = elem.getAttribute(key);
        if (attr) {
          out.push(`[${key}="${attr}"]`);
        }
      }
      return out.join("");
    }
    function getLocationHref() {
      try {
        return WINDOW.document.location.href;
      } catch (oO) {
        return "";
      }
    }
    function getDomElement(selector) {
      if (WINDOW.document && WINDOW.document.querySelector) {
        return WINDOW.document.querySelector(selector);
      }
      return null;
    }
    function getComponentName(elem) {
      if (!WINDOW.HTMLElement) {
        return null;
      }
      let currentElem = elem;
      const MAX_TRAVERSE_HEIGHT = 5;
      for (let i = 0; i < MAX_TRAVERSE_HEIGHT; i++) {
        if (!currentElem) {
          return null;
        }
        if (currentElem instanceof HTMLElement && currentElem.dataset["sentryComponent"]) {
          return currentElem.dataset["sentryComponent"];
        }
        currentElem = currentElem.parentNode;
      }
      return null;
    }
    exports.getComponentName = getComponentName;
    exports.getDomElement = getDomElement;
    exports.getLocationHref = getLocationHref;
    exports.htmlTreeAsString = htmlTreeAsString;
  }
});

// ../../node_modules/.pnpm/@sentry+utils@7.120.1/node_modules/@sentry/utils/cjs/debug-build.js
var require_debug_build = __commonJS({
  "../../node_modules/.pnpm/@sentry+utils@7.120.1/node_modules/@sentry/utils/cjs/debug-build.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var DEBUG_BUILD = typeof __SENTRY_DEBUG__ === "undefined" || __SENTRY_DEBUG__;
    exports.DEBUG_BUILD = DEBUG_BUILD;
  }
});

// ../../node_modules/.pnpm/@sentry+utils@7.120.1/node_modules/@sentry/utils/cjs/logger.js
var require_logger = __commonJS({
  "../../node_modules/.pnpm/@sentry+utils@7.120.1/node_modules/@sentry/utils/cjs/logger.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var debugBuild = require_debug_build();
    var worldwide = require_worldwide();
    var PREFIX = "Sentry Logger ";
    var CONSOLE_LEVELS = [
      "debug",
      "info",
      "warn",
      "error",
      "log",
      "assert",
      "trace"
    ];
    var originalConsoleMethods = {};
    function consoleSandbox(callback) {
      if (!("console" in worldwide.GLOBAL_OBJ)) {
        return callback();
      }
      const console2 = worldwide.GLOBAL_OBJ.console;
      const wrappedFuncs = {};
      const wrappedLevels = Object.keys(originalConsoleMethods);
      wrappedLevels.forEach((level) => {
        const originalConsoleMethod = originalConsoleMethods[level];
        wrappedFuncs[level] = console2[level];
        console2[level] = originalConsoleMethod;
      });
      try {
        return callback();
      } finally {
        wrappedLevels.forEach((level) => {
          console2[level] = wrappedFuncs[level];
        });
      }
    }
    function makeLogger() {
      let enabled = false;
      const logger2 = {
        enable: () => {
          enabled = true;
        },
        disable: () => {
          enabled = false;
        },
        isEnabled: () => enabled
      };
      if (debugBuild.DEBUG_BUILD) {
        CONSOLE_LEVELS.forEach((name) => {
          logger2[name] = (...args) => {
            if (enabled) {
              consoleSandbox(() => {
                worldwide.GLOBAL_OBJ.console[name](`${PREFIX}[${name}]:`, ...args);
              });
            }
          };
        });
      } else {
        CONSOLE_LEVELS.forEach((name) => {
          logger2[name] = () => void 0;
        });
      }
      return logger2;
    }
    var logger = makeLogger();
    exports.CONSOLE_LEVELS = CONSOLE_LEVELS;
    exports.consoleSandbox = consoleSandbox;
    exports.logger = logger;
    exports.originalConsoleMethods = originalConsoleMethods;
  }
});

// ../../node_modules/.pnpm/@sentry+utils@7.120.1/node_modules/@sentry/utils/cjs/dsn.js
var require_dsn = __commonJS({
  "../../node_modules/.pnpm/@sentry+utils@7.120.1/node_modules/@sentry/utils/cjs/dsn.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var debugBuild = require_debug_build();
    var logger = require_logger();
    var DSN_REGEX = /^(?:(\w+):)\/\/(?:(\w+)(?::(\w+)?)?@)([\w.-]+)(?::(\d+))?\/(.+)/;
    function isValidProtocol(protocol) {
      return protocol === "http" || protocol === "https";
    }
    function dsnToString(dsn, withPassword = false) {
      const { host, path, pass, port, projectId, protocol, publicKey } = dsn;
      return `${protocol}://${publicKey}${withPassword && pass ? `:${pass}` : ""}@${host}${port ? `:${port}` : ""}/${path ? `${path}/` : path}${projectId}`;
    }
    function dsnFromString(str) {
      const match = DSN_REGEX.exec(str);
      if (!match) {
        logger.consoleSandbox(() => {
          console.error(`Invalid Sentry Dsn: ${str}`);
        });
        return void 0;
      }
      const [protocol, publicKey, pass = "", host, port = "", lastPath] = match.slice(1);
      let path = "";
      let projectId = lastPath;
      const split = projectId.split("/");
      if (split.length > 1) {
        path = split.slice(0, -1).join("/");
        projectId = split.pop();
      }
      if (projectId) {
        const projectMatch = projectId.match(/^\d+/);
        if (projectMatch) {
          projectId = projectMatch[0];
        }
      }
      return dsnFromComponents({ host, pass, path, projectId, port, protocol, publicKey });
    }
    function dsnFromComponents(components) {
      return {
        protocol: components.protocol,
        publicKey: components.publicKey || "",
        pass: components.pass || "",
        host: components.host,
        port: components.port || "",
        path: components.path || "",
        projectId: components.projectId
      };
    }
    function validateDsn(dsn) {
      if (!debugBuild.DEBUG_BUILD) {
        return true;
      }
      const { port, projectId, protocol } = dsn;
      const requiredComponents = ["protocol", "publicKey", "host", "projectId"];
      const hasMissingRequiredComponent = requiredComponents.find((component) => {
        if (!dsn[component]) {
          logger.logger.error(`Invalid Sentry Dsn: ${component} missing`);
          return true;
        }
        return false;
      });
      if (hasMissingRequiredComponent) {
        return false;
      }
      if (!projectId.match(/^\d+$/)) {
        logger.logger.error(`Invalid Sentry Dsn: Invalid projectId ${projectId}`);
        return false;
      }
      if (!isValidProtocol(protocol)) {
        logger.logger.error(`Invalid Sentry Dsn: Invalid protocol ${protocol}`);
        return false;
      }
      if (port && isNaN(parseInt(port, 10))) {
        logger.logger.error(`Invalid Sentry Dsn: Invalid port ${port}`);
        return false;
      }
      return true;
    }
    function makeDsn(from) {
      const components = typeof from === "string" ? dsnFromString(from) : dsnFromComponents(from);
      if (!components || !validateDsn(components)) {
        return void 0;
      }
      return components;
    }
    exports.dsnFromString = dsnFromString;
    exports.dsnToString = dsnToString;
    exports.makeDsn = makeDsn;
  }
});

// ../../node_modules/.pnpm/@sentry+utils@7.120.1/node_modules/@sentry/utils/cjs/error.js
var require_error = __commonJS({
  "../../node_modules/.pnpm/@sentry+utils@7.120.1/node_modules/@sentry/utils/cjs/error.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var SentryError = class extends Error {
      /** Display name of this error instance. */
      constructor(message, logLevel = "warn") {
        super(message);
        this.message = message;
        this.name = new.target.prototype.constructor.name;
        Object.setPrototypeOf(this, new.target.prototype);
        this.logLevel = logLevel;
      }
    };
    exports.SentryError = SentryError;
  }
});

// ../../node_modules/.pnpm/@sentry+utils@7.120.1/node_modules/@sentry/utils/cjs/object.js
var require_object = __commonJS({
  "../../node_modules/.pnpm/@sentry+utils@7.120.1/node_modules/@sentry/utils/cjs/object.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var browser = require_browser();
    var debugBuild = require_debug_build();
    var is = require_is();
    var logger = require_logger();
    var string = require_string();
    function fill(source, name, replacementFactory) {
      if (!(name in source)) {
        return;
      }
      const original = source[name];
      const wrapped = replacementFactory(original);
      if (typeof wrapped === "function") {
        markFunctionWrapped(wrapped, original);
      }
      source[name] = wrapped;
    }
    function addNonEnumerableProperty(obj, name, value) {
      try {
        Object.defineProperty(obj, name, {
          // enumerable: false, // the default, so we can save on bundle size by not explicitly setting it
          value,
          writable: true,
          configurable: true
        });
      } catch (o_O) {
        debugBuild.DEBUG_BUILD && logger.logger.log(`Failed to add non-enumerable property "${name}" to object`, obj);
      }
    }
    function markFunctionWrapped(wrapped, original) {
      try {
        const proto = original.prototype || {};
        wrapped.prototype = original.prototype = proto;
        addNonEnumerableProperty(wrapped, "__sentry_original__", original);
      } catch (o_O) {
      }
    }
    function getOriginalFunction(func) {
      return func.__sentry_original__;
    }
    function urlEncode(object) {
      return Object.keys(object).map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(object[key])}`).join("&");
    }
    function convertToPlainObject(value) {
      if (is.isError(value)) {
        return {
          message: value.message,
          name: value.name,
          stack: value.stack,
          ...getOwnProperties(value)
        };
      } else if (is.isEvent(value)) {
        const newObj = {
          type: value.type,
          target: serializeEventTarget(value.target),
          currentTarget: serializeEventTarget(value.currentTarget),
          ...getOwnProperties(value)
        };
        if (typeof CustomEvent !== "undefined" && is.isInstanceOf(value, CustomEvent)) {
          newObj.detail = value.detail;
        }
        return newObj;
      } else {
        return value;
      }
    }
    function serializeEventTarget(target) {
      try {
        return is.isElement(target) ? browser.htmlTreeAsString(target) : Object.prototype.toString.call(target);
      } catch (_oO) {
        return "<unknown>";
      }
    }
    function getOwnProperties(obj) {
      if (typeof obj === "object" && obj !== null) {
        const extractedProps = {};
        for (const property in obj) {
          if (Object.prototype.hasOwnProperty.call(obj, property)) {
            extractedProps[property] = obj[property];
          }
        }
        return extractedProps;
      } else {
        return {};
      }
    }
    function extractExceptionKeysForMessage(exception, maxLength = 40) {
      const keys = Object.keys(convertToPlainObject(exception));
      keys.sort();
      if (!keys.length) {
        return "[object has no keys]";
      }
      if (keys[0].length >= maxLength) {
        return string.truncate(keys[0], maxLength);
      }
      for (let includedKeys = keys.length; includedKeys > 0; includedKeys--) {
        const serialized = keys.slice(0, includedKeys).join(", ");
        if (serialized.length > maxLength) {
          continue;
        }
        if (includedKeys === keys.length) {
          return serialized;
        }
        return string.truncate(serialized, maxLength);
      }
      return "";
    }
    function dropUndefinedKeys(inputValue) {
      const memoizationMap = /* @__PURE__ */ new Map();
      return _dropUndefinedKeys(inputValue, memoizationMap);
    }
    function _dropUndefinedKeys(inputValue, memoizationMap) {
      if (isPojo(inputValue)) {
        const memoVal = memoizationMap.get(inputValue);
        if (memoVal !== void 0) {
          return memoVal;
        }
        const returnValue = {};
        memoizationMap.set(inputValue, returnValue);
        for (const key of Object.keys(inputValue)) {
          if (typeof inputValue[key] !== "undefined") {
            returnValue[key] = _dropUndefinedKeys(inputValue[key], memoizationMap);
          }
        }
        return returnValue;
      }
      if (Array.isArray(inputValue)) {
        const memoVal = memoizationMap.get(inputValue);
        if (memoVal !== void 0) {
          return memoVal;
        }
        const returnValue = [];
        memoizationMap.set(inputValue, returnValue);
        inputValue.forEach((item) => {
          returnValue.push(_dropUndefinedKeys(item, memoizationMap));
        });
        return returnValue;
      }
      return inputValue;
    }
    function isPojo(input) {
      if (!is.isPlainObject(input)) {
        return false;
      }
      try {
        const name = Object.getPrototypeOf(input).constructor.name;
        return !name || name === "Object";
      } catch (e) {
        return true;
      }
    }
    function objectify(wat) {
      let objectified;
      switch (true) {
        case (wat === void 0 || wat === null):
          objectified = new String(wat);
          break;
        case (typeof wat === "symbol" || typeof wat === "bigint"):
          objectified = Object(wat);
          break;
        case is.isPrimitive(wat):
          objectified = new wat.constructor(wat);
          break;
        default:
          objectified = wat;
          break;
      }
      return objectified;
    }
    exports.addNonEnumerableProperty = addNonEnumerableProperty;
    exports.convertToPlainObject = convertToPlainObject;
    exports.dropUndefinedKeys = dropUndefinedKeys;
    exports.extractExceptionKeysForMessage = extractExceptionKeysForMessage;
    exports.fill = fill;
    exports.getOriginalFunction = getOriginalFunction;
    exports.markFunctionWrapped = markFunctionWrapped;
    exports.objectify = objectify;
    exports.urlEncode = urlEncode;
  }
});

// ../../node_modules/.pnpm/@sentry+utils@7.120.1/node_modules/@sentry/utils/cjs/node-stack-trace.js
var require_node_stack_trace = __commonJS({
  "../../node_modules/.pnpm/@sentry+utils@7.120.1/node_modules/@sentry/utils/cjs/node-stack-trace.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    function filenameIsInApp(filename, isNative = false) {
      const isInternal = isNative || filename && // It's not internal if it's an absolute linux path
      !filename.startsWith("/") && // It's not internal if it's an absolute windows path
      !filename.match(/^[A-Z]:/) && // It's not internal if the path is starting with a dot
      !filename.startsWith(".") && // It's not internal if the frame has a protocol. In node, this is usually the case if the file got pre-processed with a bundler like webpack
      !filename.match(/^[a-zA-Z]([a-zA-Z0-9.\-+])*:\/\//);
      return !isInternal && filename !== void 0 && !filename.includes("node_modules/");
    }
    function node(getModule) {
      const FILENAME_MATCH = /^\s*[-]{4,}$/;
      const FULL_MATCH = /at (?:async )?(?:(.+?)\s+\()?(?:(.+):(\d+):(\d+)?|([^)]+))\)?/;
      return (line) => {
        const lineMatch = line.match(FULL_MATCH);
        if (lineMatch) {
          let object;
          let method;
          let functionName;
          let typeName;
          let methodName;
          if (lineMatch[1]) {
            functionName = lineMatch[1];
            let methodStart = functionName.lastIndexOf(".");
            if (functionName[methodStart - 1] === ".") {
              methodStart--;
            }
            if (methodStart > 0) {
              object = functionName.slice(0, methodStart);
              method = functionName.slice(methodStart + 1);
              const objectEnd = object.indexOf(".Module");
              if (objectEnd > 0) {
                functionName = functionName.slice(objectEnd + 1);
                object = object.slice(0, objectEnd);
              }
            }
            typeName = void 0;
          }
          if (method) {
            typeName = object;
            methodName = method;
          }
          if (method === "<anonymous>") {
            methodName = void 0;
            functionName = void 0;
          }
          if (functionName === void 0) {
            methodName = methodName || "<anonymous>";
            functionName = typeName ? `${typeName}.${methodName}` : methodName;
          }
          let filename = lineMatch[2] && lineMatch[2].startsWith("file://") ? lineMatch[2].slice(7) : lineMatch[2];
          const isNative = lineMatch[5] === "native";
          if (filename && filename.match(/\/[A-Z]:/)) {
            filename = filename.slice(1);
          }
          if (!filename && lineMatch[5] && !isNative) {
            filename = lineMatch[5];
          }
          return {
            filename,
            module: getModule ? getModule(filename) : void 0,
            function: functionName,
            lineno: parseInt(lineMatch[3], 10) || void 0,
            colno: parseInt(lineMatch[4], 10) || void 0,
            in_app: filenameIsInApp(filename, isNative)
          };
        }
        if (line.match(FILENAME_MATCH)) {
          return {
            filename: line
          };
        }
        return void 0;
      };
    }
    exports.filenameIsInApp = filenameIsInApp;
    exports.node = node;
  }
});

// ../../node_modules/.pnpm/@sentry+utils@7.120.1/node_modules/@sentry/utils/cjs/stacktrace.js
var require_stacktrace = __commonJS({
  "../../node_modules/.pnpm/@sentry+utils@7.120.1/node_modules/@sentry/utils/cjs/stacktrace.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var nodeStackTrace = require_node_stack_trace();
    var STACKTRACE_FRAME_LIMIT = 50;
    var WEBPACK_ERROR_REGEXP = /\(error: (.*)\)/;
    var STRIP_FRAME_REGEXP = /captureMessage|captureException/;
    function createStackParser(...parsers) {
      const sortedParsers = parsers.sort((a, b) => a[0] - b[0]).map((p) => p[1]);
      return (stack, skipFirst = 0) => {
        const frames = [];
        const lines = stack.split("\n");
        for (let i = skipFirst; i < lines.length; i++) {
          const line = lines[i];
          if (line.length > 1024) {
            continue;
          }
          const cleanedLine = WEBPACK_ERROR_REGEXP.test(line) ? line.replace(WEBPACK_ERROR_REGEXP, "$1") : line;
          if (cleanedLine.match(/\S*Error: /)) {
            continue;
          }
          for (const parser of sortedParsers) {
            const frame = parser(cleanedLine);
            if (frame) {
              frames.push(frame);
              break;
            }
          }
          if (frames.length >= STACKTRACE_FRAME_LIMIT) {
            break;
          }
        }
        return stripSentryFramesAndReverse(frames);
      };
    }
    function stackParserFromStackParserOptions(stackParser) {
      if (Array.isArray(stackParser)) {
        return createStackParser(...stackParser);
      }
      return stackParser;
    }
    function stripSentryFramesAndReverse(stack) {
      if (!stack.length) {
        return [];
      }
      const localStack = Array.from(stack);
      if (/sentryWrapped/.test(localStack[localStack.length - 1].function || "")) {
        localStack.pop();
      }
      localStack.reverse();
      if (STRIP_FRAME_REGEXP.test(localStack[localStack.length - 1].function || "")) {
        localStack.pop();
        if (STRIP_FRAME_REGEXP.test(localStack[localStack.length - 1].function || "")) {
          localStack.pop();
        }
      }
      return localStack.slice(0, STACKTRACE_FRAME_LIMIT).map((frame) => ({
        ...frame,
        filename: frame.filename || localStack[localStack.length - 1].filename,
        function: frame.function || "?"
      }));
    }
    var defaultFunctionName = "<anonymous>";
    function getFunctionName(fn) {
      try {
        if (!fn || typeof fn !== "function") {
          return defaultFunctionName;
        }
        return fn.name || defaultFunctionName;
      } catch (e) {
        return defaultFunctionName;
      }
    }
    function nodeStackLineParser(getModule) {
      return [90, nodeStackTrace.node(getModule)];
    }
    exports.filenameIsInApp = nodeStackTrace.filenameIsInApp;
    exports.createStackParser = createStackParser;
    exports.getFunctionName = getFunctionName;
    exports.nodeStackLineParser = nodeStackLineParser;
    exports.stackParserFromStackParserOptions = stackParserFromStackParserOptions;
    exports.stripSentryFramesAndReverse = stripSentryFramesAndReverse;
  }
});

// ../../node_modules/.pnpm/@sentry+utils@7.120.1/node_modules/@sentry/utils/cjs/instrument/_handlers.js
var require_handlers = __commonJS({
  "../../node_modules/.pnpm/@sentry+utils@7.120.1/node_modules/@sentry/utils/cjs/instrument/_handlers.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var debugBuild = require_debug_build();
    var logger = require_logger();
    var stacktrace = require_stacktrace();
    var handlers = {};
    var instrumented = {};
    function addHandler(type, handler) {
      handlers[type] = handlers[type] || [];
      handlers[type].push(handler);
    }
    function resetInstrumentationHandlers() {
      Object.keys(handlers).forEach((key) => {
        handlers[key] = void 0;
      });
    }
    function maybeInstrument(type, instrumentFn) {
      if (!instrumented[type]) {
        instrumentFn();
        instrumented[type] = true;
      }
    }
    function triggerHandlers(type, data) {
      const typeHandlers = type && handlers[type];
      if (!typeHandlers) {
        return;
      }
      for (const handler of typeHandlers) {
        try {
          handler(data);
        } catch (e) {
          debugBuild.DEBUG_BUILD && logger.logger.error(
            `Error while triggering instrumentation handler.
Type: ${type}
Name: ${stacktrace.getFunctionName(handler)}
Error:`,
            e
          );
        }
      }
    }
    exports.addHandler = addHandler;
    exports.maybeInstrument = maybeInstrument;
    exports.resetInstrumentationHandlers = resetInstrumentationHandlers;
    exports.triggerHandlers = triggerHandlers;
  }
});

// ../../node_modules/.pnpm/@sentry+utils@7.120.1/node_modules/@sentry/utils/cjs/instrument/console.js
var require_console = __commonJS({
  "../../node_modules/.pnpm/@sentry+utils@7.120.1/node_modules/@sentry/utils/cjs/instrument/console.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var logger = require_logger();
    var object = require_object();
    var worldwide = require_worldwide();
    var _handlers = require_handlers();
    function addConsoleInstrumentationHandler(handler) {
      const type = "console";
      _handlers.addHandler(type, handler);
      _handlers.maybeInstrument(type, instrumentConsole);
    }
    function instrumentConsole() {
      if (!("console" in worldwide.GLOBAL_OBJ)) {
        return;
      }
      logger.CONSOLE_LEVELS.forEach(function(level) {
        if (!(level in worldwide.GLOBAL_OBJ.console)) {
          return;
        }
        object.fill(worldwide.GLOBAL_OBJ.console, level, function(originalConsoleMethod) {
          logger.originalConsoleMethods[level] = originalConsoleMethod;
          return function(...args) {
            const handlerData = { args, level };
            _handlers.triggerHandlers("console", handlerData);
            const log = logger.originalConsoleMethods[level];
            log && log.apply(worldwide.GLOBAL_OBJ.console, args);
          };
        });
      });
    }
    exports.addConsoleInstrumentationHandler = addConsoleInstrumentationHandler;
  }
});

// ../../node_modules/.pnpm/@sentry+utils@7.120.1/node_modules/@sentry/utils/cjs/misc.js
var require_misc = __commonJS({
  "../../node_modules/.pnpm/@sentry+utils@7.120.1/node_modules/@sentry/utils/cjs/misc.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var object = require_object();
    var string = require_string();
    var worldwide = require_worldwide();
    function uuid4() {
      const gbl = worldwide.GLOBAL_OBJ;
      const crypto = gbl.crypto || gbl.msCrypto;
      let getRandomByte = () => Math.random() * 16;
      try {
        if (crypto && crypto.randomUUID) {
          return crypto.randomUUID().replace(/-/g, "");
        }
        if (crypto && crypto.getRandomValues) {
          getRandomByte = () => {
            const typedArray = new Uint8Array(1);
            crypto.getRandomValues(typedArray);
            return typedArray[0];
          };
        }
      } catch (_) {
      }
      return ([1e7] + 1e3 + 4e3 + 8e3 + 1e11).replace(
        /[018]/g,
        (c) => (
          // eslint-disable-next-line no-bitwise
          (c ^ (getRandomByte() & 15) >> c / 4).toString(16)
        )
      );
    }
    function getFirstException(event) {
      return event.exception && event.exception.values ? event.exception.values[0] : void 0;
    }
    function getEventDescription(event) {
      const { message, event_id: eventId } = event;
      if (message) {
        return message;
      }
      const firstException = getFirstException(event);
      if (firstException) {
        if (firstException.type && firstException.value) {
          return `${firstException.type}: ${firstException.value}`;
        }
        return firstException.type || firstException.value || eventId || "<unknown>";
      }
      return eventId || "<unknown>";
    }
    function addExceptionTypeValue(event, value, type) {
      const exception = event.exception = event.exception || {};
      const values = exception.values = exception.values || [];
      const firstException = values[0] = values[0] || {};
      if (!firstException.value) {
        firstException.value = value || "";
      }
      if (!firstException.type) {
        firstException.type = type || "Error";
      }
    }
    function addExceptionMechanism(event, newMechanism) {
      const firstException = getFirstException(event);
      if (!firstException) {
        return;
      }
      const defaultMechanism = { type: "generic", handled: true };
      const currentMechanism = firstException.mechanism;
      firstException.mechanism = { ...defaultMechanism, ...currentMechanism, ...newMechanism };
      if (newMechanism && "data" in newMechanism) {
        const mergedData = { ...currentMechanism && currentMechanism.data, ...newMechanism.data };
        firstException.mechanism.data = mergedData;
      }
    }
    var SEMVER_REGEXP = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;
    function parseSemver(input) {
      const match = input.match(SEMVER_REGEXP) || [];
      const major = parseInt(match[1], 10);
      const minor = parseInt(match[2], 10);
      const patch = parseInt(match[3], 10);
      return {
        buildmetadata: match[5],
        major: isNaN(major) ? void 0 : major,
        minor: isNaN(minor) ? void 0 : minor,
        patch: isNaN(patch) ? void 0 : patch,
        prerelease: match[4]
      };
    }
    function addContextToFrame(lines, frame, linesOfContext = 5) {
      if (frame.lineno === void 0) {
        return;
      }
      const maxLines = lines.length;
      const sourceLine = Math.max(Math.min(maxLines - 1, frame.lineno - 1), 0);
      frame.pre_context = lines.slice(Math.max(0, sourceLine - linesOfContext), sourceLine).map((line) => string.snipLine(line, 0));
      frame.context_line = string.snipLine(lines[Math.min(maxLines - 1, sourceLine)], frame.colno || 0);
      frame.post_context = lines.slice(Math.min(sourceLine + 1, maxLines), sourceLine + 1 + linesOfContext).map((line) => string.snipLine(line, 0));
    }
    function checkOrSetAlreadyCaught(exception) {
      if (exception && exception.__sentry_captured__) {
        return true;
      }
      try {
        object.addNonEnumerableProperty(exception, "__sentry_captured__", true);
      } catch (err) {
      }
      return false;
    }
    function arrayify(maybeArray) {
      return Array.isArray(maybeArray) ? maybeArray : [maybeArray];
    }
    exports.addContextToFrame = addContextToFrame;
    exports.addExceptionMechanism = addExceptionMechanism;
    exports.addExceptionTypeValue = addExceptionTypeValue;
    exports.arrayify = arrayify;
    exports.checkOrSetAlreadyCaught = checkOrSetAlreadyCaught;
    exports.getEventDescription = getEventDescription;
    exports.parseSemver = parseSemver;
    exports.uuid4 = uuid4;
  }
});

// ../../node_modules/.pnpm/@sentry+utils@7.120.1/node_modules/@sentry/utils/cjs/instrument/dom.js
var require_dom = __commonJS({
  "../../node_modules/.pnpm/@sentry+utils@7.120.1/node_modules/@sentry/utils/cjs/instrument/dom.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var misc = require_misc();
    var object = require_object();
    var worldwide = require_worldwide();
    var _handlers = require_handlers();
    var WINDOW = worldwide.GLOBAL_OBJ;
    var DEBOUNCE_DURATION = 1e3;
    var debounceTimerID;
    var lastCapturedEventType;
    var lastCapturedEventTargetId;
    function addClickKeypressInstrumentationHandler(handler) {
      const type = "dom";
      _handlers.addHandler(type, handler);
      _handlers.maybeInstrument(type, instrumentDOM);
    }
    function instrumentDOM() {
      if (!WINDOW.document) {
        return;
      }
      const triggerDOMHandler = _handlers.triggerHandlers.bind(null, "dom");
      const globalDOMEventHandler = makeDOMEventHandler(triggerDOMHandler, true);
      WINDOW.document.addEventListener("click", globalDOMEventHandler, false);
      WINDOW.document.addEventListener("keypress", globalDOMEventHandler, false);
      ["EventTarget", "Node"].forEach((target) => {
        const proto = WINDOW[target] && WINDOW[target].prototype;
        if (!proto || !proto.hasOwnProperty || !proto.hasOwnProperty("addEventListener")) {
          return;
        }
        object.fill(proto, "addEventListener", function(originalAddEventListener) {
          return function(type, listener, options) {
            if (type === "click" || type == "keypress") {
              try {
                const el = this;
                const handlers = el.__sentry_instrumentation_handlers__ = el.__sentry_instrumentation_handlers__ || {};
                const handlerForType = handlers[type] = handlers[type] || { refCount: 0 };
                if (!handlerForType.handler) {
                  const handler = makeDOMEventHandler(triggerDOMHandler);
                  handlerForType.handler = handler;
                  originalAddEventListener.call(this, type, handler, options);
                }
                handlerForType.refCount++;
              } catch (e) {
              }
            }
            return originalAddEventListener.call(this, type, listener, options);
          };
        });
        object.fill(
          proto,
          "removeEventListener",
          function(originalRemoveEventListener) {
            return function(type, listener, options) {
              if (type === "click" || type == "keypress") {
                try {
                  const el = this;
                  const handlers = el.__sentry_instrumentation_handlers__ || {};
                  const handlerForType = handlers[type];
                  if (handlerForType) {
                    handlerForType.refCount--;
                    if (handlerForType.refCount <= 0) {
                      originalRemoveEventListener.call(this, type, handlerForType.handler, options);
                      handlerForType.handler = void 0;
                      delete handlers[type];
                    }
                    if (Object.keys(handlers).length === 0) {
                      delete el.__sentry_instrumentation_handlers__;
                    }
                  }
                } catch (e) {
                }
              }
              return originalRemoveEventListener.call(this, type, listener, options);
            };
          }
        );
      });
    }
    function isSimilarToLastCapturedEvent(event) {
      if (event.type !== lastCapturedEventType) {
        return false;
      }
      try {
        if (!event.target || event.target._sentryId !== lastCapturedEventTargetId) {
          return false;
        }
      } catch (e) {
      }
      return true;
    }
    function shouldSkipDOMEvent(eventType, target) {
      if (eventType !== "keypress") {
        return false;
      }
      if (!target || !target.tagName) {
        return true;
      }
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) {
        return false;
      }
      return true;
    }
    function makeDOMEventHandler(handler, globalListener = false) {
      return (event) => {
        if (!event || event["_sentryCaptured"]) {
          return;
        }
        const target = getEventTarget(event);
        if (shouldSkipDOMEvent(event.type, target)) {
          return;
        }
        object.addNonEnumerableProperty(event, "_sentryCaptured", true);
        if (target && !target._sentryId) {
          object.addNonEnumerableProperty(target, "_sentryId", misc.uuid4());
        }
        const name = event.type === "keypress" ? "input" : event.type;
        if (!isSimilarToLastCapturedEvent(event)) {
          const handlerData = { event, name, global: globalListener };
          handler(handlerData);
          lastCapturedEventType = event.type;
          lastCapturedEventTargetId = target ? target._sentryId : void 0;
        }
        clearTimeout(debounceTimerID);
        debounceTimerID = WINDOW.setTimeout(() => {
          lastCapturedEventTargetId = void 0;
          lastCapturedEventType = void 0;
        }, DEBOUNCE_DURATION);
      };
    }
    function getEventTarget(event) {
      try {
        return event.target;
      } catch (e) {
        return null;
      }
    }
    exports.addClickKeypressInstrumentationHandler = addClickKeypressInstrumentationHandler;
    exports.instrumentDOM = instrumentDOM;
  }
});

// ../../node_modules/.pnpm/@sentry+utils@7.120.1/node_modules/@sentry/utils/cjs/supports.js
var require_supports = __commonJS({
  "../../node_modules/.pnpm/@sentry+utils@7.120.1/node_modules/@sentry/utils/cjs/supports.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var debugBuild = require_debug_build();
    var logger = require_logger();
    var worldwide = require_worldwide();
    var WINDOW = worldwide.getGlobalObject();
    function supportsErrorEvent() {
      try {
        new ErrorEvent("");
        return true;
      } catch (e) {
        return false;
      }
    }
    function supportsDOMError() {
      try {
        new DOMError("");
        return true;
      } catch (e) {
        return false;
      }
    }
    function supportsDOMException() {
      try {
        new DOMException("");
        return true;
      } catch (e) {
        return false;
      }
    }
    function supportsFetch() {
      if (!("fetch" in WINDOW)) {
        return false;
      }
      try {
        new Headers();
        new Request("http://www.example.com");
        new Response();
        return true;
      } catch (e) {
        return false;
      }
    }
    function isNativeFetch(func) {
      return func && /^function fetch\(\)\s+\{\s+\[native code\]\s+\}$/.test(func.toString());
    }
    function supportsNativeFetch() {
      if (typeof EdgeRuntime === "string") {
        return true;
      }
      if (!supportsFetch()) {
        return false;
      }
      if (isNativeFetch(WINDOW.fetch)) {
        return true;
      }
      let result = false;
      const doc = WINDOW.document;
      if (doc && typeof doc.createElement === "function") {
        try {
          const sandbox = doc.createElement("iframe");
          sandbox.hidden = true;
          doc.head.appendChild(sandbox);
          if (sandbox.contentWindow && sandbox.contentWindow.fetch) {
            result = isNativeFetch(sandbox.contentWindow.fetch);
          }
          doc.head.removeChild(sandbox);
        } catch (err) {
          debugBuild.DEBUG_BUILD && logger.logger.warn("Could not create sandbox iframe for pure fetch check, bailing to window.fetch: ", err);
        }
      }
      return result;
    }
    function supportsReportingObserver() {
      return "ReportingObserver" in WINDOW;
    }
    function supportsReferrerPolicy() {
      if (!supportsFetch()) {
        return false;
      }
      try {
        new Request("_", {
          referrerPolicy: "origin"
        });
        return true;
      } catch (e) {
        return false;
      }
    }
    exports.isNativeFetch = isNativeFetch;
    exports.supportsDOMError = supportsDOMError;
    exports.supportsDOMException = supportsDOMException;
    exports.supportsErrorEvent = supportsErrorEvent;
    exports.supportsFetch = supportsFetch;
    exports.supportsNativeFetch = supportsNativeFetch;
    exports.supportsReferrerPolicy = supportsReferrerPolicy;
    exports.supportsReportingObserver = supportsReportingObserver;
  }
});

// ../../node_modules/.pnpm/@sentry+utils@7.120.1/node_modules/@sentry/utils/cjs/instrument/fetch.js
var require_fetch = __commonJS({
  "../../node_modules/.pnpm/@sentry+utils@7.120.1/node_modules/@sentry/utils/cjs/instrument/fetch.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var object = require_object();
    var supports = require_supports();
    var worldwide = require_worldwide();
    var _handlers = require_handlers();
    function addFetchInstrumentationHandler(handler) {
      const type = "fetch";
      _handlers.addHandler(type, handler);
      _handlers.maybeInstrument(type, instrumentFetch);
    }
    function instrumentFetch() {
      if (!supports.supportsNativeFetch()) {
        return;
      }
      object.fill(worldwide.GLOBAL_OBJ, "fetch", function(originalFetch) {
        return function(...args) {
          const { method, url } = parseFetchArgs(args);
          const handlerData = {
            args,
            fetchData: {
              method,
              url
            },
            startTimestamp: Date.now()
          };
          _handlers.triggerHandlers("fetch", {
            ...handlerData
          });
          return originalFetch.apply(worldwide.GLOBAL_OBJ, args).then(
            (response) => {
              const finishedHandlerData = {
                ...handlerData,
                endTimestamp: Date.now(),
                response
              };
              _handlers.triggerHandlers("fetch", finishedHandlerData);
              return response;
            },
            (error) => {
              const erroredHandlerData = {
                ...handlerData,
                endTimestamp: Date.now(),
                error
              };
              _handlers.triggerHandlers("fetch", erroredHandlerData);
              throw error;
            }
          );
        };
      });
    }
    function hasProp(obj, prop) {
      return !!obj && typeof obj === "object" && !!obj[prop];
    }
    function getUrlFromResource(resource) {
      if (typeof resource === "string") {
        return resource;
      }
      if (!resource) {
        return "";
      }
      if (hasProp(resource, "url")) {
        return resource.url;
      }
      if (resource.toString) {
        return resource.toString();
      }
      return "";
    }
    function parseFetchArgs(fetchArgs) {
      if (fetchArgs.length === 0) {
        return { method: "GET", url: "" };
      }
      if (fetchArgs.length === 2) {
        const [url, options] = fetchArgs;
        return {
          url: getUrlFromResource(url),
          method: hasProp(options, "method") ? String(options.method).toUpperCase() : "GET"
        };
      }
      const arg = fetchArgs[0];
      return {
        url: getUrlFromResource(arg),
        method: hasProp(arg, "method") ? String(arg.method).toUpperCase() : "GET"
      };
    }
    exports.addFetchInstrumentationHandler = addFetchInstrumentationHandler;
    exports.parseFetchArgs = parseFetchArgs;
  }
});

// ../../node_modules/.pnpm/@sentry+utils@7.120.1/node_modules/@sentry/utils/cjs/instrument/globalError.js
var require_globalError = __commonJS({
  "../../node_modules/.pnpm/@sentry+utils@7.120.1/node_modules/@sentry/utils/cjs/instrument/globalError.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var worldwide = require_worldwide();
    var _handlers = require_handlers();
    var _oldOnErrorHandler = null;
    function addGlobalErrorInstrumentationHandler(handler) {
      const type = "error";
      _handlers.addHandler(type, handler);
      _handlers.maybeInstrument(type, instrumentError);
    }
    function instrumentError() {
      _oldOnErrorHandler = worldwide.GLOBAL_OBJ.onerror;
      worldwide.GLOBAL_OBJ.onerror = function(msg, url, line, column, error) {
        const handlerData = {
          column,
          error,
          line,
          msg,
          url
        };
        _handlers.triggerHandlers("error", handlerData);
        if (_oldOnErrorHandler && !_oldOnErrorHandler.__SENTRY_LOADER__) {
          return _oldOnErrorHandler.apply(this, arguments);
        }
        return false;
      };
      worldwide.GLOBAL_OBJ.onerror.__SENTRY_INSTRUMENTED__ = true;
    }
    exports.addGlobalErrorInstrumentationHandler = addGlobalErrorInstrumentationHandler;
  }
});

// ../../node_modules/.pnpm/@sentry+utils@7.120.1/node_modules/@sentry/utils/cjs/instrument/globalUnhandledRejection.js
var require_globalUnhandledRejection = __commonJS({
  "../../node_modules/.pnpm/@sentry+utils@7.120.1/node_modules/@sentry/utils/cjs/instrument/globalUnhandledRejection.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var worldwide = require_worldwide();
    var _handlers = require_handlers();
    var _oldOnUnhandledRejectionHandler = null;
    function addGlobalUnhandledRejectionInstrumentationHandler(handler) {
      const type = "unhandledrejection";
      _handlers.addHandler(type, handler);
      _handlers.maybeInstrument(type, instrumentUnhandledRejection);
    }
    function instrumentUnhandledRejection() {
      _oldOnUnhandledRejectionHandler = worldwide.GLOBAL_OBJ.onunhandledrejection;
      worldwide.GLOBAL_OBJ.onunhandledrejection = function(e) {
        const handlerData = e;
        _handlers.triggerHandlers("unhandledrejection", handlerData);
        if (_oldOnUnhandledRejectionHandler && !_oldOnUnhandledRejectionHandler.__SENTRY_LOADER__) {
          return _oldOnUnhandledRejectionHandler.apply(this, arguments);
        }
        return true;
      };
      worldwide.GLOBAL_OBJ.onunhandledrejection.__SENTRY_INSTRUMENTED__ = true;
    }
    exports.addGlobalUnhandledRejectionInstrumentationHandler = addGlobalUnhandledRejectionInstrumentationHandler;
  }
});

// ../../node_modules/.pnpm/@sentry+utils@7.120.1/node_modules/@sentry/utils/cjs/vendor/supportsHistory.js
var require_supportsHistory = __commonJS({
  "../../node_modules/.pnpm/@sentry+utils@7.120.1/node_modules/@sentry/utils/cjs/vendor/supportsHistory.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var worldwide = require_worldwide();
    var WINDOW = worldwide.getGlobalObject();
    function supportsHistory() {
      const chromeVar = WINDOW.chrome;
      const isChromePackagedApp = chromeVar && chromeVar.app && chromeVar.app.runtime;
      const hasHistoryApi = "history" in WINDOW && !!WINDOW.history.pushState && !!WINDOW.history.replaceState;
      return !isChromePackagedApp && hasHistoryApi;
    }
    exports.supportsHistory = supportsHistory;
  }
});

// ../../node_modules/.pnpm/@sentry+utils@7.120.1/node_modules/@sentry/utils/cjs/instrument/history.js
var require_history = __commonJS({
  "../../node_modules/.pnpm/@sentry+utils@7.120.1/node_modules/@sentry/utils/cjs/instrument/history.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var object = require_object();
    require_debug_build();
    require_logger();
    var worldwide = require_worldwide();
    var supportsHistory = require_supportsHistory();
    var _handlers = require_handlers();
    var WINDOW = worldwide.GLOBAL_OBJ;
    var lastHref;
    function addHistoryInstrumentationHandler(handler) {
      const type = "history";
      _handlers.addHandler(type, handler);
      _handlers.maybeInstrument(type, instrumentHistory);
    }
    function instrumentHistory() {
      if (!supportsHistory.supportsHistory()) {
        return;
      }
      const oldOnPopState = WINDOW.onpopstate;
      WINDOW.onpopstate = function(...args) {
        const to = WINDOW.location.href;
        const from = lastHref;
        lastHref = to;
        const handlerData = { from, to };
        _handlers.triggerHandlers("history", handlerData);
        if (oldOnPopState) {
          try {
            return oldOnPopState.apply(this, args);
          } catch (_oO) {
          }
        }
      };
      function historyReplacementFunction(originalHistoryFunction) {
        return function(...args) {
          const url = args.length > 2 ? args[2] : void 0;
          if (url) {
            const from = lastHref;
            const to = String(url);
            lastHref = to;
            const handlerData = { from, to };
            _handlers.triggerHandlers("history", handlerData);
          }
          return originalHistoryFunction.apply(this, args);
        };
      }
      object.fill(WINDOW.history, "pushState", historyReplacementFunction);
      object.fill(WINDOW.history, "replaceState", historyReplacementFunction);
    }
    exports.addHistoryInstrumentationHandler = addHistoryInstrumentationHandler;
  }
});

// ../../node_modules/.pnpm/@sentry+utils@7.120.1/node_modules/@sentry/utils/cjs/instrument/xhr.js
var require_xhr = __commonJS({
  "../../node_modules/.pnpm/@sentry+utils@7.120.1/node_modules/@sentry/utils/cjs/instrument/xhr.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var is = require_is();
    var object = require_object();
    var worldwide = require_worldwide();
    var _handlers = require_handlers();
    var WINDOW = worldwide.GLOBAL_OBJ;
    var SENTRY_XHR_DATA_KEY = "__sentry_xhr_v3__";
    function addXhrInstrumentationHandler(handler) {
      const type = "xhr";
      _handlers.addHandler(type, handler);
      _handlers.maybeInstrument(type, instrumentXHR);
    }
    function instrumentXHR() {
      if (!WINDOW.XMLHttpRequest) {
        return;
      }
      const xhrproto = XMLHttpRequest.prototype;
      object.fill(xhrproto, "open", function(originalOpen) {
        return function(...args) {
          const startTimestamp = Date.now();
          const method = is.isString(args[0]) ? args[0].toUpperCase() : void 0;
          const url = parseUrl(args[1]);
          if (!method || !url) {
            return originalOpen.apply(this, args);
          }
          this[SENTRY_XHR_DATA_KEY] = {
            method,
            url,
            request_headers: {}
          };
          if (method === "POST" && url.match(/sentry_key/)) {
            this.__sentry_own_request__ = true;
          }
          const onreadystatechangeHandler = () => {
            const xhrInfo = this[SENTRY_XHR_DATA_KEY];
            if (!xhrInfo) {
              return;
            }
            if (this.readyState === 4) {
              try {
                xhrInfo.status_code = this.status;
              } catch (e) {
              }
              const handlerData = {
                args: [method, url],
                endTimestamp: Date.now(),
                startTimestamp,
                xhr: this
              };
              _handlers.triggerHandlers("xhr", handlerData);
            }
          };
          if ("onreadystatechange" in this && typeof this.onreadystatechange === "function") {
            object.fill(this, "onreadystatechange", function(original) {
              return function(...readyStateArgs) {
                onreadystatechangeHandler();
                return original.apply(this, readyStateArgs);
              };
            });
          } else {
            this.addEventListener("readystatechange", onreadystatechangeHandler);
          }
          object.fill(this, "setRequestHeader", function(original) {
            return function(...setRequestHeaderArgs) {
              const [header, value] = setRequestHeaderArgs;
              const xhrInfo = this[SENTRY_XHR_DATA_KEY];
              if (xhrInfo && is.isString(header) && is.isString(value)) {
                xhrInfo.request_headers[header.toLowerCase()] = value;
              }
              return original.apply(this, setRequestHeaderArgs);
            };
          });
          return originalOpen.apply(this, args);
        };
      });
      object.fill(xhrproto, "send", function(originalSend) {
        return function(...args) {
          const sentryXhrData = this[SENTRY_XHR_DATA_KEY];
          if (!sentryXhrData) {
            return originalSend.apply(this, args);
          }
          if (args[0] !== void 0) {
            sentryXhrData.body = args[0];
          }
          const handlerData = {
            args: [sentryXhrData.method, sentryXhrData.url],
            startTimestamp: Date.now(),
            xhr: this
          };
          _handlers.triggerHandlers("xhr", handlerData);
          return originalSend.apply(this, args);
        };
      });
    }
    function parseUrl(url) {
      if (is.isString(url)) {
        return url;
      }
      try {
        return url.toString();
      } catch (e2) {
      }
      return void 0;
    }
    exports.SENTRY_XHR_DATA_KEY = SENTRY_XHR_DATA_KEY;
    exports.addXhrInstrumentationHandler = addXhrInstrumentationHandler;
    exports.instrumentXHR = instrumentXHR;
  }
});

// ../../node_modules/.pnpm/@sentry+utils@7.120.1/node_modules/@sentry/utils/cjs/instrument/index.js
var require_instrument = __commonJS({
  "../../node_modules/.pnpm/@sentry+utils@7.120.1/node_modules/@sentry/utils/cjs/instrument/index.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var debugBuild = require_debug_build();
    var logger = require_logger();
    var console2 = require_console();
    var dom = require_dom();
    var fetch2 = require_fetch();
    var globalError = require_globalError();
    var globalUnhandledRejection = require_globalUnhandledRejection();
    var history = require_history();
    var xhr = require_xhr();
    function addInstrumentationHandler(type, callback) {
      switch (type) {
        case "console":
          return console2.addConsoleInstrumentationHandler(callback);
        case "dom":
          return dom.addClickKeypressInstrumentationHandler(callback);
        case "xhr":
          return xhr.addXhrInstrumentationHandler(callback);
        case "fetch":
          return fetch2.addFetchInstrumentationHandler(callback);
        case "history":
          return history.addHistoryInstrumentationHandler(callback);
        case "error":
          return globalError.addGlobalErrorInstrumentationHandler(callback);
        case "unhandledrejection":
          return globalUnhandledRejection.addGlobalUnhandledRejectionInstrumentationHandler(callback);
        default:
          debugBuild.DEBUG_BUILD && logger.logger.warn("unknown instrumentation type:", type);
      }
    }
    exports.addConsoleInstrumentationHandler = console2.addConsoleInstrumentationHandler;
    exports.addClickKeypressInstrumentationHandler = dom.addClickKeypressInstrumentationHandler;
    exports.addFetchInstrumentationHandler = fetch2.addFetchInstrumentationHandler;
    exports.addGlobalErrorInstrumentationHandler = globalError.addGlobalErrorInstrumentationHandler;
    exports.addGlobalUnhandledRejectionInstrumentationHandler = globalUnhandledRejection.addGlobalUnhandledRejectionInstrumentationHandler;
    exports.addHistoryInstrumentationHandler = history.addHistoryInstrumentationHandler;
    exports.SENTRY_XHR_DATA_KEY = xhr.SENTRY_XHR_DATA_KEY;
    exports.addXhrInstrumentationHandler = xhr.addXhrInstrumentationHandler;
    exports.addInstrumentationHandler = addInstrumentationHandler;
  }
});

// ../../node_modules/.pnpm/@sentry+utils@7.120.1/node_modules/@sentry/utils/cjs/env.js
var require_env = __commonJS({
  "../../node_modules/.pnpm/@sentry+utils@7.120.1/node_modules/@sentry/utils/cjs/env.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    function isBrowserBundle() {
      return typeof __SENTRY_BROWSER_BUNDLE__ !== "undefined" && !!__SENTRY_BROWSER_BUNDLE__;
    }
    function getSDKSource() {
      return "npm";
    }
    exports.getSDKSource = getSDKSource;
    exports.isBrowserBundle = isBrowserBundle;
  }
});

// ../../node_modules/.pnpm/@sentry+utils@7.120.1/node_modules/@sentry/utils/cjs/node.js
var require_node = __commonJS({
  "../../node_modules/.pnpm/@sentry+utils@7.120.1/node_modules/@sentry/utils/cjs/node.js"(exports, module) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var env = require_env();
    function isNodeEnv() {
      return !env.isBrowserBundle() && Object.prototype.toString.call(typeof process !== "undefined" ? process : 0) === "[object process]";
    }
    function dynamicRequire(mod, request) {
      return mod.require(request);
    }
    function loadModule(moduleName) {
      let mod;
      try {
        mod = dynamicRequire(module, moduleName);
      } catch (e) {
      }
      try {
        const { cwd } = dynamicRequire(module, "process");
        mod = dynamicRequire(module, `${cwd()}/node_modules/${moduleName}`);
      } catch (e) {
      }
      return mod;
    }
    exports.dynamicRequire = dynamicRequire;
    exports.isNodeEnv = isNodeEnv;
    exports.loadModule = loadModule;
  }
});

// ../../node_modules/.pnpm/@sentry+utils@7.120.1/node_modules/@sentry/utils/cjs/isBrowser.js
var require_isBrowser = __commonJS({
  "../../node_modules/.pnpm/@sentry+utils@7.120.1/node_modules/@sentry/utils/cjs/isBrowser.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var node = require_node();
    var worldwide = require_worldwide();
    function isBrowser() {
      return typeof window !== "undefined" && (!node.isNodeEnv() || isElectronNodeRenderer());
    }
    function isElectronNodeRenderer() {
      return (
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
        worldwide.GLOBAL_OBJ.process !== void 0 && worldwide.GLOBAL_OBJ.process.type === "renderer"
      );
    }
    exports.isBrowser = isBrowser;
  }
});

// ../../node_modules/.pnpm/@sentry+utils@7.120.1/node_modules/@sentry/utils/cjs/memo.js
var require_memo = __commonJS({
  "../../node_modules/.pnpm/@sentry+utils@7.120.1/node_modules/@sentry/utils/cjs/memo.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    function memoBuilder() {
      const hasWeakSet = typeof WeakSet === "function";
      const inner = hasWeakSet ? /* @__PURE__ */ new WeakSet() : [];
      function memoize(obj) {
        if (hasWeakSet) {
          if (inner.has(obj)) {
            return true;
          }
          inner.add(obj);
          return false;
        }
        for (let i = 0; i < inner.length; i++) {
          const value = inner[i];
          if (value === obj) {
            return true;
          }
        }
        inner.push(obj);
        return false;
      }
      function unmemoize(obj) {
        if (hasWeakSet) {
          inner.delete(obj);
        } else {
          for (let i = 0; i < inner.length; i++) {
            if (inner[i] === obj) {
              inner.splice(i, 1);
              break;
            }
          }
        }
      }
      return [memoize, unmemoize];
    }
    exports.memoBuilder = memoBuilder;
  }
});

// ../../node_modules/.pnpm/@sentry+utils@7.120.1/node_modules/@sentry/utils/cjs/normalize.js
var require_normalize = __commonJS({
  "../../node_modules/.pnpm/@sentry+utils@7.120.1/node_modules/@sentry/utils/cjs/normalize.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var is = require_is();
    var memo = require_memo();
    var object = require_object();
    var stacktrace = require_stacktrace();
    function normalize(input, depth = 100, maxProperties = Infinity) {
      try {
        return visit("", input, depth, maxProperties);
      } catch (err) {
        return { ERROR: `**non-serializable** (${err})` };
      }
    }
    function normalizeToSize(object2, depth = 3, maxSize = 100 * 1024) {
      const normalized = normalize(object2, depth);
      if (jsonSize(normalized) > maxSize) {
        return normalizeToSize(object2, depth - 1, maxSize);
      }
      return normalized;
    }
    function visit(key, value, depth = Infinity, maxProperties = Infinity, memo$1 = memo.memoBuilder()) {
      const [memoize, unmemoize] = memo$1;
      if (value == null || // this matches null and undefined -> eqeq not eqeqeq
      ["number", "boolean", "string"].includes(typeof value) && !is.isNaN(value)) {
        return value;
      }
      const stringified = stringifyValue(key, value);
      if (!stringified.startsWith("[object ")) {
        return stringified;
      }
      if (value["__sentry_skip_normalization__"]) {
        return value;
      }
      const remainingDepth = typeof value["__sentry_override_normalization_depth__"] === "number" ? value["__sentry_override_normalization_depth__"] : depth;
      if (remainingDepth === 0) {
        return stringified.replace("object ", "");
      }
      if (memoize(value)) {
        return "[Circular ~]";
      }
      const valueWithToJSON = value;
      if (valueWithToJSON && typeof valueWithToJSON.toJSON === "function") {
        try {
          const jsonValue = valueWithToJSON.toJSON();
          return visit("", jsonValue, remainingDepth - 1, maxProperties, memo$1);
        } catch (err) {
        }
      }
      const normalized = Array.isArray(value) ? [] : {};
      let numAdded = 0;
      const visitable = object.convertToPlainObject(value);
      for (const visitKey in visitable) {
        if (!Object.prototype.hasOwnProperty.call(visitable, visitKey)) {
          continue;
        }
        if (numAdded >= maxProperties) {
          normalized[visitKey] = "[MaxProperties ~]";
          break;
        }
        const visitValue = visitable[visitKey];
        normalized[visitKey] = visit(visitKey, visitValue, remainingDepth - 1, maxProperties, memo$1);
        numAdded++;
      }
      unmemoize(value);
      return normalized;
    }
    function stringifyValue(key, value) {
      try {
        if (key === "domain" && value && typeof value === "object" && value._events) {
          return "[Domain]";
        }
        if (key === "domainEmitter") {
          return "[DomainEmitter]";
        }
        if (typeof global !== "undefined" && value === global) {
          return "[Global]";
        }
        if (typeof window !== "undefined" && value === window) {
          return "[Window]";
        }
        if (typeof document !== "undefined" && value === document) {
          return "[Document]";
        }
        if (is.isVueViewModel(value)) {
          return "[VueViewModel]";
        }
        if (is.isSyntheticEvent(value)) {
          return "[SyntheticEvent]";
        }
        if (typeof value === "number" && value !== value) {
          return "[NaN]";
        }
        if (typeof value === "function") {
          return `[Function: ${stacktrace.getFunctionName(value)}]`;
        }
        if (typeof value === "symbol") {
          return `[${String(value)}]`;
        }
        if (typeof value === "bigint") {
          return `[BigInt: ${String(value)}]`;
        }
        const objName = getConstructorName(value);
        if (/^HTML(\w*)Element$/.test(objName)) {
          return `[HTMLElement: ${objName}]`;
        }
        return `[object ${objName}]`;
      } catch (err) {
        return `**non-serializable** (${err})`;
      }
    }
    function getConstructorName(value) {
      const prototype = Object.getPrototypeOf(value);
      return prototype ? prototype.constructor.name : "null prototype";
    }
    function utf8Length(value) {
      return ~-encodeURI(value).split(/%..|./).length;
    }
    function jsonSize(value) {
      return utf8Length(JSON.stringify(value));
    }
    function normalizeUrlToBase(url, basePath) {
      const escapedBase = basePath.replace(/\\/g, "/").replace(/[|\\{}()[\]^$+*?.]/g, "\\$&");
      let newUrl = url;
      try {
        newUrl = decodeURI(url);
      } catch (_Oo) {
      }
      return newUrl.replace(/\\/g, "/").replace(/webpack:\/?/g, "").replace(new RegExp(`(file://)?/*${escapedBase}/*`, "ig"), "app:///");
    }
    exports.normalize = normalize;
    exports.normalizeToSize = normalizeToSize;
    exports.normalizeUrlToBase = normalizeUrlToBase;
    exports.walk = visit;
  }
});

// ../../node_modules/.pnpm/@sentry+utils@7.120.1/node_modules/@sentry/utils/cjs/path.js
var require_path = __commonJS({
  "../../node_modules/.pnpm/@sentry+utils@7.120.1/node_modules/@sentry/utils/cjs/path.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    function normalizeArray(parts, allowAboveRoot) {
      let up = 0;
      for (let i = parts.length - 1; i >= 0; i--) {
        const last = parts[i];
        if (last === ".") {
          parts.splice(i, 1);
        } else if (last === "..") {
          parts.splice(i, 1);
          up++;
        } else if (up) {
          parts.splice(i, 1);
          up--;
        }
      }
      if (allowAboveRoot) {
        for (; up--; up) {
          parts.unshift("..");
        }
      }
      return parts;
    }
    var splitPathRe = /^(\S+:\\|\/?)([\s\S]*?)((?:\.{1,2}|[^/\\]+?|)(\.[^./\\]*|))(?:[/\\]*)$/;
    function splitPath(filename) {
      const truncated = filename.length > 1024 ? `<truncated>${filename.slice(-1024)}` : filename;
      const parts = splitPathRe.exec(truncated);
      return parts ? parts.slice(1) : [];
    }
    function resolve(...args) {
      let resolvedPath = "";
      let resolvedAbsolute = false;
      for (let i = args.length - 1; i >= -1 && !resolvedAbsolute; i--) {
        const path = i >= 0 ? args[i] : "/";
        if (!path) {
          continue;
        }
        resolvedPath = `${path}/${resolvedPath}`;
        resolvedAbsolute = path.charAt(0) === "/";
      }
      resolvedPath = normalizeArray(
        resolvedPath.split("/").filter((p) => !!p),
        !resolvedAbsolute
      ).join("/");
      return (resolvedAbsolute ? "/" : "") + resolvedPath || ".";
    }
    function trim(arr) {
      let start = 0;
      for (; start < arr.length; start++) {
        if (arr[start] !== "") {
          break;
        }
      }
      let end = arr.length - 1;
      for (; end >= 0; end--) {
        if (arr[end] !== "") {
          break;
        }
      }
      if (start > end) {
        return [];
      }
      return arr.slice(start, end - start + 1);
    }
    function relative(from, to) {
      from = resolve(from).slice(1);
      to = resolve(to).slice(1);
      const fromParts = trim(from.split("/"));
      const toParts = trim(to.split("/"));
      const length = Math.min(fromParts.length, toParts.length);
      let samePartsLength = length;
      for (let i = 0; i < length; i++) {
        if (fromParts[i] !== toParts[i]) {
          samePartsLength = i;
          break;
        }
      }
      let outputParts = [];
      for (let i = samePartsLength; i < fromParts.length; i++) {
        outputParts.push("..");
      }
      outputParts = outputParts.concat(toParts.slice(samePartsLength));
      return outputParts.join("/");
    }
    function normalizePath(path) {
      const isPathAbsolute = isAbsolute(path);
      const trailingSlash = path.slice(-1) === "/";
      let normalizedPath = normalizeArray(
        path.split("/").filter((p) => !!p),
        !isPathAbsolute
      ).join("/");
      if (!normalizedPath && !isPathAbsolute) {
        normalizedPath = ".";
      }
      if (normalizedPath && trailingSlash) {
        normalizedPath += "/";
      }
      return (isPathAbsolute ? "/" : "") + normalizedPath;
    }
    function isAbsolute(path) {
      return path.charAt(0) === "/";
    }
    function join(...args) {
      return normalizePath(args.join("/"));
    }
    function dirname(path) {
      const result = splitPath(path);
      const root = result[0];
      let dir = result[1];
      if (!root && !dir) {
        return ".";
      }
      if (dir) {
        dir = dir.slice(0, dir.length - 1);
      }
      return root + dir;
    }
    function basename(path, ext) {
      let f = splitPath(path)[2];
      if (ext && f.slice(ext.length * -1) === ext) {
        f = f.slice(0, f.length - ext.length);
      }
      return f;
    }
    exports.basename = basename;
    exports.dirname = dirname;
    exports.isAbsolute = isAbsolute;
    exports.join = join;
    exports.normalizePath = normalizePath;
    exports.relative = relative;
    exports.resolve = resolve;
  }
});

// ../../node_modules/.pnpm/@sentry+utils@7.120.1/node_modules/@sentry/utils/cjs/syncpromise.js
var require_syncpromise = __commonJS({
  "../../node_modules/.pnpm/@sentry+utils@7.120.1/node_modules/@sentry/utils/cjs/syncpromise.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var is = require_is();
    var States;
    (function(States2) {
      const PENDING = 0;
      States2[States2["PENDING"] = PENDING] = "PENDING";
      const RESOLVED = 1;
      States2[States2["RESOLVED"] = RESOLVED] = "RESOLVED";
      const REJECTED = 2;
      States2[States2["REJECTED"] = REJECTED] = "REJECTED";
    })(States || (States = {}));
    function resolvedSyncPromise(value) {
      return new SyncPromise((resolve) => {
        resolve(value);
      });
    }
    function rejectedSyncPromise(reason) {
      return new SyncPromise((_, reject) => {
        reject(reason);
      });
    }
    var SyncPromise = class _SyncPromise {
      constructor(executor) {
        _SyncPromise.prototype.__init.call(this);
        _SyncPromise.prototype.__init2.call(this);
        _SyncPromise.prototype.__init3.call(this);
        _SyncPromise.prototype.__init4.call(this);
        this._state = States.PENDING;
        this._handlers = [];
        try {
          executor(this._resolve, this._reject);
        } catch (e) {
          this._reject(e);
        }
      }
      /** JSDoc */
      then(onfulfilled, onrejected) {
        return new _SyncPromise((resolve, reject) => {
          this._handlers.push([
            false,
            (result) => {
              if (!onfulfilled) {
                resolve(result);
              } else {
                try {
                  resolve(onfulfilled(result));
                } catch (e) {
                  reject(e);
                }
              }
            },
            (reason) => {
              if (!onrejected) {
                reject(reason);
              } else {
                try {
                  resolve(onrejected(reason));
                } catch (e) {
                  reject(e);
                }
              }
            }
          ]);
          this._executeHandlers();
        });
      }
      /** JSDoc */
      catch(onrejected) {
        return this.then((val) => val, onrejected);
      }
      /** JSDoc */
      finally(onfinally) {
        return new _SyncPromise((resolve, reject) => {
          let val;
          let isRejected;
          return this.then(
            (value) => {
              isRejected = false;
              val = value;
              if (onfinally) {
                onfinally();
              }
            },
            (reason) => {
              isRejected = true;
              val = reason;
              if (onfinally) {
                onfinally();
              }
            }
          ).then(() => {
            if (isRejected) {
              reject(val);
              return;
            }
            resolve(val);
          });
        });
      }
      /** JSDoc */
      __init() {
        this._resolve = (value) => {
          this._setResult(States.RESOLVED, value);
        };
      }
      /** JSDoc */
      __init2() {
        this._reject = (reason) => {
          this._setResult(States.REJECTED, reason);
        };
      }
      /** JSDoc */
      __init3() {
        this._setResult = (state, value) => {
          if (this._state !== States.PENDING) {
            return;
          }
          if (is.isThenable(value)) {
            void value.then(this._resolve, this._reject);
            return;
          }
          this._state = state;
          this._value = value;
          this._executeHandlers();
        };
      }
      /** JSDoc */
      __init4() {
        this._executeHandlers = () => {
          if (this._state === States.PENDING) {
            return;
          }
          const cachedHandlers = this._handlers.slice();
          this._handlers = [];
          cachedHandlers.forEach((handler) => {
            if (handler[0]) {
              return;
            }
            if (this._state === States.RESOLVED) {
              handler[1](this._value);
            }
            if (this._state === States.REJECTED) {
              handler[2](this._value);
            }
            handler[0] = true;
          });
        };
      }
    };
    exports.SyncPromise = SyncPromise;
    exports.rejectedSyncPromise = rejectedSyncPromise;
    exports.resolvedSyncPromise = resolvedSyncPromise;
  }
});

// ../../node_modules/.pnpm/@sentry+utils@7.120.1/node_modules/@sentry/utils/cjs/promisebuffer.js
var require_promisebuffer = __commonJS({
  "../../node_modules/.pnpm/@sentry+utils@7.120.1/node_modules/@sentry/utils/cjs/promisebuffer.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var error = require_error();
    var syncpromise = require_syncpromise();
    function makePromiseBuffer(limit) {
      const buffer = [];
      function isReady() {
        return limit === void 0 || buffer.length < limit;
      }
      function remove(task) {
        return buffer.splice(buffer.indexOf(task), 1)[0];
      }
      function add(taskProducer) {
        if (!isReady()) {
          return syncpromise.rejectedSyncPromise(new error.SentryError("Not adding Promise because buffer limit was reached."));
        }
        const task = taskProducer();
        if (buffer.indexOf(task) === -1) {
          buffer.push(task);
        }
        void task.then(() => remove(task)).then(
          null,
          () => remove(task).then(null, () => {
          })
        );
        return task;
      }
      function drain(timeout) {
        return new syncpromise.SyncPromise((resolve, reject) => {
          let counter = buffer.length;
          if (!counter) {
            return resolve(true);
          }
          const capturedSetTimeout = setTimeout(() => {
            if (timeout && timeout > 0) {
              resolve(false);
            }
          }, timeout);
          buffer.forEach((item) => {
            void syncpromise.resolvedSyncPromise(item).then(() => {
              if (!--counter) {
                clearTimeout(capturedSetTimeout);
                resolve(true);
              }
            }, reject);
          });
        });
      }
      return {
        $: buffer,
        add,
        drain
      };
    }
    exports.makePromiseBuffer = makePromiseBuffer;
  }
});

// ../../node_modules/.pnpm/@sentry+utils@7.120.1/node_modules/@sentry/utils/cjs/cookie.js
var require_cookie = __commonJS({
  "../../node_modules/.pnpm/@sentry+utils@7.120.1/node_modules/@sentry/utils/cjs/cookie.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    function parseCookie(str) {
      const obj = {};
      let index = 0;
      while (index < str.length) {
        const eqIdx = str.indexOf("=", index);
        if (eqIdx === -1) {
          break;
        }
        let endIdx = str.indexOf(";", index);
        if (endIdx === -1) {
          endIdx = str.length;
        } else if (endIdx < eqIdx) {
          index = str.lastIndexOf(";", eqIdx - 1) + 1;
          continue;
        }
        const key = str.slice(index, eqIdx).trim();
        if (void 0 === obj[key]) {
          let val = str.slice(eqIdx + 1, endIdx).trim();
          if (val.charCodeAt(0) === 34) {
            val = val.slice(1, -1);
          }
          try {
            obj[key] = val.indexOf("%") !== -1 ? decodeURIComponent(val) : val;
          } catch (e) {
            obj[key] = val;
          }
        }
        index = endIdx + 1;
      }
      return obj;
    }
    exports.parseCookie = parseCookie;
  }
});

// ../../node_modules/.pnpm/@sentry+utils@7.120.1/node_modules/@sentry/utils/cjs/url.js
var require_url = __commonJS({
  "../../node_modules/.pnpm/@sentry+utils@7.120.1/node_modules/@sentry/utils/cjs/url.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    function parseUrl(url) {
      if (!url) {
        return {};
      }
      const match = url.match(/^(([^:/?#]+):)?(\/\/([^/?#]*))?([^?#]*)(\?([^#]*))?(#(.*))?$/);
      if (!match) {
        return {};
      }
      const query = match[6] || "";
      const fragment = match[8] || "";
      return {
        host: match[4],
        path: match[5],
        protocol: match[2],
        search: query,
        hash: fragment,
        relative: match[5] + query + fragment
        // everything minus origin
      };
    }
    function stripUrlQueryAndFragment(urlPath) {
      return urlPath.split(/[\?#]/, 1)[0];
    }
    function getNumberOfUrlSegments(url) {
      return url.split(/\\?\//).filter((s) => s.length > 0 && s !== ",").length;
    }
    function getSanitizedUrlString(url) {
      const { protocol, host, path } = url;
      const filteredHost = host && host.replace(/^.*@/, "[filtered]:[filtered]@").replace(/(:80)$/, "").replace(/(:443)$/, "") || "";
      return `${protocol ? `${protocol}://` : ""}${filteredHost}${path}`;
    }
    exports.getNumberOfUrlSegments = getNumberOfUrlSegments;
    exports.getSanitizedUrlString = getSanitizedUrlString;
    exports.parseUrl = parseUrl;
    exports.stripUrlQueryAndFragment = stripUrlQueryAndFragment;
  }
});

// ../../node_modules/.pnpm/@sentry+utils@7.120.1/node_modules/@sentry/utils/cjs/requestdata.js
var require_requestdata = __commonJS({
  "../../node_modules/.pnpm/@sentry+utils@7.120.1/node_modules/@sentry/utils/cjs/requestdata.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var cookie = require_cookie();
    var debugBuild = require_debug_build();
    var is = require_is();
    var logger = require_logger();
    var normalize = require_normalize();
    var url = require_url();
    var DEFAULT_INCLUDES = {
      ip: false,
      request: true,
      transaction: true,
      user: true
    };
    var DEFAULT_REQUEST_INCLUDES = ["cookies", "data", "headers", "method", "query_string", "url"];
    var DEFAULT_USER_INCLUDES = ["id", "username", "email"];
    function addRequestDataToTransaction(transaction, req, deps) {
      if (!transaction)
        return;
      if (!transaction.metadata.source || transaction.metadata.source === "url") {
        const [name, source] = extractPathForTransaction(req, { path: true, method: true });
        transaction.updateName(name);
        transaction.setMetadata({ source });
      }
      transaction.setAttribute("url", req.originalUrl || req.url);
      if (req.baseUrl) {
        transaction.setAttribute("baseUrl", req.baseUrl);
      }
      transaction.setData("query", extractQueryParams(req, deps));
    }
    function extractPathForTransaction(req, options = {}) {
      const method = req.method && req.method.toUpperCase();
      let path = "";
      let source = "url";
      if (options.customRoute || req.route) {
        path = options.customRoute || `${req.baseUrl || ""}${req.route && req.route.path}`;
        source = "route";
      } else if (req.originalUrl || req.url) {
        path = url.stripUrlQueryAndFragment(req.originalUrl || req.url || "");
      }
      let name = "";
      if (options.method && method) {
        name += method;
      }
      if (options.method && options.path) {
        name += " ";
      }
      if (options.path && path) {
        name += path;
      }
      return [name, source];
    }
    function extractTransaction(req, type) {
      switch (type) {
        case "path": {
          return extractPathForTransaction(req, { path: true })[0];
        }
        case "handler": {
          return req.route && req.route.stack && req.route.stack[0] && req.route.stack[0].name || "<anonymous>";
        }
        case "methodPath":
        default: {
          const customRoute = req._reconstructedRoute ? req._reconstructedRoute : void 0;
          return extractPathForTransaction(req, { path: true, method: true, customRoute })[0];
        }
      }
    }
    function extractUserData(user, keys) {
      const extractedUser = {};
      const attributes = Array.isArray(keys) ? keys : DEFAULT_USER_INCLUDES;
      attributes.forEach((key) => {
        if (user && key in user) {
          extractedUser[key] = user[key];
        }
      });
      return extractedUser;
    }
    function extractRequestData(req, options) {
      const { include = DEFAULT_REQUEST_INCLUDES, deps } = options || {};
      const requestData = {};
      const headers = req.headers || {};
      const method = req.method;
      const host = headers.host || req.hostname || req.host || "<no host>";
      const protocol = req.protocol === "https" || req.socket && req.socket.encrypted ? "https" : "http";
      const originalUrl = req.originalUrl || req.url || "";
      const absoluteUrl = originalUrl.startsWith(protocol) ? originalUrl : `${protocol}://${host}${originalUrl}`;
      include.forEach((key) => {
        switch (key) {
          case "headers": {
            requestData.headers = headers;
            if (!include.includes("cookies")) {
              delete requestData.headers.cookie;
            }
            break;
          }
          case "method": {
            requestData.method = method;
            break;
          }
          case "url": {
            requestData.url = absoluteUrl;
            break;
          }
          case "cookies": {
            requestData.cookies = // TODO (v8 / #5257): We're only sending the empty object for backwards compatibility, so the last bit can
            // come off in v8
            req.cookies || headers.cookie && cookie.parseCookie(headers.cookie) || {};
            break;
          }
          case "query_string": {
            requestData.query_string = extractQueryParams(req, deps);
            break;
          }
          case "data": {
            if (method === "GET" || method === "HEAD") {
              break;
            }
            if (req.body !== void 0) {
              requestData.data = is.isString(req.body) ? req.body : JSON.stringify(normalize.normalize(req.body));
            }
            break;
          }
          default: {
            if ({}.hasOwnProperty.call(req, key)) {
              requestData[key] = req[key];
            }
          }
        }
      });
      return requestData;
    }
    function addRequestDataToEvent(event, req, options) {
      const include = {
        ...DEFAULT_INCLUDES,
        ...options && options.include
      };
      if (include.request) {
        const extractedRequestData = Array.isArray(include.request) ? extractRequestData(req, { include: include.request, deps: options && options.deps }) : extractRequestData(req, { deps: options && options.deps });
        event.request = {
          ...event.request,
          ...extractedRequestData
        };
      }
      if (include.user) {
        const extractedUser = req.user && is.isPlainObject(req.user) ? extractUserData(req.user, include.user) : {};
        if (Object.keys(extractedUser).length) {
          event.user = {
            ...event.user,
            ...extractedUser
          };
        }
      }
      if (include.ip) {
        const ip = req.ip || req.socket && req.socket.remoteAddress;
        if (ip) {
          event.user = {
            ...event.user,
            ip_address: ip
          };
        }
      }
      if (include.transaction && !event.transaction) {
        event.transaction = extractTransaction(req, include.transaction);
      }
      return event;
    }
    function extractQueryParams(req, deps) {
      let originalUrl = req.originalUrl || req.url || "";
      if (!originalUrl) {
        return;
      }
      if (originalUrl.startsWith("/")) {
        originalUrl = `http://dogs.are.great${originalUrl}`;
      }
      try {
        return req.query || typeof URL !== "undefined" && new URL(originalUrl).search.slice(1) || // In Node 8, `URL` isn't in the global scope, so we have to use the built-in module from Node
        deps && deps.url && deps.url.parse(originalUrl).query || void 0;
      } catch (e2) {
        return void 0;
      }
    }
    function winterCGHeadersToDict(winterCGHeaders) {
      const headers = {};
      try {
        winterCGHeaders.forEach((value, key) => {
          if (typeof value === "string") {
            headers[key] = value;
          }
        });
      } catch (e) {
        debugBuild.DEBUG_BUILD && logger.logger.warn("Sentry failed extracting headers from a request object. If you see this, please file an issue.");
      }
      return headers;
    }
    function winterCGRequestToRequestData(req) {
      const headers = winterCGHeadersToDict(req.headers);
      return {
        method: req.method,
        url: req.url,
        headers
      };
    }
    exports.DEFAULT_USER_INCLUDES = DEFAULT_USER_INCLUDES;
    exports.addRequestDataToEvent = addRequestDataToEvent;
    exports.addRequestDataToTransaction = addRequestDataToTransaction;
    exports.extractPathForTransaction = extractPathForTransaction;
    exports.extractRequestData = extractRequestData;
    exports.winterCGHeadersToDict = winterCGHeadersToDict;
    exports.winterCGRequestToRequestData = winterCGRequestToRequestData;
  }
});

// ../../node_modules/.pnpm/@sentry+utils@7.120.1/node_modules/@sentry/utils/cjs/severity.js
var require_severity = __commonJS({
  "../../node_modules/.pnpm/@sentry+utils@7.120.1/node_modules/@sentry/utils/cjs/severity.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var validSeverityLevels = ["fatal", "error", "warning", "log", "info", "debug"];
    function severityFromString(level) {
      return severityLevelFromString(level);
    }
    function severityLevelFromString(level) {
      return level === "warn" ? "warning" : validSeverityLevels.includes(level) ? level : "log";
    }
    exports.severityFromString = severityFromString;
    exports.severityLevelFromString = severityLevelFromString;
    exports.validSeverityLevels = validSeverityLevels;
  }
});

// ../../node_modules/.pnpm/@sentry+utils@7.120.1/node_modules/@sentry/utils/cjs/time.js
var require_time = __commonJS({
  "../../node_modules/.pnpm/@sentry+utils@7.120.1/node_modules/@sentry/utils/cjs/time.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var worldwide = require_worldwide();
    var ONE_SECOND_IN_MS = 1e3;
    function dateTimestampInSeconds() {
      return Date.now() / ONE_SECOND_IN_MS;
    }
    function createUnixTimestampInSecondsFunc() {
      const { performance: performance2 } = worldwide.GLOBAL_OBJ;
      if (!performance2 || !performance2.now) {
        return dateTimestampInSeconds;
      }
      const approxStartingTimeOrigin = Date.now() - performance2.now();
      const timeOrigin = performance2.timeOrigin == void 0 ? approxStartingTimeOrigin : performance2.timeOrigin;
      return () => {
        return (timeOrigin + performance2.now()) / ONE_SECOND_IN_MS;
      };
    }
    var timestampInSeconds = createUnixTimestampInSecondsFunc();
    var timestampWithMs = timestampInSeconds;
    exports._browserPerformanceTimeOriginMode = void 0;
    var browserPerformanceTimeOrigin = (() => {
      const { performance: performance2 } = worldwide.GLOBAL_OBJ;
      if (!performance2 || !performance2.now) {
        exports._browserPerformanceTimeOriginMode = "none";
        return void 0;
      }
      const threshold = 3600 * 1e3;
      const performanceNow = performance2.now();
      const dateNow = Date.now();
      const timeOriginDelta = performance2.timeOrigin ? Math.abs(performance2.timeOrigin + performanceNow - dateNow) : threshold;
      const timeOriginIsReliable = timeOriginDelta < threshold;
      const navigationStart = performance2.timing && performance2.timing.navigationStart;
      const hasNavigationStart = typeof navigationStart === "number";
      const navigationStartDelta = hasNavigationStart ? Math.abs(navigationStart + performanceNow - dateNow) : threshold;
      const navigationStartIsReliable = navigationStartDelta < threshold;
      if (timeOriginIsReliable || navigationStartIsReliable) {
        if (timeOriginDelta <= navigationStartDelta) {
          exports._browserPerformanceTimeOriginMode = "timeOrigin";
          return performance2.timeOrigin;
        } else {
          exports._browserPerformanceTimeOriginMode = "navigationStart";
          return navigationStart;
        }
      }
      exports._browserPerformanceTimeOriginMode = "dateNow";
      return dateNow;
    })();
    exports.browserPerformanceTimeOrigin = browserPerformanceTimeOrigin;
    exports.dateTimestampInSeconds = dateTimestampInSeconds;
    exports.timestampInSeconds = timestampInSeconds;
    exports.timestampWithMs = timestampWithMs;
  }
});

// ../../node_modules/.pnpm/@sentry+utils@7.120.1/node_modules/@sentry/utils/cjs/baggage.js
var require_baggage = __commonJS({
  "../../node_modules/.pnpm/@sentry+utils@7.120.1/node_modules/@sentry/utils/cjs/baggage.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var debugBuild = require_debug_build();
    var is = require_is();
    var logger = require_logger();
    var BAGGAGE_HEADER_NAME = "baggage";
    var SENTRY_BAGGAGE_KEY_PREFIX = "sentry-";
    var SENTRY_BAGGAGE_KEY_PREFIX_REGEX = /^sentry-/;
    var MAX_BAGGAGE_STRING_LENGTH = 8192;
    function baggageHeaderToDynamicSamplingContext(baggageHeader) {
      if (!is.isString(baggageHeader) && !Array.isArray(baggageHeader)) {
        return void 0;
      }
      let baggageObject = {};
      if (Array.isArray(baggageHeader)) {
        baggageObject = baggageHeader.reduce((acc, curr) => {
          const currBaggageObject = baggageHeaderToObject(curr);
          for (const key of Object.keys(currBaggageObject)) {
            acc[key] = currBaggageObject[key];
          }
          return acc;
        }, {});
      } else {
        if (!baggageHeader) {
          return void 0;
        }
        baggageObject = baggageHeaderToObject(baggageHeader);
      }
      const dynamicSamplingContext = Object.entries(baggageObject).reduce((acc, [key, value]) => {
        if (key.match(SENTRY_BAGGAGE_KEY_PREFIX_REGEX)) {
          const nonPrefixedKey = key.slice(SENTRY_BAGGAGE_KEY_PREFIX.length);
          acc[nonPrefixedKey] = value;
        }
        return acc;
      }, {});
      if (Object.keys(dynamicSamplingContext).length > 0) {
        return dynamicSamplingContext;
      } else {
        return void 0;
      }
    }
    function dynamicSamplingContextToSentryBaggageHeader(dynamicSamplingContext) {
      if (!dynamicSamplingContext) {
        return void 0;
      }
      const sentryPrefixedDSC = Object.entries(dynamicSamplingContext).reduce(
        (acc, [dscKey, dscValue]) => {
          if (dscValue) {
            acc[`${SENTRY_BAGGAGE_KEY_PREFIX}${dscKey}`] = dscValue;
          }
          return acc;
        },
        {}
      );
      return objectToBaggageHeader(sentryPrefixedDSC);
    }
    function baggageHeaderToObject(baggageHeader) {
      return baggageHeader.split(",").map((baggageEntry) => baggageEntry.split("=").map((keyOrValue) => decodeURIComponent(keyOrValue.trim()))).reduce((acc, [key, value]) => {
        acc[key] = value;
        return acc;
      }, {});
    }
    function objectToBaggageHeader(object) {
      if (Object.keys(object).length === 0) {
        return void 0;
      }
      return Object.entries(object).reduce((baggageHeader, [objectKey, objectValue], currentIndex) => {
        const baggageEntry = `${encodeURIComponent(objectKey)}=${encodeURIComponent(objectValue)}`;
        const newBaggageHeader = currentIndex === 0 ? baggageEntry : `${baggageHeader},${baggageEntry}`;
        if (newBaggageHeader.length > MAX_BAGGAGE_STRING_LENGTH) {
          debugBuild.DEBUG_BUILD && logger.logger.warn(
            `Not adding key: ${objectKey} with val: ${objectValue} to baggage header due to exceeding baggage size limits.`
          );
          return baggageHeader;
        } else {
          return newBaggageHeader;
        }
      }, "");
    }
    exports.BAGGAGE_HEADER_NAME = BAGGAGE_HEADER_NAME;
    exports.MAX_BAGGAGE_STRING_LENGTH = MAX_BAGGAGE_STRING_LENGTH;
    exports.SENTRY_BAGGAGE_KEY_PREFIX = SENTRY_BAGGAGE_KEY_PREFIX;
    exports.SENTRY_BAGGAGE_KEY_PREFIX_REGEX = SENTRY_BAGGAGE_KEY_PREFIX_REGEX;
    exports.baggageHeaderToDynamicSamplingContext = baggageHeaderToDynamicSamplingContext;
    exports.dynamicSamplingContextToSentryBaggageHeader = dynamicSamplingContextToSentryBaggageHeader;
  }
});

// ../../node_modules/.pnpm/@sentry+utils@7.120.1/node_modules/@sentry/utils/cjs/tracing.js
var require_tracing = __commonJS({
  "../../node_modules/.pnpm/@sentry+utils@7.120.1/node_modules/@sentry/utils/cjs/tracing.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var baggage = require_baggage();
    var misc = require_misc();
    var TRACEPARENT_REGEXP = new RegExp(
      "^[ \\t]*([0-9a-f]{32})?-?([0-9a-f]{16})?-?([01])?[ \\t]*$"
      // whitespace
    );
    function extractTraceparentData(traceparent) {
      if (!traceparent) {
        return void 0;
      }
      const matches = traceparent.match(TRACEPARENT_REGEXP);
      if (!matches) {
        return void 0;
      }
      let parentSampled;
      if (matches[3] === "1") {
        parentSampled = true;
      } else if (matches[3] === "0") {
        parentSampled = false;
      }
      return {
        traceId: matches[1],
        parentSampled,
        parentSpanId: matches[2]
      };
    }
    function tracingContextFromHeaders(sentryTrace, baggage$1) {
      const traceparentData = extractTraceparentData(sentryTrace);
      const dynamicSamplingContext = baggage.baggageHeaderToDynamicSamplingContext(baggage$1);
      const { traceId, parentSpanId, parentSampled } = traceparentData || {};
      if (!traceparentData) {
        return {
          traceparentData,
          dynamicSamplingContext: void 0,
          propagationContext: {
            traceId: traceId || misc.uuid4(),
            spanId: misc.uuid4().substring(16)
          }
        };
      } else {
        return {
          traceparentData,
          dynamicSamplingContext: dynamicSamplingContext || {},
          // If we have traceparent data but no DSC it means we are not head of trace and we must freeze it
          propagationContext: {
            traceId: traceId || misc.uuid4(),
            parentSpanId: parentSpanId || misc.uuid4().substring(16),
            spanId: misc.uuid4().substring(16),
            sampled: parentSampled,
            dsc: dynamicSamplingContext || {}
            // If we have traceparent data but no DSC it means we are not head of trace and we must freeze it
          }
        };
      }
    }
    function propagationContextFromHeaders(sentryTrace, baggage$1) {
      const traceparentData = extractTraceparentData(sentryTrace);
      const dynamicSamplingContext = baggage.baggageHeaderToDynamicSamplingContext(baggage$1);
      const { traceId, parentSpanId, parentSampled } = traceparentData || {};
      if (!traceparentData) {
        return {
          traceId: traceId || misc.uuid4(),
          spanId: misc.uuid4().substring(16)
        };
      } else {
        return {
          traceId: traceId || misc.uuid4(),
          parentSpanId: parentSpanId || misc.uuid4().substring(16),
          spanId: misc.uuid4().substring(16),
          sampled: parentSampled,
          dsc: dynamicSamplingContext || {}
          // If we have traceparent data but no DSC it means we are not head of trace and we must freeze it
        };
      }
    }
    function generateSentryTraceHeader(traceId = misc.uuid4(), spanId = misc.uuid4().substring(16), sampled) {
      let sampledString = "";
      if (sampled !== void 0) {
        sampledString = sampled ? "-1" : "-0";
      }
      return `${traceId}-${spanId}${sampledString}`;
    }
    exports.TRACEPARENT_REGEXP = TRACEPARENT_REGEXP;
    exports.extractTraceparentData = extractTraceparentData;
    exports.generateSentryTraceHeader = generateSentryTraceHeader;
    exports.propagationContextFromHeaders = propagationContextFromHeaders;
    exports.tracingContextFromHeaders = tracingContextFromHeaders;
  }
});

// ../../node_modules/.pnpm/@sentry+utils@7.120.1/node_modules/@sentry/utils/cjs/envelope.js
var require_envelope = __commonJS({
  "../../node_modules/.pnpm/@sentry+utils@7.120.1/node_modules/@sentry/utils/cjs/envelope.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var dsn = require_dsn();
    var normalize = require_normalize();
    var object = require_object();
    function createEnvelope(headers, items = []) {
      return [headers, items];
    }
    function addItemToEnvelope(envelope, newItem) {
      const [headers, items] = envelope;
      return [headers, [...items, newItem]];
    }
    function forEachEnvelopeItem(envelope, callback) {
      const envelopeItems = envelope[1];
      for (const envelopeItem of envelopeItems) {
        const envelopeItemType = envelopeItem[0].type;
        const result = callback(envelopeItem, envelopeItemType);
        if (result) {
          return true;
        }
      }
      return false;
    }
    function envelopeContainsItemType(envelope, types) {
      return forEachEnvelopeItem(envelope, (_, type) => types.includes(type));
    }
    function encodeUTF8(input, textEncoder) {
      const utf8 = textEncoder || new TextEncoder();
      return utf8.encode(input);
    }
    function serializeEnvelope(envelope, textEncoder) {
      const [envHeaders, items] = envelope;
      let parts = JSON.stringify(envHeaders);
      function append(next) {
        if (typeof parts === "string") {
          parts = typeof next === "string" ? parts + next : [encodeUTF8(parts, textEncoder), next];
        } else {
          parts.push(typeof next === "string" ? encodeUTF8(next, textEncoder) : next);
        }
      }
      for (const item of items) {
        const [itemHeaders, payload] = item;
        append(`
${JSON.stringify(itemHeaders)}
`);
        if (typeof payload === "string" || payload instanceof Uint8Array) {
          append(payload);
        } else {
          let stringifiedPayload;
          try {
            stringifiedPayload = JSON.stringify(payload);
          } catch (e) {
            stringifiedPayload = JSON.stringify(normalize.normalize(payload));
          }
          append(stringifiedPayload);
        }
      }
      return typeof parts === "string" ? parts : concatBuffers(parts);
    }
    function concatBuffers(buffers) {
      const totalLength = buffers.reduce((acc, buf) => acc + buf.length, 0);
      const merged = new Uint8Array(totalLength);
      let offset = 0;
      for (const buffer of buffers) {
        merged.set(buffer, offset);
        offset += buffer.length;
      }
      return merged;
    }
    function parseEnvelope(env, textEncoder, textDecoder) {
      let buffer = typeof env === "string" ? textEncoder.encode(env) : env;
      function readBinary(length) {
        const bin = buffer.subarray(0, length);
        buffer = buffer.subarray(length + 1);
        return bin;
      }
      function readJson() {
        let i = buffer.indexOf(10);
        if (i < 0) {
          i = buffer.length;
        }
        return JSON.parse(textDecoder.decode(readBinary(i)));
      }
      const envelopeHeader = readJson();
      const items = [];
      while (buffer.length) {
        const itemHeader = readJson();
        const binaryLength = typeof itemHeader.length === "number" ? itemHeader.length : void 0;
        items.push([itemHeader, binaryLength ? readBinary(binaryLength) : readJson()]);
      }
      return [envelopeHeader, items];
    }
    function createAttachmentEnvelopeItem(attachment, textEncoder) {
      const buffer = typeof attachment.data === "string" ? encodeUTF8(attachment.data, textEncoder) : attachment.data;
      return [
        object.dropUndefinedKeys({
          type: "attachment",
          length: buffer.length,
          filename: attachment.filename,
          content_type: attachment.contentType,
          attachment_type: attachment.attachmentType
        }),
        buffer
      ];
    }
    var ITEM_TYPE_TO_DATA_CATEGORY_MAP = {
      session: "session",
      sessions: "session",
      attachment: "attachment",
      transaction: "transaction",
      event: "error",
      client_report: "internal",
      user_report: "default",
      profile: "profile",
      replay_event: "replay",
      replay_recording: "replay",
      check_in: "monitor",
      feedback: "feedback",
      span: "span",
      statsd: "metric_bucket"
    };
    function envelopeItemTypeToDataCategory(type) {
      return ITEM_TYPE_TO_DATA_CATEGORY_MAP[type];
    }
    function getSdkMetadataForEnvelopeHeader(metadataOrEvent) {
      if (!metadataOrEvent || !metadataOrEvent.sdk) {
        return;
      }
      const { name, version } = metadataOrEvent.sdk;
      return { name, version };
    }
    function createEventEnvelopeHeaders(event, sdkInfo, tunnel, dsn$1) {
      const dynamicSamplingContext = event.sdkProcessingMetadata && event.sdkProcessingMetadata.dynamicSamplingContext;
      return {
        event_id: event.event_id,
        sent_at: (/* @__PURE__ */ new Date()).toISOString(),
        ...sdkInfo && { sdk: sdkInfo },
        ...!!tunnel && dsn$1 && { dsn: dsn.dsnToString(dsn$1) },
        ...dynamicSamplingContext && {
          trace: object.dropUndefinedKeys({ ...dynamicSamplingContext })
        }
      };
    }
    exports.addItemToEnvelope = addItemToEnvelope;
    exports.createAttachmentEnvelopeItem = createAttachmentEnvelopeItem;
    exports.createEnvelope = createEnvelope;
    exports.createEventEnvelopeHeaders = createEventEnvelopeHeaders;
    exports.envelopeContainsItemType = envelopeContainsItemType;
    exports.envelopeItemTypeToDataCategory = envelopeItemTypeToDataCategory;
    exports.forEachEnvelopeItem = forEachEnvelopeItem;
    exports.getSdkMetadataForEnvelopeHeader = getSdkMetadataForEnvelopeHeader;
    exports.parseEnvelope = parseEnvelope;
    exports.serializeEnvelope = serializeEnvelope;
  }
});

// ../../node_modules/.pnpm/@sentry+utils@7.120.1/node_modules/@sentry/utils/cjs/clientreport.js
var require_clientreport = __commonJS({
  "../../node_modules/.pnpm/@sentry+utils@7.120.1/node_modules/@sentry/utils/cjs/clientreport.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var envelope = require_envelope();
    var time = require_time();
    function createClientReportEnvelope(discarded_events, dsn, timestamp) {
      const clientReportItem = [
        { type: "client_report" },
        {
          timestamp: timestamp || time.dateTimestampInSeconds(),
          discarded_events
        }
      ];
      return envelope.createEnvelope(dsn ? { dsn } : {}, [clientReportItem]);
    }
    exports.createClientReportEnvelope = createClientReportEnvelope;
  }
});

// ../../node_modules/.pnpm/@sentry+utils@7.120.1/node_modules/@sentry/utils/cjs/ratelimit.js
var require_ratelimit = __commonJS({
  "../../node_modules/.pnpm/@sentry+utils@7.120.1/node_modules/@sentry/utils/cjs/ratelimit.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var DEFAULT_RETRY_AFTER = 60 * 1e3;
    function parseRetryAfterHeader(header, now = Date.now()) {
      const headerDelay = parseInt(`${header}`, 10);
      if (!isNaN(headerDelay)) {
        return headerDelay * 1e3;
      }
      const headerDate = Date.parse(`${header}`);
      if (!isNaN(headerDate)) {
        return headerDate - now;
      }
      return DEFAULT_RETRY_AFTER;
    }
    function disabledUntil(limits, dataCategory) {
      return limits[dataCategory] || limits.all || 0;
    }
    function isRateLimited(limits, dataCategory, now = Date.now()) {
      return disabledUntil(limits, dataCategory) > now;
    }
    function updateRateLimits(limits, { statusCode, headers }, now = Date.now()) {
      const updatedRateLimits = {
        ...limits
      };
      const rateLimitHeader = headers && headers["x-sentry-rate-limits"];
      const retryAfterHeader = headers && headers["retry-after"];
      if (rateLimitHeader) {
        for (const limit of rateLimitHeader.trim().split(",")) {
          const [retryAfter, categories, , , namespaces] = limit.split(":", 5);
          const headerDelay = parseInt(retryAfter, 10);
          const delay = (!isNaN(headerDelay) ? headerDelay : 60) * 1e3;
          if (!categories) {
            updatedRateLimits.all = now + delay;
          } else {
            for (const category of categories.split(";")) {
              if (category === "metric_bucket") {
                if (!namespaces || namespaces.split(";").includes("custom")) {
                  updatedRateLimits[category] = now + delay;
                }
              } else {
                updatedRateLimits[category] = now + delay;
              }
            }
          }
        }
      } else if (retryAfterHeader) {
        updatedRateLimits.all = now + parseRetryAfterHeader(retryAfterHeader, now);
      } else if (statusCode === 429) {
        updatedRateLimits.all = now + 60 * 1e3;
      }
      return updatedRateLimits;
    }
    exports.DEFAULT_RETRY_AFTER = DEFAULT_RETRY_AFTER;
    exports.disabledUntil = disabledUntil;
    exports.isRateLimited = isRateLimited;
    exports.parseRetryAfterHeader = parseRetryAfterHeader;
    exports.updateRateLimits = updateRateLimits;
  }
});

// ../../node_modules/.pnpm/@sentry+utils@7.120.1/node_modules/@sentry/utils/cjs/userIntegrations.js
var require_userIntegrations = __commonJS({
  "../../node_modules/.pnpm/@sentry+utils@7.120.1/node_modules/@sentry/utils/cjs/userIntegrations.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    function setNestedKey(obj, keyPath, value) {
      const match = keyPath.match(/([a-z_]+)\.(.*)/i);
      if (match === null) {
        obj[keyPath] = value;
      } else {
        const innerObj = obj[match[1]];
        setNestedKey(innerObj, match[2], value);
      }
    }
    function addOrUpdateIntegration(defaultIntegrationInstance, userIntegrations, forcedOptions = {}) {
      return Array.isArray(userIntegrations) ? addOrUpdateIntegrationInArray(defaultIntegrationInstance, userIntegrations, forcedOptions) : addOrUpdateIntegrationInFunction(
        defaultIntegrationInstance,
        // Somehow TS can't figure out that not being an array makes this necessarily a function
        userIntegrations,
        forcedOptions
      );
    }
    function addOrUpdateIntegrationInArray(defaultIntegrationInstance, userIntegrations, forcedOptions) {
      const userInstance = userIntegrations.find((integration) => integration.name === defaultIntegrationInstance.name);
      if (userInstance) {
        for (const [keyPath, value] of Object.entries(forcedOptions)) {
          setNestedKey(userInstance, keyPath, value);
        }
        return userIntegrations;
      }
      return [...userIntegrations, defaultIntegrationInstance];
    }
    function addOrUpdateIntegrationInFunction(defaultIntegrationInstance, userIntegrationsFunc, forcedOptions) {
      const wrapper = (defaultIntegrations) => {
        const userFinalIntegrations = userIntegrationsFunc(defaultIntegrations);
        if (defaultIntegrationInstance.allowExclusionByUser) {
          const userFinalInstance = userFinalIntegrations.find(
            (integration) => integration.name === defaultIntegrationInstance.name
          );
          if (!userFinalInstance) {
            return userFinalIntegrations;
          }
        }
        return addOrUpdateIntegrationInArray(defaultIntegrationInstance, userFinalIntegrations, forcedOptions);
      };
      return wrapper;
    }
    exports.addOrUpdateIntegration = addOrUpdateIntegration;
  }
});

// ../../node_modules/.pnpm/@sentry+utils@7.120.1/node_modules/@sentry/utils/cjs/cache.js
var require_cache = __commonJS({
  "../../node_modules/.pnpm/@sentry+utils@7.120.1/node_modules/@sentry/utils/cjs/cache.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    function makeFifoCache(size) {
      let evictionOrder = [];
      let cache = {};
      return {
        add(key, value) {
          while (evictionOrder.length >= size) {
            const evictCandidate = evictionOrder.shift();
            if (evictCandidate !== void 0) {
              delete cache[evictCandidate];
            }
          }
          if (cache[key]) {
            this.delete(key);
          }
          evictionOrder.push(key);
          cache[key] = value;
        },
        clear() {
          cache = {};
          evictionOrder = [];
        },
        get(key) {
          return cache[key];
        },
        size() {
          return evictionOrder.length;
        },
        // Delete cache key and return true if it existed, false otherwise.
        delete(key) {
          if (!cache[key]) {
            return false;
          }
          delete cache[key];
          for (let i = 0; i < evictionOrder.length; i++) {
            if (evictionOrder[i] === key) {
              evictionOrder.splice(i, 1);
              break;
            }
          }
          return true;
        }
      };
    }
    exports.makeFifoCache = makeFifoCache;
  }
});

// ../../node_modules/.pnpm/@sentry+utils@7.120.1/node_modules/@sentry/utils/cjs/eventbuilder.js
var require_eventbuilder = __commonJS({
  "../../node_modules/.pnpm/@sentry+utils@7.120.1/node_modules/@sentry/utils/cjs/eventbuilder.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var is = require_is();
    var misc = require_misc();
    var normalize = require_normalize();
    var object = require_object();
    function parseStackFrames(stackParser, error) {
      return stackParser(error.stack || "", 1);
    }
    function exceptionFromError(stackParser, error) {
      const exception = {
        type: error.name || error.constructor.name,
        value: error.message
      };
      const frames = parseStackFrames(stackParser, error);
      if (frames.length) {
        exception.stacktrace = { frames };
      }
      return exception;
    }
    function getMessageForObject(exception) {
      if ("name" in exception && typeof exception.name === "string") {
        let message = `'${exception.name}' captured as exception`;
        if ("message" in exception && typeof exception.message === "string") {
          message += ` with message '${exception.message}'`;
        }
        return message;
      } else if ("message" in exception && typeof exception.message === "string") {
        return exception.message;
      } else {
        return `Object captured as exception with keys: ${object.extractExceptionKeysForMessage(
          exception
        )}`;
      }
    }
    function eventFromUnknownInput(getHubOrClient, stackParser, exception, hint) {
      const client = typeof getHubOrClient === "function" ? (
        // eslint-disable-next-line deprecation/deprecation
        getHubOrClient().getClient()
      ) : getHubOrClient;
      let ex = exception;
      const providedMechanism = hint && hint.data && hint.data.mechanism;
      const mechanism = providedMechanism || {
        handled: true,
        type: "generic"
      };
      let extras;
      if (!is.isError(exception)) {
        if (is.isPlainObject(exception)) {
          const normalizeDepth = client && client.getOptions().normalizeDepth;
          extras = { ["__serialized__"]: normalize.normalizeToSize(exception, normalizeDepth) };
          const message = getMessageForObject(exception);
          ex = hint && hint.syntheticException || new Error(message);
          ex.message = message;
        } else {
          ex = hint && hint.syntheticException || new Error(exception);
          ex.message = exception;
        }
        mechanism.synthetic = true;
      }
      const event = {
        exception: {
          values: [exceptionFromError(stackParser, ex)]
        }
      };
      if (extras) {
        event.extra = extras;
      }
      misc.addExceptionTypeValue(event, void 0, void 0);
      misc.addExceptionMechanism(event, mechanism);
      return {
        ...event,
        event_id: hint && hint.event_id
      };
    }
    function eventFromMessage(stackParser, message, level = "info", hint, attachStacktrace) {
      const event = {
        event_id: hint && hint.event_id,
        level
      };
      if (attachStacktrace && hint && hint.syntheticException) {
        const frames = parseStackFrames(stackParser, hint.syntheticException);
        if (frames.length) {
          event.exception = {
            values: [
              {
                value: message,
                stacktrace: { frames }
              }
            ]
          };
        }
      }
      if (is.isParameterizedString(message)) {
        const { __sentry_template_string__, __sentry_template_values__ } = message;
        event.logentry = {
          message: __sentry_template_string__,
          params: __sentry_template_values__
        };
        return event;
      }
      event.message = message;
      return event;
    }
    exports.eventFromMessage = eventFromMessage;
    exports.eventFromUnknownInput = eventFromUnknownInput;
    exports.exceptionFromError = exceptionFromError;
    exports.parseStackFrames = parseStackFrames;
  }
});

// ../../node_modules/.pnpm/@sentry+utils@7.120.1/node_modules/@sentry/utils/cjs/anr.js
var require_anr = __commonJS({
  "../../node_modules/.pnpm/@sentry+utils@7.120.1/node_modules/@sentry/utils/cjs/anr.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var object = require_object();
    var nodeStackTrace = require_node_stack_trace();
    function watchdogTimer(createTimer, pollInterval, anrThreshold, callback) {
      const timer = createTimer();
      let triggered = false;
      let enabled = true;
      setInterval(() => {
        const diffMs = timer.getTimeMs();
        if (triggered === false && diffMs > pollInterval + anrThreshold) {
          triggered = true;
          if (enabled) {
            callback();
          }
        }
        if (diffMs < pollInterval + anrThreshold) {
          triggered = false;
        }
      }, 20);
      return {
        poll: () => {
          timer.reset();
        },
        enabled: (state) => {
          enabled = state;
        }
      };
    }
    function callFrameToStackFrame(frame, url, getModuleFromFilename) {
      const filename = url ? url.replace(/^file:\/\//, "") : void 0;
      const colno = frame.location.columnNumber ? frame.location.columnNumber + 1 : void 0;
      const lineno = frame.location.lineNumber ? frame.location.lineNumber + 1 : void 0;
      return object.dropUndefinedKeys({
        filename,
        module: getModuleFromFilename(filename),
        function: frame.functionName || "?",
        colno,
        lineno,
        in_app: filename ? nodeStackTrace.filenameIsInApp(filename) : void 0
      });
    }
    exports.callFrameToStackFrame = callFrameToStackFrame;
    exports.watchdogTimer = watchdogTimer;
  }
});

// ../../node_modules/.pnpm/@sentry+utils@7.120.1/node_modules/@sentry/utils/cjs/lru.js
var require_lru = __commonJS({
  "../../node_modules/.pnpm/@sentry+utils@7.120.1/node_modules/@sentry/utils/cjs/lru.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var LRUMap = class {
      constructor(_maxSize) {
        this._maxSize = _maxSize;
        this._cache = /* @__PURE__ */ new Map();
      }
      /** Get the current size of the cache */
      get size() {
        return this._cache.size;
      }
      /** Get an entry or undefined if it was not in the cache. Re-inserts to update the recently used order */
      get(key) {
        const value = this._cache.get(key);
        if (value === void 0) {
          return void 0;
        }
        this._cache.delete(key);
        this._cache.set(key, value);
        return value;
      }
      /** Insert an entry and evict an older entry if we've reached maxSize */
      set(key, value) {
        if (this._cache.size >= this._maxSize) {
          this._cache.delete(this._cache.keys().next().value);
        }
        this._cache.set(key, value);
      }
      /** Remove an entry and return the entry if it was in the cache */
      remove(key) {
        const value = this._cache.get(key);
        if (value) {
          this._cache.delete(key);
        }
        return value;
      }
      /** Clear all entries */
      clear() {
        this._cache.clear();
      }
      /** Get all the keys */
      keys() {
        return Array.from(this._cache.keys());
      }
      /** Get all the values */
      values() {
        const values = [];
        this._cache.forEach((value) => values.push(value));
        return values;
      }
    };
    exports.LRUMap = LRUMap;
  }
});

// ../../node_modules/.pnpm/@sentry+utils@7.120.1/node_modules/@sentry/utils/cjs/buildPolyfills/_nullishCoalesce.js
var require_nullishCoalesce = __commonJS({
  "../../node_modules/.pnpm/@sentry+utils@7.120.1/node_modules/@sentry/utils/cjs/buildPolyfills/_nullishCoalesce.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    function _nullishCoalesce(lhs, rhsFn) {
      return lhs != null ? lhs : rhsFn();
    }
    exports._nullishCoalesce = _nullishCoalesce;
  }
});

// ../../node_modules/.pnpm/@sentry+utils@7.120.1/node_modules/@sentry/utils/cjs/buildPolyfills/_asyncNullishCoalesce.js
var require_asyncNullishCoalesce = __commonJS({
  "../../node_modules/.pnpm/@sentry+utils@7.120.1/node_modules/@sentry/utils/cjs/buildPolyfills/_asyncNullishCoalesce.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var _nullishCoalesce = require_nullishCoalesce();
    async function _asyncNullishCoalesce(lhs, rhsFn) {
      return _nullishCoalesce._nullishCoalesce(lhs, rhsFn);
    }
    exports._asyncNullishCoalesce = _asyncNullishCoalesce;
  }
});

// ../../node_modules/.pnpm/@sentry+utils@7.120.1/node_modules/@sentry/utils/cjs/buildPolyfills/_asyncOptionalChain.js
var require_asyncOptionalChain = __commonJS({
  "../../node_modules/.pnpm/@sentry+utils@7.120.1/node_modules/@sentry/utils/cjs/buildPolyfills/_asyncOptionalChain.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    async function _asyncOptionalChain(ops) {
      let lastAccessLHS = void 0;
      let value = ops[0];
      let i = 1;
      while (i < ops.length) {
        const op = ops[i];
        const fn = ops[i + 1];
        i += 2;
        if ((op === "optionalAccess" || op === "optionalCall") && value == null) {
          return;
        }
        if (op === "access" || op === "optionalAccess") {
          lastAccessLHS = value;
          value = await fn(value);
        } else if (op === "call" || op === "optionalCall") {
          value = await fn((...args) => value.call(lastAccessLHS, ...args));
          lastAccessLHS = void 0;
        }
      }
      return value;
    }
    exports._asyncOptionalChain = _asyncOptionalChain;
  }
});

// ../../node_modules/.pnpm/@sentry+utils@7.120.1/node_modules/@sentry/utils/cjs/buildPolyfills/_asyncOptionalChainDelete.js
var require_asyncOptionalChainDelete = __commonJS({
  "../../node_modules/.pnpm/@sentry+utils@7.120.1/node_modules/@sentry/utils/cjs/buildPolyfills/_asyncOptionalChainDelete.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var _asyncOptionalChain = require_asyncOptionalChain();
    async function _asyncOptionalChainDelete(ops) {
      const result = await _asyncOptionalChain._asyncOptionalChain(ops);
      return result == null ? true : result;
    }
    exports._asyncOptionalChainDelete = _asyncOptionalChainDelete;
  }
});

// ../../node_modules/.pnpm/@sentry+utils@7.120.1/node_modules/@sentry/utils/cjs/buildPolyfills/_optionalChain.js
var require_optionalChain = __commonJS({
  "../../node_modules/.pnpm/@sentry+utils@7.120.1/node_modules/@sentry/utils/cjs/buildPolyfills/_optionalChain.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    function _optionalChain(ops) {
      let lastAccessLHS = void 0;
      let value = ops[0];
      let i = 1;
      while (i < ops.length) {
        const op = ops[i];
        const fn = ops[i + 1];
        i += 2;
        if ((op === "optionalAccess" || op === "optionalCall") && value == null) {
          return;
        }
        if (op === "access" || op === "optionalAccess") {
          lastAccessLHS = value;
          value = fn(value);
        } else if (op === "call" || op === "optionalCall") {
          value = fn((...args) => value.call(lastAccessLHS, ...args));
          lastAccessLHS = void 0;
        }
      }
      return value;
    }
    exports._optionalChain = _optionalChain;
  }
});

// ../../node_modules/.pnpm/@sentry+utils@7.120.1/node_modules/@sentry/utils/cjs/buildPolyfills/_optionalChainDelete.js
var require_optionalChainDelete = __commonJS({
  "../../node_modules/.pnpm/@sentry+utils@7.120.1/node_modules/@sentry/utils/cjs/buildPolyfills/_optionalChainDelete.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var _optionalChain = require_optionalChain();
    function _optionalChainDelete(ops) {
      const result = _optionalChain._optionalChain(ops);
      return result == null ? true : result;
    }
    exports._optionalChainDelete = _optionalChainDelete;
  }
});

// ../../node_modules/.pnpm/@sentry+utils@7.120.1/node_modules/@sentry/utils/cjs/vendor/escapeStringForRegex.js
var require_escapeStringForRegex = __commonJS({
  "../../node_modules/.pnpm/@sentry+utils@7.120.1/node_modules/@sentry/utils/cjs/vendor/escapeStringForRegex.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    function escapeStringForRegex(regexString) {
      return regexString.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&").replace(/-/g, "\\x2d");
    }
    exports.escapeStringForRegex = escapeStringForRegex;
  }
});

// ../../node_modules/.pnpm/@sentry+utils@7.120.1/node_modules/@sentry/utils/cjs/index.js
var require_cjs = __commonJS({
  "../../node_modules/.pnpm/@sentry+utils@7.120.1/node_modules/@sentry/utils/cjs/index.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var aggregateErrors = require_aggregate_errors();
    var browser = require_browser();
    var dsn = require_dsn();
    var error = require_error();
    var worldwide = require_worldwide();
    var index = require_instrument();
    var is = require_is();
    var isBrowser = require_isBrowser();
    var logger = require_logger();
    var memo = require_memo();
    var misc = require_misc();
    var node = require_node();
    var normalize = require_normalize();
    var object = require_object();
    var path = require_path();
    var promisebuffer = require_promisebuffer();
    var requestdata = require_requestdata();
    var severity = require_severity();
    var stacktrace = require_stacktrace();
    var string = require_string();
    var supports = require_supports();
    var syncpromise = require_syncpromise();
    var time = require_time();
    var tracing = require_tracing();
    var env = require_env();
    var envelope = require_envelope();
    var clientreport = require_clientreport();
    var ratelimit = require_ratelimit();
    var baggage = require_baggage();
    var url = require_url();
    var userIntegrations = require_userIntegrations();
    var cache = require_cache();
    var eventbuilder = require_eventbuilder();
    var anr = require_anr();
    var lru = require_lru();
    var _asyncNullishCoalesce = require_asyncNullishCoalesce();
    var _asyncOptionalChain = require_asyncOptionalChain();
    var _asyncOptionalChainDelete = require_asyncOptionalChainDelete();
    var _nullishCoalesce = require_nullishCoalesce();
    var _optionalChain = require_optionalChain();
    var _optionalChainDelete = require_optionalChainDelete();
    var console2 = require_console();
    var dom = require_dom();
    var xhr = require_xhr();
    var fetch2 = require_fetch();
    var history = require_history();
    var globalError = require_globalError();
    var globalUnhandledRejection = require_globalUnhandledRejection();
    var _handlers = require_handlers();
    var nodeStackTrace = require_node_stack_trace();
    var escapeStringForRegex = require_escapeStringForRegex();
    var supportsHistory = require_supportsHistory();
    exports.applyAggregateErrorsToEvent = aggregateErrors.applyAggregateErrorsToEvent;
    exports.getComponentName = browser.getComponentName;
    exports.getDomElement = browser.getDomElement;
    exports.getLocationHref = browser.getLocationHref;
    exports.htmlTreeAsString = browser.htmlTreeAsString;
    exports.dsnFromString = dsn.dsnFromString;
    exports.dsnToString = dsn.dsnToString;
    exports.makeDsn = dsn.makeDsn;
    exports.SentryError = error.SentryError;
    exports.GLOBAL_OBJ = worldwide.GLOBAL_OBJ;
    exports.getGlobalObject = worldwide.getGlobalObject;
    exports.getGlobalSingleton = worldwide.getGlobalSingleton;
    exports.addInstrumentationHandler = index.addInstrumentationHandler;
    exports.isDOMError = is.isDOMError;
    exports.isDOMException = is.isDOMException;
    exports.isElement = is.isElement;
    exports.isError = is.isError;
    exports.isErrorEvent = is.isErrorEvent;
    exports.isEvent = is.isEvent;
    exports.isInstanceOf = is.isInstanceOf;
    exports.isNaN = is.isNaN;
    exports.isParameterizedString = is.isParameterizedString;
    exports.isPlainObject = is.isPlainObject;
    exports.isPrimitive = is.isPrimitive;
    exports.isRegExp = is.isRegExp;
    exports.isString = is.isString;
    exports.isSyntheticEvent = is.isSyntheticEvent;
    exports.isThenable = is.isThenable;
    exports.isVueViewModel = is.isVueViewModel;
    exports.isBrowser = isBrowser.isBrowser;
    exports.CONSOLE_LEVELS = logger.CONSOLE_LEVELS;
    exports.consoleSandbox = logger.consoleSandbox;
    exports.logger = logger.logger;
    exports.originalConsoleMethods = logger.originalConsoleMethods;
    exports.memoBuilder = memo.memoBuilder;
    exports.addContextToFrame = misc.addContextToFrame;
    exports.addExceptionMechanism = misc.addExceptionMechanism;
    exports.addExceptionTypeValue = misc.addExceptionTypeValue;
    exports.arrayify = misc.arrayify;
    exports.checkOrSetAlreadyCaught = misc.checkOrSetAlreadyCaught;
    exports.getEventDescription = misc.getEventDescription;
    exports.parseSemver = misc.parseSemver;
    exports.uuid4 = misc.uuid4;
    exports.dynamicRequire = node.dynamicRequire;
    exports.isNodeEnv = node.isNodeEnv;
    exports.loadModule = node.loadModule;
    exports.normalize = normalize.normalize;
    exports.normalizeToSize = normalize.normalizeToSize;
    exports.normalizeUrlToBase = normalize.normalizeUrlToBase;
    exports.walk = normalize.walk;
    exports.addNonEnumerableProperty = object.addNonEnumerableProperty;
    exports.convertToPlainObject = object.convertToPlainObject;
    exports.dropUndefinedKeys = object.dropUndefinedKeys;
    exports.extractExceptionKeysForMessage = object.extractExceptionKeysForMessage;
    exports.fill = object.fill;
    exports.getOriginalFunction = object.getOriginalFunction;
    exports.markFunctionWrapped = object.markFunctionWrapped;
    exports.objectify = object.objectify;
    exports.urlEncode = object.urlEncode;
    exports.basename = path.basename;
    exports.dirname = path.dirname;
    exports.isAbsolute = path.isAbsolute;
    exports.join = path.join;
    exports.normalizePath = path.normalizePath;
    exports.relative = path.relative;
    exports.resolve = path.resolve;
    exports.makePromiseBuffer = promisebuffer.makePromiseBuffer;
    exports.DEFAULT_USER_INCLUDES = requestdata.DEFAULT_USER_INCLUDES;
    exports.addRequestDataToEvent = requestdata.addRequestDataToEvent;
    exports.addRequestDataToTransaction = requestdata.addRequestDataToTransaction;
    exports.extractPathForTransaction = requestdata.extractPathForTransaction;
    exports.extractRequestData = requestdata.extractRequestData;
    exports.winterCGHeadersToDict = requestdata.winterCGHeadersToDict;
    exports.winterCGRequestToRequestData = requestdata.winterCGRequestToRequestData;
    exports.severityFromString = severity.severityFromString;
    exports.severityLevelFromString = severity.severityLevelFromString;
    exports.validSeverityLevels = severity.validSeverityLevels;
    exports.createStackParser = stacktrace.createStackParser;
    exports.getFunctionName = stacktrace.getFunctionName;
    exports.nodeStackLineParser = stacktrace.nodeStackLineParser;
    exports.stackParserFromStackParserOptions = stacktrace.stackParserFromStackParserOptions;
    exports.stripSentryFramesAndReverse = stacktrace.stripSentryFramesAndReverse;
    exports.isMatchingPattern = string.isMatchingPattern;
    exports.safeJoin = string.safeJoin;
    exports.snipLine = string.snipLine;
    exports.stringMatchesSomePattern = string.stringMatchesSomePattern;
    exports.truncate = string.truncate;
    exports.isNativeFetch = supports.isNativeFetch;
    exports.supportsDOMError = supports.supportsDOMError;
    exports.supportsDOMException = supports.supportsDOMException;
    exports.supportsErrorEvent = supports.supportsErrorEvent;
    exports.supportsFetch = supports.supportsFetch;
    exports.supportsNativeFetch = supports.supportsNativeFetch;
    exports.supportsReferrerPolicy = supports.supportsReferrerPolicy;
    exports.supportsReportingObserver = supports.supportsReportingObserver;
    exports.SyncPromise = syncpromise.SyncPromise;
    exports.rejectedSyncPromise = syncpromise.rejectedSyncPromise;
    exports.resolvedSyncPromise = syncpromise.resolvedSyncPromise;
    Object.defineProperty(exports, "_browserPerformanceTimeOriginMode", {
      enumerable: true,
      get: () => time._browserPerformanceTimeOriginMode
    });
    exports.browserPerformanceTimeOrigin = time.browserPerformanceTimeOrigin;
    exports.dateTimestampInSeconds = time.dateTimestampInSeconds;
    exports.timestampInSeconds = time.timestampInSeconds;
    exports.timestampWithMs = time.timestampWithMs;
    exports.TRACEPARENT_REGEXP = tracing.TRACEPARENT_REGEXP;
    exports.extractTraceparentData = tracing.extractTraceparentData;
    exports.generateSentryTraceHeader = tracing.generateSentryTraceHeader;
    exports.propagationContextFromHeaders = tracing.propagationContextFromHeaders;
    exports.tracingContextFromHeaders = tracing.tracingContextFromHeaders;
    exports.getSDKSource = env.getSDKSource;
    exports.isBrowserBundle = env.isBrowserBundle;
    exports.addItemToEnvelope = envelope.addItemToEnvelope;
    exports.createAttachmentEnvelopeItem = envelope.createAttachmentEnvelopeItem;
    exports.createEnvelope = envelope.createEnvelope;
    exports.createEventEnvelopeHeaders = envelope.createEventEnvelopeHeaders;
    exports.envelopeContainsItemType = envelope.envelopeContainsItemType;
    exports.envelopeItemTypeToDataCategory = envelope.envelopeItemTypeToDataCategory;
    exports.forEachEnvelopeItem = envelope.forEachEnvelopeItem;
    exports.getSdkMetadataForEnvelopeHeader = envelope.getSdkMetadataForEnvelopeHeader;
    exports.parseEnvelope = envelope.parseEnvelope;
    exports.serializeEnvelope = envelope.serializeEnvelope;
    exports.createClientReportEnvelope = clientreport.createClientReportEnvelope;
    exports.DEFAULT_RETRY_AFTER = ratelimit.DEFAULT_RETRY_AFTER;
    exports.disabledUntil = ratelimit.disabledUntil;
    exports.isRateLimited = ratelimit.isRateLimited;
    exports.parseRetryAfterHeader = ratelimit.parseRetryAfterHeader;
    exports.updateRateLimits = ratelimit.updateRateLimits;
    exports.BAGGAGE_HEADER_NAME = baggage.BAGGAGE_HEADER_NAME;
    exports.MAX_BAGGAGE_STRING_LENGTH = baggage.MAX_BAGGAGE_STRING_LENGTH;
    exports.SENTRY_BAGGAGE_KEY_PREFIX = baggage.SENTRY_BAGGAGE_KEY_PREFIX;
    exports.SENTRY_BAGGAGE_KEY_PREFIX_REGEX = baggage.SENTRY_BAGGAGE_KEY_PREFIX_REGEX;
    exports.baggageHeaderToDynamicSamplingContext = baggage.baggageHeaderToDynamicSamplingContext;
    exports.dynamicSamplingContextToSentryBaggageHeader = baggage.dynamicSamplingContextToSentryBaggageHeader;
    exports.getNumberOfUrlSegments = url.getNumberOfUrlSegments;
    exports.getSanitizedUrlString = url.getSanitizedUrlString;
    exports.parseUrl = url.parseUrl;
    exports.stripUrlQueryAndFragment = url.stripUrlQueryAndFragment;
    exports.addOrUpdateIntegration = userIntegrations.addOrUpdateIntegration;
    exports.makeFifoCache = cache.makeFifoCache;
    exports.eventFromMessage = eventbuilder.eventFromMessage;
    exports.eventFromUnknownInput = eventbuilder.eventFromUnknownInput;
    exports.exceptionFromError = eventbuilder.exceptionFromError;
    exports.parseStackFrames = eventbuilder.parseStackFrames;
    exports.callFrameToStackFrame = anr.callFrameToStackFrame;
    exports.watchdogTimer = anr.watchdogTimer;
    exports.LRUMap = lru.LRUMap;
    exports._asyncNullishCoalesce = _asyncNullishCoalesce._asyncNullishCoalesce;
    exports._asyncOptionalChain = _asyncOptionalChain._asyncOptionalChain;
    exports._asyncOptionalChainDelete = _asyncOptionalChainDelete._asyncOptionalChainDelete;
    exports._nullishCoalesce = _nullishCoalesce._nullishCoalesce;
    exports._optionalChain = _optionalChain._optionalChain;
    exports._optionalChainDelete = _optionalChainDelete._optionalChainDelete;
    exports.addConsoleInstrumentationHandler = console2.addConsoleInstrumentationHandler;
    exports.addClickKeypressInstrumentationHandler = dom.addClickKeypressInstrumentationHandler;
    exports.SENTRY_XHR_DATA_KEY = xhr.SENTRY_XHR_DATA_KEY;
    exports.addXhrInstrumentationHandler = xhr.addXhrInstrumentationHandler;
    exports.addFetchInstrumentationHandler = fetch2.addFetchInstrumentationHandler;
    exports.addHistoryInstrumentationHandler = history.addHistoryInstrumentationHandler;
    exports.addGlobalErrorInstrumentationHandler = globalError.addGlobalErrorInstrumentationHandler;
    exports.addGlobalUnhandledRejectionInstrumentationHandler = globalUnhandledRejection.addGlobalUnhandledRejectionInstrumentationHandler;
    exports.resetInstrumentationHandlers = _handlers.resetInstrumentationHandlers;
    exports.filenameIsInApp = nodeStackTrace.filenameIsInApp;
    exports.escapeStringForRegex = escapeStringForRegex.escapeStringForRegex;
    exports.supportsHistory = supportsHistory.supportsHistory;
  }
});

// ../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/debug-build.js
var require_debug_build2 = __commonJS({
  "../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/debug-build.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var DEBUG_BUILD = typeof __SENTRY_DEBUG__ === "undefined" || __SENTRY_DEBUG__;
    exports.DEBUG_BUILD = DEBUG_BUILD;
  }
});

// ../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/constants.js
var require_constants = __commonJS({
  "../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/constants.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var DEFAULT_ENVIRONMENT = "production";
    exports.DEFAULT_ENVIRONMENT = DEFAULT_ENVIRONMENT;
  }
});

// ../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/eventProcessors.js
var require_eventProcessors = __commonJS({
  "../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/eventProcessors.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var utils = require_cjs();
    var debugBuild = require_debug_build2();
    function getGlobalEventProcessors() {
      return utils.getGlobalSingleton("globalEventProcessors", () => []);
    }
    function addGlobalEventProcessor(callback) {
      getGlobalEventProcessors().push(callback);
    }
    function notifyEventProcessors(processors, event, hint, index = 0) {
      return new utils.SyncPromise((resolve, reject) => {
        const processor = processors[index];
        if (event === null || typeof processor !== "function") {
          resolve(event);
        } else {
          const result = processor({ ...event }, hint);
          debugBuild.DEBUG_BUILD && processor.id && result === null && utils.logger.log(`Event processor "${processor.id}" dropped event`);
          if (utils.isThenable(result)) {
            void result.then((final) => notifyEventProcessors(processors, final, hint, index + 1).then(resolve)).then(null, reject);
          } else {
            void notifyEventProcessors(processors, result, hint, index + 1).then(resolve).then(null, reject);
          }
        }
      });
    }
    exports.addGlobalEventProcessor = addGlobalEventProcessor;
    exports.getGlobalEventProcessors = getGlobalEventProcessors;
    exports.notifyEventProcessors = notifyEventProcessors;
  }
});

// ../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/session.js
var require_session = __commonJS({
  "../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/session.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var utils = require_cjs();
    function makeSession(context) {
      const startingTime = utils.timestampInSeconds();
      const session = {
        sid: utils.uuid4(),
        init: true,
        timestamp: startingTime,
        started: startingTime,
        duration: 0,
        status: "ok",
        errors: 0,
        ignoreDuration: false,
        toJSON: () => sessionToJSON(session)
      };
      if (context) {
        updateSession(session, context);
      }
      return session;
    }
    function updateSession(session, context = {}) {
      if (context.user) {
        if (!session.ipAddress && context.user.ip_address) {
          session.ipAddress = context.user.ip_address;
        }
        if (!session.did && !context.did) {
          session.did = context.user.id || context.user.email || context.user.username;
        }
      }
      session.timestamp = context.timestamp || utils.timestampInSeconds();
      if (context.abnormal_mechanism) {
        session.abnormal_mechanism = context.abnormal_mechanism;
      }
      if (context.ignoreDuration) {
        session.ignoreDuration = context.ignoreDuration;
      }
      if (context.sid) {
        session.sid = context.sid.length === 32 ? context.sid : utils.uuid4();
      }
      if (context.init !== void 0) {
        session.init = context.init;
      }
      if (!session.did && context.did) {
        session.did = `${context.did}`;
      }
      if (typeof context.started === "number") {
        session.started = context.started;
      }
      if (session.ignoreDuration) {
        session.duration = void 0;
      } else if (typeof context.duration === "number") {
        session.duration = context.duration;
      } else {
        const duration = session.timestamp - session.started;
        session.duration = duration >= 0 ? duration : 0;
      }
      if (context.release) {
        session.release = context.release;
      }
      if (context.environment) {
        session.environment = context.environment;
      }
      if (!session.ipAddress && context.ipAddress) {
        session.ipAddress = context.ipAddress;
      }
      if (!session.userAgent && context.userAgent) {
        session.userAgent = context.userAgent;
      }
      if (typeof context.errors === "number") {
        session.errors = context.errors;
      }
      if (context.status) {
        session.status = context.status;
      }
    }
    function closeSession(session, status) {
      let context = {};
      if (status) {
        context = { status };
      } else if (session.status === "ok") {
        context = { status: "exited" };
      }
      updateSession(session, context);
    }
    function sessionToJSON(session) {
      return utils.dropUndefinedKeys({
        sid: `${session.sid}`,
        init: session.init,
        // Make sure that sec is converted to ms for date constructor
        started: new Date(session.started * 1e3).toISOString(),
        timestamp: new Date(session.timestamp * 1e3).toISOString(),
        status: session.status,
        errors: session.errors,
        did: typeof session.did === "number" || typeof session.did === "string" ? `${session.did}` : void 0,
        duration: session.duration,
        abnormal_mechanism: session.abnormal_mechanism,
        attrs: {
          release: session.release,
          environment: session.environment,
          ip_address: session.ipAddress,
          user_agent: session.userAgent
        }
      });
    }
    exports.closeSession = closeSession;
    exports.makeSession = makeSession;
    exports.updateSession = updateSession;
  }
});

// ../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/utils/spanUtils.js
var require_spanUtils = __commonJS({
  "../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/utils/spanUtils.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var utils = require_cjs();
    var TRACE_FLAG_NONE = 0;
    var TRACE_FLAG_SAMPLED = 1;
    function spanToTraceContext(span) {
      const { spanId: span_id, traceId: trace_id } = span.spanContext();
      const { data, op, parent_span_id, status, tags, origin } = spanToJSON(span);
      return utils.dropUndefinedKeys({
        data,
        op,
        parent_span_id,
        span_id,
        status,
        tags,
        trace_id,
        origin
      });
    }
    function spanToTraceHeader(span) {
      const { traceId, spanId } = span.spanContext();
      const sampled = spanIsSampled(span);
      return utils.generateSentryTraceHeader(traceId, spanId, sampled);
    }
    function spanTimeInputToSeconds(input) {
      if (typeof input === "number") {
        return ensureTimestampInSeconds(input);
      }
      if (Array.isArray(input)) {
        return input[0] + input[1] / 1e9;
      }
      if (input instanceof Date) {
        return ensureTimestampInSeconds(input.getTime());
      }
      return utils.timestampInSeconds();
    }
    function ensureTimestampInSeconds(timestamp) {
      const isMs = timestamp > 9999999999;
      return isMs ? timestamp / 1e3 : timestamp;
    }
    function spanToJSON(span) {
      if (spanIsSpanClass(span)) {
        return span.getSpanJSON();
      }
      if (typeof span.toJSON === "function") {
        return span.toJSON();
      }
      return {};
    }
    function spanIsSpanClass(span) {
      return typeof span.getSpanJSON === "function";
    }
    function spanIsSampled(span) {
      const { traceFlags } = span.spanContext();
      return Boolean(traceFlags & TRACE_FLAG_SAMPLED);
    }
    exports.TRACE_FLAG_NONE = TRACE_FLAG_NONE;
    exports.TRACE_FLAG_SAMPLED = TRACE_FLAG_SAMPLED;
    exports.spanIsSampled = spanIsSampled;
    exports.spanTimeInputToSeconds = spanTimeInputToSeconds;
    exports.spanToJSON = spanToJSON;
    exports.spanToTraceContext = spanToTraceContext;
    exports.spanToTraceHeader = spanToTraceHeader;
  }
});

// ../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/utils/prepareEvent.js
var require_prepareEvent = __commonJS({
  "../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/utils/prepareEvent.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var utils = require_cjs();
    var constants = require_constants();
    var eventProcessors = require_eventProcessors();
    var scope = require_scope();
    var applyScopeDataToEvent = require_applyScopeDataToEvent();
    var spanUtils = require_spanUtils();
    function prepareEvent(options, event, hint, scope$1, client, isolationScope) {
      const { normalizeDepth = 3, normalizeMaxBreadth = 1e3 } = options;
      const prepared = {
        ...event,
        event_id: event.event_id || hint.event_id || utils.uuid4(),
        timestamp: event.timestamp || utils.dateTimestampInSeconds()
      };
      const integrations = hint.integrations || options.integrations.map((i) => i.name);
      applyClientOptions(prepared, options);
      applyIntegrationsMetadata(prepared, integrations);
      if (event.type === void 0) {
        applyDebugIds(prepared, options.stackParser);
      }
      const finalScope = getFinalScope(scope$1, hint.captureContext);
      if (hint.mechanism) {
        utils.addExceptionMechanism(prepared, hint.mechanism);
      }
      const clientEventProcessors = client && client.getEventProcessors ? client.getEventProcessors() : [];
      const data = scope.getGlobalScope().getScopeData();
      if (isolationScope) {
        const isolationData = isolationScope.getScopeData();
        applyScopeDataToEvent.mergeScopeData(data, isolationData);
      }
      if (finalScope) {
        const finalScopeData = finalScope.getScopeData();
        applyScopeDataToEvent.mergeScopeData(data, finalScopeData);
      }
      const attachments = [...hint.attachments || [], ...data.attachments];
      if (attachments.length) {
        hint.attachments = attachments;
      }
      applyScopeDataToEvent.applyScopeDataToEvent(prepared, data);
      const eventProcessors$1 = [
        ...clientEventProcessors,
        // eslint-disable-next-line deprecation/deprecation
        ...eventProcessors.getGlobalEventProcessors(),
        // Run scope event processors _after_ all other processors
        ...data.eventProcessors
      ];
      const result = eventProcessors.notifyEventProcessors(eventProcessors$1, prepared, hint);
      return result.then((evt) => {
        if (evt) {
          applyDebugMeta(evt);
        }
        if (typeof normalizeDepth === "number" && normalizeDepth > 0) {
          return normalizeEvent(evt, normalizeDepth, normalizeMaxBreadth);
        }
        return evt;
      });
    }
    function applyClientOptions(event, options) {
      const { environment, release, dist, maxValueLength = 250 } = options;
      if (!("environment" in event)) {
        event.environment = "environment" in options ? environment : constants.DEFAULT_ENVIRONMENT;
      }
      if (event.release === void 0 && release !== void 0) {
        event.release = release;
      }
      if (event.dist === void 0 && dist !== void 0) {
        event.dist = dist;
      }
      if (event.message) {
        event.message = utils.truncate(event.message, maxValueLength);
      }
      const exception = event.exception && event.exception.values && event.exception.values[0];
      if (exception && exception.value) {
        exception.value = utils.truncate(exception.value, maxValueLength);
      }
      const request = event.request;
      if (request && request.url) {
        request.url = utils.truncate(request.url, maxValueLength);
      }
    }
    var debugIdStackParserCache = /* @__PURE__ */ new WeakMap();
    function applyDebugIds(event, stackParser) {
      const debugIdMap = utils.GLOBAL_OBJ._sentryDebugIds;
      if (!debugIdMap) {
        return;
      }
      let debugIdStackFramesCache;
      const cachedDebugIdStackFrameCache = debugIdStackParserCache.get(stackParser);
      if (cachedDebugIdStackFrameCache) {
        debugIdStackFramesCache = cachedDebugIdStackFrameCache;
      } else {
        debugIdStackFramesCache = /* @__PURE__ */ new Map();
        debugIdStackParserCache.set(stackParser, debugIdStackFramesCache);
      }
      const filenameDebugIdMap = Object.keys(debugIdMap).reduce((acc, debugIdStackTrace) => {
        let parsedStack;
        const cachedParsedStack = debugIdStackFramesCache.get(debugIdStackTrace);
        if (cachedParsedStack) {
          parsedStack = cachedParsedStack;
        } else {
          parsedStack = stackParser(debugIdStackTrace);
          debugIdStackFramesCache.set(debugIdStackTrace, parsedStack);
        }
        for (let i = parsedStack.length - 1; i >= 0; i--) {
          const stackFrame = parsedStack[i];
          if (stackFrame.filename) {
            acc[stackFrame.filename] = debugIdMap[debugIdStackTrace];
            break;
          }
        }
        return acc;
      }, {});
      try {
        event.exception.values.forEach((exception) => {
          exception.stacktrace.frames.forEach((frame) => {
            if (frame.filename) {
              frame.debug_id = filenameDebugIdMap[frame.filename];
            }
          });
        });
      } catch (e) {
      }
    }
    function applyDebugMeta(event) {
      const filenameDebugIdMap = {};
      try {
        event.exception.values.forEach((exception) => {
          exception.stacktrace.frames.forEach((frame) => {
            if (frame.debug_id) {
              if (frame.abs_path) {
                filenameDebugIdMap[frame.abs_path] = frame.debug_id;
              } else if (frame.filename) {
                filenameDebugIdMap[frame.filename] = frame.debug_id;
              }
              delete frame.debug_id;
            }
          });
        });
      } catch (e) {
      }
      if (Object.keys(filenameDebugIdMap).length === 0) {
        return;
      }
      event.debug_meta = event.debug_meta || {};
      event.debug_meta.images = event.debug_meta.images || [];
      const images = event.debug_meta.images;
      Object.keys(filenameDebugIdMap).forEach((filename) => {
        images.push({
          type: "sourcemap",
          code_file: filename,
          debug_id: filenameDebugIdMap[filename]
        });
      });
    }
    function applyIntegrationsMetadata(event, integrationNames) {
      if (integrationNames.length > 0) {
        event.sdk = event.sdk || {};
        event.sdk.integrations = [...event.sdk.integrations || [], ...integrationNames];
      }
    }
    function normalizeEvent(event, depth, maxBreadth) {
      if (!event) {
        return null;
      }
      const normalized = {
        ...event,
        ...event.breadcrumbs && {
          breadcrumbs: event.breadcrumbs.map((b) => ({
            ...b,
            ...b.data && {
              data: utils.normalize(b.data, depth, maxBreadth)
            }
          }))
        },
        ...event.user && {
          user: utils.normalize(event.user, depth, maxBreadth)
        },
        ...event.contexts && {
          contexts: utils.normalize(event.contexts, depth, maxBreadth)
        },
        ...event.extra && {
          extra: utils.normalize(event.extra, depth, maxBreadth)
        }
      };
      if (event.contexts && event.contexts.trace && normalized.contexts) {
        normalized.contexts.trace = event.contexts.trace;
        if (event.contexts.trace.data) {
          normalized.contexts.trace.data = utils.normalize(event.contexts.trace.data, depth, maxBreadth);
        }
      }
      if (event.spans) {
        normalized.spans = event.spans.map((span) => {
          const data = spanUtils.spanToJSON(span).data;
          if (data) {
            span.data = utils.normalize(data, depth, maxBreadth);
          }
          return span;
        });
      }
      return normalized;
    }
    function getFinalScope(scope$1, captureContext) {
      if (!captureContext) {
        return scope$1;
      }
      const finalScope = scope$1 ? scope$1.clone() : new scope.Scope();
      finalScope.update(captureContext);
      return finalScope;
    }
    function parseEventHintOrCaptureContext(hint) {
      if (!hint) {
        return void 0;
      }
      if (hintIsScopeOrFunction(hint)) {
        return { captureContext: hint };
      }
      if (hintIsScopeContext(hint)) {
        return {
          captureContext: hint
        };
      }
      return hint;
    }
    function hintIsScopeOrFunction(hint) {
      return hint instanceof scope.Scope || typeof hint === "function";
    }
    var captureContextKeys = [
      "user",
      "level",
      "extra",
      "contexts",
      "tags",
      "fingerprint",
      "requestSession",
      "propagationContext"
    ];
    function hintIsScopeContext(hint) {
      return Object.keys(hint).some((key) => captureContextKeys.includes(key));
    }
    exports.applyDebugIds = applyDebugIds;
    exports.applyDebugMeta = applyDebugMeta;
    exports.parseEventHintOrCaptureContext = parseEventHintOrCaptureContext;
    exports.prepareEvent = prepareEvent;
  }
});

// ../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/exports.js
var require_exports = __commonJS({
  "../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/exports.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var utils = require_cjs();
    var constants = require_constants();
    var debugBuild = require_debug_build2();
    var hub = require_hub();
    var session = require_session();
    var prepareEvent = require_prepareEvent();
    function captureException(exception, hint) {
      return hub.getCurrentHub().captureException(exception, prepareEvent.parseEventHintOrCaptureContext(hint));
    }
    function captureMessage(message, captureContext) {
      const level = typeof captureContext === "string" ? captureContext : void 0;
      const context = typeof captureContext !== "string" ? { captureContext } : void 0;
      return hub.getCurrentHub().captureMessage(message, level, context);
    }
    function captureEvent(event, hint) {
      return hub.getCurrentHub().captureEvent(event, hint);
    }
    function configureScope(callback) {
      hub.getCurrentHub().configureScope(callback);
    }
    function addBreadcrumb(breadcrumb, hint) {
      hub.getCurrentHub().addBreadcrumb(breadcrumb, hint);
    }
    function setContext(name, context) {
      hub.getCurrentHub().setContext(name, context);
    }
    function setExtras(extras) {
      hub.getCurrentHub().setExtras(extras);
    }
    function setExtra(key, extra) {
      hub.getCurrentHub().setExtra(key, extra);
    }
    function setTags(tags) {
      hub.getCurrentHub().setTags(tags);
    }
    function setTag(key, value) {
      hub.getCurrentHub().setTag(key, value);
    }
    function setUser(user) {
      hub.getCurrentHub().setUser(user);
    }
    function withScope(...rest) {
      const hub$1 = hub.getCurrentHub();
      if (rest.length === 2) {
        const [scope, callback] = rest;
        if (!scope) {
          return hub$1.withScope(callback);
        }
        return hub$1.withScope(() => {
          hub$1.getStackTop().scope = scope;
          return callback(scope);
        });
      }
      return hub$1.withScope(rest[0]);
    }
    function withIsolationScope(callback) {
      return hub.runWithAsyncContext(() => {
        return callback(hub.getIsolationScope());
      });
    }
    function withActiveSpan(span, callback) {
      return withScope((scope) => {
        scope.setSpan(span);
        return callback(scope);
      });
    }
    function startTransaction(context, customSamplingContext) {
      return hub.getCurrentHub().startTransaction({ ...context }, customSamplingContext);
    }
    function captureCheckIn(checkIn, upsertMonitorConfig) {
      const scope = getCurrentScope();
      const client = getClient();
      if (!client) {
        debugBuild.DEBUG_BUILD && utils.logger.warn("Cannot capture check-in. No client defined.");
      } else if (!client.captureCheckIn) {
        debugBuild.DEBUG_BUILD && utils.logger.warn("Cannot capture check-in. Client does not support sending check-ins.");
      } else {
        return client.captureCheckIn(checkIn, upsertMonitorConfig, scope);
      }
      return utils.uuid4();
    }
    function withMonitor(monitorSlug, callback, upsertMonitorConfig) {
      const checkInId = captureCheckIn({ monitorSlug, status: "in_progress" }, upsertMonitorConfig);
      const now = utils.timestampInSeconds();
      function finishCheckIn(status) {
        captureCheckIn({ monitorSlug, status, checkInId, duration: utils.timestampInSeconds() - now });
      }
      let maybePromiseResult;
      try {
        maybePromiseResult = callback();
      } catch (e) {
        finishCheckIn("error");
        throw e;
      }
      if (utils.isThenable(maybePromiseResult)) {
        Promise.resolve(maybePromiseResult).then(
          () => {
            finishCheckIn("ok");
          },
          () => {
            finishCheckIn("error");
          }
        );
      } else {
        finishCheckIn("ok");
      }
      return maybePromiseResult;
    }
    async function flush(timeout) {
      const client = getClient();
      if (client) {
        return client.flush(timeout);
      }
      debugBuild.DEBUG_BUILD && utils.logger.warn("Cannot flush events. No client defined.");
      return Promise.resolve(false);
    }
    async function close(timeout) {
      const client = getClient();
      if (client) {
        return client.close(timeout);
      }
      debugBuild.DEBUG_BUILD && utils.logger.warn("Cannot flush events and disable SDK. No client defined.");
      return Promise.resolve(false);
    }
    function lastEventId() {
      return hub.getCurrentHub().lastEventId();
    }
    function getClient() {
      return hub.getCurrentHub().getClient();
    }
    function isInitialized() {
      return !!getClient();
    }
    function getCurrentScope() {
      return hub.getCurrentHub().getScope();
    }
    function startSession(context) {
      const client = getClient();
      const isolationScope = hub.getIsolationScope();
      const currentScope = getCurrentScope();
      const { release, environment = constants.DEFAULT_ENVIRONMENT } = client && client.getOptions() || {};
      const { userAgent } = utils.GLOBAL_OBJ.navigator || {};
      const session$1 = session.makeSession({
        release,
        environment,
        user: currentScope.getUser() || isolationScope.getUser(),
        ...userAgent && { userAgent },
        ...context
      });
      const currentSession = isolationScope.getSession();
      if (currentSession && currentSession.status === "ok") {
        session.updateSession(currentSession, { status: "exited" });
      }
      endSession();
      isolationScope.setSession(session$1);
      currentScope.setSession(session$1);
      return session$1;
    }
    function endSession() {
      const isolationScope = hub.getIsolationScope();
      const currentScope = getCurrentScope();
      const session$1 = currentScope.getSession() || isolationScope.getSession();
      if (session$1) {
        session.closeSession(session$1);
      }
      _sendSessionUpdate();
      isolationScope.setSession();
      currentScope.setSession();
    }
    function _sendSessionUpdate() {
      const isolationScope = hub.getIsolationScope();
      const currentScope = getCurrentScope();
      const client = getClient();
      const session2 = currentScope.getSession() || isolationScope.getSession();
      if (session2 && client && client.captureSession) {
        client.captureSession(session2);
      }
    }
    function captureSession(end = false) {
      if (end) {
        endSession();
        return;
      }
      _sendSessionUpdate();
    }
    exports.addBreadcrumb = addBreadcrumb;
    exports.captureCheckIn = captureCheckIn;
    exports.captureEvent = captureEvent;
    exports.captureException = captureException;
    exports.captureMessage = captureMessage;
    exports.captureSession = captureSession;
    exports.close = close;
    exports.configureScope = configureScope;
    exports.endSession = endSession;
    exports.flush = flush;
    exports.getClient = getClient;
    exports.getCurrentScope = getCurrentScope;
    exports.isInitialized = isInitialized;
    exports.lastEventId = lastEventId;
    exports.setContext = setContext;
    exports.setExtra = setExtra;
    exports.setExtras = setExtras;
    exports.setTag = setTag;
    exports.setTags = setTags;
    exports.setUser = setUser;
    exports.startSession = startSession;
    exports.startTransaction = startTransaction;
    exports.withActiveSpan = withActiveSpan;
    exports.withIsolationScope = withIsolationScope;
    exports.withMonitor = withMonitor;
    exports.withScope = withScope;
  }
});

// ../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/utils/getRootSpan.js
var require_getRootSpan = __commonJS({
  "../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/utils/getRootSpan.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    function getRootSpan(span) {
      return span.transaction;
    }
    exports.getRootSpan = getRootSpan;
  }
});

// ../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/tracing/dynamicSamplingContext.js
var require_dynamicSamplingContext = __commonJS({
  "../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/tracing/dynamicSamplingContext.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var utils = require_cjs();
    var constants = require_constants();
    var exports$1 = require_exports();
    var getRootSpan = require_getRootSpan();
    var spanUtils = require_spanUtils();
    function getDynamicSamplingContextFromClient(trace_id, client, scope) {
      const options = client.getOptions();
      const { publicKey: public_key } = client.getDsn() || {};
      const { segment: user_segment } = scope && scope.getUser() || {};
      const dsc = utils.dropUndefinedKeys({
        environment: options.environment || constants.DEFAULT_ENVIRONMENT,
        release: options.release,
        user_segment,
        public_key,
        trace_id
      });
      client.emit && client.emit("createDsc", dsc);
      return dsc;
    }
    function getDynamicSamplingContextFromSpan(span) {
      const client = exports$1.getClient();
      if (!client) {
        return {};
      }
      const dsc = getDynamicSamplingContextFromClient(spanUtils.spanToJSON(span).trace_id || "", client, exports$1.getCurrentScope());
      const txn = getRootSpan.getRootSpan(span);
      if (!txn) {
        return dsc;
      }
      const v7FrozenDsc = txn && txn._frozenDynamicSamplingContext;
      if (v7FrozenDsc) {
        return v7FrozenDsc;
      }
      const { sampleRate: maybeSampleRate, source } = txn.metadata;
      if (maybeSampleRate != null) {
        dsc.sample_rate = `${maybeSampleRate}`;
      }
      const jsonSpan = spanUtils.spanToJSON(txn);
      if (source && source !== "url") {
        dsc.transaction = jsonSpan.description;
      }
      dsc.sampled = String(spanUtils.spanIsSampled(txn));
      client.emit && client.emit("createDsc", dsc);
      return dsc;
    }
    exports.getDynamicSamplingContextFromClient = getDynamicSamplingContextFromClient;
    exports.getDynamicSamplingContextFromSpan = getDynamicSamplingContextFromSpan;
  }
});

// ../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/utils/applyScopeDataToEvent.js
var require_applyScopeDataToEvent = __commonJS({
  "../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/utils/applyScopeDataToEvent.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var utils = require_cjs();
    var dynamicSamplingContext = require_dynamicSamplingContext();
    var getRootSpan = require_getRootSpan();
    var spanUtils = require_spanUtils();
    function applyScopeDataToEvent(event, data) {
      const { fingerprint, span, breadcrumbs, sdkProcessingMetadata } = data;
      applyDataToEvent(event, data);
      if (span) {
        applySpanToEvent(event, span);
      }
      applyFingerprintToEvent(event, fingerprint);
      applyBreadcrumbsToEvent(event, breadcrumbs);
      applySdkMetadataToEvent(event, sdkProcessingMetadata);
    }
    function mergeScopeData(data, mergeData) {
      const {
        extra,
        tags,
        user,
        contexts,
        level,
        sdkProcessingMetadata,
        breadcrumbs,
        fingerprint,
        eventProcessors,
        attachments,
        propagationContext,
        // eslint-disable-next-line deprecation/deprecation
        transactionName,
        span
      } = mergeData;
      mergeAndOverwriteScopeData(data, "extra", extra);
      mergeAndOverwriteScopeData(data, "tags", tags);
      mergeAndOverwriteScopeData(data, "user", user);
      mergeAndOverwriteScopeData(data, "contexts", contexts);
      mergeAndOverwriteScopeData(data, "sdkProcessingMetadata", sdkProcessingMetadata);
      if (level) {
        data.level = level;
      }
      if (transactionName) {
        data.transactionName = transactionName;
      }
      if (span) {
        data.span = span;
      }
      if (breadcrumbs.length) {
        data.breadcrumbs = [...data.breadcrumbs, ...breadcrumbs];
      }
      if (fingerprint.length) {
        data.fingerprint = [...data.fingerprint, ...fingerprint];
      }
      if (eventProcessors.length) {
        data.eventProcessors = [...data.eventProcessors, ...eventProcessors];
      }
      if (attachments.length) {
        data.attachments = [...data.attachments, ...attachments];
      }
      data.propagationContext = { ...data.propagationContext, ...propagationContext };
    }
    function mergeAndOverwriteScopeData(data, prop, mergeVal) {
      if (mergeVal && Object.keys(mergeVal).length) {
        data[prop] = { ...data[prop] };
        for (const key in mergeVal) {
          if (Object.prototype.hasOwnProperty.call(mergeVal, key)) {
            data[prop][key] = mergeVal[key];
          }
        }
      }
    }
    function applyDataToEvent(event, data) {
      const {
        extra,
        tags,
        user,
        contexts,
        level,
        // eslint-disable-next-line deprecation/deprecation
        transactionName
      } = data;
      const cleanedExtra = utils.dropUndefinedKeys(extra);
      if (cleanedExtra && Object.keys(cleanedExtra).length) {
        event.extra = { ...cleanedExtra, ...event.extra };
      }
      const cleanedTags = utils.dropUndefinedKeys(tags);
      if (cleanedTags && Object.keys(cleanedTags).length) {
        event.tags = { ...cleanedTags, ...event.tags };
      }
      const cleanedUser = utils.dropUndefinedKeys(user);
      if (cleanedUser && Object.keys(cleanedUser).length) {
        event.user = { ...cleanedUser, ...event.user };
      }
      const cleanedContexts = utils.dropUndefinedKeys(contexts);
      if (cleanedContexts && Object.keys(cleanedContexts).length) {
        event.contexts = { ...cleanedContexts, ...event.contexts };
      }
      if (level) {
        event.level = level;
      }
      if (transactionName) {
        event.transaction = transactionName;
      }
    }
    function applyBreadcrumbsToEvent(event, breadcrumbs) {
      const mergedBreadcrumbs = [...event.breadcrumbs || [], ...breadcrumbs];
      event.breadcrumbs = mergedBreadcrumbs.length ? mergedBreadcrumbs : void 0;
    }
    function applySdkMetadataToEvent(event, sdkProcessingMetadata) {
      event.sdkProcessingMetadata = {
        ...event.sdkProcessingMetadata,
        ...sdkProcessingMetadata
      };
    }
    function applySpanToEvent(event, span) {
      event.contexts = { trace: spanUtils.spanToTraceContext(span), ...event.contexts };
      const rootSpan = getRootSpan.getRootSpan(span);
      if (rootSpan) {
        event.sdkProcessingMetadata = {
          dynamicSamplingContext: dynamicSamplingContext.getDynamicSamplingContextFromSpan(span),
          ...event.sdkProcessingMetadata
        };
        const transactionName = spanUtils.spanToJSON(rootSpan).description;
        if (transactionName) {
          event.tags = { transaction: transactionName, ...event.tags };
        }
      }
    }
    function applyFingerprintToEvent(event, fingerprint) {
      event.fingerprint = event.fingerprint ? utils.arrayify(event.fingerprint) : [];
      if (fingerprint) {
        event.fingerprint = event.fingerprint.concat(fingerprint);
      }
      if (event.fingerprint && !event.fingerprint.length) {
        delete event.fingerprint;
      }
    }
    exports.applyScopeDataToEvent = applyScopeDataToEvent;
    exports.mergeAndOverwriteScopeData = mergeAndOverwriteScopeData;
    exports.mergeScopeData = mergeScopeData;
  }
});

// ../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/scope.js
var require_scope = __commonJS({
  "../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/scope.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var utils = require_cjs();
    var eventProcessors = require_eventProcessors();
    var session = require_session();
    var applyScopeDataToEvent = require_applyScopeDataToEvent();
    var DEFAULT_MAX_BREADCRUMBS = 100;
    var globalScope;
    var Scope = class _Scope {
      /** Flag if notifying is happening. */
      /** Callback for client to receive scope changes. */
      /** Callback list that will be called after {@link applyToEvent}. */
      /** Array of breadcrumbs. */
      /** User */
      /** Tags */
      /** Extra */
      /** Contexts */
      /** Attachments */
      /** Propagation Context for distributed tracing */
      /**
       * A place to stash data which is needed at some point in the SDK's event processing pipeline but which shouldn't get
       * sent to Sentry
       */
      /** Fingerprint */
      /** Severity */
      // eslint-disable-next-line deprecation/deprecation
      /**
       * Transaction Name
       */
      /** Span */
      /** Session */
      /** Request Mode Session Status */
      /** The client on this scope */
      // NOTE: Any field which gets added here should get added not only to the constructor but also to the `clone` method.
      constructor() {
        this._notifyingListeners = false;
        this._scopeListeners = [];
        this._eventProcessors = [];
        this._breadcrumbs = [];
        this._attachments = [];
        this._user = {};
        this._tags = {};
        this._extra = {};
        this._contexts = {};
        this._sdkProcessingMetadata = {};
        this._propagationContext = generatePropagationContext();
      }
      /**
       * Inherit values from the parent scope.
       * @deprecated Use `scope.clone()` and `new Scope()` instead.
       */
      static clone(scope) {
        return scope ? scope.clone() : new _Scope();
      }
      /**
       * Clone this scope instance.
       */
      clone() {
        const newScope = new _Scope();
        newScope._breadcrumbs = [...this._breadcrumbs];
        newScope._tags = { ...this._tags };
        newScope._extra = { ...this._extra };
        newScope._contexts = { ...this._contexts };
        newScope._user = this._user;
        newScope._level = this._level;
        newScope._span = this._span;
        newScope._session = this._session;
        newScope._transactionName = this._transactionName;
        newScope._fingerprint = this._fingerprint;
        newScope._eventProcessors = [...this._eventProcessors];
        newScope._requestSession = this._requestSession;
        newScope._attachments = [...this._attachments];
        newScope._sdkProcessingMetadata = { ...this._sdkProcessingMetadata };
        newScope._propagationContext = { ...this._propagationContext };
        newScope._client = this._client;
        return newScope;
      }
      /** Update the client on the scope. */
      setClient(client) {
        this._client = client;
      }
      /**
       * Get the client assigned to this scope.
       *
       * It is generally recommended to use the global function `Sentry.getClient()` instead, unless you know what you are doing.
       */
      getClient() {
        return this._client;
      }
      /**
       * Add internal on change listener. Used for sub SDKs that need to store the scope.
       * @hidden
       */
      addScopeListener(callback) {
        this._scopeListeners.push(callback);
      }
      /**
       * @inheritDoc
       */
      addEventProcessor(callback) {
        this._eventProcessors.push(callback);
        return this;
      }
      /**
       * @inheritDoc
       */
      setUser(user) {
        this._user = user || {
          email: void 0,
          id: void 0,
          ip_address: void 0,
          segment: void 0,
          username: void 0
        };
        if (this._session) {
          session.updateSession(this._session, { user });
        }
        this._notifyScopeListeners();
        return this;
      }
      /**
       * @inheritDoc
       */
      getUser() {
        return this._user;
      }
      /**
       * @inheritDoc
       */
      getRequestSession() {
        return this._requestSession;
      }
      /**
       * @inheritDoc
       */
      setRequestSession(requestSession) {
        this._requestSession = requestSession;
        return this;
      }
      /**
       * @inheritDoc
       */
      setTags(tags) {
        this._tags = {
          ...this._tags,
          ...tags
        };
        this._notifyScopeListeners();
        return this;
      }
      /**
       * @inheritDoc
       */
      setTag(key, value) {
        this._tags = { ...this._tags, [key]: value };
        this._notifyScopeListeners();
        return this;
      }
      /**
       * @inheritDoc
       */
      setExtras(extras) {
        this._extra = {
          ...this._extra,
          ...extras
        };
        this._notifyScopeListeners();
        return this;
      }
      /**
       * @inheritDoc
       */
      setExtra(key, extra) {
        this._extra = { ...this._extra, [key]: extra };
        this._notifyScopeListeners();
        return this;
      }
      /**
       * @inheritDoc
       */
      setFingerprint(fingerprint) {
        this._fingerprint = fingerprint;
        this._notifyScopeListeners();
        return this;
      }
      /**
       * @inheritDoc
       */
      setLevel(level) {
        this._level = level;
        this._notifyScopeListeners();
        return this;
      }
      /**
       * Sets the transaction name on the scope for future events.
       */
      setTransactionName(name) {
        this._transactionName = name;
        this._notifyScopeListeners();
        return this;
      }
      /**
       * @inheritDoc
       */
      setContext(key, context) {
        if (context === null) {
          delete this._contexts[key];
        } else {
          this._contexts[key] = context;
        }
        this._notifyScopeListeners();
        return this;
      }
      /**
       * Sets the Span on the scope.
       * @param span Span
       * @deprecated Instead of setting a span on a scope, use `startSpan()`/`startSpanManual()` instead.
       */
      setSpan(span) {
        this._span = span;
        this._notifyScopeListeners();
        return this;
      }
      /**
       * Returns the `Span` if there is one.
       * @deprecated Use `getActiveSpan()` instead.
       */
      getSpan() {
        return this._span;
      }
      /**
       * Returns the `Transaction` attached to the scope (if there is one).
       * @deprecated You should not rely on the transaction, but just use `startSpan()` APIs instead.
       */
      getTransaction() {
        const span = this._span;
        return span && span.transaction;
      }
      /**
       * @inheritDoc
       */
      setSession(session2) {
        if (!session2) {
          delete this._session;
        } else {
          this._session = session2;
        }
        this._notifyScopeListeners();
        return this;
      }
      /**
       * @inheritDoc
       */
      getSession() {
        return this._session;
      }
      /**
       * @inheritDoc
       */
      update(captureContext) {
        if (!captureContext) {
          return this;
        }
        const scopeToMerge = typeof captureContext === "function" ? captureContext(this) : captureContext;
        if (scopeToMerge instanceof _Scope) {
          const scopeData = scopeToMerge.getScopeData();
          this._tags = { ...this._tags, ...scopeData.tags };
          this._extra = { ...this._extra, ...scopeData.extra };
          this._contexts = { ...this._contexts, ...scopeData.contexts };
          if (scopeData.user && Object.keys(scopeData.user).length) {
            this._user = scopeData.user;
          }
          if (scopeData.level) {
            this._level = scopeData.level;
          }
          if (scopeData.fingerprint.length) {
            this._fingerprint = scopeData.fingerprint;
          }
          if (scopeToMerge.getRequestSession()) {
            this._requestSession = scopeToMerge.getRequestSession();
          }
          if (scopeData.propagationContext) {
            this._propagationContext = scopeData.propagationContext;
          }
        } else if (utils.isPlainObject(scopeToMerge)) {
          const scopeContext = captureContext;
          this._tags = { ...this._tags, ...scopeContext.tags };
          this._extra = { ...this._extra, ...scopeContext.extra };
          this._contexts = { ...this._contexts, ...scopeContext.contexts };
          if (scopeContext.user) {
            this._user = scopeContext.user;
          }
          if (scopeContext.level) {
            this._level = scopeContext.level;
          }
          if (scopeContext.fingerprint) {
            this._fingerprint = scopeContext.fingerprint;
          }
          if (scopeContext.requestSession) {
            this._requestSession = scopeContext.requestSession;
          }
          if (scopeContext.propagationContext) {
            this._propagationContext = scopeContext.propagationContext;
          }
        }
        return this;
      }
      /**
       * @inheritDoc
       */
      clear() {
        this._breadcrumbs = [];
        this._tags = {};
        this._extra = {};
        this._user = {};
        this._contexts = {};
        this._level = void 0;
        this._transactionName = void 0;
        this._fingerprint = void 0;
        this._requestSession = void 0;
        this._span = void 0;
        this._session = void 0;
        this._notifyScopeListeners();
        this._attachments = [];
        this._propagationContext = generatePropagationContext();
        return this;
      }
      /**
       * @inheritDoc
       */
      addBreadcrumb(breadcrumb, maxBreadcrumbs) {
        const maxCrumbs = typeof maxBreadcrumbs === "number" ? maxBreadcrumbs : DEFAULT_MAX_BREADCRUMBS;
        if (maxCrumbs <= 0) {
          return this;
        }
        const mergedBreadcrumb = {
          timestamp: utils.dateTimestampInSeconds(),
          ...breadcrumb
        };
        const breadcrumbs = this._breadcrumbs;
        breadcrumbs.push(mergedBreadcrumb);
        this._breadcrumbs = breadcrumbs.length > maxCrumbs ? breadcrumbs.slice(-maxCrumbs) : breadcrumbs;
        this._notifyScopeListeners();
        return this;
      }
      /**
       * @inheritDoc
       */
      getLastBreadcrumb() {
        return this._breadcrumbs[this._breadcrumbs.length - 1];
      }
      /**
       * @inheritDoc
       */
      clearBreadcrumbs() {
        this._breadcrumbs = [];
        this._notifyScopeListeners();
        return this;
      }
      /**
       * @inheritDoc
       */
      addAttachment(attachment) {
        this._attachments.push(attachment);
        return this;
      }
      /**
       * @inheritDoc
       * @deprecated Use `getScopeData()` instead.
       */
      getAttachments() {
        const data = this.getScopeData();
        return data.attachments;
      }
      /**
       * @inheritDoc
       */
      clearAttachments() {
        this._attachments = [];
        return this;
      }
      /** @inheritDoc */
      getScopeData() {
        const {
          _breadcrumbs,
          _attachments,
          _contexts,
          _tags,
          _extra,
          _user,
          _level,
          _fingerprint,
          _eventProcessors,
          _propagationContext,
          _sdkProcessingMetadata,
          _transactionName,
          _span
        } = this;
        return {
          breadcrumbs: _breadcrumbs,
          attachments: _attachments,
          contexts: _contexts,
          tags: _tags,
          extra: _extra,
          user: _user,
          level: _level,
          fingerprint: _fingerprint || [],
          eventProcessors: _eventProcessors,
          propagationContext: _propagationContext,
          sdkProcessingMetadata: _sdkProcessingMetadata,
          transactionName: _transactionName,
          span: _span
        };
      }
      /**
       * Applies data from the scope to the event and runs all event processors on it.
       *
       * @param event Event
       * @param hint Object containing additional information about the original exception, for use by the event processors.
       * @hidden
       * @deprecated Use `applyScopeDataToEvent()` directly
       */
      applyToEvent(event, hint = {}, additionalEventProcessors = []) {
        applyScopeDataToEvent.applyScopeDataToEvent(event, this.getScopeData());
        const eventProcessors$1 = [
          ...additionalEventProcessors,
          // eslint-disable-next-line deprecation/deprecation
          ...eventProcessors.getGlobalEventProcessors(),
          ...this._eventProcessors
        ];
        return eventProcessors.notifyEventProcessors(eventProcessors$1, event, hint);
      }
      /**
       * Add data which will be accessible during event processing but won't get sent to Sentry
       */
      setSDKProcessingMetadata(newData) {
        this._sdkProcessingMetadata = { ...this._sdkProcessingMetadata, ...newData };
        return this;
      }
      /**
       * @inheritDoc
       */
      setPropagationContext(context) {
        this._propagationContext = context;
        return this;
      }
      /**
       * @inheritDoc
       */
      getPropagationContext() {
        return this._propagationContext;
      }
      /**
       * Capture an exception for this scope.
       *
       * @param exception The exception to capture.
       * @param hint Optinal additional data to attach to the Sentry event.
       * @returns the id of the captured Sentry event.
       */
      captureException(exception, hint) {
        const eventId = hint && hint.event_id ? hint.event_id : utils.uuid4();
        if (!this._client) {
          utils.logger.warn("No client configured on scope - will not capture exception!");
          return eventId;
        }
        const syntheticException = new Error("Sentry syntheticException");
        this._client.captureException(
          exception,
          {
            originalException: exception,
            syntheticException,
            ...hint,
            event_id: eventId
          },
          this
        );
        return eventId;
      }
      /**
       * Capture a message for this scope.
       *
       * @param message The message to capture.
       * @param level An optional severity level to report the message with.
       * @param hint Optional additional data to attach to the Sentry event.
       * @returns the id of the captured message.
       */
      captureMessage(message, level, hint) {
        const eventId = hint && hint.event_id ? hint.event_id : utils.uuid4();
        if (!this._client) {
          utils.logger.warn("No client configured on scope - will not capture message!");
          return eventId;
        }
        const syntheticException = new Error(message);
        this._client.captureMessage(
          message,
          level,
          {
            originalException: message,
            syntheticException,
            ...hint,
            event_id: eventId
          },
          this
        );
        return eventId;
      }
      /**
       * Captures a manually created event for this scope and sends it to Sentry.
       *
       * @param exception The event to capture.
       * @param hint Optional additional data to attach to the Sentry event.
       * @returns the id of the captured event.
       */
      captureEvent(event, hint) {
        const eventId = hint && hint.event_id ? hint.event_id : utils.uuid4();
        if (!this._client) {
          utils.logger.warn("No client configured on scope - will not capture event!");
          return eventId;
        }
        this._client.captureEvent(event, { ...hint, event_id: eventId }, this);
        return eventId;
      }
      /**
       * This will be called on every set call.
       */
      _notifyScopeListeners() {
        if (!this._notifyingListeners) {
          this._notifyingListeners = true;
          this._scopeListeners.forEach((callback) => {
            callback(this);
          });
          this._notifyingListeners = false;
        }
      }
    };
    function getGlobalScope() {
      if (!globalScope) {
        globalScope = new Scope();
      }
      return globalScope;
    }
    function setGlobalScope(scope) {
      globalScope = scope;
    }
    function generatePropagationContext() {
      return {
        traceId: utils.uuid4(),
        spanId: utils.uuid4().substring(16)
      };
    }
    exports.Scope = Scope;
    exports.getGlobalScope = getGlobalScope;
    exports.setGlobalScope = setGlobalScope;
  }
});

// ../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/version.js
var require_version = __commonJS({
  "../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/version.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var SDK_VERSION = "7.120.1";
    exports.SDK_VERSION = SDK_VERSION;
  }
});

// ../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/hub.js
var require_hub = __commonJS({
  "../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/hub.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var utils = require_cjs();
    var constants = require_constants();
    var debugBuild = require_debug_build2();
    var scope = require_scope();
    var session = require_session();
    var version = require_version();
    var API_VERSION = parseFloat(version.SDK_VERSION);
    var DEFAULT_BREADCRUMBS = 100;
    var Hub = class {
      /** Is a {@link Layer}[] containing the client and scope */
      /** Contains the last event id of a captured event.  */
      /**
       * Creates a new instance of the hub, will push one {@link Layer} into the
       * internal stack on creation.
       *
       * @param client bound to the hub.
       * @param scope bound to the hub.
       * @param version number, higher number means higher priority.
       *
       * @deprecated Instantiation of Hub objects is deprecated and the constructor will be removed in version 8 of the SDK.
       *
       * If you are currently using the Hub for multi-client use like so:
       *
       * ```
       * // OLD
       * const hub = new Hub();
       * hub.bindClient(client);
       * makeMain(hub)
       * ```
       *
       * instead initialize the client as follows:
       *
       * ```
       * // NEW
       * Sentry.withIsolationScope(() => {
       *    Sentry.setCurrentClient(client);
       *    client.init();
       * });
       * ```
       *
       * If you are using the Hub to capture events like so:
       *
       * ```
       * // OLD
       * const client = new Client();
       * const hub = new Hub(client);
       * hub.captureException()
       * ```
       *
       * instead capture isolated events as follows:
       *
       * ```
       * // NEW
       * const client = new Client();
       * const scope = new Scope();
       * scope.setClient(client);
       * scope.captureException();
       * ```
       */
      constructor(client, scope$1, isolationScope, _version = API_VERSION) {
        this._version = _version;
        let assignedScope;
        if (!scope$1) {
          assignedScope = new scope.Scope();
          assignedScope.setClient(client);
        } else {
          assignedScope = scope$1;
        }
        let assignedIsolationScope;
        if (!isolationScope) {
          assignedIsolationScope = new scope.Scope();
          assignedIsolationScope.setClient(client);
        } else {
          assignedIsolationScope = isolationScope;
        }
        this._stack = [{ scope: assignedScope }];
        if (client) {
          this.bindClient(client);
        }
        this._isolationScope = assignedIsolationScope;
      }
      /**
       * Checks if this hub's version is older than the given version.
       *
       * @param version A version number to compare to.
       * @return True if the given version is newer; otherwise false.
       *
       * @deprecated This will be removed in v8.
       */
      isOlderThan(version2) {
        return this._version < version2;
      }
      /**
       * This binds the given client to the current scope.
       * @param client An SDK client (client) instance.
       *
       * @deprecated Use `initAndBind()` directly, or `setCurrentClient()` and/or `client.init()` instead.
       */
      bindClient(client) {
        const top = this.getStackTop();
        top.client = client;
        top.scope.setClient(client);
        if (client && client.setupIntegrations) {
          client.setupIntegrations();
        }
      }
      /**
       * @inheritDoc
       *
       * @deprecated Use `withScope` instead.
       */
      pushScope() {
        const scope2 = this.getScope().clone();
        this.getStack().push({
          // eslint-disable-next-line deprecation/deprecation
          client: this.getClient(),
          scope: scope2
        });
        return scope2;
      }
      /**
       * @inheritDoc
       *
       * @deprecated Use `withScope` instead.
       */
      popScope() {
        if (this.getStack().length <= 1)
          return false;
        return !!this.getStack().pop();
      }
      /**
       * @inheritDoc
       *
       * @deprecated Use `Sentry.withScope()` instead.
       */
      withScope(callback) {
        const scope2 = this.pushScope();
        let maybePromiseResult;
        try {
          maybePromiseResult = callback(scope2);
        } catch (e) {
          this.popScope();
          throw e;
        }
        if (utils.isThenable(maybePromiseResult)) {
          return maybePromiseResult.then(
            (res) => {
              this.popScope();
              return res;
            },
            (e) => {
              this.popScope();
              throw e;
            }
          );
        }
        this.popScope();
        return maybePromiseResult;
      }
      /**
       * @inheritDoc
       *
       * @deprecated Use `Sentry.getClient()` instead.
       */
      getClient() {
        return this.getStackTop().client;
      }
      /**
       * Returns the scope of the top stack.
       *
       * @deprecated Use `Sentry.getCurrentScope()` instead.
       */
      getScope() {
        return this.getStackTop().scope;
      }
      /**
       * @deprecated Use `Sentry.getIsolationScope()` instead.
       */
      getIsolationScope() {
        return this._isolationScope;
      }
      /**
       * Returns the scope stack for domains or the process.
       * @deprecated This will be removed in v8.
       */
      getStack() {
        return this._stack;
      }
      /**
       * Returns the topmost scope layer in the order domain > local > process.
       * @deprecated This will be removed in v8.
       */
      getStackTop() {
        return this._stack[this._stack.length - 1];
      }
      /**
       * @inheritDoc
       *
       * @deprecated Use `Sentry.captureException()` instead.
       */
      captureException(exception, hint) {
        const eventId = this._lastEventId = hint && hint.event_id ? hint.event_id : utils.uuid4();
        const syntheticException = new Error("Sentry syntheticException");
        this.getScope().captureException(exception, {
          originalException: exception,
          syntheticException,
          ...hint,
          event_id: eventId
        });
        return eventId;
      }
      /**
       * @inheritDoc
       *
       * @deprecated Use  `Sentry.captureMessage()` instead.
       */
      captureMessage(message, level, hint) {
        const eventId = this._lastEventId = hint && hint.event_id ? hint.event_id : utils.uuid4();
        const syntheticException = new Error(message);
        this.getScope().captureMessage(message, level, {
          originalException: message,
          syntheticException,
          ...hint,
          event_id: eventId
        });
        return eventId;
      }
      /**
       * @inheritDoc
       *
       * @deprecated Use `Sentry.captureEvent()` instead.
       */
      captureEvent(event, hint) {
        const eventId = hint && hint.event_id ? hint.event_id : utils.uuid4();
        if (!event.type) {
          this._lastEventId = eventId;
        }
        this.getScope().captureEvent(event, { ...hint, event_id: eventId });
        return eventId;
      }
      /**
       * @inheritDoc
       *
       * @deprecated This will be removed in v8.
       */
      lastEventId() {
        return this._lastEventId;
      }
      /**
       * @inheritDoc
       *
       * @deprecated Use `Sentry.addBreadcrumb()` instead.
       */
      addBreadcrumb(breadcrumb, hint) {
        const { scope: scope2, client } = this.getStackTop();
        if (!client)
          return;
        const { beforeBreadcrumb = null, maxBreadcrumbs = DEFAULT_BREADCRUMBS } = client.getOptions && client.getOptions() || {};
        if (maxBreadcrumbs <= 0)
          return;
        const timestamp = utils.dateTimestampInSeconds();
        const mergedBreadcrumb = { timestamp, ...breadcrumb };
        const finalBreadcrumb = beforeBreadcrumb ? utils.consoleSandbox(() => beforeBreadcrumb(mergedBreadcrumb, hint)) : mergedBreadcrumb;
        if (finalBreadcrumb === null)
          return;
        if (client.emit) {
          client.emit("beforeAddBreadcrumb", finalBreadcrumb, hint);
        }
        scope2.addBreadcrumb(finalBreadcrumb, maxBreadcrumbs);
      }
      /**
       * @inheritDoc
       * @deprecated Use `Sentry.setUser()` instead.
       */
      setUser(user) {
        this.getScope().setUser(user);
        this.getIsolationScope().setUser(user);
      }
      /**
       * @inheritDoc
       * @deprecated Use `Sentry.setTags()` instead.
       */
      setTags(tags) {
        this.getScope().setTags(tags);
        this.getIsolationScope().setTags(tags);
      }
      /**
       * @inheritDoc
       * @deprecated Use `Sentry.setExtras()` instead.
       */
      setExtras(extras) {
        this.getScope().setExtras(extras);
        this.getIsolationScope().setExtras(extras);
      }
      /**
       * @inheritDoc
       * @deprecated Use `Sentry.setTag()` instead.
       */
      setTag(key, value) {
        this.getScope().setTag(key, value);
        this.getIsolationScope().setTag(key, value);
      }
      /**
       * @inheritDoc
       * @deprecated Use `Sentry.setExtra()` instead.
       */
      setExtra(key, extra) {
        this.getScope().setExtra(key, extra);
        this.getIsolationScope().setExtra(key, extra);
      }
      /**
       * @inheritDoc
       * @deprecated Use `Sentry.setContext()` instead.
       */
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setContext(name, context) {
        this.getScope().setContext(name, context);
        this.getIsolationScope().setContext(name, context);
      }
      /**
       * @inheritDoc
       *
       * @deprecated Use `getScope()` directly.
       */
      configureScope(callback) {
        const { scope: scope2, client } = this.getStackTop();
        if (client) {
          callback(scope2);
        }
      }
      /**
       * @inheritDoc
       */
      // eslint-disable-next-line deprecation/deprecation
      run(callback) {
        const oldHub = makeMain(this);
        try {
          callback(this);
        } finally {
          makeMain(oldHub);
        }
      }
      /**
       * @inheritDoc
       * @deprecated Use `Sentry.getClient().getIntegrationByName()` instead.
       */
      getIntegration(integration) {
        const client = this.getClient();
        if (!client)
          return null;
        try {
          return client.getIntegration(integration);
        } catch (_oO) {
          debugBuild.DEBUG_BUILD && utils.logger.warn(`Cannot retrieve integration ${integration.id} from the current Hub`);
          return null;
        }
      }
      /**
       * Starts a new `Transaction` and returns it. This is the entry point to manual tracing instrumentation.
       *
       * A tree structure can be built by adding child spans to the transaction, and child spans to other spans. To start a
       * new child span within the transaction or any span, call the respective `.startChild()` method.
       *
       * Every child span must be finished before the transaction is finished, otherwise the unfinished spans are discarded.
       *
       * The transaction must be finished with a call to its `.end()` method, at which point the transaction with all its
       * finished child spans will be sent to Sentry.
       *
       * @param context Properties of the new `Transaction`.
       * @param customSamplingContext Information given to the transaction sampling function (along with context-dependent
       * default values). See {@link Options.tracesSampler}.
       *
       * @returns The transaction which was just started
       *
       * @deprecated Use `startSpan()`, `startSpanManual()` or `startInactiveSpan()` instead.
       */
      startTransaction(context, customSamplingContext) {
        const result = this._callExtensionMethod("startTransaction", context, customSamplingContext);
        if (debugBuild.DEBUG_BUILD && !result) {
          const client = this.getClient();
          if (!client) {
            utils.logger.warn(
              "Tracing extension 'startTransaction' is missing. You should 'init' the SDK before calling 'startTransaction'"
            );
          } else {
            utils.logger.warn(`Tracing extension 'startTransaction' has not been added. Call 'addTracingExtensions' before calling 'init':
Sentry.addTracingExtensions();
Sentry.init({...});
`);
          }
        }
        return result;
      }
      /**
       * @inheritDoc
       * @deprecated Use `spanToTraceHeader()` instead.
       */
      traceHeaders() {
        return this._callExtensionMethod("traceHeaders");
      }
      /**
       * @inheritDoc
       *
       * @deprecated Use top level `captureSession` instead.
       */
      captureSession(endSession = false) {
        if (endSession) {
          return this.endSession();
        }
        this._sendSessionUpdate();
      }
      /**
       * @inheritDoc
       * @deprecated Use top level `endSession` instead.
       */
      endSession() {
        const layer = this.getStackTop();
        const scope2 = layer.scope;
        const session$1 = scope2.getSession();
        if (session$1) {
          session.closeSession(session$1);
        }
        this._sendSessionUpdate();
        scope2.setSession();
      }
      /**
       * @inheritDoc
       * @deprecated Use top level `startSession` instead.
       */
      startSession(context) {
        const { scope: scope2, client } = this.getStackTop();
        const { release, environment = constants.DEFAULT_ENVIRONMENT } = client && client.getOptions() || {};
        const { userAgent } = utils.GLOBAL_OBJ.navigator || {};
        const session$1 = session.makeSession({
          release,
          environment,
          user: scope2.getUser(),
          ...userAgent && { userAgent },
          ...context
        });
        const currentSession = scope2.getSession && scope2.getSession();
        if (currentSession && currentSession.status === "ok") {
          session.updateSession(currentSession, { status: "exited" });
        }
        this.endSession();
        scope2.setSession(session$1);
        return session$1;
      }
      /**
       * Returns if default PII should be sent to Sentry and propagated in ourgoing requests
       * when Tracing is used.
       *
       * @deprecated Use top-level `getClient().getOptions().sendDefaultPii` instead. This function
       * only unnecessarily increased API surface but only wrapped accessing the option.
       */
      shouldSendDefaultPii() {
        const client = this.getClient();
        const options = client && client.getOptions();
        return Boolean(options && options.sendDefaultPii);
      }
      /**
       * Sends the current Session on the scope
       */
      _sendSessionUpdate() {
        const { scope: scope2, client } = this.getStackTop();
        const session2 = scope2.getSession();
        if (session2 && client && client.captureSession) {
          client.captureSession(session2);
        }
      }
      /**
       * Calls global extension method and binding current instance to the function call
       */
      // @ts-expect-error Function lacks ending return statement and return type does not include 'undefined'. ts(2366)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      _callExtensionMethod(method, ...args) {
        const carrier = getMainCarrier();
        const sentry = carrier.__SENTRY__;
        if (sentry && sentry.extensions && typeof sentry.extensions[method] === "function") {
          return sentry.extensions[method].apply(this, args);
        }
        debugBuild.DEBUG_BUILD && utils.logger.warn(`Extension method ${method} couldn't be found, doing nothing.`);
      }
    };
    function getMainCarrier() {
      utils.GLOBAL_OBJ.__SENTRY__ = utils.GLOBAL_OBJ.__SENTRY__ || {
        extensions: {},
        hub: void 0
      };
      return utils.GLOBAL_OBJ;
    }
    function makeMain(hub) {
      const registry = getMainCarrier();
      const oldHub = getHubFromCarrier(registry);
      setHubOnCarrier(registry, hub);
      return oldHub;
    }
    function getCurrentHub() {
      const registry = getMainCarrier();
      if (registry.__SENTRY__ && registry.__SENTRY__.acs) {
        const hub = registry.__SENTRY__.acs.getCurrentHub();
        if (hub) {
          return hub;
        }
      }
      return getGlobalHub(registry);
    }
    function getIsolationScope() {
      return getCurrentHub().getIsolationScope();
    }
    function getGlobalHub(registry = getMainCarrier()) {
      if (!hasHubOnCarrier(registry) || // eslint-disable-next-line deprecation/deprecation
      getHubFromCarrier(registry).isOlderThan(API_VERSION)) {
        setHubOnCarrier(registry, new Hub());
      }
      return getHubFromCarrier(registry);
    }
    function ensureHubOnCarrier(carrier, parent = getGlobalHub()) {
      if (!hasHubOnCarrier(carrier) || // eslint-disable-next-line deprecation/deprecation
      getHubFromCarrier(carrier).isOlderThan(API_VERSION)) {
        const client = parent.getClient();
        const scope2 = parent.getScope();
        const isolationScope = parent.getIsolationScope();
        setHubOnCarrier(carrier, new Hub(client, scope2.clone(), isolationScope.clone()));
      }
    }
    function setAsyncContextStrategy(strategy) {
      const registry = getMainCarrier();
      registry.__SENTRY__ = registry.__SENTRY__ || {};
      registry.__SENTRY__.acs = strategy;
    }
    function runWithAsyncContext(callback, options = {}) {
      const registry = getMainCarrier();
      if (registry.__SENTRY__ && registry.__SENTRY__.acs) {
        return registry.__SENTRY__.acs.runWithAsyncContext(callback, options);
      }
      return callback();
    }
    function hasHubOnCarrier(carrier) {
      return !!(carrier && carrier.__SENTRY__ && carrier.__SENTRY__.hub);
    }
    function getHubFromCarrier(carrier) {
      return utils.getGlobalSingleton("hub", () => new Hub(), carrier);
    }
    function setHubOnCarrier(carrier, hub) {
      if (!carrier)
        return false;
      const __SENTRY__ = carrier.__SENTRY__ = carrier.__SENTRY__ || {};
      __SENTRY__.hub = hub;
      return true;
    }
    exports.API_VERSION = API_VERSION;
    exports.Hub = Hub;
    exports.ensureHubOnCarrier = ensureHubOnCarrier;
    exports.getCurrentHub = getCurrentHub;
    exports.getHubFromCarrier = getHubFromCarrier;
    exports.getIsolationScope = getIsolationScope;
    exports.getMainCarrier = getMainCarrier;
    exports.makeMain = makeMain;
    exports.runWithAsyncContext = runWithAsyncContext;
    exports.setAsyncContextStrategy = setAsyncContextStrategy;
    exports.setHubOnCarrier = setHubOnCarrier;
  }
});

// ../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/tracing/utils.js
var require_utils = __commonJS({
  "../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/tracing/utils.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var utils = require_cjs();
    var hub = require_hub();
    function getActiveTransaction(maybeHub) {
      const hub$1 = maybeHub || hub.getCurrentHub();
      const scope = hub$1.getScope();
      return scope.getTransaction();
    }
    var extractTraceparentData = utils.extractTraceparentData;
    exports.stripUrlQueryAndFragment = utils.stripUrlQueryAndFragment;
    exports.extractTraceparentData = extractTraceparentData;
    exports.getActiveTransaction = getActiveTransaction;
  }
});

// ../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/tracing/errors.js
var require_errors = __commonJS({
  "../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/tracing/errors.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var utils = require_cjs();
    var debugBuild = require_debug_build2();
    var utils$1 = require_utils();
    var errorsInstrumented = false;
    function registerErrorInstrumentation() {
      if (errorsInstrumented) {
        return;
      }
      errorsInstrumented = true;
      utils.addGlobalErrorInstrumentationHandler(errorCallback);
      utils.addGlobalUnhandledRejectionInstrumentationHandler(errorCallback);
    }
    function errorCallback() {
      const activeTransaction = utils$1.getActiveTransaction();
      if (activeTransaction) {
        const status = "internal_error";
        debugBuild.DEBUG_BUILD && utils.logger.log(`[Tracing] Transaction: ${status} -> Global error occured`);
        activeTransaction.setStatus(status);
      }
    }
    errorCallback.tag = "sentry_tracingErrorCallback";
    exports.registerErrorInstrumentation = registerErrorInstrumentation;
  }
});

// ../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/tracing/spanstatus.js
var require_spanstatus = __commonJS({
  "../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/tracing/spanstatus.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.SpanStatus = void 0;
    (function(SpanStatus) {
      const Ok = "ok";
      SpanStatus["Ok"] = Ok;
      const DeadlineExceeded = "deadline_exceeded";
      SpanStatus["DeadlineExceeded"] = DeadlineExceeded;
      const Unauthenticated = "unauthenticated";
      SpanStatus["Unauthenticated"] = Unauthenticated;
      const PermissionDenied = "permission_denied";
      SpanStatus["PermissionDenied"] = PermissionDenied;
      const NotFound = "not_found";
      SpanStatus["NotFound"] = NotFound;
      const ResourceExhausted = "resource_exhausted";
      SpanStatus["ResourceExhausted"] = ResourceExhausted;
      const InvalidArgument = "invalid_argument";
      SpanStatus["InvalidArgument"] = InvalidArgument;
      const Unimplemented = "unimplemented";
      SpanStatus["Unimplemented"] = Unimplemented;
      const Unavailable = "unavailable";
      SpanStatus["Unavailable"] = Unavailable;
      const InternalError = "internal_error";
      SpanStatus["InternalError"] = InternalError;
      const UnknownError = "unknown_error";
      SpanStatus["UnknownError"] = UnknownError;
      const Cancelled = "cancelled";
      SpanStatus["Cancelled"] = Cancelled;
      const AlreadyExists = "already_exists";
      SpanStatus["AlreadyExists"] = AlreadyExists;
      const FailedPrecondition = "failed_precondition";
      SpanStatus["FailedPrecondition"] = FailedPrecondition;
      const Aborted = "aborted";
      SpanStatus["Aborted"] = Aborted;
      const OutOfRange = "out_of_range";
      SpanStatus["OutOfRange"] = OutOfRange;
      const DataLoss = "data_loss";
      SpanStatus["DataLoss"] = DataLoss;
    })(exports.SpanStatus || (exports.SpanStatus = {}));
    function getSpanStatusFromHttpCode(httpStatus) {
      if (httpStatus < 400 && httpStatus >= 100) {
        return "ok";
      }
      if (httpStatus >= 400 && httpStatus < 500) {
        switch (httpStatus) {
          case 401:
            return "unauthenticated";
          case 403:
            return "permission_denied";
          case 404:
            return "not_found";
          case 409:
            return "already_exists";
          case 413:
            return "failed_precondition";
          case 429:
            return "resource_exhausted";
          default:
            return "invalid_argument";
        }
      }
      if (httpStatus >= 500 && httpStatus < 600) {
        switch (httpStatus) {
          case 501:
            return "unimplemented";
          case 503:
            return "unavailable";
          case 504:
            return "deadline_exceeded";
          default:
            return "internal_error";
        }
      }
      return "unknown_error";
    }
    var spanStatusfromHttpCode = getSpanStatusFromHttpCode;
    function setHttpStatus(span, httpStatus) {
      span.setTag("http.status_code", String(httpStatus));
      span.setData("http.response.status_code", httpStatus);
      const spanStatus = getSpanStatusFromHttpCode(httpStatus);
      if (spanStatus !== "unknown_error") {
        span.setStatus(spanStatus);
      }
    }
    exports.getSpanStatusFromHttpCode = getSpanStatusFromHttpCode;
    exports.setHttpStatus = setHttpStatus;
    exports.spanStatusfromHttpCode = spanStatusfromHttpCode;
  }
});

// ../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/utils/handleCallbackErrors.js
var require_handleCallbackErrors = __commonJS({
  "../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/utils/handleCallbackErrors.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var utils = require_cjs();
    function handleCallbackErrors(fn, onError, onFinally = () => {
    }) {
      let maybePromiseResult;
      try {
        maybePromiseResult = fn();
      } catch (e) {
        onError(e);
        onFinally();
        throw e;
      }
      return maybeHandlePromiseRejection(maybePromiseResult, onError, onFinally);
    }
    function maybeHandlePromiseRejection(value, onError, onFinally) {
      if (utils.isThenable(value)) {
        return value.then(
          (res) => {
            onFinally();
            return res;
          },
          (e) => {
            onError(e);
            onFinally();
            throw e;
          }
        );
      }
      onFinally();
      return value;
    }
    exports.handleCallbackErrors = handleCallbackErrors;
  }
});

// ../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/utils/hasTracingEnabled.js
var require_hasTracingEnabled = __commonJS({
  "../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/utils/hasTracingEnabled.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var exports$1 = require_exports();
    function hasTracingEnabled(maybeOptions) {
      if (typeof __SENTRY_TRACING__ === "boolean" && !__SENTRY_TRACING__) {
        return false;
      }
      const client = exports$1.getClient();
      const options = maybeOptions || client && client.getOptions();
      return !!options && (options.enableTracing || "tracesSampleRate" in options || "tracesSampler" in options);
    }
    exports.hasTracingEnabled = hasTracingEnabled;
  }
});

// ../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/tracing/trace.js
var require_trace = __commonJS({
  "../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/tracing/trace.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var utils = require_cjs();
    var debugBuild = require_debug_build2();
    var hub = require_hub();
    var spanUtils = require_spanUtils();
    require_errors();
    require_spanstatus();
    var dynamicSamplingContext = require_dynamicSamplingContext();
    var exports$1 = require_exports();
    var handleCallbackErrors = require_handleCallbackErrors();
    var hasTracingEnabled = require_hasTracingEnabled();
    function trace(context, callback, onError = () => {
    }, afterFinish = () => {
    }) {
      const hub$1 = hub.getCurrentHub();
      const scope = exports$1.getCurrentScope();
      const parentSpan = scope.getSpan();
      const spanContext = normalizeContext(context);
      const activeSpan = createChildSpanOrTransaction(hub$1, {
        parentSpan,
        spanContext,
        forceTransaction: false,
        scope
      });
      scope.setSpan(activeSpan);
      return handleCallbackErrors.handleCallbackErrors(
        () => callback(activeSpan),
        (error) => {
          activeSpan && activeSpan.setStatus("internal_error");
          onError(error, activeSpan);
        },
        () => {
          activeSpan && activeSpan.end();
          scope.setSpan(parentSpan);
          afterFinish();
        }
      );
    }
    function startSpan(context, callback) {
      const spanContext = normalizeContext(context);
      return hub.runWithAsyncContext(() => {
        return exports$1.withScope(context.scope, (scope) => {
          const hub$1 = hub.getCurrentHub();
          const parentSpan = scope.getSpan();
          const shouldSkipSpan = context.onlyIfParent && !parentSpan;
          const activeSpan = shouldSkipSpan ? void 0 : createChildSpanOrTransaction(hub$1, {
            parentSpan,
            spanContext,
            forceTransaction: context.forceTransaction,
            scope
          });
          return handleCallbackErrors.handleCallbackErrors(
            () => callback(activeSpan),
            () => {
              if (activeSpan) {
                const { status } = spanUtils.spanToJSON(activeSpan);
                if (!status || status === "ok") {
                  activeSpan.setStatus("internal_error");
                }
              }
            },
            () => activeSpan && activeSpan.end()
          );
        });
      });
    }
    var startActiveSpan = startSpan;
    function startSpanManual(context, callback) {
      const spanContext = normalizeContext(context);
      return hub.runWithAsyncContext(() => {
        return exports$1.withScope(context.scope, (scope) => {
          const hub$1 = hub.getCurrentHub();
          const parentSpan = scope.getSpan();
          const shouldSkipSpan = context.onlyIfParent && !parentSpan;
          const activeSpan = shouldSkipSpan ? void 0 : createChildSpanOrTransaction(hub$1, {
            parentSpan,
            spanContext,
            forceTransaction: context.forceTransaction,
            scope
          });
          function finishAndSetSpan() {
            activeSpan && activeSpan.end();
          }
          return handleCallbackErrors.handleCallbackErrors(
            () => callback(activeSpan, finishAndSetSpan),
            () => {
              if (activeSpan && activeSpan.isRecording()) {
                const { status } = spanUtils.spanToJSON(activeSpan);
                if (!status || status === "ok") {
                  activeSpan.setStatus("internal_error");
                }
              }
            }
          );
        });
      });
    }
    function startInactiveSpan(context) {
      if (!hasTracingEnabled.hasTracingEnabled()) {
        return void 0;
      }
      const spanContext = normalizeContext(context);
      const hub$1 = hub.getCurrentHub();
      const parentSpan = context.scope ? (
        // eslint-disable-next-line deprecation/deprecation
        context.scope.getSpan()
      ) : getActiveSpan();
      const shouldSkipSpan = context.onlyIfParent && !parentSpan;
      if (shouldSkipSpan) {
        return void 0;
      }
      const scope = context.scope || exports$1.getCurrentScope();
      const temporaryScope = scope.clone();
      return createChildSpanOrTransaction(hub$1, {
        parentSpan,
        spanContext,
        forceTransaction: context.forceTransaction,
        scope: temporaryScope
      });
    }
    function getActiveSpan() {
      return exports$1.getCurrentScope().getSpan();
    }
    var continueTrace = ({
      sentryTrace,
      baggage
    }, callback) => {
      const currentScope = exports$1.getCurrentScope();
      const { traceparentData, dynamicSamplingContext: dynamicSamplingContext2, propagationContext } = utils.tracingContextFromHeaders(
        sentryTrace,
        baggage
      );
      currentScope.setPropagationContext(propagationContext);
      if (debugBuild.DEBUG_BUILD && traceparentData) {
        utils.logger.log(`[Tracing] Continuing trace ${traceparentData.traceId}.`);
      }
      const transactionContext = {
        ...traceparentData,
        metadata: utils.dropUndefinedKeys({
          dynamicSamplingContext: dynamicSamplingContext2
        })
      };
      if (!callback) {
        return transactionContext;
      }
      return hub.runWithAsyncContext(() => {
        return callback(transactionContext);
      });
    };
    function createChildSpanOrTransaction(hub$1, {
      parentSpan,
      spanContext,
      forceTransaction,
      scope
    }) {
      if (!hasTracingEnabled.hasTracingEnabled()) {
        return void 0;
      }
      const isolationScope = hub.getIsolationScope();
      let span;
      if (parentSpan && !forceTransaction) {
        span = parentSpan.startChild(spanContext);
      } else if (parentSpan) {
        const dsc = dynamicSamplingContext.getDynamicSamplingContextFromSpan(parentSpan);
        const { traceId, spanId: parentSpanId } = parentSpan.spanContext();
        const sampled = spanUtils.spanIsSampled(parentSpan);
        span = hub$1.startTransaction({
          traceId,
          parentSpanId,
          parentSampled: sampled,
          ...spanContext,
          metadata: {
            dynamicSamplingContext: dsc,
            // eslint-disable-next-line deprecation/deprecation
            ...spanContext.metadata
          }
        });
      } else {
        const { traceId, dsc, parentSpanId, sampled } = {
          ...isolationScope.getPropagationContext(),
          ...scope.getPropagationContext()
        };
        span = hub$1.startTransaction({
          traceId,
          parentSpanId,
          parentSampled: sampled,
          ...spanContext,
          metadata: {
            dynamicSamplingContext: dsc,
            // eslint-disable-next-line deprecation/deprecation
            ...spanContext.metadata
          }
        });
      }
      scope.setSpan(span);
      setCapturedScopesOnSpan(span, scope, isolationScope);
      return span;
    }
    function normalizeContext(context) {
      if (context.startTime) {
        const ctx = { ...context };
        ctx.startTimestamp = spanUtils.spanTimeInputToSeconds(context.startTime);
        delete ctx.startTime;
        return ctx;
      }
      return context;
    }
    var SCOPE_ON_START_SPAN_FIELD = "_sentryScope";
    var ISOLATION_SCOPE_ON_START_SPAN_FIELD = "_sentryIsolationScope";
    function setCapturedScopesOnSpan(span, scope, isolationScope) {
      if (span) {
        utils.addNonEnumerableProperty(span, ISOLATION_SCOPE_ON_START_SPAN_FIELD, isolationScope);
        utils.addNonEnumerableProperty(span, SCOPE_ON_START_SPAN_FIELD, scope);
      }
    }
    function getCapturedScopesOnSpan(span) {
      return {
        scope: span[SCOPE_ON_START_SPAN_FIELD],
        isolationScope: span[ISOLATION_SCOPE_ON_START_SPAN_FIELD]
      };
    }
    exports.continueTrace = continueTrace;
    exports.getActiveSpan = getActiveSpan;
    exports.getCapturedScopesOnSpan = getCapturedScopesOnSpan;
    exports.startActiveSpan = startActiveSpan;
    exports.startInactiveSpan = startInactiveSpan;
    exports.startSpan = startSpan;
    exports.startSpanManual = startSpanManual;
    exports.trace = trace;
  }
});

// ../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/metrics/metric-summary.js
var require_metric_summary = __commonJS({
  "../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/metrics/metric-summary.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var utils = require_cjs();
    require_debug_build2();
    require_errors();
    require_spanstatus();
    var trace = require_trace();
    var SPAN_METRIC_SUMMARY;
    function getMetricStorageForSpan(span) {
      return SPAN_METRIC_SUMMARY ? SPAN_METRIC_SUMMARY.get(span) : void 0;
    }
    function getMetricSummaryJsonForSpan(span) {
      const storage = getMetricStorageForSpan(span);
      if (!storage) {
        return void 0;
      }
      const output = {};
      for (const [, [exportKey, summary]] of storage) {
        if (!output[exportKey]) {
          output[exportKey] = [];
        }
        output[exportKey].push(utils.dropUndefinedKeys(summary));
      }
      return output;
    }
    function updateMetricSummaryOnActiveSpan(metricType, sanitizedName, value, unit, tags, bucketKey) {
      const span = trace.getActiveSpan();
      if (span) {
        const storage = getMetricStorageForSpan(span) || /* @__PURE__ */ new Map();
        const exportKey = `${metricType}:${sanitizedName}@${unit}`;
        const bucketItem = storage.get(bucketKey);
        if (bucketItem) {
          const [, summary] = bucketItem;
          storage.set(bucketKey, [
            exportKey,
            {
              min: Math.min(summary.min, value),
              max: Math.max(summary.max, value),
              count: summary.count += 1,
              sum: summary.sum += value,
              tags: summary.tags
            }
          ]);
        } else {
          storage.set(bucketKey, [
            exportKey,
            {
              min: value,
              max: value,
              count: 1,
              sum: value,
              tags
            }
          ]);
        }
        if (!SPAN_METRIC_SUMMARY) {
          SPAN_METRIC_SUMMARY = /* @__PURE__ */ new WeakMap();
        }
        SPAN_METRIC_SUMMARY.set(span, storage);
      }
    }
    exports.getMetricSummaryJsonForSpan = getMetricSummaryJsonForSpan;
    exports.updateMetricSummaryOnActiveSpan = updateMetricSummaryOnActiveSpan;
  }
});

// ../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/semanticAttributes.js
var require_semanticAttributes = __commonJS({
  "../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/semanticAttributes.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var SEMANTIC_ATTRIBUTE_SENTRY_SOURCE = "sentry.source";
    var SEMANTIC_ATTRIBUTE_SENTRY_SAMPLE_RATE = "sentry.sample_rate";
    var SEMANTIC_ATTRIBUTE_SENTRY_OP = "sentry.op";
    var SEMANTIC_ATTRIBUTE_SENTRY_ORIGIN = "sentry.origin";
    var SEMANTIC_ATTRIBUTE_PROFILE_ID = "profile_id";
    exports.SEMANTIC_ATTRIBUTE_PROFILE_ID = SEMANTIC_ATTRIBUTE_PROFILE_ID;
    exports.SEMANTIC_ATTRIBUTE_SENTRY_OP = SEMANTIC_ATTRIBUTE_SENTRY_OP;
    exports.SEMANTIC_ATTRIBUTE_SENTRY_ORIGIN = SEMANTIC_ATTRIBUTE_SENTRY_ORIGIN;
    exports.SEMANTIC_ATTRIBUTE_SENTRY_SAMPLE_RATE = SEMANTIC_ATTRIBUTE_SENTRY_SAMPLE_RATE;
    exports.SEMANTIC_ATTRIBUTE_SENTRY_SOURCE = SEMANTIC_ATTRIBUTE_SENTRY_SOURCE;
  }
});

// ../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/tracing/span.js
var require_span = __commonJS({
  "../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/tracing/span.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var utils = require_cjs();
    var debugBuild = require_debug_build2();
    var metricSummary = require_metric_summary();
    var semanticAttributes = require_semanticAttributes();
    var getRootSpan = require_getRootSpan();
    var spanUtils = require_spanUtils();
    var spanstatus = require_spanstatus();
    var SpanRecorder = class {
      constructor(maxlen = 1e3) {
        this._maxlen = maxlen;
        this.spans = [];
      }
      /**
       * This is just so that we don't run out of memory while recording a lot
       * of spans. At some point we just stop and flush out the start of the
       * trace tree (i.e.the first n spans with the smallest
       * start_timestamp).
       */
      add(span) {
        if (this.spans.length > this._maxlen) {
          span.spanRecorder = void 0;
        } else {
          this.spans.push(span);
        }
      }
    };
    var Span = class _Span {
      /**
       * Tags for the span.
       * @deprecated Use `spanToJSON(span).atttributes` instead.
       */
      /**
       * Data for the span.
       * @deprecated Use `spanToJSON(span).atttributes` instead.
       */
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      /**
       * List of spans that were finalized
       *
       * @deprecated This property will no longer be public. Span recording will be handled internally.
       */
      /**
       * @inheritDoc
       * @deprecated Use top level `Sentry.getRootSpan()` instead
       */
      /**
       * The instrumenter that created this span.
       *
       * TODO (v8): This can probably be replaced by an `instanceOf` check of the span class.
       *            the instrumenter can only be sentry or otel so we can check the span instance
       *            to verify which one it is and remove this field entirely.
       *
       * @deprecated This field will be removed.
       */
      /** Epoch timestamp in seconds when the span started. */
      /** Epoch timestamp in seconds when the span ended. */
      /** Internal keeper of the status */
      /**
       * You should never call the constructor manually, always use `Sentry.startTransaction()`
       * or call `startChild()` on an existing span.
       * @internal
       * @hideconstructor
       * @hidden
       */
      constructor(spanContext = {}) {
        this._traceId = spanContext.traceId || utils.uuid4();
        this._spanId = spanContext.spanId || utils.uuid4().substring(16);
        this._startTime = spanContext.startTimestamp || utils.timestampInSeconds();
        this.tags = spanContext.tags ? { ...spanContext.tags } : {};
        this.data = spanContext.data ? { ...spanContext.data } : {};
        this.instrumenter = spanContext.instrumenter || "sentry";
        this._attributes = {};
        this.setAttributes({
          [semanticAttributes.SEMANTIC_ATTRIBUTE_SENTRY_ORIGIN]: spanContext.origin || "manual",
          [semanticAttributes.SEMANTIC_ATTRIBUTE_SENTRY_OP]: spanContext.op,
          ...spanContext.attributes
        });
        this._name = spanContext.name || spanContext.description;
        if (spanContext.parentSpanId) {
          this._parentSpanId = spanContext.parentSpanId;
        }
        if ("sampled" in spanContext) {
          this._sampled = spanContext.sampled;
        }
        if (spanContext.status) {
          this._status = spanContext.status;
        }
        if (spanContext.endTimestamp) {
          this._endTime = spanContext.endTimestamp;
        }
        if (spanContext.exclusiveTime !== void 0) {
          this._exclusiveTime = spanContext.exclusiveTime;
        }
        this._measurements = spanContext.measurements ? { ...spanContext.measurements } : {};
      }
      // This rule conflicts with another eslint rule :(
      /* eslint-disable @typescript-eslint/member-ordering */
      /**
       * An alias for `description` of the Span.
       * @deprecated Use `spanToJSON(span).description` instead.
       */
      get name() {
        return this._name || "";
      }
      /**
       * Update the name of the span.
       * @deprecated Use `spanToJSON(span).description` instead.
       */
      set name(name) {
        this.updateName(name);
      }
      /**
       * Get the description of the Span.
       * @deprecated Use `spanToJSON(span).description` instead.
       */
      get description() {
        return this._name;
      }
      /**
       * Get the description of the Span.
       * @deprecated Use `spanToJSON(span).description` instead.
       */
      set description(description) {
        this._name = description;
      }
      /**
       * The ID of the trace.
       * @deprecated Use `spanContext().traceId` instead.
       */
      get traceId() {
        return this._traceId;
      }
      /**
       * The ID of the trace.
       * @deprecated You cannot update the traceId of a span after span creation.
       */
      set traceId(traceId) {
        this._traceId = traceId;
      }
      /**
       * The ID of the span.
       * @deprecated Use `spanContext().spanId` instead.
       */
      get spanId() {
        return this._spanId;
      }
      /**
       * The ID of the span.
       * @deprecated You cannot update the spanId of a span after span creation.
       */
      set spanId(spanId) {
        this._spanId = spanId;
      }
      /**
       * @inheritDoc
       *
       * @deprecated Use `startSpan` functions instead.
       */
      set parentSpanId(string) {
        this._parentSpanId = string;
      }
      /**
       * @inheritDoc
       *
       * @deprecated Use `spanToJSON(span).parent_span_id` instead.
       */
      get parentSpanId() {
        return this._parentSpanId;
      }
      /**
       * Was this span chosen to be sent as part of the sample?
       * @deprecated Use `isRecording()` instead.
       */
      get sampled() {
        return this._sampled;
      }
      /**
       * Was this span chosen to be sent as part of the sample?
       * @deprecated You cannot update the sampling decision of a span after span creation.
       */
      set sampled(sampled) {
        this._sampled = sampled;
      }
      /**
       * Attributes for the span.
       * @deprecated Use `spanToJSON(span).atttributes` instead.
       */
      get attributes() {
        return this._attributes;
      }
      /**
       * Attributes for the span.
       * @deprecated Use `setAttributes()` instead.
       */
      set attributes(attributes) {
        this._attributes = attributes;
      }
      /**
       * Timestamp in seconds (epoch time) indicating when the span started.
       * @deprecated Use `spanToJSON()` instead.
       */
      get startTimestamp() {
        return this._startTime;
      }
      /**
       * Timestamp in seconds (epoch time) indicating when the span started.
       * @deprecated In v8, you will not be able to update the span start time after creation.
       */
      set startTimestamp(startTime) {
        this._startTime = startTime;
      }
      /**
       * Timestamp in seconds when the span ended.
       * @deprecated Use `spanToJSON()` instead.
       */
      get endTimestamp() {
        return this._endTime;
      }
      /**
       * Timestamp in seconds when the span ended.
       * @deprecated Set the end time via `span.end()` instead.
       */
      set endTimestamp(endTime) {
        this._endTime = endTime;
      }
      /**
       * The status of the span.
       *
       * @deprecated Use `spanToJSON().status` instead to get the status.
       */
      get status() {
        return this._status;
      }
      /**
       * The status of the span.
       *
       * @deprecated Use `.setStatus()` instead to set or update the status.
       */
      set status(status) {
        this._status = status;
      }
      /**
       * Operation of the span
       *
       * @deprecated Use `spanToJSON().op` to read the op instead.
       */
      get op() {
        return this._attributes[semanticAttributes.SEMANTIC_ATTRIBUTE_SENTRY_OP];
      }
      /**
       * Operation of the span
       *
       * @deprecated Use `startSpan()` functions to set or `span.setAttribute(SEMANTIC_ATTRIBUTE_SENTRY_OP, 'op')
       *             to update the span instead.
       */
      set op(op) {
        this.setAttribute(semanticAttributes.SEMANTIC_ATTRIBUTE_SENTRY_OP, op);
      }
      /**
       * The origin of the span, giving context about what created the span.
       *
       * @deprecated Use `spanToJSON().origin` to read the origin instead.
       */
      get origin() {
        return this._attributes[semanticAttributes.SEMANTIC_ATTRIBUTE_SENTRY_ORIGIN];
      }
      /**
       * The origin of the span, giving context about what created the span.
       *
       * @deprecated Use `startSpan()` functions to set the origin instead.
       */
      set origin(origin) {
        this.setAttribute(semanticAttributes.SEMANTIC_ATTRIBUTE_SENTRY_ORIGIN, origin);
      }
      /* eslint-enable @typescript-eslint/member-ordering */
      /** @inheritdoc */
      spanContext() {
        const { _spanId: spanId, _traceId: traceId, _sampled: sampled } = this;
        return {
          spanId,
          traceId,
          traceFlags: sampled ? spanUtils.TRACE_FLAG_SAMPLED : spanUtils.TRACE_FLAG_NONE
        };
      }
      /**
       * Creates a new `Span` while setting the current `Span.id` as `parentSpanId`.
       * Also the `sampled` decision will be inherited.
       *
       * @deprecated Use `startSpan()`, `startSpanManual()` or `startInactiveSpan()` instead.
       */
      startChild(spanContext) {
        const childSpan = new _Span({
          ...spanContext,
          parentSpanId: this._spanId,
          sampled: this._sampled,
          traceId: this._traceId
        });
        childSpan.spanRecorder = this.spanRecorder;
        if (childSpan.spanRecorder) {
          childSpan.spanRecorder.add(childSpan);
        }
        const rootSpan = getRootSpan.getRootSpan(this);
        childSpan.transaction = rootSpan;
        if (debugBuild.DEBUG_BUILD && rootSpan) {
          const opStr = spanContext && spanContext.op || "< unknown op >";
          const nameStr = spanUtils.spanToJSON(childSpan).description || "< unknown name >";
          const idStr = rootSpan.spanContext().spanId;
          const logMessage = `[Tracing] Starting '${opStr}' span on transaction '${nameStr}' (${idStr}).`;
          utils.logger.log(logMessage);
          this._logMessage = logMessage;
        }
        return childSpan;
      }
      /**
       * Sets the tag attribute on the current span.
       *
       * Can also be used to unset a tag, by passing `undefined`.
       *
       * @param key Tag key
       * @param value Tag value
       * @deprecated Use `setAttribute()` instead.
       */
      setTag(key, value) {
        this.tags = { ...this.tags, [key]: value };
        return this;
      }
      /**
       * Sets the data attribute on the current span
       * @param key Data key
       * @param value Data value
       * @deprecated Use `setAttribute()` instead.
       */
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setData(key, value) {
        this.data = { ...this.data, [key]: value };
        return this;
      }
      /** @inheritdoc */
      setAttribute(key, value) {
        if (value === void 0) {
          delete this._attributes[key];
        } else {
          this._attributes[key] = value;
        }
      }
      /** @inheritdoc */
      setAttributes(attributes) {
        Object.keys(attributes).forEach((key) => this.setAttribute(key, attributes[key]));
      }
      /**
       * @inheritDoc
       */
      setStatus(value) {
        this._status = value;
        return this;
      }
      /**
       * @inheritDoc
       * @deprecated Use top-level `setHttpStatus()` instead.
       */
      setHttpStatus(httpStatus) {
        spanstatus.setHttpStatus(this, httpStatus);
        return this;
      }
      /**
       * @inheritdoc
       *
       * @deprecated Use `.updateName()` instead.
       */
      setName(name) {
        this.updateName(name);
      }
      /**
       * @inheritDoc
       */
      updateName(name) {
        this._name = name;
        return this;
      }
      /**
       * @inheritDoc
       *
       * @deprecated Use `spanToJSON(span).status === 'ok'` instead.
       */
      isSuccess() {
        return this._status === "ok";
      }
      /**
       * @inheritDoc
       *
       * @deprecated Use `.end()` instead.
       */
      finish(endTimestamp) {
        return this.end(endTimestamp);
      }
      /** @inheritdoc */
      end(endTimestamp) {
        if (this._endTime) {
          return;
        }
        const rootSpan = getRootSpan.getRootSpan(this);
        if (debugBuild.DEBUG_BUILD && // Don't call this for transactions
        rootSpan && rootSpan.spanContext().spanId !== this._spanId) {
          const logMessage = this._logMessage;
          if (logMessage) {
            utils.logger.log(logMessage.replace("Starting", "Finishing"));
          }
        }
        this._endTime = spanUtils.spanTimeInputToSeconds(endTimestamp);
      }
      /**
       * @inheritDoc
       *
       * @deprecated Use `spanToTraceHeader()` instead.
       */
      toTraceparent() {
        return spanUtils.spanToTraceHeader(this);
      }
      /**
       * @inheritDoc
       *
       * @deprecated Use `spanToJSON()` or access the fields directly instead.
       */
      toContext() {
        return utils.dropUndefinedKeys({
          data: this._getData(),
          description: this._name,
          endTimestamp: this._endTime,
          // eslint-disable-next-line deprecation/deprecation
          op: this.op,
          parentSpanId: this._parentSpanId,
          sampled: this._sampled,
          spanId: this._spanId,
          startTimestamp: this._startTime,
          status: this._status,
          // eslint-disable-next-line deprecation/deprecation
          tags: this.tags,
          traceId: this._traceId
        });
      }
      /**
       * @inheritDoc
       *
       * @deprecated Update the fields directly instead.
       */
      updateWithContext(spanContext) {
        this.data = spanContext.data || {};
        this._name = spanContext.name || spanContext.description;
        this._endTime = spanContext.endTimestamp;
        this.op = spanContext.op;
        this._parentSpanId = spanContext.parentSpanId;
        this._sampled = spanContext.sampled;
        this._spanId = spanContext.spanId || this._spanId;
        this._startTime = spanContext.startTimestamp || this._startTime;
        this._status = spanContext.status;
        this.tags = spanContext.tags || {};
        this._traceId = spanContext.traceId || this._traceId;
        return this;
      }
      /**
       * @inheritDoc
       *
       * @deprecated Use `spanToTraceContext()` util function instead.
       */
      getTraceContext() {
        return spanUtils.spanToTraceContext(this);
      }
      /**
       * Get JSON representation of this span.
       *
       * @hidden
       * @internal This method is purely for internal purposes and should not be used outside
       * of SDK code. If you need to get a JSON representation of a span,
       * use `spanToJSON(span)` instead.
       */
      getSpanJSON() {
        return utils.dropUndefinedKeys({
          data: this._getData(),
          description: this._name,
          op: this._attributes[semanticAttributes.SEMANTIC_ATTRIBUTE_SENTRY_OP],
          parent_span_id: this._parentSpanId,
          span_id: this._spanId,
          start_timestamp: this._startTime,
          status: this._status,
          // eslint-disable-next-line deprecation/deprecation
          tags: Object.keys(this.tags).length > 0 ? this.tags : void 0,
          timestamp: this._endTime,
          trace_id: this._traceId,
          origin: this._attributes[semanticAttributes.SEMANTIC_ATTRIBUTE_SENTRY_ORIGIN],
          _metrics_summary: metricSummary.getMetricSummaryJsonForSpan(this),
          profile_id: this._attributes[semanticAttributes.SEMANTIC_ATTRIBUTE_PROFILE_ID],
          exclusive_time: this._exclusiveTime,
          measurements: Object.keys(this._measurements).length > 0 ? this._measurements : void 0
        });
      }
      /** @inheritdoc */
      isRecording() {
        return !this._endTime && !!this._sampled;
      }
      /**
       * Convert the object to JSON.
       * @deprecated Use `spanToJSON(span)` instead.
       */
      toJSON() {
        return this.getSpanJSON();
      }
      /**
       * Get the merged data for this span.
       * For now, this combines `data` and `attributes` together,
       * until eventually we can ingest `attributes` directly.
       */
      _getData() {
        const { data, _attributes: attributes } = this;
        const hasData = Object.keys(data).length > 0;
        const hasAttributes = Object.keys(attributes).length > 0;
        if (!hasData && !hasAttributes) {
          return void 0;
        }
        if (hasData && hasAttributes) {
          return {
            ...data,
            ...attributes
          };
        }
        return hasData ? data : attributes;
      }
    };
    exports.Span = Span;
    exports.SpanRecorder = SpanRecorder;
  }
});

// ../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/tracing/transaction.js
var require_transaction = __commonJS({
  "../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/tracing/transaction.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var utils = require_cjs();
    var debugBuild = require_debug_build2();
    var hub = require_hub();
    var metricSummary = require_metric_summary();
    var semanticAttributes = require_semanticAttributes();
    var spanUtils = require_spanUtils();
    var dynamicSamplingContext = require_dynamicSamplingContext();
    var span = require_span();
    var trace = require_trace();
    var Transaction = class extends span.Span {
      /**
       * The reference to the current hub.
       */
      // eslint-disable-next-line deprecation/deprecation
      // DO NOT yet remove this property, it is used in a hack for v7 backwards compatibility.
      /**
       * This constructor should never be called manually. Those instrumenting tracing should use
       * `Sentry.startTransaction()`, and internal methods should use `hub.startTransaction()`.
       * @internal
       * @hideconstructor
       * @hidden
       *
       * @deprecated Transactions will be removed in v8. Use spans instead.
       */
      // eslint-disable-next-line deprecation/deprecation
      constructor(transactionContext, hub$1) {
        super(transactionContext);
        this._contexts = {};
        this._hub = hub$1 || hub.getCurrentHub();
        this._name = transactionContext.name || "";
        this._metadata = {
          // eslint-disable-next-line deprecation/deprecation
          ...transactionContext.metadata
        };
        this._trimEnd = transactionContext.trimEnd;
        this.transaction = this;
        const incomingDynamicSamplingContext = this._metadata.dynamicSamplingContext;
        if (incomingDynamicSamplingContext) {
          this._frozenDynamicSamplingContext = { ...incomingDynamicSamplingContext };
        }
      }
      // This sadly conflicts with the getter/setter ordering :(
      /* eslint-disable @typescript-eslint/member-ordering */
      /**
       * Getter for `name` property.
       * @deprecated Use `spanToJSON(span).description` instead.
       */
      get name() {
        return this._name;
      }
      /**
       * Setter for `name` property, which also sets `source` as custom.
       * @deprecated Use `updateName()` and `setMetadata()` instead.
       */
      set name(newName) {
        this.setName(newName);
      }
      /**
       * Get the metadata for this transaction.
       * @deprecated Use `spanGetMetadata(transaction)` instead.
       */
      get metadata() {
        return {
          // Defaults
          // eslint-disable-next-line deprecation/deprecation
          source: "custom",
          spanMetadata: {},
          // Legacy metadata
          ...this._metadata,
          // From attributes
          ...this._attributes[semanticAttributes.SEMANTIC_ATTRIBUTE_SENTRY_SOURCE] && {
            source: this._attributes[semanticAttributes.SEMANTIC_ATTRIBUTE_SENTRY_SOURCE]
          },
          ...this._attributes[semanticAttributes.SEMANTIC_ATTRIBUTE_SENTRY_SAMPLE_RATE] && {
            sampleRate: this._attributes[semanticAttributes.SEMANTIC_ATTRIBUTE_SENTRY_SAMPLE_RATE]
          }
        };
      }
      /**
       * Update the metadata for this transaction.
       * @deprecated Use `spanGetMetadata(transaction)` instead.
       */
      set metadata(metadata) {
        this._metadata = metadata;
      }
      /* eslint-enable @typescript-eslint/member-ordering */
      /**
       * Setter for `name` property, which also sets `source` on the metadata.
       *
       * @deprecated Use `.updateName()` and `.setAttribute()` instead.
       */
      setName(name, source = "custom") {
        this._name = name;
        this.setAttribute(semanticAttributes.SEMANTIC_ATTRIBUTE_SENTRY_SOURCE, source);
      }
      /** @inheritdoc */
      updateName(name) {
        this._name = name;
        return this;
      }
      /**
       * Attaches SpanRecorder to the span itself
       * @param maxlen maximum number of spans that can be recorded
       */
      initSpanRecorder(maxlen = 1e3) {
        if (!this.spanRecorder) {
          this.spanRecorder = new span.SpanRecorder(maxlen);
        }
        this.spanRecorder.add(this);
      }
      /**
       * Set the context of a transaction event.
       * @deprecated Use either `.setAttribute()`, or set the context on the scope before creating the transaction.
       */
      setContext(key, context) {
        if (context === null) {
          delete this._contexts[key];
        } else {
          this._contexts[key] = context;
        }
      }
      /**
       * @inheritDoc
       *
       * @deprecated Use top-level `setMeasurement()` instead.
       */
      setMeasurement(name, value, unit = "") {
        this._measurements[name] = { value, unit };
      }
      /**
       * Store metadata on this transaction.
       * @deprecated Use attributes or store data on the scope instead.
       */
      setMetadata(newMetadata) {
        this._metadata = { ...this._metadata, ...newMetadata };
      }
      /**
       * @inheritDoc
       */
      end(endTimestamp) {
        const timestampInS = spanUtils.spanTimeInputToSeconds(endTimestamp);
        const transaction = this._finishTransaction(timestampInS);
        if (!transaction) {
          return void 0;
        }
        return this._hub.captureEvent(transaction);
      }
      /**
       * @inheritDoc
       */
      toContext() {
        const spanContext = super.toContext();
        return utils.dropUndefinedKeys({
          ...spanContext,
          name: this._name,
          trimEnd: this._trimEnd
        });
      }
      /**
       * @inheritDoc
       */
      updateWithContext(transactionContext) {
        super.updateWithContext(transactionContext);
        this._name = transactionContext.name || "";
        this._trimEnd = transactionContext.trimEnd;
        return this;
      }
      /**
       * @inheritdoc
       *
       * @experimental
       *
       * @deprecated Use top-level `getDynamicSamplingContextFromSpan` instead.
       */
      getDynamicSamplingContext() {
        return dynamicSamplingContext.getDynamicSamplingContextFromSpan(this);
      }
      /**
       * Override the current hub with a new one.
       * Used if you want another hub to finish the transaction.
       *
       * @internal
       */
      // eslint-disable-next-line deprecation/deprecation
      setHub(hub2) {
        this._hub = hub2;
      }
      /**
       * Get the profile id of the transaction.
       */
      getProfileId() {
        if (this._contexts !== void 0 && this._contexts["profile"] !== void 0) {
          return this._contexts["profile"].profile_id;
        }
        return void 0;
      }
      /**
       * Finish the transaction & prepare the event to send to Sentry.
       */
      _finishTransaction(endTimestamp) {
        if (this._endTime !== void 0) {
          return void 0;
        }
        if (!this._name) {
          debugBuild.DEBUG_BUILD && utils.logger.warn("Transaction has no name, falling back to `<unlabeled transaction>`.");
          this._name = "<unlabeled transaction>";
        }
        super.end(endTimestamp);
        const client = this._hub.getClient();
        if (client && client.emit) {
          client.emit("finishTransaction", this);
        }
        if (this._sampled !== true) {
          debugBuild.DEBUG_BUILD && utils.logger.log("[Tracing] Discarding transaction because its trace was not chosen to be sampled.");
          if (client) {
            client.recordDroppedEvent("sample_rate", "transaction");
          }
          return void 0;
        }
        const finishedSpans = this.spanRecorder ? (
          // eslint-disable-next-line deprecation/deprecation
          this.spanRecorder.spans.filter((span2) => span2 !== this && spanUtils.spanToJSON(span2).timestamp)
        ) : [];
        if (this._trimEnd && finishedSpans.length > 0) {
          const endTimes = finishedSpans.map((span2) => spanUtils.spanToJSON(span2).timestamp).filter(Boolean);
          this._endTime = endTimes.reduce((prev, current) => {
            return prev > current ? prev : current;
          });
        }
        const { scope: capturedSpanScope, isolationScope: capturedSpanIsolationScope } = trace.getCapturedScopesOnSpan(this);
        const { metadata } = this;
        const { source } = metadata;
        const transaction = {
          contexts: {
            ...this._contexts,
            // We don't want to override trace context
            trace: spanUtils.spanToTraceContext(this)
          },
          // TODO: Pass spans serialized via `spanToJSON()` here instead in v8.
          spans: finishedSpans,
          start_timestamp: this._startTime,
          // eslint-disable-next-line deprecation/deprecation
          tags: this.tags,
          timestamp: this._endTime,
          transaction: this._name,
          type: "transaction",
          sdkProcessingMetadata: {
            ...metadata,
            capturedSpanScope,
            capturedSpanIsolationScope,
            ...utils.dropUndefinedKeys({
              dynamicSamplingContext: dynamicSamplingContext.getDynamicSamplingContextFromSpan(this)
            })
          },
          _metrics_summary: metricSummary.getMetricSummaryJsonForSpan(this),
          ...source && {
            transaction_info: {
              source
            }
          }
        };
        const hasMeasurements = Object.keys(this._measurements).length > 0;
        if (hasMeasurements) {
          debugBuild.DEBUG_BUILD && utils.logger.log(
            "[Measurements] Adding measurements to transaction",
            JSON.stringify(this._measurements, void 0, 2)
          );
          transaction.measurements = this._measurements;
        }
        debugBuild.DEBUG_BUILD && utils.logger.log(`[Tracing] Finishing ${this.op} transaction: ${this._name}.`);
        return transaction;
      }
    };
    exports.Transaction = Transaction;
  }
});

// ../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/tracing/idletransaction.js
var require_idletransaction = __commonJS({
  "../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/tracing/idletransaction.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var utils = require_cjs();
    var debugBuild = require_debug_build2();
    var spanUtils = require_spanUtils();
    var span = require_span();
    var transaction = require_transaction();
    var TRACING_DEFAULTS = {
      idleTimeout: 1e3,
      finalTimeout: 3e4,
      heartbeatInterval: 5e3
    };
    var FINISH_REASON_TAG = "finishReason";
    var IDLE_TRANSACTION_FINISH_REASONS = [
      "heartbeatFailed",
      "idleTimeout",
      "documentHidden",
      "finalTimeout",
      "externalFinish",
      "cancelled"
    ];
    var IdleTransactionSpanRecorder = class extends span.SpanRecorder {
      constructor(_pushActivity, _popActivity, transactionSpanId, maxlen) {
        super(maxlen);
        this._pushActivity = _pushActivity;
        this._popActivity = _popActivity;
        this.transactionSpanId = transactionSpanId;
      }
      /**
       * @inheritDoc
       */
      add(span2) {
        if (span2.spanContext().spanId !== this.transactionSpanId) {
          const originalEnd = span2.end;
          span2.end = (...rest) => {
            this._popActivity(span2.spanContext().spanId);
            return originalEnd.apply(span2, rest);
          };
          if (spanUtils.spanToJSON(span2).timestamp === void 0) {
            this._pushActivity(span2.spanContext().spanId);
          }
        }
        super.add(span2);
      }
    };
    var IdleTransaction = class extends transaction.Transaction {
      // Activities store a list of active spans
      // Track state of activities in previous heartbeat
      // Amount of times heartbeat has counted. Will cause transaction to finish after 3 beats.
      // We should not use heartbeat if we finished a transaction
      // Idle timeout was canceled and we should finish the transaction with the last span end.
      /**
       * Timer that tracks Transaction idleTimeout
       */
      /**
       * @deprecated Transactions will be removed in v8. Use spans instead.
       */
      constructor(transactionContext, _idleHub, _idleTimeout = TRACING_DEFAULTS.idleTimeout, _finalTimeout = TRACING_DEFAULTS.finalTimeout, _heartbeatInterval = TRACING_DEFAULTS.heartbeatInterval, _onScope = false, delayAutoFinishUntilSignal = false) {
        super(transactionContext, _idleHub);
        this._idleHub = _idleHub;
        this._idleTimeout = _idleTimeout;
        this._finalTimeout = _finalTimeout;
        this._heartbeatInterval = _heartbeatInterval;
        this._onScope = _onScope;
        this.activities = {};
        this._heartbeatCounter = 0;
        this._finished = false;
        this._idleTimeoutCanceledPermanently = false;
        this._beforeFinishCallbacks = [];
        this._finishReason = IDLE_TRANSACTION_FINISH_REASONS[4];
        this._autoFinishAllowed = !delayAutoFinishUntilSignal;
        if (_onScope) {
          debugBuild.DEBUG_BUILD && utils.logger.log(`Setting idle transaction on scope. Span ID: ${this.spanContext().spanId}`);
          _idleHub.getScope().setSpan(this);
        }
        if (!delayAutoFinishUntilSignal) {
          this._restartIdleTimeout();
        }
        setTimeout(() => {
          if (!this._finished) {
            this.setStatus("deadline_exceeded");
            this._finishReason = IDLE_TRANSACTION_FINISH_REASONS[3];
            this.end();
          }
        }, this._finalTimeout);
      }
      /** {@inheritDoc} */
      end(endTimestamp) {
        const endTimestampInS = spanUtils.spanTimeInputToSeconds(endTimestamp);
        this._finished = true;
        this.activities = {};
        if (this.op === "ui.action.click") {
          this.setAttribute(FINISH_REASON_TAG, this._finishReason);
        }
        if (this.spanRecorder) {
          debugBuild.DEBUG_BUILD && // eslint-disable-next-line deprecation/deprecation
          utils.logger.log("[Tracing] finishing IdleTransaction", new Date(endTimestampInS * 1e3).toISOString(), this.op);
          for (const callback of this._beforeFinishCallbacks) {
            callback(this, endTimestampInS);
          }
          this.spanRecorder.spans = this.spanRecorder.spans.filter((span2) => {
            if (span2.spanContext().spanId === this.spanContext().spanId) {
              return true;
            }
            if (!spanUtils.spanToJSON(span2).timestamp) {
              span2.setStatus("cancelled");
              span2.end(endTimestampInS);
              debugBuild.DEBUG_BUILD && utils.logger.log("[Tracing] cancelling span since transaction ended early", JSON.stringify(span2, void 0, 2));
            }
            const { start_timestamp: startTime, timestamp: endTime } = spanUtils.spanToJSON(span2);
            const spanStartedBeforeTransactionFinish = startTime && startTime < endTimestampInS;
            const timeoutWithMarginOfError = (this._finalTimeout + this._idleTimeout) / 1e3;
            const spanEndedBeforeFinalTimeout = endTime && startTime && endTime - startTime < timeoutWithMarginOfError;
            if (debugBuild.DEBUG_BUILD) {
              const stringifiedSpan = JSON.stringify(span2, void 0, 2);
              if (!spanStartedBeforeTransactionFinish) {
                utils.logger.log("[Tracing] discarding Span since it happened after Transaction was finished", stringifiedSpan);
              } else if (!spanEndedBeforeFinalTimeout) {
                utils.logger.log("[Tracing] discarding Span since it finished after Transaction final timeout", stringifiedSpan);
              }
            }
            return spanStartedBeforeTransactionFinish && spanEndedBeforeFinalTimeout;
          });
          debugBuild.DEBUG_BUILD && utils.logger.log("[Tracing] flushing IdleTransaction");
        } else {
          debugBuild.DEBUG_BUILD && utils.logger.log("[Tracing] No active IdleTransaction");
        }
        if (this._onScope) {
          const scope = this._idleHub.getScope();
          if (scope.getTransaction() === this) {
            scope.setSpan(void 0);
          }
        }
        return super.end(endTimestamp);
      }
      /**
       * Register a callback function that gets executed before the transaction finishes.
       * Useful for cleanup or if you want to add any additional spans based on current context.
       *
       * This is exposed because users have no other way of running something before an idle transaction
       * finishes.
       */
      registerBeforeFinishCallback(callback) {
        this._beforeFinishCallbacks.push(callback);
      }
      /**
       * @inheritDoc
       */
      initSpanRecorder(maxlen) {
        if (!this.spanRecorder) {
          const pushActivity = (id) => {
            if (this._finished) {
              return;
            }
            this._pushActivity(id);
          };
          const popActivity = (id) => {
            if (this._finished) {
              return;
            }
            this._popActivity(id);
          };
          this.spanRecorder = new IdleTransactionSpanRecorder(pushActivity, popActivity, this.spanContext().spanId, maxlen);
          debugBuild.DEBUG_BUILD && utils.logger.log("Starting heartbeat");
          this._pingHeartbeat();
        }
        this.spanRecorder.add(this);
      }
      /**
       * Cancels the existing idle timeout, if there is one.
       * @param restartOnChildSpanChange Default is `true`.
       *                                 If set to false the transaction will end
       *                                 with the last child span.
       */
      cancelIdleTimeout(endTimestamp, {
        restartOnChildSpanChange
      } = {
        restartOnChildSpanChange: true
      }) {
        this._idleTimeoutCanceledPermanently = restartOnChildSpanChange === false;
        if (this._idleTimeoutID) {
          clearTimeout(this._idleTimeoutID);
          this._idleTimeoutID = void 0;
          if (Object.keys(this.activities).length === 0 && this._idleTimeoutCanceledPermanently) {
            this._finishReason = IDLE_TRANSACTION_FINISH_REASONS[5];
            this.end(endTimestamp);
          }
        }
      }
      /**
       * Temporary method used to externally set the transaction's `finishReason`
       *
       * ** WARNING**
       * This is for the purpose of experimentation only and will be removed in the near future, do not use!
       *
       * @internal
       *
       */
      setFinishReason(reason) {
        this._finishReason = reason;
      }
      /**
       * Permits the IdleTransaction to automatically end itself via the idle timeout and heartbeat mechanisms when the `delayAutoFinishUntilSignal` option was set to `true`.
       */
      sendAutoFinishSignal() {
        if (!this._autoFinishAllowed) {
          debugBuild.DEBUG_BUILD && utils.logger.log("[Tracing] Received finish signal for idle transaction.");
          this._restartIdleTimeout();
          this._autoFinishAllowed = true;
        }
      }
      /**
       * Restarts idle timeout, if there is no running idle timeout it will start one.
       */
      _restartIdleTimeout(endTimestamp) {
        this.cancelIdleTimeout();
        this._idleTimeoutID = setTimeout(() => {
          if (!this._finished && Object.keys(this.activities).length === 0) {
            this._finishReason = IDLE_TRANSACTION_FINISH_REASONS[1];
            this.end(endTimestamp);
          }
        }, this._idleTimeout);
      }
      /**
       * Start tracking a specific activity.
       * @param spanId The span id that represents the activity
       */
      _pushActivity(spanId) {
        this.cancelIdleTimeout(void 0, { restartOnChildSpanChange: !this._idleTimeoutCanceledPermanently });
        debugBuild.DEBUG_BUILD && utils.logger.log(`[Tracing] pushActivity: ${spanId}`);
        this.activities[spanId] = true;
        debugBuild.DEBUG_BUILD && utils.logger.log("[Tracing] new activities count", Object.keys(this.activities).length);
      }
      /**
       * Remove an activity from usage
       * @param spanId The span id that represents the activity
       */
      _popActivity(spanId) {
        if (this.activities[spanId]) {
          debugBuild.DEBUG_BUILD && utils.logger.log(`[Tracing] popActivity ${spanId}`);
          delete this.activities[spanId];
          debugBuild.DEBUG_BUILD && utils.logger.log("[Tracing] new activities count", Object.keys(this.activities).length);
        }
        if (Object.keys(this.activities).length === 0) {
          const endTimestamp = utils.timestampInSeconds();
          if (this._idleTimeoutCanceledPermanently) {
            if (this._autoFinishAllowed) {
              this._finishReason = IDLE_TRANSACTION_FINISH_REASONS[5];
              this.end(endTimestamp);
            }
          } else {
            this._restartIdleTimeout(endTimestamp + this._idleTimeout / 1e3);
          }
        }
      }
      /**
       * Checks when entries of this.activities are not changing for 3 beats.
       * If this occurs we finish the transaction.
       */
      _beat() {
        if (this._finished) {
          return;
        }
        const heartbeatString = Object.keys(this.activities).join("");
        if (heartbeatString === this._prevHeartbeatString) {
          this._heartbeatCounter++;
        } else {
          this._heartbeatCounter = 1;
        }
        this._prevHeartbeatString = heartbeatString;
        if (this._heartbeatCounter >= 3) {
          if (this._autoFinishAllowed) {
            debugBuild.DEBUG_BUILD && utils.logger.log("[Tracing] Transaction finished because of no change for 3 heart beats");
            this.setStatus("deadline_exceeded");
            this._finishReason = IDLE_TRANSACTION_FINISH_REASONS[0];
            this.end();
          }
        } else {
          this._pingHeartbeat();
        }
      }
      /**
       * Pings the heartbeat
       */
      _pingHeartbeat() {
        debugBuild.DEBUG_BUILD && utils.logger.log(`pinging Heartbeat -> current counter: ${this._heartbeatCounter}`);
        setTimeout(() => {
          this._beat();
        }, this._heartbeatInterval);
      }
    };
    exports.IdleTransaction = IdleTransaction;
    exports.IdleTransactionSpanRecorder = IdleTransactionSpanRecorder;
    exports.TRACING_DEFAULTS = TRACING_DEFAULTS;
  }
});

// ../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/tracing/sampling.js
var require_sampling = __commonJS({
  "../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/tracing/sampling.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var utils = require_cjs();
    var debugBuild = require_debug_build2();
    var semanticAttributes = require_semanticAttributes();
    var hasTracingEnabled = require_hasTracingEnabled();
    var spanUtils = require_spanUtils();
    function sampleTransaction(transaction, options, samplingContext) {
      if (!hasTracingEnabled.hasTracingEnabled(options)) {
        transaction.sampled = false;
        return transaction;
      }
      if (transaction.sampled !== void 0) {
        transaction.setAttribute(semanticAttributes.SEMANTIC_ATTRIBUTE_SENTRY_SAMPLE_RATE, Number(transaction.sampled));
        return transaction;
      }
      let sampleRate;
      if (typeof options.tracesSampler === "function") {
        sampleRate = options.tracesSampler(samplingContext);
        transaction.setAttribute(semanticAttributes.SEMANTIC_ATTRIBUTE_SENTRY_SAMPLE_RATE, Number(sampleRate));
      } else if (samplingContext.parentSampled !== void 0) {
        sampleRate = samplingContext.parentSampled;
      } else if (typeof options.tracesSampleRate !== "undefined") {
        sampleRate = options.tracesSampleRate;
        transaction.setAttribute(semanticAttributes.SEMANTIC_ATTRIBUTE_SENTRY_SAMPLE_RATE, Number(sampleRate));
      } else {
        sampleRate = 1;
        transaction.setAttribute(semanticAttributes.SEMANTIC_ATTRIBUTE_SENTRY_SAMPLE_RATE, sampleRate);
      }
      if (!isValidSampleRate(sampleRate)) {
        debugBuild.DEBUG_BUILD && utils.logger.warn("[Tracing] Discarding transaction because of invalid sample rate.");
        transaction.sampled = false;
        return transaction;
      }
      if (!sampleRate) {
        debugBuild.DEBUG_BUILD && utils.logger.log(
          `[Tracing] Discarding transaction because ${typeof options.tracesSampler === "function" ? "tracesSampler returned 0 or false" : "a negative sampling decision was inherited or tracesSampleRate is set to 0"}`
        );
        transaction.sampled = false;
        return transaction;
      }
      transaction.sampled = Math.random() < sampleRate;
      if (!transaction.sampled) {
        debugBuild.DEBUG_BUILD && utils.logger.log(
          `[Tracing] Discarding transaction because it's not included in the random sample (sampling rate = ${Number(
            sampleRate
          )})`
        );
        return transaction;
      }
      debugBuild.DEBUG_BUILD && // eslint-disable-next-line deprecation/deprecation
      utils.logger.log(`[Tracing] starting ${transaction.op} transaction - ${spanUtils.spanToJSON(transaction).description}`);
      return transaction;
    }
    function isValidSampleRate(rate) {
      if (utils.isNaN(rate) || !(typeof rate === "number" || typeof rate === "boolean")) {
        debugBuild.DEBUG_BUILD && utils.logger.warn(
          `[Tracing] Given sample rate is invalid. Sample rate must be a boolean or a number between 0 and 1. Got ${JSON.stringify(
            rate
          )} of type ${JSON.stringify(typeof rate)}.`
        );
        return false;
      }
      if (rate < 0 || rate > 1) {
        debugBuild.DEBUG_BUILD && utils.logger.warn(`[Tracing] Given sample rate is invalid. Sample rate must be between 0 and 1. Got ${rate}.`);
        return false;
      }
      return true;
    }
    exports.isValidSampleRate = isValidSampleRate;
    exports.sampleTransaction = sampleTransaction;
  }
});

// ../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/tracing/hubextensions.js
var require_hubextensions = __commonJS({
  "../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/tracing/hubextensions.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var utils = require_cjs();
    var debugBuild = require_debug_build2();
    var hub = require_hub();
    var spanUtils = require_spanUtils();
    var errors = require_errors();
    var idletransaction = require_idletransaction();
    var sampling = require_sampling();
    var transaction = require_transaction();
    function traceHeaders() {
      const scope = this.getScope();
      const span = scope.getSpan();
      return span ? {
        "sentry-trace": spanUtils.spanToTraceHeader(span)
      } : {};
    }
    function _startTransaction(transactionContext, customSamplingContext) {
      const client = this.getClient();
      const options = client && client.getOptions() || {};
      const configInstrumenter = options.instrumenter || "sentry";
      const transactionInstrumenter = transactionContext.instrumenter || "sentry";
      if (configInstrumenter !== transactionInstrumenter) {
        debugBuild.DEBUG_BUILD && utils.logger.error(
          `A transaction was started with instrumenter=\`${transactionInstrumenter}\`, but the SDK is configured with the \`${configInstrumenter}\` instrumenter.
The transaction will not be sampled. Please use the ${configInstrumenter} instrumentation to start transactions.`
        );
        transactionContext.sampled = false;
      }
      let transaction$1 = new transaction.Transaction(transactionContext, this);
      transaction$1 = sampling.sampleTransaction(transaction$1, options, {
        name: transactionContext.name,
        parentSampled: transactionContext.parentSampled,
        transactionContext,
        attributes: {
          // eslint-disable-next-line deprecation/deprecation
          ...transactionContext.data,
          ...transactionContext.attributes
        },
        ...customSamplingContext
      });
      if (transaction$1.isRecording()) {
        transaction$1.initSpanRecorder(options._experiments && options._experiments.maxSpans);
      }
      if (client && client.emit) {
        client.emit("startTransaction", transaction$1);
      }
      return transaction$1;
    }
    function startIdleTransaction(hub2, transactionContext, idleTimeout, finalTimeout, onScope, customSamplingContext, heartbeatInterval, delayAutoFinishUntilSignal = false) {
      const client = hub2.getClient();
      const options = client && client.getOptions() || {};
      let transaction2 = new idletransaction.IdleTransaction(
        transactionContext,
        hub2,
        idleTimeout,
        finalTimeout,
        heartbeatInterval,
        onScope,
        delayAutoFinishUntilSignal
      );
      transaction2 = sampling.sampleTransaction(transaction2, options, {
        name: transactionContext.name,
        parentSampled: transactionContext.parentSampled,
        transactionContext,
        attributes: {
          // eslint-disable-next-line deprecation/deprecation
          ...transactionContext.data,
          ...transactionContext.attributes
        },
        ...customSamplingContext
      });
      if (transaction2.isRecording()) {
        transaction2.initSpanRecorder(options._experiments && options._experiments.maxSpans);
      }
      if (client && client.emit) {
        client.emit("startTransaction", transaction2);
      }
      return transaction2;
    }
    function addTracingExtensions() {
      const carrier = hub.getMainCarrier();
      if (!carrier.__SENTRY__) {
        return;
      }
      carrier.__SENTRY__.extensions = carrier.__SENTRY__.extensions || {};
      if (!carrier.__SENTRY__.extensions.startTransaction) {
        carrier.__SENTRY__.extensions.startTransaction = _startTransaction;
      }
      if (!carrier.__SENTRY__.extensions.traceHeaders) {
        carrier.__SENTRY__.extensions.traceHeaders = traceHeaders;
      }
      errors.registerErrorInstrumentation();
    }
    exports.addTracingExtensions = addTracingExtensions;
    exports.startIdleTransaction = startIdleTransaction;
  }
});

// ../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/tracing/measurement.js
var require_measurement = __commonJS({
  "../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/tracing/measurement.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var utils = require_utils();
    function setMeasurement(name, value, unit) {
      const transaction = utils.getActiveTransaction();
      if (transaction) {
        transaction.setMeasurement(name, value, unit);
      }
    }
    exports.setMeasurement = setMeasurement;
  }
});

// ../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/envelope.js
var require_envelope2 = __commonJS({
  "../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/envelope.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var utils = require_cjs();
    function enhanceEventWithSdkInfo(event, sdkInfo) {
      if (!sdkInfo) {
        return event;
      }
      event.sdk = event.sdk || {};
      event.sdk.name = event.sdk.name || sdkInfo.name;
      event.sdk.version = event.sdk.version || sdkInfo.version;
      event.sdk.integrations = [...event.sdk.integrations || [], ...sdkInfo.integrations || []];
      event.sdk.packages = [...event.sdk.packages || [], ...sdkInfo.packages || []];
      return event;
    }
    function createSessionEnvelope(session, dsn, metadata, tunnel) {
      const sdkInfo = utils.getSdkMetadataForEnvelopeHeader(metadata);
      const envelopeHeaders = {
        sent_at: (/* @__PURE__ */ new Date()).toISOString(),
        ...sdkInfo && { sdk: sdkInfo },
        ...!!tunnel && dsn && { dsn: utils.dsnToString(dsn) }
      };
      const envelopeItem = "aggregates" in session ? [{ type: "sessions" }, session] : [{ type: "session" }, session.toJSON()];
      return utils.createEnvelope(envelopeHeaders, [envelopeItem]);
    }
    function createEventEnvelope(event, dsn, metadata, tunnel) {
      const sdkInfo = utils.getSdkMetadataForEnvelopeHeader(metadata);
      const eventType = event.type && event.type !== "replay_event" ? event.type : "event";
      enhanceEventWithSdkInfo(event, metadata && metadata.sdk);
      const envelopeHeaders = utils.createEventEnvelopeHeaders(event, sdkInfo, tunnel, dsn);
      delete event.sdkProcessingMetadata;
      const eventItem = [{ type: eventType }, event];
      return utils.createEnvelope(envelopeHeaders, [eventItem]);
    }
    exports.createEventEnvelope = createEventEnvelope;
    exports.createSessionEnvelope = createSessionEnvelope;
  }
});

// ../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/sessionflusher.js
var require_sessionflusher = __commonJS({
  "../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/sessionflusher.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var utils = require_cjs();
    var exports$1 = require_exports();
    var SessionFlusher = class {
      // Cast to any so that it can use Node.js timeout
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      constructor(client, attrs) {
        this._client = client;
        this.flushTimeout = 60;
        this._pendingAggregates = {};
        this._isEnabled = true;
        this._intervalId = setInterval(() => this.flush(), this.flushTimeout * 1e3);
        if (this._intervalId.unref) {
          this._intervalId.unref();
        }
        this._sessionAttrs = attrs;
      }
      /** Checks if `pendingAggregates` has entries, and if it does flushes them by calling `sendSession` */
      flush() {
        const sessionAggregates = this.getSessionAggregates();
        if (sessionAggregates.aggregates.length === 0) {
          return;
        }
        this._pendingAggregates = {};
        this._client.sendSession(sessionAggregates);
      }
      /** Massages the entries in `pendingAggregates` and returns aggregated sessions */
      getSessionAggregates() {
        const aggregates = Object.keys(this._pendingAggregates).map((key) => {
          return this._pendingAggregates[parseInt(key)];
        });
        const sessionAggregates = {
          attrs: this._sessionAttrs,
          aggregates
        };
        return utils.dropUndefinedKeys(sessionAggregates);
      }
      /** JSDoc */
      close() {
        clearInterval(this._intervalId);
        this._isEnabled = false;
        this.flush();
      }
      /**
       * Wrapper function for _incrementSessionStatusCount that checks if the instance of SessionFlusher is enabled then
       * fetches the session status of the request from `Scope.getRequestSession().status` on the scope and passes them to
       * `_incrementSessionStatusCount` along with the start date
       */
      incrementSessionStatusCount() {
        if (!this._isEnabled) {
          return;
        }
        const scope = exports$1.getCurrentScope();
        const requestSession = scope.getRequestSession();
        if (requestSession && requestSession.status) {
          this._incrementSessionStatusCount(requestSession.status, /* @__PURE__ */ new Date());
          scope.setRequestSession(void 0);
        }
      }
      /**
       * Increments status bucket in pendingAggregates buffer (internal state) corresponding to status of
       * the session received
       */
      _incrementSessionStatusCount(status, date) {
        const sessionStartedTrunc = new Date(date).setSeconds(0, 0);
        this._pendingAggregates[sessionStartedTrunc] = this._pendingAggregates[sessionStartedTrunc] || {};
        const aggregationCounts = this._pendingAggregates[sessionStartedTrunc];
        if (!aggregationCounts.started) {
          aggregationCounts.started = new Date(sessionStartedTrunc).toISOString();
        }
        switch (status) {
          case "errored":
            aggregationCounts.errored = (aggregationCounts.errored || 0) + 1;
            return aggregationCounts.errored;
          case "ok":
            aggregationCounts.exited = (aggregationCounts.exited || 0) + 1;
            return aggregationCounts.exited;
          default:
            aggregationCounts.crashed = (aggregationCounts.crashed || 0) + 1;
            return aggregationCounts.crashed;
        }
      }
    };
    exports.SessionFlusher = SessionFlusher;
  }
});

// ../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/api.js
var require_api = __commonJS({
  "../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/api.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var utils = require_cjs();
    var SENTRY_API_VERSION = "7";
    function getBaseApiEndpoint(dsn) {
      const protocol = dsn.protocol ? `${dsn.protocol}:` : "";
      const port = dsn.port ? `:${dsn.port}` : "";
      return `${protocol}//${dsn.host}${port}${dsn.path ? `/${dsn.path}` : ""}/api/`;
    }
    function _getIngestEndpoint(dsn) {
      return `${getBaseApiEndpoint(dsn)}${dsn.projectId}/envelope/`;
    }
    function _encodedAuth(dsn, sdkInfo) {
      return utils.urlEncode({
        // We send only the minimum set of required information. See
        // https://github.com/getsentry/sentry-javascript/issues/2572.
        sentry_key: dsn.publicKey,
        sentry_version: SENTRY_API_VERSION,
        ...sdkInfo && { sentry_client: `${sdkInfo.name}/${sdkInfo.version}` }
      });
    }
    function getEnvelopeEndpointWithUrlEncodedAuth(dsn, tunnelOrOptions = {}) {
      const tunnel = typeof tunnelOrOptions === "string" ? tunnelOrOptions : tunnelOrOptions.tunnel;
      const sdkInfo = typeof tunnelOrOptions === "string" || !tunnelOrOptions._metadata ? void 0 : tunnelOrOptions._metadata.sdk;
      return tunnel ? tunnel : `${_getIngestEndpoint(dsn)}?${_encodedAuth(dsn, sdkInfo)}`;
    }
    function getReportDialogEndpoint(dsnLike, dialogOptions) {
      const dsn = utils.makeDsn(dsnLike);
      if (!dsn) {
        return "";
      }
      const endpoint = `${getBaseApiEndpoint(dsn)}embed/error-page/`;
      let encodedOptions = `dsn=${utils.dsnToString(dsn)}`;
      for (const key in dialogOptions) {
        if (key === "dsn") {
          continue;
        }
        if (key === "onClose") {
          continue;
        }
        if (key === "user") {
          const user = dialogOptions.user;
          if (!user) {
            continue;
          }
          if (user.name) {
            encodedOptions += `&name=${encodeURIComponent(user.name)}`;
          }
          if (user.email) {
            encodedOptions += `&email=${encodeURIComponent(user.email)}`;
          }
        } else {
          encodedOptions += `&${encodeURIComponent(key)}=${encodeURIComponent(dialogOptions[key])}`;
        }
      }
      return `${endpoint}?${encodedOptions}`;
    }
    exports.getEnvelopeEndpointWithUrlEncodedAuth = getEnvelopeEndpointWithUrlEncodedAuth;
    exports.getReportDialogEndpoint = getReportDialogEndpoint;
  }
});

// ../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/integration.js
var require_integration = __commonJS({
  "../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/integration.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var utils = require_cjs();
    var debugBuild = require_debug_build2();
    var eventProcessors = require_eventProcessors();
    var exports$1 = require_exports();
    var hub = require_hub();
    var installedIntegrations = [];
    function filterDuplicates(integrations) {
      const integrationsByName = {};
      integrations.forEach((currentInstance) => {
        const { name } = currentInstance;
        const existingInstance = integrationsByName[name];
        if (existingInstance && !existingInstance.isDefaultInstance && currentInstance.isDefaultInstance) {
          return;
        }
        integrationsByName[name] = currentInstance;
      });
      return Object.keys(integrationsByName).map((k) => integrationsByName[k]);
    }
    function getIntegrationsToSetup(options) {
      const defaultIntegrations = options.defaultIntegrations || [];
      const userIntegrations = options.integrations;
      defaultIntegrations.forEach((integration) => {
        integration.isDefaultInstance = true;
      });
      let integrations;
      if (Array.isArray(userIntegrations)) {
        integrations = [...defaultIntegrations, ...userIntegrations];
      } else if (typeof userIntegrations === "function") {
        integrations = utils.arrayify(userIntegrations(defaultIntegrations));
      } else {
        integrations = defaultIntegrations;
      }
      const finalIntegrations = filterDuplicates(integrations);
      const debugIndex = findIndex(finalIntegrations, (integration) => integration.name === "Debug");
      if (debugIndex !== -1) {
        const [debugInstance] = finalIntegrations.splice(debugIndex, 1);
        finalIntegrations.push(debugInstance);
      }
      return finalIntegrations;
    }
    function setupIntegrations(client, integrations) {
      const integrationIndex = {};
      integrations.forEach((integration) => {
        if (integration) {
          setupIntegration(client, integration, integrationIndex);
        }
      });
      return integrationIndex;
    }
    function afterSetupIntegrations(client, integrations) {
      for (const integration of integrations) {
        if (integration && integration.afterAllSetup) {
          integration.afterAllSetup(client);
        }
      }
    }
    function setupIntegration(client, integration, integrationIndex) {
      if (integrationIndex[integration.name]) {
        debugBuild.DEBUG_BUILD && utils.logger.log(`Integration skipped because it was already installed: ${integration.name}`);
        return;
      }
      integrationIndex[integration.name] = integration;
      if (installedIntegrations.indexOf(integration.name) === -1) {
        integration.setupOnce(eventProcessors.addGlobalEventProcessor, hub.getCurrentHub);
        installedIntegrations.push(integration.name);
      }
      if (integration.setup && typeof integration.setup === "function") {
        integration.setup(client);
      }
      if (client.on && typeof integration.preprocessEvent === "function") {
        const callback = integration.preprocessEvent.bind(integration);
        client.on("preprocessEvent", (event, hint) => callback(event, hint, client));
      }
      if (client.addEventProcessor && typeof integration.processEvent === "function") {
        const callback = integration.processEvent.bind(integration);
        const processor = Object.assign((event, hint) => callback(event, hint, client), {
          id: integration.name
        });
        client.addEventProcessor(processor);
      }
      debugBuild.DEBUG_BUILD && utils.logger.log(`Integration installed: ${integration.name}`);
    }
    function addIntegration(integration) {
      const client = exports$1.getClient();
      if (!client || !client.addIntegration) {
        debugBuild.DEBUG_BUILD && utils.logger.warn(`Cannot add integration "${integration.name}" because no SDK Client is available.`);
        return;
      }
      client.addIntegration(integration);
    }
    function findIndex(arr, callback) {
      for (let i = 0; i < arr.length; i++) {
        if (callback(arr[i]) === true) {
          return i;
        }
      }
      return -1;
    }
    function convertIntegrationFnToClass(name, fn) {
      return Object.assign(
        function ConvertedIntegration(...args) {
          return fn(...args);
        },
        { id: name }
      );
    }
    function defineIntegration(fn) {
      return fn;
    }
    exports.addIntegration = addIntegration;
    exports.afterSetupIntegrations = afterSetupIntegrations;
    exports.convertIntegrationFnToClass = convertIntegrationFnToClass;
    exports.defineIntegration = defineIntegration;
    exports.getIntegrationsToSetup = getIntegrationsToSetup;
    exports.installedIntegrations = installedIntegrations;
    exports.setupIntegration = setupIntegration;
    exports.setupIntegrations = setupIntegrations;
  }
});

// ../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/metrics/utils.js
var require_utils2 = __commonJS({
  "../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/metrics/utils.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var utils = require_cjs();
    function getBucketKey(metricType, name, unit, tags) {
      const stringifiedTags = Object.entries(utils.dropUndefinedKeys(tags)).sort((a, b) => a[0].localeCompare(b[0]));
      return `${metricType}${name}${unit}${stringifiedTags}`;
    }
    function simpleHash(s) {
      let rv = 0;
      for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        rv = (rv << 5) - rv + c;
        rv &= rv;
      }
      return rv >>> 0;
    }
    function serializeMetricBuckets(metricBucketItems) {
      let out = "";
      for (const item of metricBucketItems) {
        const tagEntries = Object.entries(item.tags);
        const maybeTags = tagEntries.length > 0 ? `|#${tagEntries.map(([key, value]) => `${key}:${value}`).join(",")}` : "";
        out += `${item.name}@${item.unit}:${item.metric}|${item.metricType}${maybeTags}|T${item.timestamp}
`;
      }
      return out;
    }
    function sanitizeUnit(unit) {
      return unit.replace(/[^\w]+/gi, "_");
    }
    function sanitizeMetricKey(key) {
      return key.replace(/[^\w\-.]+/gi, "_");
    }
    function sanitizeTagKey(key) {
      return key.replace(/[^\w\-./]+/gi, "");
    }
    var tagValueReplacements = [
      ["\n", "\\n"],
      ["\r", "\\r"],
      ["	", "\\t"],
      ["\\", "\\\\"],
      ["|", "\\u{7c}"],
      [",", "\\u{2c}"]
    ];
    function getCharOrReplacement(input) {
      for (const [search, replacement] of tagValueReplacements) {
        if (input === search) {
          return replacement;
        }
      }
      return input;
    }
    function sanitizeTagValue(value) {
      return [...value].reduce((acc, char) => acc + getCharOrReplacement(char), "");
    }
    function sanitizeTags(unsanitizedTags) {
      const tags = {};
      for (const key in unsanitizedTags) {
        if (Object.prototype.hasOwnProperty.call(unsanitizedTags, key)) {
          const sanitizedKey = sanitizeTagKey(key);
          tags[sanitizedKey] = sanitizeTagValue(String(unsanitizedTags[key]));
        }
      }
      return tags;
    }
    exports.getBucketKey = getBucketKey;
    exports.sanitizeMetricKey = sanitizeMetricKey;
    exports.sanitizeTags = sanitizeTags;
    exports.sanitizeUnit = sanitizeUnit;
    exports.serializeMetricBuckets = serializeMetricBuckets;
    exports.simpleHash = simpleHash;
  }
});

// ../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/metrics/envelope.js
var require_envelope3 = __commonJS({
  "../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/metrics/envelope.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var utils = require_cjs();
    var utils$1 = require_utils2();
    function createMetricEnvelope(metricBucketItems, dsn, metadata, tunnel) {
      const headers = {
        sent_at: (/* @__PURE__ */ new Date()).toISOString()
      };
      if (metadata && metadata.sdk) {
        headers.sdk = {
          name: metadata.sdk.name,
          version: metadata.sdk.version
        };
      }
      if (!!tunnel && dsn) {
        headers.dsn = utils.dsnToString(dsn);
      }
      const item = createMetricEnvelopeItem(metricBucketItems);
      return utils.createEnvelope(headers, [item]);
    }
    function createMetricEnvelopeItem(metricBucketItems) {
      const payload = utils$1.serializeMetricBuckets(metricBucketItems);
      const metricHeaders = {
        type: "statsd",
        length: payload.length
      };
      return [metricHeaders, payload];
    }
    exports.createMetricEnvelope = createMetricEnvelope;
  }
});

// ../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/baseclient.js
var require_baseclient = __commonJS({
  "../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/baseclient.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var utils = require_cjs();
    var api = require_api();
    var debugBuild = require_debug_build2();
    var envelope = require_envelope2();
    var exports$1 = require_exports();
    var hub = require_hub();
    var integration = require_integration();
    var envelope$1 = require_envelope3();
    var session = require_session();
    var dynamicSamplingContext = require_dynamicSamplingContext();
    var prepareEvent = require_prepareEvent();
    var ALREADY_SEEN_ERROR = "Not capturing exception because it's already been captured.";
    var BaseClient = class {
      /**
       * A reference to a metrics aggregator
       *
       * @experimental Note this is alpha API. It may experience breaking changes in the future.
       */
      /** Options passed to the SDK. */
      /** The client Dsn, if specified in options. Without this Dsn, the SDK will be disabled. */
      /** Array of set up integrations. */
      /** Indicates whether this client's integrations have been set up. */
      /** Number of calls being processed */
      /** Holds flushable  */
      // eslint-disable-next-line @typescript-eslint/ban-types
      /**
       * Initializes this client instance.
       *
       * @param options Options for the client.
       */
      constructor(options) {
        this._options = options;
        this._integrations = {};
        this._integrationsInitialized = false;
        this._numProcessing = 0;
        this._outcomes = {};
        this._hooks = {};
        this._eventProcessors = [];
        if (options.dsn) {
          this._dsn = utils.makeDsn(options.dsn);
        } else {
          debugBuild.DEBUG_BUILD && utils.logger.warn("No DSN provided, client will not send events.");
        }
        if (this._dsn) {
          const url = api.getEnvelopeEndpointWithUrlEncodedAuth(this._dsn, options);
          this._transport = options.transport({
            tunnel: this._options.tunnel,
            recordDroppedEvent: this.recordDroppedEvent.bind(this),
            ...options.transportOptions,
            url
          });
        }
      }
      /**
       * @inheritDoc
       */
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/explicit-module-boundary-types
      captureException(exception, hint, scope) {
        if (utils.checkOrSetAlreadyCaught(exception)) {
          debugBuild.DEBUG_BUILD && utils.logger.log(ALREADY_SEEN_ERROR);
          return;
        }
        let eventId = hint && hint.event_id;
        this._process(
          this.eventFromException(exception, hint).then((event) => this._captureEvent(event, hint, scope)).then((result) => {
            eventId = result;
          })
        );
        return eventId;
      }
      /**
       * @inheritDoc
       */
      captureMessage(message, level, hint, scope) {
        let eventId = hint && hint.event_id;
        const eventMessage = utils.isParameterizedString(message) ? message : String(message);
        const promisedEvent = utils.isPrimitive(message) ? this.eventFromMessage(eventMessage, level, hint) : this.eventFromException(message, hint);
        this._process(
          promisedEvent.then((event) => this._captureEvent(event, hint, scope)).then((result) => {
            eventId = result;
          })
        );
        return eventId;
      }
      /**
       * @inheritDoc
       */
      captureEvent(event, hint, scope) {
        if (hint && hint.originalException && utils.checkOrSetAlreadyCaught(hint.originalException)) {
          debugBuild.DEBUG_BUILD && utils.logger.log(ALREADY_SEEN_ERROR);
          return;
        }
        let eventId = hint && hint.event_id;
        const sdkProcessingMetadata = event.sdkProcessingMetadata || {};
        const capturedSpanScope = sdkProcessingMetadata.capturedSpanScope;
        this._process(
          this._captureEvent(event, hint, capturedSpanScope || scope).then((result) => {
            eventId = result;
          })
        );
        return eventId;
      }
      /**
       * @inheritDoc
       */
      captureSession(session$1) {
        if (!(typeof session$1.release === "string")) {
          debugBuild.DEBUG_BUILD && utils.logger.warn("Discarded session because of missing or non-string release");
        } else {
          this.sendSession(session$1);
          session.updateSession(session$1, { init: false });
        }
      }
      /**
       * @inheritDoc
       */
      getDsn() {
        return this._dsn;
      }
      /**
       * @inheritDoc
       */
      getOptions() {
        return this._options;
      }
      /**
       * @see SdkMetadata in @sentry/types
       *
       * @return The metadata of the SDK
       */
      getSdkMetadata() {
        return this._options._metadata;
      }
      /**
       * @inheritDoc
       */
      getTransport() {
        return this._transport;
      }
      /**
       * @inheritDoc
       */
      flush(timeout) {
        const transport = this._transport;
        if (transport) {
          if (this.metricsAggregator) {
            this.metricsAggregator.flush();
          }
          return this._isClientDoneProcessing(timeout).then((clientFinished) => {
            return transport.flush(timeout).then((transportFlushed) => clientFinished && transportFlushed);
          });
        } else {
          return utils.resolvedSyncPromise(true);
        }
      }
      /**
       * @inheritDoc
       */
      close(timeout) {
        return this.flush(timeout).then((result) => {
          this.getOptions().enabled = false;
          if (this.metricsAggregator) {
            this.metricsAggregator.close();
          }
          return result;
        });
      }
      /** Get all installed event processors. */
      getEventProcessors() {
        return this._eventProcessors;
      }
      /** @inheritDoc */
      addEventProcessor(eventProcessor) {
        this._eventProcessors.push(eventProcessor);
      }
      /**
       * This is an internal function to setup all integrations that should run on the client.
       * @deprecated Use `client.init()` instead.
       */
      setupIntegrations(forceInitialize) {
        if (forceInitialize && !this._integrationsInitialized || this._isEnabled() && !this._integrationsInitialized) {
          this._setupIntegrations();
        }
      }
      /** @inheritdoc */
      init() {
        if (this._isEnabled()) {
          this._setupIntegrations();
        }
      }
      /**
       * Gets an installed integration by its `id`.
       *
       * @returns The installed integration or `undefined` if no integration with that `id` was installed.
       * @deprecated Use `getIntegrationByName()` instead.
       */
      getIntegrationById(integrationId) {
        return this.getIntegrationByName(integrationId);
      }
      /**
       * Gets an installed integration by its name.
       *
       * @returns The installed integration or `undefined` if no integration with that `name` was installed.
       */
      getIntegrationByName(integrationName) {
        return this._integrations[integrationName];
      }
      /**
       * Returns the client's instance of the given integration class, it any.
       * @deprecated Use `getIntegrationByName()` instead.
       */
      getIntegration(integration2) {
        try {
          return this._integrations[integration2.id] || null;
        } catch (_oO) {
          debugBuild.DEBUG_BUILD && utils.logger.warn(`Cannot retrieve integration ${integration2.id} from the current Client`);
          return null;
        }
      }
      /**
       * @inheritDoc
       */
      addIntegration(integration$1) {
        const isAlreadyInstalled = this._integrations[integration$1.name];
        integration.setupIntegration(this, integration$1, this._integrations);
        if (!isAlreadyInstalled) {
          integration.afterSetupIntegrations(this, [integration$1]);
        }
      }
      /**
       * @inheritDoc
       */
      sendEvent(event, hint = {}) {
        this.emit("beforeSendEvent", event, hint);
        let env = envelope.createEventEnvelope(event, this._dsn, this._options._metadata, this._options.tunnel);
        for (const attachment of hint.attachments || []) {
          env = utils.addItemToEnvelope(
            env,
            utils.createAttachmentEnvelopeItem(
              attachment,
              this._options.transportOptions && this._options.transportOptions.textEncoder
            )
          );
        }
        const promise = this._sendEnvelope(env);
        if (promise) {
          promise.then((sendResponse) => this.emit("afterSendEvent", event, sendResponse), null);
        }
      }
      /**
       * @inheritDoc
       */
      sendSession(session2) {
        const env = envelope.createSessionEnvelope(session2, this._dsn, this._options._metadata, this._options.tunnel);
        this._sendEnvelope(env);
      }
      /**
       * @inheritDoc
       */
      recordDroppedEvent(reason, category, eventOrCount) {
        if (this._options.sendClientReports) {
          const count = typeof eventOrCount === "number" ? eventOrCount : 1;
          const key = `${reason}:${category}`;
          debugBuild.DEBUG_BUILD && utils.logger.log(`Recording outcome: "${key}"${count > 1 ? ` (${count} times)` : ""}`);
          this._outcomes[key] = (this._outcomes[key] || 0) + count;
        }
      }
      /**
       * @inheritDoc
       */
      captureAggregateMetrics(metricBucketItems) {
        debugBuild.DEBUG_BUILD && utils.logger.log(`Flushing aggregated metrics, number of metrics: ${metricBucketItems.length}`);
        const metricsEnvelope = envelope$1.createMetricEnvelope(
          metricBucketItems,
          this._dsn,
          this._options._metadata,
          this._options.tunnel
        );
        this._sendEnvelope(metricsEnvelope);
      }
      // Keep on() & emit() signatures in sync with types' client.ts interface
      /* eslint-disable @typescript-eslint/unified-signatures */
      /** @inheritdoc */
      /** @inheritdoc */
      on(hook, callback) {
        if (!this._hooks[hook]) {
          this._hooks[hook] = [];
        }
        this._hooks[hook].push(callback);
      }
      /** @inheritdoc */
      /** @inheritdoc */
      emit(hook, ...rest) {
        if (this._hooks[hook]) {
          this._hooks[hook].forEach((callback) => callback(...rest));
        }
      }
      /* eslint-enable @typescript-eslint/unified-signatures */
      /** Setup integrations for this client. */
      _setupIntegrations() {
        const { integrations } = this._options;
        this._integrations = integration.setupIntegrations(this, integrations);
        integration.afterSetupIntegrations(this, integrations);
        this._integrationsInitialized = true;
      }
      /** Updates existing session based on the provided event */
      _updateSessionFromEvent(session$1, event) {
        let crashed = false;
        let errored = false;
        const exceptions = event.exception && event.exception.values;
        if (exceptions) {
          errored = true;
          for (const ex of exceptions) {
            const mechanism = ex.mechanism;
            if (mechanism && mechanism.handled === false) {
              crashed = true;
              break;
            }
          }
        }
        const sessionNonTerminal = session$1.status === "ok";
        const shouldUpdateAndSend = sessionNonTerminal && session$1.errors === 0 || sessionNonTerminal && crashed;
        if (shouldUpdateAndSend) {
          session.updateSession(session$1, {
            ...crashed && { status: "crashed" },
            errors: session$1.errors || Number(errored || crashed)
          });
          this.captureSession(session$1);
        }
      }
      /**
       * Determine if the client is finished processing. Returns a promise because it will wait `timeout` ms before saying
       * "no" (resolving to `false`) in order to give the client a chance to potentially finish first.
       *
       * @param timeout The time, in ms, after which to resolve to `false` if the client is still busy. Passing `0` (or not
       * passing anything) will make the promise wait as long as it takes for processing to finish before resolving to
       * `true`.
       * @returns A promise which will resolve to `true` if processing is already done or finishes before the timeout, and
       * `false` otherwise
       */
      _isClientDoneProcessing(timeout) {
        return new utils.SyncPromise((resolve) => {
          let ticked = 0;
          const tick = 1;
          const interval = setInterval(() => {
            if (this._numProcessing == 0) {
              clearInterval(interval);
              resolve(true);
            } else {
              ticked += tick;
              if (timeout && ticked >= timeout) {
                clearInterval(interval);
                resolve(false);
              }
            }
          }, tick);
        });
      }
      /** Determines whether this SDK is enabled and a transport is present. */
      _isEnabled() {
        return this.getOptions().enabled !== false && this._transport !== void 0;
      }
      /**
       * Adds common information to events.
       *
       * The information includes release and environment from `options`,
       * breadcrumbs and context (extra, tags and user) from the scope.
       *
       * Information that is already present in the event is never overwritten. For
       * nested objects, such as the context, keys are merged.
       *
       * @param event The original event.
       * @param hint May contain additional information about the original exception.
       * @param scope A scope containing event metadata.
       * @returns A new event with more information.
       */
      _prepareEvent(event, hint, scope, isolationScope = hub.getIsolationScope()) {
        const options = this.getOptions();
        const integrations = Object.keys(this._integrations);
        if (!hint.integrations && integrations.length > 0) {
          hint.integrations = integrations;
        }
        this.emit("preprocessEvent", event, hint);
        return prepareEvent.prepareEvent(options, event, hint, scope, this, isolationScope).then((evt) => {
          if (evt === null) {
            return evt;
          }
          const propagationContext = {
            ...isolationScope.getPropagationContext(),
            ...scope ? scope.getPropagationContext() : void 0
          };
          const trace = evt.contexts && evt.contexts.trace;
          if (!trace && propagationContext) {
            const { traceId: trace_id, spanId, parentSpanId, dsc } = propagationContext;
            evt.contexts = {
              trace: {
                trace_id,
                span_id: spanId,
                parent_span_id: parentSpanId
              },
              ...evt.contexts
            };
            const dynamicSamplingContext$1 = dsc ? dsc : dynamicSamplingContext.getDynamicSamplingContextFromClient(trace_id, this, scope);
            evt.sdkProcessingMetadata = {
              dynamicSamplingContext: dynamicSamplingContext$1,
              ...evt.sdkProcessingMetadata
            };
          }
          return evt;
        });
      }
      /**
       * Processes the event and logs an error in case of rejection
       * @param event
       * @param hint
       * @param scope
       */
      _captureEvent(event, hint = {}, scope) {
        return this._processEvent(event, hint, scope).then(
          (finalEvent) => {
            return finalEvent.event_id;
          },
          (reason) => {
            if (debugBuild.DEBUG_BUILD) {
              const sentryError = reason;
              if (sentryError.logLevel === "log") {
                utils.logger.log(sentryError.message);
              } else {
                utils.logger.warn(sentryError);
              }
            }
            return void 0;
          }
        );
      }
      /**
       * Processes an event (either error or message) and sends it to Sentry.
       *
       * This also adds breadcrumbs and context information to the event. However,
       * platform specific meta data (such as the User's IP address) must be added
       * by the SDK implementor.
       *
       *
       * @param event The event to send to Sentry.
       * @param hint May contain additional information about the original exception.
       * @param scope A scope containing event metadata.
       * @returns A SyncPromise that resolves with the event or rejects in case event was/will not be send.
       */
      _processEvent(event, hint, scope) {
        const options = this.getOptions();
        const { sampleRate } = options;
        const isTransaction = isTransactionEvent(event);
        const isError = isErrorEvent(event);
        const eventType = event.type || "error";
        const beforeSendLabel = `before send for type \`${eventType}\``;
        if (isError && typeof sampleRate === "number" && Math.random() > sampleRate) {
          this.recordDroppedEvent("sample_rate", "error", event);
          return utils.rejectedSyncPromise(
            new utils.SentryError(
              `Discarding event because it's not included in the random sample (sampling rate = ${sampleRate})`,
              "log"
            )
          );
        }
        const dataCategory = eventType === "replay_event" ? "replay" : eventType;
        const sdkProcessingMetadata = event.sdkProcessingMetadata || {};
        const capturedSpanIsolationScope = sdkProcessingMetadata.capturedSpanIsolationScope;
        return this._prepareEvent(event, hint, scope, capturedSpanIsolationScope).then((prepared) => {
          if (prepared === null) {
            this.recordDroppedEvent("event_processor", dataCategory, event);
            throw new utils.SentryError("An event processor returned `null`, will not send event.", "log");
          }
          const isInternalException = hint.data && hint.data.__sentry__ === true;
          if (isInternalException) {
            return prepared;
          }
          const result = processBeforeSend(options, prepared, hint);
          return _validateBeforeSendResult(result, beforeSendLabel);
        }).then((processedEvent) => {
          if (processedEvent === null) {
            this.recordDroppedEvent("before_send", dataCategory, event);
            if (isTransaction) {
              const spans = event.spans || [];
              const spanCount = 1 + spans.length;
              this.recordDroppedEvent("before_send", "span", spanCount);
            }
            throw new utils.SentryError(`${beforeSendLabel} returned \`null\`, will not send event.`, "log");
          }
          const session2 = scope && scope.getSession();
          if (!isTransaction && session2) {
            this._updateSessionFromEvent(session2, processedEvent);
          }
          if (isTransaction) {
            const spanCountBefore = processedEvent.sdkProcessingMetadata && processedEvent.sdkProcessingMetadata.spanCountBeforeProcessing || 0;
            const spanCountAfter = processedEvent.spans ? processedEvent.spans.length : 0;
            const droppedSpanCount = spanCountBefore - spanCountAfter;
            if (droppedSpanCount > 0) {
              this.recordDroppedEvent("before_send", "span", droppedSpanCount);
            }
          }
          const transactionInfo = processedEvent.transaction_info;
          if (isTransaction && transactionInfo && processedEvent.transaction !== event.transaction) {
            const source = "custom";
            processedEvent.transaction_info = {
              ...transactionInfo,
              source
            };
          }
          this.sendEvent(processedEvent, hint);
          return processedEvent;
        }).then(null, (reason) => {
          if (reason instanceof utils.SentryError) {
            throw reason;
          }
          this.captureException(reason, {
            data: {
              __sentry__: true
            },
            originalException: reason
          });
          throw new utils.SentryError(
            `Event processing pipeline threw an error, original event will not be sent. Details have been sent as a new event.
Reason: ${reason}`
          );
        });
      }
      /**
       * Occupies the client with processing and event
       */
      _process(promise) {
        this._numProcessing++;
        void promise.then(
          (value) => {
            this._numProcessing--;
            return value;
          },
          (reason) => {
            this._numProcessing--;
            return reason;
          }
        );
      }
      /**
       * @inheritdoc
       */
      _sendEnvelope(envelope2) {
        this.emit("beforeEnvelope", envelope2);
        if (this._isEnabled() && this._transport) {
          return this._transport.send(envelope2).then(null, (reason) => {
            debugBuild.DEBUG_BUILD && utils.logger.error("Error while sending event:", reason);
          });
        } else {
          debugBuild.DEBUG_BUILD && utils.logger.error("Transport disabled");
        }
      }
      /**
       * Clears outcomes on this client and returns them.
       */
      _clearOutcomes() {
        const outcomes = this._outcomes;
        this._outcomes = {};
        return Object.keys(outcomes).map((key) => {
          const [reason, category] = key.split(":");
          return {
            reason,
            category,
            quantity: outcomes[key]
          };
        });
      }
      /**
       * @inheritDoc
       */
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/explicit-module-boundary-types
    };
    function _validateBeforeSendResult(beforeSendResult, beforeSendLabel) {
      const invalidValueError = `${beforeSendLabel} must return \`null\` or a valid event.`;
      if (utils.isThenable(beforeSendResult)) {
        return beforeSendResult.then(
          (event) => {
            if (!utils.isPlainObject(event) && event !== null) {
              throw new utils.SentryError(invalidValueError);
            }
            return event;
          },
          (e) => {
            throw new utils.SentryError(`${beforeSendLabel} rejected with ${e}`);
          }
        );
      } else if (!utils.isPlainObject(beforeSendResult) && beforeSendResult !== null) {
        throw new utils.SentryError(invalidValueError);
      }
      return beforeSendResult;
    }
    function processBeforeSend(options, event, hint) {
      const { beforeSend, beforeSendTransaction } = options;
      if (isErrorEvent(event) && beforeSend) {
        return beforeSend(event, hint);
      }
      if (isTransactionEvent(event) && beforeSendTransaction) {
        if (event.spans) {
          const spanCountBefore = event.spans.length;
          event.sdkProcessingMetadata = {
            ...event.sdkProcessingMetadata,
            spanCountBeforeProcessing: spanCountBefore
          };
        }
        return beforeSendTransaction(event, hint);
      }
      return event;
    }
    function isErrorEvent(event) {
      return event.type === void 0;
    }
    function isTransactionEvent(event) {
      return event.type === "transaction";
    }
    function addEventProcessor(callback) {
      const client = exports$1.getClient();
      if (!client || !client.addEventProcessor) {
        return;
      }
      client.addEventProcessor(callback);
    }
    exports.BaseClient = BaseClient;
    exports.addEventProcessor = addEventProcessor;
  }
});

// ../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/checkin.js
var require_checkin = __commonJS({
  "../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/checkin.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var utils = require_cjs();
    function createCheckInEnvelope(checkIn, dynamicSamplingContext, metadata, tunnel, dsn) {
      const headers = {
        sent_at: (/* @__PURE__ */ new Date()).toISOString()
      };
      if (metadata && metadata.sdk) {
        headers.sdk = {
          name: metadata.sdk.name,
          version: metadata.sdk.version
        };
      }
      if (!!tunnel && !!dsn) {
        headers.dsn = utils.dsnToString(dsn);
      }
      if (dynamicSamplingContext) {
        headers.trace = utils.dropUndefinedKeys(dynamicSamplingContext);
      }
      const item = createCheckInEnvelopeItem(checkIn);
      return utils.createEnvelope(headers, [item]);
    }
    function createCheckInEnvelopeItem(checkIn) {
      const checkInHeaders = {
        type: "check_in"
      };
      return [checkInHeaders, checkIn];
    }
    exports.createCheckInEnvelope = createCheckInEnvelope;
  }
});

// ../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/metrics/constants.js
var require_constants2 = __commonJS({
  "../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/metrics/constants.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var COUNTER_METRIC_TYPE = "c";
    var GAUGE_METRIC_TYPE = "g";
    var SET_METRIC_TYPE = "s";
    var DISTRIBUTION_METRIC_TYPE = "d";
    var DEFAULT_BROWSER_FLUSH_INTERVAL = 5e3;
    var DEFAULT_FLUSH_INTERVAL = 1e4;
    var MAX_WEIGHT = 1e4;
    exports.COUNTER_METRIC_TYPE = COUNTER_METRIC_TYPE;
    exports.DEFAULT_BROWSER_FLUSH_INTERVAL = DEFAULT_BROWSER_FLUSH_INTERVAL;
    exports.DEFAULT_FLUSH_INTERVAL = DEFAULT_FLUSH_INTERVAL;
    exports.DISTRIBUTION_METRIC_TYPE = DISTRIBUTION_METRIC_TYPE;
    exports.GAUGE_METRIC_TYPE = GAUGE_METRIC_TYPE;
    exports.MAX_WEIGHT = MAX_WEIGHT;
    exports.SET_METRIC_TYPE = SET_METRIC_TYPE;
  }
});

// ../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/metrics/instance.js
var require_instance = __commonJS({
  "../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/metrics/instance.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var constants = require_constants2();
    var utils = require_utils2();
    var CounterMetric = class {
      constructor(_value) {
        this._value = _value;
      }
      /** @inheritDoc */
      get weight() {
        return 1;
      }
      /** @inheritdoc */
      add(value) {
        this._value += value;
      }
      /** @inheritdoc */
      toString() {
        return `${this._value}`;
      }
    };
    var GaugeMetric = class {
      constructor(value) {
        this._last = value;
        this._min = value;
        this._max = value;
        this._sum = value;
        this._count = 1;
      }
      /** @inheritDoc */
      get weight() {
        return 5;
      }
      /** @inheritdoc */
      add(value) {
        this._last = value;
        if (value < this._min) {
          this._min = value;
        }
        if (value > this._max) {
          this._max = value;
        }
        this._sum += value;
        this._count++;
      }
      /** @inheritdoc */
      toString() {
        return `${this._last}:${this._min}:${this._max}:${this._sum}:${this._count}`;
      }
    };
    var DistributionMetric = class {
      constructor(first) {
        this._value = [first];
      }
      /** @inheritDoc */
      get weight() {
        return this._value.length;
      }
      /** @inheritdoc */
      add(value) {
        this._value.push(value);
      }
      /** @inheritdoc */
      toString() {
        return this._value.join(":");
      }
    };
    var SetMetric = class {
      constructor(first) {
        this.first = first;
        this._value = /* @__PURE__ */ new Set([first]);
      }
      /** @inheritDoc */
      get weight() {
        return this._value.size;
      }
      /** @inheritdoc */
      add(value) {
        this._value.add(value);
      }
      /** @inheritdoc */
      toString() {
        return Array.from(this._value).map((val) => typeof val === "string" ? utils.simpleHash(val) : val).join(":");
      }
    };
    var METRIC_MAP = {
      [constants.COUNTER_METRIC_TYPE]: CounterMetric,
      [constants.GAUGE_METRIC_TYPE]: GaugeMetric,
      [constants.DISTRIBUTION_METRIC_TYPE]: DistributionMetric,
      [constants.SET_METRIC_TYPE]: SetMetric
    };
    exports.CounterMetric = CounterMetric;
    exports.DistributionMetric = DistributionMetric;
    exports.GaugeMetric = GaugeMetric;
    exports.METRIC_MAP = METRIC_MAP;
    exports.SetMetric = SetMetric;
  }
});

// ../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/metrics/aggregator.js
var require_aggregator = __commonJS({
  "../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/metrics/aggregator.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var utils$1 = require_cjs();
    var constants = require_constants2();
    var instance = require_instance();
    var metricSummary = require_metric_summary();
    var utils = require_utils2();
    var MetricsAggregator = class {
      // TODO(@anonrig): Use FinalizationRegistry to have a proper way of flushing the buckets
      // when the aggregator is garbage collected.
      // Ref: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/FinalizationRegistry
      // Different metrics have different weights. We use this to limit the number of metrics
      // that we store in memory.
      // Cast to any so that it can use Node.js timeout
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      // SDKs are required to shift the flush interval by random() * rollup_in_seconds.
      // That shift is determined once per startup to create jittering.
      // An SDK is required to perform force flushing ahead of scheduled time if the memory
      // pressure is too high. There is no rule for this other than that SDKs should be tracking
      // abstract aggregation complexity (eg: a counter only carries a single float, whereas a
      // distribution is a float per emission).
      //
      // Force flush is used on either shutdown, flush() or when we exceed the max weight.
      constructor(_client) {
        this._client = _client;
        this._buckets = /* @__PURE__ */ new Map();
        this._bucketsTotalWeight = 0;
        this._interval = setInterval(() => this._flush(), constants.DEFAULT_FLUSH_INTERVAL);
        if (this._interval.unref) {
          this._interval.unref();
        }
        this._flushShift = Math.floor(Math.random() * constants.DEFAULT_FLUSH_INTERVAL / 1e3);
        this._forceFlush = false;
      }
      /**
       * @inheritDoc
       */
      add(metricType, unsanitizedName, value, unsanitizedUnit = "none", unsanitizedTags = {}, maybeFloatTimestamp = utils$1.timestampInSeconds()) {
        const timestamp = Math.floor(maybeFloatTimestamp);
        const name = utils.sanitizeMetricKey(unsanitizedName);
        const tags = utils.sanitizeTags(unsanitizedTags);
        const unit = utils.sanitizeUnit(unsanitizedUnit);
        const bucketKey = utils.getBucketKey(metricType, name, unit, tags);
        let bucketItem = this._buckets.get(bucketKey);
        const previousWeight = bucketItem && metricType === constants.SET_METRIC_TYPE ? bucketItem.metric.weight : 0;
        if (bucketItem) {
          bucketItem.metric.add(value);
          if (bucketItem.timestamp < timestamp) {
            bucketItem.timestamp = timestamp;
          }
        } else {
          bucketItem = {
            // @ts-expect-error we don't need to narrow down the type of value here, saves bundle size.
            metric: new instance.METRIC_MAP[metricType](value),
            timestamp,
            metricType,
            name,
            unit,
            tags
          };
          this._buckets.set(bucketKey, bucketItem);
        }
        const val = typeof value === "string" ? bucketItem.metric.weight - previousWeight : value;
        metricSummary.updateMetricSummaryOnActiveSpan(metricType, name, val, unit, unsanitizedTags, bucketKey);
        this._bucketsTotalWeight += bucketItem.metric.weight;
        if (this._bucketsTotalWeight >= constants.MAX_WEIGHT) {
          this.flush();
        }
      }
      /**
       * Flushes the current metrics to the transport via the transport.
       */
      flush() {
        this._forceFlush = true;
        this._flush();
      }
      /**
       * Shuts down metrics aggregator and clears all metrics.
       */
      close() {
        this._forceFlush = true;
        clearInterval(this._interval);
        this._flush();
      }
      /**
       * Flushes the buckets according to the internal state of the aggregator.
       * If it is a force flush, which happens on shutdown, it will flush all buckets.
       * Otherwise, it will only flush buckets that are older than the flush interval,
       * and according to the flush shift.
       *
       * This function mutates `_forceFlush` and `_bucketsTotalWeight` properties.
       */
      _flush() {
        if (this._forceFlush) {
          this._forceFlush = false;
          this._bucketsTotalWeight = 0;
          this._captureMetrics(this._buckets);
          this._buckets.clear();
          return;
        }
        const cutoffSeconds = Math.floor(utils$1.timestampInSeconds()) - constants.DEFAULT_FLUSH_INTERVAL / 1e3 - this._flushShift;
        const flushedBuckets = /* @__PURE__ */ new Map();
        for (const [key, bucket] of this._buckets) {
          if (bucket.timestamp <= cutoffSeconds) {
            flushedBuckets.set(key, bucket);
            this._bucketsTotalWeight -= bucket.metric.weight;
          }
        }
        for (const [key] of flushedBuckets) {
          this._buckets.delete(key);
        }
        this._captureMetrics(flushedBuckets);
      }
      /**
       * Only captures a subset of the buckets passed to this function.
       * @param flushedBuckets
       */
      _captureMetrics(flushedBuckets) {
        if (flushedBuckets.size > 0 && this._client.captureAggregateMetrics) {
          const buckets = Array.from(flushedBuckets).map(([, bucketItem]) => bucketItem);
          this._client.captureAggregateMetrics(buckets);
        }
      }
    };
    exports.MetricsAggregator = MetricsAggregator;
  }
});

// ../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/server-runtime-client.js
var require_server_runtime_client = __commonJS({
  "../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/server-runtime-client.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var utils = require_cjs();
    var baseclient = require_baseclient();
    var checkin = require_checkin();
    var debugBuild = require_debug_build2();
    var exports$1 = require_exports();
    var aggregator = require_aggregator();
    var sessionflusher = require_sessionflusher();
    var hubextensions = require_hubextensions();
    var spanUtils = require_spanUtils();
    var getRootSpan = require_getRootSpan();
    require_spanstatus();
    var dynamicSamplingContext = require_dynamicSamplingContext();
    var ServerRuntimeClient = class extends baseclient.BaseClient {
      /**
       * Creates a new Edge SDK instance.
       * @param options Configuration options for this SDK.
       */
      constructor(options) {
        hubextensions.addTracingExtensions();
        super(options);
        if (options._experiments && options._experiments["metricsAggregator"]) {
          this.metricsAggregator = new aggregator.MetricsAggregator(this);
        }
      }
      /**
       * @inheritDoc
       */
      eventFromException(exception, hint) {
        return utils.resolvedSyncPromise(utils.eventFromUnknownInput(exports$1.getClient(), this._options.stackParser, exception, hint));
      }
      /**
       * @inheritDoc
       */
      eventFromMessage(message, level = "info", hint) {
        return utils.resolvedSyncPromise(
          utils.eventFromMessage(this._options.stackParser, message, level, hint, this._options.attachStacktrace)
        );
      }
      /**
       * @inheritDoc
       */
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/explicit-module-boundary-types
      captureException(exception, hint, scope) {
        if (this._options.autoSessionTracking && this._sessionFlusher && scope) {
          const requestSession = scope.getRequestSession();
          if (requestSession && requestSession.status === "ok") {
            requestSession.status = "errored";
          }
        }
        return super.captureException(exception, hint, scope);
      }
      /**
       * @inheritDoc
       */
      captureEvent(event, hint, scope) {
        if (this._options.autoSessionTracking && this._sessionFlusher && scope) {
          const eventType = event.type || "exception";
          const isException = eventType === "exception" && event.exception && event.exception.values && event.exception.values.length > 0;
          if (isException) {
            const requestSession = scope.getRequestSession();
            if (requestSession && requestSession.status === "ok") {
              requestSession.status = "errored";
            }
          }
        }
        return super.captureEvent(event, hint, scope);
      }
      /**
       *
       * @inheritdoc
       */
      close(timeout) {
        if (this._sessionFlusher) {
          this._sessionFlusher.close();
        }
        return super.close(timeout);
      }
      /** Method that initialises an instance of SessionFlusher on Client */
      initSessionFlusher() {
        const { release, environment } = this._options;
        if (!release) {
          debugBuild.DEBUG_BUILD && utils.logger.warn("Cannot initialise an instance of SessionFlusher if no release is provided!");
        } else {
          this._sessionFlusher = new sessionflusher.SessionFlusher(this, {
            release,
            environment
          });
        }
      }
      /**
       * Create a cron monitor check in and send it to Sentry.
       *
       * @param checkIn An object that describes a check in.
       * @param upsertMonitorConfig An optional object that describes a monitor config. Use this if you want
       * to create a monitor automatically when sending a check in.
       */
      captureCheckIn(checkIn, monitorConfig, scope) {
        const id = "checkInId" in checkIn && checkIn.checkInId ? checkIn.checkInId : utils.uuid4();
        if (!this._isEnabled()) {
          debugBuild.DEBUG_BUILD && utils.logger.warn("SDK not enabled, will not capture checkin.");
          return id;
        }
        const options = this.getOptions();
        const { release, environment, tunnel } = options;
        const serializedCheckIn = {
          check_in_id: id,
          monitor_slug: checkIn.monitorSlug,
          status: checkIn.status,
          release,
          environment
        };
        if ("duration" in checkIn) {
          serializedCheckIn.duration = checkIn.duration;
        }
        if (monitorConfig) {
          serializedCheckIn.monitor_config = {
            schedule: monitorConfig.schedule,
            checkin_margin: monitorConfig.checkinMargin,
            max_runtime: monitorConfig.maxRuntime,
            timezone: monitorConfig.timezone
          };
        }
        const [dynamicSamplingContext2, traceContext] = this._getTraceInfoFromScope(scope);
        if (traceContext) {
          serializedCheckIn.contexts = {
            trace: traceContext
          };
        }
        const envelope = checkin.createCheckInEnvelope(
          serializedCheckIn,
          dynamicSamplingContext2,
          this.getSdkMetadata(),
          tunnel,
          this.getDsn()
        );
        debugBuild.DEBUG_BUILD && utils.logger.info("Sending checkin:", checkIn.monitorSlug, checkIn.status);
        this._sendEnvelope(envelope);
        return id;
      }
      /**
       * Method responsible for capturing/ending a request session by calling `incrementSessionStatusCount` to increment
       * appropriate session aggregates bucket
       */
      _captureRequestSession() {
        if (!this._sessionFlusher) {
          debugBuild.DEBUG_BUILD && utils.logger.warn("Discarded request mode session because autoSessionTracking option was disabled");
        } else {
          this._sessionFlusher.incrementSessionStatusCount();
        }
      }
      /**
       * @inheritDoc
       */
      _prepareEvent(event, hint, scope, isolationScope) {
        if (this._options.platform) {
          event.platform = event.platform || this._options.platform;
        }
        if (this._options.runtime) {
          event.contexts = {
            ...event.contexts,
            runtime: (event.contexts || {}).runtime || this._options.runtime
          };
        }
        if (this._options.serverName) {
          event.server_name = event.server_name || this._options.serverName;
        }
        return super._prepareEvent(event, hint, scope, isolationScope);
      }
      /** Extract trace information from scope */
      _getTraceInfoFromScope(scope) {
        if (!scope) {
          return [void 0, void 0];
        }
        const span = scope.getSpan();
        if (span) {
          const samplingContext = getRootSpan.getRootSpan(span) ? dynamicSamplingContext.getDynamicSamplingContextFromSpan(span) : void 0;
          return [samplingContext, spanUtils.spanToTraceContext(span)];
        }
        const { traceId, spanId, parentSpanId, dsc } = scope.getPropagationContext();
        const traceContext = {
          trace_id: traceId,
          span_id: spanId,
          parent_span_id: parentSpanId
        };
        if (dsc) {
          return [dsc, traceContext];
        }
        return [dynamicSamplingContext.getDynamicSamplingContextFromClient(traceId, this, scope), traceContext];
      }
    };
    exports.ServerRuntimeClient = ServerRuntimeClient;
  }
});

// ../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/sdk.js
var require_sdk = __commonJS({
  "../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/sdk.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var utils = require_cjs();
    var debugBuild = require_debug_build2();
    var exports$1 = require_exports();
    var hub = require_hub();
    function initAndBind(clientClass, options) {
      if (options.debug === true) {
        if (debugBuild.DEBUG_BUILD) {
          utils.logger.enable();
        } else {
          utils.consoleSandbox(() => {
            console.warn("[Sentry] Cannot initialize SDK with `debug` option using a non-debug bundle.");
          });
        }
      }
      const scope = exports$1.getCurrentScope();
      scope.update(options.initialScope);
      const client = new clientClass(options);
      setCurrentClient(client);
      initializeClient(client);
    }
    function setCurrentClient(client) {
      const hub$1 = hub.getCurrentHub();
      const top = hub$1.getStackTop();
      top.client = client;
      top.scope.setClient(client);
    }
    function initializeClient(client) {
      if (client.init) {
        client.init();
      } else if (client.setupIntegrations) {
        client.setupIntegrations();
      }
    }
    exports.initAndBind = initAndBind;
    exports.setCurrentClient = setCurrentClient;
  }
});

// ../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/transports/base.js
var require_base = __commonJS({
  "../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/transports/base.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var utils = require_cjs();
    var debugBuild = require_debug_build2();
    var DEFAULT_TRANSPORT_BUFFER_SIZE = 30;
    function createTransport(options, makeRequest, buffer = utils.makePromiseBuffer(
      options.bufferSize || DEFAULT_TRANSPORT_BUFFER_SIZE
    )) {
      let rateLimits = {};
      const flush = (timeout) => buffer.drain(timeout);
      function send(envelope) {
        const filteredEnvelopeItems = [];
        utils.forEachEnvelopeItem(envelope, (item, type) => {
          const dataCategory = utils.envelopeItemTypeToDataCategory(type);
          if (utils.isRateLimited(rateLimits, dataCategory)) {
            const event = getEventForEnvelopeItem(item, type);
            options.recordDroppedEvent("ratelimit_backoff", dataCategory, event);
          } else {
            filteredEnvelopeItems.push(item);
          }
        });
        if (filteredEnvelopeItems.length === 0) {
          return utils.resolvedSyncPromise();
        }
        const filteredEnvelope = utils.createEnvelope(envelope[0], filteredEnvelopeItems);
        const recordEnvelopeLoss = (reason) => {
          utils.forEachEnvelopeItem(filteredEnvelope, (item, type) => {
            const event = getEventForEnvelopeItem(item, type);
            options.recordDroppedEvent(reason, utils.envelopeItemTypeToDataCategory(type), event);
          });
        };
        const requestTask = () => makeRequest({ body: utils.serializeEnvelope(filteredEnvelope, options.textEncoder) }).then(
          (response) => {
            if (response.statusCode !== void 0 && (response.statusCode < 200 || response.statusCode >= 300)) {
              debugBuild.DEBUG_BUILD && utils.logger.warn(`Sentry responded with status code ${response.statusCode} to sent event.`);
            }
            rateLimits = utils.updateRateLimits(rateLimits, response);
            return response;
          },
          (error) => {
            recordEnvelopeLoss("network_error");
            throw error;
          }
        );
        return buffer.add(requestTask).then(
          (result) => result,
          (error) => {
            if (error instanceof utils.SentryError) {
              debugBuild.DEBUG_BUILD && utils.logger.error("Skipped sending event because buffer is full.");
              recordEnvelopeLoss("queue_overflow");
              return utils.resolvedSyncPromise();
            } else {
              throw error;
            }
          }
        );
      }
      send.__sentry__baseTransport__ = true;
      return {
        send,
        flush
      };
    }
    function getEventForEnvelopeItem(item, type) {
      if (type !== "event" && type !== "transaction") {
        return void 0;
      }
      return Array.isArray(item) ? item[1] : void 0;
    }
    exports.DEFAULT_TRANSPORT_BUFFER_SIZE = DEFAULT_TRANSPORT_BUFFER_SIZE;
    exports.createTransport = createTransport;
  }
});

// ../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/transports/offline.js
var require_offline = __commonJS({
  "../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/transports/offline.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var utils = require_cjs();
    var debugBuild = require_debug_build2();
    var MIN_DELAY = 100;
    var START_DELAY = 5e3;
    var MAX_DELAY = 36e5;
    function log(msg, error) {
      debugBuild.DEBUG_BUILD && utils.logger.info(`[Offline]: ${msg}`, error);
    }
    function makeOfflineTransport(createTransport) {
      return (options) => {
        const transport = createTransport(options);
        const store = options.createStore ? options.createStore(options) : void 0;
        let retryDelay = START_DELAY;
        let flushTimer;
        function shouldQueue(env, error, retryDelay2) {
          if (utils.envelopeContainsItemType(env, ["replay_event", "replay_recording", "client_report"])) {
            return false;
          }
          if (options.shouldStore) {
            return options.shouldStore(env, error, retryDelay2);
          }
          return true;
        }
        function flushIn(delay) {
          if (!store) {
            return;
          }
          if (flushTimer) {
            clearTimeout(flushTimer);
          }
          flushTimer = setTimeout(async () => {
            flushTimer = void 0;
            const found = await store.pop();
            if (found) {
              log("Attempting to send previously queued event");
              void send(found).catch((e) => {
                log("Failed to retry sending", e);
              });
            }
          }, delay);
          if (typeof flushTimer !== "number" && flushTimer.unref) {
            flushTimer.unref();
          }
        }
        function flushWithBackOff() {
          if (flushTimer) {
            return;
          }
          flushIn(retryDelay);
          retryDelay = Math.min(retryDelay * 2, MAX_DELAY);
        }
        async function send(envelope) {
          try {
            const result = await transport.send(envelope);
            let delay = MIN_DELAY;
            if (result) {
              if (result.headers && result.headers["retry-after"]) {
                delay = utils.parseRetryAfterHeader(result.headers["retry-after"]);
              } else if ((result.statusCode || 0) >= 400) {
                return result;
              }
            }
            flushIn(delay);
            retryDelay = START_DELAY;
            return result;
          } catch (e) {
            if (store && await shouldQueue(envelope, e, retryDelay)) {
              await store.insert(envelope);
              flushWithBackOff();
              log("Error sending. Event queued", e);
              return {};
            } else {
              throw e;
            }
          }
        }
        if (options.flushAtStartup) {
          flushWithBackOff();
        }
        return {
          send,
          flush: (t) => transport.flush(t)
        };
      };
    }
    exports.MIN_DELAY = MIN_DELAY;
    exports.START_DELAY = START_DELAY;
    exports.makeOfflineTransport = makeOfflineTransport;
  }
});

// ../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/transports/multiplexed.js
var require_multiplexed = __commonJS({
  "../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/transports/multiplexed.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var utils = require_cjs();
    var api = require_api();
    function eventFromEnvelope(env, types) {
      let event;
      utils.forEachEnvelopeItem(env, (item, type) => {
        if (types.includes(type)) {
          event = Array.isArray(item) ? item[1] : void 0;
        }
        return !!event;
      });
      return event;
    }
    function makeOverrideReleaseTransport(createTransport, release) {
      return (options) => {
        const transport = createTransport(options);
        return {
          ...transport,
          send: async (envelope) => {
            const event = eventFromEnvelope(envelope, ["event", "transaction", "profile", "replay_event"]);
            if (event) {
              event.release = release;
            }
            return transport.send(envelope);
          }
        };
      };
    }
    function overrideDsn(envelope, dsn) {
      return utils.createEnvelope(
        dsn ? {
          ...envelope[0],
          dsn
        } : envelope[0],
        envelope[1]
      );
    }
    function makeMultiplexedTransport(createTransport, matcher) {
      return (options) => {
        const fallbackTransport = createTransport(options);
        const otherTransports = /* @__PURE__ */ new Map();
        function getTransport(dsn, release) {
          const key = release ? `${dsn}:${release}` : dsn;
          let transport = otherTransports.get(key);
          if (!transport) {
            const validatedDsn = utils.dsnFromString(dsn);
            if (!validatedDsn) {
              return void 0;
            }
            const url = api.getEnvelopeEndpointWithUrlEncodedAuth(validatedDsn, options.tunnel);
            transport = release ? makeOverrideReleaseTransport(createTransport, release)({ ...options, url }) : createTransport({ ...options, url });
            otherTransports.set(key, transport);
          }
          return [dsn, transport];
        }
        async function send(envelope) {
          function getEvent(types) {
            const eventTypes = types && types.length ? types : ["event"];
            return eventFromEnvelope(envelope, eventTypes);
          }
          const transports = matcher({ envelope, getEvent }).map((result) => {
            if (typeof result === "string") {
              return getTransport(result, void 0);
            } else {
              return getTransport(result.dsn, result.release);
            }
          }).filter((t) => !!t);
          if (transports.length === 0) {
            transports.push(["", fallbackTransport]);
          }
          const results = await Promise.all(
            transports.map(([dsn, transport]) => transport.send(overrideDsn(envelope, dsn)))
          );
          return results[0];
        }
        async function flush(timeout) {
          const promises = [await fallbackTransport.flush(timeout)];
          for (const [, transport] of otherTransports) {
            promises.push(await transport.flush(timeout));
          }
          return promises.every((r) => r);
        }
        return {
          send,
          flush
        };
      };
    }
    exports.eventFromEnvelope = eventFromEnvelope;
    exports.makeMultiplexedTransport = makeMultiplexedTransport;
  }
});

// ../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/span.js
var require_span2 = __commonJS({
  "../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/span.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var utils = require_cjs();
    function createSpanEnvelope(spans, dsn) {
      const headers = {
        sent_at: (/* @__PURE__ */ new Date()).toISOString()
      };
      if (dsn) {
        headers.dsn = utils.dsnToString(dsn);
      }
      const items = spans.map(createSpanItem);
      return utils.createEnvelope(headers, items);
    }
    function createSpanItem(span) {
      const spanHeaders = {
        type: "span"
      };
      return [spanHeaders, span];
    }
    exports.createSpanEnvelope = createSpanEnvelope;
  }
});

// ../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/utils/isSentryRequestUrl.js
var require_isSentryRequestUrl = __commonJS({
  "../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/utils/isSentryRequestUrl.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    function isSentryRequestUrl(url, hubOrClient) {
      const client = hubOrClient && isHub(hubOrClient) ? (
        // eslint-disable-next-line deprecation/deprecation
        hubOrClient.getClient()
      ) : hubOrClient;
      const dsn = client && client.getDsn();
      const tunnel = client && client.getOptions().tunnel;
      return checkDsn(url, dsn) || checkTunnel(url, tunnel);
    }
    function checkTunnel(url, tunnel) {
      if (!tunnel) {
        return false;
      }
      return removeTrailingSlash(url) === removeTrailingSlash(tunnel);
    }
    function checkDsn(url, dsn) {
      return dsn ? url.includes(dsn.host) : false;
    }
    function removeTrailingSlash(str) {
      return str[str.length - 1] === "/" ? str.slice(0, -1) : str;
    }
    function isHub(hubOrClient) {
      return hubOrClient.getClient !== void 0;
    }
    exports.isSentryRequestUrl = isSentryRequestUrl;
  }
});

// ../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/utils/parameterize.js
var require_parameterize = __commonJS({
  "../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/utils/parameterize.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    function parameterize(strings, ...values) {
      const formatted = new String(String.raw(strings, ...values));
      formatted.__sentry_template_string__ = strings.join("\0").replace(/%/g, "%%").replace(/\0/g, "%s");
      formatted.__sentry_template_values__ = values;
      return formatted;
    }
    exports.parameterize = parameterize;
  }
});

// ../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/utils/sdkMetadata.js
var require_sdkMetadata = __commonJS({
  "../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/utils/sdkMetadata.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var version = require_version();
    function applySdkMetadata(options, name, names = [name], source = "npm") {
      const metadata = options._metadata || {};
      if (!metadata.sdk) {
        metadata.sdk = {
          name: `sentry.javascript.${name}`,
          packages: names.map((name2) => ({
            name: `${source}:@sentry/${name2}`,
            version: version.SDK_VERSION
          })),
          version: version.SDK_VERSION
        };
      }
      options._metadata = metadata;
    }
    exports.applySdkMetadata = applySdkMetadata;
  }
});

// ../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/metadata.js
var require_metadata = __commonJS({
  "../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/metadata.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var utils = require_cjs();
    var filenameMetadataMap = /* @__PURE__ */ new Map();
    var parsedStacks = /* @__PURE__ */ new Set();
    function ensureMetadataStacksAreParsed(parser) {
      if (!utils.GLOBAL_OBJ._sentryModuleMetadata) {
        return;
      }
      for (const stack of Object.keys(utils.GLOBAL_OBJ._sentryModuleMetadata)) {
        const metadata = utils.GLOBAL_OBJ._sentryModuleMetadata[stack];
        if (parsedStacks.has(stack)) {
          continue;
        }
        parsedStacks.add(stack);
        const frames = parser(stack);
        for (const frame of frames.reverse()) {
          if (frame.filename) {
            filenameMetadataMap.set(frame.filename, metadata);
            break;
          }
        }
      }
    }
    function getMetadataForUrl(parser, filename) {
      ensureMetadataStacksAreParsed(parser);
      return filenameMetadataMap.get(filename);
    }
    function addMetadataToStackFrames(parser, event) {
      try {
        event.exception.values.forEach((exception) => {
          if (!exception.stacktrace) {
            return;
          }
          for (const frame of exception.stacktrace.frames || []) {
            if (!frame.filename) {
              continue;
            }
            const metadata = getMetadataForUrl(parser, frame.filename);
            if (metadata) {
              frame.module_metadata = metadata;
            }
          }
        });
      } catch (_) {
      }
    }
    function stripMetadataFromStackFrames(event) {
      try {
        event.exception.values.forEach((exception) => {
          if (!exception.stacktrace) {
            return;
          }
          for (const frame of exception.stacktrace.frames || []) {
            delete frame.module_metadata;
          }
        });
      } catch (_) {
      }
    }
    exports.addMetadataToStackFrames = addMetadataToStackFrames;
    exports.getMetadataForUrl = getMetadataForUrl;
    exports.stripMetadataFromStackFrames = stripMetadataFromStackFrames;
  }
});

// ../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/integrations/metadata.js
var require_metadata2 = __commonJS({
  "../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/integrations/metadata.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var utils = require_cjs();
    var integration = require_integration();
    var metadata = require_metadata();
    var INTEGRATION_NAME = "ModuleMetadata";
    var _moduleMetadataIntegration = () => {
      return {
        name: INTEGRATION_NAME,
        // TODO v8: Remove this
        setupOnce() {
        },
        // eslint-disable-line @typescript-eslint/no-empty-function
        setup(client) {
          if (typeof client.on !== "function") {
            return;
          }
          client.on("beforeEnvelope", (envelope) => {
            utils.forEachEnvelopeItem(envelope, (item, type) => {
              if (type === "event") {
                const event = Array.isArray(item) ? item[1] : void 0;
                if (event) {
                  metadata.stripMetadataFromStackFrames(event);
                  item[1] = event;
                }
              }
            });
          });
        },
        processEvent(event, _hint, client) {
          const stackParser = client.getOptions().stackParser;
          metadata.addMetadataToStackFrames(stackParser, event);
          return event;
        }
      };
    };
    var moduleMetadataIntegration = integration.defineIntegration(_moduleMetadataIntegration);
    var ModuleMetadata = integration.convertIntegrationFnToClass(
      INTEGRATION_NAME,
      moduleMetadataIntegration
    );
    exports.ModuleMetadata = ModuleMetadata;
    exports.moduleMetadataIntegration = moduleMetadataIntegration;
  }
});

// ../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/integrations/requestdata.js
var require_requestdata2 = __commonJS({
  "../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/integrations/requestdata.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var utils = require_cjs();
    var integration = require_integration();
    var spanUtils = require_spanUtils();
    var DEFAULT_OPTIONS = {
      include: {
        cookies: true,
        data: true,
        headers: true,
        ip: false,
        query_string: true,
        url: true,
        user: {
          id: true,
          username: true,
          email: true
        }
      },
      transactionNamingScheme: "methodPath"
    };
    var INTEGRATION_NAME = "RequestData";
    var _requestDataIntegration = (options = {}) => {
      const _addRequestData = utils.addRequestDataToEvent;
      const _options = {
        ...DEFAULT_OPTIONS,
        ...options,
        include: {
          // @ts-expect-error It's mad because `method` isn't a known `include` key. (It's only here and not set by default in
          // `addRequestDataToEvent` for legacy reasons. TODO (v8): Change that.)
          method: true,
          ...DEFAULT_OPTIONS.include,
          ...options.include,
          user: options.include && typeof options.include.user === "boolean" ? options.include.user : {
            ...DEFAULT_OPTIONS.include.user,
            // Unclear why TS still thinks `options.include.user` could be a boolean at this point
            ...(options.include || {}).user
          }
        }
      };
      return {
        name: INTEGRATION_NAME,
        // TODO v8: Remove this
        setupOnce() {
        },
        // eslint-disable-line @typescript-eslint/no-empty-function
        processEvent(event, _hint, client) {
          const { transactionNamingScheme } = _options;
          const { sdkProcessingMetadata = {} } = event;
          const req = sdkProcessingMetadata.request;
          if (!req) {
            return event;
          }
          const addRequestDataOptions = sdkProcessingMetadata.requestDataOptionsFromExpressHandler || sdkProcessingMetadata.requestDataOptionsFromGCPWrapper || convertReqDataIntegrationOptsToAddReqDataOpts(_options);
          const processedEvent = _addRequestData(event, req, addRequestDataOptions);
          if (event.type === "transaction" || transactionNamingScheme === "handler") {
            return processedEvent;
          }
          const reqWithTransaction = req;
          const transaction = reqWithTransaction._sentryTransaction;
          if (transaction) {
            const name = spanUtils.spanToJSON(transaction).description || "";
            const shouldIncludeMethodInTransactionName = getSDKName(client) === "sentry.javascript.nextjs" ? name.startsWith("/api") : transactionNamingScheme !== "path";
            const [transactionValue] = utils.extractPathForTransaction(req, {
              path: true,
              method: shouldIncludeMethodInTransactionName,
              customRoute: name
            });
            processedEvent.transaction = transactionValue;
          }
          return processedEvent;
        }
      };
    };
    var requestDataIntegration = integration.defineIntegration(_requestDataIntegration);
    var RequestData = integration.convertIntegrationFnToClass(INTEGRATION_NAME, requestDataIntegration);
    function convertReqDataIntegrationOptsToAddReqDataOpts(integrationOptions) {
      const {
        transactionNamingScheme,
        include: { ip, user, ...requestOptions }
      } = integrationOptions;
      const requestIncludeKeys = [];
      for (const [key, value] of Object.entries(requestOptions)) {
        if (value) {
          requestIncludeKeys.push(key);
        }
      }
      let addReqDataUserOpt;
      if (user === void 0) {
        addReqDataUserOpt = true;
      } else if (typeof user === "boolean") {
        addReqDataUserOpt = user;
      } else {
        const userIncludeKeys = [];
        for (const [key, value] of Object.entries(user)) {
          if (value) {
            userIncludeKeys.push(key);
          }
        }
        addReqDataUserOpt = userIncludeKeys;
      }
      return {
        include: {
          ip,
          user: addReqDataUserOpt,
          request: requestIncludeKeys.length !== 0 ? requestIncludeKeys : void 0,
          transaction: transactionNamingScheme
        }
      };
    }
    function getSDKName(client) {
      try {
        return client.getOptions()._metadata.sdk.name;
      } catch (err) {
        return void 0;
      }
    }
    exports.RequestData = RequestData;
    exports.requestDataIntegration = requestDataIntegration;
  }
});

// ../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/integrations/inboundfilters.js
var require_inboundfilters = __commonJS({
  "../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/integrations/inboundfilters.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var utils = require_cjs();
    var debugBuild = require_debug_build2();
    var integration = require_integration();
    var DEFAULT_IGNORE_ERRORS = [
      /^Script error\.?$/,
      /^Javascript error: Script error\.? on line 0$/,
      /^ResizeObserver loop completed with undelivered notifications.$/,
      /^Cannot redefine property: googletag$/
    ];
    var DEFAULT_IGNORE_TRANSACTIONS = [
      /^.*\/healthcheck$/,
      /^.*\/healthy$/,
      /^.*\/live$/,
      /^.*\/ready$/,
      /^.*\/heartbeat$/,
      /^.*\/health$/,
      /^.*\/healthz$/
    ];
    var INTEGRATION_NAME = "InboundFilters";
    var _inboundFiltersIntegration = (options = {}) => {
      return {
        name: INTEGRATION_NAME,
        // TODO v8: Remove this
        setupOnce() {
        },
        // eslint-disable-line @typescript-eslint/no-empty-function
        processEvent(event, _hint, client) {
          const clientOptions = client.getOptions();
          const mergedOptions = _mergeOptions(options, clientOptions);
          return _shouldDropEvent(event, mergedOptions) ? null : event;
        }
      };
    };
    var inboundFiltersIntegration = integration.defineIntegration(_inboundFiltersIntegration);
    var InboundFilters = integration.convertIntegrationFnToClass(
      INTEGRATION_NAME,
      inboundFiltersIntegration
    );
    function _mergeOptions(internalOptions = {}, clientOptions = {}) {
      return {
        allowUrls: [...internalOptions.allowUrls || [], ...clientOptions.allowUrls || []],
        denyUrls: [...internalOptions.denyUrls || [], ...clientOptions.denyUrls || []],
        ignoreErrors: [
          ...internalOptions.ignoreErrors || [],
          ...clientOptions.ignoreErrors || [],
          ...internalOptions.disableErrorDefaults ? [] : DEFAULT_IGNORE_ERRORS
        ],
        ignoreTransactions: [
          ...internalOptions.ignoreTransactions || [],
          ...clientOptions.ignoreTransactions || [],
          ...internalOptions.disableTransactionDefaults ? [] : DEFAULT_IGNORE_TRANSACTIONS
        ],
        ignoreInternal: internalOptions.ignoreInternal !== void 0 ? internalOptions.ignoreInternal : true
      };
    }
    function _shouldDropEvent(event, options) {
      if (options.ignoreInternal && _isSentryError(event)) {
        debugBuild.DEBUG_BUILD && utils.logger.warn(`Event dropped due to being internal Sentry Error.
Event: ${utils.getEventDescription(event)}`);
        return true;
      }
      if (_isIgnoredError(event, options.ignoreErrors)) {
        debugBuild.DEBUG_BUILD && utils.logger.warn(
          `Event dropped due to being matched by \`ignoreErrors\` option.
Event: ${utils.getEventDescription(event)}`
        );
        return true;
      }
      if (_isIgnoredTransaction(event, options.ignoreTransactions)) {
        debugBuild.DEBUG_BUILD && utils.logger.warn(
          `Event dropped due to being matched by \`ignoreTransactions\` option.
Event: ${utils.getEventDescription(event)}`
        );
        return true;
      }
      if (_isDeniedUrl(event, options.denyUrls)) {
        debugBuild.DEBUG_BUILD && utils.logger.warn(
          `Event dropped due to being matched by \`denyUrls\` option.
Event: ${utils.getEventDescription(
            event
          )}.
Url: ${_getEventFilterUrl(event)}`
        );
        return true;
      }
      if (!_isAllowedUrl(event, options.allowUrls)) {
        debugBuild.DEBUG_BUILD && utils.logger.warn(
          `Event dropped due to not being matched by \`allowUrls\` option.
Event: ${utils.getEventDescription(
            event
          )}.
Url: ${_getEventFilterUrl(event)}`
        );
        return true;
      }
      return false;
    }
    function _isIgnoredError(event, ignoreErrors) {
      if (event.type || !ignoreErrors || !ignoreErrors.length) {
        return false;
      }
      return _getPossibleEventMessages(event).some((message) => utils.stringMatchesSomePattern(message, ignoreErrors));
    }
    function _isIgnoredTransaction(event, ignoreTransactions) {
      if (event.type !== "transaction" || !ignoreTransactions || !ignoreTransactions.length) {
        return false;
      }
      const name = event.transaction;
      return name ? utils.stringMatchesSomePattern(name, ignoreTransactions) : false;
    }
    function _isDeniedUrl(event, denyUrls) {
      if (!denyUrls || !denyUrls.length) {
        return false;
      }
      const url = _getEventFilterUrl(event);
      return !url ? false : utils.stringMatchesSomePattern(url, denyUrls);
    }
    function _isAllowedUrl(event, allowUrls) {
      if (!allowUrls || !allowUrls.length) {
        return true;
      }
      const url = _getEventFilterUrl(event);
      return !url ? true : utils.stringMatchesSomePattern(url, allowUrls);
    }
    function _getPossibleEventMessages(event) {
      const possibleMessages = [];
      if (event.message) {
        possibleMessages.push(event.message);
      }
      let lastException;
      try {
        lastException = event.exception.values[event.exception.values.length - 1];
      } catch (e) {
      }
      if (lastException) {
        if (lastException.value) {
          possibleMessages.push(lastException.value);
          if (lastException.type) {
            possibleMessages.push(`${lastException.type}: ${lastException.value}`);
          }
        }
      }
      if (debugBuild.DEBUG_BUILD && possibleMessages.length === 0) {
        utils.logger.error(`Could not extract message for event ${utils.getEventDescription(event)}`);
      }
      return possibleMessages;
    }
    function _isSentryError(event) {
      try {
        return event.exception.values[0].type === "SentryError";
      } catch (e) {
      }
      return false;
    }
    function _getLastValidUrl(frames = []) {
      for (let i = frames.length - 1; i >= 0; i--) {
        const frame = frames[i];
        if (frame && frame.filename !== "<anonymous>" && frame.filename !== "[native code]") {
          return frame.filename || null;
        }
      }
      return null;
    }
    function _getEventFilterUrl(event) {
      try {
        let frames;
        try {
          frames = event.exception.values[0].stacktrace.frames;
        } catch (e) {
        }
        return frames ? _getLastValidUrl(frames) : null;
      } catch (oO) {
        debugBuild.DEBUG_BUILD && utils.logger.error(`Cannot extract url for event ${utils.getEventDescription(event)}`);
        return null;
      }
    }
    exports.InboundFilters = InboundFilters;
    exports.inboundFiltersIntegration = inboundFiltersIntegration;
  }
});

// ../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/integrations/functiontostring.js
var require_functiontostring = __commonJS({
  "../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/integrations/functiontostring.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var utils = require_cjs();
    var exports$1 = require_exports();
    var integration = require_integration();
    var originalFunctionToString;
    var INTEGRATION_NAME = "FunctionToString";
    var SETUP_CLIENTS = /* @__PURE__ */ new WeakMap();
    var _functionToStringIntegration = () => {
      return {
        name: INTEGRATION_NAME,
        setupOnce() {
          originalFunctionToString = Function.prototype.toString;
          try {
            Function.prototype.toString = function(...args) {
              const originalFunction = utils.getOriginalFunction(this);
              const context = SETUP_CLIENTS.has(exports$1.getClient()) && originalFunction !== void 0 ? originalFunction : this;
              return originalFunctionToString.apply(context, args);
            };
          } catch (e) {
          }
        },
        setup(client) {
          SETUP_CLIENTS.set(client, true);
        }
      };
    };
    var functionToStringIntegration = integration.defineIntegration(_functionToStringIntegration);
    var FunctionToString = integration.convertIntegrationFnToClass(
      INTEGRATION_NAME,
      functionToStringIntegration
    );
    exports.FunctionToString = FunctionToString;
    exports.functionToStringIntegration = functionToStringIntegration;
  }
});

// ../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/integrations/linkederrors.js
var require_linkederrors = __commonJS({
  "../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/integrations/linkederrors.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var utils = require_cjs();
    var integration = require_integration();
    var DEFAULT_KEY = "cause";
    var DEFAULT_LIMIT = 5;
    var INTEGRATION_NAME = "LinkedErrors";
    var _linkedErrorsIntegration = (options = {}) => {
      const limit = options.limit || DEFAULT_LIMIT;
      const key = options.key || DEFAULT_KEY;
      return {
        name: INTEGRATION_NAME,
        // TODO v8: Remove this
        setupOnce() {
        },
        // eslint-disable-line @typescript-eslint/no-empty-function
        preprocessEvent(event, hint, client) {
          const options2 = client.getOptions();
          utils.applyAggregateErrorsToEvent(
            utils.exceptionFromError,
            options2.stackParser,
            options2.maxValueLength,
            key,
            limit,
            event,
            hint
          );
        }
      };
    };
    var linkedErrorsIntegration = integration.defineIntegration(_linkedErrorsIntegration);
    var LinkedErrors = integration.convertIntegrationFnToClass(INTEGRATION_NAME, linkedErrorsIntegration);
    exports.LinkedErrors = LinkedErrors;
    exports.linkedErrorsIntegration = linkedErrorsIntegration;
  }
});

// ../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/integrations/index.js
var require_integrations = __commonJS({
  "../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/integrations/index.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var functiontostring = require_functiontostring();
    var inboundfilters = require_inboundfilters();
    var linkederrors = require_linkederrors();
    exports.FunctionToString = functiontostring.FunctionToString;
    exports.InboundFilters = inboundfilters.InboundFilters;
    exports.LinkedErrors = linkederrors.LinkedErrors;
  }
});

// ../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/metrics/browser-aggregator.js
var require_browser_aggregator = __commonJS({
  "../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/metrics/browser-aggregator.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var utils$1 = require_cjs();
    var constants = require_constants2();
    var instance = require_instance();
    var metricSummary = require_metric_summary();
    var utils = require_utils2();
    var BrowserMetricsAggregator = class {
      // TODO(@anonrig): Use FinalizationRegistry to have a proper way of flushing the buckets
      // when the aggregator is garbage collected.
      // Ref: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/FinalizationRegistry
      constructor(_client) {
        this._client = _client;
        this._buckets = /* @__PURE__ */ new Map();
        this._interval = setInterval(() => this.flush(), constants.DEFAULT_BROWSER_FLUSH_INTERVAL);
      }
      /**
       * @inheritDoc
       */
      add(metricType, unsanitizedName, value, unsanitizedUnit = "none", unsanitizedTags = {}, maybeFloatTimestamp = utils$1.timestampInSeconds()) {
        const timestamp = Math.floor(maybeFloatTimestamp);
        const name = utils.sanitizeMetricKey(unsanitizedName);
        const tags = utils.sanitizeTags(unsanitizedTags);
        const unit = utils.sanitizeUnit(unsanitizedUnit);
        const bucketKey = utils.getBucketKey(metricType, name, unit, tags);
        let bucketItem = this._buckets.get(bucketKey);
        const previousWeight = bucketItem && metricType === constants.SET_METRIC_TYPE ? bucketItem.metric.weight : 0;
        if (bucketItem) {
          bucketItem.metric.add(value);
          if (bucketItem.timestamp < timestamp) {
            bucketItem.timestamp = timestamp;
          }
        } else {
          bucketItem = {
            // @ts-expect-error we don't need to narrow down the type of value here, saves bundle size.
            metric: new instance.METRIC_MAP[metricType](value),
            timestamp,
            metricType,
            name,
            unit,
            tags
          };
          this._buckets.set(bucketKey, bucketItem);
        }
        const val = typeof value === "string" ? bucketItem.metric.weight - previousWeight : value;
        metricSummary.updateMetricSummaryOnActiveSpan(metricType, name, val, unit, unsanitizedTags, bucketKey);
      }
      /**
       * @inheritDoc
       */
      flush() {
        if (this._buckets.size === 0) {
          return;
        }
        if (this._client.captureAggregateMetrics) {
          const metricBuckets = Array.from(this._buckets).map(([, bucketItem]) => bucketItem);
          this._client.captureAggregateMetrics(metricBuckets);
        }
        this._buckets.clear();
      }
      /**
       * @inheritDoc
       */
      close() {
        clearInterval(this._interval);
        this.flush();
      }
    };
    exports.BrowserMetricsAggregator = BrowserMetricsAggregator;
  }
});

// ../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/metrics/integration.js
var require_integration2 = __commonJS({
  "../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/metrics/integration.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var integration = require_integration();
    var browserAggregator = require_browser_aggregator();
    var INTEGRATION_NAME = "MetricsAggregator";
    var _metricsAggregatorIntegration = () => {
      return {
        name: INTEGRATION_NAME,
        // TODO v8: Remove this
        setupOnce() {
        },
        // eslint-disable-line @typescript-eslint/no-empty-function
        setup(client) {
          client.metricsAggregator = new browserAggregator.BrowserMetricsAggregator(client);
        }
      };
    };
    var metricsAggregatorIntegration = integration.defineIntegration(_metricsAggregatorIntegration);
    var MetricsAggregator = integration.convertIntegrationFnToClass(
      INTEGRATION_NAME,
      metricsAggregatorIntegration
    );
    exports.MetricsAggregator = MetricsAggregator;
    exports.metricsAggregatorIntegration = metricsAggregatorIntegration;
  }
});

// ../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/metrics/exports.js
var require_exports2 = __commonJS({
  "../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/metrics/exports.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var utils = require_cjs();
    var debugBuild = require_debug_build2();
    var exports$1 = require_exports();
    var spanUtils = require_spanUtils();
    var constants = require_constants2();
    var integration = require_integration2();
    function addToMetricsAggregator(metricType, name, value, data = {}) {
      const client = exports$1.getClient();
      const scope = exports$1.getCurrentScope();
      if (client) {
        if (!client.metricsAggregator) {
          debugBuild.DEBUG_BUILD && utils.logger.warn("No metrics aggregator enabled. Please add the MetricsAggregator integration to use metrics APIs");
          return;
        }
        const { unit, tags, timestamp } = data;
        const { release, environment } = client.getOptions();
        const transaction = scope.getTransaction();
        const metricTags = {};
        if (release) {
          metricTags.release = release;
        }
        if (environment) {
          metricTags.environment = environment;
        }
        if (transaction) {
          metricTags.transaction = spanUtils.spanToJSON(transaction).description || "";
        }
        debugBuild.DEBUG_BUILD && utils.logger.log(`Adding value of ${value} to ${metricType} metric ${name}`);
        client.metricsAggregator.add(metricType, name, value, unit, { ...metricTags, ...tags }, timestamp);
      }
    }
    function increment(name, value = 1, data) {
      addToMetricsAggregator(constants.COUNTER_METRIC_TYPE, name, value, data);
    }
    function distribution(name, value, data) {
      addToMetricsAggregator(constants.DISTRIBUTION_METRIC_TYPE, name, value, data);
    }
    function set(name, value, data) {
      addToMetricsAggregator(constants.SET_METRIC_TYPE, name, value, data);
    }
    function gauge(name, value, data) {
      addToMetricsAggregator(constants.GAUGE_METRIC_TYPE, name, value, data);
    }
    var metrics = {
      increment,
      distribution,
      set,
      gauge,
      /** @deprecated Use `metrics.metricsAggregratorIntegration()` instead. */
      // eslint-disable-next-line deprecation/deprecation
      MetricsAggregator: integration.MetricsAggregator,
      metricsAggregatorIntegration: integration.metricsAggregatorIntegration
    };
    exports.distribution = distribution;
    exports.gauge = gauge;
    exports.increment = increment;
    exports.metrics = metrics;
    exports.set = set;
  }
});

// ../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/index.js
var require_cjs2 = __commonJS({
  "../../node_modules/.pnpm/@sentry+core@7.120.1/node_modules/@sentry/core/cjs/index.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var hubextensions = require_hubextensions();
    var idletransaction = require_idletransaction();
    var span$1 = require_span();
    var transaction = require_transaction();
    var utils = require_utils();
    var spanstatus = require_spanstatus();
    var trace = require_trace();
    var dynamicSamplingContext = require_dynamicSamplingContext();
    var measurement = require_measurement();
    var sampling = require_sampling();
    var semanticAttributes = require_semanticAttributes();
    var envelope = require_envelope2();
    var exports$1 = require_exports();
    var hub = require_hub();
    var session = require_session();
    var sessionflusher = require_sessionflusher();
    var scope = require_scope();
    var eventProcessors = require_eventProcessors();
    var api = require_api();
    var baseclient = require_baseclient();
    var serverRuntimeClient = require_server_runtime_client();
    var sdk = require_sdk();
    var base = require_base();
    var offline = require_offline();
    var multiplexed = require_multiplexed();
    var version = require_version();
    var integration = require_integration();
    var applyScopeDataToEvent = require_applyScopeDataToEvent();
    var prepareEvent = require_prepareEvent();
    var checkin = require_checkin();
    var span = require_span2();
    var hasTracingEnabled = require_hasTracingEnabled();
    var isSentryRequestUrl = require_isSentryRequestUrl();
    var handleCallbackErrors = require_handleCallbackErrors();
    var parameterize = require_parameterize();
    var spanUtils = require_spanUtils();
    var getRootSpan = require_getRootSpan();
    var sdkMetadata = require_sdkMetadata();
    var constants = require_constants();
    var metadata = require_metadata2();
    var requestdata = require_requestdata2();
    var inboundfilters = require_inboundfilters();
    var functiontostring = require_functiontostring();
    var linkederrors = require_linkederrors();
    var index = require_integrations();
    var exports$2 = require_exports2();
    var Integrations = index;
    exports.addTracingExtensions = hubextensions.addTracingExtensions;
    exports.startIdleTransaction = hubextensions.startIdleTransaction;
    exports.IdleTransaction = idletransaction.IdleTransaction;
    exports.TRACING_DEFAULTS = idletransaction.TRACING_DEFAULTS;
    exports.Span = span$1.Span;
    exports.Transaction = transaction.Transaction;
    exports.extractTraceparentData = utils.extractTraceparentData;
    exports.getActiveTransaction = utils.getActiveTransaction;
    Object.defineProperty(exports, "SpanStatus", {
      enumerable: true,
      get: () => spanstatus.SpanStatus
    });
    exports.getSpanStatusFromHttpCode = spanstatus.getSpanStatusFromHttpCode;
    exports.setHttpStatus = spanstatus.setHttpStatus;
    exports.spanStatusfromHttpCode = spanstatus.spanStatusfromHttpCode;
    exports.continueTrace = trace.continueTrace;
    exports.getActiveSpan = trace.getActiveSpan;
    exports.startActiveSpan = trace.startActiveSpan;
    exports.startInactiveSpan = trace.startInactiveSpan;
    exports.startSpan = trace.startSpan;
    exports.startSpanManual = trace.startSpanManual;
    exports.trace = trace.trace;
    exports.getDynamicSamplingContextFromClient = dynamicSamplingContext.getDynamicSamplingContextFromClient;
    exports.getDynamicSamplingContextFromSpan = dynamicSamplingContext.getDynamicSamplingContextFromSpan;
    exports.setMeasurement = measurement.setMeasurement;
    exports.isValidSampleRate = sampling.isValidSampleRate;
    exports.SEMANTIC_ATTRIBUTE_PROFILE_ID = semanticAttributes.SEMANTIC_ATTRIBUTE_PROFILE_ID;
    exports.SEMANTIC_ATTRIBUTE_SENTRY_OP = semanticAttributes.SEMANTIC_ATTRIBUTE_SENTRY_OP;
    exports.SEMANTIC_ATTRIBUTE_SENTRY_ORIGIN = semanticAttributes.SEMANTIC_ATTRIBUTE_SENTRY_ORIGIN;
    exports.SEMANTIC_ATTRIBUTE_SENTRY_SAMPLE_RATE = semanticAttributes.SEMANTIC_ATTRIBUTE_SENTRY_SAMPLE_RATE;
    exports.SEMANTIC_ATTRIBUTE_SENTRY_SOURCE = semanticAttributes.SEMANTIC_ATTRIBUTE_SENTRY_SOURCE;
    exports.createEventEnvelope = envelope.createEventEnvelope;
    exports.createSessionEnvelope = envelope.createSessionEnvelope;
    exports.addBreadcrumb = exports$1.addBreadcrumb;
    exports.captureCheckIn = exports$1.captureCheckIn;
    exports.captureEvent = exports$1.captureEvent;
    exports.captureException = exports$1.captureException;
    exports.captureMessage = exports$1.captureMessage;
    exports.captureSession = exports$1.captureSession;
    exports.close = exports$1.close;
    exports.configureScope = exports$1.configureScope;
    exports.endSession = exports$1.endSession;
    exports.flush = exports$1.flush;
    exports.getClient = exports$1.getClient;
    exports.getCurrentScope = exports$1.getCurrentScope;
    exports.isInitialized = exports$1.isInitialized;
    exports.lastEventId = exports$1.lastEventId;
    exports.setContext = exports$1.setContext;
    exports.setExtra = exports$1.setExtra;
    exports.setExtras = exports$1.setExtras;
    exports.setTag = exports$1.setTag;
    exports.setTags = exports$1.setTags;
    exports.setUser = exports$1.setUser;
    exports.startSession = exports$1.startSession;
    exports.startTransaction = exports$1.startTransaction;
    exports.withActiveSpan = exports$1.withActiveSpan;
    exports.withIsolationScope = exports$1.withIsolationScope;
    exports.withMonitor = exports$1.withMonitor;
    exports.withScope = exports$1.withScope;
    exports.Hub = hub.Hub;
    exports.ensureHubOnCarrier = hub.ensureHubOnCarrier;
    exports.getCurrentHub = hub.getCurrentHub;
    exports.getHubFromCarrier = hub.getHubFromCarrier;
    exports.getIsolationScope = hub.getIsolationScope;
    exports.getMainCarrier = hub.getMainCarrier;
    exports.makeMain = hub.makeMain;
    exports.runWithAsyncContext = hub.runWithAsyncContext;
    exports.setAsyncContextStrategy = hub.setAsyncContextStrategy;
    exports.setHubOnCarrier = hub.setHubOnCarrier;
    exports.closeSession = session.closeSession;
    exports.makeSession = session.makeSession;
    exports.updateSession = session.updateSession;
    exports.SessionFlusher = sessionflusher.SessionFlusher;
    exports.Scope = scope.Scope;
    exports.getGlobalScope = scope.getGlobalScope;
    exports.setGlobalScope = scope.setGlobalScope;
    exports.addGlobalEventProcessor = eventProcessors.addGlobalEventProcessor;
    exports.notifyEventProcessors = eventProcessors.notifyEventProcessors;
    exports.getEnvelopeEndpointWithUrlEncodedAuth = api.getEnvelopeEndpointWithUrlEncodedAuth;
    exports.getReportDialogEndpoint = api.getReportDialogEndpoint;
    exports.BaseClient = baseclient.BaseClient;
    exports.addEventProcessor = baseclient.addEventProcessor;
    exports.ServerRuntimeClient = serverRuntimeClient.ServerRuntimeClient;
    exports.initAndBind = sdk.initAndBind;
    exports.setCurrentClient = sdk.setCurrentClient;
    exports.createTransport = base.createTransport;
    exports.makeOfflineTransport = offline.makeOfflineTransport;
    exports.makeMultiplexedTransport = multiplexed.makeMultiplexedTransport;
    exports.SDK_VERSION = version.SDK_VERSION;
    exports.addIntegration = integration.addIntegration;
    exports.convertIntegrationFnToClass = integration.convertIntegrationFnToClass;
    exports.defineIntegration = integration.defineIntegration;
    exports.getIntegrationsToSetup = integration.getIntegrationsToSetup;
    exports.applyScopeDataToEvent = applyScopeDataToEvent.applyScopeDataToEvent;
    exports.mergeScopeData = applyScopeDataToEvent.mergeScopeData;
    exports.prepareEvent = prepareEvent.prepareEvent;
    exports.createCheckInEnvelope = checkin.createCheckInEnvelope;
    exports.createSpanEnvelope = span.createSpanEnvelope;
    exports.hasTracingEnabled = hasTracingEnabled.hasTracingEnabled;
    exports.isSentryRequestUrl = isSentryRequestUrl.isSentryRequestUrl;
    exports.handleCallbackErrors = handleCallbackErrors.handleCallbackErrors;
    exports.parameterize = parameterize.parameterize;
    exports.spanIsSampled = spanUtils.spanIsSampled;
    exports.spanToJSON = spanUtils.spanToJSON;
    exports.spanToTraceContext = spanUtils.spanToTraceContext;
    exports.spanToTraceHeader = spanUtils.spanToTraceHeader;
    exports.getRootSpan = getRootSpan.getRootSpan;
    exports.applySdkMetadata = sdkMetadata.applySdkMetadata;
    exports.DEFAULT_ENVIRONMENT = constants.DEFAULT_ENVIRONMENT;
    exports.ModuleMetadata = metadata.ModuleMetadata;
    exports.moduleMetadataIntegration = metadata.moduleMetadataIntegration;
    exports.RequestData = requestdata.RequestData;
    exports.requestDataIntegration = requestdata.requestDataIntegration;
    exports.InboundFilters = inboundfilters.InboundFilters;
    exports.inboundFiltersIntegration = inboundfilters.inboundFiltersIntegration;
    exports.FunctionToString = functiontostring.FunctionToString;
    exports.functionToStringIntegration = functiontostring.functionToStringIntegration;
    exports.LinkedErrors = linkederrors.LinkedErrors;
    exports.linkedErrorsIntegration = linkederrors.linkedErrorsIntegration;
    exports.metrics = exports$2.metrics;
    exports.Integrations = Integrations;
  }
});

// ../../node_modules/.pnpm/@sentry-internal+tracing@7.120.1/node_modules/@sentry-internal/tracing/cjs/common/debug-build.js
var require_debug_build3 = __commonJS({
  "../../node_modules/.pnpm/@sentry-internal+tracing@7.120.1/node_modules/@sentry-internal/tracing/cjs/common/debug-build.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var DEBUG_BUILD = typeof __SENTRY_DEBUG__ === "undefined" || __SENTRY_DEBUG__;
    exports.DEBUG_BUILD = DEBUG_BUILD;
  }
});

// ../../node_modules/.pnpm/@sentry-internal+tracing@7.120.1/node_modules/@sentry-internal/tracing/cjs/node/integrations/utils/node-utils.js
var require_node_utils = __commonJS({
  "../../node_modules/.pnpm/@sentry-internal+tracing@7.120.1/node_modules/@sentry-internal/tracing/cjs/node/integrations/utils/node-utils.js"(exports) {
    var {
      _optionalChain
    } = require_cjs();
    Object.defineProperty(exports, "__esModule", { value: true });
    function shouldDisableAutoInstrumentation(getCurrentHub) {
      const clientOptions = _optionalChain([getCurrentHub, "call", (_) => _(), "access", (_2) => _2.getClient, "call", (_3) => _3(), "optionalAccess", (_4) => _4.getOptions, "call", (_5) => _5()]);
      const instrumenter = _optionalChain([clientOptions, "optionalAccess", (_6) => _6.instrumenter]) || "sentry";
      return instrumenter !== "sentry";
    }
    exports.shouldDisableAutoInstrumentation = shouldDisableAutoInstrumentation;
  }
});

// ../../node_modules/.pnpm/@sentry-internal+tracing@7.120.1/node_modules/@sentry-internal/tracing/cjs/node/integrations/express.js
var require_express = __commonJS({
  "../../node_modules/.pnpm/@sentry-internal+tracing@7.120.1/node_modules/@sentry-internal/tracing/cjs/node/integrations/express.js"(exports) {
    var {
      _optionalChain
    } = require_cjs();
    Object.defineProperty(exports, "__esModule", { value: true });
    var core = require_cjs2();
    var utils = require_cjs();
    var debugBuild = require_debug_build3();
    var nodeUtils = require_node_utils();
    var Express = class _Express {
      /**
       * @inheritDoc
       */
      static __initStatic() {
        this.id = "Express";
      }
      /**
       * @inheritDoc
       */
      /**
       * Express App instance
       */
      /**
       * @inheritDoc
       */
      constructor(options = {}) {
        this.name = _Express.id;
        this._router = options.router || options.app;
        this._methods = (Array.isArray(options.methods) ? options.methods : []).concat("use");
      }
      /**
       * @inheritDoc
       */
      // eslint-disable-next-line deprecation/deprecation
      setupOnce(_, getCurrentHub) {
        if (!this._router) {
          debugBuild.DEBUG_BUILD && utils.logger.error("ExpressIntegration is missing an Express instance");
          return;
        }
        if (nodeUtils.shouldDisableAutoInstrumentation(getCurrentHub)) {
          debugBuild.DEBUG_BUILD && utils.logger.log("Express Integration is skipped because of instrumenter configuration.");
          return;
        }
        instrumentMiddlewares(this._router, this._methods);
        instrumentRouter(this._router);
      }
    };
    Express.__initStatic();
    function wrap(fn, method) {
      const arity = fn.length;
      switch (arity) {
        case 2: {
          return function(req, res) {
            const transaction = res.__sentry_transaction;
            if (transaction) {
              const span = transaction.startChild({
                description: fn.name,
                op: `middleware.express.${method}`,
                origin: "auto.middleware.express"
              });
              res.once("finish", () => {
                span.end();
              });
            }
            return fn.call(this, req, res);
          };
        }
        case 3: {
          return function(req, res, next) {
            const transaction = res.__sentry_transaction;
            const span = _optionalChain([transaction, "optionalAccess", (_2) => _2.startChild, "call", (_3) => _3({
              description: fn.name,
              op: `middleware.express.${method}`,
              origin: "auto.middleware.express"
            })]);
            fn.call(this, req, res, function(...args) {
              _optionalChain([span, "optionalAccess", (_4) => _4.end, "call", (_5) => _5()]);
              next.call(this, ...args);
            });
          };
        }
        case 4: {
          return function(err, req, res, next) {
            const transaction = res.__sentry_transaction;
            const span = _optionalChain([transaction, "optionalAccess", (_6) => _6.startChild, "call", (_7) => _7({
              description: fn.name,
              op: `middleware.express.${method}`,
              origin: "auto.middleware.express"
            })]);
            fn.call(this, err, req, res, function(...args) {
              _optionalChain([span, "optionalAccess", (_8) => _8.end, "call", (_9) => _9()]);
              next.call(this, ...args);
            });
          };
        }
        default: {
          throw new Error(`Express middleware takes 2-4 arguments. Got: ${arity}`);
        }
      }
    }
    function wrapMiddlewareArgs(args, method) {
      return args.map((arg) => {
        if (typeof arg === "function") {
          return wrap(arg, method);
        }
        if (Array.isArray(arg)) {
          return arg.map((a) => {
            if (typeof a === "function") {
              return wrap(a, method);
            }
            return a;
          });
        }
        return arg;
      });
    }
    function patchMiddleware(router, method) {
      const originalCallback = router[method];
      router[method] = function(...args) {
        return originalCallback.call(this, ...wrapMiddlewareArgs(args, method));
      };
      return router;
    }
    function instrumentMiddlewares(router, methods = []) {
      methods.forEach((method) => patchMiddleware(router, method));
    }
    function instrumentRouter(appOrRouter) {
      const isApp = "settings" in appOrRouter;
      if (isApp && appOrRouter._router === void 0 && appOrRouter.lazyrouter) {
        appOrRouter.lazyrouter();
      }
      const router = isApp ? appOrRouter._router : appOrRouter;
      if (!router) {
        debugBuild.DEBUG_BUILD && utils.logger.debug("Cannot instrument router for URL Parameterization (did not find a valid router).");
        debugBuild.DEBUG_BUILD && utils.logger.debug("Routing instrumentation is currently only supported in Express 4.");
        return;
      }
      const routerProto = Object.getPrototypeOf(router);
      const originalProcessParams = routerProto.process_params;
      routerProto.process_params = function process_params(layer, called, req, res, done) {
        if (!req._reconstructedRoute) {
          req._reconstructedRoute = "";
        }
        const { layerRoutePath, isRegex, isArray, numExtraSegments } = getLayerRoutePathInfo(layer);
        if (layerRoutePath || isRegex || isArray) {
          req._hasParameters = true;
        }
        let partialRoute;
        if (layerRoutePath) {
          partialRoute = layerRoutePath;
        } else {
          partialRoute = preventDuplicateSegments(req.originalUrl, req._reconstructedRoute, layer.path) || "";
        }
        const finalPartialRoute = partialRoute.split("/").filter((segment) => segment.length > 0 && (isRegex || isArray || !segment.includes("*"))).join("/");
        if (finalPartialRoute && finalPartialRoute.length > 0) {
          req._reconstructedRoute += `/${finalPartialRoute}${isRegex ? "/" : ""}`;
        }
        const urlLength = utils.getNumberOfUrlSegments(utils.stripUrlQueryAndFragment(req.originalUrl || "")) + numExtraSegments;
        const routeLength = utils.getNumberOfUrlSegments(req._reconstructedRoute);
        if (urlLength === routeLength) {
          if (!req._hasParameters) {
            if (req._reconstructedRoute !== req.originalUrl) {
              req._reconstructedRoute = req.originalUrl ? utils.stripUrlQueryAndFragment(req.originalUrl) : req.originalUrl;
            }
          }
          const transaction = res.__sentry_transaction;
          const attributes = transaction && core.spanToJSON(transaction).data || {};
          if (transaction && attributes[core.SEMANTIC_ATTRIBUTE_SENTRY_SOURCE] !== "custom") {
            const finalRoute = req._reconstructedRoute || "/";
            const [name, source] = utils.extractPathForTransaction(req, { path: true, method: true, customRoute: finalRoute });
            transaction.updateName(name);
            transaction.setAttribute(core.SEMANTIC_ATTRIBUTE_SENTRY_SOURCE, source);
          }
        }
        return originalProcessParams.call(this, layer, called, req, res, done);
      };
    }
    var extractOriginalRoute = (path, regexp, keys) => {
      if (!path || !regexp || !keys || Object.keys(keys).length === 0 || !_optionalChain([keys, "access", (_10) => _10[0], "optionalAccess", (_11) => _11.offset])) {
        return void 0;
      }
      const orderedKeys = keys.sort((a, b) => a.offset - b.offset);
      const pathRegex = new RegExp(regexp, `${regexp.flags}d`);
      const execResult = pathRegex.exec(path);
      if (!execResult || !execResult.indices) {
        return void 0;
      }
      const [, ...paramIndices] = execResult.indices;
      if (paramIndices.length !== orderedKeys.length) {
        return void 0;
      }
      let resultPath = path;
      let indexShift = 0;
      paramIndices.forEach((item, index) => {
        if (item) {
          const [startOffset, endOffset] = item;
          const substr1 = resultPath.substring(0, startOffset - indexShift);
          const replacement = `:${orderedKeys[index].name}`;
          const substr2 = resultPath.substring(endOffset - indexShift);
          resultPath = substr1 + replacement + substr2;
          indexShift = indexShift + (endOffset - startOffset - replacement.length);
        }
      });
      return resultPath;
    };
    function getLayerRoutePathInfo(layer) {
      let lrp = _optionalChain([layer, "access", (_12) => _12.route, "optionalAccess", (_13) => _13.path]);
      const isRegex = utils.isRegExp(lrp);
      const isArray = Array.isArray(lrp);
      if (!lrp) {
        const [major] = utils.GLOBAL_OBJ.process.versions.node.split(".").map(Number);
        if (major >= 16) {
          lrp = extractOriginalRoute(layer.path, layer.regexp, layer.keys);
        }
      }
      if (!lrp) {
        return { isRegex, isArray, numExtraSegments: 0 };
      }
      const numExtraSegments = isArray ? Math.max(getNumberOfArrayUrlSegments(lrp) - utils.getNumberOfUrlSegments(layer.path || ""), 0) : 0;
      const layerRoutePath = getLayerRoutePathString(isArray, lrp);
      return { layerRoutePath, isRegex, isArray, numExtraSegments };
    }
    function getNumberOfArrayUrlSegments(routesArray) {
      return routesArray.reduce((accNumSegments, currentRoute) => {
        return accNumSegments + utils.getNumberOfUrlSegments(currentRoute.toString());
      }, 0);
    }
    function getLayerRoutePathString(isArray, lrp) {
      if (isArray) {
        return lrp.map((r) => r.toString()).join(",");
      }
      return lrp && lrp.toString();
    }
    function preventDuplicateSegments(originalUrl, reconstructedRoute, layerPath) {
      const normalizeURL = utils.stripUrlQueryAndFragment(originalUrl || "");
      const originalUrlSplit = _optionalChain([normalizeURL, "optionalAccess", (_14) => _14.split, "call", (_15) => _15("/"), "access", (_16) => _16.filter, "call", (_17) => _17((v) => !!v)]);
      let tempCounter = 0;
      const currentOffset = _optionalChain([reconstructedRoute, "optionalAccess", (_18) => _18.split, "call", (_19) => _19("/"), "access", (_20) => _20.filter, "call", (_21) => _21((v) => !!v), "access", (_22) => _22.length]) || 0;
      const result = _optionalChain([
        layerPath,
        "optionalAccess",
        (_23) => _23.split,
        "call",
        (_24) => _24("/"),
        "access",
        (_25) => _25.filter,
        "call",
        (_26) => _26((segment) => {
          if (_optionalChain([originalUrlSplit, "optionalAccess", (_27) => _27[currentOffset + tempCounter]]) === segment) {
            tempCounter += 1;
            return true;
          }
          return false;
        }),
        "access",
        (_28) => _28.join,
        "call",
        (_29) => _29("/")
      ]);
      return result;
    }
    exports.Express = Express;
    exports.extractOriginalRoute = extractOriginalRoute;
    exports.preventDuplicateSegments = preventDuplicateSegments;
  }
});

// ../../node_modules/.pnpm/@sentry-internal+tracing@7.120.1/node_modules/@sentry-internal/tracing/cjs/node/integrations/postgres.js
var require_postgres = __commonJS({
  "../../node_modules/.pnpm/@sentry-internal+tracing@7.120.1/node_modules/@sentry-internal/tracing/cjs/node/integrations/postgres.js"(exports) {
    var {
      _optionalChain
    } = require_cjs();
    Object.defineProperty(exports, "__esModule", { value: true });
    var utils = require_cjs();
    var debugBuild = require_debug_build3();
    var nodeUtils = require_node_utils();
    var Postgres = class _Postgres {
      /**
       * @inheritDoc
       */
      static __initStatic() {
        this.id = "Postgres";
      }
      /**
       * @inheritDoc
       */
      constructor(options = {}) {
        this.name = _Postgres.id;
        this._usePgNative = !!options.usePgNative;
        this._module = options.module;
      }
      /** @inheritdoc */
      loadDependency() {
        return this._module = this._module || utils.loadModule("pg");
      }
      /**
       * @inheritDoc
       */
      // eslint-disable-next-line deprecation/deprecation
      setupOnce(_, getCurrentHub) {
        if (nodeUtils.shouldDisableAutoInstrumentation(getCurrentHub)) {
          debugBuild.DEBUG_BUILD && utils.logger.log("Postgres Integration is skipped because of instrumenter configuration.");
          return;
        }
        const pkg = this.loadDependency();
        if (!pkg) {
          debugBuild.DEBUG_BUILD && utils.logger.error("Postgres Integration was unable to require `pg` package.");
          return;
        }
        const Client = this._usePgNative ? _optionalChain([pkg, "access", (_2) => _2.native, "optionalAccess", (_3) => _3.Client]) : pkg.Client;
        if (!Client) {
          debugBuild.DEBUG_BUILD && utils.logger.error("Postgres Integration was unable to access 'pg-native' bindings.");
          return;
        }
        utils.fill(Client.prototype, "query", function(orig) {
          return function(config, values, callback) {
            const scope = getCurrentHub().getScope();
            const parentSpan = scope.getSpan();
            const data = {
              "db.system": "postgresql"
            };
            try {
              if (this.database) {
                data["db.name"] = this.database;
              }
              if (this.host) {
                data["server.address"] = this.host;
              }
              if (this.port) {
                data["server.port"] = this.port;
              }
              if (this.user) {
                data["db.user"] = this.user;
              }
            } catch (e) {
            }
            const span = _optionalChain([parentSpan, "optionalAccess", (_4) => _4.startChild, "call", (_5) => _5({
              description: typeof config === "string" ? config : config.text,
              op: "db",
              origin: "auto.db.postgres",
              data
            })]);
            if (typeof callback === "function") {
              return orig.call(this, config, values, function(err, result) {
                _optionalChain([span, "optionalAccess", (_6) => _6.end, "call", (_7) => _7()]);
                callback(err, result);
              });
            }
            if (typeof values === "function") {
              return orig.call(this, config, function(err, result) {
                _optionalChain([span, "optionalAccess", (_8) => _8.end, "call", (_9) => _9()]);
                values(err, result);
              });
            }
            const rv = typeof values !== "undefined" ? orig.call(this, config, values) : orig.call(this, config);
            if (utils.isThenable(rv)) {
              return rv.then((res) => {
                _optionalChain([span, "optionalAccess", (_10) => _10.end, "call", (_11) => _11()]);
                return res;
              });
            }
            _optionalChain([span, "optionalAccess", (_12) => _12.end, "call", (_13) => _13()]);
            return rv;
          };
        });
      }
    };
    Postgres.__initStatic();
    exports.Postgres = Postgres;
  }
});

// ../../node_modules/.pnpm/@sentry-internal+tracing@7.120.1/node_modules/@sentry-internal/tracing/cjs/node/integrations/mysql.js
var require_mysql = __commonJS({
  "../../node_modules/.pnpm/@sentry-internal+tracing@7.120.1/node_modules/@sentry-internal/tracing/cjs/node/integrations/mysql.js"(exports) {
    var {
      _optionalChain
    } = require_cjs();
    Object.defineProperty(exports, "__esModule", { value: true });
    var utils = require_cjs();
    var debugBuild = require_debug_build3();
    var nodeUtils = require_node_utils();
    var Mysql = class _Mysql {
      /**
       * @inheritDoc
       */
      static __initStatic() {
        this.id = "Mysql";
      }
      /**
       * @inheritDoc
       */
      constructor() {
        this.name = _Mysql.id;
      }
      /** @inheritdoc */
      loadDependency() {
        return this._module = this._module || utils.loadModule("mysql/lib/Connection.js");
      }
      /**
       * @inheritDoc
       */
      // eslint-disable-next-line deprecation/deprecation
      setupOnce(_, getCurrentHub) {
        if (nodeUtils.shouldDisableAutoInstrumentation(getCurrentHub)) {
          debugBuild.DEBUG_BUILD && utils.logger.log("Mysql Integration is skipped because of instrumenter configuration.");
          return;
        }
        const pkg = this.loadDependency();
        if (!pkg) {
          debugBuild.DEBUG_BUILD && utils.logger.error("Mysql Integration was unable to require `mysql` package.");
          return;
        }
        let mySqlConfig = void 0;
        try {
          pkg.prototype.connect = new Proxy(pkg.prototype.connect, {
            apply(wrappingTarget, thisArg, args) {
              if (!mySqlConfig) {
                mySqlConfig = thisArg.config;
              }
              return wrappingTarget.apply(thisArg, args);
            }
          });
        } catch (e) {
          debugBuild.DEBUG_BUILD && utils.logger.error("Mysql Integration was unable to instrument `mysql` config.");
        }
        function spanDataFromConfig() {
          if (!mySqlConfig) {
            return {};
          }
          return {
            "server.address": mySqlConfig.host,
            "server.port": mySqlConfig.port,
            "db.user": mySqlConfig.user
          };
        }
        function finishSpan(span) {
          if (!span) {
            return;
          }
          const data = spanDataFromConfig();
          Object.keys(data).forEach((key) => {
            span.setAttribute(key, data[key]);
          });
          span.end();
        }
        utils.fill(pkg, "createQuery", function(orig) {
          return function(options, values, callback) {
            const scope = getCurrentHub().getScope();
            const parentSpan = scope.getSpan();
            const span = _optionalChain([parentSpan, "optionalAccess", (_2) => _2.startChild, "call", (_3) => _3({
              description: typeof options === "string" ? options : options.sql,
              op: "db",
              origin: "auto.db.mysql",
              data: {
                "db.system": "mysql"
              }
            })]);
            if (typeof callback === "function") {
              return orig.call(this, options, values, function(err, result, fields) {
                finishSpan(span);
                callback(err, result, fields);
              });
            }
            if (typeof values === "function") {
              return orig.call(this, options, function(err, result, fields) {
                finishSpan(span);
                values(err, result, fields);
              });
            }
            const query = orig.call(this, options, values);
            query.on("end", () => {
              finishSpan(span);
            });
            return query;
          };
        });
      }
    };
    Mysql.__initStatic();
    exports.Mysql = Mysql;
  }
});

// ../../node_modules/.pnpm/@sentry-internal+tracing@7.120.1/node_modules/@sentry-internal/tracing/cjs/node/integrations/mongo.js
var require_mongo = __commonJS({
  "../../node_modules/.pnpm/@sentry-internal+tracing@7.120.1/node_modules/@sentry-internal/tracing/cjs/node/integrations/mongo.js"(exports) {
    var {
      _optionalChain
    } = require_cjs();
    Object.defineProperty(exports, "__esModule", { value: true });
    var utils = require_cjs();
    var debugBuild = require_debug_build3();
    var nodeUtils = require_node_utils();
    var OPERATIONS = [
      "aggregate",
      // aggregate(pipeline, options, callback)
      "bulkWrite",
      // bulkWrite(operations, options, callback)
      "countDocuments",
      // countDocuments(query, options, callback)
      "createIndex",
      // createIndex(fieldOrSpec, options, callback)
      "createIndexes",
      // createIndexes(indexSpecs, options, callback)
      "deleteMany",
      // deleteMany(filter, options, callback)
      "deleteOne",
      // deleteOne(filter, options, callback)
      "distinct",
      // distinct(key, query, options, callback)
      "drop",
      // drop(options, callback)
      "dropIndex",
      // dropIndex(indexName, options, callback)
      "dropIndexes",
      // dropIndexes(options, callback)
      "estimatedDocumentCount",
      // estimatedDocumentCount(options, callback)
      "find",
      // find(query, options, callback)
      "findOne",
      // findOne(query, options, callback)
      "findOneAndDelete",
      // findOneAndDelete(filter, options, callback)
      "findOneAndReplace",
      // findOneAndReplace(filter, replacement, options, callback)
      "findOneAndUpdate",
      // findOneAndUpdate(filter, update, options, callback)
      "indexes",
      // indexes(options, callback)
      "indexExists",
      // indexExists(indexes, options, callback)
      "indexInformation",
      // indexInformation(options, callback)
      "initializeOrderedBulkOp",
      // initializeOrderedBulkOp(options, callback)
      "insertMany",
      // insertMany(docs, options, callback)
      "insertOne",
      // insertOne(doc, options, callback)
      "isCapped",
      // isCapped(options, callback)
      "mapReduce",
      // mapReduce(map, reduce, options, callback)
      "options",
      // options(options, callback)
      "parallelCollectionScan",
      // parallelCollectionScan(options, callback)
      "rename",
      // rename(newName, options, callback)
      "replaceOne",
      // replaceOne(filter, doc, options, callback)
      "stats",
      // stats(options, callback)
      "updateMany",
      // updateMany(filter, update, options, callback)
      "updateOne"
      // updateOne(filter, update, options, callback)
    ];
    var OPERATION_SIGNATURES = {
      // aggregate intentionally not included because `pipeline` arguments are too complex to serialize well
      // see https://github.com/getsentry/sentry-javascript/pull/3102
      bulkWrite: ["operations"],
      countDocuments: ["query"],
      createIndex: ["fieldOrSpec"],
      createIndexes: ["indexSpecs"],
      deleteMany: ["filter"],
      deleteOne: ["filter"],
      distinct: ["key", "query"],
      dropIndex: ["indexName"],
      find: ["query"],
      findOne: ["query"],
      findOneAndDelete: ["filter"],
      findOneAndReplace: ["filter", "replacement"],
      findOneAndUpdate: ["filter", "update"],
      indexExists: ["indexes"],
      insertMany: ["docs"],
      insertOne: ["doc"],
      mapReduce: ["map", "reduce"],
      rename: ["newName"],
      replaceOne: ["filter", "doc"],
      updateMany: ["filter", "update"],
      updateOne: ["filter", "update"]
    };
    function isCursor(maybeCursor) {
      return maybeCursor && typeof maybeCursor === "object" && maybeCursor.once && typeof maybeCursor.once === "function";
    }
    var Mongo = class _Mongo {
      /**
       * @inheritDoc
       */
      static __initStatic() {
        this.id = "Mongo";
      }
      /**
       * @inheritDoc
       */
      /**
       * @inheritDoc
       */
      constructor(options = {}) {
        this.name = _Mongo.id;
        this._operations = Array.isArray(options.operations) ? options.operations : OPERATIONS;
        this._describeOperations = "describeOperations" in options ? options.describeOperations : true;
        this._useMongoose = !!options.useMongoose;
      }
      /** @inheritdoc */
      loadDependency() {
        const moduleName = this._useMongoose ? "mongoose" : "mongodb";
        return this._module = this._module || utils.loadModule(moduleName);
      }
      /**
       * @inheritDoc
       */
      // eslint-disable-next-line deprecation/deprecation
      setupOnce(_, getCurrentHub) {
        if (nodeUtils.shouldDisableAutoInstrumentation(getCurrentHub)) {
          debugBuild.DEBUG_BUILD && utils.logger.log("Mongo Integration is skipped because of instrumenter configuration.");
          return;
        }
        const pkg = this.loadDependency();
        if (!pkg) {
          const moduleName = this._useMongoose ? "mongoose" : "mongodb";
          debugBuild.DEBUG_BUILD && utils.logger.error(`Mongo Integration was unable to require \`${moduleName}\` package.`);
          return;
        }
        this._instrumentOperations(pkg.Collection, this._operations, getCurrentHub);
      }
      /**
       * Patches original collection methods
       */
      // eslint-disable-next-line deprecation/deprecation
      _instrumentOperations(collection, operations, getCurrentHub) {
        operations.forEach((operation) => this._patchOperation(collection, operation, getCurrentHub));
      }
      /**
       * Patches original collection to utilize our tracing functionality
       */
      // eslint-disable-next-line deprecation/deprecation
      _patchOperation(collection, operation, getCurrentHub) {
        if (!(operation in collection.prototype))
          return;
        const getSpanContext = this._getSpanContextFromOperationArguments.bind(this);
        utils.fill(collection.prototype, operation, function(orig) {
          return function(...args) {
            const lastArg = args[args.length - 1];
            const hub = getCurrentHub();
            const scope = hub.getScope();
            const client = hub.getClient();
            const parentSpan = scope.getSpan();
            const sendDefaultPii = _optionalChain([client, "optionalAccess", (_2) => _2.getOptions, "call", (_3) => _3(), "access", (_4) => _4.sendDefaultPii]);
            if (typeof lastArg !== "function" || operation === "mapReduce" && args.length === 2) {
              const span2 = _optionalChain([parentSpan, "optionalAccess", (_5) => _5.startChild, "call", (_6) => _6(getSpanContext(this, operation, args, sendDefaultPii))]);
              const maybePromiseOrCursor = orig.call(this, ...args);
              if (utils.isThenable(maybePromiseOrCursor)) {
                return maybePromiseOrCursor.then((res) => {
                  _optionalChain([span2, "optionalAccess", (_7) => _7.end, "call", (_8) => _8()]);
                  return res;
                });
              } else if (isCursor(maybePromiseOrCursor)) {
                const cursor = maybePromiseOrCursor;
                try {
                  cursor.once("close", () => {
                    _optionalChain([span2, "optionalAccess", (_9) => _9.end, "call", (_10) => _10()]);
                  });
                } catch (e) {
                  _optionalChain([span2, "optionalAccess", (_11) => _11.end, "call", (_12) => _12()]);
                }
                return cursor;
              } else {
                _optionalChain([span2, "optionalAccess", (_13) => _13.end, "call", (_14) => _14()]);
                return maybePromiseOrCursor;
              }
            }
            const span = _optionalChain([parentSpan, "optionalAccess", (_15) => _15.startChild, "call", (_16) => _16(getSpanContext(this, operation, args.slice(0, -1)))]);
            return orig.call(this, ...args.slice(0, -1), function(err, result) {
              _optionalChain([span, "optionalAccess", (_17) => _17.end, "call", (_18) => _18()]);
              lastArg(err, result);
            });
          };
        });
      }
      /**
       * Form a SpanContext based on the user input to a given operation.
       */
      _getSpanContextFromOperationArguments(collection, operation, args, sendDefaultPii = false) {
        const data = {
          "db.system": "mongodb",
          "db.name": collection.dbName,
          "db.operation": operation,
          "db.mongodb.collection": collection.collectionName
        };
        const spanContext = {
          op: "db",
          // TODO v8: Use `${collection.collectionName}.${operation}`
          origin: "auto.db.mongo",
          description: operation,
          data
        };
        const signature = OPERATION_SIGNATURES[operation];
        const shouldDescribe = Array.isArray(this._describeOperations) ? this._describeOperations.includes(operation) : this._describeOperations;
        if (!signature || !shouldDescribe || !sendDefaultPii) {
          return spanContext;
        }
        try {
          if (operation === "mapReduce") {
            const [map, reduce] = args;
            data[signature[0]] = typeof map === "string" ? map : map.name || "<anonymous>";
            data[signature[1]] = typeof reduce === "string" ? reduce : reduce.name || "<anonymous>";
          } else {
            for (let i = 0; i < signature.length; i++) {
              data[`db.mongodb.${signature[i]}`] = JSON.stringify(args[i]);
            }
          }
        } catch (_oO) {
        }
        return spanContext;
      }
    };
    Mongo.__initStatic();
    exports.Mongo = Mongo;
  }
});

// ../../node_modules/.pnpm/@sentry-internal+tracing@7.120.1/node_modules/@sentry-internal/tracing/cjs/node/integrations/prisma.js
var require_prisma = __commonJS({
  "../../node_modules/.pnpm/@sentry-internal+tracing@7.120.1/node_modules/@sentry-internal/tracing/cjs/node/integrations/prisma.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var core = require_cjs2();
    var utils = require_cjs();
    var debugBuild = require_debug_build3();
    var nodeUtils = require_node_utils();
    function isValidPrismaClient(possibleClient) {
      return !!possibleClient && !!possibleClient["$use"];
    }
    var Prisma = class _Prisma {
      /**
       * @inheritDoc
       */
      static __initStatic() {
        this.id = "Prisma";
      }
      /**
       * @inheritDoc
       */
      /**
       * @inheritDoc
       */
      constructor(options = {}) {
        this.name = _Prisma.id;
        if (isValidPrismaClient(options.client) && !options.client._sentryInstrumented) {
          utils.addNonEnumerableProperty(options.client, "_sentryInstrumented", true);
          const clientData = {};
          try {
            const engineConfig = options.client._engineConfig;
            if (engineConfig) {
              const { activeProvider, clientVersion } = engineConfig;
              if (activeProvider) {
                clientData["db.system"] = activeProvider;
              }
              if (clientVersion) {
                clientData["db.prisma.version"] = clientVersion;
              }
            }
          } catch (e) {
          }
          options.client.$use((params, next) => {
            if (nodeUtils.shouldDisableAutoInstrumentation(core.getCurrentHub)) {
              return next(params);
            }
            const action = params.action;
            const model = params.model;
            return core.startSpan(
              {
                name: model ? `${model} ${action}` : action,
                onlyIfParent: true,
                op: "db.prisma",
                attributes: {
                  [core.SEMANTIC_ATTRIBUTE_SENTRY_ORIGIN]: "auto.db.prisma"
                },
                data: { ...clientData, "db.operation": action }
              },
              () => next(params)
            );
          });
        } else {
          debugBuild.DEBUG_BUILD && utils.logger.warn("Unsupported Prisma client provided to PrismaIntegration. Provided client:", options.client);
        }
      }
      /**
       * @inheritDoc
       */
      setupOnce() {
      }
    };
    Prisma.__initStatic();
    exports.Prisma = Prisma;
  }
});

// ../../node_modules/.pnpm/@sentry-internal+tracing@7.120.1/node_modules/@sentry-internal/tracing/cjs/node/integrations/graphql.js
var require_graphql = __commonJS({
  "../../node_modules/.pnpm/@sentry-internal+tracing@7.120.1/node_modules/@sentry-internal/tracing/cjs/node/integrations/graphql.js"(exports) {
    var {
      _optionalChain
    } = require_cjs();
    Object.defineProperty(exports, "__esModule", { value: true });
    var utils = require_cjs();
    var debugBuild = require_debug_build3();
    var nodeUtils = require_node_utils();
    var GraphQL = class _GraphQL {
      /**
       * @inheritDoc
       */
      static __initStatic() {
        this.id = "GraphQL";
      }
      /**
       * @inheritDoc
       */
      constructor() {
        this.name = _GraphQL.id;
      }
      /** @inheritdoc */
      loadDependency() {
        return this._module = this._module || utils.loadModule("graphql/execution/execute.js");
      }
      /**
       * @inheritDoc
       */
      // eslint-disable-next-line deprecation/deprecation
      setupOnce(_, getCurrentHub) {
        if (nodeUtils.shouldDisableAutoInstrumentation(getCurrentHub)) {
          debugBuild.DEBUG_BUILD && utils.logger.log("GraphQL Integration is skipped because of instrumenter configuration.");
          return;
        }
        const pkg = this.loadDependency();
        if (!pkg) {
          debugBuild.DEBUG_BUILD && utils.logger.error("GraphQL Integration was unable to require graphql/execution package.");
          return;
        }
        utils.fill(pkg, "execute", function(orig) {
          return function(...args) {
            const scope = getCurrentHub().getScope();
            const parentSpan = scope.getSpan();
            const span = _optionalChain([parentSpan, "optionalAccess", (_2) => _2.startChild, "call", (_3) => _3({
              description: "execute",
              op: "graphql.execute",
              origin: "auto.graphql.graphql"
            })]);
            _optionalChain([scope, "optionalAccess", (_4) => _4.setSpan, "call", (_5) => _5(span)]);
            const rv = orig.call(this, ...args);
            if (utils.isThenable(rv)) {
              return rv.then((res) => {
                _optionalChain([span, "optionalAccess", (_6) => _6.end, "call", (_7) => _7()]);
                _optionalChain([scope, "optionalAccess", (_8) => _8.setSpan, "call", (_9) => _9(parentSpan)]);
                return res;
              });
            }
            _optionalChain([span, "optionalAccess", (_10) => _10.end, "call", (_11) => _11()]);
            _optionalChain([scope, "optionalAccess", (_12) => _12.setSpan, "call", (_13) => _13(parentSpan)]);
            return rv;
          };
        });
      }
    };
    GraphQL.__initStatic();
    exports.GraphQL = GraphQL;
  }
});

// ../../node_modules/.pnpm/@sentry-internal+tracing@7.120.1/node_modules/@sentry-internal/tracing/cjs/node/integrations/apollo.js
var require_apollo = __commonJS({
  "../../node_modules/.pnpm/@sentry-internal+tracing@7.120.1/node_modules/@sentry-internal/tracing/cjs/node/integrations/apollo.js"(exports) {
    var {
      _optionalChain
    } = require_cjs();
    Object.defineProperty(exports, "__esModule", { value: true });
    var utils = require_cjs();
    var debugBuild = require_debug_build3();
    var nodeUtils = require_node_utils();
    var Apollo = class _Apollo {
      /**
       * @inheritDoc
       */
      static __initStatic() {
        this.id = "Apollo";
      }
      /**
       * @inheritDoc
       */
      /**
       * @inheritDoc
       */
      constructor(options = {
        useNestjs: false
      }) {
        this.name = _Apollo.id;
        this._useNest = !!options.useNestjs;
      }
      /** @inheritdoc */
      loadDependency() {
        if (this._useNest) {
          this._module = this._module || utils.loadModule("@nestjs/graphql");
        } else {
          this._module = this._module || utils.loadModule("apollo-server-core");
        }
        return this._module;
      }
      /**
       * @inheritDoc
       */
      // eslint-disable-next-line deprecation/deprecation
      setupOnce(_, getCurrentHub) {
        if (nodeUtils.shouldDisableAutoInstrumentation(getCurrentHub)) {
          debugBuild.DEBUG_BUILD && utils.logger.log("Apollo Integration is skipped because of instrumenter configuration.");
          return;
        }
        if (this._useNest) {
          const pkg = this.loadDependency();
          if (!pkg) {
            debugBuild.DEBUG_BUILD && utils.logger.error("Apollo-NestJS Integration was unable to require @nestjs/graphql package.");
            return;
          }
          utils.fill(
            pkg.GraphQLFactory.prototype,
            "mergeWithSchema",
            function(orig) {
              return function(...args) {
                utils.fill(this.resolversExplorerService, "explore", function(orig2) {
                  return function() {
                    const resolvers = utils.arrayify(orig2.call(this));
                    const instrumentedResolvers = instrumentResolvers(resolvers, getCurrentHub);
                    return instrumentedResolvers;
                  };
                });
                return orig.call(this, ...args);
              };
            }
          );
        } else {
          const pkg = this.loadDependency();
          if (!pkg) {
            debugBuild.DEBUG_BUILD && utils.logger.error("Apollo Integration was unable to require apollo-server-core package.");
            return;
          }
          utils.fill(pkg.ApolloServerBase.prototype, "constructSchema", function(orig) {
            return function() {
              if (!this.config.resolvers) {
                if (debugBuild.DEBUG_BUILD) {
                  if (this.config.schema) {
                    utils.logger.warn(
                      "Apollo integration is not able to trace `ApolloServer` instances constructed via `schema` property.If you are using NestJS with Apollo, please use `Sentry.Integrations.Apollo({ useNestjs: true })` instead."
                    );
                    utils.logger.warn();
                  } else if (this.config.modules) {
                    utils.logger.warn(
                      "Apollo integration is not able to trace `ApolloServer` instances constructed via `modules` property."
                    );
                  }
                  utils.logger.error("Skipping tracing as no resolvers found on the `ApolloServer` instance.");
                }
                return orig.call(this);
              }
              const resolvers = utils.arrayify(this.config.resolvers);
              this.config.resolvers = instrumentResolvers(resolvers, getCurrentHub);
              return orig.call(this);
            };
          });
        }
      }
    };
    Apollo.__initStatic();
    function instrumentResolvers(resolvers, getCurrentHub) {
      return resolvers.map((model) => {
        Object.keys(model).forEach((resolverGroupName) => {
          Object.keys(model[resolverGroupName]).forEach((resolverName) => {
            if (typeof model[resolverGroupName][resolverName] !== "function") {
              return;
            }
            wrapResolver(model, resolverGroupName, resolverName, getCurrentHub);
          });
        });
        return model;
      });
    }
    function wrapResolver(model, resolverGroupName, resolverName, getCurrentHub) {
      utils.fill(model[resolverGroupName], resolverName, function(orig) {
        return function(...args) {
          const scope = getCurrentHub().getScope();
          const parentSpan = scope.getSpan();
          const span = _optionalChain([parentSpan, "optionalAccess", (_2) => _2.startChild, "call", (_3) => _3({
            description: `${resolverGroupName}.${resolverName}`,
            op: "graphql.resolve",
            origin: "auto.graphql.apollo"
          })]);
          const rv = orig.call(this, ...args);
          if (utils.isThenable(rv)) {
            return rv.then((res) => {
              _optionalChain([span, "optionalAccess", (_4) => _4.end, "call", (_5) => _5()]);
              return res;
            });
          }
          _optionalChain([span, "optionalAccess", (_6) => _6.end, "call", (_7) => _7()]);
          return rv;
        };
      });
    }
    exports.Apollo = Apollo;
  }
});

// ../../node_modules/.pnpm/@sentry-internal+tracing@7.120.1/node_modules/@sentry-internal/tracing/cjs/node/integrations/lazy.js
var require_lazy = __commonJS({
  "../../node_modules/.pnpm/@sentry-internal+tracing@7.120.1/node_modules/@sentry-internal/tracing/cjs/node/integrations/lazy.js"(exports, module) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var utils = require_cjs();
    var lazyLoadedNodePerformanceMonitoringIntegrations = [
      () => {
        const integration = utils.dynamicRequire(module, "./apollo");
        return new integration.Apollo();
      },
      () => {
        const integration = utils.dynamicRequire(module, "./apollo");
        return new integration.Apollo({ useNestjs: true });
      },
      () => {
        const integration = utils.dynamicRequire(module, "./graphql");
        return new integration.GraphQL();
      },
      () => {
        const integration = utils.dynamicRequire(module, "./mongo");
        return new integration.Mongo();
      },
      () => {
        const integration = utils.dynamicRequire(module, "./mongo");
        return new integration.Mongo({ mongoose: true });
      },
      () => {
        const integration = utils.dynamicRequire(module, "./mysql");
        return new integration.Mysql();
      },
      () => {
        const integration = utils.dynamicRequire(module, "./postgres");
        return new integration.Postgres();
      }
    ];
    exports.lazyLoadedNodePerformanceMonitoringIntegrations = lazyLoadedNodePerformanceMonitoringIntegrations;
  }
});

// ../../node_modules/.pnpm/@sentry-internal+tracing@7.120.1/node_modules/@sentry-internal/tracing/cjs/browser/types.js
var require_types = __commonJS({
  "../../node_modules/.pnpm/@sentry-internal+tracing@7.120.1/node_modules/@sentry-internal/tracing/cjs/browser/types.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var utils = require_cjs();
    var WINDOW = utils.GLOBAL_OBJ;
    exports.WINDOW = WINDOW;
  }
});

// ../../node_modules/.pnpm/@sentry-internal+tracing@7.120.1/node_modules/@sentry-internal/tracing/cjs/browser/backgroundtab.js
var require_backgroundtab = __commonJS({
  "../../node_modules/.pnpm/@sentry-internal+tracing@7.120.1/node_modules/@sentry-internal/tracing/cjs/browser/backgroundtab.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var core = require_cjs2();
    var utils = require_cjs();
    var debugBuild = require_debug_build3();
    var types = require_types();
    function registerBackgroundTabDetection() {
      if (types.WINDOW.document) {
        types.WINDOW.document.addEventListener("visibilitychange", () => {
          const activeTransaction = core.getActiveTransaction();
          if (types.WINDOW.document.hidden && activeTransaction) {
            const statusType = "cancelled";
            const { op, status } = core.spanToJSON(activeTransaction);
            debugBuild.DEBUG_BUILD && utils.logger.log(`[Tracing] Transaction: ${statusType} -> since tab moved to the background, op: ${op}`);
            if (!status) {
              activeTransaction.setStatus(statusType);
            }
            activeTransaction.setTag("visibilitychange", "document.hidden");
            activeTransaction.end();
          }
        });
      } else {
        debugBuild.DEBUG_BUILD && utils.logger.warn("[Tracing] Could not set up background tab detection due to lack of global document");
      }
    }
    exports.registerBackgroundTabDetection = registerBackgroundTabDetection;
  }
});

// ../../node_modules/.pnpm/@sentry-internal+tracing@7.120.1/node_modules/@sentry-internal/tracing/cjs/browser/web-vitals/lib/bindReporter.js
var require_bindReporter = __commonJS({
  "../../node_modules/.pnpm/@sentry-internal+tracing@7.120.1/node_modules/@sentry-internal/tracing/cjs/browser/web-vitals/lib/bindReporter.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var bindReporter = (callback, metric, reportAllChanges) => {
      let prevValue;
      let delta;
      return (forceReport) => {
        if (metric.value >= 0) {
          if (forceReport || reportAllChanges) {
            delta = metric.value - (prevValue || 0);
            if (delta || prevValue === void 0) {
              prevValue = metric.value;
              metric.delta = delta;
              callback(metric);
            }
          }
        }
      };
    };
    exports.bindReporter = bindReporter;
  }
});

// ../../node_modules/.pnpm/@sentry-internal+tracing@7.120.1/node_modules/@sentry-internal/tracing/cjs/browser/web-vitals/lib/generateUniqueID.js
var require_generateUniqueID = __commonJS({
  "../../node_modules/.pnpm/@sentry-internal+tracing@7.120.1/node_modules/@sentry-internal/tracing/cjs/browser/web-vitals/lib/generateUniqueID.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var generateUniqueID = () => {
      return `v3-${Date.now()}-${Math.floor(Math.random() * (9e12 - 1)) + 1e12}`;
    };
    exports.generateUniqueID = generateUniqueID;
  }
});

// ../../node_modules/.pnpm/@sentry-internal+tracing@7.120.1/node_modules/@sentry-internal/tracing/cjs/browser/web-vitals/lib/getNavigationEntry.js
var require_getNavigationEntry = __commonJS({
  "../../node_modules/.pnpm/@sentry-internal+tracing@7.120.1/node_modules/@sentry-internal/tracing/cjs/browser/web-vitals/lib/getNavigationEntry.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var types = require_types();
    var getNavigationEntryFromPerformanceTiming = () => {
      const timing = types.WINDOW.performance.timing;
      const type = types.WINDOW.performance.navigation.type;
      const navigationEntry = {
        entryType: "navigation",
        startTime: 0,
        type: type == 2 ? "back_forward" : type === 1 ? "reload" : "navigate"
      };
      for (const key in timing) {
        if (key !== "navigationStart" && key !== "toJSON") {
          navigationEntry[key] = Math.max(timing[key] - timing.navigationStart, 0);
        }
      }
      return navigationEntry;
    };
    var getNavigationEntry = () => {
      if (types.WINDOW.__WEB_VITALS_POLYFILL__) {
        return types.WINDOW.performance && (performance.getEntriesByType && performance.getEntriesByType("navigation")[0] || getNavigationEntryFromPerformanceTiming());
      } else {
        return types.WINDOW.performance && performance.getEntriesByType && performance.getEntriesByType("navigation")[0];
      }
    };
    exports.getNavigationEntry = getNavigationEntry;
  }
});

// ../../node_modules/.pnpm/@sentry-internal+tracing@7.120.1/node_modules/@sentry-internal/tracing/cjs/browser/web-vitals/lib/getActivationStart.js
var require_getActivationStart = __commonJS({
  "../../node_modules/.pnpm/@sentry-internal+tracing@7.120.1/node_modules/@sentry-internal/tracing/cjs/browser/web-vitals/lib/getActivationStart.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var getNavigationEntry = require_getNavigationEntry();
    var getActivationStart = () => {
      const navEntry = getNavigationEntry.getNavigationEntry();
      return navEntry && navEntry.activationStart || 0;
    };
    exports.getActivationStart = getActivationStart;
  }
});

// ../../node_modules/.pnpm/@sentry-internal+tracing@7.120.1/node_modules/@sentry-internal/tracing/cjs/browser/web-vitals/lib/initMetric.js
var require_initMetric = __commonJS({
  "../../node_modules/.pnpm/@sentry-internal+tracing@7.120.1/node_modules/@sentry-internal/tracing/cjs/browser/web-vitals/lib/initMetric.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var types = require_types();
    var generateUniqueID = require_generateUniqueID();
    var getActivationStart = require_getActivationStart();
    var getNavigationEntry = require_getNavigationEntry();
    var initMetric = (name, value) => {
      const navEntry = getNavigationEntry.getNavigationEntry();
      let navigationType = "navigate";
      if (navEntry) {
        if (types.WINDOW.document && types.WINDOW.document.prerendering || getActivationStart.getActivationStart() > 0) {
          navigationType = "prerender";
        } else {
          navigationType = navEntry.type.replace(/_/g, "-");
        }
      }
      return {
        name,
        value: typeof value === "undefined" ? -1 : value,
        rating: "good",
        // Will be updated if the value changes.
        delta: 0,
        entries: [],
        id: generateUniqueID.generateUniqueID(),
        navigationType
      };
    };
    exports.initMetric = initMetric;
  }
});

// ../../node_modules/.pnpm/@sentry-internal+tracing@7.120.1/node_modules/@sentry-internal/tracing/cjs/browser/web-vitals/lib/observe.js
var require_observe = __commonJS({
  "../../node_modules/.pnpm/@sentry-internal+tracing@7.120.1/node_modules/@sentry-internal/tracing/cjs/browser/web-vitals/lib/observe.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var observe = (type, callback, opts) => {
      try {
        if (PerformanceObserver.supportedEntryTypes.includes(type)) {
          const po = new PerformanceObserver((list) => {
            callback(list.getEntries());
          });
          po.observe(
            Object.assign(
              {
                type,
                buffered: true
              },
              opts || {}
            )
          );
          return po;
        }
      } catch (e) {
      }
      return;
    };
    exports.observe = observe;
  }
});

// ../../node_modules/.pnpm/@sentry-internal+tracing@7.120.1/node_modules/@sentry-internal/tracing/cjs/browser/web-vitals/lib/onHidden.js
var require_onHidden = __commonJS({
  "../../node_modules/.pnpm/@sentry-internal+tracing@7.120.1/node_modules/@sentry-internal/tracing/cjs/browser/web-vitals/lib/onHidden.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var types = require_types();
    var onHidden = (cb, once) => {
      const onHiddenOrPageHide = (event) => {
        if (event.type === "pagehide" || types.WINDOW.document.visibilityState === "hidden") {
          cb(event);
          if (once) {
            removeEventListener("visibilitychange", onHiddenOrPageHide, true);
            removeEventListener("pagehide", onHiddenOrPageHide, true);
          }
        }
      };
      if (types.WINDOW.document) {
        addEventListener("visibilitychange", onHiddenOrPageHide, true);
        addEventListener("pagehide", onHiddenOrPageHide, true);
      }
    };
    exports.onHidden = onHidden;
  }
});

// ../../node_modules/.pnpm/@sentry-internal+tracing@7.120.1/node_modules/@sentry-internal/tracing/cjs/browser/web-vitals/getCLS.js
var require_getCLS = __commonJS({
  "../../node_modules/.pnpm/@sentry-internal+tracing@7.120.1/node_modules/@sentry-internal/tracing/cjs/browser/web-vitals/getCLS.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var bindReporter = require_bindReporter();
    var initMetric = require_initMetric();
    var observe = require_observe();
    var onHidden = require_onHidden();
    var onCLS = (onReport, options = {}) => {
      const metric = initMetric.initMetric("CLS", 0);
      let report;
      let sessionValue = 0;
      let sessionEntries = [];
      const handleEntries = (entries) => {
        entries.forEach((entry) => {
          if (!entry.hadRecentInput) {
            const firstSessionEntry = sessionEntries[0];
            const lastSessionEntry = sessionEntries[sessionEntries.length - 1];
            if (sessionValue && sessionEntries.length !== 0 && entry.startTime - lastSessionEntry.startTime < 1e3 && entry.startTime - firstSessionEntry.startTime < 5e3) {
              sessionValue += entry.value;
              sessionEntries.push(entry);
            } else {
              sessionValue = entry.value;
              sessionEntries = [entry];
            }
            if (sessionValue > metric.value) {
              metric.value = sessionValue;
              metric.entries = sessionEntries;
              if (report) {
                report();
              }
            }
          }
        });
      };
      const po = observe.observe("layout-shift", handleEntries);
      if (po) {
        report = bindReporter.bindReporter(onReport, metric, options.reportAllChanges);
        const stopListening = () => {
          handleEntries(po.takeRecords());
          report(true);
        };
        onHidden.onHidden(stopListening);
        return stopListening;
      }
      return;
    };
    exports.onCLS = onCLS;
  }
});

// ../../node_modules/.pnpm/@sentry-internal+tracing@7.120.1/node_modules/@sentry-internal/tracing/cjs/browser/web-vitals/lib/getVisibilityWatcher.js
var require_getVisibilityWatcher = __commonJS({
  "../../node_modules/.pnpm/@sentry-internal+tracing@7.120.1/node_modules/@sentry-internal/tracing/cjs/browser/web-vitals/lib/getVisibilityWatcher.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var types = require_types();
    var onHidden = require_onHidden();
    var firstHiddenTime = -1;
    var initHiddenTime = () => {
      if (types.WINDOW.document && types.WINDOW.document.visibilityState) {
        firstHiddenTime = types.WINDOW.document.visibilityState === "hidden" && !types.WINDOW.document.prerendering ? 0 : Infinity;
      }
    };
    var trackChanges = () => {
      onHidden.onHidden(({ timeStamp }) => {
        firstHiddenTime = timeStamp;
      }, true);
    };
    var getVisibilityWatcher = () => {
      if (firstHiddenTime < 0) {
        initHiddenTime();
        trackChanges();
      }
      return {
        get firstHiddenTime() {
          return firstHiddenTime;
        }
      };
    };
    exports.getVisibilityWatcher = getVisibilityWatcher;
  }
});

// ../../node_modules/.pnpm/@sentry-internal+tracing@7.120.1/node_modules/@sentry-internal/tracing/cjs/browser/web-vitals/getFID.js
var require_getFID = __commonJS({
  "../../node_modules/.pnpm/@sentry-internal+tracing@7.120.1/node_modules/@sentry-internal/tracing/cjs/browser/web-vitals/getFID.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var bindReporter = require_bindReporter();
    var getVisibilityWatcher = require_getVisibilityWatcher();
    var initMetric = require_initMetric();
    var observe = require_observe();
    var onHidden = require_onHidden();
    var onFID = (onReport) => {
      const visibilityWatcher = getVisibilityWatcher.getVisibilityWatcher();
      const metric = initMetric.initMetric("FID");
      let report;
      const handleEntry = (entry) => {
        if (entry.startTime < visibilityWatcher.firstHiddenTime) {
          metric.value = entry.processingStart - entry.startTime;
          metric.entries.push(entry);
          report(true);
        }
      };
      const handleEntries = (entries) => {
        entries.forEach(handleEntry);
      };
      const po = observe.observe("first-input", handleEntries);
      report = bindReporter.bindReporter(onReport, metric);
      if (po) {
        onHidden.onHidden(() => {
          handleEntries(po.takeRecords());
          po.disconnect();
        }, true);
      }
    };
    exports.onFID = onFID;
  }
});

// ../../node_modules/.pnpm/@sentry-internal+tracing@7.120.1/node_modules/@sentry-internal/tracing/cjs/browser/web-vitals/lib/polyfills/interactionCountPolyfill.js
var require_interactionCountPolyfill = __commonJS({
  "../../node_modules/.pnpm/@sentry-internal+tracing@7.120.1/node_modules/@sentry-internal/tracing/cjs/browser/web-vitals/lib/polyfills/interactionCountPolyfill.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var observe = require_observe();
    var interactionCountEstimate = 0;
    var minKnownInteractionId = Infinity;
    var maxKnownInteractionId = 0;
    var updateEstimate = (entries) => {
      entries.forEach((e) => {
        if (e.interactionId) {
          minKnownInteractionId = Math.min(minKnownInteractionId, e.interactionId);
          maxKnownInteractionId = Math.max(maxKnownInteractionId, e.interactionId);
          interactionCountEstimate = maxKnownInteractionId ? (maxKnownInteractionId - minKnownInteractionId) / 7 + 1 : 0;
        }
      });
    };
    var po;
    var getInteractionCount = () => {
      return po ? interactionCountEstimate : performance.interactionCount || 0;
    };
    var initInteractionCountPolyfill = () => {
      if ("interactionCount" in performance || po)
        return;
      po = observe.observe("event", updateEstimate, {
        type: "event",
        buffered: true,
        durationThreshold: 0
      });
    };
    exports.getInteractionCount = getInteractionCount;
    exports.initInteractionCountPolyfill = initInteractionCountPolyfill;
  }
});

// ../../node_modules/.pnpm/@sentry-internal+tracing@7.120.1/node_modules/@sentry-internal/tracing/cjs/browser/web-vitals/getINP.js
var require_getINP = __commonJS({
  "../../node_modules/.pnpm/@sentry-internal+tracing@7.120.1/node_modules/@sentry-internal/tracing/cjs/browser/web-vitals/getINP.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var bindReporter = require_bindReporter();
    var initMetric = require_initMetric();
    var observe = require_observe();
    var onHidden = require_onHidden();
    var interactionCountPolyfill = require_interactionCountPolyfill();
    var getInteractionCountForNavigation = () => {
      return interactionCountPolyfill.getInteractionCount();
    };
    var MAX_INTERACTIONS_TO_CONSIDER = 10;
    var longestInteractionList = [];
    var longestInteractionMap = {};
    var processEntry = (entry) => {
      const minLongestInteraction = longestInteractionList[longestInteractionList.length - 1];
      const existingInteraction = longestInteractionMap[entry.interactionId];
      if (existingInteraction || longestInteractionList.length < MAX_INTERACTIONS_TO_CONSIDER || entry.duration > minLongestInteraction.latency) {
        if (existingInteraction) {
          existingInteraction.entries.push(entry);
          existingInteraction.latency = Math.max(existingInteraction.latency, entry.duration);
        } else {
          const interaction = {
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            id: entry.interactionId,
            latency: entry.duration,
            entries: [entry]
          };
          longestInteractionMap[interaction.id] = interaction;
          longestInteractionList.push(interaction);
        }
        longestInteractionList.sort((a, b) => b.latency - a.latency);
        longestInteractionList.splice(MAX_INTERACTIONS_TO_CONSIDER).forEach((i) => {
          delete longestInteractionMap[i.id];
        });
      }
    };
    var estimateP98LongestInteraction = () => {
      const candidateInteractionIndex = Math.min(
        longestInteractionList.length - 1,
        Math.floor(getInteractionCountForNavigation() / 50)
      );
      return longestInteractionList[candidateInteractionIndex];
    };
    var onINP = (onReport, opts) => {
      opts = opts || {};
      interactionCountPolyfill.initInteractionCountPolyfill();
      const metric = initMetric.initMetric("INP");
      let report;
      const handleEntries = (entries) => {
        entries.forEach((entry) => {
          if (entry.interactionId) {
            processEntry(entry);
          }
          if (entry.entryType === "first-input") {
            const noMatchingEntry = !longestInteractionList.some((interaction) => {
              return interaction.entries.some((prevEntry) => {
                return entry.duration === prevEntry.duration && entry.startTime === prevEntry.startTime;
              });
            });
            if (noMatchingEntry) {
              processEntry(entry);
            }
          }
        });
        const inp = estimateP98LongestInteraction();
        if (inp && inp.latency !== metric.value) {
          metric.value = inp.latency;
          metric.entries = inp.entries;
          report();
        }
      };
      const po = observe.observe("event", handleEntries, {
        // Event Timing entries have their durations rounded to the nearest 8ms,
        // so a duration of 40ms would be any event that spans 2.5 or more frames
        // at 60Hz. This threshold is chosen to strike a balance between usefulness
        // and performance. Running this callback for any interaction that spans
        // just one or two frames is likely not worth the insight that could be
        // gained.
        durationThreshold: opts.durationThreshold || 40
      });
      report = bindReporter.bindReporter(onReport, metric, opts.reportAllChanges);
      if (po) {
        po.observe({ type: "first-input", buffered: true });
        onHidden.onHidden(() => {
          handleEntries(po.takeRecords());
          if (metric.value < 0 && getInteractionCountForNavigation() > 0) {
            metric.value = 0;
            metric.entries = [];
          }
          report(true);
        });
      }
    };
    exports.onINP = onINP;
  }
});

// ../../node_modules/.pnpm/@sentry-internal+tracing@7.120.1/node_modules/@sentry-internal/tracing/cjs/browser/web-vitals/getLCP.js
var require_getLCP = __commonJS({
  "../../node_modules/.pnpm/@sentry-internal+tracing@7.120.1/node_modules/@sentry-internal/tracing/cjs/browser/web-vitals/getLCP.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var types = require_types();
    var bindReporter = require_bindReporter();
    var getActivationStart = require_getActivationStart();
    var getVisibilityWatcher = require_getVisibilityWatcher();
    var initMetric = require_initMetric();
    var observe = require_observe();
    var onHidden = require_onHidden();
    var reportedMetricIDs = {};
    var onLCP = (onReport) => {
      const visibilityWatcher = getVisibilityWatcher.getVisibilityWatcher();
      const metric = initMetric.initMetric("LCP");
      let report;
      const handleEntries = (entries) => {
        const lastEntry = entries[entries.length - 1];
        if (lastEntry) {
          const value = Math.max(lastEntry.startTime - getActivationStart.getActivationStart(), 0);
          if (value < visibilityWatcher.firstHiddenTime) {
            metric.value = value;
            metric.entries = [lastEntry];
            report();
          }
        }
      };
      const po = observe.observe("largest-contentful-paint", handleEntries);
      if (po) {
        report = bindReporter.bindReporter(onReport, metric);
        const stopListening = () => {
          if (!reportedMetricIDs[metric.id]) {
            handleEntries(po.takeRecords());
            po.disconnect();
            reportedMetricIDs[metric.id] = true;
            report(true);
          }
        };
        ["keydown", "click"].forEach((type) => {
          if (types.WINDOW.document) {
            addEventListener(type, stopListening, { once: true, capture: true });
          }
        });
        onHidden.onHidden(stopListening, true);
        return stopListening;
      }
      return;
    };
    exports.onLCP = onLCP;
  }
});

// ../../node_modules/.pnpm/@sentry-internal+tracing@7.120.1/node_modules/@sentry-internal/tracing/cjs/browser/web-vitals/onTTFB.js
var require_onTTFB = __commonJS({
  "../../node_modules/.pnpm/@sentry-internal+tracing@7.120.1/node_modules/@sentry-internal/tracing/cjs/browser/web-vitals/onTTFB.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var types = require_types();
    var bindReporter = require_bindReporter();
    var getActivationStart = require_getActivationStart();
    var getNavigationEntry = require_getNavigationEntry();
    var initMetric = require_initMetric();
    var whenReady = (callback) => {
      if (!types.WINDOW.document) {
        return;
      }
      if (types.WINDOW.document.prerendering) {
        addEventListener("prerenderingchange", () => whenReady(callback), true);
      } else if (types.WINDOW.document.readyState !== "complete") {
        addEventListener("load", () => whenReady(callback), true);
      } else {
        setTimeout(callback, 0);
      }
    };
    var onTTFB = (onReport, opts) => {
      opts = opts || {};
      const metric = initMetric.initMetric("TTFB");
      const report = bindReporter.bindReporter(onReport, metric, opts.reportAllChanges);
      whenReady(() => {
        const navEntry = getNavigationEntry.getNavigationEntry();
        if (navEntry) {
          metric.value = Math.max(navEntry.responseStart - getActivationStart.getActivationStart(), 0);
          if (metric.value < 0 || metric.value > performance.now())
            return;
          metric.entries = [navEntry];
          report(true);
        }
      });
    };
    exports.onTTFB = onTTFB;
  }
});

// ../../node_modules/.pnpm/@sentry-internal+tracing@7.120.1/node_modules/@sentry-internal/tracing/cjs/browser/instrument.js
var require_instrument2 = __commonJS({
  "../../node_modules/.pnpm/@sentry-internal+tracing@7.120.1/node_modules/@sentry-internal/tracing/cjs/browser/instrument.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var utils = require_cjs();
    var debugBuild = require_debug_build3();
    var getCLS = require_getCLS();
    var getFID = require_getFID();
    var getINP = require_getINP();
    var getLCP = require_getLCP();
    var observe = require_observe();
    var onTTFB = require_onTTFB();
    var handlers = {};
    var instrumented = {};
    var _previousCls;
    var _previousFid;
    var _previousLcp;
    var _previousTtfb;
    var _previousInp;
    function addClsInstrumentationHandler(callback, stopOnCallback = false) {
      return addMetricObserver("cls", callback, instrumentCls, _previousCls, stopOnCallback);
    }
    function addLcpInstrumentationHandler(callback, stopOnCallback = false) {
      return addMetricObserver("lcp", callback, instrumentLcp, _previousLcp, stopOnCallback);
    }
    function addTtfbInstrumentationHandler(callback) {
      return addMetricObserver("ttfb", callback, instrumentTtfb, _previousTtfb);
    }
    function addFidInstrumentationHandler(callback) {
      return addMetricObserver("fid", callback, instrumentFid, _previousFid);
    }
    function addInpInstrumentationHandler(callback) {
      return addMetricObserver("inp", callback, instrumentInp, _previousInp);
    }
    function addPerformanceInstrumentationHandler(type, callback) {
      addHandler(type, callback);
      if (!instrumented[type]) {
        instrumentPerformanceObserver(type);
        instrumented[type] = true;
      }
      return getCleanupCallback(type, callback);
    }
    function triggerHandlers(type, data) {
      const typeHandlers = handlers[type];
      if (!typeHandlers || !typeHandlers.length) {
        return;
      }
      for (const handler of typeHandlers) {
        try {
          handler(data);
        } catch (e) {
          debugBuild.DEBUG_BUILD && utils.logger.error(
            `Error while triggering instrumentation handler.
Type: ${type}
Name: ${utils.getFunctionName(handler)}
Error:`,
            e
          );
        }
      }
    }
    function instrumentCls() {
      return getCLS.onCLS(
        (metric) => {
          triggerHandlers("cls", {
            metric
          });
          _previousCls = metric;
        },
        { reportAllChanges: true }
      );
    }
    function instrumentFid() {
      return getFID.onFID((metric) => {
        triggerHandlers("fid", {
          metric
        });
        _previousFid = metric;
      });
    }
    function instrumentLcp() {
      return getLCP.onLCP((metric) => {
        triggerHandlers("lcp", {
          metric
        });
        _previousLcp = metric;
      });
    }
    function instrumentTtfb() {
      return onTTFB.onTTFB((metric) => {
        triggerHandlers("ttfb", {
          metric
        });
        _previousTtfb = metric;
      });
    }
    function instrumentInp() {
      return getINP.onINP((metric) => {
        triggerHandlers("inp", {
          metric
        });
        _previousInp = metric;
      });
    }
    function addMetricObserver(type, callback, instrumentFn, previousValue, stopOnCallback = false) {
      addHandler(type, callback);
      let stopListening;
      if (!instrumented[type]) {
        stopListening = instrumentFn();
        instrumented[type] = true;
      }
      if (previousValue) {
        callback({ metric: previousValue });
      }
      return getCleanupCallback(type, callback, stopOnCallback ? stopListening : void 0);
    }
    function instrumentPerformanceObserver(type) {
      const options = {};
      if (type === "event") {
        options.durationThreshold = 0;
      }
      observe.observe(
        type,
        (entries) => {
          triggerHandlers(type, { entries });
        },
        options
      );
    }
    function addHandler(type, handler) {
      handlers[type] = handlers[type] || [];
      handlers[type].push(handler);
    }
    function getCleanupCallback(type, callback, stopListening) {
      return () => {
        if (stopListening) {
          stopListening();
        }
        const typeHandlers = handlers[type];
        if (!typeHandlers) {
          return;
        }
        const index = typeHandlers.indexOf(callback);
        if (index !== -1) {
          typeHandlers.splice(index, 1);
        }
      };
    }
    exports.addClsInstrumentationHandler = addClsInstrumentationHandler;
    exports.addFidInstrumentationHandler = addFidInstrumentationHandler;
    exports.addInpInstrumentationHandler = addInpInstrumentationHandler;
    exports.addLcpInstrumentationHandler = addLcpInstrumentationHandler;
    exports.addPerformanceInstrumentationHandler = addPerformanceInstrumentationHandler;
    exports.addTtfbInstrumentationHandler = addTtfbInstrumentationHandler;
  }
});

// ../../node_modules/.pnpm/@sentry-internal+tracing@7.120.1/node_modules/@sentry-internal/tracing/cjs/browser/metrics/utils.js
var require_utils3 = __commonJS({
  "../../node_modules/.pnpm/@sentry-internal+tracing@7.120.1/node_modules/@sentry-internal/tracing/cjs/browser/metrics/utils.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    function isMeasurementValue(value) {
      return typeof value === "number" && isFinite(value);
    }
    function _startChild(transaction, { startTimestamp, ...ctx }) {
      if (startTimestamp && transaction.startTimestamp > startTimestamp) {
        transaction.startTimestamp = startTimestamp;
      }
      return transaction.startChild({
        startTimestamp,
        ...ctx
      });
    }
    exports._startChild = _startChild;
    exports.isMeasurementValue = isMeasurementValue;
  }
});

// ../../node_modules/.pnpm/@sentry-internal+tracing@7.120.1/node_modules/@sentry-internal/tracing/cjs/browser/metrics/index.js
var require_metrics = __commonJS({
  "../../node_modules/.pnpm/@sentry-internal+tracing@7.120.1/node_modules/@sentry-internal/tracing/cjs/browser/metrics/index.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var core = require_cjs2();
    var utils = require_cjs();
    var debugBuild = require_debug_build3();
    var instrument = require_instrument2();
    var types = require_types();
    var getVisibilityWatcher = require_getVisibilityWatcher();
    var utils$1 = require_utils3();
    var getNavigationEntry = require_getNavigationEntry();
    var MAX_INT_AS_BYTES = 2147483647;
    function msToSec(time) {
      return time / 1e3;
    }
    function getBrowserPerformanceAPI() {
      return types.WINDOW && types.WINDOW.addEventListener && types.WINDOW.performance;
    }
    var _performanceCursor = 0;
    var _measurements = {};
    var _lcpEntry;
    var _clsEntry;
    function startTrackingWebVitals() {
      const performance2 = getBrowserPerformanceAPI();
      if (performance2 && utils.browserPerformanceTimeOrigin) {
        if (performance2.mark) {
          types.WINDOW.performance.mark("sentry-tracing-init");
        }
        const fidCallback = _trackFID();
        const clsCallback = _trackCLS();
        const lcpCallback = _trackLCP();
        const ttfbCallback = _trackTtfb();
        return () => {
          fidCallback();
          clsCallback();
          lcpCallback();
          ttfbCallback();
        };
      }
      return () => void 0;
    }
    function startTrackingLongTasks() {
      instrument.addPerformanceInstrumentationHandler("longtask", ({ entries }) => {
        for (const entry of entries) {
          const transaction = core.getActiveTransaction();
          if (!transaction) {
            return;
          }
          const startTime = msToSec(utils.browserPerformanceTimeOrigin + entry.startTime);
          const duration = msToSec(entry.duration);
          transaction.startChild({
            description: "Main UI thread blocked",
            op: "ui.long-task",
            origin: "auto.ui.browser.metrics",
            startTimestamp: startTime,
            endTimestamp: startTime + duration
          });
        }
      });
    }
    function startTrackingInteractions() {
      instrument.addPerformanceInstrumentationHandler("event", ({ entries }) => {
        for (const entry of entries) {
          const transaction = core.getActiveTransaction();
          if (!transaction) {
            return;
          }
          if (entry.name === "click") {
            const startTime = msToSec(utils.browserPerformanceTimeOrigin + entry.startTime);
            const duration = msToSec(entry.duration);
            const span = {
              description: utils.htmlTreeAsString(entry.target),
              op: `ui.interaction.${entry.name}`,
              origin: "auto.ui.browser.metrics",
              startTimestamp: startTime,
              endTimestamp: startTime + duration
            };
            const componentName = utils.getComponentName(entry.target);
            if (componentName) {
              span.attributes = { "ui.component_name": componentName };
            }
            transaction.startChild(span);
          }
        }
      });
    }
    function startTrackingINP(interactionIdtoRouteNameMapping, interactionsSampleRate) {
      const performance2 = getBrowserPerformanceAPI();
      if (performance2 && utils.browserPerformanceTimeOrigin) {
        const inpCallback = _trackINP(interactionIdtoRouteNameMapping, interactionsSampleRate);
        return () => {
          inpCallback();
        };
      }
      return () => void 0;
    }
    function _trackCLS() {
      return instrument.addClsInstrumentationHandler(({ metric }) => {
        const entry = metric.entries[metric.entries.length - 1];
        if (!entry) {
          return;
        }
        debugBuild.DEBUG_BUILD && utils.logger.log("[Measurements] Adding CLS");
        _measurements["cls"] = { value: metric.value, unit: "" };
        _clsEntry = entry;
      }, true);
    }
    function _trackLCP() {
      return instrument.addLcpInstrumentationHandler(({ metric }) => {
        const entry = metric.entries[metric.entries.length - 1];
        if (!entry) {
          return;
        }
        debugBuild.DEBUG_BUILD && utils.logger.log("[Measurements] Adding LCP");
        _measurements["lcp"] = { value: metric.value, unit: "millisecond" };
        _lcpEntry = entry;
      }, true);
    }
    function _trackFID() {
      return instrument.addFidInstrumentationHandler(({ metric }) => {
        const entry = metric.entries[metric.entries.length - 1];
        if (!entry) {
          return;
        }
        const timeOrigin = msToSec(utils.browserPerformanceTimeOrigin);
        const startTime = msToSec(entry.startTime);
        debugBuild.DEBUG_BUILD && utils.logger.log("[Measurements] Adding FID");
        _measurements["fid"] = { value: metric.value, unit: "millisecond" };
        _measurements["mark.fid"] = { value: timeOrigin + startTime, unit: "second" };
      });
    }
    function _trackTtfb() {
      return instrument.addTtfbInstrumentationHandler(({ metric }) => {
        const entry = metric.entries[metric.entries.length - 1];
        if (!entry) {
          return;
        }
        debugBuild.DEBUG_BUILD && utils.logger.log("[Measurements] Adding TTFB");
        _measurements["ttfb"] = { value: metric.value, unit: "millisecond" };
      });
    }
    var INP_ENTRY_MAP = {
      click: "click",
      pointerdown: "click",
      pointerup: "click",
      mousedown: "click",
      mouseup: "click",
      touchstart: "click",
      touchend: "click",
      mouseover: "hover",
      mouseout: "hover",
      mouseenter: "hover",
      mouseleave: "hover",
      pointerover: "hover",
      pointerout: "hover",
      pointerenter: "hover",
      pointerleave: "hover",
      dragstart: "drag",
      dragend: "drag",
      drag: "drag",
      dragenter: "drag",
      dragleave: "drag",
      dragover: "drag",
      drop: "drag",
      keydown: "press",
      keyup: "press",
      keypress: "press",
      input: "press"
    };
    function _trackINP(interactionIdToRouteNameMapping, interactionsSampleRate) {
      return instrument.addInpInstrumentationHandler(({ metric }) => {
        if (metric.value === void 0) {
          return;
        }
        const entry = metric.entries.find(
          (entry2) => entry2.duration === metric.value && INP_ENTRY_MAP[entry2.name] !== void 0
        );
        const client = core.getClient();
        if (!entry || !client) {
          return;
        }
        const interactionType = INP_ENTRY_MAP[entry.name];
        const options = client.getOptions();
        const startTime = msToSec(utils.browserPerformanceTimeOrigin + entry.startTime);
        const duration = msToSec(metric.value);
        const interaction = entry.interactionId !== void 0 ? interactionIdToRouteNameMapping[entry.interactionId] : void 0;
        if (interaction === void 0) {
          return;
        }
        const { routeName, parentContext, activeTransaction, user, replayId } = interaction;
        const userDisplay = user !== void 0 ? user.email || user.id || user.ip_address : void 0;
        const profileId = activeTransaction !== void 0 ? activeTransaction.getProfileId() : void 0;
        const span = new core.Span({
          startTimestamp: startTime,
          endTimestamp: startTime + duration,
          op: `ui.interaction.${interactionType}`,
          name: utils.htmlTreeAsString(entry.target),
          attributes: {
            release: options.release,
            environment: options.environment,
            transaction: routeName,
            ...userDisplay !== void 0 && userDisplay !== "" ? { user: userDisplay } : {},
            ...profileId !== void 0 ? { profile_id: profileId } : {},
            ...replayId !== void 0 ? { replay_id: replayId } : {}
          },
          exclusiveTime: metric.value,
          measurements: {
            inp: { value: metric.value, unit: "millisecond" }
          }
        });
        const sampleRate = getSampleRate(parentContext, options, interactionsSampleRate);
        if (!sampleRate) {
          return;
        }
        if (Math.random() < sampleRate) {
          const envelope = span ? core.createSpanEnvelope([span], client.getDsn()) : void 0;
          const transport = client && client.getTransport();
          if (transport && envelope) {
            transport.send(envelope).then(null, (reason) => {
              debugBuild.DEBUG_BUILD && utils.logger.error("Error while sending interaction:", reason);
            });
          }
          return;
        }
      });
    }
    function addPerformanceEntries(transaction) {
      const performance2 = getBrowserPerformanceAPI();
      if (!performance2 || !types.WINDOW.performance.getEntries || !utils.browserPerformanceTimeOrigin) {
        return;
      }
      debugBuild.DEBUG_BUILD && utils.logger.log("[Tracing] Adding & adjusting spans using Performance API");
      const timeOrigin = msToSec(utils.browserPerformanceTimeOrigin);
      const performanceEntries = performance2.getEntries();
      const { op, start_timestamp: transactionStartTime } = core.spanToJSON(transaction);
      performanceEntries.slice(_performanceCursor).forEach((entry) => {
        const startTime = msToSec(entry.startTime);
        const duration = msToSec(entry.duration);
        if (transaction.op === "navigation" && transactionStartTime && timeOrigin + startTime < transactionStartTime) {
          return;
        }
        switch (entry.entryType) {
          case "navigation": {
            _addNavigationSpans(transaction, entry, timeOrigin);
            break;
          }
          case "mark":
          case "paint":
          case "measure": {
            _addMeasureSpans(transaction, entry, startTime, duration, timeOrigin);
            const firstHidden = getVisibilityWatcher.getVisibilityWatcher();
            const shouldRecord = entry.startTime < firstHidden.firstHiddenTime;
            if (entry.name === "first-paint" && shouldRecord) {
              debugBuild.DEBUG_BUILD && utils.logger.log("[Measurements] Adding FP");
              _measurements["fp"] = { value: entry.startTime, unit: "millisecond" };
            }
            if (entry.name === "first-contentful-paint" && shouldRecord) {
              debugBuild.DEBUG_BUILD && utils.logger.log("[Measurements] Adding FCP");
              _measurements["fcp"] = { value: entry.startTime, unit: "millisecond" };
            }
            break;
          }
          case "resource": {
            _addResourceSpans(transaction, entry, entry.name, startTime, duration, timeOrigin);
            break;
          }
        }
      });
      _performanceCursor = Math.max(performanceEntries.length - 1, 0);
      _trackNavigator(transaction);
      if (op === "pageload") {
        _addTtfbRequestTimeToMeasurements(_measurements);
        ["fcp", "fp", "lcp"].forEach((name) => {
          if (!_measurements[name] || !transactionStartTime || timeOrigin >= transactionStartTime) {
            return;
          }
          const oldValue = _measurements[name].value;
          const measurementTimestamp = timeOrigin + msToSec(oldValue);
          const normalizedValue = Math.abs((measurementTimestamp - transactionStartTime) * 1e3);
          const delta = normalizedValue - oldValue;
          debugBuild.DEBUG_BUILD && utils.logger.log(`[Measurements] Normalized ${name} from ${oldValue} to ${normalizedValue} (${delta})`);
          _measurements[name].value = normalizedValue;
        });
        const fidMark = _measurements["mark.fid"];
        if (fidMark && _measurements["fid"]) {
          utils$1._startChild(transaction, {
            description: "first input delay",
            endTimestamp: fidMark.value + msToSec(_measurements["fid"].value),
            op: "ui.action",
            origin: "auto.ui.browser.metrics",
            startTimestamp: fidMark.value
          });
          delete _measurements["mark.fid"];
        }
        if (!("fcp" in _measurements)) {
          delete _measurements.cls;
        }
        Object.keys(_measurements).forEach((measurementName) => {
          core.setMeasurement(measurementName, _measurements[measurementName].value, _measurements[measurementName].unit);
        });
        _tagMetricInfo(transaction);
      }
      _lcpEntry = void 0;
      _clsEntry = void 0;
      _measurements = {};
    }
    function _addMeasureSpans(transaction, entry, startTime, duration, timeOrigin) {
      const measureStartTimestamp = timeOrigin + startTime;
      const measureEndTimestamp = measureStartTimestamp + duration;
      utils$1._startChild(transaction, {
        description: entry.name,
        endTimestamp: measureEndTimestamp,
        op: entry.entryType,
        origin: "auto.resource.browser.metrics",
        startTimestamp: measureStartTimestamp
      });
      return measureStartTimestamp;
    }
    function _addNavigationSpans(transaction, entry, timeOrigin) {
      ["unloadEvent", "redirect", "domContentLoadedEvent", "loadEvent", "connect"].forEach((event) => {
        _addPerformanceNavigationTiming(transaction, entry, event, timeOrigin);
      });
      _addPerformanceNavigationTiming(transaction, entry, "secureConnection", timeOrigin, "TLS/SSL", "connectEnd");
      _addPerformanceNavigationTiming(transaction, entry, "fetch", timeOrigin, "cache", "domainLookupStart");
      _addPerformanceNavigationTiming(transaction, entry, "domainLookup", timeOrigin, "DNS");
      _addRequest(transaction, entry, timeOrigin);
    }
    function _addPerformanceNavigationTiming(transaction, entry, event, timeOrigin, description, eventEnd) {
      const end = eventEnd ? entry[eventEnd] : entry[`${event}End`];
      const start = entry[`${event}Start`];
      if (!start || !end) {
        return;
      }
      utils$1._startChild(transaction, {
        op: "browser",
        origin: "auto.browser.browser.metrics",
        description: description || event,
        startTimestamp: timeOrigin + msToSec(start),
        endTimestamp: timeOrigin + msToSec(end)
      });
    }
    function _addRequest(transaction, entry, timeOrigin) {
      if (entry.responseEnd) {
        utils$1._startChild(transaction, {
          op: "browser",
          origin: "auto.browser.browser.metrics",
          description: "request",
          startTimestamp: timeOrigin + msToSec(entry.requestStart),
          endTimestamp: timeOrigin + msToSec(entry.responseEnd)
        });
        utils$1._startChild(transaction, {
          op: "browser",
          origin: "auto.browser.browser.metrics",
          description: "response",
          startTimestamp: timeOrigin + msToSec(entry.responseStart),
          endTimestamp: timeOrigin + msToSec(entry.responseEnd)
        });
      }
    }
    function _addResourceSpans(transaction, entry, resourceUrl, startTime, duration, timeOrigin) {
      if (entry.initiatorType === "xmlhttprequest" || entry.initiatorType === "fetch") {
        return;
      }
      const parsedUrl = utils.parseUrl(resourceUrl);
      const data = {};
      setResourceEntrySizeData(data, entry, "transferSize", "http.response_transfer_size");
      setResourceEntrySizeData(data, entry, "encodedBodySize", "http.response_content_length");
      setResourceEntrySizeData(data, entry, "decodedBodySize", "http.decoded_response_content_length");
      if ("renderBlockingStatus" in entry) {
        data["resource.render_blocking_status"] = entry.renderBlockingStatus;
      }
      if (parsedUrl.protocol) {
        data["url.scheme"] = parsedUrl.protocol.split(":").pop();
      }
      if (parsedUrl.host) {
        data["server.address"] = parsedUrl.host;
      }
      data["url.same_origin"] = resourceUrl.includes(types.WINDOW.location.origin);
      const startTimestamp = timeOrigin + startTime;
      const endTimestamp = startTimestamp + duration;
      utils$1._startChild(transaction, {
        description: resourceUrl.replace(types.WINDOW.location.origin, ""),
        endTimestamp,
        op: entry.initiatorType ? `resource.${entry.initiatorType}` : "resource.other",
        origin: "auto.resource.browser.metrics",
        startTimestamp,
        data
      });
    }
    function _trackNavigator(transaction) {
      const navigator2 = types.WINDOW.navigator;
      if (!navigator2) {
        return;
      }
      const connection = navigator2.connection;
      if (connection) {
        if (connection.effectiveType) {
          transaction.setTag("effectiveConnectionType", connection.effectiveType);
        }
        if (connection.type) {
          transaction.setTag("connectionType", connection.type);
        }
        if (utils$1.isMeasurementValue(connection.rtt)) {
          _measurements["connection.rtt"] = { value: connection.rtt, unit: "millisecond" };
        }
      }
      if (utils$1.isMeasurementValue(navigator2.deviceMemory)) {
        transaction.setTag("deviceMemory", `${navigator2.deviceMemory} GB`);
      }
      if (utils$1.isMeasurementValue(navigator2.hardwareConcurrency)) {
        transaction.setTag("hardwareConcurrency", String(navigator2.hardwareConcurrency));
      }
    }
    function _tagMetricInfo(transaction) {
      if (_lcpEntry) {
        debugBuild.DEBUG_BUILD && utils.logger.log("[Measurements] Adding LCP Data");
        if (_lcpEntry.element) {
          transaction.setTag("lcp.element", utils.htmlTreeAsString(_lcpEntry.element));
        }
        if (_lcpEntry.id) {
          transaction.setTag("lcp.id", _lcpEntry.id);
        }
        if (_lcpEntry.url) {
          transaction.setTag("lcp.url", _lcpEntry.url.trim().slice(0, 200));
        }
        transaction.setTag("lcp.size", _lcpEntry.size);
      }
      if (_clsEntry && _clsEntry.sources) {
        debugBuild.DEBUG_BUILD && utils.logger.log("[Measurements] Adding CLS Data");
        _clsEntry.sources.forEach(
          (source, index) => (
            // TODO: Can we rewrite this to an attribute?
            // eslint-disable-next-line deprecation/deprecation
            transaction.setTag(`cls.source.${index + 1}`, utils.htmlTreeAsString(source.node))
          )
        );
      }
    }
    function setResourceEntrySizeData(data, entry, key, dataKey) {
      const entryVal = entry[key];
      if (entryVal != null && entryVal < MAX_INT_AS_BYTES) {
        data[dataKey] = entryVal;
      }
    }
    function _addTtfbRequestTimeToMeasurements(_measurements2) {
      const navEntry = getNavigationEntry.getNavigationEntry();
      if (!navEntry) {
        return;
      }
      const { responseStart, requestStart } = navEntry;
      if (requestStart <= responseStart) {
        debugBuild.DEBUG_BUILD && utils.logger.log("[Measurements] Adding TTFB Request Time");
        _measurements2["ttfb.requestTime"] = {
          value: responseStart - requestStart,
          unit: "millisecond"
        };
      }
    }
    function getSampleRate(transactionContext, options, interactionsSampleRate) {
      if (!core.hasTracingEnabled(options)) {
        return false;
      }
      let sampleRate;
      if (transactionContext !== void 0 && typeof options.tracesSampler === "function") {
        sampleRate = options.tracesSampler({
          transactionContext,
          name: transactionContext.name,
          parentSampled: transactionContext.parentSampled,
          attributes: {
            // eslint-disable-next-line deprecation/deprecation
            ...transactionContext.data,
            ...transactionContext.attributes
          },
          location: types.WINDOW.location
        });
      } else if (transactionContext !== void 0 && transactionContext.sampled !== void 0) {
        sampleRate = transactionContext.sampled;
      } else if (typeof options.tracesSampleRate !== "undefined") {
        sampleRate = options.tracesSampleRate;
      } else {
        sampleRate = 1;
      }
      if (!core.isValidSampleRate(sampleRate)) {
        debugBuild.DEBUG_BUILD && utils.logger.warn("[Tracing] Discarding interaction span because of invalid sample rate.");
        return false;
      }
      if (sampleRate === true) {
        return interactionsSampleRate;
      } else if (sampleRate === false) {
        return 0;
      }
      return sampleRate * interactionsSampleRate;
    }
    exports._addMeasureSpans = _addMeasureSpans;
    exports._addResourceSpans = _addResourceSpans;
    exports.addPerformanceEntries = addPerformanceEntries;
    exports.startTrackingINP = startTrackingINP;
    exports.startTrackingInteractions = startTrackingInteractions;
    exports.startTrackingLongTasks = startTrackingLongTasks;
    exports.startTrackingWebVitals = startTrackingWebVitals;
  }
});

// ../../node_modules/.pnpm/@sentry-internal+tracing@7.120.1/node_modules/@sentry-internal/tracing/cjs/common/fetch.js
var require_fetch2 = __commonJS({
  "../../node_modules/.pnpm/@sentry-internal+tracing@7.120.1/node_modules/@sentry-internal/tracing/cjs/common/fetch.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var core = require_cjs2();
    var utils = require_cjs();
    function instrumentFetchRequest(handlerData, shouldCreateSpan, shouldAttachHeaders, spans, spanOrigin = "auto.http.browser") {
      if (!core.hasTracingEnabled() || !handlerData.fetchData) {
        return void 0;
      }
      const shouldCreateSpanResult = shouldCreateSpan(handlerData.fetchData.url);
      if (handlerData.endTimestamp && shouldCreateSpanResult) {
        const spanId = handlerData.fetchData.__span;
        if (!spanId)
          return;
        const span2 = spans[spanId];
        if (span2) {
          endSpan(span2, handlerData);
          delete spans[spanId];
        }
        return void 0;
      }
      const scope = core.getCurrentScope();
      const client = core.getClient();
      const { method, url } = handlerData.fetchData;
      const fullUrl = getFullURL(url);
      const host = fullUrl ? utils.parseUrl(fullUrl).host : void 0;
      const span = shouldCreateSpanResult ? core.startInactiveSpan({
        name: `${method} ${url}`,
        onlyIfParent: true,
        attributes: {
          url,
          type: "fetch",
          "http.method": method,
          "http.url": fullUrl,
          "server.address": host,
          [core.SEMANTIC_ATTRIBUTE_SENTRY_ORIGIN]: spanOrigin
        },
        op: "http.client"
      }) : void 0;
      if (span) {
        handlerData.fetchData.__span = span.spanContext().spanId;
        spans[span.spanContext().spanId] = span;
      }
      if (shouldAttachHeaders(handlerData.fetchData.url) && client) {
        const request = handlerData.args[0];
        handlerData.args[1] = handlerData.args[1] || {};
        const options = handlerData.args[1];
        options.headers = addTracingHeadersToFetchRequest(request, client, scope, options, span);
      }
      return span;
    }
    function addTracingHeadersToFetchRequest(request, client, scope, options, requestSpan) {
      const span = requestSpan || scope.getSpan();
      const isolationScope = core.getIsolationScope();
      const { traceId, spanId, sampled, dsc } = {
        ...isolationScope.getPropagationContext(),
        ...scope.getPropagationContext()
      };
      const sentryTraceHeader = span ? core.spanToTraceHeader(span) : utils.generateSentryTraceHeader(traceId, spanId, sampled);
      const sentryBaggageHeader = utils.dynamicSamplingContextToSentryBaggageHeader(
        dsc || (span ? core.getDynamicSamplingContextFromSpan(span) : core.getDynamicSamplingContextFromClient(traceId, client, scope))
      );
      const headers = options.headers || (typeof Request !== "undefined" && utils.isInstanceOf(request, Request) ? request.headers : void 0);
      if (!headers) {
        return { "sentry-trace": sentryTraceHeader, baggage: sentryBaggageHeader };
      } else if (typeof Headers !== "undefined" && utils.isInstanceOf(headers, Headers)) {
        const newHeaders = new Headers(headers);
        newHeaders.append("sentry-trace", sentryTraceHeader);
        if (sentryBaggageHeader) {
          newHeaders.append(utils.BAGGAGE_HEADER_NAME, sentryBaggageHeader);
        }
        return newHeaders;
      } else if (Array.isArray(headers)) {
        const newHeaders = [...headers, ["sentry-trace", sentryTraceHeader]];
        if (sentryBaggageHeader) {
          newHeaders.push([utils.BAGGAGE_HEADER_NAME, sentryBaggageHeader]);
        }
        return newHeaders;
      } else {
        const existingBaggageHeader = "baggage" in headers ? headers.baggage : void 0;
        const newBaggageHeaders = [];
        if (Array.isArray(existingBaggageHeader)) {
          newBaggageHeaders.push(...existingBaggageHeader);
        } else if (existingBaggageHeader) {
          newBaggageHeaders.push(existingBaggageHeader);
        }
        if (sentryBaggageHeader) {
          newBaggageHeaders.push(sentryBaggageHeader);
        }
        return {
          ...headers,
          "sentry-trace": sentryTraceHeader,
          baggage: newBaggageHeaders.length > 0 ? newBaggageHeaders.join(",") : void 0
        };
      }
    }
    function getFullURL(url) {
      try {
        const parsed = new URL(url);
        return parsed.href;
      } catch (e) {
        return void 0;
      }
    }
    function endSpan(span, handlerData) {
      if (handlerData.response) {
        core.setHttpStatus(span, handlerData.response.status);
        const contentLength = handlerData.response && handlerData.response.headers && handlerData.response.headers.get("content-length");
        if (contentLength) {
          const contentLengthNum = parseInt(contentLength);
          if (contentLengthNum > 0) {
            span.setAttribute("http.response_content_length", contentLengthNum);
          }
        }
      } else if (handlerData.error) {
        span.setStatus("internal_error");
      }
      span.end();
    }
    exports.addTracingHeadersToFetchRequest = addTracingHeadersToFetchRequest;
    exports.instrumentFetchRequest = instrumentFetchRequest;
  }
});

// ../../node_modules/.pnpm/@sentry-internal+tracing@7.120.1/node_modules/@sentry-internal/tracing/cjs/browser/request.js
var require_request = __commonJS({
  "../../node_modules/.pnpm/@sentry-internal+tracing@7.120.1/node_modules/@sentry-internal/tracing/cjs/browser/request.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var core = require_cjs2();
    var utils = require_cjs();
    var fetch2 = require_fetch2();
    var instrument = require_instrument2();
    var types = require_types();
    var DEFAULT_TRACE_PROPAGATION_TARGETS = ["localhost", /^\/(?!\/)/];
    var defaultRequestInstrumentationOptions = {
      traceFetch: true,
      traceXHR: true,
      enableHTTPTimings: true,
      // TODO (v8): Remove this property
      tracingOrigins: DEFAULT_TRACE_PROPAGATION_TARGETS,
      tracePropagationTargets: DEFAULT_TRACE_PROPAGATION_TARGETS
    };
    function instrumentOutgoingRequests(_options) {
      const {
        traceFetch,
        traceXHR,
        // eslint-disable-next-line deprecation/deprecation
        tracePropagationTargets,
        // eslint-disable-next-line deprecation/deprecation
        tracingOrigins,
        shouldCreateSpanForRequest,
        enableHTTPTimings
      } = {
        traceFetch: defaultRequestInstrumentationOptions.traceFetch,
        traceXHR: defaultRequestInstrumentationOptions.traceXHR,
        ..._options
      };
      const shouldCreateSpan = typeof shouldCreateSpanForRequest === "function" ? shouldCreateSpanForRequest : (_) => true;
      const shouldAttachHeadersWithTargets = (url) => shouldAttachHeaders(url, tracePropagationTargets || tracingOrigins);
      const spans = {};
      if (traceFetch) {
        utils.addFetchInstrumentationHandler((handlerData) => {
          const createdSpan = fetch2.instrumentFetchRequest(handlerData, shouldCreateSpan, shouldAttachHeadersWithTargets, spans);
          if (createdSpan) {
            const fullUrl = getFullURL(handlerData.fetchData.url);
            const host = fullUrl ? utils.parseUrl(fullUrl).host : void 0;
            createdSpan.setAttributes({
              "http.url": fullUrl,
              "server.address": host
            });
          }
          if (enableHTTPTimings && createdSpan) {
            addHTTPTimings(createdSpan);
          }
        });
      }
      if (traceXHR) {
        utils.addXhrInstrumentationHandler((handlerData) => {
          const createdSpan = xhrCallback(handlerData, shouldCreateSpan, shouldAttachHeadersWithTargets, spans);
          if (enableHTTPTimings && createdSpan) {
            addHTTPTimings(createdSpan);
          }
        });
      }
    }
    function isPerformanceResourceTiming(entry) {
      return entry.entryType === "resource" && "initiatorType" in entry && typeof entry.nextHopProtocol === "string" && (entry.initiatorType === "fetch" || entry.initiatorType === "xmlhttprequest");
    }
    function addHTTPTimings(span) {
      const { url } = core.spanToJSON(span).data || {};
      if (!url || typeof url !== "string") {
        return;
      }
      const cleanup = instrument.addPerformanceInstrumentationHandler("resource", ({ entries }) => {
        entries.forEach((entry) => {
          if (isPerformanceResourceTiming(entry) && entry.name.endsWith(url)) {
            const spanData = resourceTimingEntryToSpanData(entry);
            spanData.forEach((data) => span.setAttribute(...data));
            setTimeout(cleanup);
          }
        });
      });
    }
    function extractNetworkProtocol(nextHopProtocol) {
      let name = "unknown";
      let version = "unknown";
      let _name = "";
      for (const char of nextHopProtocol) {
        if (char === "/") {
          [name, version] = nextHopProtocol.split("/");
          break;
        }
        if (!isNaN(Number(char))) {
          name = _name === "h" ? "http" : _name;
          version = nextHopProtocol.split(_name)[1];
          break;
        }
        _name += char;
      }
      if (_name === nextHopProtocol) {
        name = _name;
      }
      return { name, version };
    }
    function getAbsoluteTime(time = 0) {
      return ((utils.browserPerformanceTimeOrigin || performance.timeOrigin) + time) / 1e3;
    }
    function resourceTimingEntryToSpanData(resourceTiming) {
      const { name, version } = extractNetworkProtocol(resourceTiming.nextHopProtocol);
      const timingSpanData = [];
      timingSpanData.push(["network.protocol.version", version], ["network.protocol.name", name]);
      if (!utils.browserPerformanceTimeOrigin) {
        return timingSpanData;
      }
      return [
        ...timingSpanData,
        ["http.request.redirect_start", getAbsoluteTime(resourceTiming.redirectStart)],
        ["http.request.fetch_start", getAbsoluteTime(resourceTiming.fetchStart)],
        ["http.request.domain_lookup_start", getAbsoluteTime(resourceTiming.domainLookupStart)],
        ["http.request.domain_lookup_end", getAbsoluteTime(resourceTiming.domainLookupEnd)],
        ["http.request.connect_start", getAbsoluteTime(resourceTiming.connectStart)],
        ["http.request.secure_connection_start", getAbsoluteTime(resourceTiming.secureConnectionStart)],
        ["http.request.connection_end", getAbsoluteTime(resourceTiming.connectEnd)],
        ["http.request.request_start", getAbsoluteTime(resourceTiming.requestStart)],
        ["http.request.response_start", getAbsoluteTime(resourceTiming.responseStart)],
        ["http.request.response_end", getAbsoluteTime(resourceTiming.responseEnd)]
      ];
    }
    function shouldAttachHeaders(url, tracePropagationTargets) {
      return utils.stringMatchesSomePattern(url, tracePropagationTargets || DEFAULT_TRACE_PROPAGATION_TARGETS);
    }
    function xhrCallback(handlerData, shouldCreateSpan, shouldAttachHeaders2, spans) {
      const xhr = handlerData.xhr;
      const sentryXhrData = xhr && xhr[utils.SENTRY_XHR_DATA_KEY];
      if (!core.hasTracingEnabled() || !xhr || xhr.__sentry_own_request__ || !sentryXhrData) {
        return void 0;
      }
      const shouldCreateSpanResult = shouldCreateSpan(sentryXhrData.url);
      if (handlerData.endTimestamp && shouldCreateSpanResult) {
        const spanId = xhr.__sentry_xhr_span_id__;
        if (!spanId)
          return;
        const span2 = spans[spanId];
        if (span2 && sentryXhrData.status_code !== void 0) {
          core.setHttpStatus(span2, sentryXhrData.status_code);
          span2.end();
          delete spans[spanId];
        }
        return void 0;
      }
      const scope = core.getCurrentScope();
      const isolationScope = core.getIsolationScope();
      const fullUrl = getFullURL(sentryXhrData.url);
      const host = fullUrl ? utils.parseUrl(fullUrl).host : void 0;
      const span = shouldCreateSpanResult ? core.startInactiveSpan({
        name: `${sentryXhrData.method} ${sentryXhrData.url}`,
        onlyIfParent: true,
        attributes: {
          type: "xhr",
          "http.method": sentryXhrData.method,
          "http.url": fullUrl,
          url: sentryXhrData.url,
          "server.address": host,
          [core.SEMANTIC_ATTRIBUTE_SENTRY_ORIGIN]: "auto.http.browser"
        },
        op: "http.client"
      }) : void 0;
      if (span) {
        xhr.__sentry_xhr_span_id__ = span.spanContext().spanId;
        spans[xhr.__sentry_xhr_span_id__] = span;
      }
      const client = core.getClient();
      if (xhr.setRequestHeader && shouldAttachHeaders2(sentryXhrData.url) && client) {
        const { traceId, spanId, sampled, dsc } = {
          ...isolationScope.getPropagationContext(),
          ...scope.getPropagationContext()
        };
        const sentryTraceHeader = span ? core.spanToTraceHeader(span) : utils.generateSentryTraceHeader(traceId, spanId, sampled);
        const sentryBaggageHeader = utils.dynamicSamplingContextToSentryBaggageHeader(
          dsc || (span ? core.getDynamicSamplingContextFromSpan(span) : core.getDynamicSamplingContextFromClient(traceId, client, scope))
        );
        setHeaderOnXhr(xhr, sentryTraceHeader, sentryBaggageHeader);
      }
      return span;
    }
    function setHeaderOnXhr(xhr, sentryTraceHeader, sentryBaggageHeader) {
      try {
        xhr.setRequestHeader("sentry-trace", sentryTraceHeader);
        if (sentryBaggageHeader) {
          xhr.setRequestHeader(utils.BAGGAGE_HEADER_NAME, sentryBaggageHeader);
        }
      } catch (_) {
      }
    }
    function getFullURL(url) {
      try {
        const parsed = new URL(url, types.WINDOW.location.origin);
        return parsed.href;
      } catch (e) {
        return void 0;
      }
    }
    exports.DEFAULT_TRACE_PROPAGATION_TARGETS = DEFAULT_TRACE_PROPAGATION_TARGETS;
    exports.defaultRequestInstrumentationOptions = defaultRequestInstrumentationOptions;
    exports.extractNetworkProtocol = extractNetworkProtocol;
    exports.instrumentOutgoingRequests = instrumentOutgoingRequests;
    exports.shouldAttachHeaders = shouldAttachHeaders;
    exports.xhrCallback = xhrCallback;
  }
});

// ../../node_modules/.pnpm/@sentry-internal+tracing@7.120.1/node_modules/@sentry-internal/tracing/cjs/browser/router.js
var require_router = __commonJS({
  "../../node_modules/.pnpm/@sentry-internal+tracing@7.120.1/node_modules/@sentry-internal/tracing/cjs/browser/router.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var utils = require_cjs();
    var debugBuild = require_debug_build3();
    var types = require_types();
    function instrumentRoutingWithDefaults(customStartTransaction, startTransactionOnPageLoad = true, startTransactionOnLocationChange = true) {
      if (!types.WINDOW || !types.WINDOW.location) {
        debugBuild.DEBUG_BUILD && utils.logger.warn("Could not initialize routing instrumentation due to invalid location");
        return;
      }
      let startingUrl = types.WINDOW.location.href;
      let activeTransaction;
      if (startTransactionOnPageLoad) {
        activeTransaction = customStartTransaction({
          name: types.WINDOW.location.pathname,
          // pageload should always start at timeOrigin (and needs to be in s, not ms)
          startTimestamp: utils.browserPerformanceTimeOrigin ? utils.browserPerformanceTimeOrigin / 1e3 : void 0,
          op: "pageload",
          origin: "auto.pageload.browser",
          metadata: { source: "url" }
        });
      }
      if (startTransactionOnLocationChange) {
        utils.addHistoryInstrumentationHandler(({ to, from }) => {
          if (from === void 0 && startingUrl && startingUrl.indexOf(to) !== -1) {
            startingUrl = void 0;
            return;
          }
          if (from !== to) {
            startingUrl = void 0;
            if (activeTransaction) {
              debugBuild.DEBUG_BUILD && utils.logger.log(`[Tracing] Finishing current transaction with op: ${activeTransaction.op}`);
              activeTransaction.end();
            }
            activeTransaction = customStartTransaction({
              name: types.WINDOW.location.pathname,
              op: "navigation",
              origin: "auto.navigation.browser",
              metadata: { source: "url" }
            });
          }
        });
      }
    }
    exports.instrumentRoutingWithDefaults = instrumentRoutingWithDefaults;
  }
});

// ../../node_modules/.pnpm/@sentry-internal+tracing@7.120.1/node_modules/@sentry-internal/tracing/cjs/browser/browsertracing.js
var require_browsertracing = __commonJS({
  "../../node_modules/.pnpm/@sentry-internal+tracing@7.120.1/node_modules/@sentry-internal/tracing/cjs/browser/browsertracing.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var core = require_cjs2();
    var utils = require_cjs();
    var debugBuild = require_debug_build3();
    var backgroundtab = require_backgroundtab();
    var instrument = require_instrument2();
    var index = require_metrics();
    var request = require_request();
    var router = require_router();
    var types = require_types();
    var BROWSER_TRACING_INTEGRATION_ID = "BrowserTracing";
    var DEFAULT_BROWSER_TRACING_OPTIONS = {
      ...core.TRACING_DEFAULTS,
      markBackgroundTransactions: true,
      routingInstrumentation: router.instrumentRoutingWithDefaults,
      startTransactionOnLocationChange: true,
      startTransactionOnPageLoad: true,
      enableLongTask: true,
      enableInp: false,
      interactionsSampleRate: 1,
      _experiments: {},
      ...request.defaultRequestInstrumentationOptions
    };
    var MAX_INTERACTIONS = 10;
    var BrowserTracing = class {
      // This class currently doesn't have a static `id` field like the other integration classes, because it prevented
      // @sentry/tracing from being treeshaken. Tree shakers do not like static fields, because they behave like side effects.
      // TODO: Come up with a better plan, than using static fields on integration classes, and use that plan on all
      // integrations.
      /** Browser Tracing integration options */
      /**
       * @inheritDoc
       */
      // eslint-disable-next-line deprecation/deprecation
      constructor(_options) {
        this.name = BROWSER_TRACING_INTEGRATION_ID;
        this._hasSetTracePropagationTargets = false;
        core.addTracingExtensions();
        if (debugBuild.DEBUG_BUILD) {
          this._hasSetTracePropagationTargets = !!(_options && // eslint-disable-next-line deprecation/deprecation
          (_options.tracePropagationTargets || _options.tracingOrigins));
        }
        this.options = {
          ...DEFAULT_BROWSER_TRACING_OPTIONS,
          ..._options
        };
        if (this.options._experiments.enableLongTask !== void 0) {
          this.options.enableLongTask = this.options._experiments.enableLongTask;
        }
        if (_options && !_options.tracePropagationTargets && _options.tracingOrigins) {
          this.options.tracePropagationTargets = _options.tracingOrigins;
        }
        this._collectWebVitals = index.startTrackingWebVitals();
        this._interactionIdToRouteNameMapping = {};
        if (this.options.enableInp) {
          index.startTrackingINP(this._interactionIdToRouteNameMapping, this.options.interactionsSampleRate);
        }
        if (this.options.enableLongTask) {
          index.startTrackingLongTasks();
        }
        if (this.options._experiments.enableInteractions) {
          index.startTrackingInteractions();
        }
        this._latestRoute = {
          name: void 0,
          context: void 0
        };
      }
      /**
       * @inheritDoc
       */
      // eslint-disable-next-line deprecation/deprecation
      setupOnce(_, getCurrentHub) {
        this._getCurrentHub = getCurrentHub;
        const hub = getCurrentHub();
        const client = hub.getClient();
        const clientOptions = client && client.getOptions();
        const {
          routingInstrumentation: instrumentRouting,
          startTransactionOnLocationChange,
          startTransactionOnPageLoad,
          markBackgroundTransactions,
          traceFetch,
          traceXHR,
          shouldCreateSpanForRequest,
          enableHTTPTimings,
          _experiments
        } = this.options;
        const clientOptionsTracePropagationTargets = clientOptions && clientOptions.tracePropagationTargets;
        const tracePropagationTargets = clientOptionsTracePropagationTargets || this.options.tracePropagationTargets;
        if (debugBuild.DEBUG_BUILD && this._hasSetTracePropagationTargets && clientOptionsTracePropagationTargets) {
          utils.logger.warn(
            "[Tracing] The `tracePropagationTargets` option was set in the BrowserTracing integration and top level `Sentry.init`. The top level `Sentry.init` value is being used."
          );
        }
        instrumentRouting(
          (context) => {
            const transaction = this._createRouteTransaction(context);
            this.options._experiments.onStartRouteTransaction && this.options._experiments.onStartRouteTransaction(transaction, context, getCurrentHub);
            return transaction;
          },
          startTransactionOnPageLoad,
          startTransactionOnLocationChange
        );
        if (markBackgroundTransactions) {
          backgroundtab.registerBackgroundTabDetection();
        }
        if (_experiments.enableInteractions) {
          this._registerInteractionListener();
        }
        if (this.options.enableInp) {
          this._registerInpInteractionListener();
        }
        request.instrumentOutgoingRequests({
          traceFetch,
          traceXHR,
          tracePropagationTargets,
          shouldCreateSpanForRequest,
          enableHTTPTimings
        });
      }
      /** Create routing idle transaction. */
      _createRouteTransaction(context) {
        if (!this._getCurrentHub) {
          debugBuild.DEBUG_BUILD && utils.logger.warn(`[Tracing] Did not create ${context.op} transaction because _getCurrentHub is invalid.`);
          return void 0;
        }
        const hub = this._getCurrentHub();
        const { beforeNavigate, idleTimeout, finalTimeout, heartbeatInterval } = this.options;
        const isPageloadTransaction = context.op === "pageload";
        let expandedContext;
        if (isPageloadTransaction) {
          const sentryTrace = isPageloadTransaction ? getMetaContent("sentry-trace") : "";
          const baggage = isPageloadTransaction ? getMetaContent("baggage") : void 0;
          const { traceId, dsc, parentSpanId, sampled } = utils.propagationContextFromHeaders(sentryTrace, baggage);
          expandedContext = {
            traceId,
            parentSpanId,
            parentSampled: sampled,
            ...context,
            metadata: {
              // eslint-disable-next-line deprecation/deprecation
              ...context.metadata,
              dynamicSamplingContext: dsc
            },
            trimEnd: true
          };
        } else {
          expandedContext = {
            trimEnd: true,
            ...context
          };
        }
        const modifiedContext = typeof beforeNavigate === "function" ? beforeNavigate(expandedContext) : expandedContext;
        const finalContext = modifiedContext === void 0 ? { ...expandedContext, sampled: false } : modifiedContext;
        finalContext.metadata = finalContext.name !== expandedContext.name ? (
          // eslint-disable-next-line deprecation/deprecation
          { ...finalContext.metadata, source: "custom" }
        ) : (
          // eslint-disable-next-line deprecation/deprecation
          finalContext.metadata
        );
        this._latestRoute.name = finalContext.name;
        this._latestRoute.context = finalContext;
        if (finalContext.sampled === false) {
          debugBuild.DEBUG_BUILD && utils.logger.log(`[Tracing] Will not send ${finalContext.op} transaction because of beforeNavigate.`);
        }
        debugBuild.DEBUG_BUILD && utils.logger.log(`[Tracing] Starting ${finalContext.op} transaction on scope`);
        const { location } = types.WINDOW;
        const idleTransaction = core.startIdleTransaction(
          hub,
          finalContext,
          idleTimeout,
          finalTimeout,
          true,
          { location },
          // for use in the tracesSampler
          heartbeatInterval,
          isPageloadTransaction
          // should wait for finish signal if it's a pageload transaction
        );
        if (isPageloadTransaction) {
          if (types.WINDOW.document) {
            types.WINDOW.document.addEventListener("readystatechange", () => {
              if (["interactive", "complete"].includes(types.WINDOW.document.readyState)) {
                idleTransaction.sendAutoFinishSignal();
              }
            });
            if (["interactive", "complete"].includes(types.WINDOW.document.readyState)) {
              idleTransaction.sendAutoFinishSignal();
            }
          }
        }
        idleTransaction.registerBeforeFinishCallback((transaction) => {
          this._collectWebVitals();
          index.addPerformanceEntries(transaction);
        });
        return idleTransaction;
      }
      /** Start listener for interaction transactions */
      _registerInteractionListener() {
        let inflightInteractionTransaction;
        const registerInteractionTransaction = () => {
          const { idleTimeout, finalTimeout, heartbeatInterval } = this.options;
          const op = "ui.action.click";
          const currentTransaction = core.getActiveTransaction();
          if (currentTransaction && currentTransaction.op && ["navigation", "pageload"].includes(currentTransaction.op)) {
            debugBuild.DEBUG_BUILD && utils.logger.warn(
              `[Tracing] Did not create ${op} transaction because a pageload or navigation transaction is in progress.`
            );
            return void 0;
          }
          if (inflightInteractionTransaction) {
            inflightInteractionTransaction.setFinishReason("interactionInterrupted");
            inflightInteractionTransaction.end();
            inflightInteractionTransaction = void 0;
          }
          if (!this._getCurrentHub) {
            debugBuild.DEBUG_BUILD && utils.logger.warn(`[Tracing] Did not create ${op} transaction because _getCurrentHub is invalid.`);
            return void 0;
          }
          if (!this._latestRoute.name) {
            debugBuild.DEBUG_BUILD && utils.logger.warn(`[Tracing] Did not create ${op} transaction because _latestRouteName is missing.`);
            return void 0;
          }
          const hub = this._getCurrentHub();
          const { location } = types.WINDOW;
          const context = {
            name: this._latestRoute.name,
            op,
            trimEnd: true,
            data: {
              [core.SEMANTIC_ATTRIBUTE_SENTRY_SOURCE]: this._latestRoute.context ? getSource(this._latestRoute.context) : "url"
            }
          };
          inflightInteractionTransaction = core.startIdleTransaction(
            hub,
            context,
            idleTimeout,
            finalTimeout,
            true,
            { location },
            // for use in the tracesSampler
            heartbeatInterval
          );
        };
        ["click"].forEach((type) => {
          if (types.WINDOW.document) {
            addEventListener(type, registerInteractionTransaction, { once: false, capture: true });
          }
        });
      }
      /** Creates a listener on interaction entries, and maps interactionIds to the origin path of the interaction */
      _registerInpInteractionListener() {
        const handleEntries = ({ entries }) => {
          const client = core.getClient();
          const replay = client !== void 0 && client.getIntegrationByName !== void 0 ? client.getIntegrationByName("Replay") : void 0;
          const replayId = replay !== void 0 ? replay.getReplayId() : void 0;
          const activeTransaction = core.getActiveTransaction();
          const currentScope = core.getCurrentScope();
          const user = currentScope !== void 0 ? currentScope.getUser() : void 0;
          entries.forEach((entry) => {
            if (isPerformanceEventTiming(entry)) {
              const interactionId = entry.interactionId;
              if (interactionId === void 0) {
                return;
              }
              const existingInteraction = this._interactionIdToRouteNameMapping[interactionId];
              const duration = entry.duration;
              const startTime = entry.startTime;
              const keys = Object.keys(this._interactionIdToRouteNameMapping);
              const minInteractionId = keys.length > 0 ? keys.reduce((a, b) => {
                return this._interactionIdToRouteNameMapping[a].duration < this._interactionIdToRouteNameMapping[b].duration ? a : b;
              }) : void 0;
              if (entry.entryType === "first-input") {
                const matchingEntry = keys.map((key) => this._interactionIdToRouteNameMapping[key]).some((interaction) => {
                  return interaction.duration === duration && interaction.startTime === startTime;
                });
                if (matchingEntry) {
                  return;
                }
              }
              if (!interactionId) {
                return;
              }
              if (existingInteraction) {
                existingInteraction.duration = Math.max(existingInteraction.duration, duration);
              } else if (keys.length < MAX_INTERACTIONS || minInteractionId === void 0 || duration > this._interactionIdToRouteNameMapping[minInteractionId].duration) {
                const routeName = this._latestRoute.name;
                const parentContext = this._latestRoute.context;
                if (routeName && parentContext) {
                  if (minInteractionId && Object.keys(this._interactionIdToRouteNameMapping).length >= MAX_INTERACTIONS) {
                    delete this._interactionIdToRouteNameMapping[minInteractionId];
                  }
                  this._interactionIdToRouteNameMapping[interactionId] = {
                    routeName,
                    duration,
                    parentContext,
                    user,
                    activeTransaction,
                    replayId,
                    startTime
                  };
                }
              }
            }
          });
        };
        instrument.addPerformanceInstrumentationHandler("event", handleEntries);
        instrument.addPerformanceInstrumentationHandler("first-input", handleEntries);
      }
    };
    function getMetaContent(metaName) {
      const metaTag = utils.getDomElement(`meta[name=${metaName}]`);
      return metaTag ? metaTag.getAttribute("content") : void 0;
    }
    function getSource(context) {
      const sourceFromAttributes = context.attributes && context.attributes[core.SEMANTIC_ATTRIBUTE_SENTRY_SOURCE];
      const sourceFromData = context.data && context.data[core.SEMANTIC_ATTRIBUTE_SENTRY_SOURCE];
      const sourceFromMetadata = context.metadata && context.metadata.source;
      return sourceFromAttributes || sourceFromData || sourceFromMetadata;
    }
    function isPerformanceEventTiming(entry) {
      return "duration" in entry;
    }
    exports.BROWSER_TRACING_INTEGRATION_ID = BROWSER_TRACING_INTEGRATION_ID;
    exports.BrowserTracing = BrowserTracing;
    exports.getMetaContent = getMetaContent;
  }
});

// ../../node_modules/.pnpm/@sentry-internal+tracing@7.120.1/node_modules/@sentry-internal/tracing/cjs/browser/browserTracingIntegration.js
var require_browserTracingIntegration = __commonJS({
  "../../node_modules/.pnpm/@sentry-internal+tracing@7.120.1/node_modules/@sentry-internal/tracing/cjs/browser/browserTracingIntegration.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var core = require_cjs2();
    var utils = require_cjs();
    var debugBuild = require_debug_build3();
    var backgroundtab = require_backgroundtab();
    var instrument = require_instrument2();
    var index = require_metrics();
    var request = require_request();
    var types = require_types();
    var BROWSER_TRACING_INTEGRATION_ID = "BrowserTracing";
    var DEFAULT_BROWSER_TRACING_OPTIONS = {
      ...core.TRACING_DEFAULTS,
      instrumentNavigation: true,
      instrumentPageLoad: true,
      markBackgroundSpan: true,
      enableLongTask: true,
      enableInp: false,
      interactionsSampleRate: 1,
      _experiments: {},
      ...request.defaultRequestInstrumentationOptions
    };
    var browserTracingIntegration = (_options = {}) => {
      const _hasSetTracePropagationTargets = debugBuild.DEBUG_BUILD ? !!// eslint-disable-next-line deprecation/deprecation
      (_options.tracePropagationTargets || _options.tracingOrigins) : false;
      core.addTracingExtensions();
      if (!_options.tracePropagationTargets && _options.tracingOrigins) {
        _options.tracePropagationTargets = _options.tracingOrigins;
      }
      const options = {
        ...DEFAULT_BROWSER_TRACING_OPTIONS,
        ..._options
      };
      const _collectWebVitals = index.startTrackingWebVitals();
      const interactionIdToRouteNameMapping = {};
      if (options.enableInp) {
        index.startTrackingINP(interactionIdToRouteNameMapping, options.interactionsSampleRate);
      }
      if (options.enableLongTask) {
        index.startTrackingLongTasks();
      }
      if (options._experiments.enableInteractions) {
        index.startTrackingInteractions();
      }
      const latestRoute = {
        name: void 0,
        context: void 0
      };
      function _createRouteTransaction(context) {
        const hub = core.getCurrentHub();
        const { beforeStartSpan, idleTimeout, finalTimeout, heartbeatInterval } = options;
        const isPageloadTransaction = context.op === "pageload";
        let expandedContext;
        if (isPageloadTransaction) {
          const sentryTrace = isPageloadTransaction ? getMetaContent("sentry-trace") : "";
          const baggage = isPageloadTransaction ? getMetaContent("baggage") : void 0;
          const { traceId, dsc, parentSpanId, sampled } = utils.propagationContextFromHeaders(sentryTrace, baggage);
          expandedContext = {
            traceId,
            parentSpanId,
            parentSampled: sampled,
            ...context,
            metadata: {
              // eslint-disable-next-line deprecation/deprecation
              ...context.metadata,
              dynamicSamplingContext: dsc
            },
            trimEnd: true
          };
        } else {
          expandedContext = {
            trimEnd: true,
            ...context
          };
        }
        const finalContext = beforeStartSpan ? beforeStartSpan(expandedContext) : expandedContext;
        finalContext.metadata = finalContext.name !== expandedContext.name ? (
          // eslint-disable-next-line deprecation/deprecation
          { ...finalContext.metadata, source: "custom" }
        ) : (
          // eslint-disable-next-line deprecation/deprecation
          finalContext.metadata
        );
        latestRoute.name = finalContext.name;
        latestRoute.context = finalContext;
        if (finalContext.sampled === false) {
          debugBuild.DEBUG_BUILD && utils.logger.log(`[Tracing] Will not send ${finalContext.op} transaction because of beforeNavigate.`);
        }
        debugBuild.DEBUG_BUILD && utils.logger.log(`[Tracing] Starting ${finalContext.op} transaction on scope`);
        const { location } = types.WINDOW;
        const idleTransaction = core.startIdleTransaction(
          hub,
          finalContext,
          idleTimeout,
          finalTimeout,
          true,
          { location },
          // for use in the tracesSampler
          heartbeatInterval,
          isPageloadTransaction
          // should wait for finish signal if it's a pageload transaction
        );
        if (isPageloadTransaction && types.WINDOW.document) {
          types.WINDOW.document.addEventListener("readystatechange", () => {
            if (["interactive", "complete"].includes(types.WINDOW.document.readyState)) {
              idleTransaction.sendAutoFinishSignal();
            }
          });
          if (["interactive", "complete"].includes(types.WINDOW.document.readyState)) {
            idleTransaction.sendAutoFinishSignal();
          }
        }
        idleTransaction.registerBeforeFinishCallback((transaction) => {
          _collectWebVitals();
          index.addPerformanceEntries(transaction);
        });
        return idleTransaction;
      }
      return {
        name: BROWSER_TRACING_INTEGRATION_ID,
        // eslint-disable-next-line @typescript-eslint/no-empty-function
        setupOnce: () => {
        },
        afterAllSetup(client) {
          const clientOptions = client.getOptions();
          const { markBackgroundSpan, traceFetch, traceXHR, shouldCreateSpanForRequest, enableHTTPTimings, _experiments } = options;
          const clientOptionsTracePropagationTargets = clientOptions && clientOptions.tracePropagationTargets;
          const tracePropagationTargets = clientOptionsTracePropagationTargets || options.tracePropagationTargets;
          if (debugBuild.DEBUG_BUILD && _hasSetTracePropagationTargets && clientOptionsTracePropagationTargets) {
            utils.logger.warn(
              "[Tracing] The `tracePropagationTargets` option was set in the BrowserTracing integration and top level `Sentry.init`. The top level `Sentry.init` value is being used."
            );
          }
          let activeSpan;
          let startingUrl = types.WINDOW.location && types.WINDOW.location.href;
          if (client.on) {
            client.on("startNavigationSpan", (context) => {
              if (activeSpan) {
                debugBuild.DEBUG_BUILD && utils.logger.log(`[Tracing] Finishing current transaction with op: ${core.spanToJSON(activeSpan).op}`);
                activeSpan.end();
              }
              activeSpan = _createRouteTransaction({
                op: "navigation",
                ...context
              });
            });
            client.on("startPageLoadSpan", (context) => {
              if (activeSpan) {
                debugBuild.DEBUG_BUILD && utils.logger.log(`[Tracing] Finishing current transaction with op: ${core.spanToJSON(activeSpan).op}`);
                activeSpan.end();
              }
              activeSpan = _createRouteTransaction({
                op: "pageload",
                ...context
              });
            });
          }
          if (options.instrumentPageLoad && client.emit && types.WINDOW.location) {
            const context = {
              name: types.WINDOW.location.pathname,
              // pageload should always start at timeOrigin (and needs to be in s, not ms)
              startTimestamp: utils.browserPerformanceTimeOrigin ? utils.browserPerformanceTimeOrigin / 1e3 : void 0,
              origin: "auto.pageload.browser",
              attributes: {
                [core.SEMANTIC_ATTRIBUTE_SENTRY_SOURCE]: "url"
              }
            };
            startBrowserTracingPageLoadSpan(client, context);
          }
          if (options.instrumentNavigation && client.emit && types.WINDOW.location) {
            utils.addHistoryInstrumentationHandler(({ to, from }) => {
              if (from === void 0 && startingUrl && startingUrl.indexOf(to) !== -1) {
                startingUrl = void 0;
                return;
              }
              if (from !== to) {
                startingUrl = void 0;
                const context = {
                  name: types.WINDOW.location.pathname,
                  origin: "auto.navigation.browser",
                  attributes: {
                    [core.SEMANTIC_ATTRIBUTE_SENTRY_SOURCE]: "url"
                  }
                };
                startBrowserTracingNavigationSpan(client, context);
              }
            });
          }
          if (markBackgroundSpan) {
            backgroundtab.registerBackgroundTabDetection();
          }
          if (_experiments.enableInteractions) {
            registerInteractionListener(options, latestRoute);
          }
          if (options.enableInp) {
            registerInpInteractionListener(interactionIdToRouteNameMapping, latestRoute);
          }
          request.instrumentOutgoingRequests({
            traceFetch,
            traceXHR,
            tracePropagationTargets,
            shouldCreateSpanForRequest,
            enableHTTPTimings
          });
        },
        // TODO v8: Remove this again
        // This is private API that we use to fix converted BrowserTracing integrations in Next.js & SvelteKit
        options
      };
    };
    function startBrowserTracingPageLoadSpan(client, spanOptions) {
      if (!client.emit) {
        return;
      }
      client.emit("startPageLoadSpan", spanOptions);
      const span = core.getActiveSpan();
      const op = span && core.spanToJSON(span).op;
      return op === "pageload" ? span : void 0;
    }
    function startBrowserTracingNavigationSpan(client, spanOptions) {
      if (!client.emit) {
        return;
      }
      client.emit("startNavigationSpan", spanOptions);
      const span = core.getActiveSpan();
      const op = span && core.spanToJSON(span).op;
      return op === "navigation" ? span : void 0;
    }
    function getMetaContent(metaName) {
      const metaTag = utils.getDomElement(`meta[name=${metaName}]`);
      return metaTag ? metaTag.getAttribute("content") : void 0;
    }
    function registerInteractionListener(options, latestRoute) {
      let inflightInteractionTransaction;
      const registerInteractionTransaction = () => {
        const { idleTimeout, finalTimeout, heartbeatInterval } = options;
        const op = "ui.action.click";
        const currentTransaction = core.getActiveTransaction();
        if (currentTransaction && currentTransaction.op && ["navigation", "pageload"].includes(currentTransaction.op)) {
          debugBuild.DEBUG_BUILD && utils.logger.warn(
            `[Tracing] Did not create ${op} transaction because a pageload or navigation transaction is in progress.`
          );
          return void 0;
        }
        if (inflightInteractionTransaction) {
          inflightInteractionTransaction.setFinishReason("interactionInterrupted");
          inflightInteractionTransaction.end();
          inflightInteractionTransaction = void 0;
        }
        if (!latestRoute.name) {
          debugBuild.DEBUG_BUILD && utils.logger.warn(`[Tracing] Did not create ${op} transaction because _latestRouteName is missing.`);
          return void 0;
        }
        const { location } = types.WINDOW;
        const context = {
          name: latestRoute.name,
          op,
          trimEnd: true,
          data: {
            [core.SEMANTIC_ATTRIBUTE_SENTRY_SOURCE]: latestRoute.context ? getSource(latestRoute.context) : "url"
          }
        };
        inflightInteractionTransaction = core.startIdleTransaction(
          // eslint-disable-next-line deprecation/deprecation
          core.getCurrentHub(),
          context,
          idleTimeout,
          finalTimeout,
          true,
          { location },
          // for use in the tracesSampler
          heartbeatInterval
        );
      };
      ["click"].forEach((type) => {
        if (types.WINDOW.document) {
          addEventListener(type, registerInteractionTransaction, { once: false, capture: true });
        }
      });
    }
    function isPerformanceEventTiming(entry) {
      return "duration" in entry;
    }
    var MAX_INTERACTIONS = 10;
    function registerInpInteractionListener(interactionIdToRouteNameMapping, latestRoute) {
      const handleEntries = ({ entries }) => {
        const client = core.getClient();
        const replay = client !== void 0 && client.getIntegrationByName !== void 0 ? client.getIntegrationByName("Replay") : void 0;
        const replayId = replay !== void 0 ? replay.getReplayId() : void 0;
        const activeTransaction = core.getActiveTransaction();
        const currentScope = core.getCurrentScope();
        const user = currentScope !== void 0 ? currentScope.getUser() : void 0;
        entries.forEach((entry) => {
          if (isPerformanceEventTiming(entry)) {
            const interactionId = entry.interactionId;
            if (interactionId === void 0) {
              return;
            }
            const existingInteraction = interactionIdToRouteNameMapping[interactionId];
            const duration = entry.duration;
            const startTime = entry.startTime;
            const keys = Object.keys(interactionIdToRouteNameMapping);
            const minInteractionId = keys.length > 0 ? keys.reduce((a, b) => {
              return interactionIdToRouteNameMapping[a].duration < interactionIdToRouteNameMapping[b].duration ? a : b;
            }) : void 0;
            if (entry.entryType === "first-input") {
              const matchingEntry = keys.map((key) => interactionIdToRouteNameMapping[key]).some((interaction) => {
                return interaction.duration === duration && interaction.startTime === startTime;
              });
              if (matchingEntry) {
                return;
              }
            }
            if (!interactionId) {
              return;
            }
            if (existingInteraction) {
              existingInteraction.duration = Math.max(existingInteraction.duration, duration);
            } else if (keys.length < MAX_INTERACTIONS || minInteractionId === void 0 || duration > interactionIdToRouteNameMapping[minInteractionId].duration) {
              const routeName = latestRoute.name;
              const parentContext = latestRoute.context;
              if (routeName && parentContext) {
                if (minInteractionId && Object.keys(interactionIdToRouteNameMapping).length >= MAX_INTERACTIONS) {
                  delete interactionIdToRouteNameMapping[minInteractionId];
                }
                interactionIdToRouteNameMapping[interactionId] = {
                  routeName,
                  duration,
                  parentContext,
                  user,
                  activeTransaction,
                  replayId,
                  startTime
                };
              }
            }
          }
        });
      };
      instrument.addPerformanceInstrumentationHandler("event", handleEntries);
      instrument.addPerformanceInstrumentationHandler("first-input", handleEntries);
    }
    function getSource(context) {
      const sourceFromAttributes = context.attributes && context.attributes[core.SEMANTIC_ATTRIBUTE_SENTRY_SOURCE];
      const sourceFromData = context.data && context.data[core.SEMANTIC_ATTRIBUTE_SENTRY_SOURCE];
      const sourceFromMetadata = context.metadata && context.metadata.source;
      return sourceFromAttributes || sourceFromData || sourceFromMetadata;
    }
    exports.BROWSER_TRACING_INTEGRATION_ID = BROWSER_TRACING_INTEGRATION_ID;
    exports.browserTracingIntegration = browserTracingIntegration;
    exports.getMetaContent = getMetaContent;
    exports.startBrowserTracingNavigationSpan = startBrowserTracingNavigationSpan;
    exports.startBrowserTracingPageLoadSpan = startBrowserTracingPageLoadSpan;
  }
});

// ../../node_modules/.pnpm/@sentry-internal+tracing@7.120.1/node_modules/@sentry-internal/tracing/cjs/extensions.js
var require_extensions = __commonJS({
  "../../node_modules/.pnpm/@sentry-internal+tracing@7.120.1/node_modules/@sentry-internal/tracing/cjs/extensions.js"(exports, module) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var core = require_cjs2();
    var utils = require_cjs();
    function _autoloadDatabaseIntegrations() {
      const carrier = core.getMainCarrier();
      if (!carrier.__SENTRY__) {
        return;
      }
      const packageToIntegrationMapping = {
        mongodb() {
          const integration = utils.dynamicRequire(module, "./node/integrations/mongo");
          return new integration.Mongo();
        },
        mongoose() {
          const integration = utils.dynamicRequire(module, "./node/integrations/mongo");
          return new integration.Mongo();
        },
        mysql() {
          const integration = utils.dynamicRequire(module, "./node/integrations/mysql");
          return new integration.Mysql();
        },
        pg() {
          const integration = utils.dynamicRequire(module, "./node/integrations/postgres");
          return new integration.Postgres();
        }
      };
      const mappedPackages = Object.keys(packageToIntegrationMapping).filter((moduleName) => !!utils.loadModule(moduleName)).map((pkg) => {
        try {
          return packageToIntegrationMapping[pkg]();
        } catch (e) {
          return void 0;
        }
      }).filter((p) => p);
      if (mappedPackages.length > 0) {
        carrier.__SENTRY__.integrations = [...carrier.__SENTRY__.integrations || [], ...mappedPackages];
      }
    }
    function addExtensionMethods() {
      core.addTracingExtensions();
      if (utils.isNodeEnv()) {
        _autoloadDatabaseIntegrations();
      }
    }
    exports.addExtensionMethods = addExtensionMethods;
  }
});

// ../../node_modules/.pnpm/@sentry-internal+tracing@7.120.1/node_modules/@sentry-internal/tracing/cjs/index.js
var require_cjs3 = __commonJS({
  "../../node_modules/.pnpm/@sentry-internal+tracing@7.120.1/node_modules/@sentry-internal/tracing/cjs/index.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var core = require_cjs2();
    var utils = require_cjs();
    var express = require_express();
    var postgres = require_postgres();
    var mysql = require_mysql();
    var mongo = require_mongo();
    var prisma = require_prisma();
    var graphql = require_graphql();
    var apollo = require_apollo();
    var lazy = require_lazy();
    var browsertracing = require_browsertracing();
    var browserTracingIntegration = require_browserTracingIntegration();
    var request = require_request();
    var instrument = require_instrument2();
    var fetch2 = require_fetch2();
    var extensions = require_extensions();
    exports.IdleTransaction = core.IdleTransaction;
    exports.Span = core.Span;
    exports.SpanStatus = core.SpanStatus;
    exports.Transaction = core.Transaction;
    exports.extractTraceparentData = core.extractTraceparentData;
    exports.getActiveTransaction = core.getActiveTransaction;
    exports.hasTracingEnabled = core.hasTracingEnabled;
    exports.spanStatusfromHttpCode = core.spanStatusfromHttpCode;
    exports.startIdleTransaction = core.startIdleTransaction;
    exports.TRACEPARENT_REGEXP = utils.TRACEPARENT_REGEXP;
    exports.stripUrlQueryAndFragment = utils.stripUrlQueryAndFragment;
    exports.Express = express.Express;
    exports.Postgres = postgres.Postgres;
    exports.Mysql = mysql.Mysql;
    exports.Mongo = mongo.Mongo;
    exports.Prisma = prisma.Prisma;
    exports.GraphQL = graphql.GraphQL;
    exports.Apollo = apollo.Apollo;
    exports.lazyLoadedNodePerformanceMonitoringIntegrations = lazy.lazyLoadedNodePerformanceMonitoringIntegrations;
    exports.BROWSER_TRACING_INTEGRATION_ID = browsertracing.BROWSER_TRACING_INTEGRATION_ID;
    exports.BrowserTracing = browsertracing.BrowserTracing;
    exports.browserTracingIntegration = browserTracingIntegration.browserTracingIntegration;
    exports.startBrowserTracingNavigationSpan = browserTracingIntegration.startBrowserTracingNavigationSpan;
    exports.startBrowserTracingPageLoadSpan = browserTracingIntegration.startBrowserTracingPageLoadSpan;
    exports.defaultRequestInstrumentationOptions = request.defaultRequestInstrumentationOptions;
    exports.instrumentOutgoingRequests = request.instrumentOutgoingRequests;
    exports.addClsInstrumentationHandler = instrument.addClsInstrumentationHandler;
    exports.addFidInstrumentationHandler = instrument.addFidInstrumentationHandler;
    exports.addLcpInstrumentationHandler = instrument.addLcpInstrumentationHandler;
    exports.addPerformanceInstrumentationHandler = instrument.addPerformanceInstrumentationHandler;
    exports.addTracingHeadersToFetchRequest = fetch2.addTracingHeadersToFetchRequest;
    exports.instrumentFetchRequest = fetch2.instrumentFetchRequest;
    exports.addExtensionMethods = extensions.addExtensionMethods;
  }
});

// ../../node_modules/.pnpm/@sentry+node@7.120.1/node_modules/@sentry/node/cjs/tracing/index.js
var require_tracing2 = __commonJS({
  "../../node_modules/.pnpm/@sentry+node@7.120.1/node_modules/@sentry/node/cjs/tracing/index.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var tracing = require_cjs3();
    var utils = require_cjs();
    function autoDiscoverNodePerformanceMonitoringIntegrations() {
      const loadedIntegrations = tracing.lazyLoadedNodePerformanceMonitoringIntegrations.map((tryLoad) => {
        try {
          return tryLoad();
        } catch (_) {
          return void 0;
        }
      }).filter((integration) => !!integration);
      if (loadedIntegrations.length === 0) {
        utils.logger.warn("Performance monitoring integrations could not be automatically loaded.");
      }
      return loadedIntegrations.filter((integration) => !!integration.loadDependency());
    }
    exports.autoDiscoverNodePerformanceMonitoringIntegrations = autoDiscoverNodePerformanceMonitoringIntegrations;
  }
});

// ../../node_modules/.pnpm/@sentry+node@7.120.1/node_modules/@sentry/node/cjs/client.js
var require_client = __commonJS({
  "../../node_modules/.pnpm/@sentry+node@7.120.1/node_modules/@sentry/node/cjs/client.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var os = __require("os");
    var util = __require("util");
    var core = require_cjs2();
    var NodeClient = class extends core.ServerRuntimeClient {
      /**
       * Creates a new Node SDK instance.
       * @param options Configuration options for this SDK.
       */
      constructor(options) {
        core.applySdkMetadata(options, "node");
        options.transportOptions = {
          textEncoder: new util.TextEncoder(),
          ...options.transportOptions
        };
        const clientOptions = {
          ...options,
          platform: "node",
          runtime: { name: "node", version: global.process.version },
          serverName: options.serverName || global.process.env.SENTRY_NAME || os.hostname()
        };
        super(clientOptions);
      }
    };
    exports.NodeClient = NodeClient;
  }
});

// ../../node_modules/.pnpm/@sentry+node@7.120.1/node_modules/@sentry/node/cjs/proxy/base.js
var require_base2 = __commonJS({
  "../../node_modules/.pnpm/@sentry+node@7.120.1/node_modules/@sentry/node/cjs/proxy/base.js"(exports) {
    var {
      _nullishCoalesce
    } = require_cjs();
    Object.defineProperty(exports, "__esModule", { value: true });
    var http = __require("http");
    __require("https");
    var INTERNAL = Symbol("AgentBaseInternalState");
    var Agent = class extends http.Agent {
      // Set by `http.Agent` - missing from `@types/node`
      constructor(opts) {
        super(opts);
        this[INTERNAL] = {};
      }
      /**
       * Determine whether this is an `http` or `https` request.
       */
      isSecureEndpoint(options) {
        if (options) {
          if (typeof options.secureEndpoint === "boolean") {
            return options.secureEndpoint;
          }
          if (typeof options.protocol === "string") {
            return options.protocol === "https:";
          }
        }
        const { stack } = new Error();
        if (typeof stack !== "string")
          return false;
        return stack.split("\n").some((l) => l.indexOf("(https.js:") !== -1 || l.indexOf("node:https:") !== -1);
      }
      createSocket(req, options, cb) {
        const connectOpts = {
          ...options,
          secureEndpoint: this.isSecureEndpoint(options)
        };
        Promise.resolve().then(() => this.connect(req, connectOpts)).then((socket) => {
          if (socket instanceof http.Agent) {
            return socket.addRequest(req, connectOpts);
          }
          this[INTERNAL].currentSocket = socket;
          super.createSocket(req, options, cb);
        }, cb);
      }
      createConnection() {
        const socket = this[INTERNAL].currentSocket;
        this[INTERNAL].currentSocket = void 0;
        if (!socket) {
          throw new Error("No socket was returned in the `connect()` function");
        }
        return socket;
      }
      get defaultPort() {
        return _nullishCoalesce(this[INTERNAL].defaultPort, () => this.protocol === "https:" ? 443 : 80);
      }
      set defaultPort(v) {
        if (this[INTERNAL]) {
          this[INTERNAL].defaultPort = v;
        }
      }
      get protocol() {
        return _nullishCoalesce(this[INTERNAL].protocol, () => this.isSecureEndpoint() ? "https:" : "http:");
      }
      set protocol(v) {
        if (this[INTERNAL]) {
          this[INTERNAL].protocol = v;
        }
      }
    };
    exports.Agent = Agent;
  }
});

// ../../node_modules/.pnpm/@sentry+node@7.120.1/node_modules/@sentry/node/cjs/proxy/parse-proxy-response.js
var require_parse_proxy_response = __commonJS({
  "../../node_modules/.pnpm/@sentry+node@7.120.1/node_modules/@sentry/node/cjs/proxy/parse-proxy-response.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var utils = require_cjs();
    function debug(...args) {
      utils.logger.log("[https-proxy-agent:parse-proxy-response]", ...args);
    }
    function parseProxyResponse(socket) {
      return new Promise((resolve, reject) => {
        let buffersLength = 0;
        const buffers = [];
        function read() {
          const b = socket.read();
          if (b)
            ondata(b);
          else
            socket.once("readable", read);
        }
        function cleanup() {
          socket.removeListener("end", onend);
          socket.removeListener("error", onerror);
          socket.removeListener("readable", read);
        }
        function onend() {
          cleanup();
          debug("onend");
          reject(new Error("Proxy connection ended before receiving CONNECT response"));
        }
        function onerror(err) {
          cleanup();
          debug("onerror %o", err);
          reject(err);
        }
        function ondata(b) {
          buffers.push(b);
          buffersLength += b.length;
          const buffered = Buffer.concat(buffers, buffersLength);
          const endOfHeaders = buffered.indexOf("\r\n\r\n");
          if (endOfHeaders === -1) {
            debug("have not received end of HTTP headers yet...");
            read();
            return;
          }
          const headerParts = buffered.slice(0, endOfHeaders).toString("ascii").split("\r\n");
          const firstLine = headerParts.shift();
          if (!firstLine) {
            socket.destroy();
            return reject(new Error("No header received from proxy CONNECT response"));
          }
          const firstLineParts = firstLine.split(" ");
          const statusCode = +firstLineParts[1];
          const statusText = firstLineParts.slice(2).join(" ");
          const headers = {};
          for (const header of headerParts) {
            if (!header)
              continue;
            const firstColon = header.indexOf(":");
            if (firstColon === -1) {
              socket.destroy();
              return reject(new Error(`Invalid header from proxy CONNECT response: "${header}"`));
            }
            const key = header.slice(0, firstColon).toLowerCase();
            const value = header.slice(firstColon + 1).trimStart();
            const current = headers[key];
            if (typeof current === "string") {
              headers[key] = [current, value];
            } else if (Array.isArray(current)) {
              current.push(value);
            } else {
              headers[key] = value;
            }
          }
          debug("got proxy server response: %o %o", firstLine, headers);
          cleanup();
          resolve({
            connect: {
              statusCode,
              statusText,
              headers
            },
            buffered
          });
        }
        socket.on("error", onerror);
        socket.on("end", onend);
        read();
      });
    }
    exports.parseProxyResponse = parseProxyResponse;
  }
});

// ../../node_modules/.pnpm/@sentry+node@7.120.1/node_modules/@sentry/node/cjs/proxy/index.js
var require_proxy = __commonJS({
  "../../node_modules/.pnpm/@sentry+node@7.120.1/node_modules/@sentry/node/cjs/proxy/index.js"(exports) {
    var {
      _nullishCoalesce,
      _optionalChain
    } = require_cjs();
    Object.defineProperty(exports, "__esModule", { value: true });
    var net = __require("net");
    var tls = __require("tls");
    var url = __require("url");
    var utils = require_cjs();
    var base = require_base2();
    var parseProxyResponse = require_parse_proxy_response();
    function debug(...args) {
      utils.logger.log("[https-proxy-agent]", ...args);
    }
    var HttpsProxyAgent = class extends base.Agent {
      static __initStatic() {
        this.protocols = ["http", "https"];
      }
      constructor(proxy, opts) {
        super(opts);
        this.options = {};
        this.proxy = typeof proxy === "string" ? new url.URL(proxy) : proxy;
        this.proxyHeaders = _nullishCoalesce(_optionalChain([opts, "optionalAccess", (_2) => _2.headers]), () => ({}));
        debug("Creating new HttpsProxyAgent instance: %o", this.proxy.href);
        const host = (this.proxy.hostname || this.proxy.host).replace(/^\[|\]$/g, "");
        const port = this.proxy.port ? parseInt(this.proxy.port, 10) : this.proxy.protocol === "https:" ? 443 : 80;
        this.connectOpts = {
          // Attempt to negotiate http/1.1 for proxy servers that support http/2
          ALPNProtocols: ["http/1.1"],
          ...opts ? omit(opts, "headers") : null,
          host,
          port
        };
      }
      /**
       * Called when the node-core HTTP client library is creating a
       * new HTTP request.
       */
      async connect(req, opts) {
        const { proxy } = this;
        if (!opts.host) {
          throw new TypeError('No "host" provided');
        }
        let socket;
        if (proxy.protocol === "https:") {
          debug("Creating `tls.Socket`: %o", this.connectOpts);
          const servername = this.connectOpts.servername || this.connectOpts.host;
          socket = tls.connect({
            ...this.connectOpts,
            servername: servername && net.isIP(servername) ? void 0 : servername
          });
        } else {
          debug("Creating `net.Socket`: %o", this.connectOpts);
          socket = net.connect(this.connectOpts);
        }
        const headers = typeof this.proxyHeaders === "function" ? this.proxyHeaders() : { ...this.proxyHeaders };
        const host = net.isIPv6(opts.host) ? `[${opts.host}]` : opts.host;
        let payload = `CONNECT ${host}:${opts.port} HTTP/1.1\r
`;
        if (proxy.username || proxy.password) {
          const auth = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
          headers["Proxy-Authorization"] = `Basic ${Buffer.from(auth).toString("base64")}`;
        }
        headers.Host = `${host}:${opts.port}`;
        if (!headers["Proxy-Connection"]) {
          headers["Proxy-Connection"] = this.keepAlive ? "Keep-Alive" : "close";
        }
        for (const name of Object.keys(headers)) {
          payload += `${name}: ${headers[name]}\r
`;
        }
        const proxyResponsePromise = parseProxyResponse.parseProxyResponse(socket);
        socket.write(`${payload}\r
`);
        const { connect, buffered } = await proxyResponsePromise;
        req.emit("proxyConnect", connect);
        this.emit("proxyConnect", connect, req);
        if (connect.statusCode === 200) {
          req.once("socket", resume);
          if (opts.secureEndpoint) {
            debug("Upgrading socket connection to TLS");
            const servername = opts.servername || opts.host;
            return tls.connect({
              ...omit(opts, "host", "path", "port"),
              socket,
              servername: net.isIP(servername) ? void 0 : servername
            });
          }
          return socket;
        }
        socket.destroy();
        const fakeSocket = new net.Socket({ writable: false });
        fakeSocket.readable = true;
        req.once("socket", (s) => {
          debug("Replaying proxy buffer for failed request");
          s.push(buffered);
          s.push(null);
        });
        return fakeSocket;
      }
    };
    HttpsProxyAgent.__initStatic();
    function resume(socket) {
      socket.resume();
    }
    function omit(obj, ...keys) {
      const ret = {};
      let key;
      for (key in obj) {
        if (!keys.includes(key)) {
          ret[key] = obj[key];
        }
      }
      return ret;
    }
    exports.HttpsProxyAgent = HttpsProxyAgent;
  }
});

// ../../node_modules/.pnpm/@sentry+node@7.120.1/node_modules/@sentry/node/cjs/transports/http.js
var require_http = __commonJS({
  "../../node_modules/.pnpm/@sentry+node@7.120.1/node_modules/@sentry/node/cjs/transports/http.js"(exports) {
    var {
      _nullishCoalesce
    } = require_cjs();
    Object.defineProperty(exports, "__esModule", { value: true });
    var http = __require("http");
    var https = __require("https");
    var stream = __require("stream");
    var url = __require("url");
    var zlib = __require("zlib");
    var core = require_cjs2();
    var utils = require_cjs();
    var index = require_proxy();
    var GZIP_THRESHOLD = 1024 * 32;
    function streamFromBody(body) {
      return new stream.Readable({
        read() {
          this.push(body);
          this.push(null);
        }
      });
    }
    function makeNodeTransport(options) {
      let urlSegments;
      try {
        urlSegments = new url.URL(options.url);
      } catch (e) {
        utils.consoleSandbox(() => {
          console.warn(
            "[@sentry/node]: Invalid dsn or tunnel option, will not send any events. The tunnel option must be a full URL when used."
          );
        });
        return core.createTransport(options, () => Promise.resolve({}));
      }
      const isHttps = urlSegments.protocol === "https:";
      const proxy = applyNoProxyOption(
        urlSegments,
        options.proxy || (isHttps ? process.env.https_proxy : void 0) || process.env.http_proxy
      );
      const nativeHttpModule = isHttps ? https : http;
      const keepAlive = options.keepAlive === void 0 ? false : options.keepAlive;
      const agent = proxy ? new index.HttpsProxyAgent(proxy) : new nativeHttpModule.Agent({ keepAlive, maxSockets: 30, timeout: 2e3 });
      const requestExecutor = createRequestExecutor(options, _nullishCoalesce(options.httpModule, () => nativeHttpModule), agent);
      return core.createTransport(options, requestExecutor);
    }
    function applyNoProxyOption(transportUrlSegments, proxy) {
      const { no_proxy } = process.env;
      const urlIsExemptFromProxy = no_proxy && no_proxy.split(",").some(
        (exemption) => transportUrlSegments.host.endsWith(exemption) || transportUrlSegments.hostname.endsWith(exemption)
      );
      if (urlIsExemptFromProxy) {
        return void 0;
      } else {
        return proxy;
      }
    }
    function createRequestExecutor(options, httpModule, agent) {
      const { hostname, pathname, port, protocol, search } = new url.URL(options.url);
      return function makeRequest(request) {
        return new Promise((resolve, reject) => {
          let body = streamFromBody(request.body);
          const headers = { ...options.headers };
          if (request.body.length > GZIP_THRESHOLD) {
            headers["content-encoding"] = "gzip";
            body = body.pipe(zlib.createGzip());
          }
          const req = httpModule.request(
            {
              method: "POST",
              agent,
              headers,
              hostname,
              path: `${pathname}${search}`,
              port,
              protocol,
              ca: options.caCerts
            },
            (res) => {
              res.on("data", () => {
              });
              res.on("end", () => {
              });
              res.setEncoding("utf8");
              const retryAfterHeader = _nullishCoalesce(res.headers["retry-after"], () => null);
              const rateLimitsHeader = _nullishCoalesce(res.headers["x-sentry-rate-limits"], () => null);
              resolve({
                statusCode: res.statusCode,
                headers: {
                  "retry-after": retryAfterHeader,
                  "x-sentry-rate-limits": Array.isArray(rateLimitsHeader) ? rateLimitsHeader[0] : rateLimitsHeader
                }
              });
            }
          );
          req.on("error", reject);
          body.pipe(req);
        });
      };
    }
    exports.makeNodeTransport = makeNodeTransport;
  }
});

// ../../node_modules/.pnpm/@sentry+node@7.120.1/node_modules/@sentry/node/cjs/nodeVersion.js
var require_nodeVersion = __commonJS({
  "../../node_modules/.pnpm/@sentry+node@7.120.1/node_modules/@sentry/node/cjs/nodeVersion.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var utils = require_cjs();
    var NODE_VERSION = utils.parseSemver(process.versions.node);
    exports.NODE_VERSION = NODE_VERSION;
  }
});

// ../../node_modules/.pnpm/@sentry+node@7.120.1/node_modules/@sentry/node/cjs/async/domain.js
var require_domain = __commonJS({
  "../../node_modules/.pnpm/@sentry+node@7.120.1/node_modules/@sentry/node/cjs/async/domain.js"(exports) {
    var {
      _optionalChain
    } = require_cjs();
    Object.defineProperty(exports, "__esModule", { value: true });
    var domain = __require("domain");
    var core = require_cjs2();
    function getActiveDomain() {
      return domain.active;
    }
    function getCurrentHub() {
      const activeDomain = getActiveDomain();
      if (!activeDomain) {
        return void 0;
      }
      core.ensureHubOnCarrier(activeDomain);
      return core.getHubFromCarrier(activeDomain);
    }
    function createNewHub(parent) {
      const carrier = {};
      core.ensureHubOnCarrier(carrier, parent);
      return core.getHubFromCarrier(carrier);
    }
    function runWithAsyncContext(callback, options) {
      const activeDomain = getActiveDomain();
      if (activeDomain && _optionalChain([options, "optionalAccess", (_) => _.reuseExisting])) {
        return callback();
      }
      const local = domain.create();
      const parentHub = activeDomain ? core.getHubFromCarrier(activeDomain) : void 0;
      const newHub = createNewHub(parentHub);
      core.setHubOnCarrier(local, newHub);
      return local.bind(() => {
        return callback();
      })();
    }
    function setDomainAsyncContextStrategy() {
      core.setAsyncContextStrategy({ getCurrentHub, runWithAsyncContext });
    }
    exports.setDomainAsyncContextStrategy = setDomainAsyncContextStrategy;
  }
});

// ../../node_modules/.pnpm/@sentry+node@7.120.1/node_modules/@sentry/node/cjs/async/hooks.js
var require_hooks = __commonJS({
  "../../node_modules/.pnpm/@sentry+node@7.120.1/node_modules/@sentry/node/cjs/async/hooks.js"(exports) {
    var {
      _optionalChain
    } = require_cjs();
    Object.defineProperty(exports, "__esModule", { value: true });
    var core = require_cjs2();
    var async_hooks = __require("async_hooks");
    var asyncStorage;
    function setHooksAsyncContextStrategy() {
      if (!asyncStorage) {
        asyncStorage = new async_hooks.AsyncLocalStorage();
      }
      function getCurrentHub() {
        return asyncStorage.getStore();
      }
      function createNewHub(parent) {
        const carrier = {};
        core.ensureHubOnCarrier(carrier, parent);
        return core.getHubFromCarrier(carrier);
      }
      function runWithAsyncContext(callback, options) {
        const existingHub = getCurrentHub();
        if (existingHub && _optionalChain([options, "optionalAccess", (_) => _.reuseExisting])) {
          return callback();
        }
        const newHub = createNewHub(existingHub);
        return asyncStorage.run(newHub, () => {
          return callback();
        });
      }
      core.setAsyncContextStrategy({ getCurrentHub, runWithAsyncContext });
    }
    exports.setHooksAsyncContextStrategy = setHooksAsyncContextStrategy;
  }
});

// ../../node_modules/.pnpm/@sentry+node@7.120.1/node_modules/@sentry/node/cjs/async/index.js
var require_async = __commonJS({
  "../../node_modules/.pnpm/@sentry+node@7.120.1/node_modules/@sentry/node/cjs/async/index.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var nodeVersion = require_nodeVersion();
    var domain = require_domain();
    var hooks = require_hooks();
    function setNodeAsyncContextStrategy() {
      if (nodeVersion.NODE_VERSION.major >= 14) {
        hooks.setHooksAsyncContextStrategy();
      } else {
        domain.setDomainAsyncContextStrategy();
      }
    }
    exports.setNodeAsyncContextStrategy = setNodeAsyncContextStrategy;
  }
});

// ../../node_modules/.pnpm/@sentry+node@7.120.1/node_modules/@sentry/node/cjs/integrations/console.js
var require_console2 = __commonJS({
  "../../node_modules/.pnpm/@sentry+node@7.120.1/node_modules/@sentry/node/cjs/integrations/console.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var util = __require("util");
    var core = require_cjs2();
    var utils = require_cjs();
    var INTEGRATION_NAME = "Console";
    var _consoleIntegration = () => {
      return {
        name: INTEGRATION_NAME,
        // TODO v8: Remove this
        setupOnce() {
        },
        // eslint-disable-line @typescript-eslint/no-empty-function
        setup(client) {
          utils.addConsoleInstrumentationHandler(({ args, level }) => {
            if (core.getClient() !== client) {
              return;
            }
            core.addBreadcrumb(
              {
                category: "console",
                level: utils.severityLevelFromString(level),
                message: util.format.apply(void 0, args)
              },
              {
                input: [...args],
                level
              }
            );
          });
        }
      };
    };
    var consoleIntegration = core.defineIntegration(_consoleIntegration);
    var Console = core.convertIntegrationFnToClass(INTEGRATION_NAME, consoleIntegration);
    exports.Console = Console;
    exports.consoleIntegration = consoleIntegration;
  }
});

// ../../node_modules/.pnpm/@sentry+node@7.120.1/node_modules/@sentry/node/cjs/integrations/context.js
var require_context = __commonJS({
  "../../node_modules/.pnpm/@sentry+node@7.120.1/node_modules/@sentry/node/cjs/integrations/context.js"(exports) {
    var {
      _optionalChain
    } = require_cjs();
    Object.defineProperty(exports, "__esModule", { value: true });
    var child_process = __require("child_process");
    var fs = __require("fs");
    var os = __require("os");
    var path = __require("path");
    var util = __require("util");
    var core = require_cjs2();
    var readFileAsync = util.promisify(fs.readFile);
    var readDirAsync = util.promisify(fs.readdir);
    var INTEGRATION_NAME = "Context";
    var _nodeContextIntegration = (options = {}) => {
      let cachedContext;
      const _options = {
        app: true,
        os: true,
        device: true,
        culture: true,
        cloudResource: true,
        ...options
      };
      async function addContext(event) {
        if (cachedContext === void 0) {
          cachedContext = _getContexts();
        }
        const updatedContext = _updateContext(await cachedContext);
        event.contexts = {
          ...event.contexts,
          app: { ...updatedContext.app, ..._optionalChain([event, "access", (_) => _.contexts, "optionalAccess", (_2) => _2.app]) },
          os: { ...updatedContext.os, ..._optionalChain([event, "access", (_3) => _3.contexts, "optionalAccess", (_4) => _4.os]) },
          device: { ...updatedContext.device, ..._optionalChain([event, "access", (_5) => _5.contexts, "optionalAccess", (_6) => _6.device]) },
          culture: { ...updatedContext.culture, ..._optionalChain([event, "access", (_7) => _7.contexts, "optionalAccess", (_8) => _8.culture]) },
          cloud_resource: { ...updatedContext.cloud_resource, ..._optionalChain([event, "access", (_9) => _9.contexts, "optionalAccess", (_10) => _10.cloud_resource]) }
        };
        return event;
      }
      async function _getContexts() {
        const contexts = {};
        if (_options.os) {
          contexts.os = await getOsContext();
        }
        if (_options.app) {
          contexts.app = getAppContext();
        }
        if (_options.device) {
          contexts.device = getDeviceContext(_options.device);
        }
        if (_options.culture) {
          const culture = getCultureContext();
          if (culture) {
            contexts.culture = culture;
          }
        }
        if (_options.cloudResource) {
          contexts.cloud_resource = getCloudResourceContext();
        }
        return contexts;
      }
      return {
        name: INTEGRATION_NAME,
        // TODO v8: Remove this
        setupOnce() {
        },
        // eslint-disable-line @typescript-eslint/no-empty-function
        processEvent(event) {
          return addContext(event);
        }
      };
    };
    var nodeContextIntegration = core.defineIntegration(_nodeContextIntegration);
    var Context = core.convertIntegrationFnToClass(INTEGRATION_NAME, nodeContextIntegration);
    function _updateContext(contexts) {
      if (_optionalChain([contexts, "optionalAccess", (_11) => _11.app, "optionalAccess", (_12) => _12.app_memory])) {
        contexts.app.app_memory = process.memoryUsage().rss;
      }
      if (_optionalChain([contexts, "optionalAccess", (_13) => _13.device, "optionalAccess", (_14) => _14.free_memory])) {
        contexts.device.free_memory = os.freemem();
      }
      return contexts;
    }
    async function getOsContext() {
      const platformId = os.platform();
      switch (platformId) {
        case "darwin":
          return getDarwinInfo();
        case "linux":
          return getLinuxInfo();
        default:
          return {
            name: PLATFORM_NAMES[platformId] || platformId,
            version: os.release()
          };
      }
    }
    function getCultureContext() {
      try {
        if (typeof process.versions.icu !== "string") {
          return;
        }
        const january = /* @__PURE__ */ new Date(9e8);
        const spanish = new Intl.DateTimeFormat("es", { month: "long" });
        if (spanish.format(january) === "enero") {
          const options = Intl.DateTimeFormat().resolvedOptions();
          return {
            locale: options.locale,
            timezone: options.timeZone
          };
        }
      } catch (err) {
      }
      return;
    }
    function getAppContext() {
      const app_memory = process.memoryUsage().rss;
      const app_start_time = new Date(Date.now() - process.uptime() * 1e3).toISOString();
      return { app_start_time, app_memory };
    }
    function getDeviceContext(deviceOpt) {
      const device = {};
      let uptime;
      try {
        uptime = os.uptime && os.uptime();
      } catch (e) {
      }
      if (typeof uptime === "number") {
        device.boot_time = new Date(Date.now() - uptime * 1e3).toISOString();
      }
      device.arch = os.arch();
      if (deviceOpt === true || deviceOpt.memory) {
        device.memory_size = os.totalmem();
        device.free_memory = os.freemem();
      }
      if (deviceOpt === true || deviceOpt.cpu) {
        const cpuInfo = os.cpus();
        if (cpuInfo && cpuInfo.length) {
          const firstCpu = cpuInfo[0];
          device.processor_count = cpuInfo.length;
          device.cpu_description = firstCpu.model;
          device.processor_frequency = firstCpu.speed;
        }
      }
      return device;
    }
    var PLATFORM_NAMES = {
      aix: "IBM AIX",
      freebsd: "FreeBSD",
      openbsd: "OpenBSD",
      sunos: "SunOS",
      win32: "Windows"
    };
    var LINUX_DISTROS = [
      { name: "fedora-release", distros: ["Fedora"] },
      { name: "redhat-release", distros: ["Red Hat Linux", "Centos"] },
      { name: "redhat_version", distros: ["Red Hat Linux"] },
      { name: "SuSE-release", distros: ["SUSE Linux"] },
      { name: "lsb-release", distros: ["Ubuntu Linux", "Arch Linux"] },
      { name: "debian_version", distros: ["Debian"] },
      { name: "debian_release", distros: ["Debian"] },
      { name: "arch-release", distros: ["Arch Linux"] },
      { name: "gentoo-release", distros: ["Gentoo Linux"] },
      { name: "novell-release", distros: ["SUSE Linux"] },
      { name: "alpine-release", distros: ["Alpine Linux"] }
    ];
    var LINUX_VERSIONS = {
      alpine: (content) => content,
      arch: (content) => matchFirst(/distrib_release=(.*)/, content),
      centos: (content) => matchFirst(/release ([^ ]+)/, content),
      debian: (content) => content,
      fedora: (content) => matchFirst(/release (..)/, content),
      mint: (content) => matchFirst(/distrib_release=(.*)/, content),
      red: (content) => matchFirst(/release ([^ ]+)/, content),
      suse: (content) => matchFirst(/VERSION = (.*)\n/, content),
      ubuntu: (content) => matchFirst(/distrib_release=(.*)/, content)
    };
    function matchFirst(regex, text) {
      const match = regex.exec(text);
      return match ? match[1] : void 0;
    }
    async function getDarwinInfo() {
      const darwinInfo = {
        kernel_version: os.release(),
        name: "Mac OS X",
        version: `10.${Number(os.release().split(".")[0]) - 4}`
      };
      try {
        const output = await new Promise((resolve, reject) => {
          child_process.execFile("/usr/bin/sw_vers", (error, stdout) => {
            if (error) {
              reject(error);
              return;
            }
            resolve(stdout);
          });
        });
        darwinInfo.name = matchFirst(/^ProductName:\s+(.*)$/m, output);
        darwinInfo.version = matchFirst(/^ProductVersion:\s+(.*)$/m, output);
        darwinInfo.build = matchFirst(/^BuildVersion:\s+(.*)$/m, output);
      } catch (e) {
      }
      return darwinInfo;
    }
    function getLinuxDistroId(name) {
      return name.split(" ")[0].toLowerCase();
    }
    async function getLinuxInfo() {
      const linuxInfo = {
        kernel_version: os.release(),
        name: "Linux"
      };
      try {
        const etcFiles = await readDirAsync("/etc");
        const distroFile = LINUX_DISTROS.find((file) => etcFiles.includes(file.name));
        if (!distroFile) {
          return linuxInfo;
        }
        const distroPath = path.join("/etc", distroFile.name);
        const contents = (await readFileAsync(distroPath, { encoding: "utf-8" })).toLowerCase();
        const { distros } = distroFile;
        linuxInfo.name = distros.find((d) => contents.indexOf(getLinuxDistroId(d)) >= 0) || distros[0];
        const id = getLinuxDistroId(linuxInfo.name);
        linuxInfo.version = LINUX_VERSIONS[id](contents);
      } catch (e) {
      }
      return linuxInfo;
    }
    function getCloudResourceContext() {
      if (process.env.VERCEL) {
        return {
          "cloud.provider": "vercel",
          "cloud.region": process.env.VERCEL_REGION
        };
      } else if (process.env.AWS_REGION) {
        return {
          "cloud.provider": "aws",
          "cloud.region": process.env.AWS_REGION,
          "cloud.platform": process.env.AWS_EXECUTION_ENV
        };
      } else if (process.env.GCP_PROJECT) {
        return {
          "cloud.provider": "gcp"
        };
      } else if (process.env.ALIYUN_REGION_ID) {
        return {
          "cloud.provider": "alibaba_cloud",
          "cloud.region": process.env.ALIYUN_REGION_ID
        };
      } else if (process.env.WEBSITE_SITE_NAME && process.env.REGION_NAME) {
        return {
          "cloud.provider": "azure",
          "cloud.region": process.env.REGION_NAME
        };
      } else if (process.env.IBM_CLOUD_REGION) {
        return {
          "cloud.provider": "ibm_cloud",
          "cloud.region": process.env.IBM_CLOUD_REGION
        };
      } else if (process.env.TENCENTCLOUD_REGION) {
        return {
          "cloud.provider": "tencent_cloud",
          "cloud.region": process.env.TENCENTCLOUD_REGION,
          "cloud.account.id": process.env.TENCENTCLOUD_APPID,
          "cloud.availability_zone": process.env.TENCENTCLOUD_ZONE
        };
      } else if (process.env.NETLIFY) {
        return {
          "cloud.provider": "netlify"
        };
      } else if (process.env.FLY_REGION) {
        return {
          "cloud.provider": "fly.io",
          "cloud.region": process.env.FLY_REGION
        };
      } else if (process.env.DYNO) {
        return {
          "cloud.provider": "heroku"
        };
      } else {
        return void 0;
      }
    }
    exports.Context = Context;
    exports.getDeviceContext = getDeviceContext;
    exports.nodeContextIntegration = nodeContextIntegration;
    exports.readDirAsync = readDirAsync;
    exports.readFileAsync = readFileAsync;
  }
});

// ../../node_modules/.pnpm/@sentry+node@7.120.1/node_modules/@sentry/node/cjs/integrations/contextlines.js
var require_contextlines = __commonJS({
  "../../node_modules/.pnpm/@sentry+node@7.120.1/node_modules/@sentry/node/cjs/integrations/contextlines.js"(exports) {
    var {
      _optionalChain
    } = require_cjs();
    Object.defineProperty(exports, "__esModule", { value: true });
    var fs = __require("fs");
    var core = require_cjs2();
    var utils = require_cjs();
    var FILE_CONTENT_CACHE = new utils.LRUMap(100);
    var DEFAULT_LINES_OF_CONTEXT = 7;
    var INTEGRATION_NAME = "ContextLines";
    function readTextFileAsync(path) {
      return new Promise((resolve, reject) => {
        fs.readFile(path, "utf8", (err, data) => {
          if (err)
            reject(err);
          else
            resolve(data);
        });
      });
    }
    var _contextLinesIntegration = (options = {}) => {
      const contextLines = options.frameContextLines !== void 0 ? options.frameContextLines : DEFAULT_LINES_OF_CONTEXT;
      return {
        name: INTEGRATION_NAME,
        // TODO v8: Remove this
        setupOnce() {
        },
        // eslint-disable-line @typescript-eslint/no-empty-function
        processEvent(event) {
          return addSourceContext(event, contextLines);
        }
      };
    };
    var contextLinesIntegration = core.defineIntegration(_contextLinesIntegration);
    var ContextLines = core.convertIntegrationFnToClass(INTEGRATION_NAME, contextLinesIntegration);
    async function addSourceContext(event, contextLines) {
      const enqueuedReadSourceFileTasks = {};
      const readSourceFileTasks = [];
      if (contextLines > 0 && _optionalChain([event, "access", (_2) => _2.exception, "optionalAccess", (_3) => _3.values])) {
        for (const exception of event.exception.values) {
          if (!_optionalChain([exception, "access", (_4) => _4.stacktrace, "optionalAccess", (_5) => _5.frames])) {
            continue;
          }
          for (let i = exception.stacktrace.frames.length - 1; i >= 0; i--) {
            const frame = exception.stacktrace.frames[i];
            if (frame.filename && !enqueuedReadSourceFileTasks[frame.filename] && !FILE_CONTENT_CACHE.get(frame.filename)) {
              readSourceFileTasks.push(_readSourceFile(frame.filename));
              enqueuedReadSourceFileTasks[frame.filename] = 1;
            }
          }
        }
      }
      if (readSourceFileTasks.length > 0) {
        await Promise.all(readSourceFileTasks);
      }
      if (contextLines > 0 && _optionalChain([event, "access", (_6) => _6.exception, "optionalAccess", (_7) => _7.values])) {
        for (const exception of event.exception.values) {
          if (exception.stacktrace && exception.stacktrace.frames) {
            await addSourceContextToFrames(exception.stacktrace.frames, contextLines);
          }
        }
      }
      return event;
    }
    function addSourceContextToFrames(frames, contextLines) {
      for (const frame of frames) {
        if (frame.filename && frame.context_line === void 0) {
          const sourceFileLines = FILE_CONTENT_CACHE.get(frame.filename);
          if (sourceFileLines) {
            try {
              utils.addContextToFrame(sourceFileLines, frame, contextLines);
            } catch (e) {
            }
          }
        }
      }
    }
    async function _readSourceFile(filename) {
      const cachedFile = FILE_CONTENT_CACHE.get(filename);
      if (cachedFile === null) {
        return null;
      }
      if (cachedFile !== void 0) {
        return cachedFile;
      }
      let content = null;
      try {
        const rawFileContents = await readTextFileAsync(filename);
        content = rawFileContents.split("\n");
      } catch (_) {
      }
      FILE_CONTENT_CACHE.set(filename, content);
      return content;
    }
    exports.ContextLines = ContextLines;
    exports.contextLinesIntegration = contextLinesIntegration;
  }
});

// ../../node_modules/.pnpm/@sentry+node@7.120.1/node_modules/@sentry/node/cjs/debug-build.js
var require_debug_build4 = __commonJS({
  "../../node_modules/.pnpm/@sentry+node@7.120.1/node_modules/@sentry/node/cjs/debug-build.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var DEBUG_BUILD = typeof __SENTRY_DEBUG__ === "undefined" || __SENTRY_DEBUG__;
    exports.DEBUG_BUILD = DEBUG_BUILD;
  }
});

// ../../node_modules/.pnpm/@sentry+node@7.120.1/node_modules/@sentry/node/cjs/integrations/utils/http.js
var require_http2 = __commonJS({
  "../../node_modules/.pnpm/@sentry+node@7.120.1/node_modules/@sentry/node/cjs/integrations/utils/http.js"(exports) {
    var {
      _optionalChain
    } = require_cjs();
    Object.defineProperty(exports, "__esModule", { value: true });
    var url = __require("url");
    var nodeVersion = require_nodeVersion();
    function extractRawUrl(requestOptions) {
      const { protocol, hostname, port } = parseRequestOptions(requestOptions);
      const path = requestOptions.path ? requestOptions.path : "/";
      return `${protocol}//${hostname}${port}${path}`;
    }
    function extractUrl(requestOptions) {
      const { protocol, hostname, port } = parseRequestOptions(requestOptions);
      const path = requestOptions.pathname || "/";
      const authority = requestOptions.auth ? redactAuthority(requestOptions.auth) : "";
      return `${protocol}//${authority}${hostname}${port}${path}`;
    }
    function redactAuthority(auth) {
      const [user, password] = auth.split(":");
      return `${user ? "[Filtered]" : ""}:${password ? "[Filtered]" : ""}@`;
    }
    function cleanSpanDescription(description, requestOptions, request) {
      if (!description) {
        return description;
      }
      let [method, requestUrl] = description.split(" ");
      if (requestOptions.host && !requestOptions.protocol) {
        requestOptions.protocol = _optionalChain([request, "optionalAccess", (_) => _.agent, "optionalAccess", (_2) => _2.protocol]);
        requestUrl = extractUrl(requestOptions);
      }
      if (_optionalChain([requestUrl, "optionalAccess", (_3) => _3.startsWith, "call", (_4) => _4("///")])) {
        requestUrl = requestUrl.slice(2);
      }
      return `${method} ${requestUrl}`;
    }
    function urlToOptions(url2) {
      const options = {
        protocol: url2.protocol,
        hostname: typeof url2.hostname === "string" && url2.hostname.startsWith("[") ? url2.hostname.slice(1, -1) : url2.hostname,
        hash: url2.hash,
        search: url2.search,
        pathname: url2.pathname,
        path: `${url2.pathname || ""}${url2.search || ""}`,
        href: url2.href
      };
      if (url2.port !== "") {
        options.port = Number(url2.port);
      }
      if (url2.username || url2.password) {
        options.auth = `${url2.username}:${url2.password}`;
      }
      return options;
    }
    function normalizeRequestArgs(httpModule, requestArgs) {
      let callback, requestOptions;
      if (typeof requestArgs[requestArgs.length - 1] === "function") {
        callback = requestArgs.pop();
      }
      if (typeof requestArgs[0] === "string") {
        requestOptions = urlToOptions(new url.URL(requestArgs[0]));
      } else if (requestArgs[0] instanceof url.URL) {
        requestOptions = urlToOptions(requestArgs[0]);
      } else {
        requestOptions = requestArgs[0];
        try {
          const parsed = new url.URL(
            requestOptions.path || "",
            `${requestOptions.protocol || "http:"}//${requestOptions.hostname}`
          );
          requestOptions = {
            pathname: parsed.pathname,
            search: parsed.search,
            hash: parsed.hash,
            ...requestOptions
          };
        } catch (e) {
        }
      }
      if (requestArgs.length === 2) {
        requestOptions = { ...requestOptions, ...requestArgs[1] };
      }
      if (requestOptions.protocol === void 0) {
        if (nodeVersion.NODE_VERSION.major > 8) {
          requestOptions.protocol = _optionalChain([_optionalChain([httpModule, "optionalAccess", (_5) => _5.globalAgent]), "optionalAccess", (_6) => _6.protocol]) || _optionalChain([requestOptions.agent, "optionalAccess", (_7) => _7.protocol]) || _optionalChain([requestOptions._defaultAgent, "optionalAccess", (_8) => _8.protocol]);
        } else {
          requestOptions.protocol = _optionalChain([requestOptions.agent, "optionalAccess", (_9) => _9.protocol]) || _optionalChain([requestOptions._defaultAgent, "optionalAccess", (_10) => _10.protocol]) || _optionalChain([_optionalChain([httpModule, "optionalAccess", (_11) => _11.globalAgent]), "optionalAccess", (_12) => _12.protocol]);
        }
      }
      if (callback) {
        return [requestOptions, callback];
      } else {
        return [requestOptions];
      }
    }
    function parseRequestOptions(requestOptions) {
      const protocol = requestOptions.protocol || "";
      const hostname = requestOptions.hostname || requestOptions.host || "";
      const port = !requestOptions.port || requestOptions.port === 80 || requestOptions.port === 443 || /^(.*):(\d+)$/.test(hostname) ? "" : `:${requestOptions.port}`;
      return { protocol, hostname, port };
    }
    exports.cleanSpanDescription = cleanSpanDescription;
    exports.extractRawUrl = extractRawUrl;
    exports.extractUrl = extractUrl;
    exports.normalizeRequestArgs = normalizeRequestArgs;
    exports.urlToOptions = urlToOptions;
  }
});

// ../../node_modules/.pnpm/@sentry+node@7.120.1/node_modules/@sentry/node/cjs/integrations/http.js
var require_http3 = __commonJS({
  "../../node_modules/.pnpm/@sentry+node@7.120.1/node_modules/@sentry/node/cjs/integrations/http.js"(exports) {
    var {
      _optionalChain
    } = require_cjs();
    Object.defineProperty(exports, "__esModule", { value: true });
    var core = require_cjs2();
    var utils = require_cjs();
    var debugBuild = require_debug_build4();
    var nodeVersion = require_nodeVersion();
    var http = require_http2();
    var _httpIntegration = (options = {}) => {
      const { breadcrumbs, tracing, shouldCreateSpanForRequest } = options;
      const convertedOptions = {
        breadcrumbs,
        tracing: tracing === false ? false : utils.dropUndefinedKeys({
          // If tracing is forced to `true`, we don't want to set `enableIfHasTracingEnabled`
          enableIfHasTracingEnabled: tracing === true ? void 0 : true,
          shouldCreateSpanForRequest
        })
      };
      return new Http(convertedOptions);
    };
    var httpIntegration = core.defineIntegration(_httpIntegration);
    var Http = class _Http {
      /**
       * @inheritDoc
       */
      static __initStatic() {
        this.id = "Http";
      }
      /**
       * @inheritDoc
       */
      // eslint-disable-next-line deprecation/deprecation
      __init() {
        this.name = _Http.id;
      }
      /**
       * @inheritDoc
       */
      constructor(options = {}) {
        _Http.prototype.__init.call(this);
        this._breadcrumbs = typeof options.breadcrumbs === "undefined" ? true : options.breadcrumbs;
        this._tracing = !options.tracing ? void 0 : options.tracing === true ? {} : options.tracing;
      }
      /**
       * @inheritDoc
       */
      setupOnce(_addGlobalEventProcessor, setupOnceGetCurrentHub) {
        const clientOptions = _optionalChain([setupOnceGetCurrentHub, "call", (_) => _(), "access", (_2) => _2.getClient, "call", (_3) => _3(), "optionalAccess", (_4) => _4.getOptions, "call", (_5) => _5()]);
        const shouldCreateSpans = _shouldCreateSpans(this._tracing, clientOptions);
        if (!this._breadcrumbs && !shouldCreateSpans) {
          return;
        }
        if (clientOptions && clientOptions.instrumenter !== "sentry") {
          debugBuild.DEBUG_BUILD && utils.logger.log("HTTP Integration is skipped because of instrumenter configuration.");
          return;
        }
        const shouldCreateSpanForRequest = _getShouldCreateSpanForRequest(shouldCreateSpans, this._tracing, clientOptions);
        const tracePropagationTargets = _optionalChain([clientOptions, "optionalAccess", (_6) => _6.tracePropagationTargets]) || _optionalChain([this, "access", (_7) => _7._tracing, "optionalAccess", (_8) => _8.tracePropagationTargets]);
        const httpModule = __require("http");
        const wrappedHttpHandlerMaker = _createWrappedRequestMethodFactory(
          httpModule,
          this._breadcrumbs,
          shouldCreateSpanForRequest,
          tracePropagationTargets
        );
        utils.fill(httpModule, "get", wrappedHttpHandlerMaker);
        utils.fill(httpModule, "request", wrappedHttpHandlerMaker);
        if (nodeVersion.NODE_VERSION.major > 8) {
          const httpsModule = __require("https");
          const wrappedHttpsHandlerMaker = _createWrappedRequestMethodFactory(
            httpsModule,
            this._breadcrumbs,
            shouldCreateSpanForRequest,
            tracePropagationTargets
          );
          utils.fill(httpsModule, "get", wrappedHttpsHandlerMaker);
          utils.fill(httpsModule, "request", wrappedHttpsHandlerMaker);
        }
      }
    };
    Http.__initStatic();
    function _createWrappedRequestMethodFactory(httpModule, breadcrumbsEnabled, shouldCreateSpanForRequest, tracePropagationTargets) {
      const createSpanUrlMap = new utils.LRUMap(100);
      const headersUrlMap = new utils.LRUMap(100);
      const shouldCreateSpan = (url) => {
        if (shouldCreateSpanForRequest === void 0) {
          return true;
        }
        const cachedDecision = createSpanUrlMap.get(url);
        if (cachedDecision !== void 0) {
          return cachedDecision;
        }
        const decision = shouldCreateSpanForRequest(url);
        createSpanUrlMap.set(url, decision);
        return decision;
      };
      const shouldAttachTraceData = (url) => {
        if (tracePropagationTargets === void 0) {
          return true;
        }
        const cachedDecision = headersUrlMap.get(url);
        if (cachedDecision !== void 0) {
          return cachedDecision;
        }
        const decision = utils.stringMatchesSomePattern(url, tracePropagationTargets);
        headersUrlMap.set(url, decision);
        return decision;
      };
      function addRequestBreadcrumb(event, requestSpanData, req, res) {
        if (!core.getCurrentHub().getIntegration(Http)) {
          return;
        }
        core.addBreadcrumb(
          {
            category: "http",
            data: {
              status_code: res && res.statusCode,
              ...requestSpanData
            },
            type: "http"
          },
          {
            event,
            request: req,
            response: res
          }
        );
      }
      return function wrappedRequestMethodFactory(originalRequestMethod) {
        return function wrappedMethod(...args) {
          const requestArgs = http.normalizeRequestArgs(httpModule, args);
          const requestOptions = requestArgs[0];
          const rawRequestUrl = http.extractRawUrl(requestOptions);
          const requestUrl = http.extractUrl(requestOptions);
          const client = core.getClient();
          if (core.isSentryRequestUrl(requestUrl, client)) {
            return originalRequestMethod.apply(httpModule, requestArgs);
          }
          const scope = core.getCurrentScope();
          const isolationScope = core.getIsolationScope();
          const parentSpan = core.getActiveSpan();
          const data = getRequestSpanData(requestUrl, requestOptions);
          const requestSpan = shouldCreateSpan(rawRequestUrl) ? (
            // eslint-disable-next-line deprecation/deprecation
            _optionalChain([parentSpan, "optionalAccess", (_9) => _9.startChild, "call", (_10) => _10({
              op: "http.client",
              origin: "auto.http.node.http",
              description: `${data["http.method"]} ${data.url}`,
              data
            })])
          ) : void 0;
          if (client && shouldAttachTraceData(rawRequestUrl)) {
            const { traceId, spanId, sampled, dsc } = {
              ...isolationScope.getPropagationContext(),
              ...scope.getPropagationContext()
            };
            const sentryTraceHeader = requestSpan ? core.spanToTraceHeader(requestSpan) : utils.generateSentryTraceHeader(traceId, spanId, sampled);
            const sentryBaggageHeader = utils.dynamicSamplingContextToSentryBaggageHeader(
              dsc || (requestSpan ? core.getDynamicSamplingContextFromSpan(requestSpan) : core.getDynamicSamplingContextFromClient(traceId, client, scope))
            );
            addHeadersToRequestOptions(requestOptions, requestUrl, sentryTraceHeader, sentryBaggageHeader);
          } else {
            debugBuild.DEBUG_BUILD && utils.logger.log(
              `[Tracing] Not adding sentry-trace header to outgoing request (${requestUrl}) due to mismatching tracePropagationTargets option.`
            );
          }
          return originalRequestMethod.apply(httpModule, requestArgs).once("response", function(res) {
            const req = this;
            if (breadcrumbsEnabled) {
              addRequestBreadcrumb("response", data, req, res);
            }
            if (requestSpan) {
              if (res.statusCode) {
                core.setHttpStatus(requestSpan, res.statusCode);
              }
              requestSpan.updateName(
                http.cleanSpanDescription(core.spanToJSON(requestSpan).description || "", requestOptions, req) || ""
              );
              requestSpan.end();
            }
          }).once("error", function() {
            const req = this;
            if (breadcrumbsEnabled) {
              addRequestBreadcrumb("error", data, req);
            }
            if (requestSpan) {
              core.setHttpStatus(requestSpan, 500);
              requestSpan.updateName(
                http.cleanSpanDescription(core.spanToJSON(requestSpan).description || "", requestOptions, req) || ""
              );
              requestSpan.end();
            }
          });
        };
      };
    }
    function addHeadersToRequestOptions(requestOptions, requestUrl, sentryTraceHeader, sentryBaggageHeader) {
      const headers = requestOptions.headers || {};
      if (headers["sentry-trace"]) {
        return;
      }
      debugBuild.DEBUG_BUILD && utils.logger.log(`[Tracing] Adding sentry-trace header ${sentryTraceHeader} to outgoing request to "${requestUrl}": `);
      requestOptions.headers = {
        ...requestOptions.headers,
        "sentry-trace": sentryTraceHeader,
        // Setting a header to `undefined` will crash in node so we only set the baggage header when it's defined
        ...sentryBaggageHeader && sentryBaggageHeader.length > 0 && { baggage: normalizeBaggageHeader(requestOptions, sentryBaggageHeader) }
      };
    }
    function getRequestSpanData(requestUrl, requestOptions) {
      const method = requestOptions.method || "GET";
      const data = {
        url: requestUrl,
        "http.method": method
      };
      if (requestOptions.hash) {
        data["http.fragment"] = requestOptions.hash.substring(1);
      }
      if (requestOptions.search) {
        data["http.query"] = requestOptions.search.substring(1);
      }
      return data;
    }
    function normalizeBaggageHeader(requestOptions, sentryBaggageHeader) {
      if (!requestOptions.headers || !requestOptions.headers.baggage) {
        return sentryBaggageHeader;
      } else if (!sentryBaggageHeader) {
        return requestOptions.headers.baggage;
      } else if (Array.isArray(requestOptions.headers.baggage)) {
        return [...requestOptions.headers.baggage, sentryBaggageHeader];
      }
      return [requestOptions.headers.baggage, sentryBaggageHeader];
    }
    function _shouldCreateSpans(tracingOptions, clientOptions) {
      return tracingOptions === void 0 ? false : tracingOptions.enableIfHasTracingEnabled ? core.hasTracingEnabled(clientOptions) : true;
    }
    function _getShouldCreateSpanForRequest(shouldCreateSpans, tracingOptions, clientOptions) {
      const handler = shouldCreateSpans ? (
        // eslint-disable-next-line deprecation/deprecation
        _optionalChain([tracingOptions, "optionalAccess", (_11) => _11.shouldCreateSpanForRequest]) || _optionalChain([clientOptions, "optionalAccess", (_12) => _12.shouldCreateSpanForRequest])
      ) : () => false;
      return handler;
    }
    exports.Http = Http;
    exports._getShouldCreateSpanForRequest = _getShouldCreateSpanForRequest;
    exports._shouldCreateSpans = _shouldCreateSpans;
    exports.httpIntegration = httpIntegration;
  }
});

// ../../node_modules/.pnpm/@sentry+node@7.120.1/node_modules/@sentry/node/cjs/integrations/local-variables/common.js
var require_common = __commonJS({
  "../../node_modules/.pnpm/@sentry+node@7.120.1/node_modules/@sentry/node/cjs/integrations/local-variables/common.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    function createRateLimiter(maxPerSecond, enable, disable) {
      let count = 0;
      let retrySeconds = 5;
      let disabledTimeout = 0;
      setInterval(() => {
        if (disabledTimeout === 0) {
          if (count > maxPerSecond) {
            retrySeconds *= 2;
            disable(retrySeconds);
            if (retrySeconds > 86400) {
              retrySeconds = 86400;
            }
            disabledTimeout = retrySeconds;
          }
        } else {
          disabledTimeout -= 1;
          if (disabledTimeout === 0) {
            enable();
          }
        }
        count = 0;
      }, 1e3).unref();
      return () => {
        count += 1;
      };
    }
    function isAnonymous(name) {
      return name !== void 0 && (name.length === 0 || name === "?" || name === "<anonymous>");
    }
    function functionNamesMatch(a, b) {
      return a === b || isAnonymous(a) && isAnonymous(b);
    }
    function hashFrames(frames) {
      if (frames === void 0) {
        return;
      }
      return frames.slice(-10).reduce((acc, frame) => `${acc},${frame.function},${frame.lineno},${frame.colno}`, "");
    }
    function hashFromStack(stackParser, stack) {
      if (stack === void 0) {
        return void 0;
      }
      return hashFrames(stackParser(stack, 1));
    }
    exports.createRateLimiter = createRateLimiter;
    exports.functionNamesMatch = functionNamesMatch;
    exports.hashFrames = hashFrames;
    exports.hashFromStack = hashFromStack;
    exports.isAnonymous = isAnonymous;
  }
});

// ../../node_modules/.pnpm/@sentry+node@7.120.1/node_modules/@sentry/node/cjs/integrations/local-variables/local-variables-sync.js
var require_local_variables_sync = __commonJS({
  "../../node_modules/.pnpm/@sentry+node@7.120.1/node_modules/@sentry/node/cjs/integrations/local-variables/local-variables-sync.js"(exports) {
    var {
      _optionalChain
    } = require_cjs();
    Object.defineProperty(exports, "__esModule", { value: true });
    var core = require_cjs2();
    var utils = require_cjs();
    var nodeVersion = require_nodeVersion();
    var common = require_common();
    function createCallbackList(complete) {
      let callbacks = [];
      let completedCalled = false;
      function checkedComplete(result) {
        callbacks = [];
        if (completedCalled) {
          return;
        }
        completedCalled = true;
        complete(result);
      }
      callbacks.push(checkedComplete);
      function add(fn) {
        callbacks.push(fn);
      }
      function next(result) {
        const popped = callbacks.pop() || checkedComplete;
        try {
          popped(result);
        } catch (_) {
          checkedComplete(result);
        }
      }
      return { add, next };
    }
    var AsyncSession = class {
      /** Throws if inspector API is not available */
      constructor() {
        const { Session } = __require("inspector");
        this._session = new Session();
      }
      /** @inheritdoc */
      configureAndConnect(onPause, captureAll) {
        this._session.connect();
        this._session.on("Debugger.paused", (event) => {
          onPause(event, () => {
            this._session.post("Debugger.resume");
          });
        });
        this._session.post("Debugger.enable");
        this._session.post("Debugger.setPauseOnExceptions", { state: captureAll ? "all" : "uncaught" });
      }
      setPauseOnExceptions(captureAll) {
        this._session.post("Debugger.setPauseOnExceptions", { state: captureAll ? "all" : "uncaught" });
      }
      /** @inheritdoc */
      getLocalVariables(objectId, complete) {
        this._getProperties(objectId, (props) => {
          const { add, next } = createCallbackList(complete);
          for (const prop of props) {
            if (_optionalChain([prop, "optionalAccess", (_2) => _2.value, "optionalAccess", (_3) => _3.objectId]) && _optionalChain([prop, "optionalAccess", (_4) => _4.value, "access", (_5) => _5.className]) === "Array") {
              const id = prop.value.objectId;
              add((vars) => this._unrollArray(id, prop.name, vars, next));
            } else if (_optionalChain([prop, "optionalAccess", (_6) => _6.value, "optionalAccess", (_7) => _7.objectId]) && _optionalChain([prop, "optionalAccess", (_8) => _8.value, "optionalAccess", (_9) => _9.className]) === "Object") {
              const id = prop.value.objectId;
              add((vars) => this._unrollObject(id, prop.name, vars, next));
            } else if (_optionalChain([prop, "optionalAccess", (_10) => _10.value, "optionalAccess", (_11) => _11.value]) != null || _optionalChain([prop, "optionalAccess", (_12) => _12.value, "optionalAccess", (_13) => _13.description]) != null) {
              add((vars) => this._unrollOther(prop, vars, next));
            }
          }
          next({});
        });
      }
      /**
       * Gets all the PropertyDescriptors of an object
       */
      _getProperties(objectId, next) {
        this._session.post(
          "Runtime.getProperties",
          {
            objectId,
            ownProperties: true
          },
          (err, params) => {
            if (err) {
              next([]);
            } else {
              next(params.result);
            }
          }
        );
      }
      /**
       * Unrolls an array property
       */
      _unrollArray(objectId, name, vars, next) {
        this._getProperties(objectId, (props) => {
          vars[name] = props.filter((v) => v.name !== "length" && !isNaN(parseInt(v.name, 10))).sort((a, b) => parseInt(a.name, 10) - parseInt(b.name, 10)).map((v) => _optionalChain([v, "optionalAccess", (_14) => _14.value, "optionalAccess", (_15) => _15.value]));
          next(vars);
        });
      }
      /**
       * Unrolls an object property
       */
      _unrollObject(objectId, name, vars, next) {
        this._getProperties(objectId, (props) => {
          vars[name] = props.map((v) => [v.name, _optionalChain([v, "optionalAccess", (_16) => _16.value, "optionalAccess", (_17) => _17.value])]).reduce((obj, [key, val]) => {
            obj[key] = val;
            return obj;
          }, {});
          next(vars);
        });
      }
      /**
       * Unrolls other properties
       */
      _unrollOther(prop, vars, next) {
        if (_optionalChain([prop, "optionalAccess", (_18) => _18.value, "optionalAccess", (_19) => _19.value]) != null) {
          vars[prop.name] = prop.value.value;
        } else if (_optionalChain([prop, "optionalAccess", (_20) => _20.value, "optionalAccess", (_21) => _21.description]) != null && _optionalChain([prop, "optionalAccess", (_22) => _22.value, "optionalAccess", (_23) => _23.type]) !== "function") {
          vars[prop.name] = `<${prop.value.description}>`;
        }
        next(vars);
      }
    };
    function tryNewAsyncSession() {
      try {
        return new AsyncSession();
      } catch (e) {
        return void 0;
      }
    }
    var INTEGRATION_NAME = "LocalVariables";
    var _localVariablesSyncIntegration = (options = {}, session = tryNewAsyncSession()) => {
      const cachedFrames = new utils.LRUMap(20);
      let rateLimiter;
      let shouldProcessEvent = false;
      function handlePaused(stackParser, { params: { reason, data, callFrames } }, complete) {
        if (reason !== "exception" && reason !== "promiseRejection") {
          complete();
          return;
        }
        _optionalChain([rateLimiter, "optionalCall", (_24) => _24()]);
        const exceptionHash = common.hashFromStack(stackParser, _optionalChain([data, "optionalAccess", (_25) => _25.description]));
        if (exceptionHash == void 0) {
          complete();
          return;
        }
        const { add, next } = createCallbackList((frames) => {
          cachedFrames.set(exceptionHash, frames);
          complete();
        });
        for (let i = 0; i < Math.min(callFrames.length, 5); i++) {
          const { scopeChain, functionName, this: obj } = callFrames[i];
          const localScope = scopeChain.find((scope) => scope.type === "local");
          const fn = obj.className === "global" || !obj.className ? functionName : `${obj.className}.${functionName}`;
          if (_optionalChain([localScope, "optionalAccess", (_26) => _26.object, "access", (_27) => _27.objectId]) === void 0) {
            add((frames) => {
              frames[i] = { function: fn };
              next(frames);
            });
          } else {
            const id = localScope.object.objectId;
            add(
              (frames) => _optionalChain([session, "optionalAccess", (_28) => _28.getLocalVariables, "call", (_29) => _29(id, (vars) => {
                frames[i] = { function: fn, vars };
                next(frames);
              })])
            );
          }
        }
        next([]);
      }
      function addLocalVariablesToException(exception) {
        const hash = common.hashFrames(_optionalChain([exception, "optionalAccess", (_30) => _30.stacktrace, "optionalAccess", (_31) => _31.frames]));
        if (hash === void 0) {
          return;
        }
        const cachedFrame = cachedFrames.remove(hash);
        if (cachedFrame === void 0) {
          return;
        }
        const frames = (_optionalChain([exception, "access", (_32) => _32.stacktrace, "optionalAccess", (_33) => _33.frames]) || []).filter((frame) => frame.function !== "new Promise");
        for (let i = 0; i < frames.length; i++) {
          const frameIndex = frames.length - i - 1;
          if (!frames[frameIndex] || !cachedFrame[i]) {
            break;
          }
          if (
            // We need to have vars to add
            cachedFrame[i].vars === void 0 || // We're not interested in frames that are not in_app because the vars are not relevant
            frames[frameIndex].in_app === false || // The function names need to match
            !common.functionNamesMatch(frames[frameIndex].function, cachedFrame[i].function)
          ) {
            continue;
          }
          frames[frameIndex].vars = cachedFrame[i].vars;
        }
      }
      function addLocalVariablesToEvent(event) {
        for (const exception of _optionalChain([event, "optionalAccess", (_34) => _34.exception, "optionalAccess", (_35) => _35.values]) || []) {
          addLocalVariablesToException(exception);
        }
        return event;
      }
      return {
        name: INTEGRATION_NAME,
        setupOnce() {
          const client = core.getClient();
          const clientOptions = _optionalChain([client, "optionalAccess", (_36) => _36.getOptions, "call", (_37) => _37()]);
          if (session && _optionalChain([clientOptions, "optionalAccess", (_38) => _38.includeLocalVariables])) {
            const unsupportedNodeVersion = nodeVersion.NODE_VERSION.major < 18;
            if (unsupportedNodeVersion) {
              utils.logger.log("The `LocalVariables` integration is only supported on Node >= v18.");
              return;
            }
            const captureAll = options.captureAllExceptions !== false;
            session.configureAndConnect(
              (ev, complete) => handlePaused(clientOptions.stackParser, ev, complete),
              captureAll
            );
            if (captureAll) {
              const max = options.maxExceptionsPerSecond || 50;
              rateLimiter = common.createRateLimiter(
                max,
                () => {
                  utils.logger.log("Local variables rate-limit lifted.");
                  _optionalChain([session, "optionalAccess", (_39) => _39.setPauseOnExceptions, "call", (_40) => _40(true)]);
                },
                (seconds) => {
                  utils.logger.log(
                    `Local variables rate-limit exceeded. Disabling capturing of caught exceptions for ${seconds} seconds.`
                  );
                  _optionalChain([session, "optionalAccess", (_41) => _41.setPauseOnExceptions, "call", (_42) => _42(false)]);
                }
              );
            }
            shouldProcessEvent = true;
          }
        },
        processEvent(event) {
          if (shouldProcessEvent) {
            return addLocalVariablesToEvent(event);
          }
          return event;
        },
        // These are entirely for testing
        _getCachedFramesCount() {
          return cachedFrames.size;
        },
        _getFirstCachedFrame() {
          return cachedFrames.values()[0];
        }
      };
    };
    var localVariablesSyncIntegration = core.defineIntegration(_localVariablesSyncIntegration);
    var LocalVariablesSync = core.convertIntegrationFnToClass(
      INTEGRATION_NAME,
      localVariablesSyncIntegration
    );
    exports.LocalVariablesSync = LocalVariablesSync;
    exports.createCallbackList = createCallbackList;
    exports.localVariablesSyncIntegration = localVariablesSyncIntegration;
  }
});

// ../../node_modules/.pnpm/@sentry+node@7.120.1/node_modules/@sentry/node/cjs/integrations/local-variables/index.js
var require_local_variables = __commonJS({
  "../../node_modules/.pnpm/@sentry+node@7.120.1/node_modules/@sentry/node/cjs/integrations/local-variables/index.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var localVariablesSync = require_local_variables_sync();
    var LocalVariables = localVariablesSync.LocalVariablesSync;
    var localVariablesIntegration = localVariablesSync.localVariablesSyncIntegration;
    exports.LocalVariables = LocalVariables;
    exports.localVariablesIntegration = localVariablesIntegration;
  }
});

// ../../node_modules/.pnpm/@sentry+node@7.120.1/node_modules/@sentry/node/cjs/integrations/modules.js
var require_modules = __commonJS({
  "../../node_modules/.pnpm/@sentry+node@7.120.1/node_modules/@sentry/node/cjs/integrations/modules.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var fs = __require("fs");
    var path = __require("path");
    var core = require_cjs2();
    var moduleCache;
    var INTEGRATION_NAME = "Modules";
    function getPaths() {
      try {
        return __require.cache ? Object.keys(__require.cache) : [];
      } catch (e) {
        return [];
      }
    }
    function collectModules() {
      const mainPaths = __require.main && __require.main.paths || [];
      const paths = getPaths();
      const infos = {};
      const seen = {};
      paths.forEach((path$1) => {
        let dir = path$1;
        const updir = () => {
          const orig = dir;
          dir = path.dirname(orig);
          if (!dir || orig === dir || seen[orig]) {
            return void 0;
          }
          if (mainPaths.indexOf(dir) < 0) {
            return updir();
          }
          const pkgfile = path.join(orig, "package.json");
          seen[orig] = true;
          if (!fs.existsSync(pkgfile)) {
            return updir();
          }
          try {
            const info = JSON.parse(fs.readFileSync(pkgfile, "utf8"));
            infos[info.name] = info.version;
          } catch (_oO) {
          }
        };
        updir();
      });
      return infos;
    }
    function _getModules() {
      if (!moduleCache) {
        moduleCache = collectModules();
      }
      return moduleCache;
    }
    var _modulesIntegration = () => {
      return {
        name: INTEGRATION_NAME,
        // TODO v8: Remove this
        setupOnce() {
        },
        // eslint-disable-line @typescript-eslint/no-empty-function
        processEvent(event) {
          event.modules = {
            ...event.modules,
            ..._getModules()
          };
          return event;
        }
      };
    };
    var modulesIntegration = core.defineIntegration(_modulesIntegration);
    var Modules = core.convertIntegrationFnToClass(INTEGRATION_NAME, modulesIntegration);
    exports.Modules = Modules;
    exports.modulesIntegration = modulesIntegration;
  }
});

// ../../node_modules/.pnpm/@sentry+node@7.120.1/node_modules/@sentry/node/cjs/integrations/utils/errorhandling.js
var require_errorhandling = __commonJS({
  "../../node_modules/.pnpm/@sentry+node@7.120.1/node_modules/@sentry/node/cjs/integrations/utils/errorhandling.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var core = require_cjs2();
    var utils = require_cjs();
    var debugBuild = require_debug_build4();
    var DEFAULT_SHUTDOWN_TIMEOUT = 2e3;
    function logAndExitProcess(error) {
      utils.consoleSandbox(() => {
        console.error(error);
      });
      const client = core.getClient();
      if (client === void 0) {
        debugBuild.DEBUG_BUILD && utils.logger.warn("No NodeClient was defined, we are exiting the process now.");
        global.process.exit(1);
      }
      const options = client.getOptions();
      const timeout = options && options.shutdownTimeout && options.shutdownTimeout > 0 && options.shutdownTimeout || DEFAULT_SHUTDOWN_TIMEOUT;
      client.close(timeout).then(
        (result) => {
          if (!result) {
            debugBuild.DEBUG_BUILD && utils.logger.warn("We reached the timeout for emptying the request buffer, still exiting now!");
          }
          global.process.exit(1);
        },
        (error2) => {
          debugBuild.DEBUG_BUILD && utils.logger.error(error2);
        }
      );
    }
    exports.logAndExitProcess = logAndExitProcess;
  }
});

// ../../node_modules/.pnpm/@sentry+node@7.120.1/node_modules/@sentry/node/cjs/integrations/onuncaughtexception.js
var require_onuncaughtexception = __commonJS({
  "../../node_modules/.pnpm/@sentry+node@7.120.1/node_modules/@sentry/node/cjs/integrations/onuncaughtexception.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var core = require_cjs2();
    var utils = require_cjs();
    var debugBuild = require_debug_build4();
    var errorhandling = require_errorhandling();
    var INTEGRATION_NAME = "OnUncaughtException";
    var _onUncaughtExceptionIntegration = (options = {}) => {
      const _options = {
        exitEvenIfOtherHandlersAreRegistered: true,
        ...options
      };
      return {
        name: INTEGRATION_NAME,
        // TODO v8: Remove this
        setupOnce() {
        },
        // eslint-disable-line @typescript-eslint/no-empty-function
        setup(client) {
          global.process.on("uncaughtException", makeErrorHandler(client, _options));
        }
      };
    };
    var onUncaughtExceptionIntegration = core.defineIntegration(_onUncaughtExceptionIntegration);
    var OnUncaughtException = core.convertIntegrationFnToClass(
      INTEGRATION_NAME,
      onUncaughtExceptionIntegration
    );
    function makeErrorHandler(client, options) {
      const timeout = 2e3;
      let caughtFirstError = false;
      let caughtSecondError = false;
      let calledFatalError = false;
      let firstError;
      const clientOptions = client.getOptions();
      return Object.assign(
        (error) => {
          let onFatalError = errorhandling.logAndExitProcess;
          if (options.onFatalError) {
            onFatalError = options.onFatalError;
          } else if (clientOptions.onFatalError) {
            onFatalError = clientOptions.onFatalError;
          }
          const userProvidedListenersCount = global.process.listeners("uncaughtException").reduce((acc, listener) => {
            if (
              // There are 3 listeners we ignore:
              listener.name === "domainUncaughtExceptionClear" || // as soon as we're using domains this listener is attached by node itself
              listener.tag && listener.tag === "sentry_tracingErrorCallback" || // the handler we register for tracing
              listener._errorHandler
            ) {
              return acc;
            } else {
              return acc + 1;
            }
          }, 0);
          const processWouldExit = userProvidedListenersCount === 0;
          const shouldApplyFatalHandlingLogic = options.exitEvenIfOtherHandlersAreRegistered || processWouldExit;
          if (!caughtFirstError) {
            firstError = error;
            caughtFirstError = true;
            if (core.getClient() === client) {
              core.captureException(error, {
                originalException: error,
                captureContext: {
                  level: "fatal"
                },
                mechanism: {
                  handled: false,
                  type: "onuncaughtexception"
                }
              });
            }
            if (!calledFatalError && shouldApplyFatalHandlingLogic) {
              calledFatalError = true;
              onFatalError(error);
            }
          } else {
            if (shouldApplyFatalHandlingLogic) {
              if (calledFatalError) {
                debugBuild.DEBUG_BUILD && utils.logger.warn(
                  "uncaught exception after calling fatal error shutdown callback - this is bad! forcing shutdown"
                );
                errorhandling.logAndExitProcess(error);
              } else if (!caughtSecondError) {
                caughtSecondError = true;
                setTimeout(() => {
                  if (!calledFatalError) {
                    calledFatalError = true;
                    onFatalError(firstError, error);
                  }
                }, timeout);
              }
            }
          }
        },
        { _errorHandler: true }
      );
    }
    exports.OnUncaughtException = OnUncaughtException;
    exports.makeErrorHandler = makeErrorHandler;
    exports.onUncaughtExceptionIntegration = onUncaughtExceptionIntegration;
  }
});

// ../../node_modules/.pnpm/@sentry+node@7.120.1/node_modules/@sentry/node/cjs/integrations/onunhandledrejection.js
var require_onunhandledrejection = __commonJS({
  "../../node_modules/.pnpm/@sentry+node@7.120.1/node_modules/@sentry/node/cjs/integrations/onunhandledrejection.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var core = require_cjs2();
    var utils = require_cjs();
    var errorhandling = require_errorhandling();
    var INTEGRATION_NAME = "OnUnhandledRejection";
    var _onUnhandledRejectionIntegration = (options = {}) => {
      const mode = options.mode || "warn";
      return {
        name: INTEGRATION_NAME,
        // TODO v8: Remove this
        setupOnce() {
        },
        // eslint-disable-line @typescript-eslint/no-empty-function
        setup(client) {
          global.process.on("unhandledRejection", makeUnhandledPromiseHandler(client, { mode }));
        }
      };
    };
    var onUnhandledRejectionIntegration = core.defineIntegration(_onUnhandledRejectionIntegration);
    var OnUnhandledRejection = core.convertIntegrationFnToClass(
      INTEGRATION_NAME,
      onUnhandledRejectionIntegration
    );
    function makeUnhandledPromiseHandler(client, options) {
      return function sendUnhandledPromise(reason, promise) {
        if (core.getClient() !== client) {
          return;
        }
        core.captureException(reason, {
          originalException: promise,
          captureContext: {
            extra: { unhandledPromiseRejection: true }
          },
          mechanism: {
            handled: false,
            type: "onunhandledrejection"
          }
        });
        handleRejection(reason, options);
      };
    }
    function handleRejection(reason, options) {
      const rejectionWarning = "This error originated either by throwing inside of an async function without a catch block, or by rejecting a promise which was not handled with .catch(). The promise rejected with the reason:";
      if (options.mode === "warn") {
        utils.consoleSandbox(() => {
          console.warn(rejectionWarning);
          console.error(reason && reason.stack ? reason.stack : reason);
        });
      } else if (options.mode === "strict") {
        utils.consoleSandbox(() => {
          console.warn(rejectionWarning);
        });
        errorhandling.logAndExitProcess(reason);
      }
    }
    exports.OnUnhandledRejection = OnUnhandledRejection;
    exports.makeUnhandledPromiseHandler = makeUnhandledPromiseHandler;
    exports.onUnhandledRejectionIntegration = onUnhandledRejectionIntegration;
  }
});

// ../../node_modules/.pnpm/@sentry+node@7.120.1/node_modules/@sentry/node/cjs/integrations/spotlight.js
var require_spotlight = __commonJS({
  "../../node_modules/.pnpm/@sentry+node@7.120.1/node_modules/@sentry/node/cjs/integrations/spotlight.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var http = __require("http");
    var url = __require("url");
    var core = require_cjs2();
    var utils = require_cjs();
    var INTEGRATION_NAME = "Spotlight";
    var _spotlightIntegration = (options = {}) => {
      const _options = {
        sidecarUrl: options.sidecarUrl || "http://localhost:8969/stream"
      };
      return {
        name: INTEGRATION_NAME,
        // TODO v8: Remove this
        setupOnce() {
        },
        // eslint-disable-line @typescript-eslint/no-empty-function
        setup(client) {
          if (typeof process === "object" && process.env && process.env.NODE_ENV !== "development") {
            utils.logger.warn("[Spotlight] It seems you're not in dev mode. Do you really want to have Spotlight enabled?");
          }
          connectToSpotlight(client, _options);
        }
      };
    };
    var spotlightIntegration = core.defineIntegration(_spotlightIntegration);
    var Spotlight = core.convertIntegrationFnToClass(INTEGRATION_NAME, spotlightIntegration);
    function connectToSpotlight(client, options) {
      const spotlightUrl = parseSidecarUrl(options.sidecarUrl);
      if (!spotlightUrl) {
        return;
      }
      let failedRequests = 0;
      if (typeof client.on !== "function") {
        utils.logger.warn("[Spotlight] Cannot connect to spotlight due to missing method on SDK client (`client.on`)");
        return;
      }
      client.on("beforeEnvelope", (envelope) => {
        if (failedRequests > 3) {
          utils.logger.warn("[Spotlight] Disabled Sentry -> Spotlight integration due to too many failed requests");
          return;
        }
        const serializedEnvelope = utils.serializeEnvelope(envelope);
        const request = getNativeHttpRequest();
        const req = request(
          {
            method: "POST",
            path: spotlightUrl.pathname,
            hostname: spotlightUrl.hostname,
            port: spotlightUrl.port,
            headers: {
              "Content-Type": "application/x-sentry-envelope"
            }
          },
          (res) => {
            res.on("data", () => {
            });
            res.on("end", () => {
            });
            res.setEncoding("utf8");
          }
        );
        req.on("error", () => {
          failedRequests++;
          utils.logger.warn("[Spotlight] Failed to send envelope to Spotlight Sidecar");
        });
        req.write(serializedEnvelope);
        req.end();
      });
    }
    function parseSidecarUrl(url$1) {
      try {
        return new url.URL(`${url$1}`);
      } catch (e) {
        utils.logger.warn(`[Spotlight] Invalid sidecar URL: ${url$1}`);
        return void 0;
      }
    }
    function getNativeHttpRequest() {
      const { request } = http;
      if (isWrapped(request)) {
        return request.__sentry_original__;
      }
      return request;
    }
    function isWrapped(impl) {
      return "__sentry_original__" in impl;
    }
    exports.Spotlight = Spotlight;
    exports.getNativeHttpRequest = getNativeHttpRequest;
    exports.spotlightIntegration = spotlightIntegration;
  }
});

// ../../node_modules/.pnpm/@sentry+node@7.120.1/node_modules/@sentry/node/cjs/integrations/undici/index.js
var require_undici = __commonJS({
  "../../node_modules/.pnpm/@sentry+node@7.120.1/node_modules/@sentry/node/cjs/integrations/undici/index.js"(exports) {
    var {
      _optionalChain
    } = require_cjs();
    Object.defineProperty(exports, "__esModule", { value: true });
    var core = require_cjs2();
    var utils = require_cjs();
    var nodeVersion = require_nodeVersion();
    exports.ChannelName = void 0;
    (function(ChannelName) {
      const RequestCreate = "undici:request:create";
      ChannelName["RequestCreate"] = RequestCreate;
      const RequestEnd = "undici:request:headers";
      ChannelName["RequestEnd"] = RequestEnd;
      const RequestError = "undici:request:error";
      ChannelName["RequestError"] = RequestError;
    })(exports.ChannelName || (exports.ChannelName = {}));
    var _nativeNodeFetchintegration = (options) => {
      return new Undici(options);
    };
    var nativeNodeFetchintegration = core.defineIntegration(_nativeNodeFetchintegration);
    var Undici = class _Undici {
      /**
       * @inheritDoc
       */
      static __initStatic() {
        this.id = "Undici";
      }
      /**
       * @inheritDoc
       */
      // eslint-disable-next-line deprecation/deprecation
      __init() {
        this.name = _Undici.id;
      }
      __init2() {
        this._createSpanUrlMap = new utils.LRUMap(100);
      }
      __init3() {
        this._headersUrlMap = new utils.LRUMap(100);
      }
      constructor(_options = {}) {
        _Undici.prototype.__init.call(this);
        _Undici.prototype.__init2.call(this);
        _Undici.prototype.__init3.call(this);
        _Undici.prototype.__init4.call(this);
        _Undici.prototype.__init5.call(this);
        _Undici.prototype.__init6.call(this);
        this._options = {
          breadcrumbs: _options.breadcrumbs === void 0 ? true : _options.breadcrumbs,
          tracing: _options.tracing,
          shouldCreateSpanForRequest: _options.shouldCreateSpanForRequest
        };
      }
      /**
       * @inheritDoc
       */
      setupOnce(_addGlobalEventProcessor) {
        if (nodeVersion.NODE_VERSION.major < 16) {
          return;
        }
        let ds;
        try {
          ds = __require("diagnostics_channel");
        } catch (e) {
        }
        if (!ds || !ds.subscribe) {
          return;
        }
        ds.subscribe(exports.ChannelName.RequestCreate, this._onRequestCreate);
        ds.subscribe(exports.ChannelName.RequestEnd, this._onRequestEnd);
        ds.subscribe(exports.ChannelName.RequestError, this._onRequestError);
      }
      /** Helper that wraps shouldCreateSpanForRequest option */
      _shouldCreateSpan(url) {
        if (this._options.tracing === false || this._options.tracing === void 0 && !core.hasTracingEnabled()) {
          return false;
        }
        if (this._options.shouldCreateSpanForRequest === void 0) {
          return true;
        }
        const cachedDecision = this._createSpanUrlMap.get(url);
        if (cachedDecision !== void 0) {
          return cachedDecision;
        }
        const decision = this._options.shouldCreateSpanForRequest(url);
        this._createSpanUrlMap.set(url, decision);
        return decision;
      }
      __init4() {
        this._onRequestCreate = (message) => {
          if (!_optionalChain([core.getClient, "call", (_10) => _10(), "optionalAccess", (_11) => _11.getIntegration, "call", (_12) => _12(_Undici)])) {
            return;
          }
          const { request } = message;
          const stringUrl = request.origin ? request.origin.toString() + request.path : request.path;
          const client = core.getClient();
          if (!client) {
            return;
          }
          if (core.isSentryRequestUrl(stringUrl, client) || request.__sentry_span__ !== void 0) {
            return;
          }
          const clientOptions = client.getOptions();
          const scope = core.getCurrentScope();
          const isolationScope = core.getIsolationScope();
          const parentSpan = core.getActiveSpan();
          const span = this._shouldCreateSpan(stringUrl) ? createRequestSpan(parentSpan, request, stringUrl) : void 0;
          if (span) {
            request.__sentry_span__ = span;
          }
          const shouldAttachTraceData = (url) => {
            if (clientOptions.tracePropagationTargets === void 0) {
              return true;
            }
            const cachedDecision = this._headersUrlMap.get(url);
            if (cachedDecision !== void 0) {
              return cachedDecision;
            }
            const decision = utils.stringMatchesSomePattern(url, clientOptions.tracePropagationTargets);
            this._headersUrlMap.set(url, decision);
            return decision;
          };
          if (shouldAttachTraceData(stringUrl)) {
            const { traceId, spanId, sampled, dsc } = {
              ...isolationScope.getPropagationContext(),
              ...scope.getPropagationContext()
            };
            const sentryTraceHeader = span ? core.spanToTraceHeader(span) : utils.generateSentryTraceHeader(traceId, spanId, sampled);
            const sentryBaggageHeader = utils.dynamicSamplingContextToSentryBaggageHeader(
              dsc || (span ? core.getDynamicSamplingContextFromSpan(span) : core.getDynamicSamplingContextFromClient(traceId, client, scope))
            );
            setHeadersOnRequest(request, sentryTraceHeader, sentryBaggageHeader);
          }
        };
      }
      __init5() {
        this._onRequestEnd = (message) => {
          if (!_optionalChain([core.getClient, "call", (_13) => _13(), "optionalAccess", (_14) => _14.getIntegration, "call", (_15) => _15(_Undici)])) {
            return;
          }
          const { request, response } = message;
          const stringUrl = request.origin ? request.origin.toString() + request.path : request.path;
          if (core.isSentryRequestUrl(stringUrl, core.getClient())) {
            return;
          }
          const span = request.__sentry_span__;
          if (span) {
            core.setHttpStatus(span, response.statusCode);
            span.end();
          }
          if (this._options.breadcrumbs) {
            core.addBreadcrumb(
              {
                category: "http",
                data: {
                  method: request.method,
                  status_code: response.statusCode,
                  url: stringUrl
                },
                type: "http"
              },
              {
                event: "response",
                request,
                response
              }
            );
          }
        };
      }
      __init6() {
        this._onRequestError = (message) => {
          if (!_optionalChain([core.getClient, "call", (_16) => _16(), "optionalAccess", (_17) => _17.getIntegration, "call", (_18) => _18(_Undici)])) {
            return;
          }
          const { request } = message;
          const stringUrl = request.origin ? request.origin.toString() + request.path : request.path;
          if (core.isSentryRequestUrl(stringUrl, core.getClient())) {
            return;
          }
          const span = request.__sentry_span__;
          if (span) {
            span.setStatus("internal_error");
            span.end();
          }
          if (this._options.breadcrumbs) {
            core.addBreadcrumb(
              {
                category: "http",
                data: {
                  method: request.method,
                  url: stringUrl
                },
                level: "error",
                type: "http"
              },
              {
                event: "error",
                request
              }
            );
          }
        };
      }
    };
    Undici.__initStatic();
    function setHeadersOnRequest(request, sentryTrace, sentryBaggageHeader) {
      let hasSentryHeaders;
      if (Array.isArray(request.headers)) {
        hasSentryHeaders = request.headers.some((headerLine) => headerLine === "sentry-trace");
      } else {
        const headerLines = request.headers.split("\r\n");
        hasSentryHeaders = headerLines.some((headerLine) => headerLine.startsWith("sentry-trace:"));
      }
      if (hasSentryHeaders) {
        return;
      }
      request.addHeader("sentry-trace", sentryTrace);
      if (sentryBaggageHeader) {
        request.addHeader("baggage", sentryBaggageHeader);
      }
    }
    function createRequestSpan(activeSpan, request, stringUrl) {
      const url = utils.parseUrl(stringUrl);
      const method = request.method || "GET";
      const data = {
        "http.method": method
      };
      if (url.search) {
        data["http.query"] = url.search;
      }
      if (url.hash) {
        data["http.fragment"] = url.hash;
      }
      return _optionalChain([activeSpan, "optionalAccess", (_19) => _19.startChild, "call", (_20) => _20({
        op: "http.client",
        origin: "auto.http.node.undici",
        description: `${method} ${utils.getSanitizedUrlString(url)}`,
        data
      })]);
    }
    exports.Undici = Undici;
    exports.nativeNodeFetchintegration = nativeNodeFetchintegration;
  }
});

// ../../node_modules/.pnpm/@sentry+node@7.120.1/node_modules/@sentry/node/cjs/module.js
var require_module = __commonJS({
  "../../node_modules/.pnpm/@sentry+node@7.120.1/node_modules/@sentry/node/cjs/module.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var path = __require("path");
    var utils = require_cjs();
    function normalizeWindowsPath(path2) {
      return path2.replace(/^[A-Z]:/, "").replace(/\\/g, "/");
    }
    function createGetModuleFromFilename(basePath = process.argv[1] ? utils.dirname(process.argv[1]) : process.cwd(), isWindows = path.sep === "\\") {
      const normalizedBase = isWindows ? normalizeWindowsPath(basePath) : basePath;
      return (filename) => {
        if (!filename) {
          return;
        }
        const normalizedFilename = isWindows ? normalizeWindowsPath(filename) : filename;
        let { dir, base: file, ext } = path.posix.parse(normalizedFilename);
        if (ext === ".js" || ext === ".mjs" || ext === ".cjs") {
          file = file.slice(0, ext.length * -1);
        }
        if (!dir) {
          dir = ".";
        }
        const n = dir.lastIndexOf("/node_modules");
        if (n > -1) {
          return `${dir.slice(n + 14).replace(/\//g, ".")}:${file}`;
        }
        if (dir.startsWith(normalizedBase)) {
          let moduleName = dir.slice(normalizedBase.length + 1).replace(/\//g, ".");
          if (moduleName) {
            moduleName += ":";
          }
          moduleName += file;
          return moduleName;
        }
        return file;
      };
    }
    exports.createGetModuleFromFilename = createGetModuleFromFilename;
  }
});

// ../../node_modules/.pnpm/@sentry+node@7.120.1/node_modules/@sentry/node/cjs/sdk.js
var require_sdk2 = __commonJS({
  "../../node_modules/.pnpm/@sentry+node@7.120.1/node_modules/@sentry/node/cjs/sdk.js"(exports) {
    var {
      _optionalChain
    } = require_cjs();
    Object.defineProperty(exports, "__esModule", { value: true });
    var core = require_cjs2();
    var utils = require_cjs();
    var index$2 = require_async();
    var client = require_client();
    var console2 = require_console2();
    var context = require_context();
    var contextlines = require_contextlines();
    var http = require_http3();
    var index$1 = require_local_variables();
    var modules = require_modules();
    var onuncaughtexception = require_onuncaughtexception();
    var onunhandledrejection = require_onunhandledrejection();
    var spotlight = require_spotlight();
    var index = require_undici();
    var module$1 = require_module();
    var http$1 = require_http();
    var defaultIntegrations = [
      // Common
      core.inboundFiltersIntegration(),
      core.functionToStringIntegration(),
      core.linkedErrorsIntegration(),
      core.requestDataIntegration(),
      // Native Wrappers
      console2.consoleIntegration(),
      http.httpIntegration(),
      index.nativeNodeFetchintegration(),
      // Global Handlers
      onuncaughtexception.onUncaughtExceptionIntegration(),
      onunhandledrejection.onUnhandledRejectionIntegration(),
      // Event Info
      contextlines.contextLinesIntegration(),
      index$1.localVariablesIntegration(),
      context.nodeContextIntegration(),
      modules.modulesIntegration()
    ];
    function getDefaultIntegrations(_options) {
      const carrier = core.getMainCarrier();
      const autoloadedIntegrations = _optionalChain([carrier, "access", (_) => _.__SENTRY__, "optionalAccess", (_2) => _2.integrations]) || [];
      return [
        // eslint-disable-next-line deprecation/deprecation
        ...defaultIntegrations,
        ...autoloadedIntegrations
      ];
    }
    function init(options = {}) {
      index$2.setNodeAsyncContextStrategy();
      if (options.defaultIntegrations === void 0) {
        options.defaultIntegrations = getDefaultIntegrations();
      }
      if (options.dsn === void 0 && process.env.SENTRY_DSN) {
        options.dsn = process.env.SENTRY_DSN;
      }
      const sentryTracesSampleRate = process.env.SENTRY_TRACES_SAMPLE_RATE;
      if (options.tracesSampleRate === void 0 && sentryTracesSampleRate) {
        const tracesSampleRate = parseFloat(sentryTracesSampleRate);
        if (isFinite(tracesSampleRate)) {
          options.tracesSampleRate = tracesSampleRate;
        }
      }
      if (options.release === void 0) {
        const detectedRelease = getSentryRelease();
        if (detectedRelease !== void 0) {
          options.release = detectedRelease;
        } else {
          options.autoSessionTracking = false;
        }
      }
      if (options.environment === void 0 && process.env.SENTRY_ENVIRONMENT) {
        options.environment = process.env.SENTRY_ENVIRONMENT;
      }
      if (options.autoSessionTracking === void 0 && options.dsn !== void 0) {
        options.autoSessionTracking = true;
      }
      if (options.instrumenter === void 0) {
        options.instrumenter = "sentry";
      }
      const clientOptions = {
        ...options,
        stackParser: utils.stackParserFromStackParserOptions(options.stackParser || defaultStackParser),
        integrations: core.getIntegrationsToSetup(options),
        transport: options.transport || http$1.makeNodeTransport
      };
      core.initAndBind(options.clientClass || client.NodeClient, clientOptions);
      if (options.autoSessionTracking) {
        startSessionTracking();
      }
      updateScopeFromEnvVariables();
      if (options.spotlight) {
        const client2 = core.getClient();
        if (client2 && client2.addIntegration) {
          const integrations = client2.getOptions().integrations;
          for (const integration of integrations) {
            client2.addIntegration(integration);
          }
          client2.addIntegration(
            spotlight.spotlightIntegration({ sidecarUrl: typeof options.spotlight === "string" ? options.spotlight : void 0 })
          );
        }
      }
    }
    function isAutoSessionTrackingEnabled(client2) {
      if (client2 === void 0) {
        return false;
      }
      const clientOptions = client2 && client2.getOptions();
      if (clientOptions && clientOptions.autoSessionTracking !== void 0) {
        return clientOptions.autoSessionTracking;
      }
      return false;
    }
    function getSentryRelease(fallback) {
      if (process.env.SENTRY_RELEASE) {
        return process.env.SENTRY_RELEASE;
      }
      if (utils.GLOBAL_OBJ.SENTRY_RELEASE && utils.GLOBAL_OBJ.SENTRY_RELEASE.id) {
        return utils.GLOBAL_OBJ.SENTRY_RELEASE.id;
      }
      return (
        // GitHub Actions - https://help.github.com/en/actions/configuring-and-managing-workflows/using-environment-variables#default-environment-variables
        process.env.GITHUB_SHA || // Netlify - https://docs.netlify.com/configure-builds/environment-variables/#build-metadata
        process.env.COMMIT_REF || // Vercel - https://vercel.com/docs/v2/build-step#system-environment-variables
        process.env.VERCEL_GIT_COMMIT_SHA || process.env.VERCEL_GITHUB_COMMIT_SHA || process.env.VERCEL_GITLAB_COMMIT_SHA || process.env.VERCEL_BITBUCKET_COMMIT_SHA || // Zeit (now known as Vercel)
        process.env.ZEIT_GITHUB_COMMIT_SHA || process.env.ZEIT_GITLAB_COMMIT_SHA || process.env.ZEIT_BITBUCKET_COMMIT_SHA || // Cloudflare Pages - https://developers.cloudflare.com/pages/platform/build-configuration/#environment-variables
        process.env.CF_PAGES_COMMIT_SHA || fallback
      );
    }
    var defaultStackParser = utils.createStackParser(utils.nodeStackLineParser(module$1.createGetModuleFromFilename()));
    function startSessionTracking() {
      core.startSession();
      process.on("beforeExit", () => {
        const session = core.getIsolationScope().getSession();
        const terminalStates = ["exited", "crashed"];
        if (session && !terminalStates.includes(session.status)) {
          core.endSession();
        }
      });
    }
    function updateScopeFromEnvVariables() {
      const sentryUseEnvironment = (process.env.SENTRY_USE_ENVIRONMENT || "").toLowerCase();
      if (!["false", "n", "no", "off", "0"].includes(sentryUseEnvironment)) {
        const sentryTraceEnv = process.env.SENTRY_TRACE;
        const baggageEnv = process.env.SENTRY_BAGGAGE;
        const propagationContext = utils.propagationContextFromHeaders(sentryTraceEnv, baggageEnv);
        core.getCurrentScope().setPropagationContext(propagationContext);
      }
    }
    exports.defaultIntegrations = defaultIntegrations;
    exports.defaultStackParser = defaultStackParser;
    exports.getDefaultIntegrations = getDefaultIntegrations;
    exports.getSentryRelease = getSentryRelease;
    exports.init = init;
    exports.isAutoSessionTrackingEnabled = isAutoSessionTrackingEnabled;
  }
});

// ../../node_modules/.pnpm/@sentry+node@7.120.1/node_modules/@sentry/node/cjs/utils.js
var require_utils4 = __commonJS({
  "../../node_modules/.pnpm/@sentry+node@7.120.1/node_modules/@sentry/node/cjs/utils.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var fs = __require("fs");
    var path = __require("path");
    function deepReadDirSync(targetDir) {
      const targetDirAbsPath = path.resolve(targetDir);
      if (!fs.existsSync(targetDirAbsPath)) {
        throw new Error(`Cannot read contents of ${targetDirAbsPath}. Directory does not exist.`);
      }
      if (!fs.statSync(targetDirAbsPath).isDirectory()) {
        throw new Error(`Cannot read contents of ${targetDirAbsPath}, because it is not a directory.`);
      }
      const deepReadCurrentDir = (currentDirAbsPath) => {
        return fs.readdirSync(currentDirAbsPath).reduce((absPaths, itemName) => {
          const itemAbsPath = path.join(currentDirAbsPath, itemName);
          if (fs.statSync(itemAbsPath).isDirectory()) {
            return absPaths.concat(deepReadCurrentDir(itemAbsPath));
          }
          absPaths.push(itemAbsPath);
          return absPaths;
        }, []);
      };
      return deepReadCurrentDir(targetDirAbsPath).map((absPath) => path.relative(targetDirAbsPath, absPath));
    }
    exports.deepReadDirSync = deepReadDirSync;
  }
});

// ../../node_modules/.pnpm/@sentry+node@7.120.1/node_modules/@sentry/node/cjs/integrations/anr/worker-script.js
var require_worker_script = __commonJS({
  "../../node_modules/.pnpm/@sentry+node@7.120.1/node_modules/@sentry/node/cjs/integrations/anr/worker-script.js"(exports) {
    exports.base64WorkerScript = "aW1wb3J0IHsgU2Vzc2lvbiB9IGZyb20gJ2luc3BlY3Rvcic7CmltcG9ydCB7IHdvcmtlckRhdGEsIHBhcmVudFBvcnQgfSBmcm9tICd3b3JrZXJfdGhyZWFkcyc7CmltcG9ydCB7IHBvc2l4LCBzZXAgfSBmcm9tICdwYXRoJzsKaW1wb3J0ICogYXMgaHR0cCBmcm9tICdodHRwJzsKaW1wb3J0ICogYXMgaHR0cHMgZnJvbSAnaHR0cHMnOwppbXBvcnQgeyBSZWFkYWJsZSB9IGZyb20gJ3N0cmVhbSc7CmltcG9ydCB7IFVSTCB9IGZyb20gJ3VybCc7CmltcG9ydCB7IGNyZWF0ZUd6aXAgfSBmcm9tICd6bGliJzsKaW1wb3J0ICogYXMgbmV0IGZyb20gJ25ldCc7CmltcG9ydCAqIGFzIHRscyBmcm9tICd0bHMnOwoKLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIEB0eXBlc2NyaXB0LWVzbGludC91bmJvdW5kLW1ldGhvZApjb25zdCBvYmplY3RUb1N0cmluZyA9IE9iamVjdC5wcm90b3R5cGUudG9TdHJpbmc7CgovKioKICogQ2hlY2tzIHdoZXRoZXIgZ2l2ZW4gdmFsdWUncyB0eXBlIGlzIG9uZSBvZiBhIGZldyBFcnJvciBvciBFcnJvci1saWtlCiAqIHtAbGluayBpc0Vycm9yfS4KICoKICogQHBhcmFtIHdhdCBBIHZhbHVlIHRvIGJlIGNoZWNrZWQuCiAqIEByZXR1cm5zIEEgYm9vbGVhbiByZXByZXNlbnRpbmcgdGhlIHJlc3VsdC4KICovCmZ1bmN0aW9uIGlzRXJyb3Iod2F0KSB7CiAgc3dpdGNoIChvYmplY3RUb1N0cmluZy5jYWxsKHdhdCkpIHsKICAgIGNhc2UgJ1tvYmplY3QgRXJyb3JdJzoKICAgIGNhc2UgJ1tvYmplY3QgRXhjZXB0aW9uXSc6CiAgICBjYXNlICdbb2JqZWN0IERPTUV4Y2VwdGlvbl0nOgogICAgICByZXR1cm4gdHJ1ZTsKICAgIGRlZmF1bHQ6CiAgICAgIHJldHVybiBpc0luc3RhbmNlT2Yod2F0LCBFcnJvcik7CiAgfQp9Ci8qKgogKiBDaGVja3Mgd2hldGhlciBnaXZlbiB2YWx1ZSBpcyBhbiBpbnN0YW5jZSBvZiB0aGUgZ2l2ZW4gYnVpbHQtaW4gY2xhc3MuCiAqCiAqIEBwYXJhbSB3YXQgVGhlIHZhbHVlIHRvIGJlIGNoZWNrZWQKICogQHBhcmFtIGNsYXNzTmFtZQogKiBAcmV0dXJucyBBIGJvb2xlYW4gcmVwcmVzZW50aW5nIHRoZSByZXN1bHQuCiAqLwpmdW5jdGlvbiBpc0J1aWx0aW4od2F0LCBjbGFzc05hbWUpIHsKICByZXR1cm4gb2JqZWN0VG9TdHJpbmcuY2FsbCh3YXQpID09PSBgW29iamVjdCAke2NsYXNzTmFtZX1dYDsKfQoKLyoqCiAqIENoZWNrcyB3aGV0aGVyIGdpdmVuIHZhbHVlJ3MgdHlwZSBpcyBhIHN0cmluZwogKiB7QGxpbmsgaXNTdHJpbmd9LgogKgogKiBAcGFyYW0gd2F0IEEgdmFsdWUgdG8gYmUgY2hlY2tlZC4KICogQHJldHVybnMgQSBib29sZWFuIHJlcHJlc2VudGluZyB0aGUgcmVzdWx0LgogKi8KZnVuY3Rpb24gaXNTdHJpbmcod2F0KSB7CiAgcmV0dXJuIGlzQnVpbHRpbih3YXQsICdTdHJpbmcnKTsKfQoKLyoqCiAqIENoZWNrcyB3aGV0aGVyIGdpdmVuIHZhbHVlJ3MgdHlwZSBpcyBhbiBvYmplY3QgbGl0ZXJhbCwgb3IgYSBjbGFzcyBpbnN0YW5jZS4KICoge0BsaW5rIGlzUGxhaW5PYmplY3R9LgogKgogKiBAcGFyYW0gd2F0IEEgdmFsdWUgdG8gYmUgY2hlY2tlZC4KICogQHJldHVybnMgQSBib29sZWFuIHJlcHJlc2VudGluZyB0aGUgcmVzdWx0LgogKi8KZnVuY3Rpb24gaXNQbGFpbk9iamVjdCh3YXQpIHsKICByZXR1cm4gaXNCdWlsdGluKHdhdCwgJ09iamVjdCcpOwp9CgovKioKICogQ2hlY2tzIHdoZXRoZXIgZ2l2ZW4gdmFsdWUncyB0eXBlIGlzIGFuIEV2ZW50IGluc3RhbmNlCiAqIHtAbGluayBpc0V2ZW50fS4KICoKICogQHBhcmFtIHdhdCBBIHZhbHVlIHRvIGJlIGNoZWNrZWQuCiAqIEByZXR1cm5zIEEgYm9vbGVhbiByZXByZXNlbnRpbmcgdGhlIHJlc3VsdC4KICovCmZ1bmN0aW9uIGlzRXZlbnQod2F0KSB7CiAgcmV0dXJuIHR5cGVvZiBFdmVudCAhPT0gJ3VuZGVmaW5lZCcgJiYgaXNJbnN0YW5jZU9mKHdhdCwgRXZlbnQpOwp9CgovKioKICogQ2hlY2tzIHdoZXRoZXIgZ2l2ZW4gdmFsdWUncyB0eXBlIGlzIGFuIEVsZW1lbnQgaW5zdGFuY2UKICoge0BsaW5rIGlzRWxlbWVudH0uCiAqCiAqIEBwYXJhbSB3YXQgQSB2YWx1ZSB0byBiZSBjaGVja2VkLgogKiBAcmV0dXJucyBBIGJvb2xlYW4gcmVwcmVzZW50aW5nIHRoZSByZXN1bHQuCiAqLwpmdW5jdGlvbiBpc0VsZW1lbnQod2F0KSB7CiAgcmV0dXJuIHR5cGVvZiBFbGVtZW50ICE9PSAndW5kZWZpbmVkJyAmJiBpc0luc3RhbmNlT2Yod2F0LCBFbGVtZW50KTsKfQoKLyoqCiAqIENoZWNrcyB3aGV0aGVyIGdpdmVuIHZhbHVlIGhhcyBhIHRoZW4gZnVuY3Rpb24uCiAqIEBwYXJhbSB3YXQgQSB2YWx1ZSB0byBiZSBjaGVja2VkLgogKi8KZnVuY3Rpb24gaXNUaGVuYWJsZSh3YXQpIHsKICAvLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgQHR5cGVzY3JpcHQtZXNsaW50L25vLXVuc2FmZS1tZW1iZXItYWNjZXNzCiAgcmV0dXJuIEJvb2xlYW4od2F0ICYmIHdhdC50aGVuICYmIHR5cGVvZiB3YXQudGhlbiA9PT0gJ2Z1bmN0aW9uJyk7Cn0KCi8qKgogKiBDaGVja3Mgd2hldGhlciBnaXZlbiB2YWx1ZSdzIHR5cGUgaXMgYSBTeW50aGV0aWNFdmVudAogKiB7QGxpbmsgaXNTeW50aGV0aWNFdmVudH0uCiAqCiAqIEBwYXJhbSB3YXQgQSB2YWx1ZSB0byBiZSBjaGVja2VkLgogKiBAcmV0dXJucyBBIGJvb2xlYW4gcmVwcmVzZW50aW5nIHRoZSByZXN1bHQuCiAqLwpmdW5jdGlvbiBpc1N5bnRoZXRpY0V2ZW50KHdhdCkgewogIHJldHVybiBpc1BsYWluT2JqZWN0KHdhdCkgJiYgJ25hdGl2ZUV2ZW50JyBpbiB3YXQgJiYgJ3ByZXZlbnREZWZhdWx0JyBpbiB3YXQgJiYgJ3N0b3BQcm9wYWdhdGlvbicgaW4gd2F0Owp9CgovKioKICogQ2hlY2tzIHdoZXRoZXIgZ2l2ZW4gdmFsdWUgaXMgTmFOCiAqIHtAbGluayBpc05hTn0uCiAqCiAqIEBwYXJhbSB3YXQgQSB2YWx1ZSB0byBiZSBjaGVja2VkLgogKiBAcmV0dXJucyBBIGJvb2xlYW4gcmVwcmVzZW50aW5nIHRoZSByZXN1bHQuCiAqLwpmdW5jdGlvbiBpc05hTiQxKHdhdCkgewogIHJldHVybiB0eXBlb2Ygd2F0ID09PSAnbnVtYmVyJyAmJiB3YXQgIT09IHdhdDsKfQoKLyoqCiAqIENoZWNrcyB3aGV0aGVyIGdpdmVuIHZhbHVlJ3MgdHlwZSBpcyBhbiBpbnN0YW5jZSBvZiBwcm92aWRlZCBjb25zdHJ1Y3Rvci4KICoge0BsaW5rIGlzSW5zdGFuY2VPZn0uCiAqCiAqIEBwYXJhbSB3YXQgQSB2YWx1ZSB0byBiZSBjaGVja2VkLgogKiBAcGFyYW0gYmFzZSBBIGNvbnN0cnVjdG9yIHRvIGJlIHVzZWQgaW4gYSBjaGVjay4KICogQHJldHVybnMgQSBib29sZWFuIHJlcHJlc2VudGluZyB0aGUgcmVzdWx0LgogKi8KZnVuY3Rpb24gaXNJbnN0YW5jZU9mKHdhdCwgYmFzZSkgewogIHRyeSB7CiAgICByZXR1cm4gd2F0IGluc3RhbmNlb2YgYmFzZTsKICB9IGNhdGNoIChfZSkgewogICAgcmV0dXJuIGZhbHNlOwogIH0KfQoKLyoqCiAqIENoZWNrcyB3aGV0aGVyIGdpdmVuIHZhbHVlJ3MgdHlwZSBpcyBhIFZ1ZSBWaWV3TW9kZWwuCiAqCiAqIEBwYXJhbSB3YXQgQSB2YWx1ZSB0byBiZSBjaGVja2VkLgogKiBAcmV0dXJucyBBIGJvb2xlYW4gcmVwcmVzZW50aW5nIHRoZSByZXN1bHQuCiAqLwpmdW5jdGlvbiBpc1Z1ZVZpZXdNb2RlbCh3YXQpIHsKICAvLyBOb3QgdXNpbmcgT2JqZWN0LnByb3RvdHlwZS50b1N0cmluZyBiZWNhdXNlIGluIFZ1ZSAzIGl0IHdvdWxkIHJlYWQgdGhlIGluc3RhbmNlJ3MgU3ltYm9sKFN5bWJvbC50b1N0cmluZ1RhZykgcHJvcGVydHkuCiAgcmV0dXJuICEhKHR5cGVvZiB3YXQgPT09ICdvYmplY3QnICYmIHdhdCAhPT0gbnVsbCAmJiAoKHdhdCApLl9faXNWdWUgfHwgKHdhdCApLl9pc1Z1ZSkpOwp9CgovKiogSW50ZXJuYWwgZ2xvYmFsIHdpdGggY29tbW9uIHByb3BlcnRpZXMgYW5kIFNlbnRyeSBleHRlbnNpb25zICAqLwoKLy8gVGhlIGNvZGUgYmVsb3cgZm9yICdpc0dsb2JhbE9iaicgYW5kICdHTE9CQUxfT0JKJyB3YXMgY29waWVkIGZyb20gY29yZS1qcyBiZWZvcmUgbW9kaWZpY2F0aW9uCi8vIGh0dHBzOi8vZ2l0aHViLmNvbS96bG9pcm9jay9jb3JlLWpzL2Jsb2IvMWI5NDRkZjU1MjgyY2RjOTljOTBkYjVmNDllYjBiNmVkYTJjYzBhMy9wYWNrYWdlcy9jb3JlLWpzL2ludGVybmFscy9nbG9iYWwuanMKLy8gY29yZS1qcyBoYXMgdGhlIGZvbGxvd2luZyBsaWNlbmNlOgovLwovLyBDb3B5cmlnaHQgKGMpIDIwMTQtMjAyMiBEZW5pcyBQdXNoa2FyZXYKLy8KLy8gUGVybWlzc2lvbiBpcyBoZXJlYnkgZ3JhbnRlZCwgZnJlZSBvZiBjaGFyZ2UsIHRvIGFueSBwZXJzb24gb2J0YWluaW5nIGEgY29weQovLyBvZiB0aGlzIHNvZnR3YXJlIGFuZCBhc3NvY2lhdGVkIGRvY3VtZW50YXRpb24gZmlsZXMgKHRoZSAiU29mdHdhcmUiKSwgdG8gZGVhbAovLyBpbiB0aGUgU29mdHdhcmUgd2l0aG91dCByZXN0cmljdGlvbiwgaW5jbHVkaW5nIHdpdGhvdXQgbGltaXRhdGlvbiB0aGUgcmlnaHRzCi8vIHRvIHVzZSwgY29weSwgbW9kaWZ5LCBtZXJnZSwgcHVibGlzaCwgZGlzdHJpYnV0ZSwgc3VibGljZW5zZSwgYW5kL29yIHNlbGwKLy8gY29waWVzIG9mIHRoZSBTb2Z0d2FyZSwgYW5kIHRvIHBlcm1pdCBwZXJzb25zIHRvIHdob20gdGhlIFNvZnR3YXJlIGlzCi8vIGZ1cm5pc2hlZCB0byBkbyBzbywgc3ViamVjdCB0byB0aGUgZm9sbG93aW5nIGNvbmRpdGlvbnM6Ci8vCi8vIFRoZSBhYm92ZSBjb3B5cmlnaHQgbm90aWNlIGFuZCB0aGlzIHBlcm1pc3Npb24gbm90aWNlIHNoYWxsIGJlIGluY2x1ZGVkIGluCi8vIGFsbCBjb3BpZXMgb3Igc3Vic3RhbnRpYWwgcG9ydGlvbnMgb2YgdGhlIFNvZnR3YXJlLgovLwovLyBUSEUgU09GVFdBUkUgSVMgUFJPVklERUQgIkFTIElTIiwgV0lUSE9VVCBXQVJSQU5UWSBPRiBBTlkgS0lORCwgRVhQUkVTUyBPUgovLyBJTVBMSUVELCBJTkNMVURJTkcgQlVUIE5PVCBMSU1JVEVEIFRPIFRIRSBXQVJSQU5USUVTIE9GIE1FUkNIQU5UQUJJTElUWSwKLy8gRklUTkVTUyBGT1IgQSBQQVJUSUNVTEFSIFBVUlBPU0UgQU5EIE5PTklORlJJTkdFTUVOVC4gSU4gTk8gRVZFTlQgU0hBTEwgVEhFCi8vIEFVVEhPUlMgT1IgQ09QWVJJR0hUIEhPTERFUlMgQkUgTElBQkxFIEZPUiBBTlkgQ0xBSU0sIERBTUFHRVMgT1IgT1RIRVIKLy8gTElBQklMSVRZLCBXSEVUSEVSIElOIEFOIEFDVElPTiBPRiBDT05UUkFDVCwgVE9SVCBPUiBPVEhFUldJU0UsIEFSSVNJTkcgRlJPTSwKLy8gT1VUIE9GIE9SIElOIENPTk5FQ1RJT04gV0lUSCBUSEUgU09GVFdBUkUgT1IgVEhFIFVTRSBPUiBPVEhFUiBERUFMSU5HUyBJTgovLyBUSEUgU09GVFdBUkUuCgovKiogUmV0dXJucyAnb2JqJyBpZiBpdCdzIHRoZSBnbG9iYWwgb2JqZWN0LCBvdGhlcndpc2UgcmV0dXJucyB1bmRlZmluZWQgKi8KZnVuY3Rpb24gaXNHbG9iYWxPYmoob2JqKSB7CiAgcmV0dXJuIG9iaiAmJiBvYmouTWF0aCA9PSBNYXRoID8gb2JqIDogdW5kZWZpbmVkOwp9CgovKiogR2V0J3MgdGhlIGdsb2JhbCBvYmplY3QgZm9yIHRoZSBjdXJyZW50IEphdmFTY3JpcHQgcnVudGltZSAqLwpjb25zdCBHTE9CQUxfT0JKID0KICAodHlwZW9mIGdsb2JhbFRoaXMgPT0gJ29iamVjdCcgJiYgaXNHbG9iYWxPYmooZ2xvYmFsVGhpcykpIHx8CiAgLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIG5vLXJlc3RyaWN0ZWQtZ2xvYmFscwogICh0eXBlb2Ygd2luZG93ID09ICdvYmplY3QnICYmIGlzR2xvYmFsT2JqKHdpbmRvdykpIHx8CiAgKHR5cGVvZiBzZWxmID09ICdvYmplY3QnICYmIGlzR2xvYmFsT2JqKHNlbGYpKSB8fAogICh0eXBlb2YgZ2xvYmFsID09ICdvYmplY3QnICYmIGlzR2xvYmFsT2JqKGdsb2JhbCkpIHx8CiAgKGZ1bmN0aW9uICgpIHsKICAgIHJldHVybiB0aGlzOwogIH0pKCkgfHwKICB7fTsKCi8qKgogKiBAZGVwcmVjYXRlZCBVc2UgR0xPQkFMX09CSiBpbnN0ZWFkIG9yIFdJTkRPVyBmcm9tIEBzZW50cnkvYnJvd3Nlci4gVGhpcyB3aWxsIGJlIHJlbW92ZWQgaW4gdjgKICovCmZ1bmN0aW9uIGdldEdsb2JhbE9iamVjdCgpIHsKICByZXR1cm4gR0xPQkFMX09CSiA7Cn0KCi8qKgogKiBSZXR1cm5zIGEgZ2xvYmFsIHNpbmdsZXRvbiBjb250YWluZWQgaW4gdGhlIGdsb2JhbCBgX19TRU5UUllfX2Agb2JqZWN0LgogKgogKiBJZiB0aGUgc2luZ2xldG9uIGRvZXNuJ3QgYWxyZWFkeSBleGlzdCBpbiBgX19TRU5UUllfX2AsIGl0IHdpbGwgYmUgY3JlYXRlZCB1c2luZyB0aGUgZ2l2ZW4gZmFjdG9yeQogKiBmdW5jdGlvbiBhbmQgYWRkZWQgdG8gdGhlIGBfX1NFTlRSWV9fYCBvYmplY3QuCiAqCiAqIEBwYXJhbSBuYW1lIG5hbWUgb2YgdGhlIGdsb2JhbCBzaW5nbGV0b24gb24gX19TRU5UUllfXwogKiBAcGFyYW0gY3JlYXRvciBjcmVhdG9yIEZhY3RvcnkgZnVuY3Rpb24gdG8gY3JlYXRlIHRoZSBzaW5nbGV0b24gaWYgaXQgZG9lc24ndCBhbHJlYWR5IGV4aXN0IG9uIGBfX1NFTlRSWV9fYAogKiBAcGFyYW0gb2JqIChPcHRpb25hbCkgVGhlIGdsb2JhbCBvYmplY3Qgb24gd2hpY2ggdG8gbG9vayBmb3IgYF9fU0VOVFJZX19gLCBpZiBub3QgYEdMT0JBTF9PQkpgJ3MgcmV0dXJuIHZhbHVlCiAqIEByZXR1cm5zIHRoZSBzaW5nbGV0b24KICovCmZ1bmN0aW9uIGdldEdsb2JhbFNpbmdsZXRvbihuYW1lLCBjcmVhdG9yLCBvYmopIHsKICBjb25zdCBnYmwgPSAob2JqIHx8IEdMT0JBTF9PQkopIDsKICBjb25zdCBfX1NFTlRSWV9fID0gKGdibC5fX1NFTlRSWV9fID0gZ2JsLl9fU0VOVFJZX18gfHwge30pOwogIGNvbnN0IHNpbmdsZXRvbiA9IF9fU0VOVFJZX19bbmFtZV0gfHwgKF9fU0VOVFJZX19bbmFtZV0gPSBjcmVhdG9yKCkpOwogIHJldHVybiBzaW5nbGV0b247Cn0KCi8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBkZXByZWNhdGlvbi9kZXByZWNhdGlvbgpjb25zdCBXSU5ET1cgPSBnZXRHbG9iYWxPYmplY3QoKTsKCmNvbnN0IERFRkFVTFRfTUFYX1NUUklOR19MRU5HVEggPSA4MDsKCi8qKgogKiBHaXZlbiBhIGNoaWxkIERPTSBlbGVtZW50LCByZXR1cm5zIGEgcXVlcnktc2VsZWN0b3Igc3RhdGVtZW50IGRlc2NyaWJpbmcgdGhhdAogKiBhbmQgaXRzIGFuY2VzdG9ycwogKiBlLmcuIFtIVE1MRWxlbWVudF0gPT4gYm9keSA+IGRpdiA+IGlucHV0I2Zvby5idG5bbmFtZT1iYXpdCiAqIEByZXR1cm5zIGdlbmVyYXRlZCBET00gcGF0aAogKi8KZnVuY3Rpb24gaHRtbFRyZWVBc1N0cmluZygKICBlbGVtLAogIG9wdGlvbnMgPSB7fSwKKSB7CiAgaWYgKCFlbGVtKSB7CiAgICByZXR1cm4gJzx1bmtub3duPic7CiAgfQoKICAvLyB0cnkvY2F0Y2ggYm90aDoKICAvLyAtIGFjY2Vzc2luZyBldmVudC50YXJnZXQgKHNlZSBnZXRzZW50cnkvcmF2ZW4tanMjODM4LCAjNzY4KQogIC8vIC0gYGh0bWxUcmVlQXNTdHJpbmdgIGJlY2F1c2UgaXQncyBjb21wbGV4LCBhbmQganVzdCBhY2Nlc3NpbmcgdGhlIERPTSBpbmNvcnJlY3RseQogIC8vIC0gY2FuIHRocm93IGFuIGV4Y2VwdGlvbiBpbiBzb21lIGNpcmN1bXN0YW5jZXMuCiAgdHJ5IHsKICAgIGxldCBjdXJyZW50RWxlbSA9IGVsZW0gOwogICAgY29uc3QgTUFYX1RSQVZFUlNFX0hFSUdIVCA9IDU7CiAgICBjb25zdCBvdXQgPSBbXTsKICAgIGxldCBoZWlnaHQgPSAwOwogICAgbGV0IGxlbiA9IDA7CiAgICBjb25zdCBzZXBhcmF0b3IgPSAnID4gJzsKICAgIGNvbnN0IHNlcExlbmd0aCA9IHNlcGFyYXRvci5sZW5ndGg7CiAgICBsZXQgbmV4dFN0cjsKICAgIGNvbnN0IGtleUF0dHJzID0gQXJyYXkuaXNBcnJheShvcHRpb25zKSA/IG9wdGlvbnMgOiBvcHRpb25zLmtleUF0dHJzOwogICAgY29uc3QgbWF4U3RyaW5nTGVuZ3RoID0gKCFBcnJheS5pc0FycmF5KG9wdGlvbnMpICYmIG9wdGlvbnMubWF4U3RyaW5nTGVuZ3RoKSB8fCBERUZBVUxUX01BWF9TVFJJTkdfTEVOR1RIOwoKICAgIHdoaWxlIChjdXJyZW50RWxlbSAmJiBoZWlnaHQrKyA8IE1BWF9UUkFWRVJTRV9IRUlHSFQpIHsKICAgICAgbmV4dFN0ciA9IF9odG1sRWxlbWVudEFzU3RyaW5nKGN1cnJlbnRFbGVtLCBrZXlBdHRycyk7CiAgICAgIC8vIGJhaWwgb3V0IGlmCiAgICAgIC8vIC0gbmV4dFN0ciBpcyB0aGUgJ2h0bWwnIGVsZW1lbnQKICAgICAgLy8gLSB0aGUgbGVuZ3RoIG9mIHRoZSBzdHJpbmcgdGhhdCB3b3VsZCBiZSBjcmVhdGVkIGV4Y2VlZHMgbWF4U3RyaW5nTGVuZ3RoCiAgICAgIC8vICAgKGlnbm9yZSB0aGlzIGxpbWl0IGlmIHdlIGFyZSBvbiB0aGUgZmlyc3QgaXRlcmF0aW9uKQogICAgICBpZiAobmV4dFN0ciA9PT0gJ2h0bWwnIHx8IChoZWlnaHQgPiAxICYmIGxlbiArIG91dC5sZW5ndGggKiBzZXBMZW5ndGggKyBuZXh0U3RyLmxlbmd0aCA+PSBtYXhTdHJpbmdMZW5ndGgpKSB7CiAgICAgICAgYnJlYWs7CiAgICAgIH0KCiAgICAgIG91dC5wdXNoKG5leHRTdHIpOwoKICAgICAgbGVuICs9IG5leHRTdHIubGVuZ3RoOwogICAgICBjdXJyZW50RWxlbSA9IGN1cnJlbnRFbGVtLnBhcmVudE5vZGU7CiAgICB9CgogICAgcmV0dXJuIG91dC5yZXZlcnNlKCkuam9pbihzZXBhcmF0b3IpOwogIH0gY2F0Y2ggKF9vTykgewogICAgcmV0dXJuICc8dW5rbm93bj4nOwogIH0KfQoKLyoqCiAqIFJldHVybnMgYSBzaW1wbGUsIHF1ZXJ5LXNlbGVjdG9yIHJlcHJlc2VudGF0aW9uIG9mIGEgRE9NIGVsZW1lbnQKICogZS5nLiBbSFRNTEVsZW1lbnRdID0+IGlucHV0I2Zvby5idG5bbmFtZT1iYXpdCiAqIEByZXR1cm5zIGdlbmVyYXRlZCBET00gcGF0aAogKi8KZnVuY3Rpb24gX2h0bWxFbGVtZW50QXNTdHJpbmcoZWwsIGtleUF0dHJzKSB7CiAgY29uc3QgZWxlbSA9IGVsCgo7CgogIGNvbnN0IG91dCA9IFtdOwogIGxldCBjbGFzc05hbWU7CiAgbGV0IGNsYXNzZXM7CiAgbGV0IGtleTsKICBsZXQgYXR0cjsKICBsZXQgaTsKCiAgaWYgKCFlbGVtIHx8ICFlbGVtLnRhZ05hbWUpIHsKICAgIHJldHVybiAnJzsKICB9CgogIC8vIEB0cy1leHBlY3QtZXJyb3IgV0lORE9XIGhhcyBIVE1MRWxlbWVudAogIGlmIChXSU5ET1cuSFRNTEVsZW1lbnQpIHsKICAgIC8vIElmIHVzaW5nIHRoZSBjb21wb25lbnQgbmFtZSBhbm5vdGF0aW9uIHBsdWdpbiwgdGhpcyB2YWx1ZSBtYXkgYmUgYXZhaWxhYmxlIG9uIHRoZSBET00gbm9kZQogICAgaWYgKGVsZW0gaW5zdGFuY2VvZiBIVE1MRWxlbWVudCAmJiBlbGVtLmRhdGFzZXQgJiYgZWxlbS5kYXRhc2V0WydzZW50cnlDb21wb25lbnQnXSkgewogICAgICByZXR1cm4gZWxlbS5kYXRhc2V0WydzZW50cnlDb21wb25lbnQnXTsKICAgIH0KICB9CgogIG91dC5wdXNoKGVsZW0udGFnTmFtZS50b0xvd2VyQ2FzZSgpKTsKCiAgLy8gUGFpcnMgb2YgYXR0cmlidXRlIGtleXMgZGVmaW5lZCBpbiBgc2VyaWFsaXplQXR0cmlidXRlYCBhbmQgdGhlaXIgdmFsdWVzIG9uIGVsZW1lbnQuCiAgY29uc3Qga2V5QXR0clBhaXJzID0KICAgIGtleUF0dHJzICYmIGtleUF0dHJzLmxlbmd0aAogICAgICA/IGtleUF0dHJzLmZpbHRlcihrZXlBdHRyID0+IGVsZW0uZ2V0QXR0cmlidXRlKGtleUF0dHIpKS5tYXAoa2V5QXR0ciA9PiBba2V5QXR0ciwgZWxlbS5nZXRBdHRyaWJ1dGUoa2V5QXR0cildKQogICAgICA6IG51bGw7CgogIGlmIChrZXlBdHRyUGFpcnMgJiYga2V5QXR0clBhaXJzLmxlbmd0aCkgewogICAga2V5QXR0clBhaXJzLmZvckVhY2goa2V5QXR0clBhaXIgPT4gewogICAgICBvdXQucHVzaChgWyR7a2V5QXR0clBhaXJbMF19PSIke2tleUF0dHJQYWlyWzFdfSJdYCk7CiAgICB9KTsKICB9IGVsc2UgewogICAgaWYgKGVsZW0uaWQpIHsKICAgICAgb3V0LnB1c2goYCMke2VsZW0uaWR9YCk7CiAgICB9CgogICAgLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIHByZWZlci1jb25zdAogICAgY2xhc3NOYW1lID0gZWxlbS5jbGFzc05hbWU7CiAgICBpZiAoY2xhc3NOYW1lICYmIGlzU3RyaW5nKGNsYXNzTmFtZSkpIHsKICAgICAgY2xhc3NlcyA9IGNsYXNzTmFtZS5zcGxpdCgvXHMrLyk7CiAgICAgIGZvciAoaSA9IDA7IGkgPCBjbGFzc2VzLmxlbmd0aDsgaSsrKSB7CiAgICAgICAgb3V0LnB1c2goYC4ke2NsYXNzZXNbaV19YCk7CiAgICAgIH0KICAgIH0KICB9CiAgY29uc3QgYWxsb3dlZEF0dHJzID0gWydhcmlhLWxhYmVsJywgJ3R5cGUnLCAnbmFtZScsICd0aXRsZScsICdhbHQnXTsKICBmb3IgKGkgPSAwOyBpIDwgYWxsb3dlZEF0dHJzLmxlbmd0aDsgaSsrKSB7CiAgICBrZXkgPSBhbGxvd2VkQXR0cnNbaV07CiAgICBhdHRyID0gZWxlbS5nZXRBdHRyaWJ1dGUoa2V5KTsKICAgIGlmIChhdHRyKSB7CiAgICAgIG91dC5wdXNoKGBbJHtrZXl9PSIke2F0dHJ9Il1gKTsKICAgIH0KICB9CiAgcmV0dXJuIG91dC5qb2luKCcnKTsKfQoKLyoqCiAqIFRoaXMgc2VydmVzIGFzIGEgYnVpbGQgdGltZSBmbGFnIHRoYXQgd2lsbCBiZSB0cnVlIGJ5IGRlZmF1bHQsIGJ1dCBmYWxzZSBpbiBub24tZGVidWcgYnVpbGRzIG9yIGlmIHVzZXJzIHJlcGxhY2UgYF9fU0VOVFJZX0RFQlVHX19gIGluIHRoZWlyIGdlbmVyYXRlZCBjb2RlLgogKgogKiBBVFRFTlRJT046IFRoaXMgY29uc3RhbnQgbXVzdCBuZXZlciBjcm9zcyBwYWNrYWdlIGJvdW5kYXJpZXMgKGkuZS4gYmUgZXhwb3J0ZWQpIHRvIGd1YXJhbnRlZSB0aGF0IGl0IGNhbiBiZSB1c2VkIGZvciB0cmVlIHNoYWtpbmcuCiAqLwpjb25zdCBERUJVR19CVUlMRCQxID0gKHR5cGVvZiBfX1NFTlRSWV9ERUJVR19fID09PSAndW5kZWZpbmVkJyB8fCBfX1NFTlRSWV9ERUJVR19fKTsKCi8qKiBQcmVmaXggZm9yIGxvZ2dpbmcgc3RyaW5ncyAqLwpjb25zdCBQUkVGSVggPSAnU2VudHJ5IExvZ2dlciAnOwoKY29uc3QgQ09OU09MRV9MRVZFTFMgPSBbCiAgJ2RlYnVnJywKICAnaW5mbycsCiAgJ3dhcm4nLAogICdlcnJvcicsCiAgJ2xvZycsCiAgJ2Fzc2VydCcsCiAgJ3RyYWNlJywKXSA7CgovKiogVGhpcyBtYXkgYmUgbXV0YXRlZCBieSB0aGUgY29uc29sZSBpbnN0cnVtZW50YXRpb24uICovCmNvbnN0IG9yaWdpbmFsQ29uc29sZU1ldGhvZHMKCiA9IHt9OwoKLyoqIEpTRG9jICovCgovKioKICogVGVtcG9yYXJpbHkgZGlzYWJsZSBzZW50cnkgY29uc29sZSBpbnN0cnVtZW50YXRpb25zLgogKgogKiBAcGFyYW0gY2FsbGJhY2sgVGhlIGZ1bmN0aW9uIHRvIHJ1biBhZ2FpbnN0IHRoZSBvcmlnaW5hbCBgY29uc29sZWAgbWVzc2FnZXMKICogQHJldHVybnMgVGhlIHJlc3VsdHMgb2YgdGhlIGNhbGxiYWNrCiAqLwpmdW5jdGlvbiBjb25zb2xlU2FuZGJveChjYWxsYmFjaykgewogIGlmICghKCdjb25zb2xlJyBpbiBHTE9CQUxfT0JKKSkgewogICAgcmV0dXJuIGNhbGxiYWNrKCk7CiAgfQoKICBjb25zdCBjb25zb2xlID0gR0xPQkFMX09CSi5jb25zb2xlIDsKICBjb25zdCB3cmFwcGVkRnVuY3MgPSB7fTsKCiAgY29uc3Qgd3JhcHBlZExldmVscyA9IE9iamVjdC5rZXlzKG9yaWdpbmFsQ29uc29sZU1ldGhvZHMpIDsKCiAgLy8gUmVzdG9yZSBhbGwgd3JhcHBlZCBjb25zb2xlIG1ldGhvZHMKICB3cmFwcGVkTGV2ZWxzLmZvckVhY2gobGV2ZWwgPT4gewogICAgY29uc3Qgb3JpZ2luYWxDb25zb2xlTWV0aG9kID0gb3JpZ2luYWxDb25zb2xlTWV0aG9kc1tsZXZlbF0gOwogICAgd3JhcHBlZEZ1bmNzW2xldmVsXSA9IGNvbnNvbGVbbGV2ZWxdIDsKICAgIGNvbnNvbGVbbGV2ZWxdID0gb3JpZ2luYWxDb25zb2xlTWV0aG9kOwogIH0pOwoKICB0cnkgewogICAgcmV0dXJuIGNhbGxiYWNrKCk7CiAgfSBmaW5hbGx5IHsKICAgIC8vIFJldmVydCByZXN0b3JhdGlvbiB0byB3cmFwcGVkIHN0YXRlCiAgICB3cmFwcGVkTGV2ZWxzLmZvckVhY2gobGV2ZWwgPT4gewogICAgICBjb25zb2xlW2xldmVsXSA9IHdyYXBwZWRGdW5jc1tsZXZlbF0gOwogICAgfSk7CiAgfQp9CgpmdW5jdGlvbiBtYWtlTG9nZ2VyKCkgewogIGxldCBlbmFibGVkID0gZmFsc2U7CiAgY29uc3QgbG9nZ2VyID0gewogICAgZW5hYmxlOiAoKSA9PiB7CiAgICAgIGVuYWJsZWQgPSB0cnVlOwogICAgfSwKICAgIGRpc2FibGU6ICgpID0+IHsKICAgICAgZW5hYmxlZCA9IGZhbHNlOwogICAgfSwKICAgIGlzRW5hYmxlZDogKCkgPT4gZW5hYmxlZCwKICB9OwoKICBpZiAoREVCVUdfQlVJTEQkMSkgewogICAgQ09OU09MRV9MRVZFTFMuZm9yRWFjaChuYW1lID0+IHsKICAgICAgLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIEB0eXBlc2NyaXB0LWVzbGludC9uby1leHBsaWNpdC1hbnkKICAgICAgbG9nZ2VyW25hbWVdID0gKC4uLmFyZ3MpID0+IHsKICAgICAgICBpZiAoZW5hYmxlZCkgewogICAgICAgICAgY29uc29sZVNhbmRib3goKCkgPT4gewogICAgICAgICAgICBHTE9CQUxfT0JKLmNvbnNvbGVbbmFtZV0oYCR7UFJFRklYfVske25hbWV9XTpgLCAuLi5hcmdzKTsKICAgICAgICAgIH0pOwogICAgICAgIH0KICAgICAgfTsKICAgIH0pOwogIH0gZWxzZSB7CiAgICBDT05TT0xFX0xFVkVMUy5mb3JFYWNoKG5hbWUgPT4gewogICAgICBsb2dnZXJbbmFtZV0gPSAoKSA9PiB1bmRlZmluZWQ7CiAgICB9KTsKICB9CgogIHJldHVybiBsb2dnZXIgOwp9Cgpjb25zdCBsb2dnZXIgPSBtYWtlTG9nZ2VyKCk7CgovKioKICogUmVuZGVycyB0aGUgc3RyaW5nIHJlcHJlc2VudGF0aW9uIG9mIHRoaXMgRHNuLgogKgogKiBCeSBkZWZhdWx0LCB0aGlzIHdpbGwgcmVuZGVyIHRoZSBwdWJsaWMgcmVwcmVzZW50YXRpb24gd2l0aG91dCB0aGUgcGFzc3dvcmQKICogY29tcG9uZW50LiBUbyBnZXQgdGhlIGRlcHJlY2F0ZWQgcHJpdmF0ZSByZXByZXNlbnRhdGlvbiwgc2V0IGB3aXRoUGFzc3dvcmRgCiAqIHRvIHRydWUuCiAqCiAqIEBwYXJhbSB3aXRoUGFzc3dvcmQgV2hlbiBzZXQgdG8gdHJ1ZSwgdGhlIHBhc3N3b3JkIHdpbGwgYmUgaW5jbHVkZWQuCiAqLwpmdW5jdGlvbiBkc25Ub1N0cmluZyhkc24sIHdpdGhQYXNzd29yZCA9IGZhbHNlKSB7CiAgY29uc3QgeyBob3N0LCBwYXRoLCBwYXNzLCBwb3J0LCBwcm9qZWN0SWQsIHByb3RvY29sLCBwdWJsaWNLZXkgfSA9IGRzbjsKICByZXR1cm4gKAogICAgYCR7cHJvdG9jb2x9Oi8vJHtwdWJsaWNLZXl9JHt3aXRoUGFzc3dvcmQgJiYgcGFzcyA/IGA6JHtwYXNzfWAgOiAnJ31gICsKICAgIGBAJHtob3N0fSR7cG9ydCA/IGA6JHtwb3J0fWAgOiAnJ30vJHtwYXRoID8gYCR7cGF0aH0vYCA6IHBhdGh9JHtwcm9qZWN0SWR9YAogICk7Cn0KCi8qKiBBbiBlcnJvciBlbWl0dGVkIGJ5IFNlbnRyeSBTREtzIGFuZCByZWxhdGVkIHV0aWxpdGllcy4gKi8KY2xhc3MgU2VudHJ5RXJyb3IgZXh0ZW5kcyBFcnJvciB7CiAgLyoqIERpc3BsYXkgbmFtZSBvZiB0aGlzIGVycm9yIGluc3RhbmNlLiAqLwoKICAgY29uc3RydWN0b3IoIG1lc3NhZ2UsIGxvZ0xldmVsID0gJ3dhcm4nKSB7CiAgICBzdXBlcihtZXNzYWdlKTt0aGlzLm1lc3NhZ2UgPSBtZXNzYWdlOwogICAgdGhpcy5uYW1lID0gbmV3LnRhcmdldC5wcm90b3R5cGUuY29uc3RydWN0b3IubmFtZTsKICAgIC8vIFRoaXMgc2V0cyB0aGUgcHJvdG90eXBlIHRvIGJlIGBFcnJvcmAsIG5vdCBgU2VudHJ5RXJyb3JgLiBJdCdzIHVuY2xlYXIgd2h5IHdlIGRvIHRoaXMsIGJ1dCBjb21tZW50aW5nIHRoaXMgbGluZQogICAgLy8gb3V0IGNhdXNlcyB2YXJpb3VzIChzZWVtaW5nbHkgdG90YWxseSB1bnJlbGF0ZWQpIHBsYXl3cmlnaHQgdGVzdHMgY29uc2lzdGVudGx5IHRpbWUgb3V0LiBGWUksIHRoaXMgbWFrZXMKICAgIC8vIGluc3RhbmNlcyBvZiBgU2VudHJ5RXJyb3JgIGZhaWwgYG9iaiBpbnN0YW5jZW9mIFNlbnRyeUVycm9yYCBjaGVja3MuCiAgICBPYmplY3Quc2V0UHJvdG90eXBlT2YodGhpcywgbmV3LnRhcmdldC5wcm90b3R5cGUpOwogICAgdGhpcy5sb2dMZXZlbCA9IGxvZ0xldmVsOwogIH0KfQoKLyoqCiAqIEVuY29kZXMgZ2l2ZW4gb2JqZWN0IGludG8gdXJsLWZyaWVuZGx5IGZvcm1hdAogKgogKiBAcGFyYW0gb2JqZWN0IEFuIG9iamVjdCB0aGF0IGNvbnRhaW5zIHNlcmlhbGl6YWJsZSB2YWx1ZXMKICogQHJldHVybnMgc3RyaW5nIEVuY29kZWQKICovCmZ1bmN0aW9uIHVybEVuY29kZShvYmplY3QpIHsKICByZXR1cm4gT2JqZWN0LmtleXMob2JqZWN0KQogICAgLm1hcChrZXkgPT4gYCR7ZW5jb2RlVVJJQ29tcG9uZW50KGtleSl9PSR7ZW5jb2RlVVJJQ29tcG9uZW50KG9iamVjdFtrZXldKX1gKQogICAgLmpvaW4oJyYnKTsKfQoKLyoqCiAqIFRyYW5zZm9ybXMgYW55IGBFcnJvcmAgb3IgYEV2ZW50YCBpbnRvIGEgcGxhaW4gb2JqZWN0IHdpdGggYWxsIG9mIHRoZWlyIGVudW1lcmFibGUgcHJvcGVydGllcywgYW5kIHNvbWUgb2YgdGhlaXIKICogbm9uLWVudW1lcmFibGUgcHJvcGVydGllcyBhdHRhY2hlZC4KICoKICogQHBhcmFtIHZhbHVlIEluaXRpYWwgc291cmNlIHRoYXQgd2UgaGF2ZSB0byB0cmFuc2Zvcm0gaW4gb3JkZXIgZm9yIGl0IHRvIGJlIHVzYWJsZSBieSB0aGUgc2VyaWFsaXplcgogKiBAcmV0dXJucyBBbiBFdmVudCBvciBFcnJvciB0dXJuZWQgaW50byBhbiBvYmplY3QgLSBvciB0aGUgdmFsdWUgYXJndXJtZW50IGl0c2VsZiwgd2hlbiB2YWx1ZSBpcyBuZWl0aGVyIGFuIEV2ZW50IG5vcgogKiAgYW4gRXJyb3IuCiAqLwpmdW5jdGlvbiBjb252ZXJ0VG9QbGFpbk9iamVjdCgKICB2YWx1ZSwKKQoKIHsKICBpZiAoaXNFcnJvcih2YWx1ZSkpIHsKICAgIHJldHVybiB7CiAgICAgIG1lc3NhZ2U6IHZhbHVlLm1lc3NhZ2UsCiAgICAgIG5hbWU6IHZhbHVlLm5hbWUsCiAgICAgIHN0YWNrOiB2YWx1ZS5zdGFjaywKICAgICAgLi4uZ2V0T3duUHJvcGVydGllcyh2YWx1ZSksCiAgICB9OwogIH0gZWxzZSBpZiAoaXNFdmVudCh2YWx1ZSkpIHsKICAgIGNvbnN0IG5ld09iagoKID0gewogICAgICB0eXBlOiB2YWx1ZS50eXBlLAogICAgICB0YXJnZXQ6IHNlcmlhbGl6ZUV2ZW50VGFyZ2V0KHZhbHVlLnRhcmdldCksCiAgICAgIGN1cnJlbnRUYXJnZXQ6IHNlcmlhbGl6ZUV2ZW50VGFyZ2V0KHZhbHVlLmN1cnJlbnRUYXJnZXQpLAogICAgICAuLi5nZXRPd25Qcm9wZXJ0aWVzKHZhbHVlKSwKICAgIH07CgogICAgaWYgKHR5cGVvZiBDdXN0b21FdmVudCAhPT0gJ3VuZGVmaW5lZCcgJiYgaXNJbnN0YW5jZU9mKHZhbHVlLCBDdXN0b21FdmVudCkpIHsKICAgICAgbmV3T2JqLmRldGFpbCA9IHZhbHVlLmRldGFpbDsKICAgIH0KCiAgICByZXR1cm4gbmV3T2JqOwogIH0gZWxzZSB7CiAgICByZXR1cm4gdmFsdWU7CiAgfQp9CgovKiogQ3JlYXRlcyBhIHN0cmluZyByZXByZXNlbnRhdGlvbiBvZiB0aGUgdGFyZ2V0IG9mIGFuIGBFdmVudGAgb2JqZWN0ICovCmZ1bmN0aW9uIHNlcmlhbGl6ZUV2ZW50VGFyZ2V0KHRhcmdldCkgewogIHRyeSB7CiAgICByZXR1cm4gaXNFbGVtZW50KHRhcmdldCkgPyBodG1sVHJlZUFzU3RyaW5nKHRhcmdldCkgOiBPYmplY3QucHJvdG90eXBlLnRvU3RyaW5nLmNhbGwodGFyZ2V0KTsKICB9IGNhdGNoIChfb08pIHsKICAgIHJldHVybiAnPHVua25vd24+JzsKICB9Cn0KCi8qKiBGaWx0ZXJzIG91dCBhbGwgYnV0IGFuIG9iamVjdCdzIG93biBwcm9wZXJ0aWVzICovCmZ1bmN0aW9uIGdldE93blByb3BlcnRpZXMob2JqKSB7CiAgaWYgKHR5cGVvZiBvYmogPT09ICdvYmplY3QnICYmIG9iaiAhPT0gbnVsbCkgewogICAgY29uc3QgZXh0cmFjdGVkUHJvcHMgPSB7fTsKICAgIGZvciAoY29uc3QgcHJvcGVydHkgaW4gb2JqKSB7CiAgICAgIGlmIChPYmplY3QucHJvdG90eXBlLmhhc093blByb3BlcnR5LmNhbGwob2JqLCBwcm9wZXJ0eSkpIHsKICAgICAgICBleHRyYWN0ZWRQcm9wc1twcm9wZXJ0eV0gPSAob2JqIClbcHJvcGVydHldOwogICAgICB9CiAgICB9CiAgICByZXR1cm4gZXh0cmFjdGVkUHJvcHM7CiAgfSBlbHNlIHsKICAgIHJldHVybiB7fTsKICB9Cn0KCi8qKgogKiBHaXZlbiBhbnkgb2JqZWN0LCByZXR1cm4gYSBuZXcgb2JqZWN0IGhhdmluZyByZW1vdmVkIGFsbCBmaWVsZHMgd2hvc2UgdmFsdWUgd2FzIGB1bmRlZmluZWRgLgogKiBXb3JrcyByZWN1cnNpdmVseSBvbiBvYmplY3RzIGFuZCBhcnJheXMuCiAqCiAqIEF0dGVudGlvbjogVGhpcyBmdW5jdGlvbiBrZWVwcyBjaXJjdWxhciByZWZlcmVuY2VzIGluIHRoZSByZXR1cm5lZCBvYmplY3QuCiAqLwpmdW5jdGlvbiBkcm9wVW5kZWZpbmVkS2V5cyhpbnB1dFZhbHVlKSB7CiAgLy8gVGhpcyBtYXAga2VlcHMgdHJhY2sgb2Ygd2hhdCBhbHJlYWR5IHZpc2l0ZWQgbm9kZXMgbWFwIHRvLgogIC8vIE91ciBTZXQgLSBiYXNlZCBtZW1vQnVpbGRlciBkb2Vzbid0IHdvcmsgaGVyZSBiZWNhdXNlIHdlIHdhbnQgdG8gdGhlIG91dHB1dCBvYmplY3QgdG8gaGF2ZSB0aGUgc2FtZSBjaXJjdWxhcgogIC8vIHJlZmVyZW5jZXMgYXMgdGhlIGlucHV0IG9iamVjdC4KICBjb25zdCBtZW1vaXphdGlvbk1hcCA9IG5ldyBNYXAoKTsKCiAgLy8gVGhpcyBmdW5jdGlvbiBqdXN0IHByb3hpZXMgYF9kcm9wVW5kZWZpbmVkS2V5c2AgdG8ga2VlcCB0aGUgYG1lbW9CdWlsZGVyYCBvdXQgb2YgdGhpcyBmdW5jdGlvbidzIEFQSQogIHJldHVybiBfZHJvcFVuZGVmaW5lZEtleXMoaW5wdXRWYWx1ZSwgbWVtb2l6YXRpb25NYXApOwp9CgpmdW5jdGlvbiBfZHJvcFVuZGVmaW5lZEtleXMoaW5wdXRWYWx1ZSwgbWVtb2l6YXRpb25NYXApIHsKICBpZiAoaXNQb2pvKGlucHV0VmFsdWUpKSB7CiAgICAvLyBJZiB0aGlzIG5vZGUgaGFzIGFscmVhZHkgYmVlbiB2aXNpdGVkIGR1ZSB0byBhIGNpcmN1bGFyIHJlZmVyZW5jZSwgcmV0dXJuIHRoZSBvYmplY3QgaXQgd2FzIG1hcHBlZCB0byBpbiB0aGUgbmV3IG9iamVjdAogICAgY29uc3QgbWVtb1ZhbCA9IG1lbW9pemF0aW9uTWFwLmdldChpbnB1dFZhbHVlKTsKICAgIGlmIChtZW1vVmFsICE9PSB1bmRlZmluZWQpIHsKICAgICAgcmV0dXJuIG1lbW9WYWwgOwogICAgfQoKICAgIGNvbnN0IHJldHVyblZhbHVlID0ge307CiAgICAvLyBTdG9yZSB0aGUgbWFwcGluZyBvZiB0aGlzIHZhbHVlIGluIGNhc2Ugd2UgdmlzaXQgaXQgYWdhaW4sIGluIGNhc2Ugb2YgY2lyY3VsYXIgZGF0YQogICAgbWVtb2l6YXRpb25NYXAuc2V0KGlucHV0VmFsdWUsIHJldHVyblZhbHVlKTsKCiAgICBmb3IgKGNvbnN0IGtleSBvZiBPYmplY3Qua2V5cyhpbnB1dFZhbHVlKSkgewogICAgICBpZiAodHlwZW9mIGlucHV0VmFsdWVba2V5XSAhPT0gJ3VuZGVmaW5lZCcpIHsKICAgICAgICByZXR1cm5WYWx1ZVtrZXldID0gX2Ryb3BVbmRlZmluZWRLZXlzKGlucHV0VmFsdWVba2V5XSwgbWVtb2l6YXRpb25NYXApOwogICAgICB9CiAgICB9CgogICAgcmV0dXJuIHJldHVyblZhbHVlIDsKICB9CgogIGlmIChBcnJheS5pc0FycmF5KGlucHV0VmFsdWUpKSB7CiAgICAvLyBJZiB0aGlzIG5vZGUgaGFzIGFscmVhZHkgYmVlbiB2aXNpdGVkIGR1ZSB0byBhIGNpcmN1bGFyIHJlZmVyZW5jZSwgcmV0dXJuIHRoZSBhcnJheSBpdCB3YXMgbWFwcGVkIHRvIGluIHRoZSBuZXcgb2JqZWN0CiAgICBjb25zdCBtZW1vVmFsID0gbWVtb2l6YXRpb25NYXAuZ2V0KGlucHV0VmFsdWUpOwogICAgaWYgKG1lbW9WYWwgIT09IHVuZGVmaW5lZCkgewogICAgICByZXR1cm4gbWVtb1ZhbCA7CiAgICB9CgogICAgY29uc3QgcmV0dXJuVmFsdWUgPSBbXTsKICAgIC8vIFN0b3JlIHRoZSBtYXBwaW5nIG9mIHRoaXMgdmFsdWUgaW4gY2FzZSB3ZSB2aXNpdCBpdCBhZ2FpbiwgaW4gY2FzZSBvZiBjaXJjdWxhciBkYXRhCiAgICBtZW1vaXphdGlvbk1hcC5zZXQoaW5wdXRWYWx1ZSwgcmV0dXJuVmFsdWUpOwoKICAgIGlucHV0VmFsdWUuZm9yRWFjaCgoaXRlbSkgPT4gewogICAgICByZXR1cm5WYWx1ZS5wdXNoKF9kcm9wVW5kZWZpbmVkS2V5cyhpdGVtLCBtZW1vaXphdGlvbk1hcCkpOwogICAgfSk7CgogICAgcmV0dXJuIHJldHVyblZhbHVlIDsKICB9CgogIHJldHVybiBpbnB1dFZhbHVlOwp9CgpmdW5jdGlvbiBpc1Bvam8oaW5wdXQpIHsKICBpZiAoIWlzUGxhaW5PYmplY3QoaW5wdXQpKSB7CiAgICByZXR1cm4gZmFsc2U7CiAgfQoKICB0cnkgewogICAgY29uc3QgbmFtZSA9IChPYmplY3QuZ2V0UHJvdG90eXBlT2YoaW5wdXQpICkuY29uc3RydWN0b3IubmFtZTsKICAgIHJldHVybiAhbmFtZSB8fCBuYW1lID09PSAnT2JqZWN0JzsKICB9IGNhdGNoIChlKSB7CiAgICByZXR1cm4gdHJ1ZTsKICB9Cn0KCi8qKgogKiBEb2VzIHRoaXMgZmlsZW5hbWUgbG9vayBsaWtlIGl0J3MgcGFydCBvZiB0aGUgYXBwIGNvZGU/CiAqLwpmdW5jdGlvbiBmaWxlbmFtZUlzSW5BcHAoZmlsZW5hbWUsIGlzTmF0aXZlID0gZmFsc2UpIHsKICBjb25zdCBpc0ludGVybmFsID0KICAgIGlzTmF0aXZlIHx8CiAgICAoZmlsZW5hbWUgJiYKICAgICAgLy8gSXQncyBub3QgaW50ZXJuYWwgaWYgaXQncyBhbiBhYnNvbHV0ZSBsaW51eCBwYXRoCiAgICAgICFmaWxlbmFtZS5zdGFydHNXaXRoKCcvJykgJiYKICAgICAgLy8gSXQncyBub3QgaW50ZXJuYWwgaWYgaXQncyBhbiBhYnNvbHV0ZSB3aW5kb3dzIHBhdGgKICAgICAgIWZpbGVuYW1lLm1hdGNoKC9eW0EtWl06LykgJiYKICAgICAgLy8gSXQncyBub3QgaW50ZXJuYWwgaWYgdGhlIHBhdGggaXMgc3RhcnRpbmcgd2l0aCBhIGRvdAogICAgICAhZmlsZW5hbWUuc3RhcnRzV2l0aCgnLicpICYmCiAgICAgIC8vIEl0J3Mgbm90IGludGVybmFsIGlmIHRoZSBmcmFtZSBoYXMgYSBwcm90b2NvbC4gSW4gbm9kZSwgdGhpcyBpcyB1c3VhbGx5IHRoZSBjYXNlIGlmIHRoZSBmaWxlIGdvdCBwcmUtcHJvY2Vzc2VkIHdpdGggYSBidW5kbGVyIGxpa2Ugd2VicGFjawogICAgICAhZmlsZW5hbWUubWF0Y2goL15bYS16QS1aXShbYS16QS1aMC05LlwtK10pKjpcL1wvLykpOyAvLyBTY2hlbWEgZnJvbTogaHR0cHM6Ly9zdGFja292ZXJmbG93LmNvbS9hLzM2NDE3ODIKCiAgLy8gaW5fYXBwIGlzIGFsbCB0aGF0J3Mgbm90IGFuIGludGVybmFsIE5vZGUgZnVuY3Rpb24gb3IgYSBtb2R1bGUgd2l0aGluIG5vZGVfbW9kdWxlcwogIC8vIG5vdGUgdGhhdCBpc05hdGl2ZSBhcHBlYXJzIHRvIHJldHVybiB0cnVlIGV2ZW4gZm9yIG5vZGUgY29yZSBsaWJyYXJpZXMKICAvLyBzZWUgaHR0cHM6Ly9naXRodWIuY29tL2dldHNlbnRyeS9yYXZlbi1ub2RlL2lzc3Vlcy8xNzYKCiAgcmV0dXJuICFpc0ludGVybmFsICYmIGZpbGVuYW1lICE9PSB1bmRlZmluZWQgJiYgIWZpbGVuYW1lLmluY2x1ZGVzKCdub2RlX21vZHVsZXMvJyk7Cn0KCmNvbnN0IFNUQUNLVFJBQ0VfRlJBTUVfTElNSVQgPSA1MDsKY29uc3QgU1RSSVBfRlJBTUVfUkVHRVhQID0gL2NhcHR1cmVNZXNzYWdlfGNhcHR1cmVFeGNlcHRpb24vOwoKLyoqCiAqIFJlbW92ZXMgU2VudHJ5IGZyYW1lcyBmcm9tIHRoZSB0b3AgYW5kIGJvdHRvbSBvZiB0aGUgc3RhY2sgaWYgcHJlc2VudCBhbmQgZW5mb3JjZXMgYSBsaW1pdCBvZiBtYXggbnVtYmVyIG9mIGZyYW1lcy4KICogQXNzdW1lcyBzdGFjayBpbnB1dCBpcyBvcmRlcmVkIGZyb20gdG9wIHRvIGJvdHRvbSBhbmQgcmV0dXJucyB0aGUgcmV2ZXJzZSByZXByZXNlbnRhdGlvbiBzbyBjYWxsIHNpdGUgb2YgdGhlCiAqIGZ1bmN0aW9uIHRoYXQgY2F1c2VkIHRoZSBjcmFzaCBpcyB0aGUgbGFzdCBmcmFtZSBpbiB0aGUgYXJyYXkuCiAqIEBoaWRkZW4KICovCmZ1bmN0aW9uIHN0cmlwU2VudHJ5RnJhbWVzQW5kUmV2ZXJzZShzdGFjaykgewogIGlmICghc3RhY2subGVuZ3RoKSB7CiAgICByZXR1cm4gW107CiAgfQoKICBjb25zdCBsb2NhbFN0YWNrID0gQXJyYXkuZnJvbShzdGFjayk7CgogIC8vIElmIHN0YWNrIHN0YXJ0cyB3aXRoIG9uZSBvZiBvdXIgQVBJIGNhbGxzLCByZW1vdmUgaXQgKHN0YXJ0cywgbWVhbmluZyBpdCdzIHRoZSB0b3Agb2YgdGhlIHN0YWNrIC0gYWthIGxhc3QgY2FsbCkKICBpZiAoL3NlbnRyeVdyYXBwZWQvLnRlc3QobG9jYWxTdGFja1tsb2NhbFN0YWNrLmxlbmd0aCAtIDFdLmZ1bmN0aW9uIHx8ICcnKSkgewogICAgbG9jYWxTdGFjay5wb3AoKTsKICB9CgogIC8vIFJldmVyc2luZyBpbiB0aGUgbWlkZGxlIG9mIHRoZSBwcm9jZWR1cmUgYWxsb3dzIHVzIHRvIGp1c3QgcG9wIHRoZSB2YWx1ZXMgb2ZmIHRoZSBzdGFjawogIGxvY2FsU3RhY2sucmV2ZXJzZSgpOwoKICAvLyBJZiBzdGFjayBlbmRzIHdpdGggb25lIG9mIG91ciBpbnRlcm5hbCBBUEkgY2FsbHMsIHJlbW92ZSBpdCAoZW5kcywgbWVhbmluZyBpdCdzIHRoZSBib3R0b20gb2YgdGhlIHN0YWNrIC0gYWthIHRvcC1tb3N0IGNhbGwpCiAgaWYgKFNUUklQX0ZSQU1FX1JFR0VYUC50ZXN0KGxvY2FsU3RhY2tbbG9jYWxTdGFjay5sZW5ndGggLSAxXS5mdW5jdGlvbiB8fCAnJykpIHsKICAgIGxvY2FsU3RhY2sucG9wKCk7CgogICAgLy8gV2hlbiB1c2luZyBzeW50aGV0aWMgZXZlbnRzLCB3ZSB3aWxsIGhhdmUgYSAyIGxldmVscyBkZWVwIHN0YWNrLCBhcyBgbmV3IEVycm9yKCdTZW50cnkgc3ludGhldGljRXhjZXB0aW9uJylgCiAgICAvLyBpcyBwcm9kdWNlZCB3aXRoaW4gdGhlIGh1YiBpdHNlbGYsIG1ha2luZyBpdDoKICAgIC8vCiAgICAvLyAgIFNlbnRyeS5jYXB0dXJlRXhjZXB0aW9uKCkKICAgIC8vICAgZ2V0Q3VycmVudEh1YigpLmNhcHR1cmVFeGNlcHRpb24oKQogICAgLy8KICAgIC8vIGluc3RlYWQgb2YganVzdCB0aGUgdG9wIGBTZW50cnlgIGNhbGwgaXRzZWxmLgogICAgLy8gVGhpcyBmb3JjZXMgdXMgdG8gcG9zc2libHkgc3RyaXAgYW4gYWRkaXRpb25hbCBmcmFtZSBpbiB0aGUgZXhhY3Qgc2FtZSB3YXMgYXMgYWJvdmUuCiAgICBpZiAoU1RSSVBfRlJBTUVfUkVHRVhQLnRlc3QobG9jYWxTdGFja1tsb2NhbFN0YWNrLmxlbmd0aCAtIDFdLmZ1bmN0aW9uIHx8ICcnKSkgewogICAgICBsb2NhbFN0YWNrLnBvcCgpOwogICAgfQogIH0KCiAgcmV0dXJuIGxvY2FsU3RhY2suc2xpY2UoMCwgU1RBQ0tUUkFDRV9GUkFNRV9MSU1JVCkubWFwKGZyYW1lID0+ICh7CiAgICAuLi5mcmFtZSwKICAgIGZpbGVuYW1lOiBmcmFtZS5maWxlbmFtZSB8fCBsb2NhbFN0YWNrW2xvY2FsU3RhY2subGVuZ3RoIC0gMV0uZmlsZW5hbWUsCiAgICBmdW5jdGlvbjogZnJhbWUuZnVuY3Rpb24gfHwgJz8nLAogIH0pKTsKfQoKY29uc3QgZGVmYXVsdEZ1bmN0aW9uTmFtZSA9ICc8YW5vbnltb3VzPic7CgovKioKICogU2FmZWx5IGV4dHJhY3QgZnVuY3Rpb24gbmFtZSBmcm9tIGl0c2VsZgogKi8KZnVuY3Rpb24gZ2V0RnVuY3Rpb25OYW1lKGZuKSB7CiAgdHJ5IHsKICAgIGlmICghZm4gfHwgdHlwZW9mIGZuICE9PSAnZnVuY3Rpb24nKSB7CiAgICAgIHJldHVybiBkZWZhdWx0RnVuY3Rpb25OYW1lOwogICAgfQogICAgcmV0dXJuIGZuLm5hbWUgfHwgZGVmYXVsdEZ1bmN0aW9uTmFtZTsKICB9IGNhdGNoIChlKSB7CiAgICAvLyBKdXN0IGFjY2Vzc2luZyBjdXN0b20gcHJvcHMgaW4gc29tZSBTZWxlbml1bSBlbnZpcm9ubWVudHMKICAgIC8vIGNhbiBjYXVzZSBhICJQZXJtaXNzaW9uIGRlbmllZCIgZXhjZXB0aW9uIChzZWUgcmF2ZW4tanMjNDk1KS4KICAgIHJldHVybiBkZWZhdWx0RnVuY3Rpb25OYW1lOwogIH0KfQoKLyoqCiAqIFVVSUQ0IGdlbmVyYXRvcgogKgogKiBAcmV0dXJucyBzdHJpbmcgR2VuZXJhdGVkIFVVSUQ0LgogKi8KZnVuY3Rpb24gdXVpZDQoKSB7CiAgY29uc3QgZ2JsID0gR0xPQkFMX09CSiA7CiAgY29uc3QgY3J5cHRvID0gZ2JsLmNyeXB0byB8fCBnYmwubXNDcnlwdG87CgogIGxldCBnZXRSYW5kb21CeXRlID0gKCkgPT4gTWF0aC5yYW5kb20oKSAqIDE2OwogIHRyeSB7CiAgICBpZiAoY3J5cHRvICYmIGNyeXB0by5yYW5kb21VVUlEKSB7CiAgICAgIHJldHVybiBjcnlwdG8ucmFuZG9tVVVJRCgpLnJlcGxhY2UoLy0vZywgJycpOwogICAgfQogICAgaWYgKGNyeXB0byAmJiBjcnlwdG8uZ2V0UmFuZG9tVmFsdWVzKSB7CiAgICAgIGdldFJhbmRvbUJ5dGUgPSAoKSA9PiB7CiAgICAgICAgLy8gY3J5cHRvLmdldFJhbmRvbVZhbHVlcyBtaWdodCByZXR1cm4gdW5kZWZpbmVkIGluc3RlYWQgb2YgdGhlIHR5cGVkIGFycmF5CiAgICAgICAgLy8gaW4gb2xkIENocm9taXVtIHZlcnNpb25zIChlLmcuIDIzLjAuMTIzNS4wICgxNTE0MjIpKQogICAgICAgIC8vIEhvd2V2ZXIsIGB0eXBlZEFycmF5YCBpcyBzdGlsbCBmaWxsZWQgaW4tcGxhY2UuCiAgICAgICAgLy8gQHNlZSBodHRwczovL2RldmVsb3Blci5tb3ppbGxhLm9yZy9lbi1VUy9kb2NzL1dlYi9BUEkvQ3J5cHRvL2dldFJhbmRvbVZhbHVlcyN0eXBlZGFycmF5CiAgICAgICAgY29uc3QgdHlwZWRBcnJheSA9IG5ldyBVaW50OEFycmF5KDEpOwogICAgICAgIGNyeXB0by5nZXRSYW5kb21WYWx1ZXModHlwZWRBcnJheSk7CiAgICAgICAgcmV0dXJuIHR5cGVkQXJyYXlbMF07CiAgICAgIH07CiAgICB9CiAgfSBjYXRjaCAoXykgewogICAgLy8gc29tZSBydW50aW1lcyBjYW4gY3Jhc2ggaW52b2tpbmcgY3J5cHRvCiAgICAvLyBodHRwczovL2dpdGh1Yi5jb20vZ2V0c2VudHJ5L3NlbnRyeS1qYXZhc2NyaXB0L2lzc3Vlcy84OTM1CiAgfQoKICAvLyBodHRwOi8vc3RhY2tvdmVyZmxvdy5jb20vcXVlc3Rpb25zLzEwNTAzNC9ob3ctdG8tY3JlYXRlLWEtZ3VpZC11dWlkLWluLWphdmFzY3JpcHQvMjExNzUyMyMyMTE3NTIzCiAgLy8gQ29uY2F0ZW5hdGluZyB0aGUgZm9sbG93aW5nIG51bWJlcnMgYXMgc3RyaW5ncyByZXN1bHRzIGluICcxMDAwMDAwMDEwMDA0MDAwODAwMDEwMDAwMDAwMDAwMCcKICByZXR1cm4gKChbMWU3XSApICsgMWUzICsgNGUzICsgOGUzICsgMWUxMSkucmVwbGFjZSgvWzAxOF0vZywgYyA9PgogICAgLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIG5vLWJpdHdpc2UKICAgICgoYyApIF4gKChnZXRSYW5kb21CeXRlKCkgJiAxNSkgPj4gKChjICkgLyA0KSkpLnRvU3RyaW5nKDE2KSwKICApOwp9CgovKioKICogQ2hlY2tzIHdoZXRoZXIgdGhlIGdpdmVuIGlucHV0IGlzIGFscmVhZHkgYW4gYXJyYXksIGFuZCBpZiBpdCBpc24ndCwgd3JhcHMgaXQgaW4gb25lLgogKgogKiBAcGFyYW0gbWF5YmVBcnJheSBJbnB1dCB0byB0dXJuIGludG8gYW4gYXJyYXksIGlmIG5lY2Vzc2FyeQogKiBAcmV0dXJucyBUaGUgaW5wdXQsIGlmIGFscmVhZHkgYW4gYXJyYXksIG9yIGFuIGFycmF5IHdpdGggdGhlIGlucHV0IGFzIHRoZSBvbmx5IGVsZW1lbnQsIGlmIG5vdAogKi8KZnVuY3Rpb24gYXJyYXlpZnkobWF5YmVBcnJheSkgewogIHJldHVybiBBcnJheS5pc0FycmF5KG1heWJlQXJyYXkpID8gbWF5YmVBcnJheSA6IFttYXliZUFycmF5XTsKfQoKLyogZXNsaW50LWRpc2FibGUgQHR5cGVzY3JpcHQtZXNsaW50L25vLXVuc2FmZS1tZW1iZXItYWNjZXNzICovCi8qIGVzbGludC1kaXNhYmxlIEB0eXBlc2NyaXB0LWVzbGludC9uby1leHBsaWNpdC1hbnkgKi8KCi8qKgogKiBIZWxwZXIgdG8gZGVjeWNsZSBqc29uIG9iamVjdHMKICovCmZ1bmN0aW9uIG1lbW9CdWlsZGVyKCkgewogIGNvbnN0IGhhc1dlYWtTZXQgPSB0eXBlb2YgV2Vha1NldCA9PT0gJ2Z1bmN0aW9uJzsKICBjb25zdCBpbm5lciA9IGhhc1dlYWtTZXQgPyBuZXcgV2Vha1NldCgpIDogW107CiAgZnVuY3Rpb24gbWVtb2l6ZShvYmopIHsKICAgIGlmIChoYXNXZWFrU2V0KSB7CiAgICAgIGlmIChpbm5lci5oYXMob2JqKSkgewogICAgICAgIHJldHVybiB0cnVlOwogICAgICB9CiAgICAgIGlubmVyLmFkZChvYmopOwogICAgICByZXR1cm4gZmFsc2U7CiAgICB9CiAgICAvLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgQHR5cGVzY3JpcHQtZXNsaW50L3ByZWZlci1mb3Itb2YKICAgIGZvciAobGV0IGkgPSAwOyBpIDwgaW5uZXIubGVuZ3RoOyBpKyspIHsKICAgICAgY29uc3QgdmFsdWUgPSBpbm5lcltpXTsKICAgICAgaWYgKHZhbHVlID09PSBvYmopIHsKICAgICAgICByZXR1cm4gdHJ1ZTsKICAgICAgfQogICAgfQogICAgaW5uZXIucHVzaChvYmopOwogICAgcmV0dXJuIGZhbHNlOwogIH0KCiAgZnVuY3Rpb24gdW5tZW1vaXplKG9iaikgewogICAgaWYgKGhhc1dlYWtTZXQpIHsKICAgICAgaW5uZXIuZGVsZXRlKG9iaik7CiAgICB9IGVsc2UgewogICAgICBmb3IgKGxldCBpID0gMDsgaSA8IGlubmVyLmxlbmd0aDsgaSsrKSB7CiAgICAgICAgaWYgKGlubmVyW2ldID09PSBvYmopIHsKICAgICAgICAgIGlubmVyLnNwbGljZShpLCAxKTsKICAgICAgICAgIGJyZWFrOwogICAgICAgIH0KICAgICAgfQogICAgfQogIH0KICByZXR1cm4gW21lbW9pemUsIHVubWVtb2l6ZV07Cn0KCi8qKgogKiBSZWN1cnNpdmVseSBub3JtYWxpemVzIHRoZSBnaXZlbiBvYmplY3QuCiAqCiAqIC0gQ3JlYXRlcyBhIGNvcHkgdG8gcHJldmVudCBvcmlnaW5hbCBpbnB1dCBtdXRhdGlvbgogKiAtIFNraXBzIG5vbi1lbnVtZXJhYmxlIHByb3BlcnRpZXMKICogLSBXaGVuIHN0cmluZ2lmeWluZywgY2FsbHMgYHRvSlNPTmAgaWYgaW1wbGVtZW50ZWQKICogLSBSZW1vdmVzIGNpcmN1bGFyIHJlZmVyZW5jZXMKICogLSBUcmFuc2xhdGVzIG5vbi1zZXJpYWxpemFibGUgdmFsdWVzIChgdW5kZWZpbmVkYC9gTmFOYC9mdW5jdGlvbnMpIHRvIHNlcmlhbGl6YWJsZSBmb3JtYXQKICogLSBUcmFuc2xhdGVzIGtub3duIGdsb2JhbCBvYmplY3RzL2NsYXNzZXMgdG8gYSBzdHJpbmcgcmVwcmVzZW50YXRpb25zCiAqIC0gVGFrZXMgY2FyZSBvZiBgRXJyb3JgIG9iamVjdCBzZXJpYWxpemF0aW9uCiAqIC0gT3B0aW9uYWxseSBsaW1pdHMgZGVwdGggb2YgZmluYWwgb3V0cHV0CiAqIC0gT3B0aW9uYWxseSBsaW1pdHMgbnVtYmVyIG9mIHByb3BlcnRpZXMvZWxlbWVudHMgaW5jbHVkZWQgaW4gYW55IHNpbmdsZSBvYmplY3QvYXJyYXkKICoKICogQHBhcmFtIGlucHV0IFRoZSBvYmplY3QgdG8gYmUgbm9ybWFsaXplZC4KICogQHBhcmFtIGRlcHRoIFRoZSBtYXggZGVwdGggdG8gd2hpY2ggdG8gbm9ybWFsaXplIHRoZSBvYmplY3QuIChBbnl0aGluZyBkZWVwZXIgc3RyaW5naWZpZWQgd2hvbGUuKQogKiBAcGFyYW0gbWF4UHJvcGVydGllcyBUaGUgbWF4IG51bWJlciBvZiBlbGVtZW50cyBvciBwcm9wZXJ0aWVzIHRvIGJlIGluY2x1ZGVkIGluIGFueSBzaW5nbGUgYXJyYXkgb3IKICogb2JqZWN0IGluIHRoZSBub3JtYWxsaXplZCBvdXRwdXQuCiAqIEByZXR1cm5zIEEgbm9ybWFsaXplZCB2ZXJzaW9uIG9mIHRoZSBvYmplY3QsIG9yIGAiKipub24tc2VyaWFsaXphYmxlKioiYCBpZiBhbnkgZXJyb3JzIGFyZSB0aHJvd24gZHVyaW5nIG5vcm1hbGl6YXRpb24uCiAqLwovLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgQHR5cGVzY3JpcHQtZXNsaW50L25vLWV4cGxpY2l0LWFueQpmdW5jdGlvbiBub3JtYWxpemUoaW5wdXQsIGRlcHRoID0gMTAwLCBtYXhQcm9wZXJ0aWVzID0gK0luZmluaXR5KSB7CiAgdHJ5IHsKICAgIC8vIHNpbmNlIHdlJ3JlIGF0IHRoZSBvdXRlcm1vc3QgbGV2ZWwsIHdlIGRvbid0IHByb3ZpZGUgYSBrZXkKICAgIHJldHVybiB2aXNpdCgnJywgaW5wdXQsIGRlcHRoLCBtYXhQcm9wZXJ0aWVzKTsKICB9IGNhdGNoIChlcnIpIHsKICAgIHJldHVybiB7IEVSUk9SOiBgKipub24tc2VyaWFsaXphYmxlKiogKCR7ZXJyfSlgIH07CiAgfQp9CgovKioKICogVmlzaXRzIGEgbm9kZSB0byBwZXJmb3JtIG5vcm1hbGl6YXRpb24gb24gaXQKICoKICogQHBhcmFtIGtleSBUaGUga2V5IGNvcnJlc3BvbmRpbmcgdG8gdGhlIGdpdmVuIG5vZGUKICogQHBhcmFtIHZhbHVlIFRoZSBub2RlIHRvIGJlIHZpc2l0ZWQKICogQHBhcmFtIGRlcHRoIE9wdGlvbmFsIG51bWJlciBpbmRpY2F0aW5nIHRoZSBtYXhpbXVtIHJlY3Vyc2lvbiBkZXB0aAogKiBAcGFyYW0gbWF4UHJvcGVydGllcyBPcHRpb25hbCBtYXhpbXVtIG51bWJlciBvZiBwcm9wZXJ0aWVzL2VsZW1lbnRzIGluY2x1ZGVkIGluIGFueSBzaW5nbGUgb2JqZWN0L2FycmF5CiAqIEBwYXJhbSBtZW1vIE9wdGlvbmFsIE1lbW8gY2xhc3MgaGFuZGxpbmcgZGVjeWNsaW5nCiAqLwpmdW5jdGlvbiB2aXNpdCgKICBrZXksCiAgdmFsdWUsCiAgZGVwdGggPSArSW5maW5pdHksCiAgbWF4UHJvcGVydGllcyA9ICtJbmZpbml0eSwKICBtZW1vID0gbWVtb0J1aWxkZXIoKSwKKSB7CiAgY29uc3QgW21lbW9pemUsIHVubWVtb2l6ZV0gPSBtZW1vOwoKICAvLyBHZXQgdGhlIHNpbXBsZSBjYXNlcyBvdXQgb2YgdGhlIHdheSBmaXJzdAogIGlmICgKICAgIHZhbHVlID09IG51bGwgfHwgLy8gdGhpcyBtYXRjaGVzIG51bGwgYW5kIHVuZGVmaW5lZCAtPiBlcWVxIG5vdCBlcWVxZXEKICAgIChbJ251bWJlcicsICdib29sZWFuJywgJ3N0cmluZyddLmluY2x1ZGVzKHR5cGVvZiB2YWx1ZSkgJiYgIWlzTmFOJDEodmFsdWUpKQogICkgewogICAgcmV0dXJuIHZhbHVlIDsKICB9CgogIGNvbnN0IHN0cmluZ2lmaWVkID0gc3RyaW5naWZ5VmFsdWUoa2V5LCB2YWx1ZSk7CgogIC8vIEFueXRoaW5nIHdlIGNvdWxkIHBvdGVudGlhbGx5IGRpZyBpbnRvIG1vcmUgKG9iamVjdHMgb3IgYXJyYXlzKSB3aWxsIGhhdmUgY29tZSBiYWNrIGFzIGAiW29iamVjdCBYWFhYXSJgLgogIC8vIEV2ZXJ5dGhpbmcgZWxzZSB3aWxsIGhhdmUgYWxyZWFkeSBiZWVuIHNlcmlhbGl6ZWQsIHNvIGlmIHdlIGRvbid0IHNlZSB0aGF0IHBhdHRlcm4sIHdlJ3JlIGRvbmUuCiAgaWYgKCFzdHJpbmdpZmllZC5zdGFydHNXaXRoKCdbb2JqZWN0ICcpKSB7CiAgICByZXR1cm4gc3RyaW5naWZpZWQ7CiAgfQoKICAvLyBGcm9tIGhlcmUgb24sIHdlIGNhbiBhc3NlcnQgdGhhdCBgdmFsdWVgIGlzIGVpdGhlciBhbiBvYmplY3Qgb3IgYW4gYXJyYXkuCgogIC8vIERvIG5vdCBub3JtYWxpemUgb2JqZWN0cyB0aGF0IHdlIGtub3cgaGF2ZSBhbHJlYWR5IGJlZW4gbm9ybWFsaXplZC4gQXMgYSBnZW5lcmFsIHJ1bGUsIHRoZQogIC8vICJfX3NlbnRyeV9za2lwX25vcm1hbGl6YXRpb25fXyIgcHJvcGVydHkgc2hvdWxkIG9ubHkgYmUgdXNlZCBzcGFyaW5nbHkgYW5kIG9ubHkgc2hvdWxkIG9ubHkgYmUgc2V0IG9uIG9iamVjdHMgdGhhdAogIC8vIGhhdmUgYWxyZWFkeSBiZWVuIG5vcm1hbGl6ZWQuCiAgaWYgKCh2YWx1ZSApWydfX3NlbnRyeV9za2lwX25vcm1hbGl6YXRpb25fXyddKSB7CiAgICByZXR1cm4gdmFsdWUgOwogIH0KCiAgLy8gV2UgY2FuIHNldCBgX19zZW50cnlfb3ZlcnJpZGVfbm9ybWFsaXphdGlvbl9kZXB0aF9fYCBvbiBhbiBvYmplY3QgdG8gZW5zdXJlIHRoYXQgZnJvbSB0aGVyZQogIC8vIFdlIGtlZXAgYSBjZXJ0YWluIGFtb3VudCBvZiBkZXB0aC4KICAvLyBUaGlzIHNob3VsZCBiZSB1c2VkIHNwYXJpbmdseSwgZS5nLiB3ZSB1c2UgaXQgZm9yIHRoZSByZWR1eCBpbnRlZ3JhdGlvbiB0byBlbnN1cmUgd2UgZ2V0IGEgY2VydGFpbiBhbW91bnQgb2Ygc3RhdGUuCiAgY29uc3QgcmVtYWluaW5nRGVwdGggPQogICAgdHlwZW9mICh2YWx1ZSApWydfX3NlbnRyeV9vdmVycmlkZV9ub3JtYWxpemF0aW9uX2RlcHRoX18nXSA9PT0gJ251bWJlcicKICAgICAgPyAoKHZhbHVlIClbJ19fc2VudHJ5X292ZXJyaWRlX25vcm1hbGl6YXRpb25fZGVwdGhfXyddICkKICAgICAgOiBkZXB0aDsKCiAgLy8gV2UncmUgYWxzbyBkb25lIGlmIHdlJ3ZlIHJlYWNoZWQgdGhlIG1heCBkZXB0aAogIGlmIChyZW1haW5pbmdEZXB0aCA9PT0gMCkgewogICAgLy8gQXQgdGhpcyBwb2ludCB3ZSBrbm93IGBzZXJpYWxpemVkYCBpcyBhIHN0cmluZyBvZiB0aGUgZm9ybSBgIltvYmplY3QgWFhYWF0iYC4gQ2xlYW4gaXQgdXAgc28gaXQncyBqdXN0IGAiW1hYWFhdImAuCiAgICByZXR1cm4gc3RyaW5naWZpZWQucmVwbGFjZSgnb2JqZWN0ICcsICcnKTsKICB9CgogIC8vIElmIHdlJ3ZlIGFscmVhZHkgdmlzaXRlZCB0aGlzIGJyYW5jaCwgYmFpbCBvdXQsIGFzIGl0J3MgY2lyY3VsYXIgcmVmZXJlbmNlLiBJZiBub3QsIG5vdGUgdGhhdCB3ZSdyZSBzZWVpbmcgaXQgbm93LgogIGlmIChtZW1vaXplKHZhbHVlKSkgewogICAgcmV0dXJuICdbQ2lyY3VsYXIgfl0nOwogIH0KCiAgLy8gSWYgdGhlIHZhbHVlIGhhcyBhIGB0b0pTT05gIG1ldGhvZCwgd2UgY2FsbCBpdCB0byBleHRyYWN0IG1vcmUgaW5mb3JtYXRpb24KICBjb25zdCB2YWx1ZVdpdGhUb0pTT04gPSB2YWx1ZSA7CiAgaWYgKHZhbHVlV2l0aFRvSlNPTiAmJiB0eXBlb2YgdmFsdWVXaXRoVG9KU09OLnRvSlNPTiA9PT0gJ2Z1bmN0aW9uJykgewogICAgdHJ5IHsKICAgICAgY29uc3QganNvblZhbHVlID0gdmFsdWVXaXRoVG9KU09OLnRvSlNPTigpOwogICAgICAvLyBXZSBuZWVkIHRvIG5vcm1hbGl6ZSB0aGUgcmV0dXJuIHZhbHVlIG9mIGAudG9KU09OKClgIGluIGNhc2UgaXQgaGFzIGNpcmN1bGFyIHJlZmVyZW5jZXMKICAgICAgcmV0dXJuIHZpc2l0KCcnLCBqc29uVmFsdWUsIHJlbWFpbmluZ0RlcHRoIC0gMSwgbWF4UHJvcGVydGllcywgbWVtbyk7CiAgICB9IGNhdGNoIChlcnIpIHsKICAgICAgLy8gcGFzcyAoVGhlIGJ1aWx0LWluIGB0b0pTT05gIGZhaWxlZCwgYnV0IHdlIGNhbiBzdGlsbCB0cnkgdG8gZG8gaXQgb3Vyc2VsdmVzKQogICAgfQogIH0KCiAgLy8gQXQgdGhpcyBwb2ludCB3ZSBrbm93IHdlIGVpdGhlciBoYXZlIGFuIG9iamVjdCBvciBhbiBhcnJheSwgd2UgaGF2ZW4ndCBzZWVuIGl0IGJlZm9yZSwgYW5kIHdlJ3JlIGdvaW5nIHRvIHJlY3Vyc2UKICAvLyBiZWNhdXNlIHdlIGhhdmVuJ3QgeWV0IHJlYWNoZWQgdGhlIG1heCBkZXB0aC4gQ3JlYXRlIGFuIGFjY3VtdWxhdG9yIHRvIGhvbGQgdGhlIHJlc3VsdHMgb2YgdmlzaXRpbmcgZWFjaAogIC8vIHByb3BlcnR5L2VudHJ5LCBhbmQga2VlcCB0cmFjayBvZiB0aGUgbnVtYmVyIG9mIGl0ZW1zIHdlIGFkZCB0byBpdC4KICBjb25zdCBub3JtYWxpemVkID0gKEFycmF5LmlzQXJyYXkodmFsdWUpID8gW10gOiB7fSkgOwogIGxldCBudW1BZGRlZCA9IDA7CgogIC8vIEJlZm9yZSB3ZSBiZWdpbiwgY29udmVydGBFcnJvcmAgYW5kYEV2ZW50YCBpbnN0YW5jZXMgaW50byBwbGFpbiBvYmplY3RzLCBzaW5jZSBzb21lIG9mIGVhY2ggb2YgdGhlaXIgcmVsZXZhbnQKICAvLyBwcm9wZXJ0aWVzIGFyZSBub24tZW51bWVyYWJsZSBhbmQgb3RoZXJ3aXNlIHdvdWxkIGdldCBtaXNzZWQuCiAgY29uc3QgdmlzaXRhYmxlID0gY29udmVydFRvUGxhaW5PYmplY3QodmFsdWUgKTsKCiAgZm9yIChjb25zdCB2aXNpdEtleSBpbiB2aXNpdGFibGUpIHsKICAgIC8vIEF2b2lkIGl0ZXJhdGluZyBvdmVyIGZpZWxkcyBpbiB0aGUgcHJvdG90eXBlIGlmIHRoZXkndmUgc29tZWhvdyBiZWVuIGV4cG9zZWQgdG8gZW51bWVyYXRpb24uCiAgICBpZiAoIU9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHkuY2FsbCh2aXNpdGFibGUsIHZpc2l0S2V5KSkgewogICAgICBjb250aW51ZTsKICAgIH0KCiAgICBpZiAobnVtQWRkZWQgPj0gbWF4UHJvcGVydGllcykgewogICAgICBub3JtYWxpemVkW3Zpc2l0S2V5XSA9ICdbTWF4UHJvcGVydGllcyB+XSc7CiAgICAgIGJyZWFrOwogICAgfQoKICAgIC8vIFJlY3Vyc2l2ZWx5IHZpc2l0IGFsbCB0aGUgY2hpbGQgbm9kZXMKICAgIGNvbnN0IHZpc2l0VmFsdWUgPSB2aXNpdGFibGVbdmlzaXRLZXldOwogICAgbm9ybWFsaXplZFt2aXNpdEtleV0gPSB2aXNpdCh2aXNpdEtleSwgdmlzaXRWYWx1ZSwgcmVtYWluaW5nRGVwdGggLSAxLCBtYXhQcm9wZXJ0aWVzLCBtZW1vKTsKCiAgICBudW1BZGRlZCsrOwogIH0KCiAgLy8gT25jZSB3ZSd2ZSB2aXNpdGVkIGFsbCB0aGUgYnJhbmNoZXMsIHJlbW92ZSB0aGUgcGFyZW50IGZyb20gbWVtbyBzdG9yYWdlCiAgdW5tZW1vaXplKHZhbHVlKTsKCiAgLy8gUmV0dXJuIGFjY3VtdWxhdGVkIHZhbHVlcwogIHJldHVybiBub3JtYWxpemVkOwp9CgovKiBlc2xpbnQtZGlzYWJsZSBjb21wbGV4aXR5ICovCi8qKgogKiBTdHJpbmdpZnkgdGhlIGdpdmVuIHZhbHVlLiBIYW5kbGVzIHZhcmlvdXMga25vd24gc3BlY2lhbCB2YWx1ZXMgYW5kIHR5cGVzLgogKgogKiBOb3QgbWVhbnQgdG8gYmUgdXNlZCBvbiBzaW1wbGUgcHJpbWl0aXZlcyB3aGljaCBhbHJlYWR5IGhhdmUgYSBzdHJpbmcgcmVwcmVzZW50YXRpb24sIGFzIGl0IHdpbGwsIGZvciBleGFtcGxlLCB0dXJuCiAqIHRoZSBudW1iZXIgMTIzMSBpbnRvICJbT2JqZWN0IE51bWJlcl0iLCBub3Igb24gYG51bGxgLCBhcyBpdCB3aWxsIHRocm93LgogKgogKiBAcGFyYW0gdmFsdWUgVGhlIHZhbHVlIHRvIHN0cmluZ2lmeQogKiBAcmV0dXJucyBBIHN0cmluZ2lmaWVkIHJlcHJlc2VudGF0aW9uIG9mIHRoZSBnaXZlbiB2YWx1ZQogKi8KZnVuY3Rpb24gc3RyaW5naWZ5VmFsdWUoCiAga2V5LAogIC8vIHRoaXMgdHlwZSBpcyBhIHRpbnkgYml0IG9mIGEgY2hlYXQsIHNpbmNlIHRoaXMgZnVuY3Rpb24gZG9lcyBoYW5kbGUgTmFOICh3aGljaCBpcyB0ZWNobmljYWxseSBhIG51bWJlciksIGJ1dCBmb3IKICAvLyBvdXIgaW50ZXJuYWwgdXNlLCBpdCdsbCBkbwogIHZhbHVlLAopIHsKICB0cnkgewogICAgaWYgKGtleSA9PT0gJ2RvbWFpbicgJiYgdmFsdWUgJiYgdHlwZW9mIHZhbHVlID09PSAnb2JqZWN0JyAmJiAodmFsdWUgKS5fZXZlbnRzKSB7CiAgICAgIHJldHVybiAnW0RvbWFpbl0nOwogICAgfQoKICAgIGlmIChrZXkgPT09ICdkb21haW5FbWl0dGVyJykgewogICAgICByZXR1cm4gJ1tEb21haW5FbWl0dGVyXSc7CiAgICB9CgogICAgLy8gSXQncyBzYWZlIHRvIHVzZSBgZ2xvYmFsYCwgYHdpbmRvd2AsIGFuZCBgZG9jdW1lbnRgIGhlcmUgaW4gdGhpcyBtYW5uZXIsIGFzIHdlIGFyZSBhc3NlcnRpbmcgdXNpbmcgYHR5cGVvZmAgZmlyc3QKICAgIC8vIHdoaWNoIHdvbid0IHRocm93IGlmIHRoZXkgYXJlIG5vdCBwcmVzZW50LgoKICAgIGlmICh0eXBlb2YgZ2xvYmFsICE9PSAndW5kZWZpbmVkJyAmJiB2YWx1ZSA9PT0gZ2xvYmFsKSB7CiAgICAgIHJldHVybiAnW0dsb2JhbF0nOwogICAgfQoKICAgIC8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBuby1yZXN0cmljdGVkLWdsb2JhbHMKICAgIGlmICh0eXBlb2Ygd2luZG93ICE9PSAndW5kZWZpbmVkJyAmJiB2YWx1ZSA9PT0gd2luZG93KSB7CiAgICAgIHJldHVybiAnW1dpbmRvd10nOwogICAgfQoKICAgIC8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBuby1yZXN0cmljdGVkLWdsb2JhbHMKICAgIGlmICh0eXBlb2YgZG9jdW1lbnQgIT09ICd1bmRlZmluZWQnICYmIHZhbHVlID09PSBkb2N1bWVudCkgewogICAgICByZXR1cm4gJ1tEb2N1bWVudF0nOwogICAgfQoKICAgIGlmIChpc1Z1ZVZpZXdNb2RlbCh2YWx1ZSkpIHsKICAgICAgcmV0dXJuICdbVnVlVmlld01vZGVsXSc7CiAgICB9CgogICAgLy8gUmVhY3QncyBTeW50aGV0aWNFdmVudCB0aGluZ3kKICAgIGlmIChpc1N5bnRoZXRpY0V2ZW50KHZhbHVlKSkgewogICAgICByZXR1cm4gJ1tTeW50aGV0aWNFdmVudF0nOwogICAgfQoKICAgIGlmICh0eXBlb2YgdmFsdWUgPT09ICdudW1iZXInICYmIHZhbHVlICE9PSB2YWx1ZSkgewogICAgICByZXR1cm4gJ1tOYU5dJzsKICAgIH0KCiAgICBpZiAodHlwZW9mIHZhbHVlID09PSAnZnVuY3Rpb24nKSB7CiAgICAgIHJldHVybiBgW0Z1bmN0aW9uOiAke2dldEZ1bmN0aW9uTmFtZSh2YWx1ZSl9XWA7CiAgICB9CgogICAgaWYgKHR5cGVvZiB2YWx1ZSA9PT0gJ3N5bWJvbCcpIHsKICAgICAgcmV0dXJuIGBbJHtTdHJpbmcodmFsdWUpfV1gOwogICAgfQoKICAgIC8vIHN0cmluZ2lmaWVkIEJpZ0ludHMgYXJlIGluZGlzdGluZ3Vpc2hhYmxlIGZyb20gcmVndWxhciBudW1iZXJzLCBzbyB3ZSBuZWVkIHRvIGxhYmVsIHRoZW0gdG8gYXZvaWQgY29uZnVzaW9uCiAgICBpZiAodHlwZW9mIHZhbHVlID09PSAnYmlnaW50JykgewogICAgICByZXR1cm4gYFtCaWdJbnQ6ICR7U3RyaW5nKHZhbHVlKX1dYDsKICAgIH0KCiAgICAvLyBOb3cgdGhhdCB3ZSd2ZSBrbm9ja2VkIG91dCBhbGwgdGhlIHNwZWNpYWwgY2FzZXMgYW5kIHRoZSBwcmltaXRpdmVzLCBhbGwgd2UgaGF2ZSBsZWZ0IGFyZSBvYmplY3RzLiBTaW1wbHkgY2FzdGluZwogICAgLy8gdGhlbSB0byBzdHJpbmdzIG1lYW5zIHRoYXQgaW5zdGFuY2VzIG9mIGNsYXNzZXMgd2hpY2ggaGF2ZW4ndCBkZWZpbmVkIHRoZWlyIGB0b1N0cmluZ1RhZ2Agd2lsbCBqdXN0IGNvbWUgb3V0IGFzCiAgICAvLyBgIltvYmplY3QgT2JqZWN0XSJgLiBJZiB3ZSBpbnN0ZWFkIGxvb2sgYXQgdGhlIGNvbnN0cnVjdG9yJ3MgbmFtZSAod2hpY2ggaXMgdGhlIHNhbWUgYXMgdGhlIG5hbWUgb2YgdGhlIGNsYXNzKSwKICAgIC8vIHdlIGNhbiBtYWtlIHN1cmUgdGhhdCBvbmx5IHBsYWluIG9iamVjdHMgY29tZSBvdXQgdGhhdCB3YXkuCiAgICBjb25zdCBvYmpOYW1lID0gZ2V0Q29uc3RydWN0b3JOYW1lKHZhbHVlKTsKCiAgICAvLyBIYW5kbGUgSFRNTCBFbGVtZW50cwogICAgaWYgKC9eSFRNTChcdyopRWxlbWVudCQvLnRlc3Qob2JqTmFtZSkpIHsKICAgICAgcmV0dXJuIGBbSFRNTEVsZW1lbnQ6ICR7b2JqTmFtZX1dYDsKICAgIH0KCiAgICByZXR1cm4gYFtvYmplY3QgJHtvYmpOYW1lfV1gOwogIH0gY2F0Y2ggKGVycikgewogICAgcmV0dXJuIGAqKm5vbi1zZXJpYWxpemFibGUqKiAoJHtlcnJ9KWA7CiAgfQp9Ci8qIGVzbGludC1lbmFibGUgY29tcGxleGl0eSAqLwoKZnVuY3Rpb24gZ2V0Q29uc3RydWN0b3JOYW1lKHZhbHVlKSB7CiAgY29uc3QgcHJvdG90eXBlID0gT2JqZWN0LmdldFByb3RvdHlwZU9mKHZhbHVlKTsKCiAgcmV0dXJuIHByb3RvdHlwZSA/IHByb3RvdHlwZS5jb25zdHJ1Y3Rvci5uYW1lIDogJ251bGwgcHJvdG90eXBlJzsKfQoKLyoqCiAqIE5vcm1hbGl6ZXMgVVJMcyBpbiBleGNlcHRpb25zIGFuZCBzdGFja3RyYWNlcyB0byBhIGJhc2UgcGF0aCBzbyBTZW50cnkgY2FuIGZpbmdlcnByaW50CiAqIGFjcm9zcyBwbGF0Zm9ybXMgYW5kIHdvcmtpbmcgZGlyZWN0b3J5LgogKgogKiBAcGFyYW0gdXJsIFRoZSBVUkwgdG8gYmUgbm9ybWFsaXplZC4KICogQHBhcmFtIGJhc2VQYXRoIFRoZSBhcHBsaWNhdGlvbiBiYXNlIHBhdGguCiAqIEByZXR1cm5zIFRoZSBub3JtYWxpemVkIFVSTC4KICovCmZ1bmN0aW9uIG5vcm1hbGl6ZVVybFRvQmFzZSh1cmwsIGJhc2VQYXRoKSB7CiAgY29uc3QgZXNjYXBlZEJhc2UgPSBiYXNlUGF0aAogICAgLy8gQmFja3NsYXNoIHRvIGZvcndhcmQKICAgIC5yZXBsYWNlKC9cXC9nLCAnLycpCiAgICAvLyBFc2NhcGUgUmVnRXhwIHNwZWNpYWwgY2hhcmFjdGVycwogICAgLnJlcGxhY2UoL1t8XFx7fSgpW1xdXiQrKj8uXS9nLCAnXFwkJicpOwoKICBsZXQgbmV3VXJsID0gdXJsOwogIHRyeSB7CiAgICBuZXdVcmwgPSBkZWNvZGVVUkkodXJsKTsKICB9IGNhdGNoIChfT28pIHsKICAgIC8vIFNvbWV0aW1lIHRoaXMgYnJlYWtzCiAgfQogIHJldHVybiAoCiAgICBuZXdVcmwKICAgICAgLnJlcGxhY2UoL1xcL2csICcvJykKICAgICAgLnJlcGxhY2UoL3dlYnBhY2s6XC8/L2csICcnKSAvLyBSZW1vdmUgaW50ZXJtZWRpYXRlIGJhc2UgcGF0aAogICAgICAvLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgQHNlbnRyeS1pbnRlcm5hbC9zZGsvbm8tcmVnZXhwLWNvbnN0cnVjdG9yCiAgICAgIC5yZXBsYWNlKG5ldyBSZWdFeHAoYChmaWxlOi8vKT8vKiR7ZXNjYXBlZEJhc2V9LypgLCAnaWcnKSwgJ2FwcDovLy8nKQogICk7Cn0KCi8vIFNsaWdodGx5IG1vZGlmaWVkIChubyBJRTggc3VwcG9ydCwgRVM2KSBhbmQgdHJhbnNjcmliZWQgdG8gVHlwZVNjcmlwdAoKLy8gU3BsaXQgYSBmaWxlbmFtZSBpbnRvIFtyb290LCBkaXIsIGJhc2VuYW1lLCBleHRdLCB1bml4IHZlcnNpb24KLy8gJ3Jvb3QnIGlzIGp1c3QgYSBzbGFzaCwgb3Igbm90aGluZy4KY29uc3Qgc3BsaXRQYXRoUmUgPSAvXihcUys6XFx8XC8/KShbXHNcU10qPykoKD86XC57MSwyfXxbXi9cXF0rP3wpKFwuW14uL1xcXSp8KSkoPzpbL1xcXSopJC87Ci8qKiBKU0RvYyAqLwpmdW5jdGlvbiBzcGxpdFBhdGgoZmlsZW5hbWUpIHsKICAvLyBUcnVuY2F0ZSBmaWxlcyBuYW1lcyBncmVhdGVyIHRoYW4gMTAyNCBjaGFyYWN0ZXJzIHRvIGF2b2lkIHJlZ2V4IGRvcwogIC8vIGh0dHBzOi8vZ2l0aHViLmNvbS9nZXRzZW50cnkvc2VudHJ5LWphdmFzY3JpcHQvcHVsbC84NzM3I2Rpc2N1c3Npb25fcjEyODU3MTkxNzIKICBjb25zdCB0cnVuY2F0ZWQgPSBmaWxlbmFtZS5sZW5ndGggPiAxMDI0ID8gYDx0cnVuY2F0ZWQ+JHtmaWxlbmFtZS5zbGljZSgtMTAyNCl9YCA6IGZpbGVuYW1lOwogIGNvbnN0IHBhcnRzID0gc3BsaXRQYXRoUmUuZXhlYyh0cnVuY2F0ZWQpOwogIHJldHVybiBwYXJ0cyA/IHBhcnRzLnNsaWNlKDEpIDogW107Cn0KCi8qKiBKU0RvYyAqLwpmdW5jdGlvbiBkaXJuYW1lKHBhdGgpIHsKICBjb25zdCByZXN1bHQgPSBzcGxpdFBhdGgocGF0aCk7CiAgY29uc3Qgcm9vdCA9IHJlc3VsdFswXTsKICBsZXQgZGlyID0gcmVzdWx0WzFdOwoKICBpZiAoIXJvb3QgJiYgIWRpcikgewogICAgLy8gTm8gZGlybmFtZSB3aGF0c29ldmVyCiAgICByZXR1cm4gJy4nOwogIH0KCiAgaWYgKGRpcikgewogICAgLy8gSXQgaGFzIGEgZGlybmFtZSwgc3RyaXAgdHJhaWxpbmcgc2xhc2gKICAgIGRpciA9IGRpci5zbGljZSgwLCBkaXIubGVuZ3RoIC0gMSk7CiAgfQoKICByZXR1cm4gcm9vdCArIGRpcjsKfQoKLyogZXNsaW50LWRpc2FibGUgQHR5cGVzY3JpcHQtZXNsaW50L2V4cGxpY2l0LWZ1bmN0aW9uLXJldHVybi10eXBlICovCgovKiogU3luY1Byb21pc2UgaW50ZXJuYWwgc3RhdGVzICovCnZhciBTdGF0ZXM7IChmdW5jdGlvbiAoU3RhdGVzKSB7CiAgLyoqIFBlbmRpbmcgKi8KICBjb25zdCBQRU5ESU5HID0gMDsgU3RhdGVzW1N0YXRlc1siUEVORElORyJdID0gUEVORElOR10gPSAiUEVORElORyI7CiAgLyoqIFJlc29sdmVkIC8gT0sgKi8KICBjb25zdCBSRVNPTFZFRCA9IDE7IFN0YXRlc1tTdGF0ZXNbIlJFU09MVkVEIl0gPSBSRVNPTFZFRF0gPSAiUkVTT0xWRUQiOwogIC8qKiBSZWplY3RlZCAvIEVycm9yICovCiAgY29uc3QgUkVKRUNURUQgPSAyOyBTdGF0ZXNbU3RhdGVzWyJSRUpFQ1RFRCJdID0gUkVKRUNURURdID0gIlJFSkVDVEVEIjsKfSkoU3RhdGVzIHx8IChTdGF0ZXMgPSB7fSkpOwoKLy8gT3ZlcmxvYWRzIHNvIHdlIGNhbiBjYWxsIHJlc29sdmVkU3luY1Byb21pc2Ugd2l0aG91dCBhcmd1bWVudHMgYW5kIGdlbmVyaWMgYXJndW1lbnQKCi8qKgogKiBDcmVhdGVzIGEgcmVzb2x2ZWQgc3luYyBwcm9taXNlLgogKgogKiBAcGFyYW0gdmFsdWUgdGhlIHZhbHVlIHRvIHJlc29sdmUgdGhlIHByb21pc2Ugd2l0aAogKiBAcmV0dXJucyB0aGUgcmVzb2x2ZWQgc3luYyBwcm9taXNlCiAqLwpmdW5jdGlvbiByZXNvbHZlZFN5bmNQcm9taXNlKHZhbHVlKSB7CiAgcmV0dXJuIG5ldyBTeW5jUHJvbWlzZShyZXNvbHZlID0+IHsKICAgIHJlc29sdmUodmFsdWUpOwogIH0pOwp9CgovKioKICogQ3JlYXRlcyBhIHJlamVjdGVkIHN5bmMgcHJvbWlzZS4KICoKICogQHBhcmFtIHZhbHVlIHRoZSB2YWx1ZSB0byByZWplY3QgdGhlIHByb21pc2Ugd2l0aAogKiBAcmV0dXJucyB0aGUgcmVqZWN0ZWQgc3luYyBwcm9taXNlCiAqLwpmdW5jdGlvbiByZWplY3RlZFN5bmNQcm9taXNlKHJlYXNvbikgewogIHJldHVybiBuZXcgU3luY1Byb21pc2UoKF8sIHJlamVjdCkgPT4gewogICAgcmVqZWN0KHJlYXNvbik7CiAgfSk7Cn0KCi8qKgogKiBUaGVuYWJsZSBjbGFzcyB0aGF0IGJlaGF2ZXMgbGlrZSBhIFByb21pc2UgYW5kIGZvbGxvd3MgaXQncyBpbnRlcmZhY2UKICogYnV0IGlzIG5vdCBhc3luYyBpbnRlcm5hbGx5CiAqLwpjbGFzcyBTeW5jUHJvbWlzZSB7CgogICBjb25zdHJ1Y3RvcigKICAgIGV4ZWN1dG9yLAogICkge1N5bmNQcm9taXNlLnByb3RvdHlwZS5fX2luaXQuY2FsbCh0aGlzKTtTeW5jUHJvbWlzZS5wcm90b3R5cGUuX19pbml0Mi5jYWxsKHRoaXMpO1N5bmNQcm9taXNlLnByb3RvdHlwZS5fX2luaXQzLmNhbGwodGhpcyk7U3luY1Byb21pc2UucHJvdG90eXBlLl9faW5pdDQuY2FsbCh0aGlzKTsKICAgIHRoaXMuX3N0YXRlID0gU3RhdGVzLlBFTkRJTkc7CiAgICB0aGlzLl9oYW5kbGVycyA9IFtdOwoKICAgIHRyeSB7CiAgICAgIGV4ZWN1dG9yKHRoaXMuX3Jlc29sdmUsIHRoaXMuX3JlamVjdCk7CiAgICB9IGNhdGNoIChlKSB7CiAgICAgIHRoaXMuX3JlamVjdChlKTsKICAgIH0KICB9CgogIC8qKiBKU0RvYyAqLwogICB0aGVuKAogICAgb25mdWxmaWxsZWQsCiAgICBvbnJlamVjdGVkLAogICkgewogICAgcmV0dXJuIG5ldyBTeW5jUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB7CiAgICAgIHRoaXMuX2hhbmRsZXJzLnB1c2goWwogICAgICAgIGZhbHNlLAogICAgICAgIHJlc3VsdCA9PiB7CiAgICAgICAgICBpZiAoIW9uZnVsZmlsbGVkKSB7CiAgICAgICAgICAgIC8vIFRPRE86IMKvXF8o44OEKV8vwq8KICAgICAgICAgICAgLy8gVE9ETzogRklYTUUKICAgICAgICAgICAgcmVzb2x2ZShyZXN1bHQgKTsKICAgICAgICAgIH0gZWxzZSB7CiAgICAgICAgICAgIHRyeSB7CiAgICAgICAgICAgICAgcmVzb2x2ZShvbmZ1bGZpbGxlZChyZXN1bHQpKTsKICAgICAgICAgICAgfSBjYXRjaCAoZSkgewogICAgICAgICAgICAgIHJlamVjdChlKTsKICAgICAgICAgICAgfQogICAgICAgICAgfQogICAgICAgIH0sCiAgICAgICAgcmVhc29uID0+IHsKICAgICAgICAgIGlmICghb25yZWplY3RlZCkgewogICAgICAgICAgICByZWplY3QocmVhc29uKTsKICAgICAgICAgIH0gZWxzZSB7CiAgICAgICAgICAgIHRyeSB7CiAgICAgICAgICAgICAgcmVzb2x2ZShvbnJlamVjdGVkKHJlYXNvbikpOwogICAgICAgICAgICB9IGNhdGNoIChlKSB7CiAgICAgICAgICAgICAgcmVqZWN0KGUpOwogICAgICAgICAgICB9CiAgICAgICAgICB9CiAgICAgICAgfSwKICAgICAgXSk7CiAgICAgIHRoaXMuX2V4ZWN1dGVIYW5kbGVycygpOwogICAgfSk7CiAgfQoKICAvKiogSlNEb2MgKi8KICAgY2F0Y2goCiAgICBvbnJlamVjdGVkLAogICkgewogICAgcmV0dXJuIHRoaXMudGhlbih2YWwgPT4gdmFsLCBvbnJlamVjdGVkKTsKICB9CgogIC8qKiBKU0RvYyAqLwogICBmaW5hbGx5KG9uZmluYWxseSkgewogICAgcmV0dXJuIG5ldyBTeW5jUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB7CiAgICAgIGxldCB2YWw7CiAgICAgIGxldCBpc1JlamVjdGVkOwoKICAgICAgcmV0dXJuIHRoaXMudGhlbigKICAgICAgICB2YWx1ZSA9PiB7CiAgICAgICAgICBpc1JlamVjdGVkID0gZmFsc2U7CiAgICAgICAgICB2YWwgPSB2YWx1ZTsKICAgICAgICAgIGlmIChvbmZpbmFsbHkpIHsKICAgICAgICAgICAgb25maW5hbGx5KCk7CiAgICAgICAgICB9CiAgICAgICAgfSwKICAgICAgICByZWFzb24gPT4gewogICAgICAgICAgaXNSZWplY3RlZCA9IHRydWU7CiAgICAgICAgICB2YWwgPSByZWFzb247CiAgICAgICAgICBpZiAob25maW5hbGx5KSB7CiAgICAgICAgICAgIG9uZmluYWxseSgpOwogICAgICAgICAgfQogICAgICAgIH0sCiAgICAgICkudGhlbigoKSA9PiB7CiAgICAgICAgaWYgKGlzUmVqZWN0ZWQpIHsKICAgICAgICAgIHJlamVjdCh2YWwpOwogICAgICAgICAgcmV0dXJuOwogICAgICAgIH0KCiAgICAgICAgcmVzb2x2ZSh2YWwgKTsKICAgICAgfSk7CiAgICB9KTsKICB9CgogIC8qKiBKU0RvYyAqLwogICAgX19pbml0KCkge3RoaXMuX3Jlc29sdmUgPSAodmFsdWUpID0+IHsKICAgIHRoaXMuX3NldFJlc3VsdChTdGF0ZXMuUkVTT0xWRUQsIHZhbHVlKTsKICB9O30KCiAgLyoqIEpTRG9jICovCiAgICBfX2luaXQyKCkge3RoaXMuX3JlamVjdCA9IChyZWFzb24pID0+IHsKICAgIHRoaXMuX3NldFJlc3VsdChTdGF0ZXMuUkVKRUNURUQsIHJlYXNvbik7CiAgfTt9CgogIC8qKiBKU0RvYyAqLwogICAgX19pbml0MygpIHt0aGlzLl9zZXRSZXN1bHQgPSAoc3RhdGUsIHZhbHVlKSA9PiB7CiAgICBpZiAodGhpcy5fc3RhdGUgIT09IFN0YXRlcy5QRU5ESU5HKSB7CiAgICAgIHJldHVybjsKICAgIH0KCiAgICBpZiAoaXNUaGVuYWJsZSh2YWx1ZSkpIHsKICAgICAgdm9pZCAodmFsdWUgKS50aGVuKHRoaXMuX3Jlc29sdmUsIHRoaXMuX3JlamVjdCk7CiAgICAgIHJldHVybjsKICAgIH0KCiAgICB0aGlzLl9zdGF0ZSA9IHN0YXRlOwogICAgdGhpcy5fdmFsdWUgPSB2YWx1ZTsKCiAgICB0aGlzLl9leGVjdXRlSGFuZGxlcnMoKTsKICB9O30KCiAgLyoqIEpTRG9jICovCiAgICBfX2luaXQ0KCkge3RoaXMuX2V4ZWN1dGVIYW5kbGVycyA9ICgpID0+IHsKICAgIGlmICh0aGlzLl9zdGF0ZSA9PT0gU3RhdGVzLlBFTkRJTkcpIHsKICAgICAgcmV0dXJuOwogICAgfQoKICAgIGNvbnN0IGNhY2hlZEhhbmRsZXJzID0gdGhpcy5faGFuZGxlcnMuc2xpY2UoKTsKICAgIHRoaXMuX2hhbmRsZXJzID0gW107CgogICAgY2FjaGVkSGFuZGxlcnMuZm9yRWFjaChoYW5kbGVyID0+IHsKICAgICAgaWYgKGhhbmRsZXJbMF0pIHsKICAgICAgICByZXR1cm47CiAgICAgIH0KCiAgICAgIGlmICh0aGlzLl9zdGF0ZSA9PT0gU3RhdGVzLlJFU09MVkVEKSB7CiAgICAgICAgLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIEB0eXBlc2NyaXB0LWVzbGludC9uby1mbG9hdGluZy1wcm9taXNlcwogICAgICAgIGhhbmRsZXJbMV0odGhpcy5fdmFsdWUgKTsKICAgICAgfQoKICAgICAgaWYgKHRoaXMuX3N0YXRlID09PSBTdGF0ZXMuUkVKRUNURUQpIHsKICAgICAgICBoYW5kbGVyWzJdKHRoaXMuX3ZhbHVlKTsKICAgICAgfQoKICAgICAgaGFuZGxlclswXSA9IHRydWU7CiAgICB9KTsKICB9O30KfQoKLyoqCiAqIENyZWF0ZXMgYW4gbmV3IFByb21pc2VCdWZmZXIgb2JqZWN0IHdpdGggdGhlIHNwZWNpZmllZCBsaW1pdAogKiBAcGFyYW0gbGltaXQgbWF4IG51bWJlciBvZiBwcm9taXNlcyB0aGF0IGNhbiBiZSBzdG9yZWQgaW4gdGhlIGJ1ZmZlcgogKi8KZnVuY3Rpb24gbWFrZVByb21pc2VCdWZmZXIobGltaXQpIHsKICBjb25zdCBidWZmZXIgPSBbXTsKCiAgZnVuY3Rpb24gaXNSZWFkeSgpIHsKICAgIHJldHVybiBsaW1pdCA9PT0gdW5kZWZpbmVkIHx8IGJ1ZmZlci5sZW5ndGggPCBsaW1pdDsKICB9CgogIC8qKgogICAqIFJlbW92ZSBhIHByb21pc2UgZnJvbSB0aGUgcXVldWUuCiAgICoKICAgKiBAcGFyYW0gdGFzayBDYW4gYmUgYW55IFByb21pc2VMaWtlPFQ+CiAgICogQHJldHVybnMgUmVtb3ZlZCBwcm9taXNlLgogICAqLwogIGZ1bmN0aW9uIHJlbW92ZSh0YXNrKSB7CiAgICByZXR1cm4gYnVmZmVyLnNwbGljZShidWZmZXIuaW5kZXhPZih0YXNrKSwgMSlbMF07CiAgfQoKICAvKioKICAgKiBBZGQgYSBwcm9taXNlIChyZXByZXNlbnRpbmcgYW4gaW4tZmxpZ2h0IGFjdGlvbikgdG8gdGhlIHF1ZXVlLCBhbmQgc2V0IGl0IHRvIHJlbW92ZSBpdHNlbGYgb24gZnVsZmlsbG1lbnQuCiAgICoKICAgKiBAcGFyYW0gdGFza1Byb2R1Y2VyIEEgZnVuY3Rpb24gcHJvZHVjaW5nIGFueSBQcm9taXNlTGlrZTxUPjsgSW4gcHJldmlvdXMgdmVyc2lvbnMgdGhpcyB1c2VkIHRvIGJlIGB0YXNrOgogICAqICAgICAgICBQcm9taXNlTGlrZTxUPmAsIGJ1dCB1bmRlciB0aGF0IG1vZGVsLCBQcm9taXNlcyB3ZXJlIGluc3RhbnRseSBjcmVhdGVkIG9uIHRoZSBjYWxsLXNpdGUgYW5kIHRoZWlyIGV4ZWN1dG9yCiAgICogICAgICAgIGZ1bmN0aW9ucyB0aGVyZWZvcmUgcmFuIGltbWVkaWF0ZWx5LiBUaHVzLCBldmVuIGlmIHRoZSBidWZmZXIgd2FzIGZ1bGwsIHRoZSBhY3Rpb24gc3RpbGwgaGFwcGVuZWQuIEJ5CiAgICogICAgICAgIHJlcXVpcmluZyB0aGUgcHJvbWlzZSB0byBiZSB3cmFwcGVkIGluIGEgZnVuY3Rpb24sIHdlIGNhbiBkZWZlciBwcm9taXNlIGNyZWF0aW9uIHVudGlsIGFmdGVyIHRoZSBidWZmZXIKICAgKiAgICAgICAgbGltaXQgY2hlY2suCiAgICogQHJldHVybnMgVGhlIG9yaWdpbmFsIHByb21pc2UuCiAgICovCiAgZnVuY3Rpb24gYWRkKHRhc2tQcm9kdWNlcikgewogICAgaWYgKCFpc1JlYWR5KCkpIHsKICAgICAgcmV0dXJuIHJlamVjdGVkU3luY1Byb21pc2UobmV3IFNlbnRyeUVycm9yKCdOb3QgYWRkaW5nIFByb21pc2UgYmVjYXVzZSBidWZmZXIgbGltaXQgd2FzIHJlYWNoZWQuJykpOwogICAgfQoKICAgIC8vIHN0YXJ0IHRoZSB0YXNrIGFuZCBhZGQgaXRzIHByb21pc2UgdG8gdGhlIHF1ZXVlCiAgICBjb25zdCB0YXNrID0gdGFza1Byb2R1Y2VyKCk7CiAgICBpZiAoYnVmZmVyLmluZGV4T2YodGFzaykgPT09IC0xKSB7CiAgICAgIGJ1ZmZlci5wdXNoKHRhc2spOwogICAgfQogICAgdm9pZCB0YXNrCiAgICAgIC50aGVuKCgpID0+IHJlbW92ZSh0YXNrKSkKICAgICAgLy8gVXNlIGB0aGVuKG51bGwsIHJlamVjdGlvbkhhbmRsZXIpYCByYXRoZXIgdGhhbiBgY2F0Y2gocmVqZWN0aW9uSGFuZGxlcilgIHNvIHRoYXQgd2UgY2FuIHVzZSBgUHJvbWlzZUxpa2VgCiAgICAgIC8vIHJhdGhlciB0aGFuIGBQcm9taXNlYC4gYFByb21pc2VMaWtlYCBkb2Vzbid0IGhhdmUgYSBgLmNhdGNoYCBtZXRob2QsIG1ha2luZyBpdHMgcG9seWZpbGwgc21hbGxlci4gKEVTNSBkaWRuJ3QKICAgICAgLy8gaGF2ZSBwcm9taXNlcywgc28gVFMgaGFzIHRvIHBvbHlmaWxsIHdoZW4gZG93bi1jb21waWxpbmcuKQogICAgICAudGhlbihudWxsLCAoKSA9PgogICAgICAgIHJlbW92ZSh0YXNrKS50aGVuKG51bGwsICgpID0+IHsKICAgICAgICAgIC8vIFdlIGhhdmUgdG8gYWRkIGFub3RoZXIgY2F0Y2ggaGVyZSBiZWNhdXNlIGByZW1vdmUoKWAgc3RhcnRzIGEgbmV3IHByb21pc2UgY2hhaW4uCiAgICAgICAgfSksCiAgICAgICk7CiAgICByZXR1cm4gdGFzazsKICB9CgogIC8qKgogICAqIFdhaXQgZm9yIGFsbCBwcm9taXNlcyBpbiB0aGUgcXVldWUgdG8gcmVzb2x2ZSBvciBmb3IgdGltZW91dCB0byBleHBpcmUsIHdoaWNoZXZlciBjb21lcyBmaXJzdC4KICAgKgogICAqIEBwYXJhbSB0aW1lb3V0IFRoZSB0aW1lLCBpbiBtcywgYWZ0ZXIgd2hpY2ggdG8gcmVzb2x2ZSB0byBgZmFsc2VgIGlmIHRoZSBxdWV1ZSBpcyBzdGlsbCBub24tZW1wdHkuIFBhc3NpbmcgYDBgIChvcgogICAqIG5vdCBwYXNzaW5nIGFueXRoaW5nKSB3aWxsIG1ha2UgdGhlIHByb21pc2Ugd2FpdCBhcyBsb25nIGFzIGl0IHRha2VzIGZvciB0aGUgcXVldWUgdG8gZHJhaW4gYmVmb3JlIHJlc29sdmluZyB0bwogICAqIGB0cnVlYC4KICAgKiBAcmV0dXJucyBBIHByb21pc2Ugd2hpY2ggd2lsbCByZXNvbHZlIHRvIGB0cnVlYCBpZiB0aGUgcXVldWUgaXMgYWxyZWFkeSBlbXB0eSBvciBkcmFpbnMgYmVmb3JlIHRoZSB0aW1lb3V0LCBhbmQKICAgKiBgZmFsc2VgIG90aGVyd2lzZQogICAqLwogIGZ1bmN0aW9uIGRyYWluKHRpbWVvdXQpIHsKICAgIHJldHVybiBuZXcgU3luY1Byb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4gewogICAgICBsZXQgY291bnRlciA9IGJ1ZmZlci5sZW5ndGg7CgogICAgICBpZiAoIWNvdW50ZXIpIHsKICAgICAgICByZXR1cm4gcmVzb2x2ZSh0cnVlKTsKICAgICAgfQoKICAgICAgLy8gd2FpdCBmb3IgYHRpbWVvdXRgIG1zIGFuZCB0aGVuIHJlc29sdmUgdG8gYGZhbHNlYCAoaWYgbm90IGNhbmNlbGxlZCBmaXJzdCkKICAgICAgY29uc3QgY2FwdHVyZWRTZXRUaW1lb3V0ID0gc2V0VGltZW91dCgoKSA9PiB7CiAgICAgICAgaWYgKHRpbWVvdXQgJiYgdGltZW91dCA+IDApIHsKICAgICAgICAgIHJlc29sdmUoZmFsc2UpOwogICAgICAgIH0KICAgICAgfSwgdGltZW91dCk7CgogICAgICAvLyBpZiBhbGwgcHJvbWlzZXMgcmVzb2x2ZSBpbiB0aW1lLCBjYW5jZWwgdGhlIHRpbWVyIGFuZCByZXNvbHZlIHRvIGB0cnVlYAogICAgICBidWZmZXIuZm9yRWFjaChpdGVtID0+IHsKICAgICAgICB2b2lkIHJlc29sdmVkU3luY1Byb21pc2UoaXRlbSkudGhlbigoKSA9PiB7CiAgICAgICAgICBpZiAoIS0tY291bnRlcikgewogICAgICAgICAgICBjbGVhclRpbWVvdXQoY2FwdHVyZWRTZXRUaW1lb3V0KTsKICAgICAgICAgICAgcmVzb2x2ZSh0cnVlKTsKICAgICAgICAgIH0KICAgICAgICB9LCByZWplY3QpOwogICAgICB9KTsKICAgIH0pOwogIH0KCiAgcmV0dXJuIHsKICAgICQ6IGJ1ZmZlciwKICAgIGFkZCwKICAgIGRyYWluLAogIH07Cn0KCmNvbnN0IE9ORV9TRUNPTkRfSU5fTVMgPSAxMDAwOwoKLyoqCiAqIEEgcGFydGlhbCBkZWZpbml0aW9uIG9mIHRoZSBbUGVyZm9ybWFuY2UgV2ViIEFQSV17QGxpbmsgaHR0cHM6Ly9kZXZlbG9wZXIubW96aWxsYS5vcmcvZW4tVVMvZG9jcy9XZWIvQVBJL1BlcmZvcm1hbmNlfQogKiBmb3IgYWNjZXNzaW5nIGEgaGlnaC1yZXNvbHV0aW9uIG1vbm90b25pYyBjbG9jay4KICovCgovKioKICogUmV0dXJucyBhIHRpbWVzdGFtcCBpbiBzZWNvbmRzIHNpbmNlIHRoZSBVTklYIGVwb2NoIHVzaW5nIHRoZSBEYXRlIEFQSS4KICoKICogVE9ETyh2OCk6IFJldHVybiB0eXBlIHNob3VsZCBiZSByb3VuZGVkLgogKi8KZnVuY3Rpb24gZGF0ZVRpbWVzdGFtcEluU2Vjb25kcygpIHsKICByZXR1cm4gRGF0ZS5ub3coKSAvIE9ORV9TRUNPTkRfSU5fTVM7Cn0KCi8qKgogKiBSZXR1cm5zIGEgd3JhcHBlciBhcm91bmQgdGhlIG5hdGl2ZSBQZXJmb3JtYW5jZSBBUEkgYnJvd3NlciBpbXBsZW1lbnRhdGlvbiwgb3IgdW5kZWZpbmVkIGZvciBicm93c2VycyB0aGF0IGRvIG5vdAogKiBzdXBwb3J0IHRoZSBBUEkuCiAqCiAqIFdyYXBwaW5nIHRoZSBuYXRpdmUgQVBJIHdvcmtzIGFyb3VuZCBkaWZmZXJlbmNlcyBpbiBiZWhhdmlvciBmcm9tIGRpZmZlcmVudCBicm93c2Vycy4KICovCmZ1bmN0aW9uIGNyZWF0ZVVuaXhUaW1lc3RhbXBJblNlY29uZHNGdW5jKCkgewogIGNvbnN0IHsgcGVyZm9ybWFuY2UgfSA9IEdMT0JBTF9PQkogOwogIGlmICghcGVyZm9ybWFuY2UgfHwgIXBlcmZvcm1hbmNlLm5vdykgewogICAgcmV0dXJuIGRhdGVUaW1lc3RhbXBJblNlY29uZHM7CiAgfQoKICAvLyBTb21lIGJyb3dzZXIgYW5kIGVudmlyb25tZW50cyBkb24ndCBoYXZlIGEgdGltZU9yaWdpbiwgc28gd2UgZmFsbGJhY2sgdG8KICAvLyB1c2luZyBEYXRlLm5vdygpIHRvIGNvbXB1dGUgdGhlIHN0YXJ0aW5nIHRpbWUuCiAgY29uc3QgYXBwcm94U3RhcnRpbmdUaW1lT3JpZ2luID0gRGF0ZS5ub3coKSAtIHBlcmZvcm1hbmNlLm5vdygpOwogIGNvbnN0IHRpbWVPcmlnaW4gPSBwZXJmb3JtYW5jZS50aW1lT3JpZ2luID09IHVuZGVmaW5lZCA/IGFwcHJveFN0YXJ0aW5nVGltZU9yaWdpbiA6IHBlcmZvcm1hbmNlLnRpbWVPcmlnaW47CgogIC8vIHBlcmZvcm1hbmNlLm5vdygpIGlzIGEgbW9ub3RvbmljIGNsb2NrLCB3aGljaCBtZWFucyBpdCBzdGFydHMgYXQgMCB3aGVuIHRoZSBwcm9jZXNzIGJlZ2lucy4gVG8gZ2V0IHRoZSBjdXJyZW50CiAgLy8gd2FsbCBjbG9jayB0aW1lIChhY3R1YWwgVU5JWCB0aW1lc3RhbXApLCB3ZSBuZWVkIHRvIGFkZCB0aGUgc3RhcnRpbmcgdGltZSBvcmlnaW4gYW5kIHRoZSBjdXJyZW50IHRpbWUgZWxhcHNlZC4KICAvLwogIC8vIFRPRE86IFRoaXMgZG9lcyBub3QgYWNjb3VudCBmb3IgdGhlIGNhc2Ugd2hlcmUgdGhlIG1vbm90b25pYyBjbG9jayB0aGF0IHBvd2VycyBwZXJmb3JtYW5jZS5ub3coKSBkcmlmdHMgZnJvbSB0aGUKICAvLyB3YWxsIGNsb2NrIHRpbWUsIHdoaWNoIGNhdXNlcyB0aGUgcmV0dXJuZWQgdGltZXN0YW1wIHRvIGJlIGluYWNjdXJhdGUuIFdlIHNob3VsZCBpbnZlc3RpZ2F0ZSBob3cgdG8gZGV0ZWN0IGFuZAogIC8vIGNvcnJlY3QgZm9yIHRoaXMuCiAgLy8gU2VlOiBodHRwczovL2dpdGh1Yi5jb20vZ2V0c2VudHJ5L3NlbnRyeS1qYXZhc2NyaXB0L2lzc3Vlcy8yNTkwCiAgLy8gU2VlOiBodHRwczovL2dpdGh1Yi5jb20vbWRuL2NvbnRlbnQvaXNzdWVzLzQ3MTMKICAvLyBTZWU6IGh0dHBzOi8vZGV2LnRvL25vYW1yL3doZW4tYS1taWxsaXNlY29uZC1pcy1ub3QtYS1taWxsaXNlY29uZC0zaDYKICByZXR1cm4gKCkgPT4gewogICAgcmV0dXJuICh0aW1lT3JpZ2luICsgcGVyZm9ybWFuY2Uubm93KCkpIC8gT05FX1NFQ09ORF9JTl9NUzsKICB9Owp9CgovKioKICogUmV0dXJucyBhIHRpbWVzdGFtcCBpbiBzZWNvbmRzIHNpbmNlIHRoZSBVTklYIGVwb2NoIHVzaW5nIGVpdGhlciB0aGUgUGVyZm9ybWFuY2Ugb3IgRGF0ZSBBUElzLCBkZXBlbmRpbmcgb24gdGhlCiAqIGF2YWlsYWJpbGl0eSBvZiB0aGUgUGVyZm9ybWFuY2UgQVBJLgogKgogKiBCVUc6IE5vdGUgdGhhdCBiZWNhdXNlIG9mIGhvdyBicm93c2VycyBpbXBsZW1lbnQgdGhlIFBlcmZvcm1hbmNlIEFQSSwgdGhlIGNsb2NrIG1pZ2h0IHN0b3Agd2hlbiB0aGUgY29tcHV0ZXIgaXMKICogYXNsZWVwLiBUaGlzIGNyZWF0ZXMgYSBza2V3IGJldHdlZW4gYGRhdGVUaW1lc3RhbXBJblNlY29uZHNgIGFuZCBgdGltZXN0YW1wSW5TZWNvbmRzYC4gVGhlCiAqIHNrZXcgY2FuIGdyb3cgdG8gYXJiaXRyYXJ5IGFtb3VudHMgbGlrZSBkYXlzLCB3ZWVrcyBvciBtb250aHMuCiAqIFNlZSBodHRwczovL2dpdGh1Yi5jb20vZ2V0c2VudHJ5L3NlbnRyeS1qYXZhc2NyaXB0L2lzc3Vlcy8yNTkwLgogKi8KY29uc3QgdGltZXN0YW1wSW5TZWNvbmRzID0gY3JlYXRlVW5peFRpbWVzdGFtcEluU2Vjb25kc0Z1bmMoKTsKCi8qKgogKiBUaGUgbnVtYmVyIG9mIG1pbGxpc2Vjb25kcyBzaW5jZSB0aGUgVU5JWCBlcG9jaC4gVGhpcyB2YWx1ZSBpcyBvbmx5IHVzYWJsZSBpbiBhIGJyb3dzZXIsIGFuZCBvbmx5IHdoZW4gdGhlCiAqIHBlcmZvcm1hbmNlIEFQSSBpcyBhdmFpbGFibGUuCiAqLwooKCkgPT4gewogIC8vIFVuZm9ydHVuYXRlbHkgYnJvd3NlcnMgbWF5IHJlcG9ydCBhbiBpbmFjY3VyYXRlIHRpbWUgb3JpZ2luIGRhdGEsIHRocm91Z2ggZWl0aGVyIHBlcmZvcm1hbmNlLnRpbWVPcmlnaW4gb3IKICAvLyBwZXJmb3JtYW5jZS50aW1pbmcubmF2aWdhdGlvblN0YXJ0LCB3aGljaCByZXN1bHRzIGluIHBvb3IgcmVzdWx0cyBpbiBwZXJmb3JtYW5jZSBkYXRhLiBXZSBvbmx5IHRyZWF0IHRpbWUgb3JpZ2luCiAgLy8gZGF0YSBhcyByZWxpYWJsZSBpZiB0aGV5IGFyZSB3aXRoaW4gYSByZWFzb25hYmxlIHRocmVzaG9sZCBvZiB0aGUgY3VycmVudCB0aW1lLgoKICBjb25zdCB7IHBlcmZvcm1hbmNlIH0gPSBHTE9CQUxfT0JKIDsKICBpZiAoIXBlcmZvcm1hbmNlIHx8ICFwZXJmb3JtYW5jZS5ub3cpIHsKICAgIHJldHVybiB1bmRlZmluZWQ7CiAgfQoKICBjb25zdCB0aHJlc2hvbGQgPSAzNjAwICogMTAwMDsKICBjb25zdCBwZXJmb3JtYW5jZU5vdyA9IHBlcmZvcm1hbmNlLm5vdygpOwogIGNvbnN0IGRhdGVOb3cgPSBEYXRlLm5vdygpOwoKICAvLyBpZiB0aW1lT3JpZ2luIGlzbid0IGF2YWlsYWJsZSBzZXQgZGVsdGEgdG8gdGhyZXNob2xkIHNvIGl0IGlzbid0IHVzZWQKICBjb25zdCB0aW1lT3JpZ2luRGVsdGEgPSBwZXJmb3JtYW5jZS50aW1lT3JpZ2luCiAgICA/IE1hdGguYWJzKHBlcmZvcm1hbmNlLnRpbWVPcmlnaW4gKyBwZXJmb3JtYW5jZU5vdyAtIGRhdGVOb3cpCiAgICA6IHRocmVzaG9sZDsKICBjb25zdCB0aW1lT3JpZ2luSXNSZWxpYWJsZSA9IHRpbWVPcmlnaW5EZWx0YSA8IHRocmVzaG9sZDsKCiAgLy8gV2hpbGUgcGVyZm9ybWFuY2UudGltaW5nLm5hdmlnYXRpb25TdGFydCBpcyBkZXByZWNhdGVkIGluIGZhdm9yIG9mIHBlcmZvcm1hbmNlLnRpbWVPcmlnaW4sIHBlcmZvcm1hbmNlLnRpbWVPcmlnaW4KICAvLyBpcyBub3QgYXMgd2lkZWx5IHN1cHBvcnRlZC4gTmFtZWx5LCBwZXJmb3JtYW5jZS50aW1lT3JpZ2luIGlzIHVuZGVmaW5lZCBpbiBTYWZhcmkgYXMgb2Ygd3JpdGluZy4KICAvLyBBbHNvIGFzIG9mIHdyaXRpbmcsIHBlcmZvcm1hbmNlLnRpbWluZyBpcyBub3QgYXZhaWxhYmxlIGluIFdlYiBXb3JrZXJzIGluIG1haW5zdHJlYW0gYnJvd3NlcnMsIHNvIGl0IGlzIG5vdCBhbHdheXMKICAvLyBhIHZhbGlkIGZhbGxiYWNrLiBJbiB0aGUgYWJzZW5jZSBvZiBhbiBpbml0aWFsIHRpbWUgcHJvdmlkZWQgYnkgdGhlIGJyb3dzZXIsIGZhbGxiYWNrIHRvIHRoZSBjdXJyZW50IHRpbWUgZnJvbSB0aGUKICAvLyBEYXRlIEFQSS4KICAvLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgZGVwcmVjYXRpb24vZGVwcmVjYXRpb24KICBjb25zdCBuYXZpZ2F0aW9uU3RhcnQgPSBwZXJmb3JtYW5jZS50aW1pbmcgJiYgcGVyZm9ybWFuY2UudGltaW5nLm5hdmlnYXRpb25TdGFydDsKICBjb25zdCBoYXNOYXZpZ2F0aW9uU3RhcnQgPSB0eXBlb2YgbmF2aWdhdGlvblN0YXJ0ID09PSAnbnVtYmVyJzsKICAvLyBpZiBuYXZpZ2F0aW9uU3RhcnQgaXNuJ3QgYXZhaWxhYmxlIHNldCBkZWx0YSB0byB0aHJlc2hvbGQgc28gaXQgaXNuJ3QgdXNlZAogIGNvbnN0IG5hdmlnYXRpb25TdGFydERlbHRhID0gaGFzTmF2aWdhdGlvblN0YXJ0ID8gTWF0aC5hYnMobmF2aWdhdGlvblN0YXJ0ICsgcGVyZm9ybWFuY2VOb3cgLSBkYXRlTm93KSA6IHRocmVzaG9sZDsKICBjb25zdCBuYXZpZ2F0aW9uU3RhcnRJc1JlbGlhYmxlID0gbmF2aWdhdGlvblN0YXJ0RGVsdGEgPCB0aHJlc2hvbGQ7CgogIGlmICh0aW1lT3JpZ2luSXNSZWxpYWJsZSB8fCBuYXZpZ2F0aW9uU3RhcnRJc1JlbGlhYmxlKSB7CiAgICAvLyBVc2UgdGhlIG1vcmUgcmVsaWFibGUgdGltZSBvcmlnaW4KICAgIGlmICh0aW1lT3JpZ2luRGVsdGEgPD0gbmF2aWdhdGlvblN0YXJ0RGVsdGEpIHsKICAgICAgcmV0dXJuIHBlcmZvcm1hbmNlLnRpbWVPcmlnaW47CiAgICB9IGVsc2UgewogICAgICByZXR1cm4gbmF2aWdhdGlvblN0YXJ0OwogICAgfQogIH0KICByZXR1cm4gZGF0ZU5vdzsKfSkoKTsKCi8qKgogKiBDcmVhdGVzIGFuIGVudmVsb3BlLgogKiBNYWtlIHN1cmUgdG8gYWx3YXlzIGV4cGxpY2l0bHkgcHJvdmlkZSB0aGUgZ2VuZXJpYyB0byB0aGlzIGZ1bmN0aW9uCiAqIHNvIHRoYXQgdGhlIGVudmVsb3BlIHR5cGVzIHJlc29sdmUgY29ycmVjdGx5LgogKi8KZnVuY3Rpb24gY3JlYXRlRW52ZWxvcGUoaGVhZGVycywgaXRlbXMgPSBbXSkgewogIHJldHVybiBbaGVhZGVycywgaXRlbXNdIDsKfQoKLyoqCiAqIENvbnZlbmllbmNlIGZ1bmN0aW9uIHRvIGxvb3AgdGhyb3VnaCB0aGUgaXRlbXMgYW5kIGl0ZW0gdHlwZXMgb2YgYW4gZW52ZWxvcGUuCiAqIChUaGlzIGZ1bmN0aW9uIHdhcyBtb3N0bHkgY3JlYXRlZCBiZWNhdXNlIHdvcmtpbmcgd2l0aCBlbnZlbG9wZSB0eXBlcyBpcyBwYWluZnVsIGF0IHRoZSBtb21lbnQpCiAqCiAqIElmIHRoZSBjYWxsYmFjayByZXR1cm5zIHRydWUsIHRoZSByZXN0IG9mIHRoZSBpdGVtcyB3aWxsIGJlIHNraXBwZWQuCiAqLwpmdW5jdGlvbiBmb3JFYWNoRW52ZWxvcGVJdGVtKAogIGVudmVsb3BlLAogIGNhbGxiYWNrLAopIHsKICBjb25zdCBlbnZlbG9wZUl0ZW1zID0gZW52ZWxvcGVbMV07CgogIGZvciAoY29uc3QgZW52ZWxvcGVJdGVtIG9mIGVudmVsb3BlSXRlbXMpIHsKICAgIGNvbnN0IGVudmVsb3BlSXRlbVR5cGUgPSBlbnZlbG9wZUl0ZW1bMF0udHlwZTsKICAgIGNvbnN0IHJlc3VsdCA9IGNhbGxiYWNrKGVudmVsb3BlSXRlbSwgZW52ZWxvcGVJdGVtVHlwZSk7CgogICAgaWYgKHJlc3VsdCkgewogICAgICByZXR1cm4gdHJ1ZTsKICAgIH0KICB9CgogIHJldHVybiBmYWxzZTsKfQoKLyoqCiAqIEVuY29kZSBhIHN0cmluZyB0byBVVEY4LgogKi8KZnVuY3Rpb24gZW5jb2RlVVRGOChpbnB1dCwgdGV4dEVuY29kZXIpIHsKICBjb25zdCB1dGY4ID0gdGV4dEVuY29kZXIgfHwgbmV3IFRleHRFbmNvZGVyKCk7CiAgcmV0dXJuIHV0ZjguZW5jb2RlKGlucHV0KTsKfQoKLyoqCiAqIFNlcmlhbGl6ZXMgYW4gZW52ZWxvcGUuCiAqLwpmdW5jdGlvbiBzZXJpYWxpemVFbnZlbG9wZShlbnZlbG9wZSwgdGV4dEVuY29kZXIpIHsKICBjb25zdCBbZW52SGVhZGVycywgaXRlbXNdID0gZW52ZWxvcGU7CgogIC8vIEluaXRpYWxseSB3ZSBjb25zdHJ1Y3Qgb3VyIGVudmVsb3BlIGFzIGEgc3RyaW5nIGFuZCBvbmx5IGNvbnZlcnQgdG8gYmluYXJ5IGNodW5rcyBpZiB3ZSBlbmNvdW50ZXIgYmluYXJ5IGRhdGEKICBsZXQgcGFydHMgPSBKU09OLnN0cmluZ2lmeShlbnZIZWFkZXJzKTsKCiAgZnVuY3Rpb24gYXBwZW5kKG5leHQpIHsKICAgIGlmICh0eXBlb2YgcGFydHMgPT09ICdzdHJpbmcnKSB7CiAgICAgIHBhcnRzID0gdHlwZW9mIG5leHQgPT09ICdzdHJpbmcnID8gcGFydHMgKyBuZXh0IDogW2VuY29kZVVURjgocGFydHMsIHRleHRFbmNvZGVyKSwgbmV4dF07CiAgICB9IGVsc2UgewogICAgICBwYXJ0cy5wdXNoKHR5cGVvZiBuZXh0ID09PSAnc3RyaW5nJyA/IGVuY29kZVVURjgobmV4dCwgdGV4dEVuY29kZXIpIDogbmV4dCk7CiAgICB9CiAgfQoKICBmb3IgKGNvbnN0IGl0ZW0gb2YgaXRlbXMpIHsKICAgIGNvbnN0IFtpdGVtSGVhZGVycywgcGF5bG9hZF0gPSBpdGVtOwoKICAgIGFwcGVuZChgXG4ke0pTT04uc3RyaW5naWZ5KGl0ZW1IZWFkZXJzKX1cbmApOwoKICAgIGlmICh0eXBlb2YgcGF5bG9hZCA9PT0gJ3N0cmluZycgfHwgcGF5bG9hZCBpbnN0YW5jZW9mIFVpbnQ4QXJyYXkpIHsKICAgICAgYXBwZW5kKHBheWxvYWQpOwogICAgfSBlbHNlIHsKICAgICAgbGV0IHN0cmluZ2lmaWVkUGF5bG9hZDsKICAgICAgdHJ5IHsKICAgICAgICBzdHJpbmdpZmllZFBheWxvYWQgPSBKU09OLnN0cmluZ2lmeShwYXlsb2FkKTsKICAgICAgfSBjYXRjaCAoZSkgewogICAgICAgIC8vIEluIGNhc2UsIGRlc3BpdGUgYWxsIG91ciBlZmZvcnRzIHRvIGtlZXAgYHBheWxvYWRgIGNpcmN1bGFyLWRlcGVuZGVuY3ktZnJlZSwgYEpTT04uc3RyaW5pZnkoKWAgc3RpbGwKICAgICAgICAvLyBmYWlscywgd2UgdHJ5IGFnYWluIGFmdGVyIG5vcm1hbGl6aW5nIGl0IGFnYWluIHdpdGggaW5maW5pdGUgbm9ybWFsaXphdGlvbiBkZXB0aC4gVGhpcyBvZiBjb3Vyc2UgaGFzIGEKICAgICAgICAvLyBwZXJmb3JtYW5jZSBpbXBhY3QgYnV0IGluIHRoaXMgY2FzZSBhIHBlcmZvcm1hbmNlIGhpdCBpcyBiZXR0ZXIgdGhhbiB0aHJvd2luZy4KICAgICAgICBzdHJpbmdpZmllZFBheWxvYWQgPSBKU09OLnN0cmluZ2lmeShub3JtYWxpemUocGF5bG9hZCkpOwogICAgICB9CiAgICAgIGFwcGVuZChzdHJpbmdpZmllZFBheWxvYWQpOwogICAgfQogIH0KCiAgcmV0dXJuIHR5cGVvZiBwYXJ0cyA9PT0gJ3N0cmluZycgPyBwYXJ0cyA6IGNvbmNhdEJ1ZmZlcnMocGFydHMpOwp9CgpmdW5jdGlvbiBjb25jYXRCdWZmZXJzKGJ1ZmZlcnMpIHsKICBjb25zdCB0b3RhbExlbmd0aCA9IGJ1ZmZlcnMucmVkdWNlKChhY2MsIGJ1ZikgPT4gYWNjICsgYnVmLmxlbmd0aCwgMCk7CgogIGNvbnN0IG1lcmdlZCA9IG5ldyBVaW50OEFycmF5KHRvdGFsTGVuZ3RoKTsKICBsZXQgb2Zmc2V0ID0gMDsKICBmb3IgKGNvbnN0IGJ1ZmZlciBvZiBidWZmZXJzKSB7CiAgICBtZXJnZWQuc2V0KGJ1ZmZlciwgb2Zmc2V0KTsKICAgIG9mZnNldCArPSBidWZmZXIubGVuZ3RoOwogIH0KCiAgcmV0dXJuIG1lcmdlZDsKfQoKY29uc3QgSVRFTV9UWVBFX1RPX0RBVEFfQ0FURUdPUllfTUFQID0gewogIHNlc3Npb246ICdzZXNzaW9uJywKICBzZXNzaW9uczogJ3Nlc3Npb24nLAogIGF0dGFjaG1lbnQ6ICdhdHRhY2htZW50JywKICB0cmFuc2FjdGlvbjogJ3RyYW5zYWN0aW9uJywKICBldmVudDogJ2Vycm9yJywKICBjbGllbnRfcmVwb3J0OiAnaW50ZXJuYWwnLAogIHVzZXJfcmVwb3J0OiAnZGVmYXVsdCcsCiAgcHJvZmlsZTogJ3Byb2ZpbGUnLAogIHJlcGxheV9ldmVudDogJ3JlcGxheScsCiAgcmVwbGF5X3JlY29yZGluZzogJ3JlcGxheScsCiAgY2hlY2tfaW46ICdtb25pdG9yJywKICBmZWVkYmFjazogJ2ZlZWRiYWNrJywKICBzcGFuOiAnc3BhbicsCiAgc3RhdHNkOiAnbWV0cmljX2J1Y2tldCcsCn07CgovKioKICogTWFwcyB0aGUgdHlwZSBvZiBhbiBlbnZlbG9wZSBpdGVtIHRvIGEgZGF0YSBjYXRlZ29yeS4KICovCmZ1bmN0aW9uIGVudmVsb3BlSXRlbVR5cGVUb0RhdGFDYXRlZ29yeSh0eXBlKSB7CiAgcmV0dXJuIElURU1fVFlQRV9UT19EQVRBX0NBVEVHT1JZX01BUFt0eXBlXTsKfQoKLyoqIEV4dHJhY3RzIHRoZSBtaW5pbWFsIFNESyBpbmZvIGZyb20gdGhlIG1ldGFkYXRhIG9yIGFuIGV2ZW50cyAqLwpmdW5jdGlvbiBnZXRTZGtNZXRhZGF0YUZvckVudmVsb3BlSGVhZGVyKG1ldGFkYXRhT3JFdmVudCkgewogIGlmICghbWV0YWRhdGFPckV2ZW50IHx8ICFtZXRhZGF0YU9yRXZlbnQuc2RrKSB7CiAgICByZXR1cm47CiAgfQogIGNvbnN0IHsgbmFtZSwgdmVyc2lvbiB9ID0gbWV0YWRhdGFPckV2ZW50LnNkazsKICByZXR1cm4geyBuYW1lLCB2ZXJzaW9uIH07Cn0KCi8qKgogKiBDcmVhdGVzIGV2ZW50IGVudmVsb3BlIGhlYWRlcnMsIGJhc2VkIG9uIGV2ZW50LCBzZGsgaW5mbyBhbmQgdHVubmVsCiAqIE5vdGU6IFRoaXMgZnVuY3Rpb24gd2FzIGV4dHJhY3RlZCBmcm9tIHRoZSBjb3JlIHBhY2thZ2UgdG8gbWFrZSBpdCBhdmFpbGFibGUgaW4gUmVwbGF5CiAqLwpmdW5jdGlvbiBjcmVhdGVFdmVudEVudmVsb3BlSGVhZGVycygKICBldmVudCwKICBzZGtJbmZvLAogIHR1bm5lbCwKICBkc24sCikgewogIGNvbnN0IGR5bmFtaWNTYW1wbGluZ0NvbnRleHQgPSBldmVudC5zZGtQcm9jZXNzaW5nTWV0YWRhdGEgJiYgZXZlbnQuc2RrUHJvY2Vzc2luZ01ldGFkYXRhLmR5bmFtaWNTYW1wbGluZ0NvbnRleHQ7CiAgcmV0dXJuIHsKICAgIGV2ZW50X2lkOiBldmVudC5ldmVudF9pZCAsCiAgICBzZW50X2F0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksCiAgICAuLi4oc2RrSW5mbyAmJiB7IHNkazogc2RrSW5mbyB9KSwKICAgIC4uLighIXR1bm5lbCAmJiBkc24gJiYgeyBkc246IGRzblRvU3RyaW5nKGRzbikgfSksCiAgICAuLi4oZHluYW1pY1NhbXBsaW5nQ29udGV4dCAmJiB7CiAgICAgIHRyYWNlOiBkcm9wVW5kZWZpbmVkS2V5cyh7IC4uLmR5bmFtaWNTYW1wbGluZ0NvbnRleHQgfSksCiAgICB9KSwKICB9Owp9CgovLyBJbnRlbnRpb25hbGx5IGtlZXBpbmcgdGhlIGtleSBicm9hZCwgYXMgd2UgZG9uJ3Qga25vdyBmb3Igc3VyZSB3aGF0IHJhdGUgbGltaXQgaGVhZGVycyBnZXQgcmV0dXJuZWQgZnJvbSBiYWNrZW5kCgpjb25zdCBERUZBVUxUX1JFVFJZX0FGVEVSID0gNjAgKiAxMDAwOyAvLyA2MCBzZWNvbmRzCgovKioKICogRXh0cmFjdHMgUmV0cnktQWZ0ZXIgdmFsdWUgZnJvbSB0aGUgcmVxdWVzdCBoZWFkZXIgb3IgcmV0dXJucyBkZWZhdWx0IHZhbHVlCiAqIEBwYXJhbSBoZWFkZXIgc3RyaW5nIHJlcHJlc2VudGF0aW9uIG9mICdSZXRyeS1BZnRlcicgaGVhZGVyCiAqIEBwYXJhbSBub3cgY3VycmVudCB1bml4IHRpbWVzdGFtcAogKgogKi8KZnVuY3Rpb24gcGFyc2VSZXRyeUFmdGVySGVhZGVyKGhlYWRlciwgbm93ID0gRGF0ZS5ub3coKSkgewogIGNvbnN0IGhlYWRlckRlbGF5ID0gcGFyc2VJbnQoYCR7aGVhZGVyfWAsIDEwKTsKICBpZiAoIWlzTmFOKGhlYWRlckRlbGF5KSkgewogICAgcmV0dXJuIGhlYWRlckRlbGF5ICogMTAwMDsKICB9CgogIGNvbnN0IGhlYWRlckRhdGUgPSBEYXRlLnBhcnNlKGAke2hlYWRlcn1gKTsKICBpZiAoIWlzTmFOKGhlYWRlckRhdGUpKSB7CiAgICByZXR1cm4gaGVhZGVyRGF0ZSAtIG5vdzsKICB9CgogIHJldHVybiBERUZBVUxUX1JFVFJZX0FGVEVSOwp9CgovKioKICogR2V0cyB0aGUgdGltZSB0aGF0IHRoZSBnaXZlbiBjYXRlZ29yeSBpcyBkaXNhYmxlZCB1bnRpbCBmb3IgcmF0ZSBsaW1pdGluZy4KICogSW4gY2FzZSBubyBjYXRlZ29yeS1zcGVjaWZpYyBsaW1pdCBpcyBzZXQgYnV0IGEgZ2VuZXJhbCByYXRlIGxpbWl0IGFjcm9zcyBhbGwgY2F0ZWdvcmllcyBpcyBhY3RpdmUsCiAqIHRoYXQgdGltZSBpcyByZXR1cm5lZC4KICoKICogQHJldHVybiB0aGUgdGltZSBpbiBtcyB0aGF0IHRoZSBjYXRlZ29yeSBpcyBkaXNhYmxlZCB1bnRpbCBvciAwIGlmIHRoZXJlJ3Mgbm8gYWN0aXZlIHJhdGUgbGltaXQuCiAqLwpmdW5jdGlvbiBkaXNhYmxlZFVudGlsKGxpbWl0cywgZGF0YUNhdGVnb3J5KSB7CiAgcmV0dXJuIGxpbWl0c1tkYXRhQ2F0ZWdvcnldIHx8IGxpbWl0cy5hbGwgfHwgMDsKfQoKLyoqCiAqIENoZWNrcyBpZiBhIGNhdGVnb3J5IGlzIHJhdGUgbGltaXRlZAogKi8KZnVuY3Rpb24gaXNSYXRlTGltaXRlZChsaW1pdHMsIGRhdGFDYXRlZ29yeSwgbm93ID0gRGF0ZS5ub3coKSkgewogIHJldHVybiBkaXNhYmxlZFVudGlsKGxpbWl0cywgZGF0YUNhdGVnb3J5KSA+IG5vdzsKfQoKLyoqCiAqIFVwZGF0ZSByYXRlbGltaXRzIGZyb20gaW5jb21pbmcgaGVhZGVycy4KICoKICogQHJldHVybiB0aGUgdXBkYXRlZCBSYXRlTGltaXRzIG9iamVjdC4KICovCmZ1bmN0aW9uIHVwZGF0ZVJhdGVMaW1pdHMoCiAgbGltaXRzLAogIHsgc3RhdHVzQ29kZSwgaGVhZGVycyB9LAogIG5vdyA9IERhdGUubm93KCksCikgewogIGNvbnN0IHVwZGF0ZWRSYXRlTGltaXRzID0gewogICAgLi4ubGltaXRzLAogIH07CgogIC8vICJUaGUgbmFtZSBpcyBjYXNlLWluc2Vuc2l0aXZlLiIKICAvLyBodHRwczovL2RldmVsb3Blci5tb3ppbGxhLm9yZy9lbi1VUy9kb2NzL1dlYi9BUEkvSGVhZGVycy9nZXQKICBjb25zdCByYXRlTGltaXRIZWFkZXIgPSBoZWFkZXJzICYmIGhlYWRlcnNbJ3gtc2VudHJ5LXJhdGUtbGltaXRzJ107CiAgY29uc3QgcmV0cnlBZnRlckhlYWRlciA9IGhlYWRlcnMgJiYgaGVhZGVyc1sncmV0cnktYWZ0ZXInXTsKCiAgaWYgKHJhdGVMaW1pdEhlYWRlcikgewogICAgLyoqCiAgICAgKiByYXRlIGxpbWl0IGhlYWRlcnMgYXJlIG9mIHRoZSBmb3JtCiAgICAgKiAgICAgPGhlYWRlcj4sPGhlYWRlcj4sLi4KICAgICAqIHdoZXJlIGVhY2ggPGhlYWRlcj4gaXMgb2YgdGhlIGZvcm0KICAgICAqICAgICA8cmV0cnlfYWZ0ZXI+OiA8Y2F0ZWdvcmllcz46IDxzY29wZT46IDxyZWFzb25fY29kZT46IDxuYW1lc3BhY2VzPgogICAgICogd2hlcmUKICAgICAqICAgICA8cmV0cnlfYWZ0ZXI+IGlzIGEgZGVsYXkgaW4gc2Vjb25kcwogICAgICogICAgIDxjYXRlZ29yaWVzPiBpcyB0aGUgZXZlbnQgdHlwZShzKSAoZXJyb3IsIHRyYW5zYWN0aW9uLCBldGMpIGJlaW5nIHJhdGUgbGltaXRlZCBhbmQgaXMgb2YgdGhlIGZvcm0KICAgICAqICAgICAgICAgPGNhdGVnb3J5Pjs8Y2F0ZWdvcnk+Oy4uLgogICAgICogICAgIDxzY29wZT4gaXMgd2hhdCdzIGJlaW5nIGxpbWl0ZWQgKG9yZywgcHJvamVjdCwgb3Iga2V5KSAtIGlnbm9yZWQgYnkgU0RLCiAgICAgKiAgICAgPHJlYXNvbl9jb2RlPiBpcyBhbiBhcmJpdHJhcnkgc3RyaW5nIGxpa2UgIm9yZ19xdW90YSIgLSBpZ25vcmVkIGJ5IFNESwogICAgICogICAgIDxuYW1lc3BhY2VzPiBTZW1pY29sb24tc2VwYXJhdGVkIGxpc3Qgb2YgbWV0cmljIG5hbWVzcGFjZSBpZGVudGlmaWVycy4gRGVmaW5lcyB3aGljaCBuYW1lc3BhY2Uocykgd2lsbCBiZSBhZmZlY3RlZC4KICAgICAqICAgICAgICAgT25seSBwcmVzZW50IGlmIHJhdGUgbGltaXQgYXBwbGllcyB0byB0aGUgbWV0cmljX2J1Y2tldCBkYXRhIGNhdGVnb3J5LgogICAgICovCiAgICBmb3IgKGNvbnN0IGxpbWl0IG9mIHJhdGVMaW1pdEhlYWRlci50cmltKCkuc3BsaXQoJywnKSkgewogICAgICBjb25zdCBbcmV0cnlBZnRlciwgY2F0ZWdvcmllcywgLCAsIG5hbWVzcGFjZXNdID0gbGltaXQuc3BsaXQoJzonLCA1KTsKICAgICAgY29uc3QgaGVhZGVyRGVsYXkgPSBwYXJzZUludChyZXRyeUFmdGVyLCAxMCk7CiAgICAgIGNvbnN0IGRlbGF5ID0gKCFpc05hTihoZWFkZXJEZWxheSkgPyBoZWFkZXJEZWxheSA6IDYwKSAqIDEwMDA7IC8vIDYwc2VjIGRlZmF1bHQKICAgICAgaWYgKCFjYXRlZ29yaWVzKSB7CiAgICAgICAgdXBkYXRlZFJhdGVMaW1pdHMuYWxsID0gbm93ICsgZGVsYXk7CiAgICAgIH0gZWxzZSB7CiAgICAgICAgZm9yIChjb25zdCBjYXRlZ29yeSBvZiBjYXRlZ29yaWVzLnNwbGl0KCc7JykpIHsKICAgICAgICAgIGlmIChjYXRlZ29yeSA9PT0gJ21ldHJpY19idWNrZXQnKSB7CiAgICAgICAgICAgIC8vIG5hbWVzcGFjZXMgd2lsbCBiZSBwcmVzZW50IHdoZW4gY2F0ZWdvcnkgPT09ICdtZXRyaWNfYnVja2V0JwogICAgICAgICAgICBpZiAoIW5hbWVzcGFjZXMgfHwgbmFtZXNwYWNlcy5zcGxpdCgnOycpLmluY2x1ZGVzKCdjdXN0b20nKSkgewogICAgICAgICAgICAgIHVwZGF0ZWRSYXRlTGltaXRzW2NhdGVnb3J5XSA9IG5vdyArIGRlbGF5OwogICAgICAgICAgICB9CiAgICAgICAgICB9IGVsc2UgewogICAgICAgICAgICB1cGRhdGVkUmF0ZUxpbWl0c1tjYXRlZ29yeV0gPSBub3cgKyBkZWxheTsKICAgICAgICAgIH0KICAgICAgICB9CiAgICAgIH0KICAgIH0KICB9IGVsc2UgaWYgKHJldHJ5QWZ0ZXJIZWFkZXIpIHsKICAgIHVwZGF0ZWRSYXRlTGltaXRzLmFsbCA9IG5vdyArIHBhcnNlUmV0cnlBZnRlckhlYWRlcihyZXRyeUFmdGVySGVhZGVyLCBub3cpOwogIH0gZWxzZSBpZiAoc3RhdHVzQ29kZSA9PT0gNDI5KSB7CiAgICB1cGRhdGVkUmF0ZUxpbWl0cy5hbGwgPSBub3cgKyA2MCAqIDEwMDA7CiAgfQoKICByZXR1cm4gdXBkYXRlZFJhdGVMaW1pdHM7Cn0KCi8qKgogKiBBIG5vZGUuanMgd2F0Y2hkb2cgdGltZXIKICogQHBhcmFtIHBvbGxJbnRlcnZhbCBUaGUgaW50ZXJ2YWwgdGhhdCB3ZSBleHBlY3QgdG8gZ2V0IHBvbGxlZCBhdAogKiBAcGFyYW0gYW5yVGhyZXNob2xkIFRoZSB0aHJlc2hvbGQgZm9yIHdoZW4gd2UgY29uc2lkZXIgQU5SCiAqIEBwYXJhbSBjYWxsYmFjayBUaGUgY2FsbGJhY2sgdG8gY2FsbCBmb3IgQU5SCiAqIEByZXR1cm5zIEFuIG9iamVjdCB3aXRoIGBwb2xsYCBhbmQgYGVuYWJsZWRgIGZ1bmN0aW9ucyB7QGxpbmsgV2F0Y2hkb2dSZXR1cm59CiAqLwpmdW5jdGlvbiB3YXRjaGRvZ1RpbWVyKAogIGNyZWF0ZVRpbWVyLAogIHBvbGxJbnRlcnZhbCwKICBhbnJUaHJlc2hvbGQsCiAgY2FsbGJhY2ssCikgewogIGNvbnN0IHRpbWVyID0gY3JlYXRlVGltZXIoKTsKICBsZXQgdHJpZ2dlcmVkID0gZmFsc2U7CiAgbGV0IGVuYWJsZWQgPSB0cnVlOwoKICBzZXRJbnRlcnZhbCgoKSA9PiB7CiAgICBjb25zdCBkaWZmTXMgPSB0aW1lci5nZXRUaW1lTXMoKTsKCiAgICBpZiAodHJpZ2dlcmVkID09PSBmYWxzZSAmJiBkaWZmTXMgPiBwb2xsSW50ZXJ2YWwgKyBhbnJUaHJlc2hvbGQpIHsKICAgICAgdHJpZ2dlcmVkID0gdHJ1ZTsKICAgICAgaWYgKGVuYWJsZWQpIHsKICAgICAgICBjYWxsYmFjaygpOwogICAgICB9CiAgICB9CgogICAgaWYgKGRpZmZNcyA8IHBvbGxJbnRlcnZhbCArIGFuclRocmVzaG9sZCkgewogICAgICB0cmlnZ2VyZWQgPSBmYWxzZTsKICAgIH0KICB9LCAyMCk7CgogIHJldHVybiB7CiAgICBwb2xsOiAoKSA9PiB7CiAgICAgIHRpbWVyLnJlc2V0KCk7CiAgICB9LAogICAgZW5hYmxlZDogKHN0YXRlKSA9PiB7CiAgICAgIGVuYWJsZWQgPSBzdGF0ZTsKICAgIH0sCiAgfTsKfQoKLy8gdHlwZXMgY29waWVkIGZyb20gaW5zcGVjdG9yLmQudHMKCi8qKgogKiBDb252ZXJ0cyBEZWJ1Z2dlci5DYWxsRnJhbWUgdG8gU2VudHJ5IFN0YWNrRnJhbWUKICovCmZ1bmN0aW9uIGNhbGxGcmFtZVRvU3RhY2tGcmFtZSgKICBmcmFtZSwKICB1cmwsCiAgZ2V0TW9kdWxlRnJvbUZpbGVuYW1lLAopIHsKICBjb25zdCBmaWxlbmFtZSA9IHVybCA/IHVybC5yZXBsYWNlKC9eZmlsZTpcL1wvLywgJycpIDogdW5kZWZpbmVkOwoKICAvLyBDYWxsRnJhbWUgcm93L2NvbCBhcmUgMCBiYXNlZCwgd2hlcmVhcyBTdGFja0ZyYW1lIGFyZSAxIGJhc2VkCiAgY29uc3QgY29sbm8gPSBmcmFtZS5sb2NhdGlvbi5jb2x1bW5OdW1iZXIgPyBmcmFtZS5sb2NhdGlvbi5jb2x1bW5OdW1iZXIgKyAxIDogdW5kZWZpbmVkOwogIGNvbnN0IGxpbmVubyA9IGZyYW1lLmxvY2F0aW9uLmxpbmVOdW1iZXIgPyBmcmFtZS5sb2NhdGlvbi5saW5lTnVtYmVyICsgMSA6IHVuZGVmaW5lZDsKCiAgcmV0dXJuIGRyb3BVbmRlZmluZWRLZXlzKHsKICAgIGZpbGVuYW1lLAogICAgbW9kdWxlOiBnZXRNb2R1bGVGcm9tRmlsZW5hbWUoZmlsZW5hbWUpLAogICAgZnVuY3Rpb246IGZyYW1lLmZ1bmN0aW9uTmFtZSB8fCAnPycsCiAgICBjb2xubywKICAgIGxpbmVubywKICAgIGluX2FwcDogZmlsZW5hbWUgPyBmaWxlbmFtZUlzSW5BcHAoZmlsZW5hbWUpIDogdW5kZWZpbmVkLAogIH0pOwp9CgovKioKICogVGhpcyBzZXJ2ZXMgYXMgYSBidWlsZCB0aW1lIGZsYWcgdGhhdCB3aWxsIGJlIHRydWUgYnkgZGVmYXVsdCwgYnV0IGZhbHNlIGluIG5vbi1kZWJ1ZyBidWlsZHMgb3IgaWYgdXNlcnMgcmVwbGFjZSBgX19TRU5UUllfREVCVUdfX2AgaW4gdGhlaXIgZ2VuZXJhdGVkIGNvZGUuCiAqCiAqIEFUVEVOVElPTjogVGhpcyBjb25zdGFudCBtdXN0IG5ldmVyIGNyb3NzIHBhY2thZ2UgYm91bmRhcmllcyAoaS5lLiBiZSBleHBvcnRlZCkgdG8gZ3VhcmFudGVlIHRoYXQgaXQgY2FuIGJlIHVzZWQgZm9yIHRyZWUgc2hha2luZy4KICovCmNvbnN0IERFQlVHX0JVSUxEID0gKHR5cGVvZiBfX1NFTlRSWV9ERUJVR19fID09PSAndW5kZWZpbmVkJyB8fCBfX1NFTlRSWV9ERUJVR19fKTsKCmNvbnN0IERFRkFVTFRfRU5WSVJPTk1FTlQgPSAncHJvZHVjdGlvbic7CgovKioKICogUmV0dXJucyB0aGUgZ2xvYmFsIGV2ZW50IHByb2Nlc3NvcnMuCiAqIEBkZXByZWNhdGVkIEdsb2JhbCBldmVudCBwcm9jZXNzb3JzIHdpbGwgYmUgcmVtb3ZlZCBpbiB2OC4KICovCmZ1bmN0aW9uIGdldEdsb2JhbEV2ZW50UHJvY2Vzc29ycygpIHsKICByZXR1cm4gZ2V0R2xvYmFsU2luZ2xldG9uKCdnbG9iYWxFdmVudFByb2Nlc3NvcnMnLCAoKSA9PiBbXSk7Cn0KCi8qKgogKiBQcm9jZXNzIGFuIGFycmF5IG9mIGV2ZW50IHByb2Nlc3NvcnMsIHJldHVybmluZyB0aGUgcHJvY2Vzc2VkIGV2ZW50IChvciBgbnVsbGAgaWYgdGhlIGV2ZW50IHdhcyBkcm9wcGVkKS4KICovCmZ1bmN0aW9uIG5vdGlmeUV2ZW50UHJvY2Vzc29ycygKICBwcm9jZXNzb3JzLAogIGV2ZW50LAogIGhpbnQsCiAgaW5kZXggPSAwLAopIHsKICByZXR1cm4gbmV3IFN5bmNQcm9taXNlKChyZXNvbHZlLCByZWplY3QpID0+IHsKICAgIGNvbnN0IHByb2Nlc3NvciA9IHByb2Nlc3NvcnNbaW5kZXhdOwogICAgaWYgKGV2ZW50ID09PSBudWxsIHx8IHR5cGVvZiBwcm9jZXNzb3IgIT09ICdmdW5jdGlvbicpIHsKICAgICAgcmVzb2x2ZShldmVudCk7CiAgICB9IGVsc2UgewogICAgICBjb25zdCByZXN1bHQgPSBwcm9jZXNzb3IoeyAuLi5ldmVudCB9LCBoaW50KSA7CgogICAgICBERUJVR19CVUlMRCAmJiBwcm9jZXNzb3IuaWQgJiYgcmVzdWx0ID09PSBudWxsICYmIGxvZ2dlci5sb2coYEV2ZW50IHByb2Nlc3NvciAiJHtwcm9jZXNzb3IuaWR9IiBkcm9wcGVkIGV2ZW50YCk7CgogICAgICBpZiAoaXNUaGVuYWJsZShyZXN1bHQpKSB7CiAgICAgICAgdm9pZCByZXN1bHQKICAgICAgICAgIC50aGVuKGZpbmFsID0+IG5vdGlmeUV2ZW50UHJvY2Vzc29ycyhwcm9jZXNzb3JzLCBmaW5hbCwgaGludCwgaW5kZXggKyAxKS50aGVuKHJlc29sdmUpKQogICAgICAgICAgLnRoZW4obnVsbCwgcmVqZWN0KTsKICAgICAgfSBlbHNlIHsKICAgICAgICB2b2lkIG5vdGlmeUV2ZW50UHJvY2Vzc29ycyhwcm9jZXNzb3JzLCByZXN1bHQsIGhpbnQsIGluZGV4ICsgMSkKICAgICAgICAgIC50aGVuKHJlc29sdmUpCiAgICAgICAgICAudGhlbihudWxsLCByZWplY3QpOwogICAgICB9CiAgICB9CiAgfSk7Cn0KCi8qKgogKiBDcmVhdGVzIGEgbmV3IGBTZXNzaW9uYCBvYmplY3QgYnkgc2V0dGluZyBjZXJ0YWluIGRlZmF1bHQgcGFyYW1ldGVycy4gSWYgb3B0aW9uYWwgQHBhcmFtIGNvbnRleHQKICogaXMgcGFzc2VkLCB0aGUgcGFzc2VkIHByb3BlcnRpZXMgYXJlIGFwcGxpZWQgdG8gdGhlIHNlc3Npb24gb2JqZWN0LgogKgogKiBAcGFyYW0gY29udGV4dCAob3B0aW9uYWwpIGFkZGl0aW9uYWwgcHJvcGVydGllcyB0byBiZSBhcHBsaWVkIHRvIHRoZSByZXR1cm5lZCBzZXNzaW9uIG9iamVjdAogKgogKiBAcmV0dXJucyBhIG5ldyBgU2Vzc2lvbmAgb2JqZWN0CiAqLwpmdW5jdGlvbiBtYWtlU2Vzc2lvbihjb250ZXh0KSB7CiAgLy8gQm90aCB0aW1lc3RhbXAgYW5kIHN0YXJ0ZWQgYXJlIGluIHNlY29uZHMgc2luY2UgdGhlIFVOSVggZXBvY2guCiAgY29uc3Qgc3RhcnRpbmdUaW1lID0gdGltZXN0YW1wSW5TZWNvbmRzKCk7CgogIGNvbnN0IHNlc3Npb24gPSB7CiAgICBzaWQ6IHV1aWQ0KCksCiAgICBpbml0OiB0cnVlLAogICAgdGltZXN0YW1wOiBzdGFydGluZ1RpbWUsCiAgICBzdGFydGVkOiBzdGFydGluZ1RpbWUsCiAgICBkdXJhdGlvbjogMCwKICAgIHN0YXR1czogJ29rJywKICAgIGVycm9yczogMCwKICAgIGlnbm9yZUR1cmF0aW9uOiBmYWxzZSwKICAgIHRvSlNPTjogKCkgPT4gc2Vzc2lvblRvSlNPTihzZXNzaW9uKSwKICB9OwoKICBpZiAoY29udGV4dCkgewogICAgdXBkYXRlU2Vzc2lvbihzZXNzaW9uLCBjb250ZXh0KTsKICB9CgogIHJldHVybiBzZXNzaW9uOwp9CgovKioKICogVXBkYXRlcyBhIHNlc3Npb24gb2JqZWN0IHdpdGggdGhlIHByb3BlcnRpZXMgcGFzc2VkIGluIHRoZSBjb250ZXh0LgogKgogKiBOb3RlIHRoYXQgdGhpcyBmdW5jdGlvbiBtdXRhdGVzIHRoZSBwYXNzZWQgb2JqZWN0IGFuZCByZXR1cm5zIHZvaWQuCiAqIChIYWQgdG8gZG8gdGhpcyBpbnN0ZWFkIG9mIHJldHVybmluZyBhIG5ldyBhbmQgdXBkYXRlZCBzZXNzaW9uIGJlY2F1c2UgY2xvc2luZyBhbmQgc2VuZGluZyBhIHNlc3Npb24KICogbWFrZXMgYW4gdXBkYXRlIHRvIHRoZSBzZXNzaW9uIGFmdGVyIGl0IHdhcyBwYXNzZWQgdG8gdGhlIHNlbmRpbmcgbG9naWMuCiAqIEBzZWUgQmFzZUNsaWVudC5jYXB0dXJlU2Vzc2lvbiApCiAqCiAqIEBwYXJhbSBzZXNzaW9uIHRoZSBgU2Vzc2lvbmAgdG8gdXBkYXRlCiAqIEBwYXJhbSBjb250ZXh0IHRoZSBgU2Vzc2lvbkNvbnRleHRgIGhvbGRpbmcgdGhlIHByb3BlcnRpZXMgdGhhdCBzaG91bGQgYmUgdXBkYXRlZCBpbiBAcGFyYW0gc2Vzc2lvbgogKi8KLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIGNvbXBsZXhpdHkKZnVuY3Rpb24gdXBkYXRlU2Vzc2lvbihzZXNzaW9uLCBjb250ZXh0ID0ge30pIHsKICBpZiAoY29udGV4dC51c2VyKSB7CiAgICBpZiAoIXNlc3Npb24uaXBBZGRyZXNzICYmIGNvbnRleHQudXNlci5pcF9hZGRyZXNzKSB7CiAgICAgIHNlc3Npb24uaXBBZGRyZXNzID0gY29udGV4dC51c2VyLmlwX2FkZHJlc3M7CiAgICB9CgogICAgaWYgKCFzZXNzaW9uLmRpZCAmJiAhY29udGV4dC5kaWQpIHsKICAgICAgc2Vzc2lvbi5kaWQgPSBjb250ZXh0LnVzZXIuaWQgfHwgY29udGV4dC51c2VyLmVtYWlsIHx8IGNvbnRleHQudXNlci51c2VybmFtZTsKICAgIH0KICB9CgogIHNlc3Npb24udGltZXN0YW1wID0gY29udGV4dC50aW1lc3RhbXAgfHwgdGltZXN0YW1wSW5TZWNvbmRzKCk7CgogIGlmIChjb250ZXh0LmFibm9ybWFsX21lY2hhbmlzbSkgewogICAgc2Vzc2lvbi5hYm5vcm1hbF9tZWNoYW5pc20gPSBjb250ZXh0LmFibm9ybWFsX21lY2hhbmlzbTsKICB9CgogIGlmIChjb250ZXh0Lmlnbm9yZUR1cmF0aW9uKSB7CiAgICBzZXNzaW9uLmlnbm9yZUR1cmF0aW9uID0gY29udGV4dC5pZ25vcmVEdXJhdGlvbjsKICB9CiAgaWYgKGNvbnRleHQuc2lkKSB7CiAgICAvLyBHb29kIGVub3VnaCB1dWlkIHZhbGlkYXRpb24uIOKAlCBLYW1pbAogICAgc2Vzc2lvbi5zaWQgPSBjb250ZXh0LnNpZC5sZW5ndGggPT09IDMyID8gY29udGV4dC5zaWQgOiB1dWlkNCgpOwogIH0KICBpZiAoY29udGV4dC5pbml0ICE9PSB1bmRlZmluZWQpIHsKICAgIHNlc3Npb24uaW5pdCA9IGNvbnRleHQuaW5pdDsKICB9CiAgaWYgKCFzZXNzaW9uLmRpZCAmJiBjb250ZXh0LmRpZCkgewogICAgc2Vzc2lvbi5kaWQgPSBgJHtjb250ZXh0LmRpZH1gOwogIH0KICBpZiAodHlwZW9mIGNvbnRleHQuc3RhcnRlZCA9PT0gJ251bWJlcicpIHsKICAgIHNlc3Npb24uc3RhcnRlZCA9IGNvbnRleHQuc3RhcnRlZDsKICB9CiAgaWYgKHNlc3Npb24uaWdub3JlRHVyYXRpb24pIHsKICAgIHNlc3Npb24uZHVyYXRpb24gPSB1bmRlZmluZWQ7CiAgfSBlbHNlIGlmICh0eXBlb2YgY29udGV4dC5kdXJhdGlvbiA9PT0gJ251bWJlcicpIHsKICAgIHNlc3Npb24uZHVyYXRpb24gPSBjb250ZXh0LmR1cmF0aW9uOwogIH0gZWxzZSB7CiAgICBjb25zdCBkdXJhdGlvbiA9IHNlc3Npb24udGltZXN0YW1wIC0gc2Vzc2lvbi5zdGFydGVkOwogICAgc2Vzc2lvbi5kdXJhdGlvbiA9IGR1cmF0aW9uID49IDAgPyBkdXJhdGlvbiA6IDA7CiAgfQogIGlmIChjb250ZXh0LnJlbGVhc2UpIHsKICAgIHNlc3Npb24ucmVsZWFzZSA9IGNvbnRleHQucmVsZWFzZTsKICB9CiAgaWYgKGNvbnRleHQuZW52aXJvbm1lbnQpIHsKICAgIHNlc3Npb24uZW52aXJvbm1lbnQgPSBjb250ZXh0LmVudmlyb25tZW50OwogIH0KICBpZiAoIXNlc3Npb24uaXBBZGRyZXNzICYmIGNvbnRleHQuaXBBZGRyZXNzKSB7CiAgICBzZXNzaW9uLmlwQWRkcmVzcyA9IGNvbnRleHQuaXBBZGRyZXNzOwogIH0KICBpZiAoIXNlc3Npb24udXNlckFnZW50ICYmIGNvbnRleHQudXNlckFnZW50KSB7CiAgICBzZXNzaW9uLnVzZXJBZ2VudCA9IGNvbnRleHQudXNlckFnZW50OwogIH0KICBpZiAodHlwZW9mIGNvbnRleHQuZXJyb3JzID09PSAnbnVtYmVyJykgewogICAgc2Vzc2lvbi5lcnJvcnMgPSBjb250ZXh0LmVycm9yczsKICB9CiAgaWYgKGNvbnRleHQuc3RhdHVzKSB7CiAgICBzZXNzaW9uLnN0YXR1cyA9IGNvbnRleHQuc3RhdHVzOwogIH0KfQoKLyoqCiAqIENsb3NlcyBhIHNlc3Npb24gYnkgc2V0dGluZyBpdHMgc3RhdHVzIGFuZCB1cGRhdGluZyB0aGUgc2Vzc2lvbiBvYmplY3Qgd2l0aCBpdC4KICogSW50ZXJuYWxseSBjYWxscyBgdXBkYXRlU2Vzc2lvbmAgdG8gdXBkYXRlIHRoZSBwYXNzZWQgc2Vzc2lvbiBvYmplY3QuCiAqCiAqIE5vdGUgdGhhdCB0aGlzIGZ1bmN0aW9uIG11dGF0ZXMgdGhlIHBhc3NlZCBzZXNzaW9uIChAc2VlIHVwZGF0ZVNlc3Npb24gZm9yIGV4cGxhbmF0aW9uKS4KICoKICogQHBhcmFtIHNlc3Npb24gdGhlIGBTZXNzaW9uYCBvYmplY3QgdG8gYmUgY2xvc2VkCiAqIEBwYXJhbSBzdGF0dXMgdGhlIGBTZXNzaW9uU3RhdHVzYCB3aXRoIHdoaWNoIHRoZSBzZXNzaW9uIHdhcyBjbG9zZWQuIElmIHlvdSBkb24ndCBwYXNzIGEgc3RhdHVzLAogKiAgICAgICAgICAgICAgIHRoaXMgZnVuY3Rpb24gd2lsbCBrZWVwIHRoZSBwcmV2aW91c2x5IHNldCBzdGF0dXMsIHVubGVzcyBpdCB3YXMgYCdvaydgIGluIHdoaWNoIGNhc2UKICogICAgICAgICAgICAgICBpdCBpcyBjaGFuZ2VkIHRvIGAnZXhpdGVkJ2AuCiAqLwpmdW5jdGlvbiBjbG9zZVNlc3Npb24oc2Vzc2lvbiwgc3RhdHVzKSB7CiAgbGV0IGNvbnRleHQgPSB7fTsKICBpZiAoc3RhdHVzKSB7CiAgICBjb250ZXh0ID0geyBzdGF0dXMgfTsKICB9IGVsc2UgaWYgKHNlc3Npb24uc3RhdHVzID09PSAnb2snKSB7CiAgICBjb250ZXh0ID0geyBzdGF0dXM6ICdleGl0ZWQnIH07CiAgfQoKICB1cGRhdGVTZXNzaW9uKHNlc3Npb24sIGNvbnRleHQpOwp9CgovKioKICogU2VyaWFsaXplcyBhIHBhc3NlZCBzZXNzaW9uIG9iamVjdCB0byBhIEpTT04gb2JqZWN0IHdpdGggYSBzbGlnaHRseSBkaWZmZXJlbnQgc3RydWN0dXJlLgogKiBUaGlzIGlzIG5lY2Vzc2FyeSBiZWNhdXNlIHRoZSBTZW50cnkgYmFja2VuZCByZXF1aXJlcyBhIHNsaWdodGx5IGRpZmZlcmVudCBzY2hlbWEgb2YgYSBzZXNzaW9uCiAqIHRoYW4gdGhlIG9uZSB0aGUgSlMgU0RLcyB1c2UgaW50ZXJuYWxseS4KICoKICogQHBhcmFtIHNlc3Npb24gdGhlIHNlc3Npb24gdG8gYmUgY29udmVydGVkCiAqCiAqIEByZXR1cm5zIGEgSlNPTiBvYmplY3Qgb2YgdGhlIHBhc3NlZCBzZXNzaW9uCiAqLwpmdW5jdGlvbiBzZXNzaW9uVG9KU09OKHNlc3Npb24pIHsKICByZXR1cm4gZHJvcFVuZGVmaW5lZEtleXMoewogICAgc2lkOiBgJHtzZXNzaW9uLnNpZH1gLAogICAgaW5pdDogc2Vzc2lvbi5pbml0LAogICAgLy8gTWFrZSBzdXJlIHRoYXQgc2VjIGlzIGNvbnZlcnRlZCB0byBtcyBmb3IgZGF0ZSBjb25zdHJ1Y3RvcgogICAgc3RhcnRlZDogbmV3IERhdGUoc2Vzc2lvbi5zdGFydGVkICogMTAwMCkudG9JU09TdHJpbmcoKSwKICAgIHRpbWVzdGFtcDogbmV3IERhdGUoc2Vzc2lvbi50aW1lc3RhbXAgKiAxMDAwKS50b0lTT1N0cmluZygpLAogICAgc3RhdHVzOiBzZXNzaW9uLnN0YXR1cywKICAgIGVycm9yczogc2Vzc2lvbi5lcnJvcnMsCiAgICBkaWQ6IHR5cGVvZiBzZXNzaW9uLmRpZCA9PT0gJ251bWJlcicgfHwgdHlwZW9mIHNlc3Npb24uZGlkID09PSAnc3RyaW5nJyA/IGAke3Nlc3Npb24uZGlkfWAgOiB1bmRlZmluZWQsCiAgICBkdXJhdGlvbjogc2Vzc2lvbi5kdXJhdGlvbiwKICAgIGFibm9ybWFsX21lY2hhbmlzbTogc2Vzc2lvbi5hYm5vcm1hbF9tZWNoYW5pc20sCiAgICBhdHRyczogewogICAgICByZWxlYXNlOiBzZXNzaW9uLnJlbGVhc2UsCiAgICAgIGVudmlyb25tZW50OiBzZXNzaW9uLmVudmlyb25tZW50LAogICAgICBpcF9hZGRyZXNzOiBzZXNzaW9uLmlwQWRkcmVzcywKICAgICAgdXNlcl9hZ2VudDogc2Vzc2lvbi51c2VyQWdlbnQsCiAgICB9LAogIH0pOwp9Cgpjb25zdCBUUkFDRV9GTEFHX1NBTVBMRUQgPSAweDE7CgovKioKICogQ29udmVydCBhIHNwYW4gdG8gYSB0cmFjZSBjb250ZXh0LCB3aGljaCBjYW4gYmUgc2VudCBhcyB0aGUgYHRyYWNlYCBjb250ZXh0IGluIGFuIGV2ZW50LgogKi8KZnVuY3Rpb24gc3BhblRvVHJhY2VDb250ZXh0KHNwYW4pIHsKICBjb25zdCB7IHNwYW5JZDogc3Bhbl9pZCwgdHJhY2VJZDogdHJhY2VfaWQgfSA9IHNwYW4uc3BhbkNvbnRleHQoKTsKICBjb25zdCB7IGRhdGEsIG9wLCBwYXJlbnRfc3Bhbl9pZCwgc3RhdHVzLCB0YWdzLCBvcmlnaW4gfSA9IHNwYW5Ub0pTT04oc3Bhbik7CgogIHJldHVybiBkcm9wVW5kZWZpbmVkS2V5cyh7CiAgICBkYXRhLAogICAgb3AsCiAgICBwYXJlbnRfc3Bhbl9pZCwKICAgIHNwYW5faWQsCiAgICBzdGF0dXMsCiAgICB0YWdzLAogICAgdHJhY2VfaWQsCiAgICBvcmlnaW4sCiAgfSk7Cn0KCi8qKgogKiBDb252ZXJ0IGEgc3BhbiB0byBhIEpTT04gcmVwcmVzZW50YXRpb24uCiAqIE5vdGUgdGhhdCBhbGwgZmllbGRzIHJldHVybmVkIGhlcmUgYXJlIG9wdGlvbmFsIGFuZCBuZWVkIHRvIGJlIGd1YXJkZWQgYWdhaW5zdC4KICoKICogTm90ZTogQmVjYXVzZSBvZiB0aGlzLCB3ZSBjdXJyZW50bHkgaGF2ZSBhIGNpcmN1bGFyIHR5cGUgZGVwZW5kZW5jeSAod2hpY2ggd2Ugb3B0ZWQgb3V0IG9mIGluIHBhY2thZ2UuanNvbikuCiAqIFRoaXMgaXMgbm90IGF2b2lkYWJsZSBhcyB3ZSBuZWVkIGBzcGFuVG9KU09OYCBpbiBgc3BhblV0aWxzLnRzYCwgd2hpY2ggaW4gdHVybiBpcyBuZWVkZWQgYnkgYHNwYW4udHNgIGZvciBiYWNrd2FyZHMgY29tcGF0aWJpbGl0eS4KICogQW5kIGBzcGFuVG9KU09OYCBuZWVkcyB0aGUgU3BhbiBjbGFzcyBmcm9tIGBzcGFuLnRzYCB0byBjaGVjayBoZXJlLgogKiBUT0RPIHY4OiBXaGVuIHdlIHJlbW92ZSB0aGUgZGVwcmVjYXRlZCBzdHVmZiBmcm9tIGBzcGFuLnRzYCwgd2UgY2FuIHJlbW92ZSB0aGUgY2lyY3VsYXIgZGVwZW5kZW5jeSBhZ2Fpbi4KICovCmZ1bmN0aW9uIHNwYW5Ub0pTT04oc3BhbikgewogIGlmIChzcGFuSXNTcGFuQ2xhc3Moc3BhbikpIHsKICAgIHJldHVybiBzcGFuLmdldFNwYW5KU09OKCk7CiAgfQoKICAvLyBGYWxsYmFjazogV2UgYWxzbyBjaGVjayBmb3IgYC50b0pTT04oKWAgaGVyZS4uLgogIC8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBkZXByZWNhdGlvbi9kZXByZWNhdGlvbgogIGlmICh0eXBlb2Ygc3Bhbi50b0pTT04gPT09ICdmdW5jdGlvbicpIHsKICAgIC8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBkZXByZWNhdGlvbi9kZXByZWNhdGlvbgogICAgcmV0dXJuIHNwYW4udG9KU09OKCk7CiAgfQoKICByZXR1cm4ge307Cn0KCi8qKgogKiBTYWRseSwgZHVlIHRvIGNpcmN1bGFyIGRlcGVuZGVuY3kgY2hlY2tzIHdlIGNhbm5vdCBhY3R1YWxseSBpbXBvcnQgdGhlIFNwYW4gY2xhc3MgaGVyZSBhbmQgY2hlY2sgZm9yIGluc3RhbmNlb2YuCiAqIDooIFNvIGluc3RlYWQgd2UgYXBwcm94aW1hdGUgdGhpcyBieSBjaGVja2luZyBpZiBpdCBoYXMgdGhlIGBnZXRTcGFuSlNPTmAgbWV0aG9kLgogKi8KZnVuY3Rpb24gc3BhbklzU3BhbkNsYXNzKHNwYW4pIHsKICByZXR1cm4gdHlwZW9mIChzcGFuICkuZ2V0U3BhbkpTT04gPT09ICdmdW5jdGlvbic7Cn0KCi8qKgogKiBSZXR1cm5zIHRydWUgaWYgYSBzcGFuIGlzIHNhbXBsZWQuCiAqIEluIG1vc3QgY2FzZXMsIHlvdSBzaG91bGQganVzdCB1c2UgYHNwYW4uaXNSZWNvcmRpbmcoKWAgaW5zdGVhZC4KICogSG93ZXZlciwgdGhpcyBoYXMgYSBzbGlnaHRseSBkaWZmZXJlbnQgc2VtYW50aWMsIGFzIGl0IGFsc28gcmV0dXJucyBmYWxzZSBpZiB0aGUgc3BhbiBpcyBmaW5pc2hlZC4KICogU28gaW4gdGhlIGNhc2Ugd2hlcmUgdGhpcyBkaXN0aW5jdGlvbiBpcyBpbXBvcnRhbnQsIHVzZSB0aGlzIG1ldGhvZC4KICovCmZ1bmN0aW9uIHNwYW5Jc1NhbXBsZWQoc3BhbikgewogIC8vIFdlIGFsaWduIG91ciB0cmFjZSBmbGFncyB3aXRoIHRoZSBvbmVzIE9wZW5UZWxlbWV0cnkgdXNlCiAgLy8gU28gd2UgYWxzbyBjaGVjayBmb3Igc2FtcGxlZCB0aGUgc2FtZSB3YXkgdGhleSBkby4KICBjb25zdCB7IHRyYWNlRmxhZ3MgfSA9IHNwYW4uc3BhbkNvbnRleHQoKTsKICAvLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgbm8tYml0d2lzZQogIHJldHVybiBCb29sZWFuKHRyYWNlRmxhZ3MgJiBUUkFDRV9GTEFHX1NBTVBMRUQpOwp9CgovKioKICogR2V0IHRoZSBjdXJyZW50bHkgYWN0aXZlIGNsaWVudC4KICovCmZ1bmN0aW9uIGdldENsaWVudCgpIHsKICAvLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgZGVwcmVjYXRpb24vZGVwcmVjYXRpb24KICByZXR1cm4gZ2V0Q3VycmVudEh1YigpLmdldENsaWVudCgpOwp9CgovKioKICogR2V0IHRoZSBjdXJyZW50bHkgYWN0aXZlIHNjb3BlLgogKi8KZnVuY3Rpb24gZ2V0Q3VycmVudFNjb3BlKCkgewogIC8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBkZXByZWNhdGlvbi9kZXByZWNhdGlvbgogIHJldHVybiBnZXRDdXJyZW50SHViKCkuZ2V0U2NvcGUoKTsKfQoKLyoqCiAqIFJldHVybnMgdGhlIHJvb3Qgc3BhbiBvZiBhIGdpdmVuIHNwYW4uCiAqCiAqIEFzIGxvbmcgYXMgd2UgdXNlIGBUcmFuc2FjdGlvbmBzIGludGVybmFsbHksIHRoZSByZXR1cm5lZCByb290IHNwYW4KICogd2lsbCBiZSBhIGBUcmFuc2FjdGlvbmAgYnV0IGJlIGF3YXJlIHRoYXQgdGhpcyBtaWdodCBjaGFuZ2UgaW4gdGhlIGZ1dHVyZS4KICoKICogSWYgdGhlIGdpdmVuIHNwYW4gaGFzIG5vIHJvb3Qgc3BhbiBvciB0cmFuc2FjdGlvbiwgYHVuZGVmaW5lZGAgaXMgcmV0dXJuZWQuCiAqLwpmdW5jdGlvbiBnZXRSb290U3BhbihzcGFuKSB7CiAgLy8gVE9ETyAodjgpOiBSZW1vdmUgdGhpcyBjaGVjayBhbmQganVzdCByZXR1cm4gc3BhbgogIC8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBkZXByZWNhdGlvbi9kZXByZWNhdGlvbgogIHJldHVybiBzcGFuLnRyYW5zYWN0aW9uOwp9CgovKioKICogQ3JlYXRlcyBhIGR5bmFtaWMgc2FtcGxpbmcgY29udGV4dCBmcm9tIGEgY2xpZW50LgogKgogKiBEaXNwYXRjaGVzIHRoZSBgY3JlYXRlRHNjYCBsaWZlY3ljbGUgaG9vayBhcyBhIHNpZGUgZWZmZWN0LgogKi8KZnVuY3Rpb24gZ2V0RHluYW1pY1NhbXBsaW5nQ29udGV4dEZyb21DbGllbnQoCiAgdHJhY2VfaWQsCiAgY2xpZW50LAogIHNjb3BlLAopIHsKICBjb25zdCBvcHRpb25zID0gY2xpZW50LmdldE9wdGlvbnMoKTsKCiAgY29uc3QgeyBwdWJsaWNLZXk6IHB1YmxpY19rZXkgfSA9IGNsaWVudC5nZXREc24oKSB8fCB7fTsKICAvLyBUT0RPKHY4KTogUmVtb3ZlIHNlZ21lbnQgZnJvbSBVc2VyCiAgLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIGRlcHJlY2F0aW9uL2RlcHJlY2F0aW9uCiAgY29uc3QgeyBzZWdtZW50OiB1c2VyX3NlZ21lbnQgfSA9IChzY29wZSAmJiBzY29wZS5nZXRVc2VyKCkpIHx8IHt9OwoKICBjb25zdCBkc2MgPSBkcm9wVW5kZWZpbmVkS2V5cyh7CiAgICBlbnZpcm9ubWVudDogb3B0aW9ucy5lbnZpcm9ubWVudCB8fCBERUZBVUxUX0VOVklST05NRU5ULAogICAgcmVsZWFzZTogb3B0aW9ucy5yZWxlYXNlLAogICAgdXNlcl9zZWdtZW50LAogICAgcHVibGljX2tleSwKICAgIHRyYWNlX2lkLAogIH0pIDsKCiAgY2xpZW50LmVtaXQgJiYgY2xpZW50LmVtaXQoJ2NyZWF0ZURzYycsIGRzYyk7CgogIHJldHVybiBkc2M7Cn0KCi8qKgogKiBBIFNwYW4gd2l0aCBhIGZyb3plbiBkeW5hbWljIHNhbXBsaW5nIGNvbnRleHQuCiAqLwoKLyoqCiAqIENyZWF0ZXMgYSBkeW5hbWljIHNhbXBsaW5nIGNvbnRleHQgZnJvbSBhIHNwYW4gKGFuZCBjbGllbnQgYW5kIHNjb3BlKQogKgogKiBAcGFyYW0gc3BhbiB0aGUgc3BhbiBmcm9tIHdoaWNoIGEgZmV3IHZhbHVlcyBsaWtlIHRoZSByb290IHNwYW4gbmFtZSBhbmQgc2FtcGxlIHJhdGUgYXJlIGV4dHJhY3RlZC4KICoKICogQHJldHVybnMgYSBkeW5hbWljIHNhbXBsaW5nIGNvbnRleHQKICovCmZ1bmN0aW9uIGdldER5bmFtaWNTYW1wbGluZ0NvbnRleHRGcm9tU3BhbihzcGFuKSB7CiAgY29uc3QgY2xpZW50ID0gZ2V0Q2xpZW50KCk7CiAgaWYgKCFjbGllbnQpIHsKICAgIHJldHVybiB7fTsKICB9CgogIC8vIHBhc3NpbmcgZW1pdD1mYWxzZSBoZXJlIHRvIG9ubHkgZW1pdCBsYXRlciBvbmNlIHRoZSBEU0MgaXMgYWN0dWFsbHkgcG9wdWxhdGVkCiAgY29uc3QgZHNjID0gZ2V0RHluYW1pY1NhbXBsaW5nQ29udGV4dEZyb21DbGllbnQoc3BhblRvSlNPTihzcGFuKS50cmFjZV9pZCB8fCAnJywgY2xpZW50LCBnZXRDdXJyZW50U2NvcGUoKSk7CgogIC8vIFRPRE8gKHY4KTogUmVtb3ZlIHY3RnJvemVuRHNjIGFzIGEgVHJhbnNhY3Rpb24gd2lsbCBubyBsb25nZXIgaGF2ZSBfZnJvemVuRHluYW1pY1NhbXBsaW5nQ29udGV4dAogIGNvbnN0IHR4biA9IGdldFJvb3RTcGFuKHNwYW4pIDsKICBpZiAoIXR4bikgewogICAgcmV0dXJuIGRzYzsKICB9CgogIC8vIFRPRE8gKHY4KTogUmVtb3ZlIHY3RnJvemVuRHNjIGFzIGEgVHJhbnNhY3Rpb24gd2lsbCBubyBsb25nZXIgaGF2ZSBfZnJvemVuRHluYW1pY1NhbXBsaW5nQ29udGV4dAogIC8vIEZvciBub3cgd2UgbmVlZCB0byBhdm9pZCBicmVha2luZyB1c2VycyB3aG8gZGlyZWN0bHkgY3JlYXRlZCBhIHR4biB3aXRoIGEgRFNDLCB3aGVyZSB0aGlzIGZpZWxkIGlzIHN0aWxsIHNldC4KICAvLyBAc2VlIFRyYW5zYWN0aW9uIGNsYXNzIGNvbnN0cnVjdG9yCiAgY29uc3QgdjdGcm96ZW5Ec2MgPSB0eG4gJiYgdHhuLl9mcm96ZW5EeW5hbWljU2FtcGxpbmdDb250ZXh0OwogIGlmICh2N0Zyb3plbkRzYykgewogICAgcmV0dXJuIHY3RnJvemVuRHNjOwogIH0KCiAgLy8gVE9ETyAodjgpOiBSZXBsYWNlIHR4bi5tZXRhZGF0YSB3aXRoIHR4bi5hdHRyaWJ1dGVzW10KICAvLyBXZSBjYW4ndCBkbyB0aGlzIHlldCBiZWNhdXNlIGF0dHJpYnV0ZXMgYXJlbid0IGFsd2F5cyBzZXQgeWV0LgogIC8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBkZXByZWNhdGlvbi9kZXByZWNhdGlvbgogIGNvbnN0IHsgc2FtcGxlUmF0ZTogbWF5YmVTYW1wbGVSYXRlLCBzb3VyY2UgfSA9IHR4bi5tZXRhZGF0YTsKICBpZiAobWF5YmVTYW1wbGVSYXRlICE9IG51bGwpIHsKICAgIGRzYy5zYW1wbGVfcmF0ZSA9IGAke21heWJlU2FtcGxlUmF0ZX1gOwogIH0KCiAgLy8gV2UgZG9uJ3Qgd2FudCB0byBoYXZlIGEgdHJhbnNhY3Rpb24gbmFtZSBpbiB0aGUgRFNDIGlmIHRoZSBzb3VyY2UgaXMgInVybCIgYmVjYXVzZSBVUkxzIG1pZ2h0IGNvbnRhaW4gUElJCiAgY29uc3QganNvblNwYW4gPSBzcGFuVG9KU09OKHR4bik7CgogIC8vIGFmdGVyIEpTT04gY29udmVyc2lvbiwgdHhuLm5hbWUgYmVjb21lcyBqc29uU3Bhbi5kZXNjcmlwdGlvbgogIGlmIChzb3VyY2UgJiYgc291cmNlICE9PSAndXJsJykgewogICAgZHNjLnRyYW5zYWN0aW9uID0ganNvblNwYW4uZGVzY3JpcHRpb247CiAgfQoKICBkc2Muc2FtcGxlZCA9IFN0cmluZyhzcGFuSXNTYW1wbGVkKHR4bikpOwoKICBjbGllbnQuZW1pdCAmJiBjbGllbnQuZW1pdCgnY3JlYXRlRHNjJywgZHNjKTsKCiAgcmV0dXJuIGRzYzsKfQoKLyoqCiAqIEFwcGxpZXMgZGF0YSBmcm9tIHRoZSBzY29wZSB0byB0aGUgZXZlbnQgYW5kIHJ1bnMgYWxsIGV2ZW50IHByb2Nlc3NvcnMgb24gaXQuCiAqLwpmdW5jdGlvbiBhcHBseVNjb3BlRGF0YVRvRXZlbnQoZXZlbnQsIGRhdGEpIHsKICBjb25zdCB7IGZpbmdlcnByaW50LCBzcGFuLCBicmVhZGNydW1icywgc2RrUHJvY2Vzc2luZ01ldGFkYXRhIH0gPSBkYXRhOwoKICAvLyBBcHBseSBnZW5lcmFsIGRhdGEKICBhcHBseURhdGFUb0V2ZW50KGV2ZW50LCBkYXRhKTsKCiAgLy8gV2Ugd2FudCB0byBzZXQgdGhlIHRyYWNlIGNvbnRleHQgZm9yIG5vcm1hbCBldmVudHMgb25seSBpZiB0aGVyZSBpc24ndCBhbHJlYWR5CiAgLy8gYSB0cmFjZSBjb250ZXh0IG9uIHRoZSBldmVudC4gVGhlcmUgaXMgYSBwcm9kdWN0IGZlYXR1cmUgaW4gcGxhY2Ugd2hlcmUgd2UgbGluawogIC8vIGVycm9ycyB3aXRoIHRyYW5zYWN0aW9uIGFuZCBpdCByZWxpZXMgb24gdGhhdC4KICBpZiAoc3BhbikgewogICAgYXBwbHlTcGFuVG9FdmVudChldmVudCwgc3Bhbik7CiAgfQoKICBhcHBseUZpbmdlcnByaW50VG9FdmVudChldmVudCwgZmluZ2VycHJpbnQpOwogIGFwcGx5QnJlYWRjcnVtYnNUb0V2ZW50KGV2ZW50LCBicmVhZGNydW1icyk7CiAgYXBwbHlTZGtNZXRhZGF0YVRvRXZlbnQoZXZlbnQsIHNka1Byb2Nlc3NpbmdNZXRhZGF0YSk7Cn0KCmZ1bmN0aW9uIGFwcGx5RGF0YVRvRXZlbnQoZXZlbnQsIGRhdGEpIHsKICBjb25zdCB7CiAgICBleHRyYSwKICAgIHRhZ3MsCiAgICB1c2VyLAogICAgY29udGV4dHMsCiAgICBsZXZlbCwKICAgIC8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBkZXByZWNhdGlvbi9kZXByZWNhdGlvbgogICAgdHJhbnNhY3Rpb25OYW1lLAogIH0gPSBkYXRhOwoKICBjb25zdCBjbGVhbmVkRXh0cmEgPSBkcm9wVW5kZWZpbmVkS2V5cyhleHRyYSk7CiAgaWYgKGNsZWFuZWRFeHRyYSAmJiBPYmplY3Qua2V5cyhjbGVhbmVkRXh0cmEpLmxlbmd0aCkgewogICAgZXZlbnQuZXh0cmEgPSB7IC4uLmNsZWFuZWRFeHRyYSwgLi4uZXZlbnQuZXh0cmEgfTsKICB9CgogIGNvbnN0IGNsZWFuZWRUYWdzID0gZHJvcFVuZGVmaW5lZEtleXModGFncyk7CiAgaWYgKGNsZWFuZWRUYWdzICYmIE9iamVjdC5rZXlzKGNsZWFuZWRUYWdzKS5sZW5ndGgpIHsKICAgIGV2ZW50LnRhZ3MgPSB7IC4uLmNsZWFuZWRUYWdzLCAuLi5ldmVudC50YWdzIH07CiAgfQoKICBjb25zdCBjbGVhbmVkVXNlciA9IGRyb3BVbmRlZmluZWRLZXlzKHVzZXIpOwogIGlmIChjbGVhbmVkVXNlciAmJiBPYmplY3Qua2V5cyhjbGVhbmVkVXNlcikubGVuZ3RoKSB7CiAgICBldmVudC51c2VyID0geyAuLi5jbGVhbmVkVXNlciwgLi4uZXZlbnQudXNlciB9OwogIH0KCiAgY29uc3QgY2xlYW5lZENvbnRleHRzID0gZHJvcFVuZGVmaW5lZEtleXMoY29udGV4dHMpOwogIGlmIChjbGVhbmVkQ29udGV4dHMgJiYgT2JqZWN0LmtleXMoY2xlYW5lZENvbnRleHRzKS5sZW5ndGgpIHsKICAgIGV2ZW50LmNvbnRleHRzID0geyAuLi5jbGVhbmVkQ29udGV4dHMsIC4uLmV2ZW50LmNvbnRleHRzIH07CiAgfQoKICBpZiAobGV2ZWwpIHsKICAgIGV2ZW50LmxldmVsID0gbGV2ZWw7CiAgfQoKICBpZiAodHJhbnNhY3Rpb25OYW1lKSB7CiAgICBldmVudC50cmFuc2FjdGlvbiA9IHRyYW5zYWN0aW9uTmFtZTsKICB9Cn0KCmZ1bmN0aW9uIGFwcGx5QnJlYWRjcnVtYnNUb0V2ZW50KGV2ZW50LCBicmVhZGNydW1icykgewogIGNvbnN0IG1lcmdlZEJyZWFkY3J1bWJzID0gWy4uLihldmVudC5icmVhZGNydW1icyB8fCBbXSksIC4uLmJyZWFkY3J1bWJzXTsKICBldmVudC5icmVhZGNydW1icyA9IG1lcmdlZEJyZWFkY3J1bWJzLmxlbmd0aCA/IG1lcmdlZEJyZWFkY3J1bWJzIDogdW5kZWZpbmVkOwp9CgpmdW5jdGlvbiBhcHBseVNka01ldGFkYXRhVG9FdmVudChldmVudCwgc2RrUHJvY2Vzc2luZ01ldGFkYXRhKSB7CiAgZXZlbnQuc2RrUHJvY2Vzc2luZ01ldGFkYXRhID0gewogICAgLi4uZXZlbnQuc2RrUHJvY2Vzc2luZ01ldGFkYXRhLAogICAgLi4uc2RrUHJvY2Vzc2luZ01ldGFkYXRhLAogIH07Cn0KCmZ1bmN0aW9uIGFwcGx5U3BhblRvRXZlbnQoZXZlbnQsIHNwYW4pIHsKICBldmVudC5jb250ZXh0cyA9IHsgdHJhY2U6IHNwYW5Ub1RyYWNlQ29udGV4dChzcGFuKSwgLi4uZXZlbnQuY29udGV4dHMgfTsKICBjb25zdCByb290U3BhbiA9IGdldFJvb3RTcGFuKHNwYW4pOwogIGlmIChyb290U3BhbikgewogICAgZXZlbnQuc2RrUHJvY2Vzc2luZ01ldGFkYXRhID0gewogICAgICBkeW5hbWljU2FtcGxpbmdDb250ZXh0OiBnZXREeW5hbWljU2FtcGxpbmdDb250ZXh0RnJvbVNwYW4oc3BhbiksCiAgICAgIC4uLmV2ZW50LnNka1Byb2Nlc3NpbmdNZXRhZGF0YSwKICAgIH07CiAgICBjb25zdCB0cmFuc2FjdGlvbk5hbWUgPSBzcGFuVG9KU09OKHJvb3RTcGFuKS5kZXNjcmlwdGlvbjsKICAgIGlmICh0cmFuc2FjdGlvbk5hbWUpIHsKICAgICAgZXZlbnQudGFncyA9IHsgdHJhbnNhY3Rpb246IHRyYW5zYWN0aW9uTmFtZSwgLi4uZXZlbnQudGFncyB9OwogICAgfQogIH0KfQoKLyoqCiAqIEFwcGxpZXMgZmluZ2VycHJpbnQgZnJvbSB0aGUgc2NvcGUgdG8gdGhlIGV2ZW50IGlmIHRoZXJlJ3Mgb25lLAogKiB1c2VzIG1lc3NhZ2UgaWYgdGhlcmUncyBvbmUgaW5zdGVhZCBvciBnZXQgcmlkIG9mIGVtcHR5IGZpbmdlcnByaW50CiAqLwpmdW5jdGlvbiBhcHBseUZpbmdlcnByaW50VG9FdmVudChldmVudCwgZmluZ2VycHJpbnQpIHsKICAvLyBNYWtlIHN1cmUgaXQncyBhbiBhcnJheSBmaXJzdCBhbmQgd2UgYWN0dWFsbHkgaGF2ZSBzb21ldGhpbmcgaW4gcGxhY2UKICBldmVudC5maW5nZXJwcmludCA9IGV2ZW50LmZpbmdlcnByaW50ID8gYXJyYXlpZnkoZXZlbnQuZmluZ2VycHJpbnQpIDogW107CgogIC8vIElmIHdlIGhhdmUgc29tZXRoaW5nIG9uIHRoZSBzY29wZSwgdGhlbiBtZXJnZSBpdCB3aXRoIGV2ZW50CiAgaWYgKGZpbmdlcnByaW50KSB7CiAgICBldmVudC5maW5nZXJwcmludCA9IGV2ZW50LmZpbmdlcnByaW50LmNvbmNhdChmaW5nZXJwcmludCk7CiAgfQoKICAvLyBJZiB3ZSBoYXZlIG5vIGRhdGEgYXQgYWxsLCByZW1vdmUgZW1wdHkgYXJyYXkgZGVmYXVsdAogIGlmIChldmVudC5maW5nZXJwcmludCAmJiAhZXZlbnQuZmluZ2VycHJpbnQubGVuZ3RoKSB7CiAgICBkZWxldGUgZXZlbnQuZmluZ2VycHJpbnQ7CiAgfQp9CgovKioKICogRGVmYXVsdCB2YWx1ZSBmb3IgbWF4aW11bSBudW1iZXIgb2YgYnJlYWRjcnVtYnMgYWRkZWQgdG8gYW4gZXZlbnQuCiAqLwpjb25zdCBERUZBVUxUX01BWF9CUkVBRENSVU1CUyA9IDEwMDsKCi8qKgogKiBIb2xkcyBhZGRpdGlvbmFsIGV2ZW50IGluZm9ybWF0aW9uLiB7QGxpbmsgU2NvcGUuYXBwbHlUb0V2ZW50fSB3aWxsIGJlCiAqIGNhbGxlZCBieSB0aGUgY2xpZW50IGJlZm9yZSBhbiBldmVudCB3aWxsIGJlIHNlbnQuCiAqLwpjbGFzcyBTY29wZSAgewogIC8qKiBGbGFnIGlmIG5vdGlmeWluZyBpcyBoYXBwZW5pbmcuICovCgogIC8qKiBDYWxsYmFjayBmb3IgY2xpZW50IHRvIHJlY2VpdmUgc2NvcGUgY2hhbmdlcy4gKi8KCiAgLyoqIENhbGxiYWNrIGxpc3QgdGhhdCB3aWxsIGJlIGNhbGxlZCBhZnRlciB7QGxpbmsgYXBwbHlUb0V2ZW50fS4gKi8KCiAgLyoqIEFycmF5IG9mIGJyZWFkY3J1bWJzLiAqLwoKICAvKiogVXNlciAqLwoKICAvKiogVGFncyAqLwoKICAvKiogRXh0cmEgKi8KCiAgLyoqIENvbnRleHRzICovCgogIC8qKiBBdHRhY2htZW50cyAqLwoKICAvKiogUHJvcGFnYXRpb24gQ29udGV4dCBmb3IgZGlzdHJpYnV0ZWQgdHJhY2luZyAqLwoKICAvKioKICAgKiBBIHBsYWNlIHRvIHN0YXNoIGRhdGEgd2hpY2ggaXMgbmVlZGVkIGF0IHNvbWUgcG9pbnQgaW4gdGhlIFNESydzIGV2ZW50IHByb2Nlc3NpbmcgcGlwZWxpbmUgYnV0IHdoaWNoIHNob3VsZG4ndCBnZXQKICAgKiBzZW50IHRvIFNlbnRyeQogICAqLwoKICAvKiogRmluZ2VycHJpbnQgKi8KCiAgLyoqIFNldmVyaXR5ICovCiAgLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIGRlcHJlY2F0aW9uL2RlcHJlY2F0aW9uCgogIC8qKgogICAqIFRyYW5zYWN0aW9uIE5hbWUKICAgKi8KCiAgLyoqIFNwYW4gKi8KCiAgLyoqIFNlc3Npb24gKi8KCiAgLyoqIFJlcXVlc3QgTW9kZSBTZXNzaW9uIFN0YXR1cyAqLwoKICAvKiogVGhlIGNsaWVudCBvbiB0aGlzIHNjb3BlICovCgogIC8vIE5PVEU6IEFueSBmaWVsZCB3aGljaCBnZXRzIGFkZGVkIGhlcmUgc2hvdWxkIGdldCBhZGRlZCBub3Qgb25seSB0byB0aGUgY29uc3RydWN0b3IgYnV0IGFsc28gdG8gdGhlIGBjbG9uZWAgbWV0aG9kLgoKICAgY29uc3RydWN0b3IoKSB7CiAgICB0aGlzLl9ub3RpZnlpbmdMaXN0ZW5lcnMgPSBmYWxzZTsKICAgIHRoaXMuX3Njb3BlTGlzdGVuZXJzID0gW107CiAgICB0aGlzLl9ldmVudFByb2Nlc3NvcnMgPSBbXTsKICAgIHRoaXMuX2JyZWFkY3J1bWJzID0gW107CiAgICB0aGlzLl9hdHRhY2htZW50cyA9IFtdOwogICAgdGhpcy5fdXNlciA9IHt9OwogICAgdGhpcy5fdGFncyA9IHt9OwogICAgdGhpcy5fZXh0cmEgPSB7fTsKICAgIHRoaXMuX2NvbnRleHRzID0ge307CiAgICB0aGlzLl9zZGtQcm9jZXNzaW5nTWV0YWRhdGEgPSB7fTsKICAgIHRoaXMuX3Byb3BhZ2F0aW9uQ29udGV4dCA9IGdlbmVyYXRlUHJvcGFnYXRpb25Db250ZXh0KCk7CiAgfQoKICAvKioKICAgKiBJbmhlcml0IHZhbHVlcyBmcm9tIHRoZSBwYXJlbnQgc2NvcGUuCiAgICogQGRlcHJlY2F0ZWQgVXNlIGBzY29wZS5jbG9uZSgpYCBhbmQgYG5ldyBTY29wZSgpYCBpbnN0ZWFkLgogICAqLwogICBzdGF0aWMgY2xvbmUoc2NvcGUpIHsKICAgIHJldHVybiBzY29wZSA/IHNjb3BlLmNsb25lKCkgOiBuZXcgU2NvcGUoKTsKICB9CgogIC8qKgogICAqIENsb25lIHRoaXMgc2NvcGUgaW5zdGFuY2UuCiAgICovCiAgIGNsb25lKCkgewogICAgY29uc3QgbmV3U2NvcGUgPSBuZXcgU2NvcGUoKTsKICAgIG5ld1Njb3BlLl9icmVhZGNydW1icyA9IFsuLi50aGlzLl9icmVhZGNydW1ic107CiAgICBuZXdTY29wZS5fdGFncyA9IHsgLi4udGhpcy5fdGFncyB9OwogICAgbmV3U2NvcGUuX2V4dHJhID0geyAuLi50aGlzLl9leHRyYSB9OwogICAgbmV3U2NvcGUuX2NvbnRleHRzID0geyAuLi50aGlzLl9jb250ZXh0cyB9OwogICAgbmV3U2NvcGUuX3VzZXIgPSB0aGlzLl91c2VyOwogICAgbmV3U2NvcGUuX2xldmVsID0gdGhpcy5fbGV2ZWw7CiAgICBuZXdTY29wZS5fc3BhbiA9IHRoaXMuX3NwYW47CiAgICBuZXdTY29wZS5fc2Vzc2lvbiA9IHRoaXMuX3Nlc3Npb247CiAgICBuZXdTY29wZS5fdHJhbnNhY3Rpb25OYW1lID0gdGhpcy5fdHJhbnNhY3Rpb25OYW1lOwogICAgbmV3U2NvcGUuX2ZpbmdlcnByaW50ID0gdGhpcy5fZmluZ2VycHJpbnQ7CiAgICBuZXdTY29wZS5fZXZlbnRQcm9jZXNzb3JzID0gWy4uLnRoaXMuX2V2ZW50UHJvY2Vzc29yc107CiAgICBuZXdTY29wZS5fcmVxdWVzdFNlc3Npb24gPSB0aGlzLl9yZXF1ZXN0U2Vzc2lvbjsKICAgIG5ld1Njb3BlLl9hdHRhY2htZW50cyA9IFsuLi50aGlzLl9hdHRhY2htZW50c107CiAgICBuZXdTY29wZS5fc2RrUHJvY2Vzc2luZ01ldGFkYXRhID0geyAuLi50aGlzLl9zZGtQcm9jZXNzaW5nTWV0YWRhdGEgfTsKICAgIG5ld1Njb3BlLl9wcm9wYWdhdGlvbkNvbnRleHQgPSB7IC4uLnRoaXMuX3Byb3BhZ2F0aW9uQ29udGV4dCB9OwogICAgbmV3U2NvcGUuX2NsaWVudCA9IHRoaXMuX2NsaWVudDsKCiAgICByZXR1cm4gbmV3U2NvcGU7CiAgfQoKICAvKiogVXBkYXRlIHRoZSBjbGllbnQgb24gdGhlIHNjb3BlLiAqLwogICBzZXRDbGllbnQoY2xpZW50KSB7CiAgICB0aGlzLl9jbGllbnQgPSBjbGllbnQ7CiAgfQoKICAvKioKICAgKiBHZXQgdGhlIGNsaWVudCBhc3NpZ25lZCB0byB0aGlzIHNjb3BlLgogICAqCiAgICogSXQgaXMgZ2VuZXJhbGx5IHJlY29tbWVuZGVkIHRvIHVzZSB0aGUgZ2xvYmFsIGZ1bmN0aW9uIGBTZW50cnkuZ2V0Q2xpZW50KClgIGluc3RlYWQsIHVubGVzcyB5b3Uga25vdyB3aGF0IHlvdSBhcmUgZG9pbmcuCiAgICovCiAgIGdldENsaWVudCgpIHsKICAgIHJldHVybiB0aGlzLl9jbGllbnQ7CiAgfQoKICAvKioKICAgKiBBZGQgaW50ZXJuYWwgb24gY2hhbmdlIGxpc3RlbmVyLiBVc2VkIGZvciBzdWIgU0RLcyB0aGF0IG5lZWQgdG8gc3RvcmUgdGhlIHNjb3BlLgogICAqIEBoaWRkZW4KICAgKi8KICAgYWRkU2NvcGVMaXN0ZW5lcihjYWxsYmFjaykgewogICAgdGhpcy5fc2NvcGVMaXN0ZW5lcnMucHVzaChjYWxsYmFjayk7CiAgfQoKICAvKioKICAgKiBAaW5oZXJpdERvYwogICAqLwogICBhZGRFdmVudFByb2Nlc3NvcihjYWxsYmFjaykgewogICAgdGhpcy5fZXZlbnRQcm9jZXNzb3JzLnB1c2goY2FsbGJhY2spOwogICAgcmV0dXJuIHRoaXM7CiAgfQoKICAvKioKICAgKiBAaW5oZXJpdERvYwogICAqLwogICBzZXRVc2VyKHVzZXIpIHsKICAgIC8vIElmIG51bGwgaXMgcGFzc2VkIHdlIHdhbnQgdG8gdW5zZXQgZXZlcnl0aGluZywgYnV0IHN0aWxsIGRlZmluZSBrZXlzLAogICAgLy8gc28gdGhhdCBsYXRlciBkb3duIGluIHRoZSBwaXBlbGluZSBhbnkgZXhpc3RpbmcgdmFsdWVzIGFyZSBjbGVhcmVkLgogICAgdGhpcy5fdXNlciA9IHVzZXIgfHwgewogICAgICBlbWFpbDogdW5kZWZpbmVkLAogICAgICBpZDogdW5kZWZpbmVkLAogICAgICBpcF9hZGRyZXNzOiB1bmRlZmluZWQsCiAgICAgIHNlZ21lbnQ6IHVuZGVmaW5lZCwKICAgICAgdXNlcm5hbWU6IHVuZGVmaW5lZCwKICAgIH07CgogICAgaWYgKHRoaXMuX3Nlc3Npb24pIHsKICAgICAgdXBkYXRlU2Vzc2lvbih0aGlzLl9zZXNzaW9uLCB7IHVzZXIgfSk7CiAgICB9CgogICAgdGhpcy5fbm90aWZ5U2NvcGVMaXN0ZW5lcnMoKTsKICAgIHJldHVybiB0aGlzOwogIH0KCiAgLyoqCiAgICogQGluaGVyaXREb2MKICAgKi8KICAgZ2V0VXNlcigpIHsKICAgIHJldHVybiB0aGlzLl91c2VyOwogIH0KCiAgLyoqCiAgICogQGluaGVyaXREb2MKICAgKi8KICAgZ2V0UmVxdWVzdFNlc3Npb24oKSB7CiAgICByZXR1cm4gdGhpcy5fcmVxdWVzdFNlc3Npb247CiAgfQoKICAvKioKICAgKiBAaW5oZXJpdERvYwogICAqLwogICBzZXRSZXF1ZXN0U2Vzc2lvbihyZXF1ZXN0U2Vzc2lvbikgewogICAgdGhpcy5fcmVxdWVzdFNlc3Npb24gPSByZXF1ZXN0U2Vzc2lvbjsKICAgIHJldHVybiB0aGlzOwogIH0KCiAgLyoqCiAgICogQGluaGVyaXREb2MKICAgKi8KICAgc2V0VGFncyh0YWdzKSB7CiAgICB0aGlzLl90YWdzID0gewogICAgICAuLi50aGlzLl90YWdzLAogICAgICAuLi50YWdzLAogICAgfTsKICAgIHRoaXMuX25vdGlmeVNjb3BlTGlzdGVuZXJzKCk7CiAgICByZXR1cm4gdGhpczsKICB9CgogIC8qKgogICAqIEBpbmhlcml0RG9jCiAgICovCiAgIHNldFRhZyhrZXksIHZhbHVlKSB7CiAgICB0aGlzLl90YWdzID0geyAuLi50aGlzLl90YWdzLCBba2V5XTogdmFsdWUgfTsKICAgIHRoaXMuX25vdGlmeVNjb3BlTGlzdGVuZXJzKCk7CiAgICByZXR1cm4gdGhpczsKICB9CgogIC8qKgogICAqIEBpbmhlcml0RG9jCiAgICovCiAgIHNldEV4dHJhcyhleHRyYXMpIHsKICAgIHRoaXMuX2V4dHJhID0gewogICAgICAuLi50aGlzLl9leHRyYSwKICAgICAgLi4uZXh0cmFzLAogICAgfTsKICAgIHRoaXMuX25vdGlmeVNjb3BlTGlzdGVuZXJzKCk7CiAgICByZXR1cm4gdGhpczsKICB9CgogIC8qKgogICAqIEBpbmhlcml0RG9jCiAgICovCiAgIHNldEV4dHJhKGtleSwgZXh0cmEpIHsKICAgIHRoaXMuX2V4dHJhID0geyAuLi50aGlzLl9leHRyYSwgW2tleV06IGV4dHJhIH07CiAgICB0aGlzLl9ub3RpZnlTY29wZUxpc3RlbmVycygpOwogICAgcmV0dXJuIHRoaXM7CiAgfQoKICAvKioKICAgKiBAaW5oZXJpdERvYwogICAqLwogICBzZXRGaW5nZXJwcmludChmaW5nZXJwcmludCkgewogICAgdGhpcy5fZmluZ2VycHJpbnQgPSBmaW5nZXJwcmludDsKICAgIHRoaXMuX25vdGlmeVNjb3BlTGlzdGVuZXJzKCk7CiAgICByZXR1cm4gdGhpczsKICB9CgogIC8qKgogICAqIEBpbmhlcml0RG9jCiAgICovCiAgIHNldExldmVsKAogICAgLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIGRlcHJlY2F0aW9uL2RlcHJlY2F0aW9uCiAgICBsZXZlbCwKICApIHsKICAgIHRoaXMuX2xldmVsID0gbGV2ZWw7CiAgICB0aGlzLl9ub3RpZnlTY29wZUxpc3RlbmVycygpOwogICAgcmV0dXJuIHRoaXM7CiAgfQoKICAvKioKICAgKiBTZXRzIHRoZSB0cmFuc2FjdGlvbiBuYW1lIG9uIHRoZSBzY29wZSBmb3IgZnV0dXJlIGV2ZW50cy4KICAgKi8KICAgc2V0VHJhbnNhY3Rpb25OYW1lKG5hbWUpIHsKICAgIHRoaXMuX3RyYW5zYWN0aW9uTmFtZSA9IG5hbWU7CiAgICB0aGlzLl9ub3RpZnlTY29wZUxpc3RlbmVycygpOwogICAgcmV0dXJuIHRoaXM7CiAgfQoKICAvKioKICAgKiBAaW5oZXJpdERvYwogICAqLwogICBzZXRDb250ZXh0KGtleSwgY29udGV4dCkgewogICAgaWYgKGNvbnRleHQgPT09IG51bGwpIHsKICAgICAgLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIEB0eXBlc2NyaXB0LWVzbGludC9uby1keW5hbWljLWRlbGV0ZQogICAgICBkZWxldGUgdGhpcy5fY29udGV4dHNba2V5XTsKICAgIH0gZWxzZSB7CiAgICAgIHRoaXMuX2NvbnRleHRzW2tleV0gPSBjb250ZXh0OwogICAgfQoKICAgIHRoaXMuX25vdGlmeVNjb3BlTGlzdGVuZXJzKCk7CiAgICByZXR1cm4gdGhpczsKICB9CgogIC8qKgogICAqIFNldHMgdGhlIFNwYW4gb24gdGhlIHNjb3BlLgogICAqIEBwYXJhbSBzcGFuIFNwYW4KICAgKiBAZGVwcmVjYXRlZCBJbnN0ZWFkIG9mIHNldHRpbmcgYSBzcGFuIG9uIGEgc2NvcGUsIHVzZSBgc3RhcnRTcGFuKClgL2BzdGFydFNwYW5NYW51YWwoKWAgaW5zdGVhZC4KICAgKi8KICAgc2V0U3BhbihzcGFuKSB7CiAgICB0aGlzLl9zcGFuID0gc3BhbjsKICAgIHRoaXMuX25vdGlmeVNjb3BlTGlzdGVuZXJzKCk7CiAgICByZXR1cm4gdGhpczsKICB9CgogIC8qKgogICAqIFJldHVybnMgdGhlIGBTcGFuYCBpZiB0aGVyZSBpcyBvbmUuCiAgICogQGRlcHJlY2F0ZWQgVXNlIGBnZXRBY3RpdmVTcGFuKClgIGluc3RlYWQuCiAgICovCiAgIGdldFNwYW4oKSB7CiAgICByZXR1cm4gdGhpcy5fc3BhbjsKICB9CgogIC8qKgogICAqIFJldHVybnMgdGhlIGBUcmFuc2FjdGlvbmAgYXR0YWNoZWQgdG8gdGhlIHNjb3BlIChpZiB0aGVyZSBpcyBvbmUpLgogICAqIEBkZXByZWNhdGVkIFlvdSBzaG91bGQgbm90IHJlbHkgb24gdGhlIHRyYW5zYWN0aW9uLCBidXQganVzdCB1c2UgYHN0YXJ0U3BhbigpYCBBUElzIGluc3RlYWQuCiAgICovCiAgIGdldFRyYW5zYWN0aW9uKCkgewogICAgLy8gT2Z0ZW4sIHRoaXMgc3BhbiAoaWYgaXQgZXhpc3RzIGF0IGFsbCkgd2lsbCBiZSBhIHRyYW5zYWN0aW9uLCBidXQgaXQncyBub3QgZ3VhcmFudGVlZCB0byBiZS4gUmVnYXJkbGVzcywgaXQgd2lsbAogICAgLy8gaGF2ZSBhIHBvaW50ZXIgdG8gdGhlIGN1cnJlbnRseS1hY3RpdmUgdHJhbnNhY3Rpb24uCiAgICBjb25zdCBzcGFuID0gdGhpcy5fc3BhbjsKICAgIC8vIENhbm5vdCByZXBsYWNlIHdpdGggZ2V0Um9vdFNwYW4gYmVjYXVzZSBnZXRSb290U3BhbiByZXR1cm5zIGEgc3Bhbiwgbm90IGEgdHJhbnNhY3Rpb24KICAgIC8vIEFsc28sIHRoaXMgbWV0aG9kIHdpbGwgYmUgcmVtb3ZlZCBhbnl3YXkuCiAgICAvLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgZGVwcmVjYXRpb24vZGVwcmVjYXRpb24KICAgIHJldHVybiBzcGFuICYmIHNwYW4udHJhbnNhY3Rpb247CiAgfQoKICAvKioKICAgKiBAaW5oZXJpdERvYwogICAqLwogICBzZXRTZXNzaW9uKHNlc3Npb24pIHsKICAgIGlmICghc2Vzc2lvbikgewogICAgICBkZWxldGUgdGhpcy5fc2Vzc2lvbjsKICAgIH0gZWxzZSB7CiAgICAgIHRoaXMuX3Nlc3Npb24gPSBzZXNzaW9uOwogICAgfQogICAgdGhpcy5fbm90aWZ5U2NvcGVMaXN0ZW5lcnMoKTsKICAgIHJldHVybiB0aGlzOwogIH0KCiAgLyoqCiAgICogQGluaGVyaXREb2MKICAgKi8KICAgZ2V0U2Vzc2lvbigpIHsKICAgIHJldHVybiB0aGlzLl9zZXNzaW9uOwogIH0KCiAgLyoqCiAgICogQGluaGVyaXREb2MKICAgKi8KICAgdXBkYXRlKGNhcHR1cmVDb250ZXh0KSB7CiAgICBpZiAoIWNhcHR1cmVDb250ZXh0KSB7CiAgICAgIHJldHVybiB0aGlzOwogICAgfQoKICAgIGNvbnN0IHNjb3BlVG9NZXJnZSA9IHR5cGVvZiBjYXB0dXJlQ29udGV4dCA9PT0gJ2Z1bmN0aW9uJyA/IGNhcHR1cmVDb250ZXh0KHRoaXMpIDogY2FwdHVyZUNvbnRleHQ7CgogICAgaWYgKHNjb3BlVG9NZXJnZSBpbnN0YW5jZW9mIFNjb3BlKSB7CiAgICAgIGNvbnN0IHNjb3BlRGF0YSA9IHNjb3BlVG9NZXJnZS5nZXRTY29wZURhdGEoKTsKCiAgICAgIHRoaXMuX3RhZ3MgPSB7IC4uLnRoaXMuX3RhZ3MsIC4uLnNjb3BlRGF0YS50YWdzIH07CiAgICAgIHRoaXMuX2V4dHJhID0geyAuLi50aGlzLl9leHRyYSwgLi4uc2NvcGVEYXRhLmV4dHJhIH07CiAgICAgIHRoaXMuX2NvbnRleHRzID0geyAuLi50aGlzLl9jb250ZXh0cywgLi4uc2NvcGVEYXRhLmNvbnRleHRzIH07CiAgICAgIGlmIChzY29wZURhdGEudXNlciAmJiBPYmplY3Qua2V5cyhzY29wZURhdGEudXNlcikubGVuZ3RoKSB7CiAgICAgICAgdGhpcy5fdXNlciA9IHNjb3BlRGF0YS51c2VyOwogICAgICB9CiAgICAgIGlmIChzY29wZURhdGEubGV2ZWwpIHsKICAgICAgICB0aGlzLl9sZXZlbCA9IHNjb3BlRGF0YS5sZXZlbDsKICAgICAgfQogICAgICBpZiAoc2NvcGVEYXRhLmZpbmdlcnByaW50Lmxlbmd0aCkgewogICAgICAgIHRoaXMuX2ZpbmdlcnByaW50ID0gc2NvcGVEYXRhLmZpbmdlcnByaW50OwogICAgICB9CiAgICAgIGlmIChzY29wZVRvTWVyZ2UuZ2V0UmVxdWVzdFNlc3Npb24oKSkgewogICAgICAgIHRoaXMuX3JlcXVlc3RTZXNzaW9uID0gc2NvcGVUb01lcmdlLmdldFJlcXVlc3RTZXNzaW9uKCk7CiAgICAgIH0KICAgICAgaWYgKHNjb3BlRGF0YS5wcm9wYWdhdGlvbkNvbnRleHQpIHsKICAgICAgICB0aGlzLl9wcm9wYWdhdGlvbkNvbnRleHQgPSBzY29wZURhdGEucHJvcGFnYXRpb25Db250ZXh0OwogICAgICB9CiAgICB9IGVsc2UgaWYgKGlzUGxhaW5PYmplY3Qoc2NvcGVUb01lcmdlKSkgewogICAgICBjb25zdCBzY29wZUNvbnRleHQgPSBjYXB0dXJlQ29udGV4dCA7CiAgICAgIHRoaXMuX3RhZ3MgPSB7IC4uLnRoaXMuX3RhZ3MsIC4uLnNjb3BlQ29udGV4dC50YWdzIH07CiAgICAgIHRoaXMuX2V4dHJhID0geyAuLi50aGlzLl9leHRyYSwgLi4uc2NvcGVDb250ZXh0LmV4dHJhIH07CiAgICAgIHRoaXMuX2NvbnRleHRzID0geyAuLi50aGlzLl9jb250ZXh0cywgLi4uc2NvcGVDb250ZXh0LmNvbnRleHRzIH07CiAgICAgIGlmIChzY29wZUNvbnRleHQudXNlcikgewogICAgICAgIHRoaXMuX3VzZXIgPSBzY29wZUNvbnRleHQudXNlcjsKICAgICAgfQogICAgICBpZiAoc2NvcGVDb250ZXh0LmxldmVsKSB7CiAgICAgICAgdGhpcy5fbGV2ZWwgPSBzY29wZUNvbnRleHQubGV2ZWw7CiAgICAgIH0KICAgICAgaWYgKHNjb3BlQ29udGV4dC5maW5nZXJwcmludCkgewogICAgICAgIHRoaXMuX2ZpbmdlcnByaW50ID0gc2NvcGVDb250ZXh0LmZpbmdlcnByaW50OwogICAgICB9CiAgICAgIGlmIChzY29wZUNvbnRleHQucmVxdWVzdFNlc3Npb24pIHsKICAgICAgICB0aGlzLl9yZXF1ZXN0U2Vzc2lvbiA9IHNjb3BlQ29udGV4dC5yZXF1ZXN0U2Vzc2lvbjsKICAgICAgfQogICAgICBpZiAoc2NvcGVDb250ZXh0LnByb3BhZ2F0aW9uQ29udGV4dCkgewogICAgICAgIHRoaXMuX3Byb3BhZ2F0aW9uQ29udGV4dCA9IHNjb3BlQ29udGV4dC5wcm9wYWdhdGlvbkNvbnRleHQ7CiAgICAgIH0KICAgIH0KCiAgICByZXR1cm4gdGhpczsKICB9CgogIC8qKgogICAqIEBpbmhlcml0RG9jCiAgICovCiAgIGNsZWFyKCkgewogICAgdGhpcy5fYnJlYWRjcnVtYnMgPSBbXTsKICAgIHRoaXMuX3RhZ3MgPSB7fTsKICAgIHRoaXMuX2V4dHJhID0ge307CiAgICB0aGlzLl91c2VyID0ge307CiAgICB0aGlzLl9jb250ZXh0cyA9IHt9OwogICAgdGhpcy5fbGV2ZWwgPSB1bmRlZmluZWQ7CiAgICB0aGlzLl90cmFuc2FjdGlvbk5hbWUgPSB1bmRlZmluZWQ7CiAgICB0aGlzLl9maW5nZXJwcmludCA9IHVuZGVmaW5lZDsKICAgIHRoaXMuX3JlcXVlc3RTZXNzaW9uID0gdW5kZWZpbmVkOwogICAgdGhpcy5fc3BhbiA9IHVuZGVmaW5lZDsKICAgIHRoaXMuX3Nlc3Npb24gPSB1bmRlZmluZWQ7CiAgICB0aGlzLl9ub3RpZnlTY29wZUxpc3RlbmVycygpOwogICAgdGhpcy5fYXR0YWNobWVudHMgPSBbXTsKICAgIHRoaXMuX3Byb3BhZ2F0aW9uQ29udGV4dCA9IGdlbmVyYXRlUHJvcGFnYXRpb25Db250ZXh0KCk7CiAgICByZXR1cm4gdGhpczsKICB9CgogIC8qKgogICAqIEBpbmhlcml0RG9jCiAgICovCiAgIGFkZEJyZWFkY3J1bWIoYnJlYWRjcnVtYiwgbWF4QnJlYWRjcnVtYnMpIHsKICAgIGNvbnN0IG1heENydW1icyA9IHR5cGVvZiBtYXhCcmVhZGNydW1icyA9PT0gJ251bWJlcicgPyBtYXhCcmVhZGNydW1icyA6IERFRkFVTFRfTUFYX0JSRUFEQ1JVTUJTOwoKICAgIC8vIE5vIGRhdGEgaGFzIGJlZW4gY2hhbmdlZCwgc28gZG9uJ3Qgbm90aWZ5IHNjb3BlIGxpc3RlbmVycwogICAgaWYgKG1heENydW1icyA8PSAwKSB7CiAgICAgIHJldHVybiB0aGlzOwogICAgfQoKICAgIGNvbnN0IG1lcmdlZEJyZWFkY3J1bWIgPSB7CiAgICAgIHRpbWVzdGFtcDogZGF0ZVRpbWVzdGFtcEluU2Vjb25kcygpLAogICAgICAuLi5icmVhZGNydW1iLAogICAgfTsKCiAgICBjb25zdCBicmVhZGNydW1icyA9IHRoaXMuX2JyZWFkY3J1bWJzOwogICAgYnJlYWRjcnVtYnMucHVzaChtZXJnZWRCcmVhZGNydW1iKTsKICAgIHRoaXMuX2JyZWFkY3J1bWJzID0gYnJlYWRjcnVtYnMubGVuZ3RoID4gbWF4Q3J1bWJzID8gYnJlYWRjcnVtYnMuc2xpY2UoLW1heENydW1icykgOiBicmVhZGNydW1iczsKCiAgICB0aGlzLl9ub3RpZnlTY29wZUxpc3RlbmVycygpOwoKICAgIHJldHVybiB0aGlzOwogIH0KCiAgLyoqCiAgICogQGluaGVyaXREb2MKICAgKi8KICAgZ2V0TGFzdEJyZWFkY3J1bWIoKSB7CiAgICByZXR1cm4gdGhpcy5fYnJlYWRjcnVtYnNbdGhpcy5fYnJlYWRjcnVtYnMubGVuZ3RoIC0gMV07CiAgfQoKICAvKioKICAgKiBAaW5oZXJpdERvYwogICAqLwogICBjbGVhckJyZWFkY3J1bWJzKCkgewogICAgdGhpcy5fYnJlYWRjcnVtYnMgPSBbXTsKICAgIHRoaXMuX25vdGlmeVNjb3BlTGlzdGVuZXJzKCk7CiAgICByZXR1cm4gdGhpczsKICB9CgogIC8qKgogICAqIEBpbmhlcml0RG9jCiAgICovCiAgIGFkZEF0dGFjaG1lbnQoYXR0YWNobWVudCkgewogICAgdGhpcy5fYXR0YWNobWVudHMucHVzaChhdHRhY2htZW50KTsKICAgIHJldHVybiB0aGlzOwogIH0KCiAgLyoqCiAgICogQGluaGVyaXREb2MKICAgKiBAZGVwcmVjYXRlZCBVc2UgYGdldFNjb3BlRGF0YSgpYCBpbnN0ZWFkLgogICAqLwogICBnZXRBdHRhY2htZW50cygpIHsKICAgIGNvbnN0IGRhdGEgPSB0aGlzLmdldFNjb3BlRGF0YSgpOwoKICAgIHJldHVybiBkYXRhLmF0dGFjaG1lbnRzOwogIH0KCiAgLyoqCiAgICogQGluaGVyaXREb2MKICAgKi8KICAgY2xlYXJBdHRhY2htZW50cygpIHsKICAgIHRoaXMuX2F0dGFjaG1lbnRzID0gW107CiAgICByZXR1cm4gdGhpczsKICB9CgogIC8qKiBAaW5oZXJpdERvYyAqLwogICBnZXRTY29wZURhdGEoKSB7CiAgICBjb25zdCB7CiAgICAgIF9icmVhZGNydW1icywKICAgICAgX2F0dGFjaG1lbnRzLAogICAgICBfY29udGV4dHMsCiAgICAgIF90YWdzLAogICAgICBfZXh0cmEsCiAgICAgIF91c2VyLAogICAgICBfbGV2ZWwsCiAgICAgIF9maW5nZXJwcmludCwKICAgICAgX2V2ZW50UHJvY2Vzc29ycywKICAgICAgX3Byb3BhZ2F0aW9uQ29udGV4dCwKICAgICAgX3Nka1Byb2Nlc3NpbmdNZXRhZGF0YSwKICAgICAgX3RyYW5zYWN0aW9uTmFtZSwKICAgICAgX3NwYW4sCiAgICB9ID0gdGhpczsKCiAgICByZXR1cm4gewogICAgICBicmVhZGNydW1iczogX2JyZWFkY3J1bWJzLAogICAgICBhdHRhY2htZW50czogX2F0dGFjaG1lbnRzLAogICAgICBjb250ZXh0czogX2NvbnRleHRzLAogICAgICB0YWdzOiBfdGFncywKICAgICAgZXh0cmE6IF9leHRyYSwKICAgICAgdXNlcjogX3VzZXIsCiAgICAgIGxldmVsOiBfbGV2ZWwsCiAgICAgIGZpbmdlcnByaW50OiBfZmluZ2VycHJpbnQgfHwgW10sCiAgICAgIGV2ZW50UHJvY2Vzc29yczogX2V2ZW50UHJvY2Vzc29ycywKICAgICAgcHJvcGFnYXRpb25Db250ZXh0OiBfcHJvcGFnYXRpb25Db250ZXh0LAogICAgICBzZGtQcm9jZXNzaW5nTWV0YWRhdGE6IF9zZGtQcm9jZXNzaW5nTWV0YWRhdGEsCiAgICAgIHRyYW5zYWN0aW9uTmFtZTogX3RyYW5zYWN0aW9uTmFtZSwKICAgICAgc3BhbjogX3NwYW4sCiAgICB9OwogIH0KCiAgLyoqCiAgICogQXBwbGllcyBkYXRhIGZyb20gdGhlIHNjb3BlIHRvIHRoZSBldmVudCBhbmQgcnVucyBhbGwgZXZlbnQgcHJvY2Vzc29ycyBvbiBpdC4KICAgKgogICAqIEBwYXJhbSBldmVudCBFdmVudAogICAqIEBwYXJhbSBoaW50IE9iamVjdCBjb250YWluaW5nIGFkZGl0aW9uYWwgaW5mb3JtYXRpb24gYWJvdXQgdGhlIG9yaWdpbmFsIGV4Y2VwdGlvbiwgZm9yIHVzZSBieSB0aGUgZXZlbnQgcHJvY2Vzc29ycy4KICAgKiBAaGlkZGVuCiAgICogQGRlcHJlY2F0ZWQgVXNlIGBhcHBseVNjb3BlRGF0YVRvRXZlbnQoKWAgZGlyZWN0bHkKICAgKi8KICAgYXBwbHlUb0V2ZW50KAogICAgZXZlbnQsCiAgICBoaW50ID0ge30sCiAgICBhZGRpdGlvbmFsRXZlbnRQcm9jZXNzb3JzID0gW10sCiAgKSB7CiAgICBhcHBseVNjb3BlRGF0YVRvRXZlbnQoZXZlbnQsIHRoaXMuZ2V0U2NvcGVEYXRhKCkpOwoKICAgIC8vIFRPRE8gKHY4KTogVXBkYXRlIHRoaXMgb3JkZXIgdG8gYmU6IEdsb2JhbCA+IENsaWVudCA+IFNjb3BlCiAgICBjb25zdCBldmVudFByb2Nlc3NvcnMgPSBbCiAgICAgIC4uLmFkZGl0aW9uYWxFdmVudFByb2Nlc3NvcnMsCiAgICAgIC8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBkZXByZWNhdGlvbi9kZXByZWNhdGlvbgogICAgICAuLi5nZXRHbG9iYWxFdmVudFByb2Nlc3NvcnMoKSwKICAgICAgLi4udGhpcy5fZXZlbnRQcm9jZXNzb3JzLAogICAgXTsKCiAgICByZXR1cm4gbm90aWZ5RXZlbnRQcm9jZXNzb3JzKGV2ZW50UHJvY2Vzc29ycywgZXZlbnQsIGhpbnQpOwogIH0KCiAgLyoqCiAgICogQWRkIGRhdGEgd2hpY2ggd2lsbCBiZSBhY2Nlc3NpYmxlIGR1cmluZyBldmVudCBwcm9jZXNzaW5nIGJ1dCB3b24ndCBnZXQgc2VudCB0byBTZW50cnkKICAgKi8KICAgc2V0U0RLUHJvY2Vzc2luZ01ldGFkYXRhKG5ld0RhdGEpIHsKICAgIHRoaXMuX3Nka1Byb2Nlc3NpbmdNZXRhZGF0YSA9IHsgLi4udGhpcy5fc2RrUHJvY2Vzc2luZ01ldGFkYXRhLCAuLi5uZXdEYXRhIH07CgogICAgcmV0dXJuIHRoaXM7CiAgfQoKICAvKioKICAgKiBAaW5oZXJpdERvYwogICAqLwogICBzZXRQcm9wYWdhdGlvbkNvbnRleHQoY29udGV4dCkgewogICAgdGhpcy5fcHJvcGFnYXRpb25Db250ZXh0ID0gY29udGV4dDsKICAgIHJldHVybiB0aGlzOwogIH0KCiAgLyoqCiAgICogQGluaGVyaXREb2MKICAgKi8KICAgZ2V0UHJvcGFnYXRpb25Db250ZXh0KCkgewogICAgcmV0dXJuIHRoaXMuX3Byb3BhZ2F0aW9uQ29udGV4dDsKICB9CgogIC8qKgogICAqIENhcHR1cmUgYW4gZXhjZXB0aW9uIGZvciB0aGlzIHNjb3BlLgogICAqCiAgICogQHBhcmFtIGV4Y2VwdGlvbiBUaGUgZXhjZXB0aW9uIHRvIGNhcHR1cmUuCiAgICogQHBhcmFtIGhpbnQgT3B0aW5hbCBhZGRpdGlvbmFsIGRhdGEgdG8gYXR0YWNoIHRvIHRoZSBTZW50cnkgZXZlbnQuCiAgICogQHJldHVybnMgdGhlIGlkIG9mIHRoZSBjYXB0dXJlZCBTZW50cnkgZXZlbnQuCiAgICovCiAgIGNhcHR1cmVFeGNlcHRpb24oZXhjZXB0aW9uLCBoaW50KSB7CiAgICBjb25zdCBldmVudElkID0gaGludCAmJiBoaW50LmV2ZW50X2lkID8gaGludC5ldmVudF9pZCA6IHV1aWQ0KCk7CgogICAgaWYgKCF0aGlzLl9jbGllbnQpIHsKICAgICAgbG9nZ2VyLndhcm4oJ05vIGNsaWVudCBjb25maWd1cmVkIG9uIHNjb3BlIC0gd2lsbCBub3QgY2FwdHVyZSBleGNlcHRpb24hJyk7CiAgICAgIHJldHVybiBldmVudElkOwogICAgfQoKICAgIGNvbnN0IHN5bnRoZXRpY0V4Y2VwdGlvbiA9IG5ldyBFcnJvcignU2VudHJ5IHN5bnRoZXRpY0V4Y2VwdGlvbicpOwoKICAgIHRoaXMuX2NsaWVudC5jYXB0dXJlRXhjZXB0aW9uKAogICAgICBleGNlcHRpb24sCiAgICAgIHsKICAgICAgICBvcmlnaW5hbEV4Y2VwdGlvbjogZXhjZXB0aW9uLAogICAgICAgIHN5bnRoZXRpY0V4Y2VwdGlvbiwKICAgICAgICAuLi5oaW50LAogICAgICAgIGV2ZW50X2lkOiBldmVudElkLAogICAgICB9LAogICAgICB0aGlzLAogICAgKTsKCiAgICByZXR1cm4gZXZlbnRJZDsKICB9CgogIC8qKgogICAqIENhcHR1cmUgYSBtZXNzYWdlIGZvciB0aGlzIHNjb3BlLgogICAqCiAgICogQHBhcmFtIG1lc3NhZ2UgVGhlIG1lc3NhZ2UgdG8gY2FwdHVyZS4KICAgKiBAcGFyYW0gbGV2ZWwgQW4gb3B0aW9uYWwgc2V2ZXJpdHkgbGV2ZWwgdG8gcmVwb3J0IHRoZSBtZXNzYWdlIHdpdGguCiAgICogQHBhcmFtIGhpbnQgT3B0aW9uYWwgYWRkaXRpb25hbCBkYXRhIHRvIGF0dGFjaCB0byB0aGUgU2VudHJ5IGV2ZW50LgogICAqIEByZXR1cm5zIHRoZSBpZCBvZiB0aGUgY2FwdHVyZWQgbWVzc2FnZS4KICAgKi8KICAgY2FwdHVyZU1lc3NhZ2UobWVzc2FnZSwgbGV2ZWwsIGhpbnQpIHsKICAgIGNvbnN0IGV2ZW50SWQgPSBoaW50ICYmIGhpbnQuZXZlbnRfaWQgPyBoaW50LmV2ZW50X2lkIDogdXVpZDQoKTsKCiAgICBpZiAoIXRoaXMuX2NsaWVudCkgewogICAgICBsb2dnZXIud2FybignTm8gY2xpZW50IGNvbmZpZ3VyZWQgb24gc2NvcGUgLSB3aWxsIG5vdCBjYXB0dXJlIG1lc3NhZ2UhJyk7CiAgICAgIHJldHVybiBldmVudElkOwogICAgfQoKICAgIGNvbnN0IHN5bnRoZXRpY0V4Y2VwdGlvbiA9IG5ldyBFcnJvcihtZXNzYWdlKTsKCiAgICB0aGlzLl9jbGllbnQuY2FwdHVyZU1lc3NhZ2UoCiAgICAgIG1lc3NhZ2UsCiAgICAgIGxldmVsLAogICAgICB7CiAgICAgICAgb3JpZ2luYWxFeGNlcHRpb246IG1lc3NhZ2UsCiAgICAgICAgc3ludGhldGljRXhjZXB0aW9uLAogICAgICAgIC4uLmhpbnQsCiAgICAgICAgZXZlbnRfaWQ6IGV2ZW50SWQsCiAgICAgIH0sCiAgICAgIHRoaXMsCiAgICApOwoKICAgIHJldHVybiBldmVudElkOwogIH0KCiAgLyoqCiAgICogQ2FwdHVyZXMgYSBtYW51YWxseSBjcmVhdGVkIGV2ZW50IGZvciB0aGlzIHNjb3BlIGFuZCBzZW5kcyBpdCB0byBTZW50cnkuCiAgICoKICAgKiBAcGFyYW0gZXhjZXB0aW9uIFRoZSBldmVudCB0byBjYXB0dXJlLgogICAqIEBwYXJhbSBoaW50IE9wdGlvbmFsIGFkZGl0aW9uYWwgZGF0YSB0byBhdHRhY2ggdG8gdGhlIFNlbnRyeSBldmVudC4KICAgKiBAcmV0dXJucyB0aGUgaWQgb2YgdGhlIGNhcHR1cmVkIGV2ZW50LgogICAqLwogICBjYXB0dXJlRXZlbnQoZXZlbnQsIGhpbnQpIHsKICAgIGNvbnN0IGV2ZW50SWQgPSBoaW50ICYmIGhpbnQuZXZlbnRfaWQgPyBoaW50LmV2ZW50X2lkIDogdXVpZDQoKTsKCiAgICBpZiAoIXRoaXMuX2NsaWVudCkgewogICAgICBsb2dnZXIud2FybignTm8gY2xpZW50IGNvbmZpZ3VyZWQgb24gc2NvcGUgLSB3aWxsIG5vdCBjYXB0dXJlIGV2ZW50IScpOwogICAgICByZXR1cm4gZXZlbnRJZDsKICAgIH0KCiAgICB0aGlzLl9jbGllbnQuY2FwdHVyZUV2ZW50KGV2ZW50LCB7IC4uLmhpbnQsIGV2ZW50X2lkOiBldmVudElkIH0sIHRoaXMpOwoKICAgIHJldHVybiBldmVudElkOwogIH0KCiAgLyoqCiAgICogVGhpcyB3aWxsIGJlIGNhbGxlZCBvbiBldmVyeSBzZXQgY2FsbC4KICAgKi8KICAgX25vdGlmeVNjb3BlTGlzdGVuZXJzKCkgewogICAgLy8gV2UgbmVlZCB0aGlzIGNoZWNrIGZvciB0aGlzLl9ub3RpZnlpbmdMaXN0ZW5lcnMgdG8gYmUgYWJsZSB0byB3b3JrIG9uIHNjb3BlIGR1cmluZyB1cGRhdGVzCiAgICAvLyBJZiB0aGlzIGNoZWNrIGlzIG5vdCBoZXJlIHdlJ2xsIHByb2R1Y2UgZW5kbGVzcyByZWN1cnNpb24gd2hlbiBzb21ldGhpbmcgaXMgZG9uZSB3aXRoIHRoZSBzY29wZQogICAgLy8gZHVyaW5nIHRoZSBjYWxsYmFjay4KICAgIGlmICghdGhpcy5fbm90aWZ5aW5nTGlzdGVuZXJzKSB7CiAgICAgIHRoaXMuX25vdGlmeWluZ0xpc3RlbmVycyA9IHRydWU7CiAgICAgIHRoaXMuX3Njb3BlTGlzdGVuZXJzLmZvckVhY2goY2FsbGJhY2sgPT4gewogICAgICAgIGNhbGxiYWNrKHRoaXMpOwogICAgICB9KTsKICAgICAgdGhpcy5fbm90aWZ5aW5nTGlzdGVuZXJzID0gZmFsc2U7CiAgICB9CiAgfQp9CgpmdW5jdGlvbiBnZW5lcmF0ZVByb3BhZ2F0aW9uQ29udGV4dCgpIHsKICByZXR1cm4gewogICAgdHJhY2VJZDogdXVpZDQoKSwKICAgIHNwYW5JZDogdXVpZDQoKS5zdWJzdHJpbmcoMTYpLAogIH07Cn0KCmNvbnN0IFNES19WRVJTSU9OID0gJzcuMTIwLjEnOwoKLyoqCiAqIEFQSSBjb21wYXRpYmlsaXR5IHZlcnNpb24gb2YgdGhpcyBodWIuCiAqCiAqIFdBUk5JTkc6IFRoaXMgbnVtYmVyIHNob3VsZCBvbmx5IGJlIGluY3JlYXNlZCB3aGVuIHRoZSBnbG9iYWwgaW50ZXJmYWNlCiAqIGNoYW5nZXMgYW5kIG5ldyBtZXRob2RzIGFyZSBpbnRyb2R1Y2VkLgogKgogKiBAaGlkZGVuCiAqLwpjb25zdCBBUElfVkVSU0lPTiA9IHBhcnNlRmxvYXQoU0RLX1ZFUlNJT04pOwoKLyoqCiAqIERlZmF1bHQgbWF4aW11bSBudW1iZXIgb2YgYnJlYWRjcnVtYnMgYWRkZWQgdG8gYW4gZXZlbnQuIENhbiBiZSBvdmVyd3JpdHRlbgogKiB3aXRoIHtAbGluayBPcHRpb25zLm1heEJyZWFkY3J1bWJzfS4KICovCmNvbnN0IERFRkFVTFRfQlJFQURDUlVNQlMgPSAxMDA7CgovKioKICogQGRlcHJlY2F0ZWQgVGhlIGBIdWJgIGNsYXNzIHdpbGwgYmUgcmVtb3ZlZCBpbiB2ZXJzaW9uIDggb2YgdGhlIFNESyBpbiBmYXZvdXIgb2YgYFNjb3BlYCBhbmQgYENsaWVudGAgb2JqZWN0cy4KICoKICogSWYgeW91IHByZXZpb3VzbHkgdXNlZCB0aGUgYEh1YmAgY2xhc3MgZGlyZWN0bHksIHJlcGxhY2UgaXQgd2l0aCBgU2NvcGVgIGFuZCBgQ2xpZW50YCBvYmplY3RzLiBNb3JlIGluZm9ybWF0aW9uOgogKiAtIFtNdWx0aXBsZSBTZW50cnkgSW5zdGFuY2VzXShodHRwczovL2RvY3Muc2VudHJ5LmlvL3BsYXRmb3Jtcy9qYXZhc2NyaXB0L2Jlc3QtcHJhY3RpY2VzL211bHRpcGxlLXNlbnRyeS1pbnN0YW5jZXMvKQogKiAtIFtCcm93c2VyIEV4dGVuc2lvbnNdKGh0dHBzOi8vZG9jcy5zZW50cnkuaW8vcGxhdGZvcm1zL2phdmFzY3JpcHQvYmVzdC1wcmFjdGljZXMvYnJvd3Nlci1leHRlbnNpb25zLykKICoKICogU29tZSBvZiBvdXIgQVBJcyBhcmUgdHlwZWQgd2l0aCB0aGUgSHViIGNsYXNzIGluc3RlYWQgb2YgdGhlIGludGVyZmFjZSAoZS5nLiBgZ2V0Q3VycmVudEh1YmApLiBNb3N0IG9mIHRoZW0gYXJlIGRlcHJlY2F0ZWQKICogdGhlbXNlbHZlcyBhbmQgd2lsbCBhbHNvIGJlIHJlbW92ZWQgaW4gdmVyc2lvbiA4LiBNb3JlIGluZm9ybWF0aW9uOgogKiAtIFtNaWdyYXRpb24gR3VpZGVdKGh0dHBzOi8vZ2l0aHViLmNvbS9nZXRzZW50cnkvc2VudHJ5LWphdmFzY3JpcHQvYmxvYi9kZXZlbG9wL01JR1JBVElPTi5tZCNkZXByZWNhdGUtaHViKQogKi8KLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIGRlcHJlY2F0aW9uL2RlcHJlY2F0aW9uCmNsYXNzIEh1YiAgewogIC8qKiBJcyBhIHtAbGluayBMYXllcn1bXSBjb250YWluaW5nIHRoZSBjbGllbnQgYW5kIHNjb3BlICovCgogIC8qKiBDb250YWlucyB0aGUgbGFzdCBldmVudCBpZCBvZiBhIGNhcHR1cmVkIGV2ZW50LiAgKi8KCiAgLyoqCiAgICogQ3JlYXRlcyBhIG5ldyBpbnN0YW5jZSBvZiB0aGUgaHViLCB3aWxsIHB1c2ggb25lIHtAbGluayBMYXllcn0gaW50byB0aGUKICAgKiBpbnRlcm5hbCBzdGFjayBvbiBjcmVhdGlvbi4KICAgKgogICAqIEBwYXJhbSBjbGllbnQgYm91bmQgdG8gdGhlIGh1Yi4KICAgKiBAcGFyYW0gc2NvcGUgYm91bmQgdG8gdGhlIGh1Yi4KICAgKiBAcGFyYW0gdmVyc2lvbiBudW1iZXIsIGhpZ2hlciBudW1iZXIgbWVhbnMgaGlnaGVyIHByaW9yaXR5LgogICAqCiAgICogQGRlcHJlY2F0ZWQgSW5zdGFudGlhdGlvbiBvZiBIdWIgb2JqZWN0cyBpcyBkZXByZWNhdGVkIGFuZCB0aGUgY29uc3RydWN0b3Igd2lsbCBiZSByZW1vdmVkIGluIHZlcnNpb24gOCBvZiB0aGUgU0RLLgogICAqCiAgICogSWYgeW91IGFyZSBjdXJyZW50bHkgdXNpbmcgdGhlIEh1YiBmb3IgbXVsdGktY2xpZW50IHVzZSBsaWtlIHNvOgogICAqCiAgICogYGBgCiAgICogLy8gT0xECiAgICogY29uc3QgaHViID0gbmV3IEh1YigpOwogICAqIGh1Yi5iaW5kQ2xpZW50KGNsaWVudCk7CiAgICogbWFrZU1haW4oaHViKQogICAqIGBgYAogICAqCiAgICogaW5zdGVhZCBpbml0aWFsaXplIHRoZSBjbGllbnQgYXMgZm9sbG93czoKICAgKgogICAqIGBgYAogICAqIC8vIE5FVwogICAqIFNlbnRyeS53aXRoSXNvbGF0aW9uU2NvcGUoKCkgPT4gewogICAqICAgIFNlbnRyeS5zZXRDdXJyZW50Q2xpZW50KGNsaWVudCk7CiAgICogICAgY2xpZW50LmluaXQoKTsKICAgKiB9KTsKICAgKiBgYGAKICAgKgogICAqIElmIHlvdSBhcmUgdXNpbmcgdGhlIEh1YiB0byBjYXB0dXJlIGV2ZW50cyBsaWtlIHNvOgogICAqCiAgICogYGBgCiAgICogLy8gT0xECiAgICogY29uc3QgY2xpZW50ID0gbmV3IENsaWVudCgpOwogICAqIGNvbnN0IGh1YiA9IG5ldyBIdWIoY2xpZW50KTsKICAgKiBodWIuY2FwdHVyZUV4Y2VwdGlvbigpCiAgICogYGBgCiAgICoKICAgKiBpbnN0ZWFkIGNhcHR1cmUgaXNvbGF0ZWQgZXZlbnRzIGFzIGZvbGxvd3M6CiAgICoKICAgKiBgYGAKICAgKiAvLyBORVcKICAgKiBjb25zdCBjbGllbnQgPSBuZXcgQ2xpZW50KCk7CiAgICogY29uc3Qgc2NvcGUgPSBuZXcgU2NvcGUoKTsKICAgKiBzY29wZS5zZXRDbGllbnQoY2xpZW50KTsKICAgKiBzY29wZS5jYXB0dXJlRXhjZXB0aW9uKCk7CiAgICogYGBgCiAgICovCiAgIGNvbnN0cnVjdG9yKAogICAgY2xpZW50LAogICAgc2NvcGUsCiAgICBpc29sYXRpb25TY29wZSwKICAgICAgX3ZlcnNpb24gPSBBUElfVkVSU0lPTiwKICApIHt0aGlzLl92ZXJzaW9uID0gX3ZlcnNpb247CiAgICBsZXQgYXNzaWduZWRTY29wZTsKICAgIGlmICghc2NvcGUpIHsKICAgICAgYXNzaWduZWRTY29wZSA9IG5ldyBTY29wZSgpOwogICAgICBhc3NpZ25lZFNjb3BlLnNldENsaWVudChjbGllbnQpOwogICAgfSBlbHNlIHsKICAgICAgYXNzaWduZWRTY29wZSA9IHNjb3BlOwogICAgfQoKICAgIGxldCBhc3NpZ25lZElzb2xhdGlvblNjb3BlOwogICAgaWYgKCFpc29sYXRpb25TY29wZSkgewogICAgICBhc3NpZ25lZElzb2xhdGlvblNjb3BlID0gbmV3IFNjb3BlKCk7CiAgICAgIGFzc2lnbmVkSXNvbGF0aW9uU2NvcGUuc2V0Q2xpZW50KGNsaWVudCk7CiAgICB9IGVsc2UgewogICAgICBhc3NpZ25lZElzb2xhdGlvblNjb3BlID0gaXNvbGF0aW9uU2NvcGU7CiAgICB9CgogICAgdGhpcy5fc3RhY2sgPSBbeyBzY29wZTogYXNzaWduZWRTY29wZSB9XTsKCiAgICBpZiAoY2xpZW50KSB7CiAgICAgIC8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBkZXByZWNhdGlvbi9kZXByZWNhdGlvbgogICAgICB0aGlzLmJpbmRDbGllbnQoY2xpZW50KTsKICAgIH0KCiAgICB0aGlzLl9pc29sYXRpb25TY29wZSA9IGFzc2lnbmVkSXNvbGF0aW9uU2NvcGU7CiAgfQoKICAvKioKICAgKiBDaGVja3MgaWYgdGhpcyBodWIncyB2ZXJzaW9uIGlzIG9sZGVyIHRoYW4gdGhlIGdpdmVuIHZlcnNpb24uCiAgICoKICAgKiBAcGFyYW0gdmVyc2lvbiBBIHZlcnNpb24gbnVtYmVyIHRvIGNvbXBhcmUgdG8uCiAgICogQHJldHVybiBUcnVlIGlmIHRoZSBnaXZlbiB2ZXJzaW9uIGlzIG5ld2VyOyBvdGhlcndpc2UgZmFsc2UuCiAgICoKICAgKiBAZGVwcmVjYXRlZCBUaGlzIHdpbGwgYmUgcmVtb3ZlZCBpbiB2OC4KICAgKi8KICAgaXNPbGRlclRoYW4odmVyc2lvbikgewogICAgcmV0dXJuIHRoaXMuX3ZlcnNpb24gPCB2ZXJzaW9uOwogIH0KCiAgLyoqCiAgICogVGhpcyBiaW5kcyB0aGUgZ2l2ZW4gY2xpZW50IHRvIHRoZSBjdXJyZW50IHNjb3BlLgogICAqIEBwYXJhbSBjbGllbnQgQW4gU0RLIGNsaWVudCAoY2xpZW50KSBpbnN0YW5jZS4KICAgKgogICAqIEBkZXByZWNhdGVkIFVzZSBgaW5pdEFuZEJpbmQoKWAgZGlyZWN0bHksIG9yIGBzZXRDdXJyZW50Q2xpZW50KClgIGFuZC9vciBgY2xpZW50LmluaXQoKWAgaW5zdGVhZC4KICAgKi8KICAgYmluZENsaWVudChjbGllbnQpIHsKICAgIC8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBkZXByZWNhdGlvbi9kZXByZWNhdGlvbgogICAgY29uc3QgdG9wID0gdGhpcy5nZXRTdGFja1RvcCgpOwogICAgdG9wLmNsaWVudCA9IGNsaWVudDsKICAgIHRvcC5zY29wZS5zZXRDbGllbnQoY2xpZW50KTsKICAgIC8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBkZXByZWNhdGlvbi9kZXByZWNhdGlvbgogICAgaWYgKGNsaWVudCAmJiBjbGllbnQuc2V0dXBJbnRlZ3JhdGlvbnMpIHsKICAgICAgLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIGRlcHJlY2F0aW9uL2RlcHJlY2F0aW9uCiAgICAgIGNsaWVudC5zZXR1cEludGVncmF0aW9ucygpOwogICAgfQogIH0KCiAgLyoqCiAgICogQGluaGVyaXREb2MKICAgKgogICAqIEBkZXByZWNhdGVkIFVzZSBgd2l0aFNjb3BlYCBpbnN0ZWFkLgogICAqLwogICBwdXNoU2NvcGUoKSB7CiAgICAvLyBXZSB3YW50IHRvIGNsb25lIHRoZSBjb250ZW50IG9mIHByZXYgc2NvcGUKICAgIC8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBkZXByZWNhdGlvbi9kZXByZWNhdGlvbgogICAgY29uc3Qgc2NvcGUgPSB0aGlzLmdldFNjb3BlKCkuY2xvbmUoKTsKICAgIC8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBkZXByZWNhdGlvbi9kZXByZWNhdGlvbgogICAgdGhpcy5nZXRTdGFjaygpLnB1c2goewogICAgICAvLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgZGVwcmVjYXRpb24vZGVwcmVjYXRpb24KICAgICAgY2xpZW50OiB0aGlzLmdldENsaWVudCgpLAogICAgICBzY29wZSwKICAgIH0pOwogICAgcmV0dXJuIHNjb3BlOwogIH0KCiAgLyoqCiAgICogQGluaGVyaXREb2MKICAgKgogICAqIEBkZXByZWNhdGVkIFVzZSBgd2l0aFNjb3BlYCBpbnN0ZWFkLgogICAqLwogICBwb3BTY29wZSgpIHsKICAgIC8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBkZXByZWNhdGlvbi9kZXByZWNhdGlvbgogICAgaWYgKHRoaXMuZ2V0U3RhY2soKS5sZW5ndGggPD0gMSkgcmV0dXJuIGZhbHNlOwogICAgLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIGRlcHJlY2F0aW9uL2RlcHJlY2F0aW9uCiAgICByZXR1cm4gISF0aGlzLmdldFN0YWNrKCkucG9wKCk7CiAgfQoKICAvKioKICAgKiBAaW5oZXJpdERvYwogICAqCiAgICogQGRlcHJlY2F0ZWQgVXNlIGBTZW50cnkud2l0aFNjb3BlKClgIGluc3RlYWQuCiAgICovCiAgIHdpdGhTY29wZShjYWxsYmFjaykgewogICAgLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIGRlcHJlY2F0aW9uL2RlcHJlY2F0aW9uCiAgICBjb25zdCBzY29wZSA9IHRoaXMucHVzaFNjb3BlKCk7CgogICAgbGV0IG1heWJlUHJvbWlzZVJlc3VsdDsKICAgIHRyeSB7CiAgICAgIG1heWJlUHJvbWlzZVJlc3VsdCA9IGNhbGxiYWNrKHNjb3BlKTsKICAgIH0gY2F0Y2ggKGUpIHsKICAgICAgLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIGRlcHJlY2F0aW9uL2RlcHJlY2F0aW9uCiAgICAgIHRoaXMucG9wU2NvcGUoKTsKICAgICAgdGhyb3cgZTsKICAgIH0KCiAgICBpZiAoaXNUaGVuYWJsZShtYXliZVByb21pc2VSZXN1bHQpKSB7CiAgICAgIC8vIEB0cy1leHBlY3QtZXJyb3IgLSBpc1RoZW5hYmxlIHJldHVybnMgdGhlIHdyb25nIHR5cGUKICAgICAgcmV0dXJuIG1heWJlUHJvbWlzZVJlc3VsdC50aGVuKAogICAgICAgIHJlcyA9PiB7CiAgICAgICAgICAvLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgZGVwcmVjYXRpb24vZGVwcmVjYXRpb24KICAgICAgICAgIHRoaXMucG9wU2NvcGUoKTsKICAgICAgICAgIHJldHVybiByZXM7CiAgICAgICAgfSwKICAgICAgICBlID0+IHsKICAgICAgICAgIC8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBkZXByZWNhdGlvbi9kZXByZWNhdGlvbgogICAgICAgICAgdGhpcy5wb3BTY29wZSgpOwogICAgICAgICAgdGhyb3cgZTsKICAgICAgICB9LAogICAgICApOwogICAgfQoKICAgIC8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBkZXByZWNhdGlvbi9kZXByZWNhdGlvbgogICAgdGhpcy5wb3BTY29wZSgpOwogICAgcmV0dXJuIG1heWJlUHJvbWlzZVJlc3VsdDsKICB9CgogIC8qKgogICAqIEBpbmhlcml0RG9jCiAgICoKICAgKiBAZGVwcmVjYXRlZCBVc2UgYFNlbnRyeS5nZXRDbGllbnQoKWAgaW5zdGVhZC4KICAgKi8KICAgZ2V0Q2xpZW50KCkgewogICAgLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIGRlcHJlY2F0aW9uL2RlcHJlY2F0aW9uCiAgICByZXR1cm4gdGhpcy5nZXRTdGFja1RvcCgpLmNsaWVudCA7CiAgfQoKICAvKioKICAgKiBSZXR1cm5zIHRoZSBzY29wZSBvZiB0aGUgdG9wIHN0YWNrLgogICAqCiAgICogQGRlcHJlY2F0ZWQgVXNlIGBTZW50cnkuZ2V0Q3VycmVudFNjb3BlKClgIGluc3RlYWQuCiAgICovCiAgIGdldFNjb3BlKCkgewogICAgLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIGRlcHJlY2F0aW9uL2RlcHJlY2F0aW9uCiAgICByZXR1cm4gdGhpcy5nZXRTdGFja1RvcCgpLnNjb3BlOwogIH0KCiAgLyoqCiAgICogQGRlcHJlY2F0ZWQgVXNlIGBTZW50cnkuZ2V0SXNvbGF0aW9uU2NvcGUoKWAgaW5zdGVhZC4KICAgKi8KICAgZ2V0SXNvbGF0aW9uU2NvcGUoKSB7CiAgICByZXR1cm4gdGhpcy5faXNvbGF0aW9uU2NvcGU7CiAgfQoKICAvKioKICAgKiBSZXR1cm5zIHRoZSBzY29wZSBzdGFjayBmb3IgZG9tYWlucyBvciB0aGUgcHJvY2Vzcy4KICAgKiBAZGVwcmVjYXRlZCBUaGlzIHdpbGwgYmUgcmVtb3ZlZCBpbiB2OC4KICAgKi8KICAgZ2V0U3RhY2soKSB7CiAgICByZXR1cm4gdGhpcy5fc3RhY2s7CiAgfQoKICAvKioKICAgKiBSZXR1cm5zIHRoZSB0b3Btb3N0IHNjb3BlIGxheWVyIGluIHRoZSBvcmRlciBkb21haW4gPiBsb2NhbCA+IHByb2Nlc3MuCiAgICogQGRlcHJlY2F0ZWQgVGhpcyB3aWxsIGJlIHJlbW92ZWQgaW4gdjguCiAgICovCiAgIGdldFN0YWNrVG9wKCkgewogICAgcmV0dXJuIHRoaXMuX3N0YWNrW3RoaXMuX3N0YWNrLmxlbmd0aCAtIDFdOwogIH0KCiAgLyoqCiAgICogQGluaGVyaXREb2MKICAgKgogICAqIEBkZXByZWNhdGVkIFVzZSBgU2VudHJ5LmNhcHR1cmVFeGNlcHRpb24oKWAgaW5zdGVhZC4KICAgKi8KICAgY2FwdHVyZUV4Y2VwdGlvbihleGNlcHRpb24sIGhpbnQpIHsKICAgIGNvbnN0IGV2ZW50SWQgPSAodGhpcy5fbGFzdEV2ZW50SWQgPSBoaW50ICYmIGhpbnQuZXZlbnRfaWQgPyBoaW50LmV2ZW50X2lkIDogdXVpZDQoKSk7CiAgICBjb25zdCBzeW50aGV0aWNFeGNlcHRpb24gPSBuZXcgRXJyb3IoJ1NlbnRyeSBzeW50aGV0aWNFeGNlcHRpb24nKTsKICAgIC8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBkZXByZWNhdGlvbi9kZXByZWNhdGlvbgogICAgdGhpcy5nZXRTY29wZSgpLmNhcHR1cmVFeGNlcHRpb24oZXhjZXB0aW9uLCB7CiAgICAgIG9yaWdpbmFsRXhjZXB0aW9uOiBleGNlcHRpb24sCiAgICAgIHN5bnRoZXRpY0V4Y2VwdGlvbiwKICAgICAgLi4uaGludCwKICAgICAgZXZlbnRfaWQ6IGV2ZW50SWQsCiAgICB9KTsKCiAgICByZXR1cm4gZXZlbnRJZDsKICB9CgogIC8qKgogICAqIEBpbmhlcml0RG9jCiAgICoKICAgKiBAZGVwcmVjYXRlZCBVc2UgIGBTZW50cnkuY2FwdHVyZU1lc3NhZ2UoKWAgaW5zdGVhZC4KICAgKi8KICAgY2FwdHVyZU1lc3NhZ2UoCiAgICBtZXNzYWdlLAogICAgLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIGRlcHJlY2F0aW9uL2RlcHJlY2F0aW9uCiAgICBsZXZlbCwKICAgIGhpbnQsCiAgKSB7CiAgICBjb25zdCBldmVudElkID0gKHRoaXMuX2xhc3RFdmVudElkID0gaGludCAmJiBoaW50LmV2ZW50X2lkID8gaGludC5ldmVudF9pZCA6IHV1aWQ0KCkpOwogICAgY29uc3Qgc3ludGhldGljRXhjZXB0aW9uID0gbmV3IEVycm9yKG1lc3NhZ2UpOwogICAgLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIGRlcHJlY2F0aW9uL2RlcHJlY2F0aW9uCiAgICB0aGlzLmdldFNjb3BlKCkuY2FwdHVyZU1lc3NhZ2UobWVzc2FnZSwgbGV2ZWwsIHsKICAgICAgb3JpZ2luYWxFeGNlcHRpb246IG1lc3NhZ2UsCiAgICAgIHN5bnRoZXRpY0V4Y2VwdGlvbiwKICAgICAgLi4uaGludCwKICAgICAgZXZlbnRfaWQ6IGV2ZW50SWQsCiAgICB9KTsKCiAgICByZXR1cm4gZXZlbnRJZDsKICB9CgogIC8qKgogICAqIEBpbmhlcml0RG9jCiAgICoKICAgKiBAZGVwcmVjYXRlZCBVc2UgYFNlbnRyeS5jYXB0dXJlRXZlbnQoKWAgaW5zdGVhZC4KICAgKi8KICAgY2FwdHVyZUV2ZW50KGV2ZW50LCBoaW50KSB7CiAgICBjb25zdCBldmVudElkID0gaGludCAmJiBoaW50LmV2ZW50X2lkID8gaGludC5ldmVudF9pZCA6IHV1aWQ0KCk7CiAgICBpZiAoIWV2ZW50LnR5cGUpIHsKICAgICAgdGhpcy5fbGFzdEV2ZW50SWQgPSBldmVudElkOwogICAgfQogICAgLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIGRlcHJlY2F0aW9uL2RlcHJlY2F0aW9uCiAgICB0aGlzLmdldFNjb3BlKCkuY2FwdHVyZUV2ZW50KGV2ZW50LCB7IC4uLmhpbnQsIGV2ZW50X2lkOiBldmVudElkIH0pOwogICAgcmV0dXJuIGV2ZW50SWQ7CiAgfQoKICAvKioKICAgKiBAaW5oZXJpdERvYwogICAqCiAgICogQGRlcHJlY2F0ZWQgVGhpcyB3aWxsIGJlIHJlbW92ZWQgaW4gdjguCiAgICovCiAgIGxhc3RFdmVudElkKCkgewogICAgcmV0dXJuIHRoaXMuX2xhc3RFdmVudElkOwogIH0KCiAgLyoqCiAgICogQGluaGVyaXREb2MKICAgKgogICAqIEBkZXByZWNhdGVkIFVzZSBgU2VudHJ5LmFkZEJyZWFkY3J1bWIoKWAgaW5zdGVhZC4KICAgKi8KICAgYWRkQnJlYWRjcnVtYihicmVhZGNydW1iLCBoaW50KSB7CiAgICAvLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgZGVwcmVjYXRpb24vZGVwcmVjYXRpb24KICAgIGNvbnN0IHsgc2NvcGUsIGNsaWVudCB9ID0gdGhpcy5nZXRTdGFja1RvcCgpOwoKICAgIGlmICghY2xpZW50KSByZXR1cm47CgogICAgY29uc3QgeyBiZWZvcmVCcmVhZGNydW1iID0gbnVsbCwgbWF4QnJlYWRjcnVtYnMgPSBERUZBVUxUX0JSRUFEQ1JVTUJTIH0gPQogICAgICAoY2xpZW50LmdldE9wdGlvbnMgJiYgY2xpZW50LmdldE9wdGlvbnMoKSkgfHwge307CgogICAgaWYgKG1heEJyZWFkY3J1bWJzIDw9IDApIHJldHVybjsKCiAgICBjb25zdCB0aW1lc3RhbXAgPSBkYXRlVGltZXN0YW1wSW5TZWNvbmRzKCk7CiAgICBjb25zdCBtZXJnZWRCcmVhZGNydW1iID0geyB0aW1lc3RhbXAsIC4uLmJyZWFkY3J1bWIgfTsKICAgIGNvbnN0IGZpbmFsQnJlYWRjcnVtYiA9IGJlZm9yZUJyZWFkY3J1bWIKICAgICAgPyAoY29uc29sZVNhbmRib3goKCkgPT4gYmVmb3JlQnJlYWRjcnVtYihtZXJnZWRCcmVhZGNydW1iLCBoaW50KSkgKQogICAgICA6IG1lcmdlZEJyZWFkY3J1bWI7CgogICAgaWYgKGZpbmFsQnJlYWRjcnVtYiA9PT0gbnVsbCkgcmV0dXJuOwoKICAgIGlmIChjbGllbnQuZW1pdCkgewogICAgICBjbGllbnQuZW1pdCgnYmVmb3JlQWRkQnJlYWRjcnVtYicsIGZpbmFsQnJlYWRjcnVtYiwgaGludCk7CiAgICB9CgogICAgLy8gVE9ETyh2OCk6IEkga25vdyB0aGlzIGNvbW1lbnQgZG9lc24ndCBtYWtlIG11Y2ggc2Vuc2UgYmVjYXVzZSB0aGUgaHViIHdpbGwgYmUgZGVwcmVjYXRlZCBidXQgSSBzdGlsbCB3YW50ZWQgdG8KICAgIC8vIHdyaXRlIGl0IGRvd24uIEluIHRoZW9yeSwgd2Ugd291bGQgaGF2ZSB0byBhZGQgdGhlIGJyZWFkY3J1bWJzIHRvIHRoZSBpc29sYXRpb24gc2NvcGUgaGVyZSwgaG93ZXZlciwgdGhhdCB3b3VsZAogICAgLy8gZHVwbGljYXRlIGFsbCBvZiB0aGUgYnJlYWRjcnVtYnMuIFRoZXJlIHdhcyB0aGUgcG9zc2liaWxpdHkgb2YgYWRkaW5nIGJyZWFkY3J1bWJzIHRvIGJvdGgsIHRoZSBpc29sYXRpb24gc2NvcGUKICAgIC8vIGFuZCB0aGUgbm9ybWFsIHNjb3BlLCBhbmQgZGVkdXBsaWNhdGluZyBpdCBkb3duIHRoZSBsaW5lIGluIHRoZSBldmVudCBwcm9jZXNzaW5nIHBpcGVsaW5lLiBIb3dldmVyLCB0aGF0IHdvdWxkCiAgICAvLyBoYXZlIGJlZW4gdmVyeSBmcmFnaWxlLCBiZWNhdXNlIHRoZSBicmVhZGNydW1iIG9iamVjdHMgd291bGQgaGF2ZSBuZWVkZWQgdG8ga2VlcCB0aGVpciBpZGVudGl0eSBhbGwgdGhyb3VnaG91dAogICAgLy8gdGhlIGV2ZW50IHByb2Nlc3NpbmcgcGlwZWxpbmUuCiAgICAvLyBJbiB0aGUgbmV3IGltcGxlbWVudGF0aW9uLCB0aGUgdG9wIGxldmVsIGBTZW50cnkuYWRkQnJlYWRjcnVtYigpYCBzaG91bGQgT05MWSB3cml0ZSB0byB0aGUgaXNvbGF0aW9uIHNjb3BlLgoKICAgIHNjb3BlLmFkZEJyZWFkY3J1bWIoZmluYWxCcmVhZGNydW1iLCBtYXhCcmVhZGNydW1icyk7CiAgfQoKICAvKioKICAgKiBAaW5oZXJpdERvYwogICAqIEBkZXByZWNhdGVkIFVzZSBgU2VudHJ5LnNldFVzZXIoKWAgaW5zdGVhZC4KICAgKi8KICAgc2V0VXNlcih1c2VyKSB7CiAgICAvLyBUT0RPKHY4KTogVGhlIHRvcCBsZXZlbCBgU2VudHJ5LnNldFVzZXIoKWAgZnVuY3Rpb24gc2hvdWxkIHdyaXRlIE9OTFkgdG8gdGhlIGlzb2xhdGlvbiBzY29wZS4KICAgIC8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBkZXByZWNhdGlvbi9kZXByZWNhdGlvbgogICAgdGhpcy5nZXRTY29wZSgpLnNldFVzZXIodXNlcik7CiAgICAvLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgZGVwcmVjYXRpb24vZGVwcmVjYXRpb24KICAgIHRoaXMuZ2V0SXNvbGF0aW9uU2NvcGUoKS5zZXRVc2VyKHVzZXIpOwogIH0KCiAgLyoqCiAgICogQGluaGVyaXREb2MKICAgKiBAZGVwcmVjYXRlZCBVc2UgYFNlbnRyeS5zZXRUYWdzKClgIGluc3RlYWQuCiAgICovCiAgIHNldFRhZ3ModGFncykgewogICAgLy8gVE9ETyh2OCk6IFRoZSB0b3AgbGV2ZWwgYFNlbnRyeS5zZXRUYWdzKClgIGZ1bmN0aW9uIHNob3VsZCB3cml0ZSBPTkxZIHRvIHRoZSBpc29sYXRpb24gc2NvcGUuCiAgICAvLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgZGVwcmVjYXRpb24vZGVwcmVjYXRpb24KICAgIHRoaXMuZ2V0U2NvcGUoKS5zZXRUYWdzKHRhZ3MpOwogICAgLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIGRlcHJlY2F0aW9uL2RlcHJlY2F0aW9uCiAgICB0aGlzLmdldElzb2xhdGlvblNjb3BlKCkuc2V0VGFncyh0YWdzKTsKICB9CgogIC8qKgogICAqIEBpbmhlcml0RG9jCiAgICogQGRlcHJlY2F0ZWQgVXNlIGBTZW50cnkuc2V0RXh0cmFzKClgIGluc3RlYWQuCiAgICovCiAgIHNldEV4dHJhcyhleHRyYXMpIHsKICAgIC8vIFRPRE8odjgpOiBUaGUgdG9wIGxldmVsIGBTZW50cnkuc2V0RXh0cmFzKClgIGZ1bmN0aW9uIHNob3VsZCB3cml0ZSBPTkxZIHRvIHRoZSBpc29sYXRpb24gc2NvcGUuCiAgICAvLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgZGVwcmVjYXRpb24vZGVwcmVjYXRpb24KICAgIHRoaXMuZ2V0U2NvcGUoKS5zZXRFeHRyYXMoZXh0cmFzKTsKICAgIC8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBkZXByZWNhdGlvbi9kZXByZWNhdGlvbgogICAgdGhpcy5nZXRJc29sYXRpb25TY29wZSgpLnNldEV4dHJhcyhleHRyYXMpOwogIH0KCiAgLyoqCiAgICogQGluaGVyaXREb2MKICAgKiBAZGVwcmVjYXRlZCBVc2UgYFNlbnRyeS5zZXRUYWcoKWAgaW5zdGVhZC4KICAgKi8KICAgc2V0VGFnKGtleSwgdmFsdWUpIHsKICAgIC8vIFRPRE8odjgpOiBUaGUgdG9wIGxldmVsIGBTZW50cnkuc2V0VGFnKClgIGZ1bmN0aW9uIHNob3VsZCB3cml0ZSBPTkxZIHRvIHRoZSBpc29sYXRpb24gc2NvcGUuCiAgICAvLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgZGVwcmVjYXRpb24vZGVwcmVjYXRpb24KICAgIHRoaXMuZ2V0U2NvcGUoKS5zZXRUYWcoa2V5LCB2YWx1ZSk7CiAgICAvLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgZGVwcmVjYXRpb24vZGVwcmVjYXRpb24KICAgIHRoaXMuZ2V0SXNvbGF0aW9uU2NvcGUoKS5zZXRUYWcoa2V5LCB2YWx1ZSk7CiAgfQoKICAvKioKICAgKiBAaW5oZXJpdERvYwogICAqIEBkZXByZWNhdGVkIFVzZSBgU2VudHJ5LnNldEV4dHJhKClgIGluc3RlYWQuCiAgICovCiAgIHNldEV4dHJhKGtleSwgZXh0cmEpIHsKICAgIC8vIFRPRE8odjgpOiBUaGUgdG9wIGxldmVsIGBTZW50cnkuc2V0RXh0cmEoKWAgZnVuY3Rpb24gc2hvdWxkIHdyaXRlIE9OTFkgdG8gdGhlIGlzb2xhdGlvbiBzY29wZS4KICAgIC8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBkZXByZWNhdGlvbi9kZXByZWNhdGlvbgogICAgdGhpcy5nZXRTY29wZSgpLnNldEV4dHJhKGtleSwgZXh0cmEpOwogICAgLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIGRlcHJlY2F0aW9uL2RlcHJlY2F0aW9uCiAgICB0aGlzLmdldElzb2xhdGlvblNjb3BlKCkuc2V0RXh0cmEoa2V5LCBleHRyYSk7CiAgfQoKICAvKioKICAgKiBAaW5oZXJpdERvYwogICAqIEBkZXByZWNhdGVkIFVzZSBgU2VudHJ5LnNldENvbnRleHQoKWAgaW5zdGVhZC4KICAgKi8KICAvLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgQHR5cGVzY3JpcHQtZXNsaW50L25vLWV4cGxpY2l0LWFueQogICBzZXRDb250ZXh0KG5hbWUsIGNvbnRleHQpIHsKICAgIC8vIFRPRE8odjgpOiBUaGUgdG9wIGxldmVsIGBTZW50cnkuc2V0Q29udGV4dCgpYCBmdW5jdGlvbiBzaG91bGQgd3JpdGUgT05MWSB0byB0aGUgaXNvbGF0aW9uIHNjb3BlLgogICAgLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIGRlcHJlY2F0aW9uL2RlcHJlY2F0aW9uCiAgICB0aGlzLmdldFNjb3BlKCkuc2V0Q29udGV4dChuYW1lLCBjb250ZXh0KTsKICAgIC8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBkZXByZWNhdGlvbi9kZXByZWNhdGlvbgogICAgdGhpcy5nZXRJc29sYXRpb25TY29wZSgpLnNldENvbnRleHQobmFtZSwgY29udGV4dCk7CiAgfQoKICAvKioKICAgKiBAaW5oZXJpdERvYwogICAqCiAgICogQGRlcHJlY2F0ZWQgVXNlIGBnZXRTY29wZSgpYCBkaXJlY3RseS4KICAgKi8KICAgY29uZmlndXJlU2NvcGUoY2FsbGJhY2spIHsKICAgIC8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBkZXByZWNhdGlvbi9kZXByZWNhdGlvbgogICAgY29uc3QgeyBzY29wZSwgY2xpZW50IH0gPSB0aGlzLmdldFN0YWNrVG9wKCk7CiAgICBpZiAoY2xpZW50KSB7CiAgICAgIGNhbGxiYWNrKHNjb3BlKTsKICAgIH0KICB9CgogIC8qKgogICAqIEBpbmhlcml0RG9jCiAgICovCiAgLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIGRlcHJlY2F0aW9uL2RlcHJlY2F0aW9uCiAgIHJ1bihjYWxsYmFjaykgewogICAgLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIGRlcHJlY2F0aW9uL2RlcHJlY2F0aW9uCiAgICBjb25zdCBvbGRIdWIgPSBtYWtlTWFpbih0aGlzKTsKICAgIHRyeSB7CiAgICAgIGNhbGxiYWNrKHRoaXMpOwogICAgfSBmaW5hbGx5IHsKICAgICAgLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIGRlcHJlY2F0aW9uL2RlcHJlY2F0aW9uCiAgICAgIG1ha2VNYWluKG9sZEh1Yik7CiAgICB9CiAgfQoKICAvKioKICAgKiBAaW5oZXJpdERvYwogICAqIEBkZXByZWNhdGVkIFVzZSBgU2VudHJ5LmdldENsaWVudCgpLmdldEludGVncmF0aW9uQnlOYW1lKClgIGluc3RlYWQuCiAgICovCiAgIGdldEludGVncmF0aW9uKGludGVncmF0aW9uKSB7CiAgICAvLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgZGVwcmVjYXRpb24vZGVwcmVjYXRpb24KICAgIGNvbnN0IGNsaWVudCA9IHRoaXMuZ2V0Q2xpZW50KCk7CiAgICBpZiAoIWNsaWVudCkgcmV0dXJuIG51bGw7CiAgICB0cnkgewogICAgICAvLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgZGVwcmVjYXRpb24vZGVwcmVjYXRpb24KICAgICAgcmV0dXJuIGNsaWVudC5nZXRJbnRlZ3JhdGlvbihpbnRlZ3JhdGlvbik7CiAgICB9IGNhdGNoIChfb08pIHsKICAgICAgREVCVUdfQlVJTEQgJiYgbG9nZ2VyLndhcm4oYENhbm5vdCByZXRyaWV2ZSBpbnRlZ3JhdGlvbiAke2ludGVncmF0aW9uLmlkfSBmcm9tIHRoZSBjdXJyZW50IEh1YmApOwogICAgICByZXR1cm4gbnVsbDsKICAgIH0KICB9CgogIC8qKgogICAqIFN0YXJ0cyBhIG5ldyBgVHJhbnNhY3Rpb25gIGFuZCByZXR1cm5zIGl0LiBUaGlzIGlzIHRoZSBlbnRyeSBwb2ludCB0byBtYW51YWwgdHJhY2luZyBpbnN0cnVtZW50YXRpb24uCiAgICoKICAgKiBBIHRyZWUgc3RydWN0dXJlIGNhbiBiZSBidWlsdCBieSBhZGRpbmcgY2hpbGQgc3BhbnMgdG8gdGhlIHRyYW5zYWN0aW9uLCBhbmQgY2hpbGQgc3BhbnMgdG8gb3RoZXIgc3BhbnMuIFRvIHN0YXJ0IGEKICAgKiBuZXcgY2hpbGQgc3BhbiB3aXRoaW4gdGhlIHRyYW5zYWN0aW9uIG9yIGFueSBzcGFuLCBjYWxsIHRoZSByZXNwZWN0aXZlIGAuc3RhcnRDaGlsZCgpYCBtZXRob2QuCiAgICoKICAgKiBFdmVyeSBjaGlsZCBzcGFuIG11c3QgYmUgZmluaXNoZWQgYmVmb3JlIHRoZSB0cmFuc2FjdGlvbiBpcyBmaW5pc2hlZCwgb3RoZXJ3aXNlIHRoZSB1bmZpbmlzaGVkIHNwYW5zIGFyZSBkaXNjYXJkZWQuCiAgICoKICAgKiBUaGUgdHJhbnNhY3Rpb24gbXVzdCBiZSBmaW5pc2hlZCB3aXRoIGEgY2FsbCB0byBpdHMgYC5lbmQoKWAgbWV0aG9kLCBhdCB3aGljaCBwb2ludCB0aGUgdHJhbnNhY3Rpb24gd2l0aCBhbGwgaXRzCiAgICogZmluaXNoZWQgY2hpbGQgc3BhbnMgd2lsbCBiZSBzZW50IHRvIFNlbnRyeS4KICAgKgogICAqIEBwYXJhbSBjb250ZXh0IFByb3BlcnRpZXMgb2YgdGhlIG5ldyBgVHJhbnNhY3Rpb25gLgogICAqIEBwYXJhbSBjdXN0b21TYW1wbGluZ0NvbnRleHQgSW5mb3JtYXRpb24gZ2l2ZW4gdG8gdGhlIHRyYW5zYWN0aW9uIHNhbXBsaW5nIGZ1bmN0aW9uIChhbG9uZyB3aXRoIGNvbnRleHQtZGVwZW5kZW50CiAgICogZGVmYXVsdCB2YWx1ZXMpLiBTZWUge0BsaW5rIE9wdGlvbnMudHJhY2VzU2FtcGxlcn0uCiAgICoKICAgKiBAcmV0dXJucyBUaGUgdHJhbnNhY3Rpb24gd2hpY2ggd2FzIGp1c3Qgc3RhcnRlZAogICAqCiAgICogQGRlcHJlY2F0ZWQgVXNlIGBzdGFydFNwYW4oKWAsIGBzdGFydFNwYW5NYW51YWwoKWAgb3IgYHN0YXJ0SW5hY3RpdmVTcGFuKClgIGluc3RlYWQuCiAgICovCiAgIHN0YXJ0VHJhbnNhY3Rpb24oY29udGV4dCwgY3VzdG9tU2FtcGxpbmdDb250ZXh0KSB7CiAgICBjb25zdCByZXN1bHQgPSB0aGlzLl9jYWxsRXh0ZW5zaW9uTWV0aG9kKCdzdGFydFRyYW5zYWN0aW9uJywgY29udGV4dCwgY3VzdG9tU2FtcGxpbmdDb250ZXh0KTsKCiAgICBpZiAoREVCVUdfQlVJTEQgJiYgIXJlc3VsdCkgewogICAgICAvLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgZGVwcmVjYXRpb24vZGVwcmVjYXRpb24KICAgICAgY29uc3QgY2xpZW50ID0gdGhpcy5nZXRDbGllbnQoKTsKICAgICAgaWYgKCFjbGllbnQpIHsKICAgICAgICBsb2dnZXIud2FybigKICAgICAgICAgICJUcmFjaW5nIGV4dGVuc2lvbiAnc3RhcnRUcmFuc2FjdGlvbicgaXMgbWlzc2luZy4gWW91IHNob3VsZCAnaW5pdCcgdGhlIFNESyBiZWZvcmUgY2FsbGluZyAnc3RhcnRUcmFuc2FjdGlvbiciLAogICAgICAgICk7CiAgICAgIH0gZWxzZSB7CiAgICAgICAgbG9nZ2VyLndhcm4oYFRyYWNpbmcgZXh0ZW5zaW9uICdzdGFydFRyYW5zYWN0aW9uJyBoYXMgbm90IGJlZW4gYWRkZWQuIENhbGwgJ2FkZFRyYWNpbmdFeHRlbnNpb25zJyBiZWZvcmUgY2FsbGluZyAnaW5pdCc6ClNlbnRyeS5hZGRUcmFjaW5nRXh0ZW5zaW9ucygpOwpTZW50cnkuaW5pdCh7Li4ufSk7CmApOwogICAgICB9CiAgICB9CgogICAgcmV0dXJuIHJlc3VsdDsKICB9CgogIC8qKgogICAqIEBpbmhlcml0RG9jCiAgICogQGRlcHJlY2F0ZWQgVXNlIGBzcGFuVG9UcmFjZUhlYWRlcigpYCBpbnN0ZWFkLgogICAqLwogICB0cmFjZUhlYWRlcnMoKSB7CiAgICByZXR1cm4gdGhpcy5fY2FsbEV4dGVuc2lvbk1ldGhvZCgndHJhY2VIZWFkZXJzJyk7CiAgfQoKICAvKioKICAgKiBAaW5oZXJpdERvYwogICAqCiAgICogQGRlcHJlY2F0ZWQgVXNlIHRvcCBsZXZlbCBgY2FwdHVyZVNlc3Npb25gIGluc3RlYWQuCiAgICovCiAgIGNhcHR1cmVTZXNzaW9uKGVuZFNlc3Npb24gPSBmYWxzZSkgewogICAgLy8gYm90aCBzZW5kIHRoZSB1cGRhdGUgYW5kIHB1bGwgdGhlIHNlc3Npb24gZnJvbSB0aGUgc2NvcGUKICAgIGlmIChlbmRTZXNzaW9uKSB7CiAgICAgIC8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBkZXByZWNhdGlvbi9kZXByZWNhdGlvbgogICAgICByZXR1cm4gdGhpcy5lbmRTZXNzaW9uKCk7CiAgICB9CgogICAgLy8gb25seSBzZW5kIHRoZSB1cGRhdGUKICAgIHRoaXMuX3NlbmRTZXNzaW9uVXBkYXRlKCk7CiAgfQoKICAvKioKICAgKiBAaW5oZXJpdERvYwogICAqIEBkZXByZWNhdGVkIFVzZSB0b3AgbGV2ZWwgYGVuZFNlc3Npb25gIGluc3RlYWQuCiAgICovCiAgIGVuZFNlc3Npb24oKSB7CiAgICAvLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgZGVwcmVjYXRpb24vZGVwcmVjYXRpb24KICAgIGNvbnN0IGxheWVyID0gdGhpcy5nZXRTdGFja1RvcCgpOwogICAgY29uc3Qgc2NvcGUgPSBsYXllci5zY29wZTsKICAgIGNvbnN0IHNlc3Npb24gPSBzY29wZS5nZXRTZXNzaW9uKCk7CiAgICBpZiAoc2Vzc2lvbikgewogICAgICBjbG9zZVNlc3Npb24oc2Vzc2lvbik7CiAgICB9CiAgICB0aGlzLl9zZW5kU2Vzc2lvblVwZGF0ZSgpOwoKICAgIC8vIHRoZSBzZXNzaW9uIGlzIG92ZXI7IHRha2UgaXQgb2ZmIG9mIHRoZSBzY29wZQogICAgc2NvcGUuc2V0U2Vzc2lvbigpOwogIH0KCiAgLyoqCiAgICogQGluaGVyaXREb2MKICAgKiBAZGVwcmVjYXRlZCBVc2UgdG9wIGxldmVsIGBzdGFydFNlc3Npb25gIGluc3RlYWQuCiAgICovCiAgIHN0YXJ0U2Vzc2lvbihjb250ZXh0KSB7CiAgICAvLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgZGVwcmVjYXRpb24vZGVwcmVjYXRpb24KICAgIGNvbnN0IHsgc2NvcGUsIGNsaWVudCB9ID0gdGhpcy5nZXRTdGFja1RvcCgpOwogICAgY29uc3QgeyByZWxlYXNlLCBlbnZpcm9ubWVudCA9IERFRkFVTFRfRU5WSVJPTk1FTlQgfSA9IChjbGllbnQgJiYgY2xpZW50LmdldE9wdGlvbnMoKSkgfHwge307CgogICAgLy8gV2lsbCBmZXRjaCB1c2VyQWdlbnQgaWYgY2FsbGVkIGZyb20gYnJvd3NlciBzZGsKICAgIGNvbnN0IHsgdXNlckFnZW50IH0gPSBHTE9CQUxfT0JKLm5hdmlnYXRvciB8fCB7fTsKCiAgICBjb25zdCBzZXNzaW9uID0gbWFrZVNlc3Npb24oewogICAgICByZWxlYXNlLAogICAgICBlbnZpcm9ubWVudCwKICAgICAgdXNlcjogc2NvcGUuZ2V0VXNlcigpLAogICAgICAuLi4odXNlckFnZW50ICYmIHsgdXNlckFnZW50IH0pLAogICAgICAuLi5jb250ZXh0LAogICAgfSk7CgogICAgLy8gRW5kIGV4aXN0aW5nIHNlc3Npb24gaWYgdGhlcmUncyBvbmUKICAgIGNvbnN0IGN1cnJlbnRTZXNzaW9uID0gc2NvcGUuZ2V0U2Vzc2lvbiAmJiBzY29wZS5nZXRTZXNzaW9uKCk7CiAgICBpZiAoY3VycmVudFNlc3Npb24gJiYgY3VycmVudFNlc3Npb24uc3RhdHVzID09PSAnb2snKSB7CiAgICAgIHVwZGF0ZVNlc3Npb24oY3VycmVudFNlc3Npb24sIHsgc3RhdHVzOiAnZXhpdGVkJyB9KTsKICAgIH0KICAgIC8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBkZXByZWNhdGlvbi9kZXByZWNhdGlvbgogICAgdGhpcy5lbmRTZXNzaW9uKCk7CgogICAgLy8gQWZ0ZXJ3YXJkcyB3ZSBzZXQgdGhlIG5ldyBzZXNzaW9uIG9uIHRoZSBzY29wZQogICAgc2NvcGUuc2V0U2Vzc2lvbihzZXNzaW9uKTsKCiAgICByZXR1cm4gc2Vzc2lvbjsKICB9CgogIC8qKgogICAqIFJldHVybnMgaWYgZGVmYXVsdCBQSUkgc2hvdWxkIGJlIHNlbnQgdG8gU2VudHJ5IGFuZCBwcm9wYWdhdGVkIGluIG91cmdvaW5nIHJlcXVlc3RzCiAgICogd2hlbiBUcmFjaW5nIGlzIHVzZWQuCiAgICoKICAgKiBAZGVwcmVjYXRlZCBVc2UgdG9wLWxldmVsIGBnZXRDbGllbnQoKS5nZXRPcHRpb25zKCkuc2VuZERlZmF1bHRQaWlgIGluc3RlYWQuIFRoaXMgZnVuY3Rpb24KICAgKiBvbmx5IHVubmVjZXNzYXJpbHkgaW5jcmVhc2VkIEFQSSBzdXJmYWNlIGJ1dCBvbmx5IHdyYXBwZWQgYWNjZXNzaW5nIHRoZSBvcHRpb24uCiAgICovCiAgIHNob3VsZFNlbmREZWZhdWx0UGlpKCkgewogICAgLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIGRlcHJlY2F0aW9uL2RlcHJlY2F0aW9uCiAgICBjb25zdCBjbGllbnQgPSB0aGlzLmdldENsaWVudCgpOwogICAgY29uc3Qgb3B0aW9ucyA9IGNsaWVudCAmJiBjbGllbnQuZ2V0T3B0aW9ucygpOwogICAgcmV0dXJuIEJvb2xlYW4ob3B0aW9ucyAmJiBvcHRpb25zLnNlbmREZWZhdWx0UGlpKTsKICB9CgogIC8qKgogICAqIFNlbmRzIHRoZSBjdXJyZW50IFNlc3Npb24gb24gdGhlIHNjb3BlCiAgICovCiAgIF9zZW5kU2Vzc2lvblVwZGF0ZSgpIHsKICAgIC8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBkZXByZWNhdGlvbi9kZXByZWNhdGlvbgogICAgY29uc3QgeyBzY29wZSwgY2xpZW50IH0gPSB0aGlzLmdldFN0YWNrVG9wKCk7CgogICAgY29uc3Qgc2Vzc2lvbiA9IHNjb3BlLmdldFNlc3Npb24oKTsKICAgIGlmIChzZXNzaW9uICYmIGNsaWVudCAmJiBjbGllbnQuY2FwdHVyZVNlc3Npb24pIHsKICAgICAgY2xpZW50LmNhcHR1cmVTZXNzaW9uKHNlc3Npb24pOwogICAgfQogIH0KCiAgLyoqCiAgICogQ2FsbHMgZ2xvYmFsIGV4dGVuc2lvbiBtZXRob2QgYW5kIGJpbmRpbmcgY3VycmVudCBpbnN0YW5jZSB0byB0aGUgZnVuY3Rpb24gY2FsbAogICAqLwogIC8vIEB0cy1leHBlY3QtZXJyb3IgRnVuY3Rpb24gbGFja3MgZW5kaW5nIHJldHVybiBzdGF0ZW1lbnQgYW5kIHJldHVybiB0eXBlIGRvZXMgbm90IGluY2x1ZGUgJ3VuZGVmaW5lZCcuIHRzKDIzNjYpCiAgLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIEB0eXBlc2NyaXB0LWVzbGludC9uby1leHBsaWNpdC1hbnkKICAgX2NhbGxFeHRlbnNpb25NZXRob2QobWV0aG9kLCAuLi5hcmdzKSB7CiAgICBjb25zdCBjYXJyaWVyID0gZ2V0TWFpbkNhcnJpZXIoKTsKICAgIGNvbnN0IHNlbnRyeSA9IGNhcnJpZXIuX19TRU5UUllfXzsKICAgIGlmIChzZW50cnkgJiYgc2VudHJ5LmV4dGVuc2lvbnMgJiYgdHlwZW9mIHNlbnRyeS5leHRlbnNpb25zW21ldGhvZF0gPT09ICdmdW5jdGlvbicpIHsKICAgICAgcmV0dXJuIHNlbnRyeS5leHRlbnNpb25zW21ldGhvZF0uYXBwbHkodGhpcywgYXJncyk7CiAgICB9CiAgICBERUJVR19CVUlMRCAmJiBsb2dnZXIud2FybihgRXh0ZW5zaW9uIG1ldGhvZCAke21ldGhvZH0gY291bGRuJ3QgYmUgZm91bmQsIGRvaW5nIG5vdGhpbmcuYCk7CiAgfQp9CgovKioKICogUmV0dXJucyB0aGUgZ2xvYmFsIHNoaW0gcmVnaXN0cnkuCiAqCiAqIEZJWE1FOiBUaGlzIGZ1bmN0aW9uIGlzIHByb2JsZW1hdGljLCBiZWNhdXNlIGRlc3BpdGUgYWx3YXlzIHJldHVybmluZyBhIHZhbGlkIENhcnJpZXIsCiAqIGl0IGhhcyBhbiBvcHRpb25hbCBgX19TRU5UUllfX2AgcHJvcGVydHksIHdoaWNoIHRoZW4gaW4gdHVybiByZXF1aXJlcyB1cyB0byBhbHdheXMgcGVyZm9ybSBhbiB1bm5lY2Vzc2FyeSBjaGVjawogKiBhdCB0aGUgY2FsbC1zaXRlLiBXZSBhbHdheXMgYWNjZXNzIHRoZSBjYXJyaWVyIHRocm91Z2ggdGhpcyBmdW5jdGlvbiwgc28gd2UgY2FuIGd1YXJhbnRlZSB0aGF0IGBfX1NFTlRSWV9fYCBpcyB0aGVyZS4KICoqLwpmdW5jdGlvbiBnZXRNYWluQ2FycmllcigpIHsKICBHTE9CQUxfT0JKLl9fU0VOVFJZX18gPSBHTE9CQUxfT0JKLl9fU0VOVFJZX18gfHwgewogICAgZXh0ZW5zaW9uczoge30sCiAgICBodWI6IHVuZGVmaW5lZCwKICB9OwogIHJldHVybiBHTE9CQUxfT0JKOwp9CgovKioKICogUmVwbGFjZXMgdGhlIGN1cnJlbnQgbWFpbiBodWIgd2l0aCB0aGUgcGFzc2VkIG9uZSBvbiB0aGUgZ2xvYmFsIG9iamVjdAogKgogKiBAcmV0dXJucyBUaGUgb2xkIHJlcGxhY2VkIGh1YgogKgogKiBAZGVwcmVjYXRlZCBVc2UgYHNldEN1cnJlbnRDbGllbnQoKWAgaW5zdGVhZC4KICovCi8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBkZXByZWNhdGlvbi9kZXByZWNhdGlvbgpmdW5jdGlvbiBtYWtlTWFpbihodWIpIHsKICBjb25zdCByZWdpc3RyeSA9IGdldE1haW5DYXJyaWVyKCk7CiAgY29uc3Qgb2xkSHViID0gZ2V0SHViRnJvbUNhcnJpZXIocmVnaXN0cnkpOwogIHNldEh1Yk9uQ2FycmllcihyZWdpc3RyeSwgaHViKTsKICByZXR1cm4gb2xkSHViOwp9CgovKioKICogUmV0dXJucyB0aGUgZGVmYXVsdCBodWIgaW5zdGFuY2UuCiAqCiAqIElmIGEgaHViIGlzIGFscmVhZHkgcmVnaXN0ZXJlZCBpbiB0aGUgZ2xvYmFsIGNhcnJpZXIgYnV0IHRoaXMgbW9kdWxlCiAqIGNvbnRhaW5zIGEgbW9yZSByZWNlbnQgdmVyc2lvbiwgaXQgcmVwbGFjZXMgdGhlIHJlZ2lzdGVyZWQgdmVyc2lvbi4KICogT3RoZXJ3aXNlLCB0aGUgY3VycmVudGx5IHJlZ2lzdGVyZWQgaHViIHdpbGwgYmUgcmV0dXJuZWQuCiAqCiAqIEBkZXByZWNhdGVkIFVzZSB0aGUgcmVzcGVjdGl2ZSByZXBsYWNlbWVudCBtZXRob2QgZGlyZWN0bHkgaW5zdGVhZC4KICovCi8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBkZXByZWNhdGlvbi9kZXByZWNhdGlvbgpmdW5jdGlvbiBnZXRDdXJyZW50SHViKCkgewogIC8vIEdldCBtYWluIGNhcnJpZXIgKGdsb2JhbCBmb3IgZXZlcnkgZW52aXJvbm1lbnQpCiAgY29uc3QgcmVnaXN0cnkgPSBnZXRNYWluQ2FycmllcigpOwoKICBpZiAocmVnaXN0cnkuX19TRU5UUllfXyAmJiByZWdpc3RyeS5fX1NFTlRSWV9fLmFjcykgewogICAgY29uc3QgaHViID0gcmVnaXN0cnkuX19TRU5UUllfXy5hY3MuZ2V0Q3VycmVudEh1YigpOwoKICAgIGlmIChodWIpIHsKICAgICAgcmV0dXJuIGh1YjsKICAgIH0KICB9CgogIC8vIFJldHVybiBodWIgdGhhdCBsaXZlcyBvbiBhIGdsb2JhbCBvYmplY3QKICByZXR1cm4gZ2V0R2xvYmFsSHViKHJlZ2lzdHJ5KTsKfQoKLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIGRlcHJlY2F0aW9uL2RlcHJlY2F0aW9uCmZ1bmN0aW9uIGdldEdsb2JhbEh1YihyZWdpc3RyeSA9IGdldE1haW5DYXJyaWVyKCkpIHsKICAvLyBJZiB0aGVyZSdzIG5vIGh1Yiwgb3IgaXRzIGFuIG9sZCBBUEksIGFzc2lnbiBhIG5ldyBvbmUKCiAgaWYgKAogICAgIWhhc0h1Yk9uQ2FycmllcihyZWdpc3RyeSkgfHwKICAgIC8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBkZXByZWNhdGlvbi9kZXByZWNhdGlvbgogICAgZ2V0SHViRnJvbUNhcnJpZXIocmVnaXN0cnkpLmlzT2xkZXJUaGFuKEFQSV9WRVJTSU9OKQogICkgewogICAgLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIGRlcHJlY2F0aW9uL2RlcHJlY2F0aW9uCiAgICBzZXRIdWJPbkNhcnJpZXIocmVnaXN0cnksIG5ldyBIdWIoKSk7CiAgfQoKICAvLyBSZXR1cm4gaHViIHRoYXQgbGl2ZXMgb24gYSBnbG9iYWwgb2JqZWN0CiAgcmV0dXJuIGdldEh1YkZyb21DYXJyaWVyKHJlZ2lzdHJ5KTsKfQoKLyoqCiAqIFRoaXMgd2lsbCB0ZWxsIHdoZXRoZXIgYSBjYXJyaWVyIGhhcyBhIGh1YiBvbiBpdCBvciBub3QKICogQHBhcmFtIGNhcnJpZXIgb2JqZWN0CiAqLwpmdW5jdGlvbiBoYXNIdWJPbkNhcnJpZXIoY2FycmllcikgewogIHJldHVybiAhIShjYXJyaWVyICYmIGNhcnJpZXIuX19TRU5UUllfXyAmJiBjYXJyaWVyLl9fU0VOVFJZX18uaHViKTsKfQoKLyoqCiAqIFRoaXMgd2lsbCBjcmVhdGUgYSBuZXcge0BsaW5rIEh1Yn0gYW5kIGFkZCB0byB0aGUgcGFzc2VkIG9iamVjdCBvbgogKiBfX1NFTlRSWV9fLmh1Yi4KICogQHBhcmFtIGNhcnJpZXIgb2JqZWN0CiAqIEBoaWRkZW4KICovCi8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBkZXByZWNhdGlvbi9kZXByZWNhdGlvbgpmdW5jdGlvbiBnZXRIdWJGcm9tQ2FycmllcihjYXJyaWVyKSB7CiAgLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIGRlcHJlY2F0aW9uL2RlcHJlY2F0aW9uCiAgcmV0dXJuIGdldEdsb2JhbFNpbmdsZXRvbignaHViJywgKCkgPT4gbmV3IEh1YigpLCBjYXJyaWVyKTsKfQoKLyoqCiAqIFRoaXMgd2lsbCBzZXQgcGFzc2VkIHtAbGluayBIdWJ9IG9uIHRoZSBwYXNzZWQgb2JqZWN0J3MgX19TRU5UUllfXy5odWIgYXR0cmlidXRlCiAqIEBwYXJhbSBjYXJyaWVyIG9iamVjdAogKiBAcGFyYW0gaHViIEh1YgogKiBAcmV0dXJucyBBIGJvb2xlYW4gaW5kaWNhdGluZyBzdWNjZXNzIG9yIGZhaWx1cmUKICovCi8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBkZXByZWNhdGlvbi9kZXByZWNhdGlvbgpmdW5jdGlvbiBzZXRIdWJPbkNhcnJpZXIoY2FycmllciwgaHViKSB7CiAgaWYgKCFjYXJyaWVyKSByZXR1cm4gZmFsc2U7CiAgY29uc3QgX19TRU5UUllfXyA9IChjYXJyaWVyLl9fU0VOVFJZX18gPSBjYXJyaWVyLl9fU0VOVFJZX18gfHwge30pOwogIF9fU0VOVFJZX18uaHViID0gaHViOwogIHJldHVybiB0cnVlOwp9CgovKioKICogQXBwbHkgU2RrSW5mbyAobmFtZSwgdmVyc2lvbiwgcGFja2FnZXMsIGludGVncmF0aW9ucykgdG8gdGhlIGNvcnJlc3BvbmRpbmcgZXZlbnQga2V5LgogKiBNZXJnZSB3aXRoIGV4aXN0aW5nIGRhdGEgaWYgYW55LgogKiovCmZ1bmN0aW9uIGVuaGFuY2VFdmVudFdpdGhTZGtJbmZvKGV2ZW50LCBzZGtJbmZvKSB7CiAgaWYgKCFzZGtJbmZvKSB7CiAgICByZXR1cm4gZXZlbnQ7CiAgfQogIGV2ZW50LnNkayA9IGV2ZW50LnNkayB8fCB7fTsKICBldmVudC5zZGsubmFtZSA9IGV2ZW50LnNkay5uYW1lIHx8IHNka0luZm8ubmFtZTsKICBldmVudC5zZGsudmVyc2lvbiA9IGV2ZW50LnNkay52ZXJzaW9uIHx8IHNka0luZm8udmVyc2lvbjsKICBldmVudC5zZGsuaW50ZWdyYXRpb25zID0gWy4uLihldmVudC5zZGsuaW50ZWdyYXRpb25zIHx8IFtdKSwgLi4uKHNka0luZm8uaW50ZWdyYXRpb25zIHx8IFtdKV07CiAgZXZlbnQuc2RrLnBhY2thZ2VzID0gWy4uLihldmVudC5zZGsucGFja2FnZXMgfHwgW10pLCAuLi4oc2RrSW5mby5wYWNrYWdlcyB8fCBbXSldOwogIHJldHVybiBldmVudDsKfQoKLyoqIENyZWF0ZXMgYW4gZW52ZWxvcGUgZnJvbSBhIFNlc3Npb24gKi8KZnVuY3Rpb24gY3JlYXRlU2Vzc2lvbkVudmVsb3BlKAogIHNlc3Npb24sCiAgZHNuLAogIG1ldGFkYXRhLAogIHR1bm5lbCwKKSB7CiAgY29uc3Qgc2RrSW5mbyA9IGdldFNka01ldGFkYXRhRm9yRW52ZWxvcGVIZWFkZXIobWV0YWRhdGEpOwogIGNvbnN0IGVudmVsb3BlSGVhZGVycyA9IHsKICAgIHNlbnRfYXQ6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSwKICAgIC4uLihzZGtJbmZvICYmIHsgc2RrOiBzZGtJbmZvIH0pLAogICAgLi4uKCEhdHVubmVsICYmIGRzbiAmJiB7IGRzbjogZHNuVG9TdHJpbmcoZHNuKSB9KSwKICB9OwoKICBjb25zdCBlbnZlbG9wZUl0ZW0gPQogICAgJ2FnZ3JlZ2F0ZXMnIGluIHNlc3Npb24gPyBbeyB0eXBlOiAnc2Vzc2lvbnMnIH0sIHNlc3Npb25dIDogW3sgdHlwZTogJ3Nlc3Npb24nIH0sIHNlc3Npb24udG9KU09OKCldOwoKICByZXR1cm4gY3JlYXRlRW52ZWxvcGUoZW52ZWxvcGVIZWFkZXJzLCBbZW52ZWxvcGVJdGVtXSk7Cn0KCi8qKgogKiBDcmVhdGUgYW4gRW52ZWxvcGUgZnJvbSBhbiBldmVudC4KICovCmZ1bmN0aW9uIGNyZWF0ZUV2ZW50RW52ZWxvcGUoCiAgZXZlbnQsCiAgZHNuLAogIG1ldGFkYXRhLAogIHR1bm5lbCwKKSB7CiAgY29uc3Qgc2RrSW5mbyA9IGdldFNka01ldGFkYXRhRm9yRW52ZWxvcGVIZWFkZXIobWV0YWRhdGEpOwoKICAvKgogICAgTm90ZTogRHVlIHRvIFRTLCBldmVudC50eXBlIG1heSBiZSBgcmVwbGF5X2V2ZW50YCwgdGhlb3JldGljYWxseS4KICAgIEluIHByYWN0aWNlLCB3ZSBuZXZlciBjYWxsIGBjcmVhdGVFdmVudEVudmVsb3BlYCB3aXRoIGByZXBsYXlfZXZlbnRgIHR5cGUsCiAgICBhbmQgd2UnZCBoYXZlIHRvIGFkanV0IGEgbG9vb3Qgb2YgdHlwZXMgdG8gbWFrZSB0aGlzIHdvcmsgcHJvcGVybHkuCiAgICBXZSB3YW50IHRvIGF2b2lkIGNhc3RpbmcgdGhpcyBhcm91bmQsIGFzIHRoYXQgY291bGQgbGVhZCB0byBidWdzIChlLmcuIHdoZW4gd2UgYWRkIGFub3RoZXIgdHlwZSkKICAgIFNvIHRoZSBzYWZlIGNob2ljZSBpcyB0byByZWFsbHkgZ3VhcmQgYWdhaW5zdCB0aGUgcmVwbGF5X2V2ZW50IHR5cGUgaGVyZS4KICAqLwogIGNvbnN0IGV2ZW50VHlwZSA9IGV2ZW50LnR5cGUgJiYgZXZlbnQudHlwZSAhPT0gJ3JlcGxheV9ldmVudCcgPyBldmVudC50eXBlIDogJ2V2ZW50JzsKCiAgZW5oYW5jZUV2ZW50V2l0aFNka0luZm8oZXZlbnQsIG1ldGFkYXRhICYmIG1ldGFkYXRhLnNkayk7CgogIGNvbnN0IGVudmVsb3BlSGVhZGVycyA9IGNyZWF0ZUV2ZW50RW52ZWxvcGVIZWFkZXJzKGV2ZW50LCBzZGtJbmZvLCB0dW5uZWwsIGRzbik7CgogIC8vIFByZXZlbnQgdGhpcyBkYXRhICh3aGljaCwgaWYgaXQgZXhpc3RzLCB3YXMgdXNlZCBpbiBlYXJsaWVyIHN0ZXBzIGluIHRoZSBwcm9jZXNzaW5nIHBpcGVsaW5lKSBmcm9tIGJlaW5nIHNlbnQgdG8KICAvLyBzZW50cnkuIChOb3RlOiBPdXIgdXNlIG9mIHRoaXMgcHJvcGVydHkgY29tZXMgYW5kIGdvZXMgd2l0aCB3aGF0ZXZlciB3ZSBtaWdodCBiZSBkZWJ1Z2dpbmcsIHdoYXRldmVyIGhhY2tzIHdlIG1heQogIC8vIGhhdmUgdGVtcG9yYXJpbHkgYWRkZWQsIGV0Yy4gRXZlbiBpZiB3ZSBkb24ndCBoYXBwZW4gdG8gYmUgdXNpbmcgaXQgYXQgc29tZSBwb2ludCBpbiB0aGUgZnV0dXJlLCBsZXQncyBub3QgZ2V0IHJpZAogIC8vIG9mIHRoaXMgYGRlbGV0ZWAsIGxlc3Qgd2UgbWlzcyBwdXR0aW5nIGl0IGJhY2sgaW4gdGhlIG5leHQgdGltZSB0aGUgcHJvcGVydHkgaXMgaW4gdXNlLikKICBkZWxldGUgZXZlbnQuc2RrUHJvY2Vzc2luZ01ldGFkYXRhOwoKICBjb25zdCBldmVudEl0ZW0gPSBbeyB0eXBlOiBldmVudFR5cGUgfSwgZXZlbnRdOwogIHJldHVybiBjcmVhdGVFbnZlbG9wZShlbnZlbG9wZUhlYWRlcnMsIFtldmVudEl0ZW1dKTsKfQoKY29uc3QgU0VOVFJZX0FQSV9WRVJTSU9OID0gJzcnOwoKLyoqIFJldHVybnMgdGhlIHByZWZpeCB0byBjb25zdHJ1Y3QgU2VudHJ5IGluZ2VzdGlvbiBBUEkgZW5kcG9pbnRzLiAqLwpmdW5jdGlvbiBnZXRCYXNlQXBpRW5kcG9pbnQoZHNuKSB7CiAgY29uc3QgcHJvdG9jb2wgPSBkc24ucHJvdG9jb2wgPyBgJHtkc24ucHJvdG9jb2x9OmAgOiAnJzsKICBjb25zdCBwb3J0ID0gZHNuLnBvcnQgPyBgOiR7ZHNuLnBvcnR9YCA6ICcnOwogIHJldHVybiBgJHtwcm90b2NvbH0vLyR7ZHNuLmhvc3R9JHtwb3J0fSR7ZHNuLnBhdGggPyBgLyR7ZHNuLnBhdGh9YCA6ICcnfS9hcGkvYDsKfQoKLyoqIFJldHVybnMgdGhlIGluZ2VzdCBBUEkgZW5kcG9pbnQgZm9yIHRhcmdldC4gKi8KZnVuY3Rpb24gX2dldEluZ2VzdEVuZHBvaW50KGRzbikgewogIHJldHVybiBgJHtnZXRCYXNlQXBpRW5kcG9pbnQoZHNuKX0ke2Rzbi5wcm9qZWN0SWR9L2VudmVsb3BlL2A7Cn0KCi8qKiBSZXR1cm5zIGEgVVJMLWVuY29kZWQgc3RyaW5nIHdpdGggYXV0aCBjb25maWcgc3VpdGFibGUgZm9yIGEgcXVlcnkgc3RyaW5nLiAqLwpmdW5jdGlvbiBfZW5jb2RlZEF1dGgoZHNuLCBzZGtJbmZvKSB7CiAgcmV0dXJuIHVybEVuY29kZSh7CiAgICAvLyBXZSBzZW5kIG9ubHkgdGhlIG1pbmltdW0gc2V0IG9mIHJlcXVpcmVkIGluZm9ybWF0aW9uLiBTZWUKICAgIC8vIGh0dHBzOi8vZ2l0aHViLmNvbS9nZXRzZW50cnkvc2VudHJ5LWphdmFzY3JpcHQvaXNzdWVzLzI1NzIuCiAgICBzZW50cnlfa2V5OiBkc24ucHVibGljS2V5LAogICAgc2VudHJ5X3ZlcnNpb246IFNFTlRSWV9BUElfVkVSU0lPTiwKICAgIC4uLihzZGtJbmZvICYmIHsgc2VudHJ5X2NsaWVudDogYCR7c2RrSW5mby5uYW1lfS8ke3Nka0luZm8udmVyc2lvbn1gIH0pLAogIH0pOwp9CgovKioKICogUmV0dXJucyB0aGUgZW52ZWxvcGUgZW5kcG9pbnQgVVJMIHdpdGggYXV0aCBpbiB0aGUgcXVlcnkgc3RyaW5nLgogKgogKiBTZW5kaW5nIGF1dGggYXMgcGFydCBvZiB0aGUgcXVlcnkgc3RyaW5nIGFuZCBub3QgYXMgY3VzdG9tIEhUVFAgaGVhZGVycyBhdm9pZHMgQ09SUyBwcmVmbGlnaHQgcmVxdWVzdHMuCiAqLwpmdW5jdGlvbiBnZXRFbnZlbG9wZUVuZHBvaW50V2l0aFVybEVuY29kZWRBdXRoKAogIGRzbiwKICAvLyBUT0RPICh2OCk6IFJlbW92ZSBgdHVubmVsT3JPcHRpb25zYCBpbiBmYXZvciBvZiBgb3B0aW9uc2AsIGFuZCB1c2UgdGhlIHN1YnN0aXR1dGUgY29kZSBiZWxvdwogIC8vIG9wdGlvbnM6IENsaWVudE9wdGlvbnMgPSB7fSBhcyBDbGllbnRPcHRpb25zLAogIHR1bm5lbE9yT3B0aW9ucyA9IHt9ICwKKSB7CiAgLy8gVE9ETyAodjgpOiBVc2UgdGhpcyBjb2RlIGluc3RlYWQKICAvLyBjb25zdCB7IHR1bm5lbCwgX21ldGFkYXRhID0ge30gfSA9IG9wdGlvbnM7CiAgLy8gcmV0dXJuIHR1bm5lbCA/IHR1bm5lbCA6IGAke19nZXRJbmdlc3RFbmRwb2ludChkc24pfT8ke19lbmNvZGVkQXV0aChkc24sIF9tZXRhZGF0YS5zZGspfWA7CgogIGNvbnN0IHR1bm5lbCA9IHR5cGVvZiB0dW5uZWxPck9wdGlvbnMgPT09ICdzdHJpbmcnID8gdHVubmVsT3JPcHRpb25zIDogdHVubmVsT3JPcHRpb25zLnR1bm5lbDsKICBjb25zdCBzZGtJbmZvID0KICAgIHR5cGVvZiB0dW5uZWxPck9wdGlvbnMgPT09ICdzdHJpbmcnIHx8ICF0dW5uZWxPck9wdGlvbnMuX21ldGFkYXRhID8gdW5kZWZpbmVkIDogdHVubmVsT3JPcHRpb25zLl9tZXRhZGF0YS5zZGs7CgogIHJldHVybiB0dW5uZWwgPyB0dW5uZWwgOiBgJHtfZ2V0SW5nZXN0RW5kcG9pbnQoZHNuKX0/JHtfZW5jb2RlZEF1dGgoZHNuLCBzZGtJbmZvKX1gOwp9Cgpjb25zdCBERUZBVUxUX1RSQU5TUE9SVF9CVUZGRVJfU0laRSA9IDMwOwoKLyoqCiAqIENyZWF0ZXMgYW4gaW5zdGFuY2Ugb2YgYSBTZW50cnkgYFRyYW5zcG9ydGAKICoKICogQHBhcmFtIG9wdGlvbnMKICogQHBhcmFtIG1ha2VSZXF1ZXN0CiAqLwpmdW5jdGlvbiBjcmVhdGVUcmFuc3BvcnQoCiAgb3B0aW9ucywKICBtYWtlUmVxdWVzdCwKICBidWZmZXIgPSBtYWtlUHJvbWlzZUJ1ZmZlcigKICAgIG9wdGlvbnMuYnVmZmVyU2l6ZSB8fCBERUZBVUxUX1RSQU5TUE9SVF9CVUZGRVJfU0laRSwKICApLAopIHsKICBsZXQgcmF0ZUxpbWl0cyA9IHt9OwogIGNvbnN0IGZsdXNoID0gKHRpbWVvdXQpID0+IGJ1ZmZlci5kcmFpbih0aW1lb3V0KTsKCiAgZnVuY3Rpb24gc2VuZChlbnZlbG9wZSkgewogICAgY29uc3QgZmlsdGVyZWRFbnZlbG9wZUl0ZW1zID0gW107CgogICAgLy8gRHJvcCByYXRlIGxpbWl0ZWQgaXRlbXMgZnJvbSBlbnZlbG9wZQogICAgZm9yRWFjaEVudmVsb3BlSXRlbShlbnZlbG9wZSwgKGl0ZW0sIHR5cGUpID0+IHsKICAgICAgY29uc3QgZGF0YUNhdGVnb3J5ID0gZW52ZWxvcGVJdGVtVHlwZVRvRGF0YUNhdGVnb3J5KHR5cGUpOwogICAgICBpZiAoaXNSYXRlTGltaXRlZChyYXRlTGltaXRzLCBkYXRhQ2F0ZWdvcnkpKSB7CiAgICAgICAgY29uc3QgZXZlbnQgPSBnZXRFdmVudEZvckVudmVsb3BlSXRlbShpdGVtLCB0eXBlKTsKICAgICAgICBvcHRpb25zLnJlY29yZERyb3BwZWRFdmVudCgncmF0ZWxpbWl0X2JhY2tvZmYnLCBkYXRhQ2F0ZWdvcnksIGV2ZW50KTsKICAgICAgfSBlbHNlIHsKICAgICAgICBmaWx0ZXJlZEVudmVsb3BlSXRlbXMucHVzaChpdGVtKTsKICAgICAgfQogICAgfSk7CgogICAgLy8gU2tpcCBzZW5kaW5nIGlmIGVudmVsb3BlIGlzIGVtcHR5IGFmdGVyIGZpbHRlcmluZyBvdXQgcmF0ZSBsaW1pdGVkIGV2ZW50cwogICAgaWYgKGZpbHRlcmVkRW52ZWxvcGVJdGVtcy5sZW5ndGggPT09IDApIHsKICAgICAgcmV0dXJuIHJlc29sdmVkU3luY1Byb21pc2UoKTsKICAgIH0KCiAgICAvLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgQHR5cGVzY3JpcHQtZXNsaW50L25vLWV4cGxpY2l0LWFueQogICAgY29uc3QgZmlsdGVyZWRFbnZlbG9wZSA9IGNyZWF0ZUVudmVsb3BlKGVudmVsb3BlWzBdLCBmaWx0ZXJlZEVudmVsb3BlSXRlbXMgKTsKCiAgICAvLyBDcmVhdGVzIGNsaWVudCByZXBvcnQgZm9yIGVhY2ggaXRlbSBpbiBhbiBlbnZlbG9wZQogICAgY29uc3QgcmVjb3JkRW52ZWxvcGVMb3NzID0gKHJlYXNvbikgPT4gewogICAgICBmb3JFYWNoRW52ZWxvcGVJdGVtKGZpbHRlcmVkRW52ZWxvcGUsIChpdGVtLCB0eXBlKSA9PiB7CiAgICAgICAgY29uc3QgZXZlbnQgPSBnZXRFdmVudEZvckVudmVsb3BlSXRlbShpdGVtLCB0eXBlKTsKICAgICAgICBvcHRpb25zLnJlY29yZERyb3BwZWRFdmVudChyZWFzb24sIGVudmVsb3BlSXRlbVR5cGVUb0RhdGFDYXRlZ29yeSh0eXBlKSwgZXZlbnQpOwogICAgICB9KTsKICAgIH07CgogICAgY29uc3QgcmVxdWVzdFRhc2sgPSAoKSA9PgogICAgICBtYWtlUmVxdWVzdCh7IGJvZHk6IHNlcmlhbGl6ZUVudmVsb3BlKGZpbHRlcmVkRW52ZWxvcGUsIG9wdGlvbnMudGV4dEVuY29kZXIpIH0pLnRoZW4oCiAgICAgICAgcmVzcG9uc2UgPT4gewogICAgICAgICAgLy8gV2UgZG9uJ3Qgd2FudCB0byB0aHJvdyBvbiBOT0sgcmVzcG9uc2VzLCBidXQgd2Ugd2FudCB0byBhdCBsZWFzdCBsb2cgdGhlbQogICAgICAgICAgaWYgKHJlc3BvbnNlLnN0YXR1c0NvZGUgIT09IHVuZGVmaW5lZCAmJiAocmVzcG9uc2Uuc3RhdHVzQ29kZSA8IDIwMCB8fCByZXNwb25zZS5zdGF0dXNDb2RlID49IDMwMCkpIHsKICAgICAgICAgICAgREVCVUdfQlVJTEQgJiYgbG9nZ2VyLndhcm4oYFNlbnRyeSByZXNwb25kZWQgd2l0aCBzdGF0dXMgY29kZSAke3Jlc3BvbnNlLnN0YXR1c0NvZGV9IHRvIHNlbnQgZXZlbnQuYCk7CiAgICAgICAgICB9CgogICAgICAgICAgcmF0ZUxpbWl0cyA9IHVwZGF0ZVJhdGVMaW1pdHMocmF0ZUxpbWl0cywgcmVzcG9uc2UpOwogICAgICAgICAgcmV0dXJuIHJlc3BvbnNlOwogICAgICAgIH0sCiAgICAgICAgZXJyb3IgPT4gewogICAgICAgICAgcmVjb3JkRW52ZWxvcGVMb3NzKCduZXR3b3JrX2Vycm9yJyk7CiAgICAgICAgICB0aHJvdyBlcnJvcjsKICAgICAgICB9LAogICAgICApOwoKICAgIHJldHVybiBidWZmZXIuYWRkKHJlcXVlc3RUYXNrKS50aGVuKAogICAgICByZXN1bHQgPT4gcmVzdWx0LAogICAgICBlcnJvciA9PiB7CiAgICAgICAgaWYgKGVycm9yIGluc3RhbmNlb2YgU2VudHJ5RXJyb3IpIHsKICAgICAgICAgIERFQlVHX0JVSUxEICYmIGxvZ2dlci5lcnJvcignU2tpcHBlZCBzZW5kaW5nIGV2ZW50IGJlY2F1c2UgYnVmZmVyIGlzIGZ1bGwuJyk7CiAgICAgICAgICByZWNvcmRFbnZlbG9wZUxvc3MoJ3F1ZXVlX292ZXJmbG93Jyk7CiAgICAgICAgICByZXR1cm4gcmVzb2x2ZWRTeW5jUHJvbWlzZSgpOwogICAgICAgIH0gZWxzZSB7CiAgICAgICAgICB0aHJvdyBlcnJvcjsKICAgICAgICB9CiAgICAgIH0sCiAgICApOwogIH0KCiAgLy8gV2UgdXNlIHRoaXMgdG8gaWRlbnRpZmlmeSBpZiB0aGUgdHJhbnNwb3J0IGlzIHRoZSBiYXNlIHRyYW5zcG9ydAogIC8vIFRPRE8gKHY4KTogUmVtb3ZlIHRoaXMgYWdhaW4gYXMgd2UnbGwgbm8gbG9uZ2VyIG5lZWQgaXQKICBzZW5kLl9fc2VudHJ5X19iYXNlVHJhbnNwb3J0X18gPSB0cnVlOwoKICByZXR1cm4gewogICAgc2VuZCwKICAgIGZsdXNoLAogIH07Cn0KCmZ1bmN0aW9uIGdldEV2ZW50Rm9yRW52ZWxvcGVJdGVtKGl0ZW0sIHR5cGUpIHsKICBpZiAodHlwZSAhPT0gJ2V2ZW50JyAmJiB0eXBlICE9PSAndHJhbnNhY3Rpb24nKSB7CiAgICByZXR1cm4gdW5kZWZpbmVkOwogIH0KCiAgcmV0dXJuIEFycmF5LmlzQXJyYXkoaXRlbSkgPyAoaXRlbSApWzFdIDogdW5kZWZpbmVkOwp9CgovKiogbm9ybWFsaXplcyBXaW5kb3dzIHBhdGhzICovCmZ1bmN0aW9uIG5vcm1hbGl6ZVdpbmRvd3NQYXRoKHBhdGgpIHsKICByZXR1cm4gcGF0aAogICAgLnJlcGxhY2UoL15bQS1aXTovLCAnJykgLy8gcmVtb3ZlIFdpbmRvd3Mtc3R5bGUgcHJlZml4CiAgICAucmVwbGFjZSgvXFwvZywgJy8nKTsgLy8gcmVwbGFjZSBhbGwgYFxgIGluc3RhbmNlcyB3aXRoIGAvYAp9CgovKiogQ3JlYXRlcyBhIGZ1bmN0aW9uIHRoYXQgZ2V0cyB0aGUgbW9kdWxlIG5hbWUgZnJvbSBhIGZpbGVuYW1lICovCmZ1bmN0aW9uIGNyZWF0ZUdldE1vZHVsZUZyb21GaWxlbmFtZSgKICBiYXNlUGF0aCA9IHByb2Nlc3MuYXJndlsxXSA/IGRpcm5hbWUocHJvY2Vzcy5hcmd2WzFdKSA6IHByb2Nlc3MuY3dkKCksCiAgaXNXaW5kb3dzID0gc2VwID09PSAnXFwnLAopIHsKICBjb25zdCBub3JtYWxpemVkQmFzZSA9IGlzV2luZG93cyA/IG5vcm1hbGl6ZVdpbmRvd3NQYXRoKGJhc2VQYXRoKSA6IGJhc2VQYXRoOwoKICByZXR1cm4gKGZpbGVuYW1lKSA9PiB7CiAgICBpZiAoIWZpbGVuYW1lKSB7CiAgICAgIHJldHVybjsKICAgIH0KCiAgICBjb25zdCBub3JtYWxpemVkRmlsZW5hbWUgPSBpc1dpbmRvd3MgPyBub3JtYWxpemVXaW5kb3dzUGF0aChmaWxlbmFtZSkgOiBmaWxlbmFtZTsKCiAgICAvLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgcHJlZmVyLWNvbnN0CiAgICBsZXQgeyBkaXIsIGJhc2U6IGZpbGUsIGV4dCB9ID0gcG9zaXgucGFyc2Uobm9ybWFsaXplZEZpbGVuYW1lKTsKCiAgICBpZiAoZXh0ID09PSAnLmpzJyB8fCBleHQgPT09ICcubWpzJyB8fCBleHQgPT09ICcuY2pzJykgewogICAgICBmaWxlID0gZmlsZS5zbGljZSgwLCBleHQubGVuZ3RoICogLTEpOwogICAgfQoKICAgIGlmICghZGlyKSB7CiAgICAgIC8vIE5vIGRpcm5hbWUgd2hhdHNvZXZlcgogICAgICBkaXIgPSAnLic7CiAgICB9CgogICAgY29uc3QgbiA9IGRpci5sYXN0SW5kZXhPZignL25vZGVfbW9kdWxlcycpOwogICAgaWYgKG4gPiAtMSkgewogICAgICByZXR1cm4gYCR7ZGlyLnNsaWNlKG4gKyAxNCkucmVwbGFjZSgvXC8vZywgJy4nKX06JHtmaWxlfWA7CiAgICB9CgogICAgLy8gTGV0J3Mgc2VlIGlmIGl0J3MgYSBwYXJ0IG9mIHRoZSBtYWluIG1vZHVsZQogICAgLy8gVG8gYmUgYSBwYXJ0IG9mIG1haW4gbW9kdWxlLCBpdCBoYXMgdG8gc2hhcmUgdGhlIHNhbWUgYmFzZQogICAgaWYgKGRpci5zdGFydHNXaXRoKG5vcm1hbGl6ZWRCYXNlKSkgewogICAgICBsZXQgbW9kdWxlTmFtZSA9IGRpci5zbGljZShub3JtYWxpemVkQmFzZS5sZW5ndGggKyAxKS5yZXBsYWNlKC9cLy9nLCAnLicpOwoKICAgICAgaWYgKG1vZHVsZU5hbWUpIHsKICAgICAgICBtb2R1bGVOYW1lICs9ICc6JzsKICAgICAgfQogICAgICBtb2R1bGVOYW1lICs9IGZpbGU7CgogICAgICByZXR1cm4gbW9kdWxlTmFtZTsKICAgIH0KCiAgICByZXR1cm4gZmlsZTsKICB9Owp9CgpmdW5jdGlvbiBfbnVsbGlzaENvYWxlc2NlJDIobGhzLCByaHNGbikgeyBpZiAobGhzICE9IG51bGwpIHsgcmV0dXJuIGxoczsgfSBlbHNlIHsgcmV0dXJuIHJoc0ZuKCk7IH0gfS8qKgogKiBUaGlzIGNvZGUgd2FzIG9yaWdpbmFsbHkgZm9ya2VkIGZyb20gaHR0cHM6Ly9naXRodWIuY29tL1Rvb1RhbGxOYXRlL3Byb3h5LWFnZW50cy90cmVlL2IxMzMyOTVmZDE2ZjY0NzU1NzhiNmIxNWJkOWI0ZTMzZWNiMGQwYjcKICogV2l0aCB0aGUgZm9sbG93aW5nIGxpY2VuY2U6CiAqCiAqIChUaGUgTUlUIExpY2Vuc2UpCiAqCiAqIENvcHlyaWdodCAoYykgMjAxMyBOYXRoYW4gUmFqbGljaCA8bmF0aGFuQHRvb3RhbGxuYXRlLm5ldD4qCiAqCiAqIFBlcm1pc3Npb24gaXMgaGVyZWJ5IGdyYW50ZWQsIGZyZWUgb2YgY2hhcmdlLCB0byBhbnkgcGVyc29uIG9idGFpbmluZwogKiBhIGNvcHkgb2YgdGhpcyBzb2Z0d2FyZSBhbmQgYXNzb2NpYXRlZCBkb2N1bWVudGF0aW9uIGZpbGVzICh0aGUKICogJ1NvZnR3YXJlJyksIHRvIGRlYWwgaW4gdGhlIFNvZnR3YXJlIHdpdGhvdXQgcmVzdHJpY3Rpb24sIGluY2x1ZGluZwogKiB3aXRob3V0IGxpbWl0YXRpb24gdGhlIHJpZ2h0cyB0byB1c2UsIGNvcHksIG1vZGlmeSwgbWVyZ2UsIHB1Ymxpc2gsCiAqIGRpc3RyaWJ1dGUsIHN1YmxpY2Vuc2UsIGFuZC9vciBzZWxsIGNvcGllcyBvZiB0aGUgU29mdHdhcmUsIGFuZCB0bwogKiBwZXJtaXQgcGVyc29ucyB0byB3aG9tIHRoZSBTb2Z0d2FyZSBpcyBmdXJuaXNoZWQgdG8gZG8gc28sIHN1YmplY3QgdG8KICogdGhlIGZvbGxvd2luZyBjb25kaXRpb25zOioKICoKICogVGhlIGFib3ZlIGNvcHlyaWdodCBub3RpY2UgYW5kIHRoaXMgcGVybWlzc2lvbiBub3RpY2Ugc2hhbGwgYmUKICogaW5jbHVkZWQgaW4gYWxsIGNvcGllcyBvciBzdWJzdGFudGlhbCBwb3J0aW9ucyBvZiB0aGUgU29mdHdhcmUuKgogKgogKiBUSEUgU09GVFdBUkUgSVMgUFJPVklERUQgJ0FTIElTJywgV0lUSE9VVCBXQVJSQU5UWSBPRiBBTlkgS0lORCwKICogRVhQUkVTUyBPUiBJTVBMSUVELCBJTkNMVURJTkcgQlVUIE5PVCBMSU1JVEVEIFRPIFRIRSBXQVJSQU5USUVTIE9GCiAqIE1FUkNIQU5UQUJJTElUWSwgRklUTkVTUyBGT1IgQSBQQVJUSUNVTEFSIFBVUlBPU0UgQU5EIE5PTklORlJJTkdFTUVOVC4KICogSU4gTk8gRVZFTlQgU0hBTEwgVEhFIEFVVEhPUlMgT1IgQ09QWVJJR0hUIEhPTERFUlMgQkUgTElBQkxFIEZPUiBBTlkKICogQ0xBSU0sIERBTUFHRVMgT1IgT1RIRVIgTElBQklMSVRZLCBXSEVUSEVSIElOIEFOIEFDVElPTiBPRiBDT05UUkFDVCwKICogVE9SVCBPUiBPVEhFUldJU0UsIEFSSVNJTkcgRlJPTSwgT1VUIE9GIE9SIElOIENPTk5FQ1RJT04gV0lUSCBUSEUKICogU09GVFdBUkUgT1IgVEhFIFVTRSBPUiBPVEhFUiBERUFMSU5HUyBJTiBUSEUgU09GVFdBUkUuCiAqLwoKY29uc3QgSU5URVJOQUwgPSBTeW1ib2woJ0FnZW50QmFzZUludGVybmFsU3RhdGUnKTsKCmNsYXNzIEFnZW50IGV4dGVuZHMgaHR0cC5BZ2VudCB7CgogIC8vIFNldCBieSBgaHR0cC5BZ2VudGAgLSBtaXNzaW5nIGZyb20gYEB0eXBlcy9ub2RlYAoKICBjb25zdHJ1Y3RvcihvcHRzKSB7CiAgICBzdXBlcihvcHRzKTsKICAgIHRoaXNbSU5URVJOQUxdID0ge307CiAgfQoKICAvKioKICAgKiBEZXRlcm1pbmUgd2hldGhlciB0aGlzIGlzIGFuIGBodHRwYCBvciBgaHR0cHNgIHJlcXVlc3QuCiAgICovCiAgaXNTZWN1cmVFbmRwb2ludChvcHRpb25zKSB7CiAgICBpZiAob3B0aW9ucykgewogICAgICAvLyBGaXJzdCBjaGVjayB0aGUgYHNlY3VyZUVuZHBvaW50YCBwcm9wZXJ0eSBleHBsaWNpdGx5LCBzaW5jZSB0aGlzCiAgICAgIC8vIG1lYW5zIHRoYXQgYSBwYXJlbnQgYEFnZW50YCBpcyAicGFzc2luZyB0aHJvdWdoIiB0byB0aGlzIGluc3RhbmNlLgogICAgICAvLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgQHR5cGVzY3JpcHQtZXNsaW50L25vLWV4cGxpY2l0LWFueSwgQHR5cGVzY3JpcHQtZXNsaW50L25vLXVuc2FmZS1tZW1iZXItYWNjZXNzCiAgICAgIGlmICh0eXBlb2YgKG9wdGlvbnMgKS5zZWN1cmVFbmRwb2ludCA9PT0gJ2Jvb2xlYW4nKSB7CiAgICAgICAgcmV0dXJuIG9wdGlvbnMuc2VjdXJlRW5kcG9pbnQ7CiAgICAgIH0KCiAgICAgIC8vIElmIG5vIGV4cGxpY2l0IGBzZWN1cmVgIGVuZHBvaW50LCBjaGVjayBpZiBgcHJvdG9jb2xgIHByb3BlcnR5IGlzCiAgICAgIC8vIHNldC4gVGhpcyB3aWxsIHVzdWFsbHkgYmUgdGhlIGNhc2Ugc2luY2UgdXNpbmcgYSBmdWxsIHN0cmluZyBVUkwKICAgICAgLy8gb3IgYFVSTGAgaW5zdGFuY2Ugc2hvdWxkIGJlIHRoZSBtb3N0IGNvbW1vbiB1c2FnZS4KICAgICAgaWYgKHR5cGVvZiBvcHRpb25zLnByb3RvY29sID09PSAnc3RyaW5nJykgewogICAgICAgIHJldHVybiBvcHRpb25zLnByb3RvY29sID09PSAnaHR0cHM6JzsKICAgICAgfQogICAgfQoKICAgIC8vIEZpbmFsbHksIGlmIG5vIGBwcm90b2NvbGAgcHJvcGVydHkgd2FzIHNldCwgdGhlbiBmYWxsIGJhY2sgdG8KICAgIC8vIGNoZWNraW5nIHRoZSBzdGFjayB0cmFjZSBvZiB0aGUgY3VycmVudCBjYWxsIHN0YWNrLCBhbmQgdHJ5IHRvCiAgICAvLyBkZXRlY3QgdGhlICJodHRwcyIgbW9kdWxlLgogICAgY29uc3QgeyBzdGFjayB9ID0gbmV3IEVycm9yKCk7CiAgICBpZiAodHlwZW9mIHN0YWNrICE9PSAnc3RyaW5nJykgcmV0dXJuIGZhbHNlOwogICAgcmV0dXJuIHN0YWNrLnNwbGl0KCdcbicpLnNvbWUobCA9PiBsLmluZGV4T2YoJyhodHRwcy5qczonKSAhPT0gLTEgfHwgbC5pbmRleE9mKCdub2RlOmh0dHBzOicpICE9PSAtMSk7CiAgfQoKICBjcmVhdGVTb2NrZXQocmVxLCBvcHRpb25zLCBjYikgewogICAgY29uc3QgY29ubmVjdE9wdHMgPSB7CiAgICAgIC4uLm9wdGlvbnMsCiAgICAgIHNlY3VyZUVuZHBvaW50OiB0aGlzLmlzU2VjdXJlRW5kcG9pbnQob3B0aW9ucyksCiAgICB9OwogICAgUHJvbWlzZS5yZXNvbHZlKCkKICAgICAgLnRoZW4oKCkgPT4gdGhpcy5jb25uZWN0KHJlcSwgY29ubmVjdE9wdHMpKQogICAgICAudGhlbihzb2NrZXQgPT4gewogICAgICAgIGlmIChzb2NrZXQgaW5zdGFuY2VvZiBodHRwLkFnZW50KSB7CiAgICAgICAgICAvLyBAdHMtZXhwZWN0LWVycm9yIGBhZGRSZXF1ZXN0KClgIGlzbid0IGRlZmluZWQgaW4gYEB0eXBlcy9ub2RlYAogICAgICAgICAgcmV0dXJuIHNvY2tldC5hZGRSZXF1ZXN0KHJlcSwgY29ubmVjdE9wdHMpOwogICAgICAgIH0KICAgICAgICB0aGlzW0lOVEVSTkFMXS5jdXJyZW50U29ja2V0ID0gc29ja2V0OwogICAgICAgIC8vIEB0cy1leHBlY3QtZXJyb3IgYGNyZWF0ZVNvY2tldCgpYCBpc24ndCBkZWZpbmVkIGluIGBAdHlwZXMvbm9kZWAKICAgICAgICBzdXBlci5jcmVhdGVTb2NrZXQocmVxLCBvcHRpb25zLCBjYik7CiAgICAgIH0sIGNiKTsKICB9CgogIGNyZWF0ZUNvbm5lY3Rpb24oKSB7CiAgICBjb25zdCBzb2NrZXQgPSB0aGlzW0lOVEVSTkFMXS5jdXJyZW50U29ja2V0OwogICAgdGhpc1tJTlRFUk5BTF0uY3VycmVudFNvY2tldCA9IHVuZGVmaW5lZDsKICAgIGlmICghc29ja2V0KSB7CiAgICAgIHRocm93IG5ldyBFcnJvcignTm8gc29ja2V0IHdhcyByZXR1cm5lZCBpbiB0aGUgYGNvbm5lY3QoKWAgZnVuY3Rpb24nKTsKICAgIH0KICAgIHJldHVybiBzb2NrZXQ7CiAgfQoKICBnZXQgZGVmYXVsdFBvcnQoKSB7CiAgICByZXR1cm4gX251bGxpc2hDb2FsZXNjZSQyKHRoaXNbSU5URVJOQUxdLmRlZmF1bHRQb3J0LCAoKSA9PiAoICh0aGlzLnByb3RvY29sID09PSAnaHR0cHM6JyA/IDQ0MyA6IDgwKSkpOwogIH0KCiAgc2V0IGRlZmF1bHRQb3J0KHYpIHsKICAgIGlmICh0aGlzW0lOVEVSTkFMXSkgewogICAgICB0aGlzW0lOVEVSTkFMXS5kZWZhdWx0UG9ydCA9IHY7CiAgICB9CiAgfQoKICBnZXQgcHJvdG9jb2woKSB7CiAgICByZXR1cm4gX251bGxpc2hDb2FsZXNjZSQyKHRoaXNbSU5URVJOQUxdLnByb3RvY29sLCAoKSA9PiAoICh0aGlzLmlzU2VjdXJlRW5kcG9pbnQoKSA/ICdodHRwczonIDogJ2h0dHA6JykpKTsKICB9CgogIHNldCBwcm90b2NvbCh2KSB7CiAgICBpZiAodGhpc1tJTlRFUk5BTF0pIHsKICAgICAgdGhpc1tJTlRFUk5BTF0ucHJvdG9jb2wgPSB2OwogICAgfQogIH0KfQoKZnVuY3Rpb24gZGVidWckMSguLi5hcmdzKSB7CiAgbG9nZ2VyLmxvZygnW2h0dHBzLXByb3h5LWFnZW50OnBhcnNlLXByb3h5LXJlc3BvbnNlXScsIC4uLmFyZ3MpOwp9CgpmdW5jdGlvbiBwYXJzZVByb3h5UmVzcG9uc2Uoc29ja2V0KSB7CiAgcmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlLCByZWplY3QpID0+IHsKICAgIC8vIHdlIG5lZWQgdG8gYnVmZmVyIGFueSBIVFRQIHRyYWZmaWMgdGhhdCBoYXBwZW5zIHdpdGggdGhlIHByb3h5IGJlZm9yZSB3ZSBnZXQKICAgIC8vIHRoZSBDT05ORUNUIHJlc3BvbnNlLCBzbyB0aGF0IGlmIHRoZSByZXNwb25zZSBpcyBhbnl0aGluZyBvdGhlciB0aGFuIGFuICIyMDAiCiAgICAvLyByZXNwb25zZSBjb2RlLCB0aGVuIHdlIGNhbiByZS1wbGF5IHRoZSAiZGF0YSIgZXZlbnRzIG9uIHRoZSBzb2NrZXQgb25jZSB0aGUKICAgIC8vIEhUVFAgcGFyc2VyIGlzIGhvb2tlZCB1cC4uLgogICAgbGV0IGJ1ZmZlcnNMZW5ndGggPSAwOwogICAgY29uc3QgYnVmZmVycyA9IFtdOwoKICAgIGZ1bmN0aW9uIHJlYWQoKSB7CiAgICAgIGNvbnN0IGIgPSBzb2NrZXQucmVhZCgpOwogICAgICBpZiAoYikgb25kYXRhKGIpOwogICAgICBlbHNlIHNvY2tldC5vbmNlKCdyZWFkYWJsZScsIHJlYWQpOwogICAgfQoKICAgIGZ1bmN0aW9uIGNsZWFudXAoKSB7CiAgICAgIHNvY2tldC5yZW1vdmVMaXN0ZW5lcignZW5kJywgb25lbmQpOwogICAgICBzb2NrZXQucmVtb3ZlTGlzdGVuZXIoJ2Vycm9yJywgb25lcnJvcik7CiAgICAgIHNvY2tldC5yZW1vdmVMaXN0ZW5lcigncmVhZGFibGUnLCByZWFkKTsKICAgIH0KCiAgICBmdW5jdGlvbiBvbmVuZCgpIHsKICAgICAgY2xlYW51cCgpOwogICAgICBkZWJ1ZyQxKCdvbmVuZCcpOwogICAgICByZWplY3QobmV3IEVycm9yKCdQcm94eSBjb25uZWN0aW9uIGVuZGVkIGJlZm9yZSByZWNlaXZpbmcgQ09OTkVDVCByZXNwb25zZScpKTsKICAgIH0KCiAgICBmdW5jdGlvbiBvbmVycm9yKGVycikgewogICAgICBjbGVhbnVwKCk7CiAgICAgIGRlYnVnJDEoJ29uZXJyb3IgJW8nLCBlcnIpOwogICAgICByZWplY3QoZXJyKTsKICAgIH0KCiAgICBmdW5jdGlvbiBvbmRhdGEoYikgewogICAgICBidWZmZXJzLnB1c2goYik7CiAgICAgIGJ1ZmZlcnNMZW5ndGggKz0gYi5sZW5ndGg7CgogICAgICBjb25zdCBidWZmZXJlZCA9IEJ1ZmZlci5jb25jYXQoYnVmZmVycywgYnVmZmVyc0xlbmd0aCk7CiAgICAgIGNvbnN0IGVuZE9mSGVhZGVycyA9IGJ1ZmZlcmVkLmluZGV4T2YoJ1xyXG5cclxuJyk7CgogICAgICBpZiAoZW5kT2ZIZWFkZXJzID09PSAtMSkgewogICAgICAgIC8vIGtlZXAgYnVmZmVyaW5nCiAgICAgICAgZGVidWckMSgnaGF2ZSBub3QgcmVjZWl2ZWQgZW5kIG9mIEhUVFAgaGVhZGVycyB5ZXQuLi4nKTsKICAgICAgICByZWFkKCk7CiAgICAgICAgcmV0dXJuOwogICAgICB9CgogICAgICBjb25zdCBoZWFkZXJQYXJ0cyA9IGJ1ZmZlcmVkLnNsaWNlKDAsIGVuZE9mSGVhZGVycykudG9TdHJpbmcoJ2FzY2lpJykuc3BsaXQoJ1xyXG4nKTsKICAgICAgY29uc3QgZmlyc3RMaW5lID0gaGVhZGVyUGFydHMuc2hpZnQoKTsKICAgICAgaWYgKCFmaXJzdExpbmUpIHsKICAgICAgICBzb2NrZXQuZGVzdHJveSgpOwogICAgICAgIHJldHVybiByZWplY3QobmV3IEVycm9yKCdObyBoZWFkZXIgcmVjZWl2ZWQgZnJvbSBwcm94eSBDT05ORUNUIHJlc3BvbnNlJykpOwogICAgICB9CiAgICAgIGNvbnN0IGZpcnN0TGluZVBhcnRzID0gZmlyc3RMaW5lLnNwbGl0KCcgJyk7CiAgICAgIGNvbnN0IHN0YXR1c0NvZGUgPSArZmlyc3RMaW5lUGFydHNbMV07CiAgICAgIGNvbnN0IHN0YXR1c1RleHQgPSBmaXJzdExpbmVQYXJ0cy5zbGljZSgyKS5qb2luKCcgJyk7CiAgICAgIGNvbnN0IGhlYWRlcnMgPSB7fTsKICAgICAgZm9yIChjb25zdCBoZWFkZXIgb2YgaGVhZGVyUGFydHMpIHsKICAgICAgICBpZiAoIWhlYWRlcikgY29udGludWU7CiAgICAgICAgY29uc3QgZmlyc3RDb2xvbiA9IGhlYWRlci5pbmRleE9mKCc6Jyk7CiAgICAgICAgaWYgKGZpcnN0Q29sb24gPT09IC0xKSB7CiAgICAgICAgICBzb2NrZXQuZGVzdHJveSgpOwogICAgICAgICAgcmV0dXJuIHJlamVjdChuZXcgRXJyb3IoYEludmFsaWQgaGVhZGVyIGZyb20gcHJveHkgQ09OTkVDVCByZXNwb25zZTogIiR7aGVhZGVyfSJgKSk7CiAgICAgICAgfQogICAgICAgIGNvbnN0IGtleSA9IGhlYWRlci5zbGljZSgwLCBmaXJzdENvbG9uKS50b0xvd2VyQ2FzZSgpOwogICAgICAgIGNvbnN0IHZhbHVlID0gaGVhZGVyLnNsaWNlKGZpcnN0Q29sb24gKyAxKS50cmltU3RhcnQoKTsKICAgICAgICBjb25zdCBjdXJyZW50ID0gaGVhZGVyc1trZXldOwogICAgICAgIGlmICh0eXBlb2YgY3VycmVudCA9PT0gJ3N0cmluZycpIHsKICAgICAgICAgIGhlYWRlcnNba2V5XSA9IFtjdXJyZW50LCB2YWx1ZV07CiAgICAgICAgfSBlbHNlIGlmIChBcnJheS5pc0FycmF5KGN1cnJlbnQpKSB7CiAgICAgICAgICBjdXJyZW50LnB1c2godmFsdWUpOwogICAgICAgIH0gZWxzZSB7CiAgICAgICAgICBoZWFkZXJzW2tleV0gPSB2YWx1ZTsKICAgICAgICB9CiAgICAgIH0KICAgICAgZGVidWckMSgnZ290IHByb3h5IHNlcnZlciByZXNwb25zZTogJW8gJW8nLCBmaXJzdExpbmUsIGhlYWRlcnMpOwogICAgICBjbGVhbnVwKCk7CiAgICAgIHJlc29sdmUoewogICAgICAgIGNvbm5lY3Q6IHsKICAgICAgICAgIHN0YXR1c0NvZGUsCiAgICAgICAgICBzdGF0dXNUZXh0LAogICAgICAgICAgaGVhZGVycywKICAgICAgICB9LAogICAgICAgIGJ1ZmZlcmVkLAogICAgICB9KTsKICAgIH0KCiAgICBzb2NrZXQub24oJ2Vycm9yJywgb25lcnJvcik7CiAgICBzb2NrZXQub24oJ2VuZCcsIG9uZW5kKTsKCiAgICByZWFkKCk7CiAgfSk7Cn0KCmZ1bmN0aW9uIF9udWxsaXNoQ29hbGVzY2UkMShsaHMsIHJoc0ZuKSB7IGlmIChsaHMgIT0gbnVsbCkgeyByZXR1cm4gbGhzOyB9IGVsc2UgeyByZXR1cm4gcmhzRm4oKTsgfSB9IGZ1bmN0aW9uIF9vcHRpb25hbENoYWluJDEob3BzKSB7IGxldCBsYXN0QWNjZXNzTEhTID0gdW5kZWZpbmVkOyBsZXQgdmFsdWUgPSBvcHNbMF07IGxldCBpID0gMTsgd2hpbGUgKGkgPCBvcHMubGVuZ3RoKSB7IGNvbnN0IG9wID0gb3BzW2ldOyBjb25zdCBmbiA9IG9wc1tpICsgMV07IGkgKz0gMjsgaWYgKChvcCA9PT0gJ29wdGlvbmFsQWNjZXNzJyB8fCBvcCA9PT0gJ29wdGlvbmFsQ2FsbCcpICYmIHZhbHVlID09IG51bGwpIHsgcmV0dXJuIHVuZGVmaW5lZDsgfSBpZiAob3AgPT09ICdhY2Nlc3MnIHx8IG9wID09PSAnb3B0aW9uYWxBY2Nlc3MnKSB7IGxhc3RBY2Nlc3NMSFMgPSB2YWx1ZTsgdmFsdWUgPSBmbih2YWx1ZSk7IH0gZWxzZSBpZiAob3AgPT09ICdjYWxsJyB8fCBvcCA9PT0gJ29wdGlvbmFsQ2FsbCcpIHsgdmFsdWUgPSBmbigoLi4uYXJncykgPT4gdmFsdWUuY2FsbChsYXN0QWNjZXNzTEhTLCAuLi5hcmdzKSk7IGxhc3RBY2Nlc3NMSFMgPSB1bmRlZmluZWQ7IH0gfSByZXR1cm4gdmFsdWU7IH0KCmZ1bmN0aW9uIGRlYnVnKC4uLmFyZ3MpIHsKICBsb2dnZXIubG9nKCdbaHR0cHMtcHJveHktYWdlbnRdJywgLi4uYXJncyk7Cn0KCi8qKgogKiBUaGUgYEh0dHBzUHJveHlBZ2VudGAgaW1wbGVtZW50cyBhbiBIVFRQIEFnZW50IHN1YmNsYXNzIHRoYXQgY29ubmVjdHMgdG8KICogdGhlIHNwZWNpZmllZCAiSFRUUChzKSBwcm94eSBzZXJ2ZXIiIGluIG9yZGVyIHRvIHByb3h5IEhUVFBTIHJlcXVlc3RzLgogKgogKiBPdXRnb2luZyBIVFRQIHJlcXVlc3RzIGFyZSBmaXJzdCB0dW5uZWxlZCB0aHJvdWdoIHRoZSBwcm94eSBzZXJ2ZXIgdXNpbmcgdGhlCiAqIGBDT05ORUNUYCBIVFRQIHJlcXVlc3QgbWV0aG9kIHRvIGVzdGFibGlzaCBhIGNvbm5lY3Rpb24gdG8gdGhlIHByb3h5IHNlcnZlciwKICogYW5kIHRoZW4gdGhlIHByb3h5IHNlcnZlciBjb25uZWN0cyB0byB0aGUgZGVzdGluYXRpb24gdGFyZ2V0IGFuZCBpc3N1ZXMgdGhlCiAqIEhUVFAgcmVxdWVzdCBmcm9tIHRoZSBwcm94eSBzZXJ2ZXIuCiAqCiAqIGBodHRwczpgIHJlcXVlc3RzIGhhdmUgdGhlaXIgc29ja2V0IGNvbm5lY3Rpb24gdXBncmFkZWQgdG8gVExTIG9uY2UKICogdGhlIGNvbm5lY3Rpb24gdG8gdGhlIHByb3h5IHNlcnZlciBoYXMgYmVlbiBlc3RhYmxpc2hlZC4KICovCmNsYXNzIEh0dHBzUHJveHlBZ2VudCBleHRlbmRzIEFnZW50IHsKICBzdGF0aWMgX19pbml0U3RhdGljKCkge3RoaXMucHJvdG9jb2xzID0gWydodHRwJywgJ2h0dHBzJ107IH0KCiAgY29uc3RydWN0b3IocHJveHksIG9wdHMpIHsKICAgIHN1cGVyKG9wdHMpOwogICAgdGhpcy5vcHRpb25zID0ge307CiAgICB0aGlzLnByb3h5ID0gdHlwZW9mIHByb3h5ID09PSAnc3RyaW5nJyA/IG5ldyBVUkwocHJveHkpIDogcHJveHk7CiAgICB0aGlzLnByb3h5SGVhZGVycyA9IF9udWxsaXNoQ29hbGVzY2UkMShfb3B0aW9uYWxDaGFpbiQxKFtvcHRzLCAnb3B0aW9uYWxBY2Nlc3MnLCBfMiA9PiBfMi5oZWFkZXJzXSksICgpID0+ICgge30pKTsKICAgIGRlYnVnKCdDcmVhdGluZyBuZXcgSHR0cHNQcm94eUFnZW50IGluc3RhbmNlOiAlbycsIHRoaXMucHJveHkuaHJlZik7CgogICAgLy8gVHJpbSBvZmYgdGhlIGJyYWNrZXRzIGZyb20gSVB2NiBhZGRyZXNzZXMKICAgIGNvbnN0IGhvc3QgPSAodGhpcy5wcm94eS5ob3N0bmFtZSB8fCB0aGlzLnByb3h5Lmhvc3QpLnJlcGxhY2UoL15cW3xcXSQvZywgJycpOwogICAgY29uc3QgcG9ydCA9IHRoaXMucHJveHkucG9ydCA/IHBhcnNlSW50KHRoaXMucHJveHkucG9ydCwgMTApIDogdGhpcy5wcm94eS5wcm90b2NvbCA9PT0gJ2h0dHBzOicgPyA0NDMgOiA4MDsKICAgIHRoaXMuY29ubmVjdE9wdHMgPSB7CiAgICAgIC8vIEF0dGVtcHQgdG8gbmVnb3RpYXRlIGh0dHAvMS4xIGZvciBwcm94eSBzZXJ2ZXJzIHRoYXQgc3VwcG9ydCBodHRwLzIKICAgICAgQUxQTlByb3RvY29sczogWydodHRwLzEuMSddLAogICAgICAuLi4ob3B0cyA/IG9taXQob3B0cywgJ2hlYWRlcnMnKSA6IG51bGwpLAogICAgICBob3N0LAogICAgICBwb3J0LAogICAgfTsKICB9CgogIC8qKgogICAqIENhbGxlZCB3aGVuIHRoZSBub2RlLWNvcmUgSFRUUCBjbGllbnQgbGlicmFyeSBpcyBjcmVhdGluZyBhCiAgICogbmV3IEhUVFAgcmVxdWVzdC4KICAgKi8KICBhc3luYyBjb25uZWN0KHJlcSwgb3B0cykgewogICAgY29uc3QgeyBwcm94eSB9ID0gdGhpczsKCiAgICBpZiAoIW9wdHMuaG9zdCkgewogICAgICB0aHJvdyBuZXcgVHlwZUVycm9yKCdObyAiaG9zdCIgcHJvdmlkZWQnKTsKICAgIH0KCiAgICAvLyBDcmVhdGUgYSBzb2NrZXQgY29ubmVjdGlvbiB0byB0aGUgcHJveHkgc2VydmVyLgogICAgbGV0IHNvY2tldDsKICAgIGlmIChwcm94eS5wcm90b2NvbCA9PT0gJ2h0dHBzOicpIHsKICAgICAgZGVidWcoJ0NyZWF0aW5nIGB0bHMuU29ja2V0YDogJW8nLCB0aGlzLmNvbm5lY3RPcHRzKTsKICAgICAgY29uc3Qgc2VydmVybmFtZSA9IHRoaXMuY29ubmVjdE9wdHMuc2VydmVybmFtZSB8fCB0aGlzLmNvbm5lY3RPcHRzLmhvc3Q7CiAgICAgIHNvY2tldCA9IHRscy5jb25uZWN0KHsKICAgICAgICAuLi50aGlzLmNvbm5lY3RPcHRzLAogICAgICAgIHNlcnZlcm5hbWU6IHNlcnZlcm5hbWUgJiYgbmV0LmlzSVAoc2VydmVybmFtZSkgPyB1bmRlZmluZWQgOiBzZXJ2ZXJuYW1lLAogICAgICB9KTsKICAgIH0gZWxzZSB7CiAgICAgIGRlYnVnKCdDcmVhdGluZyBgbmV0LlNvY2tldGA6ICVvJywgdGhpcy5jb25uZWN0T3B0cyk7CiAgICAgIHNvY2tldCA9IG5ldC5jb25uZWN0KHRoaXMuY29ubmVjdE9wdHMpOwogICAgfQoKICAgIGNvbnN0IGhlYWRlcnMgPQogICAgICB0eXBlb2YgdGhpcy5wcm94eUhlYWRlcnMgPT09ICdmdW5jdGlvbicgPyB0aGlzLnByb3h5SGVhZGVycygpIDogeyAuLi50aGlzLnByb3h5SGVhZGVycyB9OwogICAgY29uc3QgaG9zdCA9IG5ldC5pc0lQdjYob3B0cy5ob3N0KSA/IGBbJHtvcHRzLmhvc3R9XWAgOiBvcHRzLmhvc3Q7CiAgICBsZXQgcGF5bG9hZCA9IGBDT05ORUNUICR7aG9zdH06JHtvcHRzLnBvcnR9IEhUVFAvMS4xXHJcbmA7CgogICAgLy8gSW5qZWN0IHRoZSBgUHJveHktQXV0aG9yaXphdGlvbmAgaGVhZGVyIGlmIG5lY2Vzc2FyeS4KICAgIGlmIChwcm94eS51c2VybmFtZSB8fCBwcm94eS5wYXNzd29yZCkgewogICAgICBjb25zdCBhdXRoID0gYCR7ZGVjb2RlVVJJQ29tcG9uZW50KHByb3h5LnVzZXJuYW1lKX06JHtkZWNvZGVVUklDb21wb25lbnQocHJveHkucGFzc3dvcmQpfWA7CiAgICAgIGhlYWRlcnNbJ1Byb3h5LUF1dGhvcml6YXRpb24nXSA9IGBCYXNpYyAke0J1ZmZlci5mcm9tKGF1dGgpLnRvU3RyaW5nKCdiYXNlNjQnKX1gOwogICAgfQoKICAgIGhlYWRlcnMuSG9zdCA9IGAke2hvc3R9OiR7b3B0cy5wb3J0fWA7CgogICAgaWYgKCFoZWFkZXJzWydQcm94eS1Db25uZWN0aW9uJ10pIHsKICAgICAgaGVhZGVyc1snUHJveHktQ29ubmVjdGlvbiddID0gdGhpcy5rZWVwQWxpdmUgPyAnS2VlcC1BbGl2ZScgOiAnY2xvc2UnOwogICAgfQogICAgZm9yIChjb25zdCBuYW1lIG9mIE9iamVjdC5rZXlzKGhlYWRlcnMpKSB7CiAgICAgIHBheWxvYWQgKz0gYCR7bmFtZX06ICR7aGVhZGVyc1tuYW1lXX1cclxuYDsKICAgIH0KCiAgICBjb25zdCBwcm94eVJlc3BvbnNlUHJvbWlzZSA9IHBhcnNlUHJveHlSZXNwb25zZShzb2NrZXQpOwoKICAgIHNvY2tldC53cml0ZShgJHtwYXlsb2FkfVxyXG5gKTsKCiAgICBjb25zdCB7IGNvbm5lY3QsIGJ1ZmZlcmVkIH0gPSBhd2FpdCBwcm94eVJlc3BvbnNlUHJvbWlzZTsKICAgIHJlcS5lbWl0KCdwcm94eUNvbm5lY3QnLCBjb25uZWN0KTsKICAgIC8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBAdHlwZXNjcmlwdC1lc2xpbnQvYmFuLXRzLWNvbW1lbnQKICAgIC8vIEB0cy1pZ25vcmUgTm90IEV2ZW50RW1pdHRlciBpbiBOb2RlIHR5cGVzCiAgICB0aGlzLmVtaXQoJ3Byb3h5Q29ubmVjdCcsIGNvbm5lY3QsIHJlcSk7CgogICAgaWYgKGNvbm5lY3Quc3RhdHVzQ29kZSA9PT0gMjAwKSB7CiAgICAgIHJlcS5vbmNlKCdzb2NrZXQnLCByZXN1bWUpOwoKICAgICAgaWYgKG9wdHMuc2VjdXJlRW5kcG9pbnQpIHsKICAgICAgICAvLyBUaGUgcHJveHkgaXMgY29ubmVjdGluZyB0byBhIFRMUyBzZXJ2ZXIsIHNvIHVwZ3JhZGUKICAgICAgICAvLyB0aGlzIHNvY2tldCBjb25uZWN0aW9uIHRvIGEgVExTIGNvbm5lY3Rpb24uCiAgICAgICAgZGVidWcoJ1VwZ3JhZGluZyBzb2NrZXQgY29ubmVjdGlvbiB0byBUTFMnKTsKICAgICAgICBjb25zdCBzZXJ2ZXJuYW1lID0gb3B0cy5zZXJ2ZXJuYW1lIHx8IG9wdHMuaG9zdDsKICAgICAgICByZXR1cm4gdGxzLmNvbm5lY3QoewogICAgICAgICAgLi4ub21pdChvcHRzLCAnaG9zdCcsICdwYXRoJywgJ3BvcnQnKSwKICAgICAgICAgIHNvY2tldCwKICAgICAgICAgIHNlcnZlcm5hbWU6IG5ldC5pc0lQKHNlcnZlcm5hbWUpID8gdW5kZWZpbmVkIDogc2VydmVybmFtZSwKICAgICAgICB9KTsKICAgICAgfQoKICAgICAgcmV0dXJuIHNvY2tldDsKICAgIH0KCiAgICAvLyBTb21lIG90aGVyIHN0YXR1cyBjb2RlIHRoYXQncyBub3QgMjAwLi4uIG5lZWQgdG8gcmUtcGxheSB0aGUgSFRUUAogICAgLy8gaGVhZGVyICJkYXRhIiBldmVudHMgb250byB0aGUgc29ja2V0IG9uY2UgdGhlIEhUVFAgbWFjaGluZXJ5IGlzCiAgICAvLyBhdHRhY2hlZCBzbyB0aGF0IHRoZSBub2RlIGNvcmUgYGh0dHBgIGNhbiBwYXJzZSBhbmQgaGFuZGxlIHRoZQogICAgLy8gZXJyb3Igc3RhdHVzIGNvZGUuCgogICAgLy8gQ2xvc2UgdGhlIG9yaWdpbmFsIHNvY2tldCwgYW5kIGEgbmV3ICJmYWtlIiBzb2NrZXQgaXMgcmV0dXJuZWQKICAgIC8vIGluc3RlYWQsIHNvIHRoYXQgdGhlIHByb3h5IGRvZXNuJ3QgZ2V0IHRoZSBIVFRQIHJlcXVlc3QKICAgIC8vIHdyaXR0ZW4gdG8gaXQgKHdoaWNoIG1heSBjb250YWluIGBBdXRob3JpemF0aW9uYCBoZWFkZXJzIG9yIG90aGVyCiAgICAvLyBzZW5zaXRpdmUgZGF0YSkuCiAgICAvLwogICAgLy8gU2VlOiBodHRwczovL2hhY2tlcm9uZS5jb20vcmVwb3J0cy81NDE1MDIKICAgIHNvY2tldC5kZXN0cm95KCk7CgogICAgY29uc3QgZmFrZVNvY2tldCA9IG5ldyBuZXQuU29ja2V0KHsgd3JpdGFibGU6IGZhbHNlIH0pOwogICAgZmFrZVNvY2tldC5yZWFkYWJsZSA9IHRydWU7CgogICAgLy8gTmVlZCB0byB3YWl0IGZvciB0aGUgInNvY2tldCIgZXZlbnQgdG8gcmUtcGxheSB0aGUgImRhdGEiIGV2ZW50cy4KICAgIHJlcS5vbmNlKCdzb2NrZXQnLCAocykgPT4gewogICAgICBkZWJ1ZygnUmVwbGF5aW5nIHByb3h5IGJ1ZmZlciBmb3IgZmFpbGVkIHJlcXVlc3QnKTsKICAgICAgLy8gUmVwbGF5IHRoZSAiYnVmZmVyZWQiIEJ1ZmZlciBvbnRvIHRoZSBmYWtlIGBzb2NrZXRgLCBzaW5jZSBhdAogICAgICAvLyB0aGlzIHBvaW50IHRoZSBIVFRQIG1vZHVsZSBtYWNoaW5lcnkgaGFzIGJlZW4gaG9va2VkIHVwIGZvcgogICAgICAvLyB0aGUgdXNlci4KICAgICAgcy5wdXNoKGJ1ZmZlcmVkKTsKICAgICAgcy5wdXNoKG51bGwpOwogICAgfSk7CgogICAgcmV0dXJuIGZha2VTb2NrZXQ7CiAgfQp9IEh0dHBzUHJveHlBZ2VudC5fX2luaXRTdGF0aWMoKTsKCmZ1bmN0aW9uIHJlc3VtZShzb2NrZXQpIHsKICBzb2NrZXQucmVzdW1lKCk7Cn0KCmZ1bmN0aW9uIG9taXQoCiAgb2JqLAogIC4uLmtleXMKKQoKIHsKICBjb25zdCByZXQgPSB7fQoKOwogIGxldCBrZXk7CiAgZm9yIChrZXkgaW4gb2JqKSB7CiAgICBpZiAoIWtleXMuaW5jbHVkZXMoa2V5KSkgewogICAgICByZXRba2V5XSA9IG9ialtrZXldOwogICAgfQogIH0KICByZXR1cm4gcmV0Owp9CgpmdW5jdGlvbiBfbnVsbGlzaENvYWxlc2NlKGxocywgcmhzRm4pIHsgaWYgKGxocyAhPSBudWxsKSB7IHJldHVybiBsaHM7IH0gZWxzZSB7IHJldHVybiByaHNGbigpOyB9IH0KLy8gRXN0aW1hdGVkIG1heGltdW0gc2l6ZSBmb3IgcmVhc29uYWJsZSBzdGFuZGFsb25lIGV2ZW50CmNvbnN0IEdaSVBfVEhSRVNIT0xEID0gMTAyNCAqIDMyOwoKLyoqCiAqIEdldHMgYSBzdHJlYW0gZnJvbSBhIFVpbnQ4QXJyYXkgb3Igc3RyaW5nCiAqIFJlYWRhYmxlLmZyb20gaXMgaWRlYWwgYnV0IHdhcyBhZGRlZCBpbiBub2RlLmpzIHYxMi4zLjAgYW5kIHYxMC4xNy4wCiAqLwpmdW5jdGlvbiBzdHJlYW1Gcm9tQm9keShib2R5KSB7CiAgcmV0dXJuIG5ldyBSZWFkYWJsZSh7CiAgICByZWFkKCkgewogICAgICB0aGlzLnB1c2goYm9keSk7CiAgICAgIHRoaXMucHVzaChudWxsKTsKICAgIH0sCiAgfSk7Cn0KCi8qKgogKiBDcmVhdGVzIGEgVHJhbnNwb3J0IHRoYXQgdXNlcyBuYXRpdmUgdGhlIG5hdGl2ZSAnaHR0cCcgYW5kICdodHRwcycgbW9kdWxlcyB0byBzZW5kIGV2ZW50cyB0byBTZW50cnkuCiAqLwpmdW5jdGlvbiBtYWtlTm9kZVRyYW5zcG9ydChvcHRpb25zKSB7CiAgbGV0IHVybFNlZ21lbnRzOwoKICB0cnkgewogICAgdXJsU2VnbWVudHMgPSBuZXcgVVJMKG9wdGlvbnMudXJsKTsKICB9IGNhdGNoIChlKSB7CiAgICBjb25zb2xlU2FuZGJveCgoKSA9PiB7CiAgICAgIC8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBuby1jb25zb2xlCiAgICAgIGNvbnNvbGUud2FybigKICAgICAgICAnW0BzZW50cnkvbm9kZV06IEludmFsaWQgZHNuIG9yIHR1bm5lbCBvcHRpb24sIHdpbGwgbm90IHNlbmQgYW55IGV2ZW50cy4gVGhlIHR1bm5lbCBvcHRpb24gbXVzdCBiZSBhIGZ1bGwgVVJMIHdoZW4gdXNlZC4nLAogICAgICApOwogICAgfSk7CiAgICByZXR1cm4gY3JlYXRlVHJhbnNwb3J0KG9wdGlvbnMsICgpID0+IFByb21pc2UucmVzb2x2ZSh7fSkpOwogIH0KCiAgY29uc3QgaXNIdHRwcyA9IHVybFNlZ21lbnRzLnByb3RvY29sID09PSAnaHR0cHM6JzsKCiAgLy8gUHJveHkgcHJpb3JpdGl6YXRpb246IGh0dHAgPT4gYG9wdGlvbnMucHJveHlgIHwgYHByb2Nlc3MuZW52Lmh0dHBfcHJveHlgCiAgLy8gUHJveHkgcHJpb3JpdGl6YXRpb246IGh0dHBzID0+IGBvcHRpb25zLnByb3h5YCB8IGBwcm9jZXNzLmVudi5odHRwc19wcm94eWAgfCBgcHJvY2Vzcy5lbnYuaHR0cF9wcm94eWAKICBjb25zdCBwcm94eSA9IGFwcGx5Tm9Qcm94eU9wdGlvbigKICAgIHVybFNlZ21lbnRzLAogICAgb3B0aW9ucy5wcm94eSB8fCAoaXNIdHRwcyA/IHByb2Nlc3MuZW52Lmh0dHBzX3Byb3h5IDogdW5kZWZpbmVkKSB8fCBwcm9jZXNzLmVudi5odHRwX3Byb3h5LAogICk7CgogIGNvbnN0IG5hdGl2ZUh0dHBNb2R1bGUgPSBpc0h0dHBzID8gaHR0cHMgOiBodHRwOwogIGNvbnN0IGtlZXBBbGl2ZSA9IG9wdGlvbnMua2VlcEFsaXZlID09PSB1bmRlZmluZWQgPyBmYWxzZSA6IG9wdGlvbnMua2VlcEFsaXZlOwoKICAvLyBUT0RPKHY3KTogRXZhbHVhdGUgaWYgd2UgY2FuIHNldCBrZWVwQWxpdmUgdG8gdHJ1ZS4gVGhpcyB3b3VsZCBpbnZvbHZlIHRlc3RpbmcgZm9yIG1lbW9yeSBsZWFrcyBpbiBvbGRlciBub2RlCiAgLy8gdmVyc2lvbnMoPj0gOCkgYXMgdGhleSBoYWQgbWVtb3J5IGxlYWtzIHdoZW4gdXNpbmcgaXQ6ICMyNTU1CiAgY29uc3QgYWdlbnQgPSBwcm94eQogICAgPyAobmV3IEh0dHBzUHJveHlBZ2VudChwcm94eSkgKQogICAgOiBuZXcgbmF0aXZlSHR0cE1vZHVsZS5BZ2VudCh7IGtlZXBBbGl2ZSwgbWF4U29ja2V0czogMzAsIHRpbWVvdXQ6IDIwMDAgfSk7CgogIGNvbnN0IHJlcXVlc3RFeGVjdXRvciA9IGNyZWF0ZVJlcXVlc3RFeGVjdXRvcihvcHRpb25zLCBfbnVsbGlzaENvYWxlc2NlKG9wdGlvbnMuaHR0cE1vZHVsZSwgKCkgPT4gKCBuYXRpdmVIdHRwTW9kdWxlKSksIGFnZW50KTsKICByZXR1cm4gY3JlYXRlVHJhbnNwb3J0KG9wdGlvbnMsIHJlcXVlc3RFeGVjdXRvcik7Cn0KCi8qKgogKiBIb25vcnMgdGhlIGBub19wcm94eWAgZW52IHZhcmlhYmxlIHdpdGggdGhlIGhpZ2hlc3QgcHJpb3JpdHkgdG8gYWxsb3cgZm9yIGhvc3RzIGV4Y2x1c2lvbi4KICoKICogQHBhcmFtIHRyYW5zcG9ydFVybCBUaGUgVVJMIHRoZSB0cmFuc3BvcnQgaW50ZW5kcyB0byBzZW5kIGV2ZW50cyB0by4KICogQHBhcmFtIHByb3h5IFRoZSBjbGllbnQgY29uZmlndXJlZCBwcm94eS4KICogQHJldHVybnMgQSBwcm94eSB0aGUgdHJhbnNwb3J0IHNob3VsZCB1c2UuCiAqLwpmdW5jdGlvbiBhcHBseU5vUHJveHlPcHRpb24odHJhbnNwb3J0VXJsU2VnbWVudHMsIHByb3h5KSB7CiAgY29uc3QgeyBub19wcm94eSB9ID0gcHJvY2Vzcy5lbnY7CgogIGNvbnN0IHVybElzRXhlbXB0RnJvbVByb3h5ID0KICAgIG5vX3Byb3h5ICYmCiAgICBub19wcm94eQogICAgICAuc3BsaXQoJywnKQogICAgICAuc29tZSgKICAgICAgICBleGVtcHRpb24gPT4gdHJhbnNwb3J0VXJsU2VnbWVudHMuaG9zdC5lbmRzV2l0aChleGVtcHRpb24pIHx8IHRyYW5zcG9ydFVybFNlZ21lbnRzLmhvc3RuYW1lLmVuZHNXaXRoKGV4ZW1wdGlvbiksCiAgICAgICk7CgogIGlmICh1cmxJc0V4ZW1wdEZyb21Qcm94eSkgewogICAgcmV0dXJuIHVuZGVmaW5lZDsKICB9IGVsc2UgewogICAgcmV0dXJuIHByb3h5OwogIH0KfQoKLyoqCiAqIENyZWF0ZXMgYSBSZXF1ZXN0RXhlY3V0b3IgdG8gYmUgdXNlZCB3aXRoIGBjcmVhdGVUcmFuc3BvcnRgLgogKi8KZnVuY3Rpb24gY3JlYXRlUmVxdWVzdEV4ZWN1dG9yKAogIG9wdGlvbnMsCiAgaHR0cE1vZHVsZSwKICBhZ2VudCwKKSB7CiAgY29uc3QgeyBob3N0bmFtZSwgcGF0aG5hbWUsIHBvcnQsIHByb3RvY29sLCBzZWFyY2ggfSA9IG5ldyBVUkwob3B0aW9ucy51cmwpOwogIHJldHVybiBmdW5jdGlvbiBtYWtlUmVxdWVzdChyZXF1ZXN0KSB7CiAgICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4gewogICAgICBsZXQgYm9keSA9IHN0cmVhbUZyb21Cb2R5KHJlcXVlc3QuYm9keSk7CgogICAgICBjb25zdCBoZWFkZXJzID0geyAuLi5vcHRpb25zLmhlYWRlcnMgfTsKCiAgICAgIGlmIChyZXF1ZXN0LmJvZHkubGVuZ3RoID4gR1pJUF9USFJFU0hPTEQpIHsKICAgICAgICBoZWFkZXJzWydjb250ZW50LWVuY29kaW5nJ10gPSAnZ3ppcCc7CiAgICAgICAgYm9keSA9IGJvZHkucGlwZShjcmVhdGVHemlwKCkpOwogICAgICB9CgogICAgICBjb25zdCByZXEgPSBodHRwTW9kdWxlLnJlcXVlc3QoCiAgICAgICAgewogICAgICAgICAgbWV0aG9kOiAnUE9TVCcsCiAgICAgICAgICBhZ2VudCwKICAgICAgICAgIGhlYWRlcnMsCiAgICAgICAgICBob3N0bmFtZSwKICAgICAgICAgIHBhdGg6IGAke3BhdGhuYW1lfSR7c2VhcmNofWAsCiAgICAgICAgICBwb3J0LAogICAgICAgICAgcHJvdG9jb2wsCiAgICAgICAgICBjYTogb3B0aW9ucy5jYUNlcnRzLAogICAgICAgIH0sCiAgICAgICAgcmVzID0+IHsKICAgICAgICAgIHJlcy5vbignZGF0YScsICgpID0+IHsKICAgICAgICAgICAgLy8gRHJhaW4gc29ja2V0CiAgICAgICAgICB9KTsKCiAgICAgICAgICByZXMub24oJ2VuZCcsICgpID0+IHsKICAgICAgICAgICAgLy8gRHJhaW4gc29ja2V0CiAgICAgICAgICB9KTsKCiAgICAgICAgICByZXMuc2V0RW5jb2RpbmcoJ3V0ZjgnKTsKCiAgICAgICAgICAvLyAiS2V5LXZhbHVlIHBhaXJzIG9mIGhlYWRlciBuYW1lcyBhbmQgdmFsdWVzLiBIZWFkZXIgbmFtZXMgYXJlIGxvd2VyLWNhc2VkLiIKICAgICAgICAgIC8vIGh0dHBzOi8vbm9kZWpzLm9yZy9hcGkvaHR0cC5odG1sI2h0dHBfbWVzc2FnZV9oZWFkZXJzCiAgICAgICAgICBjb25zdCByZXRyeUFmdGVySGVhZGVyID0gX251bGxpc2hDb2FsZXNjZShyZXMuaGVhZGVyc1sncmV0cnktYWZ0ZXInXSwgKCkgPT4gKCBudWxsKSk7CiAgICAgICAgICBjb25zdCByYXRlTGltaXRzSGVhZGVyID0gX251bGxpc2hDb2FsZXNjZShyZXMuaGVhZGVyc1sneC1zZW50cnktcmF0ZS1saW1pdHMnXSwgKCkgPT4gKCBudWxsKSk7CgogICAgICAgICAgcmVzb2x2ZSh7CiAgICAgICAgICAgIHN0YXR1c0NvZGU6IHJlcy5zdGF0dXNDb2RlLAogICAgICAgICAgICBoZWFkZXJzOiB7CiAgICAgICAgICAgICAgJ3JldHJ5LWFmdGVyJzogcmV0cnlBZnRlckhlYWRlciwKICAgICAgICAgICAgICAneC1zZW50cnktcmF0ZS1saW1pdHMnOiBBcnJheS5pc0FycmF5KHJhdGVMaW1pdHNIZWFkZXIpID8gcmF0ZUxpbWl0c0hlYWRlclswXSA6IHJhdGVMaW1pdHNIZWFkZXIsCiAgICAgICAgICAgIH0sCiAgICAgICAgICB9KTsKICAgICAgICB9LAogICAgICApOwoKICAgICAgcmVxLm9uKCdlcnJvcicsIHJlamVjdCk7CiAgICAgIGJvZHkucGlwZShyZXEpOwogICAgfSk7CiAgfTsKfQoKZnVuY3Rpb24gX29wdGlvbmFsQ2hhaW4ob3BzKSB7IGxldCBsYXN0QWNjZXNzTEhTID0gdW5kZWZpbmVkOyBsZXQgdmFsdWUgPSBvcHNbMF07IGxldCBpID0gMTsgd2hpbGUgKGkgPCBvcHMubGVuZ3RoKSB7IGNvbnN0IG9wID0gb3BzW2ldOyBjb25zdCBmbiA9IG9wc1tpICsgMV07IGkgKz0gMjsgaWYgKChvcCA9PT0gJ29wdGlvbmFsQWNjZXNzJyB8fCBvcCA9PT0gJ29wdGlvbmFsQ2FsbCcpICYmIHZhbHVlID09IG51bGwpIHsgcmV0dXJuIHVuZGVmaW5lZDsgfSBpZiAob3AgPT09ICdhY2Nlc3MnIHx8IG9wID09PSAnb3B0aW9uYWxBY2Nlc3MnKSB7IGxhc3RBY2Nlc3NMSFMgPSB2YWx1ZTsgdmFsdWUgPSBmbih2YWx1ZSk7IH0gZWxzZSBpZiAob3AgPT09ICdjYWxsJyB8fCBvcCA9PT0gJ29wdGlvbmFsQ2FsbCcpIHsgdmFsdWUgPSBmbigoLi4uYXJncykgPT4gdmFsdWUuY2FsbChsYXN0QWNjZXNzTEhTLCAuLi5hcmdzKSk7IGxhc3RBY2Nlc3NMSFMgPSB1bmRlZmluZWQ7IH0gfSByZXR1cm4gdmFsdWU7IH0KY29uc3Qgb3B0aW9ucyA9IHdvcmtlckRhdGE7CmxldCBzZXNzaW9uOwpsZXQgaGFzU2VudEFuckV2ZW50ID0gZmFsc2U7CgpmdW5jdGlvbiBsb2cobXNnKSB7CiAgaWYgKG9wdGlvbnMuZGVidWcpIHsKICAgIC8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBuby1jb25zb2xlCiAgICBjb25zb2xlLmxvZyhgW0FOUiBXb3JrZXJdICR7bXNnfWApOwogIH0KfQoKY29uc3QgdXJsID0gZ2V0RW52ZWxvcGVFbmRwb2ludFdpdGhVcmxFbmNvZGVkQXV0aChvcHRpb25zLmRzbik7CmNvbnN0IHRyYW5zcG9ydCA9IG1ha2VOb2RlVHJhbnNwb3J0KHsKICB1cmwsCiAgcmVjb3JkRHJvcHBlZEV2ZW50OiAoKSA9PiB7CiAgICAvLwogIH0sCn0pOwoKYXN5bmMgZnVuY3Rpb24gc2VuZEFibm9ybWFsU2Vzc2lvbigpIHsKICAvLyBvZiB3ZSBoYXZlIGFuIGV4aXN0aW5nIHNlc3Npb24gcGFzc2VkIGZyb20gdGhlIG1haW4gdGhyZWFkLCBzZW5kIGl0IGFzIGFibm9ybWFsCiAgaWYgKHNlc3Npb24pIHsKICAgIGxvZygnU2VuZGluZyBhYm5vcm1hbCBzZXNzaW9uJyk7CiAgICB1cGRhdGVTZXNzaW9uKHNlc3Npb24sIHsgc3RhdHVzOiAnYWJub3JtYWwnLCBhYm5vcm1hbF9tZWNoYW5pc206ICdhbnJfZm9yZWdyb3VuZCcgfSk7CgogICAgY29uc3QgZW52ZWxvcGUgPSBjcmVhdGVTZXNzaW9uRW52ZWxvcGUoc2Vzc2lvbiwgb3B0aW9ucy5kc24sIG9wdGlvbnMuc2RrTWV0YWRhdGEpOwogICAgLy8gTG9nIHRoZSBlbnZlbG9wZSBzbyB0byBhaWQgaW4gdGVzdGluZwogICAgbG9nKEpTT04uc3RyaW5naWZ5KGVudmVsb3BlKSk7CgogICAgYXdhaXQgdHJhbnNwb3J0LnNlbmQoZW52ZWxvcGUpOwoKICAgIHRyeSB7CiAgICAgIC8vIE5vdGlmeSB0aGUgbWFpbiBwcm9jZXNzIHRoYXQgdGhlIHNlc3Npb24gaGFzIGVuZGVkIHNvIHRoZSBzZXNzaW9uIGNhbiBiZSBjbGVhcmVkIGZyb20gdGhlIHNjb3BlCiAgICAgIF9vcHRpb25hbENoYWluKFtwYXJlbnRQb3J0LCAnb3B0aW9uYWxBY2Nlc3MnLCBfMiA9PiBfMi5wb3N0TWVzc2FnZSwgJ2NhbGwnLCBfMyA9PiBfMygnc2Vzc2lvbi1lbmRlZCcpXSk7CiAgICB9IGNhdGNoIChfKSB7CiAgICAgIC8vIGlnbm9yZQogICAgfQogIH0KfQoKbG9nKCdTdGFydGVkJyk7CgpmdW5jdGlvbiBwcmVwYXJlU3RhY2tGcmFtZXMoc3RhY2tGcmFtZXMpIHsKICBpZiAoIXN0YWNrRnJhbWVzKSB7CiAgICByZXR1cm4gdW5kZWZpbmVkOwogIH0KCiAgLy8gU3RyaXAgU2VudHJ5IGZyYW1lcyBhbmQgcmV2ZXJzZSB0aGUgc3RhY2sgZnJhbWVzIHNvIHRoZXkgYXJlIGluIHRoZSBjb3JyZWN0IG9yZGVyCiAgY29uc3Qgc3RyaXBwZWRGcmFtZXMgPSBzdHJpcFNlbnRyeUZyYW1lc0FuZFJldmVyc2Uoc3RhY2tGcmFtZXMpOwoKICAvLyBJZiB3ZSBoYXZlIGFuIGFwcCByb290IHBhdGgsIHJld3JpdGUgdGhlIGZpbGVuYW1lcyB0byBiZSByZWxhdGl2ZSB0byB0aGUgYXBwIHJvb3QKICBpZiAob3B0aW9ucy5hcHBSb290UGF0aCkgewogICAgZm9yIChjb25zdCBmcmFtZSBvZiBzdHJpcHBlZEZyYW1lcykgewogICAgICBpZiAoIWZyYW1lLmZpbGVuYW1lKSB7CiAgICAgICAgY29udGludWU7CiAgICAgIH0KCiAgICAgIGZyYW1lLmZpbGVuYW1lID0gbm9ybWFsaXplVXJsVG9CYXNlKGZyYW1lLmZpbGVuYW1lLCBvcHRpb25zLmFwcFJvb3RQYXRoKTsKICAgIH0KICB9CgogIHJldHVybiBzdHJpcHBlZEZyYW1lczsKfQoKZnVuY3Rpb24gYXBwbHlTY29wZVRvRXZlbnQoZXZlbnQsIHNjb3BlKSB7CiAgYXBwbHlTY29wZURhdGFUb0V2ZW50KGV2ZW50LCBzY29wZSk7CgogIGlmICghX29wdGlvbmFsQ2hhaW4oW2V2ZW50LCAnYWNjZXNzJywgXzQgPT4gXzQuY29udGV4dHMsICdvcHRpb25hbEFjY2VzcycsIF81ID0+IF81LnRyYWNlXSkpIHsKICAgIGNvbnN0IHsgdHJhY2VJZCwgc3BhbklkLCBwYXJlbnRTcGFuSWQgfSA9IHNjb3BlLnByb3BhZ2F0aW9uQ29udGV4dDsKICAgIGV2ZW50LmNvbnRleHRzID0gewogICAgICB0cmFjZTogewogICAgICAgIHRyYWNlX2lkOiB0cmFjZUlkLAogICAgICAgIHNwYW5faWQ6IHNwYW5JZCwKICAgICAgICBwYXJlbnRfc3Bhbl9pZDogcGFyZW50U3BhbklkLAogICAgICB9LAogICAgICAuLi5ldmVudC5jb250ZXh0cywKICAgIH07CiAgfQp9Cgphc3luYyBmdW5jdGlvbiBzZW5kQW5yRXZlbnQoZnJhbWVzLCBzY29wZSkgewogIGlmIChoYXNTZW50QW5yRXZlbnQpIHsKICAgIHJldHVybjsKICB9CgogIGhhc1NlbnRBbnJFdmVudCA9IHRydWU7CgogIGF3YWl0IHNlbmRBYm5vcm1hbFNlc3Npb24oKTsKCiAgbG9nKCdTZW5kaW5nIGV2ZW50Jyk7CgogIGNvbnN0IGV2ZW50ID0gewogICAgZXZlbnRfaWQ6IHV1aWQ0KCksCiAgICBjb250ZXh0czogb3B0aW9ucy5jb250ZXh0cywKICAgIHJlbGVhc2U6IG9wdGlvbnMucmVsZWFzZSwKICAgIGVudmlyb25tZW50OiBvcHRpb25zLmVudmlyb25tZW50LAogICAgZGlzdDogb3B0aW9ucy5kaXN0LAogICAgcGxhdGZvcm06ICdub2RlJywKICAgIGxldmVsOiAnZXJyb3InLAogICAgZXhjZXB0aW9uOiB7CiAgICAgIHZhbHVlczogWwogICAgICAgIHsKICAgICAgICAgIHR5cGU6ICdBcHBsaWNhdGlvbk5vdFJlc3BvbmRpbmcnLAogICAgICAgICAgdmFsdWU6IGBBcHBsaWNhdGlvbiBOb3QgUmVzcG9uZGluZyBmb3IgYXQgbGVhc3QgJHtvcHRpb25zLmFuclRocmVzaG9sZH0gbXNgLAogICAgICAgICAgc3RhY2t0cmFjZTogeyBmcmFtZXM6IHByZXBhcmVTdGFja0ZyYW1lcyhmcmFtZXMpIH0sCiAgICAgICAgICAvLyBUaGlzIGVuc3VyZXMgdGhlIFVJIGRvZXNuJ3Qgc2F5ICdDcmFzaGVkIGluJyBmb3IgdGhlIHN0YWNrIHRyYWNlCiAgICAgICAgICBtZWNoYW5pc206IHsgdHlwZTogJ0FOUicgfSwKICAgICAgICB9LAogICAgICBdLAogICAgfSwKICAgIHRhZ3M6IG9wdGlvbnMuc3RhdGljVGFncywKICB9OwoKICBpZiAoc2NvcGUpIHsKICAgIGFwcGx5U2NvcGVUb0V2ZW50KGV2ZW50LCBzY29wZSk7CiAgfQoKICBjb25zdCBlbnZlbG9wZSA9IGNyZWF0ZUV2ZW50RW52ZWxvcGUoZXZlbnQsIG9wdGlvbnMuZHNuLCBvcHRpb25zLnNka01ldGFkYXRhKTsKICAvLyBMb2cgdGhlIGVudmVsb3BlIHRvIGFpZCBpbiB0ZXN0aW5nCiAgbG9nKEpTT04uc3RyaW5naWZ5KGVudmVsb3BlKSk7CgogIGF3YWl0IHRyYW5zcG9ydC5zZW5kKGVudmVsb3BlKTsKICBhd2FpdCB0cmFuc3BvcnQuZmx1c2goMjAwMCk7CgogIC8vIERlbGF5IGZvciA1IHNlY29uZHMgc28gdGhhdCBzdGRpbyBjYW4gZmx1c2ggaW4gdGhlIG1haW4gZXZlbnQgbG9vcCBldmVyIHJlc3RhcnRzLgogIC8vIFRoaXMgaXMgbWFpbmx5IGZvciB0aGUgYmVuZWZpdCBvZiBsb2dnaW5nL2RlYnVnZ2luZyBpc3N1ZXMuCiAgc2V0VGltZW91dCgoKSA9PiB7CiAgICBwcm9jZXNzLmV4aXQoMCk7CiAgfSwgNTAwMCk7Cn0KCmxldCBkZWJ1Z2dlclBhdXNlOwoKaWYgKG9wdGlvbnMuY2FwdHVyZVN0YWNrVHJhY2UpIHsKICBsb2coJ0Nvbm5lY3RpbmcgdG8gZGVidWdnZXInKTsKCiAgY29uc3Qgc2Vzc2lvbiA9IG5ldyBTZXNzaW9uKCkgOwogIHNlc3Npb24uY29ubmVjdFRvTWFpblRocmVhZCgpOwoKICBsb2coJ0Nvbm5lY3RlZCB0byBkZWJ1Z2dlcicpOwoKICAvLyBDb2xsZWN0IHNjcmlwdElkIC0+IHVybCBtYXAgc28gd2UgY2FuIGxvb2sgdXAgdGhlIGZpbGVuYW1lcyBsYXRlcgogIGNvbnN0IHNjcmlwdHMgPSBuZXcgTWFwKCk7CgogIHNlc3Npb24ub24oJ0RlYnVnZ2VyLnNjcmlwdFBhcnNlZCcsIGV2ZW50ID0+IHsKICAgIHNjcmlwdHMuc2V0KGV2ZW50LnBhcmFtcy5zY3JpcHRJZCwgZXZlbnQucGFyYW1zLnVybCk7CiAgfSk7CgogIHNlc3Npb24ub24oJ0RlYnVnZ2VyLnBhdXNlZCcsIGV2ZW50ID0+IHsKICAgIGlmIChldmVudC5wYXJhbXMucmVhc29uICE9PSAnb3RoZXInKSB7CiAgICAgIHJldHVybjsKICAgIH0KCiAgICB0cnkgewogICAgICBsb2coJ0RlYnVnZ2VyIHBhdXNlZCcpOwoKICAgICAgLy8gY29weSB0aGUgZnJhbWVzCiAgICAgIGNvbnN0IGNhbGxGcmFtZXMgPSBbLi4uZXZlbnQucGFyYW1zLmNhbGxGcmFtZXNdOwoKICAgICAgY29uc3QgZ2V0TW9kdWxlTmFtZSA9IG9wdGlvbnMuYXBwUm9vdFBhdGggPyBjcmVhdGVHZXRNb2R1bGVGcm9tRmlsZW5hbWUob3B0aW9ucy5hcHBSb290UGF0aCkgOiAoKSA9PiB1bmRlZmluZWQ7CiAgICAgIGNvbnN0IHN0YWNrRnJhbWVzID0gY2FsbEZyYW1lcy5tYXAoZnJhbWUgPT4KICAgICAgICBjYWxsRnJhbWVUb1N0YWNrRnJhbWUoZnJhbWUsIHNjcmlwdHMuZ2V0KGZyYW1lLmxvY2F0aW9uLnNjcmlwdElkKSwgZ2V0TW9kdWxlTmFtZSksCiAgICAgICk7CgogICAgICAvLyBFdmFsdWF0ZSBhIHNjcmlwdCBpbiB0aGUgY3VycmVudGx5IHBhdXNlZCBjb250ZXh0CiAgICAgIHNlc3Npb24ucG9zdCgKICAgICAgICAnUnVudGltZS5ldmFsdWF0ZScsCiAgICAgICAgewogICAgICAgICAgLy8gR3JhYiB0aGUgdHJhY2UgY29udGV4dCBmcm9tIHRoZSBjdXJyZW50IHNjb3BlCiAgICAgICAgICBleHByZXNzaW9uOiAnZ2xvYmFsLl9fU0VOVFJZX0dFVF9TQ09QRVNfXygpOycsCiAgICAgICAgICAvLyBEb24ndCByZS10cmlnZ2VyIHRoZSBkZWJ1Z2dlciBpZiB0aGlzIGNhdXNlcyBhbiBlcnJvcgogICAgICAgICAgc2lsZW50OiB0cnVlLAogICAgICAgICAgLy8gU2VyaWFsaXplIHRoZSByZXN1bHQgdG8ganNvbiBvdGhlcndpc2Ugb25seSBwcmltaXRpdmVzIGFyZSBzdXBwb3J0ZWQKICAgICAgICAgIHJldHVybkJ5VmFsdWU6IHRydWUsCiAgICAgICAgfSwKICAgICAgICAoZXJyLCBwYXJhbSkgPT4gewogICAgICAgICAgaWYgKGVycikgewogICAgICAgICAgICBsb2coYEVycm9yIGV4ZWN1dGluZyBzY3JpcHQ6ICcke2Vyci5tZXNzYWdlfSdgKTsKICAgICAgICAgIH0KCiAgICAgICAgICBjb25zdCBzY29wZXMgPSBwYXJhbSAmJiBwYXJhbS5yZXN1bHQgPyAocGFyYW0ucmVzdWx0LnZhbHVlICkgOiB1bmRlZmluZWQ7CgogICAgICAgICAgc2Vzc2lvbi5wb3N0KCdEZWJ1Z2dlci5yZXN1bWUnKTsKICAgICAgICAgIHNlc3Npb24ucG9zdCgnRGVidWdnZXIuZGlzYWJsZScpOwoKICAgICAgICAgIHNlbmRBbnJFdmVudChzdGFja0ZyYW1lcywgc2NvcGVzKS50aGVuKG51bGwsICgpID0+IHsKICAgICAgICAgICAgbG9nKCdTZW5kaW5nIEFOUiBldmVudCBmYWlsZWQuJyk7CiAgICAgICAgICB9KTsKICAgICAgICB9LAogICAgICApOwogICAgfSBjYXRjaCAoZSkgewogICAgICBzZXNzaW9uLnBvc3QoJ0RlYnVnZ2VyLnJlc3VtZScpOwogICAgICBzZXNzaW9uLnBvc3QoJ0RlYnVnZ2VyLmRpc2FibGUnKTsKICAgICAgdGhyb3cgZTsKICAgIH0KICB9KTsKCiAgZGVidWdnZXJQYXVzZSA9ICgpID0+IHsKICAgIHRyeSB7CiAgICAgIHNlc3Npb24ucG9zdCgnRGVidWdnZXIuZW5hYmxlJywgKCkgPT4gewogICAgICAgIHNlc3Npb24ucG9zdCgnRGVidWdnZXIucGF1c2UnKTsKICAgICAgfSk7CiAgICB9IGNhdGNoIChfKSB7CiAgICAgIC8vCiAgICB9CiAgfTsKfQoKZnVuY3Rpb24gY3JlYXRlSHJUaW1lcigpIHsKICAvLyBUT0RPICh2OCk6IFdlIGNhbiB1c2UgcHJvY2Vzcy5ocnRpbWUuYmlnaW50KCkgYWZ0ZXIgd2UgZHJvcCBub2RlIHY4CiAgbGV0IGxhc3RQb2xsID0gcHJvY2Vzcy5ocnRpbWUoKTsKCiAgcmV0dXJuIHsKICAgIGdldFRpbWVNczogKCkgPT4gewogICAgICBjb25zdCBbc2Vjb25kcywgbmFub1NlY29uZHNdID0gcHJvY2Vzcy5ocnRpbWUobGFzdFBvbGwpOwogICAgICByZXR1cm4gTWF0aC5mbG9vcihzZWNvbmRzICogMWUzICsgbmFub1NlY29uZHMgLyAxZTYpOwogICAgfSwKICAgIHJlc2V0OiAoKSA9PiB7CiAgICAgIGxhc3RQb2xsID0gcHJvY2Vzcy5ocnRpbWUoKTsKICAgIH0sCiAgfTsKfQoKZnVuY3Rpb24gd2F0Y2hkb2dUaW1lb3V0KCkgewogIGxvZygnV2F0Y2hkb2cgdGltZW91dCcpOwoKICBpZiAoZGVidWdnZXJQYXVzZSkgewogICAgbG9nKCdQYXVzaW5nIGRlYnVnZ2VyIHRvIGNhcHR1cmUgc3RhY2sgdHJhY2UnKTsKICAgIGRlYnVnZ2VyUGF1c2UoKTsKICB9IGVsc2UgewogICAgbG9nKCdDYXB0dXJpbmcgZXZlbnQgd2l0aG91dCBhIHN0YWNrIHRyYWNlJyk7CiAgICBzZW5kQW5yRXZlbnQoKS50aGVuKG51bGwsICgpID0+IHsKICAgICAgbG9nKCdTZW5kaW5nIEFOUiBldmVudCBmYWlsZWQgb24gd2F0Y2hkb2cgdGltZW91dC4nKTsKICAgIH0pOwogIH0KfQoKY29uc3QgeyBwb2xsIH0gPSB3YXRjaGRvZ1RpbWVyKGNyZWF0ZUhyVGltZXIsIG9wdGlvbnMucG9sbEludGVydmFsLCBvcHRpb25zLmFuclRocmVzaG9sZCwgd2F0Y2hkb2dUaW1lb3V0KTsKCl9vcHRpb25hbENoYWluKFtwYXJlbnRQb3J0LCAnb3B0aW9uYWxBY2Nlc3MnLCBfNiA9PiBfNi5vbiwgJ2NhbGwnLCBfNyA9PiBfNygnbWVzc2FnZScsIChtc2cpID0+IHsKICBpZiAobXNnLnNlc3Npb24pIHsKICAgIHNlc3Npb24gPSBtYWtlU2Vzc2lvbihtc2cuc2Vzc2lvbik7CiAgfQoKICBwb2xsKCk7Cn0pXSk7";
  }
});

// ../../node_modules/.pnpm/@sentry+node@7.120.1/node_modules/@sentry/node/cjs/integrations/anr/index.js
var require_anr2 = __commonJS({
  "../../node_modules/.pnpm/@sentry+node@7.120.1/node_modules/@sentry/node/cjs/integrations/anr/index.js"(exports, module) {
    var {
      _optionalChain,
      _optionalChainDelete
    } = require_cjs();
    Object.defineProperty(exports, "__esModule", { value: true });
    var url = __require("url");
    var core = require_cjs2();
    var utils = require_cjs();
    var nodeVersion = require_nodeVersion();
    var workerScript = require_worker_script();
    var DEFAULT_INTERVAL = 50;
    var DEFAULT_HANG_THRESHOLD = 5e3;
    function log(message, ...args) {
      utils.logger.log(`[ANR] ${message}`, ...args);
    }
    function globalWithScopeFetchFn() {
      return utils.GLOBAL_OBJ;
    }
    function getScopeData() {
      const scope = core.getGlobalScope().getScopeData();
      core.mergeScopeData(scope, core.getIsolationScope().getScopeData());
      core.mergeScopeData(scope, core.getCurrentScope().getScopeData());
      scope.attachments = [];
      scope.eventProcessors = [];
      return scope;
    }
    function getWorkerThreads() {
      return utils.dynamicRequire(module, "worker_threads");
    }
    async function getContexts(client) {
      let event = { message: "ANR" };
      const eventHint = {};
      for (const processor of client.getEventProcessors()) {
        if (event === null)
          break;
        event = await processor(event, eventHint);
      }
      return _optionalChain([event, "optionalAccess", (_2) => _2.contexts]) || {};
    }
    var INTEGRATION_NAME = "Anr";
    var _anrIntegration = (options = {}) => {
      if (nodeVersion.NODE_VERSION.major < 16 || nodeVersion.NODE_VERSION.major === 16 && nodeVersion.NODE_VERSION.minor < 17) {
        throw new Error("ANR detection requires Node 16.17.0 or later");
      }
      let worker;
      let client;
      const gbl = globalWithScopeFetchFn();
      gbl.__SENTRY_GET_SCOPES__ = getScopeData;
      return {
        name: INTEGRATION_NAME,
        // TODO v8: Remove this
        setupOnce() {
        },
        // eslint-disable-line @typescript-eslint/no-empty-function
        startWorker: () => {
          if (worker) {
            return;
          }
          if (client) {
            worker = _startWorker(client, options);
          }
        },
        stopWorker: () => {
          if (worker) {
            worker.then((stop) => {
              stop();
              worker = void 0;
            });
          }
        },
        setup(initClient) {
          client = initClient;
          setImmediate(() => this.startWorker());
        }
      };
    };
    var anrIntegration = core.defineIntegration(_anrIntegration);
    var Anr = core.convertIntegrationFnToClass(INTEGRATION_NAME, anrIntegration);
    async function _startWorker(client, integrationOptions) {
      const dsn = client.getDsn();
      if (!dsn) {
        return () => {
        };
      }
      const contexts = await getContexts(client);
      _optionalChainDelete([contexts, "access", (_3) => _3.app, "optionalAccess", (_4) => delete _4.app_memory]);
      _optionalChainDelete([contexts, "access", (_5) => _5.device, "optionalAccess", (_6) => delete _6.free_memory]);
      const initOptions = client.getOptions();
      const sdkMetadata = client.getSdkMetadata() || {};
      if (sdkMetadata.sdk) {
        sdkMetadata.sdk.integrations = initOptions.integrations.map((i) => i.name);
      }
      const options = {
        debug: utils.logger.isEnabled(),
        dsn,
        environment: initOptions.environment || "production",
        release: initOptions.release,
        dist: initOptions.dist,
        sdkMetadata,
        appRootPath: integrationOptions.appRootPath,
        pollInterval: integrationOptions.pollInterval || DEFAULT_INTERVAL,
        anrThreshold: integrationOptions.anrThreshold || DEFAULT_HANG_THRESHOLD,
        captureStackTrace: !!integrationOptions.captureStackTrace,
        staticTags: integrationOptions.staticTags || {},
        contexts
      };
      if (options.captureStackTrace) {
        const inspector = __require("inspector");
        if (!inspector.url()) {
          inspector.open(0);
        }
      }
      const { Worker } = getWorkerThreads();
      const worker = new Worker(new url.URL(`data:application/javascript;base64,${workerScript.base64WorkerScript}`), {
        workerData: options
      });
      process.on("exit", () => {
        worker.terminate();
      });
      const timer = setInterval(() => {
        try {
          const currentSession = core.getCurrentScope().getSession();
          const session = currentSession ? { ...currentSession, toJSON: void 0 } : void 0;
          worker.postMessage({ session });
        } catch (_) {
        }
      }, options.pollInterval);
      timer.unref();
      worker.on("message", (msg) => {
        if (msg === "session-ended") {
          log("ANR event sent from ANR worker. Clearing session in this thread.");
          core.getCurrentScope().setSession(void 0);
        }
      });
      worker.once("error", (err) => {
        clearInterval(timer);
        log("ANR worker error", err);
      });
      worker.once("exit", (code) => {
        clearInterval(timer);
        log("ANR worker exit", code);
      });
      worker.unref();
      return () => {
        worker.terminate();
        clearInterval(timer);
      };
    }
    exports.Anr = Anr;
    exports.anrIntegration = anrIntegration;
  }
});

// ../../node_modules/.pnpm/@sentry+node@7.120.1/node_modules/@sentry/node/cjs/integrations/anr/legacy.js
var require_legacy = __commonJS({
  "../../node_modules/.pnpm/@sentry+node@7.120.1/node_modules/@sentry/node/cjs/integrations/anr/legacy.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var core = require_cjs2();
    var index = require_anr2();
    function enableAnrDetection(options) {
      const client = core.getClient();
      const integration = new index.Anr(options);
      integration.setup(client);
      return Promise.resolve();
    }
    exports.enableAnrDetection = enableAnrDetection;
  }
});

// ../../node_modules/.pnpm/@sentry+node@7.120.1/node_modules/@sentry/node/cjs/trpc.js
var require_trpc = __commonJS({
  "../../node_modules/.pnpm/@sentry+node@7.120.1/node_modules/@sentry/node/cjs/trpc.js"(exports) {
    var {
      _optionalChain
    } = require_cjs();
    Object.defineProperty(exports, "__esModule", { value: true });
    var core = require_cjs2();
    var utils = require_cjs();
    function trpcMiddleware(options = {}) {
      return function({ path, type, next, rawInput }) {
        const clientOptions = _optionalChain([core.getClient, "call", (_) => _(), "optionalAccess", (_2) => _2.getOptions, "call", (_3) => _3()]);
        const sentryTransaction = core.getCurrentScope().getTransaction();
        if (sentryTransaction) {
          sentryTransaction.updateName(`trpc/${path}`);
          sentryTransaction.setAttribute(core.SEMANTIC_ATTRIBUTE_SENTRY_SOURCE, "route");
          sentryTransaction.op = "rpc.server";
          const trpcContext = {
            procedure_type: type
          };
          if (options.attachRpcInput !== void 0 ? options.attachRpcInput : _optionalChain([clientOptions, "optionalAccess", (_4) => _4.sendDefaultPii])) {
            trpcContext.input = utils.normalize(rawInput);
          }
          sentryTransaction.setContext("trpc", trpcContext);
        }
        function captureIfError(nextResult) {
          if (!nextResult.ok) {
            core.captureException(nextResult.error, { mechanism: { handled: false, data: { function: "trpcMiddleware" } } });
          }
        }
        let maybePromiseResult;
        try {
          maybePromiseResult = next();
        } catch (e) {
          core.captureException(e, { mechanism: { handled: false, data: { function: "trpcMiddleware" } } });
          throw e;
        }
        if (utils.isThenable(maybePromiseResult)) {
          Promise.resolve(maybePromiseResult).then(
            (nextResult) => {
              captureIfError(nextResult);
            },
            (e) => {
              core.captureException(e, { mechanism: { handled: false, data: { function: "trpcMiddleware" } } });
            }
          );
        } else {
          captureIfError(maybePromiseResult);
        }
        return maybePromiseResult;
      };
    }
    exports.trpcMiddleware = trpcMiddleware;
  }
});

// ../../node_modules/.pnpm/@sentry+node@7.120.1/node_modules/@sentry/node/cjs/requestDataDeprecated.js
var require_requestDataDeprecated = __commonJS({
  "../../node_modules/.pnpm/@sentry+node@7.120.1/node_modules/@sentry/node/cjs/requestDataDeprecated.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var utils = require_cjs();
    function extractRequestData(req, keys) {
      return utils.extractRequestData(req, { include: keys });
    }
    function parseRequest(event, req, options = {}) {
      return utils.addRequestDataToEvent(event, req, { include: options });
    }
    exports.extractRequestData = extractRequestData;
    exports.parseRequest = parseRequest;
  }
});

// ../../node_modules/.pnpm/@sentry+node@7.120.1/node_modules/@sentry/node/cjs/handlers.js
var require_handlers2 = __commonJS({
  "../../node_modules/.pnpm/@sentry+node@7.120.1/node_modules/@sentry/node/cjs/handlers.js"(exports) {
    var {
      _optionalChain
    } = require_cjs();
    Object.defineProperty(exports, "__esModule", { value: true });
    var core = require_cjs2();
    var utils = require_cjs();
    var debugBuild = require_debug_build4();
    var sdk = require_sdk2();
    var trpc = require_trpc();
    var requestDataDeprecated = require_requestDataDeprecated();
    function tracingHandler() {
      return function sentryTracingMiddleware(req, res, next) {
        const options = _optionalChain([core.getClient, "call", (_) => _(), "optionalAccess", (_2) => _2.getOptions, "call", (_3) => _3()]);
        if (!options || options.instrumenter !== "sentry" || _optionalChain([req, "access", (_4) => _4.method, "optionalAccess", (_5) => _5.toUpperCase, "call", (_6) => _6()]) === "OPTIONS" || _optionalChain([req, "access", (_7) => _7.method, "optionalAccess", (_8) => _8.toUpperCase, "call", (_9) => _9()]) === "HEAD") {
          return next();
        }
        const sentryTrace = req.headers && utils.isString(req.headers["sentry-trace"]) ? req.headers["sentry-trace"] : void 0;
        const baggage = _optionalChain([req, "access", (_10) => _10.headers, "optionalAccess", (_11) => _11.baggage]);
        if (!core.hasTracingEnabled(options)) {
          return next();
        }
        const [name, source] = utils.extractPathForTransaction(req, { path: true, method: true });
        const transaction = core.continueTrace(
          { sentryTrace, baggage },
          (ctx) => (
            // TODO: Refactor this to use `startSpan()`
            // eslint-disable-next-line deprecation/deprecation
            core.startTransaction(
              {
                name,
                op: "http.server",
                origin: "auto.http.node.tracingHandler",
                ...ctx,
                data: {
                  [core.SEMANTIC_ATTRIBUTE_SENTRY_SOURCE]: source
                },
                metadata: {
                  // eslint-disable-next-line deprecation/deprecation
                  ...ctx.metadata,
                  // The request should already have been stored in `scope.sdkProcessingMetadata` (which will become
                  // `event.sdkProcessingMetadata` the same way the metadata here will) by `sentryRequestMiddleware`, but on the
                  // off chance someone is using `sentryTracingMiddleware` without `sentryRequestMiddleware`, it doesn't hurt to
                  // be sure
                  request: req
                }
              },
              // extra context passed to the tracesSampler
              { request: utils.extractRequestData(req) }
            )
          )
        );
        core.getCurrentScope().setSpan(transaction);
        res.__sentry_transaction = transaction;
        res.once("finish", () => {
          setImmediate(() => {
            utils.addRequestDataToTransaction(transaction, req);
            core.setHttpStatus(transaction, res.statusCode);
            transaction.end();
          });
        });
        next();
      };
    }
    function convertReqHandlerOptsToAddReqDataOpts(reqHandlerOptions = {}) {
      let addRequestDataOptions;
      if ("include" in reqHandlerOptions) {
        addRequestDataOptions = { include: reqHandlerOptions.include };
      } else {
        const { ip, request, transaction, user } = reqHandlerOptions;
        if (ip || request || transaction || user) {
          addRequestDataOptions = { include: utils.dropUndefinedKeys({ ip, request, transaction, user }) };
        }
      }
      return addRequestDataOptions;
    }
    function requestHandler(options) {
      const requestDataOptions = convertReqHandlerOptsToAddReqDataOpts(options);
      const client = core.getClient();
      if (client && sdk.isAutoSessionTrackingEnabled(client)) {
        client.initSessionFlusher();
        const scope = core.getCurrentScope();
        if (scope.getSession()) {
          scope.setSession();
        }
      }
      return function sentryRequestMiddleware(req, res, next) {
        if (options && options.flushTimeout && options.flushTimeout > 0) {
          const _end = res.end;
          res.end = function(chunk, encoding, cb) {
            void core.flush(options.flushTimeout).then(() => {
              _end.call(this, chunk, encoding, cb);
            }).then(null, (e) => {
              debugBuild.DEBUG_BUILD && utils.logger.error(e);
              _end.call(this, chunk, encoding, cb);
            });
          };
        }
        core.runWithAsyncContext(() => {
          const scope = core.getCurrentScope();
          scope.setSDKProcessingMetadata({
            request: req,
            // TODO (v8): Stop passing this
            requestDataOptionsFromExpressHandler: requestDataOptions
          });
          const client2 = core.getClient();
          if (sdk.isAutoSessionTrackingEnabled(client2)) {
            scope.setRequestSession({ status: "ok" });
          }
          res.once("finish", () => {
            const client3 = core.getClient();
            if (sdk.isAutoSessionTrackingEnabled(client3)) {
              setImmediate(() => {
                if (client3 && client3._captureRequestSession) {
                  client3._captureRequestSession();
                }
              });
            }
          });
          next();
        });
      };
    }
    function getStatusCodeFromResponse(error) {
      const statusCode = error.status || error.statusCode || error.status_code || error.output && error.output.statusCode;
      return statusCode ? parseInt(statusCode, 10) : 500;
    }
    function defaultShouldHandleError(error) {
      const status = getStatusCodeFromResponse(error);
      return status >= 500;
    }
    function errorHandler(options) {
      return function sentryErrorMiddleware(error, _req, res, next) {
        const shouldHandleError = options && options.shouldHandleError || defaultShouldHandleError;
        if (shouldHandleError(error)) {
          core.withScope((_scope) => {
            _scope.setSDKProcessingMetadata({ request: _req });
            const transaction = res.__sentry_transaction;
            if (transaction && !core.getActiveSpan()) {
              _scope.setSpan(transaction);
            }
            const client = core.getClient();
            if (client && sdk.isAutoSessionTrackingEnabled(client)) {
              const isSessionAggregatesMode = client._sessionFlusher !== void 0;
              if (isSessionAggregatesMode) {
                const requestSession = _scope.getRequestSession();
                if (requestSession && requestSession.status !== void 0) {
                  requestSession.status = "crashed";
                }
              }
            }
            const eventId = core.captureException(error, { mechanism: { type: "middleware", handled: false } });
            res.sentry = eventId;
            next(error);
          });
          return;
        }
        next(error);
      };
    }
    var trpcMiddleware = trpc.trpcMiddleware;
    exports.extractRequestData = requestDataDeprecated.extractRequestData;
    exports.parseRequest = requestDataDeprecated.parseRequest;
    exports.errorHandler = errorHandler;
    exports.requestHandler = requestHandler;
    exports.tracingHandler = tracingHandler;
    exports.trpcMiddleware = trpcMiddleware;
  }
});

// ../../node_modules/.pnpm/@sentry+node@7.120.1/node_modules/@sentry/node/cjs/integrations/hapi/index.js
var require_hapi = __commonJS({
  "../../node_modules/.pnpm/@sentry+node@7.120.1/node_modules/@sentry/node/cjs/integrations/hapi/index.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var core = require_cjs2();
    var utils = require_cjs();
    function isResponseObject(response) {
      return response && response.statusCode !== void 0;
    }
    function isErrorEvent(event) {
      return event && event.error !== void 0;
    }
    function sendErrorToSentry(errorData) {
      core.captureException(errorData, {
        mechanism: {
          type: "hapi",
          handled: false,
          data: {
            function: "hapiErrorPlugin"
          }
        }
      });
    }
    var hapiErrorPlugin = {
      name: "SentryHapiErrorPlugin",
      version: core.SDK_VERSION,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      register: async function(serverArg) {
        const server = serverArg;
        server.events.on("request", (request, event) => {
          const transaction = core.getActiveTransaction();
          if (isErrorEvent(event)) {
            sendErrorToSentry(event.error);
          }
          if (transaction) {
            transaction.setStatus("internal_error");
            transaction.end();
          }
        });
      }
    };
    var hapiTracingPlugin = {
      name: "SentryHapiTracingPlugin",
      version: core.SDK_VERSION,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      register: async function(serverArg) {
        const server = serverArg;
        server.ext("onPreHandler", (request, h) => {
          const transaction = core.continueTrace(
            {
              sentryTrace: request.headers["sentry-trace"] || void 0,
              baggage: request.headers["baggage"] || void 0
            },
            (transactionContext) => {
              return core.startTransaction({
                ...transactionContext,
                op: "hapi.request",
                name: request.route.path,
                description: `${request.route.method} ${request.path}`
              });
            }
          );
          core.getCurrentScope().setSpan(transaction);
          return h.continue;
        });
        server.ext("onPreResponse", (request, h) => {
          const transaction = core.getActiveTransaction();
          if (request.response && isResponseObject(request.response) && transaction) {
            const response = request.response;
            response.header("sentry-trace", core.spanToTraceHeader(transaction));
            const dynamicSamplingContext = utils.dynamicSamplingContextToSentryBaggageHeader(
              core.getDynamicSamplingContextFromSpan(transaction)
            );
            if (dynamicSamplingContext) {
              response.header("baggage", dynamicSamplingContext);
            }
          }
          return h.continue;
        });
        server.ext("onPostHandler", (request, h) => {
          const transaction = core.getActiveTransaction();
          if (transaction) {
            if (request.response && isResponseObject(request.response)) {
              core.setHttpStatus(transaction, request.response.statusCode);
            }
            transaction.end();
          }
          return h.continue;
        });
      }
    };
    var INTEGRATION_NAME = "Hapi";
    var _hapiIntegration = (options = {}) => {
      const server = options.server;
      return {
        name: INTEGRATION_NAME,
        setupOnce() {
          if (!server) {
            return;
          }
          utils.fill(server, "start", (originalStart) => {
            return async function() {
              await this.register(hapiTracingPlugin);
              await this.register(hapiErrorPlugin);
              const result = originalStart.apply(this);
              return result;
            };
          });
        }
      };
    };
    var hapiIntegration = core.defineIntegration(_hapiIntegration);
    var Hapi = core.convertIntegrationFnToClass(INTEGRATION_NAME, hapiIntegration);
    exports.Hapi = Hapi;
    exports.hapiErrorPlugin = hapiErrorPlugin;
    exports.hapiIntegration = hapiIntegration;
    exports.hapiTracingPlugin = hapiTracingPlugin;
  }
});

// ../../node_modules/.pnpm/@sentry+node@7.120.1/node_modules/@sentry/node/cjs/integrations/index.js
var require_integrations2 = __commonJS({
  "../../node_modules/.pnpm/@sentry+node@7.120.1/node_modules/@sentry/node/cjs/integrations/index.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var console2 = require_console2();
    var http = require_http3();
    var onuncaughtexception = require_onuncaughtexception();
    var onunhandledrejection = require_onunhandledrejection();
    var modules = require_modules();
    var contextlines = require_contextlines();
    var context = require_context();
    var core = require_cjs2();
    var index = require_local_variables();
    var index$1 = require_undici();
    var spotlight = require_spotlight();
    var index$2 = require_anr2();
    var index$3 = require_hapi();
    exports.Console = console2.Console;
    exports.Http = http.Http;
    exports.OnUncaughtException = onuncaughtexception.OnUncaughtException;
    exports.OnUnhandledRejection = onunhandledrejection.OnUnhandledRejection;
    exports.Modules = modules.Modules;
    exports.ContextLines = contextlines.ContextLines;
    exports.Context = context.Context;
    exports.RequestData = core.RequestData;
    exports.LocalVariables = index.LocalVariables;
    exports.Undici = index$1.Undici;
    exports.Spotlight = spotlight.Spotlight;
    exports.Anr = index$2.Anr;
    exports.Hapi = index$3.Hapi;
  }
});

// ../../node_modules/.pnpm/@sentry+node@7.120.1/node_modules/@sentry/node/cjs/tracing/integrations.js
var require_integrations3 = __commonJS({
  "../../node_modules/.pnpm/@sentry+node@7.120.1/node_modules/@sentry/node/cjs/tracing/integrations.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var tracing = require_cjs3();
    exports.Apollo = tracing.Apollo;
    exports.Express = tracing.Express;
    exports.GraphQL = tracing.GraphQL;
    exports.Mongo = tracing.Mongo;
    exports.Mysql = tracing.Mysql;
    exports.Postgres = tracing.Postgres;
    exports.Prisma = tracing.Prisma;
  }
});

// ../../node_modules/.pnpm/@sentry+integrations@7.120.1/node_modules/@sentry/integrations/cjs/captureconsole.js
var require_captureconsole = __commonJS({
  "../../node_modules/.pnpm/@sentry+integrations@7.120.1/node_modules/@sentry/integrations/cjs/captureconsole.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var core = require_cjs2();
    var utils = require_cjs();
    var INTEGRATION_NAME = "CaptureConsole";
    var _captureConsoleIntegration = (options = {}) => {
      const levels = options.levels || utils.CONSOLE_LEVELS;
      return {
        name: INTEGRATION_NAME,
        // TODO v8: Remove this
        setupOnce() {
        },
        // eslint-disable-line @typescript-eslint/no-empty-function
        setup(client) {
          if (!("console" in utils.GLOBAL_OBJ)) {
            return;
          }
          utils.addConsoleInstrumentationHandler(({ args, level }) => {
            if (core.getClient() !== client || !levels.includes(level)) {
              return;
            }
            consoleHandler(args, level);
          });
        }
      };
    };
    var captureConsoleIntegration = core.defineIntegration(_captureConsoleIntegration);
    var CaptureConsole = core.convertIntegrationFnToClass(
      INTEGRATION_NAME,
      captureConsoleIntegration
    );
    function consoleHandler(args, level) {
      const captureContext = {
        level: utils.severityLevelFromString(level),
        extra: {
          arguments: args
        }
      };
      core.withScope((scope) => {
        scope.addEventProcessor((event) => {
          event.logger = "console";
          utils.addExceptionMechanism(event, {
            handled: false,
            type: "console"
          });
          return event;
        });
        if (level === "assert" && args[0] === false) {
          const message2 = `Assertion failed: ${utils.safeJoin(args.slice(1), " ") || "console.assert"}`;
          scope.setExtra("arguments", args.slice(1));
          core.captureMessage(message2, captureContext);
          return;
        }
        const error = args.find((arg) => arg instanceof Error);
        if (level === "error" && error) {
          core.captureException(error, captureContext);
          return;
        }
        const message = utils.safeJoin(args, " ");
        core.captureMessage(message, captureContext);
      });
    }
    exports.CaptureConsole = CaptureConsole;
    exports.captureConsoleIntegration = captureConsoleIntegration;
  }
});

// ../../node_modules/.pnpm/@sentry+integrations@7.120.1/node_modules/@sentry/integrations/cjs/debug.js
var require_debug = __commonJS({
  "../../node_modules/.pnpm/@sentry+integrations@7.120.1/node_modules/@sentry/integrations/cjs/debug.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var core = require_cjs2();
    var utils = require_cjs();
    var INTEGRATION_NAME = "Debug";
    var _debugIntegration = (options = {}) => {
      const _options = {
        debugger: false,
        stringify: false,
        ...options
      };
      return {
        name: INTEGRATION_NAME,
        // TODO v8: Remove this
        setupOnce() {
        },
        // eslint-disable-line @typescript-eslint/no-empty-function
        setup(client) {
          if (!client.on) {
            return;
          }
          client.on("beforeSendEvent", (event, hint) => {
            if (_options.debugger) {
              debugger;
            }
            utils.consoleSandbox(() => {
              if (_options.stringify) {
                console.log(JSON.stringify(event, null, 2));
                if (hint && Object.keys(hint).length) {
                  console.log(JSON.stringify(hint, null, 2));
                }
              } else {
                console.log(event);
                if (hint && Object.keys(hint).length) {
                  console.log(hint);
                }
              }
            });
          });
        }
      };
    };
    var debugIntegration = core.defineIntegration(_debugIntegration);
    var Debug = core.convertIntegrationFnToClass(INTEGRATION_NAME, debugIntegration);
    exports.Debug = Debug;
    exports.debugIntegration = debugIntegration;
  }
});

// ../../node_modules/.pnpm/@sentry+integrations@7.120.1/node_modules/@sentry/integrations/cjs/debug-build.js
var require_debug_build5 = __commonJS({
  "../../node_modules/.pnpm/@sentry+integrations@7.120.1/node_modules/@sentry/integrations/cjs/debug-build.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var DEBUG_BUILD = typeof __SENTRY_DEBUG__ === "undefined" || __SENTRY_DEBUG__;
    exports.DEBUG_BUILD = DEBUG_BUILD;
  }
});

// ../../node_modules/.pnpm/@sentry+integrations@7.120.1/node_modules/@sentry/integrations/cjs/dedupe.js
var require_dedupe = __commonJS({
  "../../node_modules/.pnpm/@sentry+integrations@7.120.1/node_modules/@sentry/integrations/cjs/dedupe.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var core = require_cjs2();
    var utils = require_cjs();
    var debugBuild = require_debug_build5();
    var INTEGRATION_NAME = "Dedupe";
    var _dedupeIntegration = () => {
      let previousEvent;
      return {
        name: INTEGRATION_NAME,
        // TODO v8: Remove this
        setupOnce() {
        },
        // eslint-disable-line @typescript-eslint/no-empty-function
        processEvent(currentEvent) {
          if (currentEvent.type) {
            return currentEvent;
          }
          try {
            if (_shouldDropEvent(currentEvent, previousEvent)) {
              debugBuild.DEBUG_BUILD && utils.logger.warn("Event dropped due to being a duplicate of previously captured event.");
              return null;
            }
          } catch (_oO) {
          }
          return previousEvent = currentEvent;
        }
      };
    };
    var dedupeIntegration = core.defineIntegration(_dedupeIntegration);
    var Dedupe = core.convertIntegrationFnToClass(INTEGRATION_NAME, dedupeIntegration);
    function _shouldDropEvent(currentEvent, previousEvent) {
      if (!previousEvent) {
        return false;
      }
      if (_isSameMessageEvent(currentEvent, previousEvent)) {
        return true;
      }
      if (_isSameExceptionEvent(currentEvent, previousEvent)) {
        return true;
      }
      return false;
    }
    function _isSameMessageEvent(currentEvent, previousEvent) {
      const currentMessage = currentEvent.message;
      const previousMessage = previousEvent.message;
      if (!currentMessage && !previousMessage) {
        return false;
      }
      if (currentMessage && !previousMessage || !currentMessage && previousMessage) {
        return false;
      }
      if (currentMessage !== previousMessage) {
        return false;
      }
      if (!_isSameFingerprint(currentEvent, previousEvent)) {
        return false;
      }
      if (!_isSameStacktrace(currentEvent, previousEvent)) {
        return false;
      }
      return true;
    }
    function _isSameExceptionEvent(currentEvent, previousEvent) {
      const previousException = _getExceptionFromEvent(previousEvent);
      const currentException = _getExceptionFromEvent(currentEvent);
      if (!previousException || !currentException) {
        return false;
      }
      if (previousException.type !== currentException.type || previousException.value !== currentException.value) {
        return false;
      }
      if (!_isSameFingerprint(currentEvent, previousEvent)) {
        return false;
      }
      if (!_isSameStacktrace(currentEvent, previousEvent)) {
        return false;
      }
      return true;
    }
    function _isSameStacktrace(currentEvent, previousEvent) {
      let currentFrames = _getFramesFromEvent(currentEvent);
      let previousFrames = _getFramesFromEvent(previousEvent);
      if (!currentFrames && !previousFrames) {
        return true;
      }
      if (currentFrames && !previousFrames || !currentFrames && previousFrames) {
        return false;
      }
      currentFrames = currentFrames;
      previousFrames = previousFrames;
      if (previousFrames.length !== currentFrames.length) {
        return false;
      }
      for (let i = 0; i < previousFrames.length; i++) {
        const frameA = previousFrames[i];
        const frameB = currentFrames[i];
        if (frameA.filename !== frameB.filename || frameA.lineno !== frameB.lineno || frameA.colno !== frameB.colno || frameA.function !== frameB.function) {
          return false;
        }
      }
      return true;
    }
    function _isSameFingerprint(currentEvent, previousEvent) {
      let currentFingerprint = currentEvent.fingerprint;
      let previousFingerprint = previousEvent.fingerprint;
      if (!currentFingerprint && !previousFingerprint) {
        return true;
      }
      if (currentFingerprint && !previousFingerprint || !currentFingerprint && previousFingerprint) {
        return false;
      }
      currentFingerprint = currentFingerprint;
      previousFingerprint = previousFingerprint;
      try {
        return !!(currentFingerprint.join("") === previousFingerprint.join(""));
      } catch (_oO) {
        return false;
      }
    }
    function _getExceptionFromEvent(event) {
      return event.exception && event.exception.values && event.exception.values[0];
    }
    function _getFramesFromEvent(event) {
      const exception = event.exception;
      if (exception) {
        try {
          return exception.values[0].stacktrace.frames;
        } catch (_oO) {
          return void 0;
        }
      }
      return void 0;
    }
    exports.Dedupe = Dedupe;
    exports._shouldDropEvent = _shouldDropEvent;
    exports.dedupeIntegration = dedupeIntegration;
  }
});

// ../../node_modules/.pnpm/@sentry+integrations@7.120.1/node_modules/@sentry/integrations/cjs/extraerrordata.js
var require_extraerrordata = __commonJS({
  "../../node_modules/.pnpm/@sentry+integrations@7.120.1/node_modules/@sentry/integrations/cjs/extraerrordata.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var core = require_cjs2();
    var utils = require_cjs();
    var debugBuild = require_debug_build5();
    var INTEGRATION_NAME = "ExtraErrorData";
    var _extraErrorDataIntegration = (options = {}) => {
      const depth = options.depth || 3;
      const captureErrorCause = options.captureErrorCause || false;
      return {
        name: INTEGRATION_NAME,
        // TODO v8: Remove this
        setupOnce() {
        },
        // eslint-disable-line @typescript-eslint/no-empty-function
        processEvent(event, hint) {
          return _enhanceEventWithErrorData(event, hint, depth, captureErrorCause);
        }
      };
    };
    var extraErrorDataIntegration = core.defineIntegration(_extraErrorDataIntegration);
    var ExtraErrorData = core.convertIntegrationFnToClass(
      INTEGRATION_NAME,
      extraErrorDataIntegration
    );
    function _enhanceEventWithErrorData(event, hint = {}, depth, captureErrorCause) {
      if (!hint.originalException || !utils.isError(hint.originalException)) {
        return event;
      }
      const exceptionName = hint.originalException.name || hint.originalException.constructor.name;
      const errorData = _extractErrorData(hint.originalException, captureErrorCause);
      if (errorData) {
        const contexts = {
          ...event.contexts
        };
        const normalizedErrorData = utils.normalize(errorData, depth);
        if (utils.isPlainObject(normalizedErrorData)) {
          utils.addNonEnumerableProperty(normalizedErrorData, "__sentry_skip_normalization__", true);
          contexts[exceptionName] = normalizedErrorData;
        }
        return {
          ...event,
          contexts
        };
      }
      return event;
    }
    function _extractErrorData(error, captureErrorCause) {
      try {
        const nativeKeys = [
          "name",
          "message",
          "stack",
          "line",
          "column",
          "fileName",
          "lineNumber",
          "columnNumber",
          "toJSON"
        ];
        const extraErrorInfo = {};
        for (const key of Object.keys(error)) {
          if (nativeKeys.indexOf(key) !== -1) {
            continue;
          }
          const value = error[key];
          extraErrorInfo[key] = utils.isError(value) ? value.toString() : value;
        }
        if (captureErrorCause && error.cause !== void 0) {
          extraErrorInfo.cause = utils.isError(error.cause) ? error.cause.toString() : error.cause;
        }
        if (typeof error.toJSON === "function") {
          const serializedError = error.toJSON();
          for (const key of Object.keys(serializedError)) {
            const value = serializedError[key];
            extraErrorInfo[key] = utils.isError(value) ? value.toString() : value;
          }
        }
        return extraErrorInfo;
      } catch (oO) {
        debugBuild.DEBUG_BUILD && utils.logger.error("Unable to extract extra data from the Error object:", oO);
      }
      return null;
    }
    exports.ExtraErrorData = ExtraErrorData;
    exports.extraErrorDataIntegration = extraErrorDataIntegration;
  }
});

// ../../node_modules/.pnpm/localforage@1.10.0/node_modules/localforage/dist/localforage.js
var require_localforage = __commonJS({
  "../../node_modules/.pnpm/localforage@1.10.0/node_modules/localforage/dist/localforage.js"(exports, module) {
    (function(f) {
      if (typeof exports === "object" && typeof module !== "undefined") {
        module.exports = f();
      } else if (typeof define === "function" && define.amd) {
        define([], f);
      } else {
        var g;
        if (typeof window !== "undefined") {
          g = window;
        } else if (typeof global !== "undefined") {
          g = global;
        } else if (typeof self !== "undefined") {
          g = self;
        } else {
          g = this;
        }
        g.localforage = f();
      }
    })(function() {
      var define2, module2, exports2;
      return function e(t, n, r) {
        function s(o2, u) {
          if (!n[o2]) {
            if (!t[o2]) {
              var a = typeof __require == "function" && __require;
              if (!u && a)
                return a(o2, true);
              if (i)
                return i(o2, true);
              var f = new Error("Cannot find module '" + o2 + "'");
              throw f.code = "MODULE_NOT_FOUND", f;
            }
            var l = n[o2] = { exports: {} };
            t[o2][0].call(l.exports, function(e2) {
              var n2 = t[o2][1][e2];
              return s(n2 ? n2 : e2);
            }, l, l.exports, e, t, n, r);
          }
          return n[o2].exports;
        }
        var i = typeof __require == "function" && __require;
        for (var o = 0; o < r.length; o++)
          s(r[o]);
        return s;
      }({ 1: [function(_dereq_, module3, exports3) {
        (function(global2) {
          "use strict";
          var Mutation = global2.MutationObserver || global2.WebKitMutationObserver;
          var scheduleDrain;
          {
            if (Mutation) {
              var called = 0;
              var observer = new Mutation(nextTick);
              var element = global2.document.createTextNode("");
              observer.observe(element, {
                characterData: true
              });
              scheduleDrain = function() {
                element.data = called = ++called % 2;
              };
            } else if (!global2.setImmediate && typeof global2.MessageChannel !== "undefined") {
              var channel = new global2.MessageChannel();
              channel.port1.onmessage = nextTick;
              scheduleDrain = function() {
                channel.port2.postMessage(0);
              };
            } else if ("document" in global2 && "onreadystatechange" in global2.document.createElement("script")) {
              scheduleDrain = function() {
                var scriptEl = global2.document.createElement("script");
                scriptEl.onreadystatechange = function() {
                  nextTick();
                  scriptEl.onreadystatechange = null;
                  scriptEl.parentNode.removeChild(scriptEl);
                  scriptEl = null;
                };
                global2.document.documentElement.appendChild(scriptEl);
              };
            } else {
              scheduleDrain = function() {
                setTimeout(nextTick, 0);
              };
            }
          }
          var draining;
          var queue = [];
          function nextTick() {
            draining = true;
            var i, oldQueue;
            var len = queue.length;
            while (len) {
              oldQueue = queue;
              queue = [];
              i = -1;
              while (++i < len) {
                oldQueue[i]();
              }
              len = queue.length;
            }
            draining = false;
          }
          module3.exports = immediate;
          function immediate(task) {
            if (queue.push(task) === 1 && !draining) {
              scheduleDrain();
            }
          }
        }).call(this, typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {});
      }, {}], 2: [function(_dereq_, module3, exports3) {
        "use strict";
        var immediate = _dereq_(1);
        function INTERNAL() {
        }
        var handlers = {};
        var REJECTED = ["REJECTED"];
        var FULFILLED = ["FULFILLED"];
        var PENDING = ["PENDING"];
        module3.exports = Promise2;
        function Promise2(resolver) {
          if (typeof resolver !== "function") {
            throw new TypeError("resolver must be a function");
          }
          this.state = PENDING;
          this.queue = [];
          this.outcome = void 0;
          if (resolver !== INTERNAL) {
            safelyResolveThenable(this, resolver);
          }
        }
        Promise2.prototype["catch"] = function(onRejected) {
          return this.then(null, onRejected);
        };
        Promise2.prototype.then = function(onFulfilled, onRejected) {
          if (typeof onFulfilled !== "function" && this.state === FULFILLED || typeof onRejected !== "function" && this.state === REJECTED) {
            return this;
          }
          var promise = new this.constructor(INTERNAL);
          if (this.state !== PENDING) {
            var resolver = this.state === FULFILLED ? onFulfilled : onRejected;
            unwrap(promise, resolver, this.outcome);
          } else {
            this.queue.push(new QueueItem(promise, onFulfilled, onRejected));
          }
          return promise;
        };
        function QueueItem(promise, onFulfilled, onRejected) {
          this.promise = promise;
          if (typeof onFulfilled === "function") {
            this.onFulfilled = onFulfilled;
            this.callFulfilled = this.otherCallFulfilled;
          }
          if (typeof onRejected === "function") {
            this.onRejected = onRejected;
            this.callRejected = this.otherCallRejected;
          }
        }
        QueueItem.prototype.callFulfilled = function(value) {
          handlers.resolve(this.promise, value);
        };
        QueueItem.prototype.otherCallFulfilled = function(value) {
          unwrap(this.promise, this.onFulfilled, value);
        };
        QueueItem.prototype.callRejected = function(value) {
          handlers.reject(this.promise, value);
        };
        QueueItem.prototype.otherCallRejected = function(value) {
          unwrap(this.promise, this.onRejected, value);
        };
        function unwrap(promise, func, value) {
          immediate(function() {
            var returnValue;
            try {
              returnValue = func(value);
            } catch (e) {
              return handlers.reject(promise, e);
            }
            if (returnValue === promise) {
              handlers.reject(promise, new TypeError("Cannot resolve promise with itself"));
            } else {
              handlers.resolve(promise, returnValue);
            }
          });
        }
        handlers.resolve = function(self2, value) {
          var result = tryCatch(getThen, value);
          if (result.status === "error") {
            return handlers.reject(self2, result.value);
          }
          var thenable = result.value;
          if (thenable) {
            safelyResolveThenable(self2, thenable);
          } else {
            self2.state = FULFILLED;
            self2.outcome = value;
            var i = -1;
            var len = self2.queue.length;
            while (++i < len) {
              self2.queue[i].callFulfilled(value);
            }
          }
          return self2;
        };
        handlers.reject = function(self2, error) {
          self2.state = REJECTED;
          self2.outcome = error;
          var i = -1;
          var len = self2.queue.length;
          while (++i < len) {
            self2.queue[i].callRejected(error);
          }
          return self2;
        };
        function getThen(obj) {
          var then = obj && obj.then;
          if (obj && (typeof obj === "object" || typeof obj === "function") && typeof then === "function") {
            return function appyThen() {
              then.apply(obj, arguments);
            };
          }
        }
        function safelyResolveThenable(self2, thenable) {
          var called = false;
          function onError(value) {
            if (called) {
              return;
            }
            called = true;
            handlers.reject(self2, value);
          }
          function onSuccess(value) {
            if (called) {
              return;
            }
            called = true;
            handlers.resolve(self2, value);
          }
          function tryToUnwrap() {
            thenable(onSuccess, onError);
          }
          var result = tryCatch(tryToUnwrap);
          if (result.status === "error") {
            onError(result.value);
          }
        }
        function tryCatch(func, value) {
          var out = {};
          try {
            out.value = func(value);
            out.status = "success";
          } catch (e) {
            out.status = "error";
            out.value = e;
          }
          return out;
        }
        Promise2.resolve = resolve;
        function resolve(value) {
          if (value instanceof this) {
            return value;
          }
          return handlers.resolve(new this(INTERNAL), value);
        }
        Promise2.reject = reject;
        function reject(reason) {
          var promise = new this(INTERNAL);
          return handlers.reject(promise, reason);
        }
        Promise2.all = all;
        function all(iterable) {
          var self2 = this;
          if (Object.prototype.toString.call(iterable) !== "[object Array]") {
            return this.reject(new TypeError("must be an array"));
          }
          var len = iterable.length;
          var called = false;
          if (!len) {
            return this.resolve([]);
          }
          var values = new Array(len);
          var resolved = 0;
          var i = -1;
          var promise = new this(INTERNAL);
          while (++i < len) {
            allResolver(iterable[i], i);
          }
          return promise;
          function allResolver(value, i2) {
            self2.resolve(value).then(resolveFromAll, function(error) {
              if (!called) {
                called = true;
                handlers.reject(promise, error);
              }
            });
            function resolveFromAll(outValue) {
              values[i2] = outValue;
              if (++resolved === len && !called) {
                called = true;
                handlers.resolve(promise, values);
              }
            }
          }
        }
        Promise2.race = race;
        function race(iterable) {
          var self2 = this;
          if (Object.prototype.toString.call(iterable) !== "[object Array]") {
            return this.reject(new TypeError("must be an array"));
          }
          var len = iterable.length;
          var called = false;
          if (!len) {
            return this.resolve([]);
          }
          var i = -1;
          var promise = new this(INTERNAL);
          while (++i < len) {
            resolver(iterable[i]);
          }
          return promise;
          function resolver(value) {
            self2.resolve(value).then(function(response) {
              if (!called) {
                called = true;
                handlers.resolve(promise, response);
              }
            }, function(error) {
              if (!called) {
                called = true;
                handlers.reject(promise, error);
              }
            });
          }
        }
      }, { "1": 1 }], 3: [function(_dereq_, module3, exports3) {
        (function(global2) {
          "use strict";
          if (typeof global2.Promise !== "function") {
            global2.Promise = _dereq_(2);
          }
        }).call(this, typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {});
      }, { "2": 2 }], 4: [function(_dereq_, module3, exports3) {
        "use strict";
        var _typeof = typeof Symbol === "function" && typeof Symbol.iterator === "symbol" ? function(obj) {
          return typeof obj;
        } : function(obj) {
          return obj && typeof Symbol === "function" && obj.constructor === Symbol && obj !== Symbol.prototype ? "symbol" : typeof obj;
        };
        function _classCallCheck(instance, Constructor) {
          if (!(instance instanceof Constructor)) {
            throw new TypeError("Cannot call a class as a function");
          }
        }
        function getIDB() {
          try {
            if (typeof indexedDB !== "undefined") {
              return indexedDB;
            }
            if (typeof webkitIndexedDB !== "undefined") {
              return webkitIndexedDB;
            }
            if (typeof mozIndexedDB !== "undefined") {
              return mozIndexedDB;
            }
            if (typeof OIndexedDB !== "undefined") {
              return OIndexedDB;
            }
            if (typeof msIndexedDB !== "undefined") {
              return msIndexedDB;
            }
          } catch (e) {
            return;
          }
        }
        var idb = getIDB();
        function isIndexedDBValid() {
          try {
            if (!idb || !idb.open) {
              return false;
            }
            var isSafari = typeof openDatabase !== "undefined" && /(Safari|iPhone|iPad|iPod)/.test(navigator.userAgent) && !/Chrome/.test(navigator.userAgent) && !/BlackBerry/.test(navigator.platform);
            var hasFetch = typeof fetch === "function" && fetch.toString().indexOf("[native code") !== -1;
            return (!isSafari || hasFetch) && typeof indexedDB !== "undefined" && // some outdated implementations of IDB that appear on Samsung
            // and HTC Android devices <4.4 are missing IDBKeyRange
            // See: https://github.com/mozilla/localForage/issues/128
            // See: https://github.com/mozilla/localForage/issues/272
            typeof IDBKeyRange !== "undefined";
          } catch (e) {
            return false;
          }
        }
        function createBlob(parts, properties) {
          parts = parts || [];
          properties = properties || {};
          try {
            return new Blob(parts, properties);
          } catch (e) {
            if (e.name !== "TypeError") {
              throw e;
            }
            var Builder = typeof BlobBuilder !== "undefined" ? BlobBuilder : typeof MSBlobBuilder !== "undefined" ? MSBlobBuilder : typeof MozBlobBuilder !== "undefined" ? MozBlobBuilder : WebKitBlobBuilder;
            var builder = new Builder();
            for (var i = 0; i < parts.length; i += 1) {
              builder.append(parts[i]);
            }
            return builder.getBlob(properties.type);
          }
        }
        if (typeof Promise === "undefined") {
          _dereq_(3);
        }
        var Promise$1 = Promise;
        function executeCallback(promise, callback) {
          if (callback) {
            promise.then(function(result) {
              callback(null, result);
            }, function(error) {
              callback(error);
            });
          }
        }
        function executeTwoCallbacks(promise, callback, errorCallback) {
          if (typeof callback === "function") {
            promise.then(callback);
          }
          if (typeof errorCallback === "function") {
            promise["catch"](errorCallback);
          }
        }
        function normalizeKey(key2) {
          if (typeof key2 !== "string") {
            console.warn(key2 + " used as a key, but it is not a string.");
            key2 = String(key2);
          }
          return key2;
        }
        function getCallback() {
          if (arguments.length && typeof arguments[arguments.length - 1] === "function") {
            return arguments[arguments.length - 1];
          }
        }
        var DETECT_BLOB_SUPPORT_STORE = "local-forage-detect-blob-support";
        var supportsBlobs = void 0;
        var dbContexts = {};
        var toString = Object.prototype.toString;
        var READ_ONLY = "readonly";
        var READ_WRITE = "readwrite";
        function _binStringToArrayBuffer(bin) {
          var length2 = bin.length;
          var buf = new ArrayBuffer(length2);
          var arr = new Uint8Array(buf);
          for (var i = 0; i < length2; i++) {
            arr[i] = bin.charCodeAt(i);
          }
          return buf;
        }
        function _checkBlobSupportWithoutCaching(idb2) {
          return new Promise$1(function(resolve) {
            var txn = idb2.transaction(DETECT_BLOB_SUPPORT_STORE, READ_WRITE);
            var blob = createBlob([""]);
            txn.objectStore(DETECT_BLOB_SUPPORT_STORE).put(blob, "key");
            txn.onabort = function(e) {
              e.preventDefault();
              e.stopPropagation();
              resolve(false);
            };
            txn.oncomplete = function() {
              var matchedChrome = navigator.userAgent.match(/Chrome\/(\d+)/);
              var matchedEdge = navigator.userAgent.match(/Edge\//);
              resolve(matchedEdge || !matchedChrome || parseInt(matchedChrome[1], 10) >= 43);
            };
          })["catch"](function() {
            return false;
          });
        }
        function _checkBlobSupport(idb2) {
          if (typeof supportsBlobs === "boolean") {
            return Promise$1.resolve(supportsBlobs);
          }
          return _checkBlobSupportWithoutCaching(idb2).then(function(value) {
            supportsBlobs = value;
            return supportsBlobs;
          });
        }
        function _deferReadiness(dbInfo) {
          var dbContext = dbContexts[dbInfo.name];
          var deferredOperation = {};
          deferredOperation.promise = new Promise$1(function(resolve, reject) {
            deferredOperation.resolve = resolve;
            deferredOperation.reject = reject;
          });
          dbContext.deferredOperations.push(deferredOperation);
          if (!dbContext.dbReady) {
            dbContext.dbReady = deferredOperation.promise;
          } else {
            dbContext.dbReady = dbContext.dbReady.then(function() {
              return deferredOperation.promise;
            });
          }
        }
        function _advanceReadiness(dbInfo) {
          var dbContext = dbContexts[dbInfo.name];
          var deferredOperation = dbContext.deferredOperations.pop();
          if (deferredOperation) {
            deferredOperation.resolve();
            return deferredOperation.promise;
          }
        }
        function _rejectReadiness(dbInfo, err) {
          var dbContext = dbContexts[dbInfo.name];
          var deferredOperation = dbContext.deferredOperations.pop();
          if (deferredOperation) {
            deferredOperation.reject(err);
            return deferredOperation.promise;
          }
        }
        function _getConnection(dbInfo, upgradeNeeded) {
          return new Promise$1(function(resolve, reject) {
            dbContexts[dbInfo.name] = dbContexts[dbInfo.name] || createDbContext();
            if (dbInfo.db) {
              if (upgradeNeeded) {
                _deferReadiness(dbInfo);
                dbInfo.db.close();
              } else {
                return resolve(dbInfo.db);
              }
            }
            var dbArgs = [dbInfo.name];
            if (upgradeNeeded) {
              dbArgs.push(dbInfo.version);
            }
            var openreq = idb.open.apply(idb, dbArgs);
            if (upgradeNeeded) {
              openreq.onupgradeneeded = function(e) {
                var db = openreq.result;
                try {
                  db.createObjectStore(dbInfo.storeName);
                  if (e.oldVersion <= 1) {
                    db.createObjectStore(DETECT_BLOB_SUPPORT_STORE);
                  }
                } catch (ex) {
                  if (ex.name === "ConstraintError") {
                    console.warn('The database "' + dbInfo.name + '" has been upgraded from version ' + e.oldVersion + " to version " + e.newVersion + ', but the storage "' + dbInfo.storeName + '" already exists.');
                  } else {
                    throw ex;
                  }
                }
              };
            }
            openreq.onerror = function(e) {
              e.preventDefault();
              reject(openreq.error);
            };
            openreq.onsuccess = function() {
              var db = openreq.result;
              db.onversionchange = function(e) {
                e.target.close();
              };
              resolve(db);
              _advanceReadiness(dbInfo);
            };
          });
        }
        function _getOriginalConnection(dbInfo) {
          return _getConnection(dbInfo, false);
        }
        function _getUpgradedConnection(dbInfo) {
          return _getConnection(dbInfo, true);
        }
        function _isUpgradeNeeded(dbInfo, defaultVersion) {
          if (!dbInfo.db) {
            return true;
          }
          var isNewStore = !dbInfo.db.objectStoreNames.contains(dbInfo.storeName);
          var isDowngrade = dbInfo.version < dbInfo.db.version;
          var isUpgrade = dbInfo.version > dbInfo.db.version;
          if (isDowngrade) {
            if (dbInfo.version !== defaultVersion) {
              console.warn('The database "' + dbInfo.name + `" can't be downgraded from version ` + dbInfo.db.version + " to version " + dbInfo.version + ".");
            }
            dbInfo.version = dbInfo.db.version;
          }
          if (isUpgrade || isNewStore) {
            if (isNewStore) {
              var incVersion = dbInfo.db.version + 1;
              if (incVersion > dbInfo.version) {
                dbInfo.version = incVersion;
              }
            }
            return true;
          }
          return false;
        }
        function _encodeBlob(blob) {
          return new Promise$1(function(resolve, reject) {
            var reader = new FileReader();
            reader.onerror = reject;
            reader.onloadend = function(e) {
              var base64 = btoa(e.target.result || "");
              resolve({
                __local_forage_encoded_blob: true,
                data: base64,
                type: blob.type
              });
            };
            reader.readAsBinaryString(blob);
          });
        }
        function _decodeBlob(encodedBlob) {
          var arrayBuff = _binStringToArrayBuffer(atob(encodedBlob.data));
          return createBlob([arrayBuff], { type: encodedBlob.type });
        }
        function _isEncodedBlob(value) {
          return value && value.__local_forage_encoded_blob;
        }
        function _fullyReady(callback) {
          var self2 = this;
          var promise = self2._initReady().then(function() {
            var dbContext = dbContexts[self2._dbInfo.name];
            if (dbContext && dbContext.dbReady) {
              return dbContext.dbReady;
            }
          });
          executeTwoCallbacks(promise, callback, callback);
          return promise;
        }
        function _tryReconnect(dbInfo) {
          _deferReadiness(dbInfo);
          var dbContext = dbContexts[dbInfo.name];
          var forages = dbContext.forages;
          for (var i = 0; i < forages.length; i++) {
            var forage = forages[i];
            if (forage._dbInfo.db) {
              forage._dbInfo.db.close();
              forage._dbInfo.db = null;
            }
          }
          dbInfo.db = null;
          return _getOriginalConnection(dbInfo).then(function(db) {
            dbInfo.db = db;
            if (_isUpgradeNeeded(dbInfo)) {
              return _getUpgradedConnection(dbInfo);
            }
            return db;
          }).then(function(db) {
            dbInfo.db = dbContext.db = db;
            for (var i2 = 0; i2 < forages.length; i2++) {
              forages[i2]._dbInfo.db = db;
            }
          })["catch"](function(err) {
            _rejectReadiness(dbInfo, err);
            throw err;
          });
        }
        function createTransaction(dbInfo, mode, callback, retries) {
          if (retries === void 0) {
            retries = 1;
          }
          try {
            var tx = dbInfo.db.transaction(dbInfo.storeName, mode);
            callback(null, tx);
          } catch (err) {
            if (retries > 0 && (!dbInfo.db || err.name === "InvalidStateError" || err.name === "NotFoundError")) {
              return Promise$1.resolve().then(function() {
                if (!dbInfo.db || err.name === "NotFoundError" && !dbInfo.db.objectStoreNames.contains(dbInfo.storeName) && dbInfo.version <= dbInfo.db.version) {
                  if (dbInfo.db) {
                    dbInfo.version = dbInfo.db.version + 1;
                  }
                  return _getUpgradedConnection(dbInfo);
                }
              }).then(function() {
                return _tryReconnect(dbInfo).then(function() {
                  createTransaction(dbInfo, mode, callback, retries - 1);
                });
              })["catch"](callback);
            }
            callback(err);
          }
        }
        function createDbContext() {
          return {
            // Running localForages sharing a database.
            forages: [],
            // Shared database.
            db: null,
            // Database readiness (promise).
            dbReady: null,
            // Deferred operations on the database.
            deferredOperations: []
          };
        }
        function _initStorage(options) {
          var self2 = this;
          var dbInfo = {
            db: null
          };
          if (options) {
            for (var i in options) {
              dbInfo[i] = options[i];
            }
          }
          var dbContext = dbContexts[dbInfo.name];
          if (!dbContext) {
            dbContext = createDbContext();
            dbContexts[dbInfo.name] = dbContext;
          }
          dbContext.forages.push(self2);
          if (!self2._initReady) {
            self2._initReady = self2.ready;
            self2.ready = _fullyReady;
          }
          var initPromises = [];
          function ignoreErrors() {
            return Promise$1.resolve();
          }
          for (var j = 0; j < dbContext.forages.length; j++) {
            var forage = dbContext.forages[j];
            if (forage !== self2) {
              initPromises.push(forage._initReady()["catch"](ignoreErrors));
            }
          }
          var forages = dbContext.forages.slice(0);
          return Promise$1.all(initPromises).then(function() {
            dbInfo.db = dbContext.db;
            return _getOriginalConnection(dbInfo);
          }).then(function(db) {
            dbInfo.db = db;
            if (_isUpgradeNeeded(dbInfo, self2._defaultConfig.version)) {
              return _getUpgradedConnection(dbInfo);
            }
            return db;
          }).then(function(db) {
            dbInfo.db = dbContext.db = db;
            self2._dbInfo = dbInfo;
            for (var k = 0; k < forages.length; k++) {
              var forage2 = forages[k];
              if (forage2 !== self2) {
                forage2._dbInfo.db = dbInfo.db;
                forage2._dbInfo.version = dbInfo.version;
              }
            }
          });
        }
        function getItem(key2, callback) {
          var self2 = this;
          key2 = normalizeKey(key2);
          var promise = new Promise$1(function(resolve, reject) {
            self2.ready().then(function() {
              createTransaction(self2._dbInfo, READ_ONLY, function(err, transaction) {
                if (err) {
                  return reject(err);
                }
                try {
                  var store = transaction.objectStore(self2._dbInfo.storeName);
                  var req = store.get(key2);
                  req.onsuccess = function() {
                    var value = req.result;
                    if (value === void 0) {
                      value = null;
                    }
                    if (_isEncodedBlob(value)) {
                      value = _decodeBlob(value);
                    }
                    resolve(value);
                  };
                  req.onerror = function() {
                    reject(req.error);
                  };
                } catch (e) {
                  reject(e);
                }
              });
            })["catch"](reject);
          });
          executeCallback(promise, callback);
          return promise;
        }
        function iterate(iterator, callback) {
          var self2 = this;
          var promise = new Promise$1(function(resolve, reject) {
            self2.ready().then(function() {
              createTransaction(self2._dbInfo, READ_ONLY, function(err, transaction) {
                if (err) {
                  return reject(err);
                }
                try {
                  var store = transaction.objectStore(self2._dbInfo.storeName);
                  var req = store.openCursor();
                  var iterationNumber = 1;
                  req.onsuccess = function() {
                    var cursor = req.result;
                    if (cursor) {
                      var value = cursor.value;
                      if (_isEncodedBlob(value)) {
                        value = _decodeBlob(value);
                      }
                      var result = iterator(value, cursor.key, iterationNumber++);
                      if (result !== void 0) {
                        resolve(result);
                      } else {
                        cursor["continue"]();
                      }
                    } else {
                      resolve();
                    }
                  };
                  req.onerror = function() {
                    reject(req.error);
                  };
                } catch (e) {
                  reject(e);
                }
              });
            })["catch"](reject);
          });
          executeCallback(promise, callback);
          return promise;
        }
        function setItem(key2, value, callback) {
          var self2 = this;
          key2 = normalizeKey(key2);
          var promise = new Promise$1(function(resolve, reject) {
            var dbInfo;
            self2.ready().then(function() {
              dbInfo = self2._dbInfo;
              if (toString.call(value) === "[object Blob]") {
                return _checkBlobSupport(dbInfo.db).then(function(blobSupport) {
                  if (blobSupport) {
                    return value;
                  }
                  return _encodeBlob(value);
                });
              }
              return value;
            }).then(function(value2) {
              createTransaction(self2._dbInfo, READ_WRITE, function(err, transaction) {
                if (err) {
                  return reject(err);
                }
                try {
                  var store = transaction.objectStore(self2._dbInfo.storeName);
                  if (value2 === null) {
                    value2 = void 0;
                  }
                  var req = store.put(value2, key2);
                  transaction.oncomplete = function() {
                    if (value2 === void 0) {
                      value2 = null;
                    }
                    resolve(value2);
                  };
                  transaction.onabort = transaction.onerror = function() {
                    var err2 = req.error ? req.error : req.transaction.error;
                    reject(err2);
                  };
                } catch (e) {
                  reject(e);
                }
              });
            })["catch"](reject);
          });
          executeCallback(promise, callback);
          return promise;
        }
        function removeItem(key2, callback) {
          var self2 = this;
          key2 = normalizeKey(key2);
          var promise = new Promise$1(function(resolve, reject) {
            self2.ready().then(function() {
              createTransaction(self2._dbInfo, READ_WRITE, function(err, transaction) {
                if (err) {
                  return reject(err);
                }
                try {
                  var store = transaction.objectStore(self2._dbInfo.storeName);
                  var req = store["delete"](key2);
                  transaction.oncomplete = function() {
                    resolve();
                  };
                  transaction.onerror = function() {
                    reject(req.error);
                  };
                  transaction.onabort = function() {
                    var err2 = req.error ? req.error : req.transaction.error;
                    reject(err2);
                  };
                } catch (e) {
                  reject(e);
                }
              });
            })["catch"](reject);
          });
          executeCallback(promise, callback);
          return promise;
        }
        function clear(callback) {
          var self2 = this;
          var promise = new Promise$1(function(resolve, reject) {
            self2.ready().then(function() {
              createTransaction(self2._dbInfo, READ_WRITE, function(err, transaction) {
                if (err) {
                  return reject(err);
                }
                try {
                  var store = transaction.objectStore(self2._dbInfo.storeName);
                  var req = store.clear();
                  transaction.oncomplete = function() {
                    resolve();
                  };
                  transaction.onabort = transaction.onerror = function() {
                    var err2 = req.error ? req.error : req.transaction.error;
                    reject(err2);
                  };
                } catch (e) {
                  reject(e);
                }
              });
            })["catch"](reject);
          });
          executeCallback(promise, callback);
          return promise;
        }
        function length(callback) {
          var self2 = this;
          var promise = new Promise$1(function(resolve, reject) {
            self2.ready().then(function() {
              createTransaction(self2._dbInfo, READ_ONLY, function(err, transaction) {
                if (err) {
                  return reject(err);
                }
                try {
                  var store = transaction.objectStore(self2._dbInfo.storeName);
                  var req = store.count();
                  req.onsuccess = function() {
                    resolve(req.result);
                  };
                  req.onerror = function() {
                    reject(req.error);
                  };
                } catch (e) {
                  reject(e);
                }
              });
            })["catch"](reject);
          });
          executeCallback(promise, callback);
          return promise;
        }
        function key(n, callback) {
          var self2 = this;
          var promise = new Promise$1(function(resolve, reject) {
            if (n < 0) {
              resolve(null);
              return;
            }
            self2.ready().then(function() {
              createTransaction(self2._dbInfo, READ_ONLY, function(err, transaction) {
                if (err) {
                  return reject(err);
                }
                try {
                  var store = transaction.objectStore(self2._dbInfo.storeName);
                  var advanced = false;
                  var req = store.openKeyCursor();
                  req.onsuccess = function() {
                    var cursor = req.result;
                    if (!cursor) {
                      resolve(null);
                      return;
                    }
                    if (n === 0) {
                      resolve(cursor.key);
                    } else {
                      if (!advanced) {
                        advanced = true;
                        cursor.advance(n);
                      } else {
                        resolve(cursor.key);
                      }
                    }
                  };
                  req.onerror = function() {
                    reject(req.error);
                  };
                } catch (e) {
                  reject(e);
                }
              });
            })["catch"](reject);
          });
          executeCallback(promise, callback);
          return promise;
        }
        function keys(callback) {
          var self2 = this;
          var promise = new Promise$1(function(resolve, reject) {
            self2.ready().then(function() {
              createTransaction(self2._dbInfo, READ_ONLY, function(err, transaction) {
                if (err) {
                  return reject(err);
                }
                try {
                  var store = transaction.objectStore(self2._dbInfo.storeName);
                  var req = store.openKeyCursor();
                  var keys2 = [];
                  req.onsuccess = function() {
                    var cursor = req.result;
                    if (!cursor) {
                      resolve(keys2);
                      return;
                    }
                    keys2.push(cursor.key);
                    cursor["continue"]();
                  };
                  req.onerror = function() {
                    reject(req.error);
                  };
                } catch (e) {
                  reject(e);
                }
              });
            })["catch"](reject);
          });
          executeCallback(promise, callback);
          return promise;
        }
        function dropInstance(options, callback) {
          callback = getCallback.apply(this, arguments);
          var currentConfig = this.config();
          options = typeof options !== "function" && options || {};
          if (!options.name) {
            options.name = options.name || currentConfig.name;
            options.storeName = options.storeName || currentConfig.storeName;
          }
          var self2 = this;
          var promise;
          if (!options.name) {
            promise = Promise$1.reject("Invalid arguments");
          } else {
            var isCurrentDb = options.name === currentConfig.name && self2._dbInfo.db;
            var dbPromise = isCurrentDb ? Promise$1.resolve(self2._dbInfo.db) : _getOriginalConnection(options).then(function(db) {
              var dbContext = dbContexts[options.name];
              var forages = dbContext.forages;
              dbContext.db = db;
              for (var i = 0; i < forages.length; i++) {
                forages[i]._dbInfo.db = db;
              }
              return db;
            });
            if (!options.storeName) {
              promise = dbPromise.then(function(db) {
                _deferReadiness(options);
                var dbContext = dbContexts[options.name];
                var forages = dbContext.forages;
                db.close();
                for (var i = 0; i < forages.length; i++) {
                  var forage = forages[i];
                  forage._dbInfo.db = null;
                }
                var dropDBPromise = new Promise$1(function(resolve, reject) {
                  var req = idb.deleteDatabase(options.name);
                  req.onerror = function() {
                    var db2 = req.result;
                    if (db2) {
                      db2.close();
                    }
                    reject(req.error);
                  };
                  req.onblocked = function() {
                    console.warn('dropInstance blocked for database "' + options.name + '" until all open connections are closed');
                  };
                  req.onsuccess = function() {
                    var db2 = req.result;
                    if (db2) {
                      db2.close();
                    }
                    resolve(db2);
                  };
                });
                return dropDBPromise.then(function(db2) {
                  dbContext.db = db2;
                  for (var i2 = 0; i2 < forages.length; i2++) {
                    var _forage = forages[i2];
                    _advanceReadiness(_forage._dbInfo);
                  }
                })["catch"](function(err) {
                  (_rejectReadiness(options, err) || Promise$1.resolve())["catch"](function() {
                  });
                  throw err;
                });
              });
            } else {
              promise = dbPromise.then(function(db) {
                if (!db.objectStoreNames.contains(options.storeName)) {
                  return;
                }
                var newVersion = db.version + 1;
                _deferReadiness(options);
                var dbContext = dbContexts[options.name];
                var forages = dbContext.forages;
                db.close();
                for (var i = 0; i < forages.length; i++) {
                  var forage = forages[i];
                  forage._dbInfo.db = null;
                  forage._dbInfo.version = newVersion;
                }
                var dropObjectPromise = new Promise$1(function(resolve, reject) {
                  var req = idb.open(options.name, newVersion);
                  req.onerror = function(err) {
                    var db2 = req.result;
                    db2.close();
                    reject(err);
                  };
                  req.onupgradeneeded = function() {
                    var db2 = req.result;
                    db2.deleteObjectStore(options.storeName);
                  };
                  req.onsuccess = function() {
                    var db2 = req.result;
                    db2.close();
                    resolve(db2);
                  };
                });
                return dropObjectPromise.then(function(db2) {
                  dbContext.db = db2;
                  for (var j = 0; j < forages.length; j++) {
                    var _forage2 = forages[j];
                    _forage2._dbInfo.db = db2;
                    _advanceReadiness(_forage2._dbInfo);
                  }
                })["catch"](function(err) {
                  (_rejectReadiness(options, err) || Promise$1.resolve())["catch"](function() {
                  });
                  throw err;
                });
              });
            }
          }
          executeCallback(promise, callback);
          return promise;
        }
        var asyncStorage = {
          _driver: "asyncStorage",
          _initStorage,
          _support: isIndexedDBValid(),
          iterate,
          getItem,
          setItem,
          removeItem,
          clear,
          length,
          key,
          keys,
          dropInstance
        };
        function isWebSQLValid() {
          return typeof openDatabase === "function";
        }
        var BASE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        var BLOB_TYPE_PREFIX = "~~local_forage_type~";
        var BLOB_TYPE_PREFIX_REGEX = /^~~local_forage_type~([^~]+)~/;
        var SERIALIZED_MARKER = "__lfsc__:";
        var SERIALIZED_MARKER_LENGTH = SERIALIZED_MARKER.length;
        var TYPE_ARRAYBUFFER = "arbf";
        var TYPE_BLOB = "blob";
        var TYPE_INT8ARRAY = "si08";
        var TYPE_UINT8ARRAY = "ui08";
        var TYPE_UINT8CLAMPEDARRAY = "uic8";
        var TYPE_INT16ARRAY = "si16";
        var TYPE_INT32ARRAY = "si32";
        var TYPE_UINT16ARRAY = "ur16";
        var TYPE_UINT32ARRAY = "ui32";
        var TYPE_FLOAT32ARRAY = "fl32";
        var TYPE_FLOAT64ARRAY = "fl64";
        var TYPE_SERIALIZED_MARKER_LENGTH = SERIALIZED_MARKER_LENGTH + TYPE_ARRAYBUFFER.length;
        var toString$1 = Object.prototype.toString;
        function stringToBuffer(serializedString) {
          var bufferLength = serializedString.length * 0.75;
          var len = serializedString.length;
          var i;
          var p = 0;
          var encoded1, encoded2, encoded3, encoded4;
          if (serializedString[serializedString.length - 1] === "=") {
            bufferLength--;
            if (serializedString[serializedString.length - 2] === "=") {
              bufferLength--;
            }
          }
          var buffer = new ArrayBuffer(bufferLength);
          var bytes = new Uint8Array(buffer);
          for (i = 0; i < len; i += 4) {
            encoded1 = BASE_CHARS.indexOf(serializedString[i]);
            encoded2 = BASE_CHARS.indexOf(serializedString[i + 1]);
            encoded3 = BASE_CHARS.indexOf(serializedString[i + 2]);
            encoded4 = BASE_CHARS.indexOf(serializedString[i + 3]);
            bytes[p++] = encoded1 << 2 | encoded2 >> 4;
            bytes[p++] = (encoded2 & 15) << 4 | encoded3 >> 2;
            bytes[p++] = (encoded3 & 3) << 6 | encoded4 & 63;
          }
          return buffer;
        }
        function bufferToString(buffer) {
          var bytes = new Uint8Array(buffer);
          var base64String = "";
          var i;
          for (i = 0; i < bytes.length; i += 3) {
            base64String += BASE_CHARS[bytes[i] >> 2];
            base64String += BASE_CHARS[(bytes[i] & 3) << 4 | bytes[i + 1] >> 4];
            base64String += BASE_CHARS[(bytes[i + 1] & 15) << 2 | bytes[i + 2] >> 6];
            base64String += BASE_CHARS[bytes[i + 2] & 63];
          }
          if (bytes.length % 3 === 2) {
            base64String = base64String.substring(0, base64String.length - 1) + "=";
          } else if (bytes.length % 3 === 1) {
            base64String = base64String.substring(0, base64String.length - 2) + "==";
          }
          return base64String;
        }
        function serialize(value, callback) {
          var valueType = "";
          if (value) {
            valueType = toString$1.call(value);
          }
          if (value && (valueType === "[object ArrayBuffer]" || value.buffer && toString$1.call(value.buffer) === "[object ArrayBuffer]")) {
            var buffer;
            var marker = SERIALIZED_MARKER;
            if (value instanceof ArrayBuffer) {
              buffer = value;
              marker += TYPE_ARRAYBUFFER;
            } else {
              buffer = value.buffer;
              if (valueType === "[object Int8Array]") {
                marker += TYPE_INT8ARRAY;
              } else if (valueType === "[object Uint8Array]") {
                marker += TYPE_UINT8ARRAY;
              } else if (valueType === "[object Uint8ClampedArray]") {
                marker += TYPE_UINT8CLAMPEDARRAY;
              } else if (valueType === "[object Int16Array]") {
                marker += TYPE_INT16ARRAY;
              } else if (valueType === "[object Uint16Array]") {
                marker += TYPE_UINT16ARRAY;
              } else if (valueType === "[object Int32Array]") {
                marker += TYPE_INT32ARRAY;
              } else if (valueType === "[object Uint32Array]") {
                marker += TYPE_UINT32ARRAY;
              } else if (valueType === "[object Float32Array]") {
                marker += TYPE_FLOAT32ARRAY;
              } else if (valueType === "[object Float64Array]") {
                marker += TYPE_FLOAT64ARRAY;
              } else {
                callback(new Error("Failed to get type for BinaryArray"));
              }
            }
            callback(marker + bufferToString(buffer));
          } else if (valueType === "[object Blob]") {
            var fileReader = new FileReader();
            fileReader.onload = function() {
              var str = BLOB_TYPE_PREFIX + value.type + "~" + bufferToString(this.result);
              callback(SERIALIZED_MARKER + TYPE_BLOB + str);
            };
            fileReader.readAsArrayBuffer(value);
          } else {
            try {
              callback(JSON.stringify(value));
            } catch (e) {
              console.error("Couldn't convert value into a JSON string: ", value);
              callback(null, e);
            }
          }
        }
        function deserialize(value) {
          if (value.substring(0, SERIALIZED_MARKER_LENGTH) !== SERIALIZED_MARKER) {
            return JSON.parse(value);
          }
          var serializedString = value.substring(TYPE_SERIALIZED_MARKER_LENGTH);
          var type = value.substring(SERIALIZED_MARKER_LENGTH, TYPE_SERIALIZED_MARKER_LENGTH);
          var blobType;
          if (type === TYPE_BLOB && BLOB_TYPE_PREFIX_REGEX.test(serializedString)) {
            var matcher = serializedString.match(BLOB_TYPE_PREFIX_REGEX);
            blobType = matcher[1];
            serializedString = serializedString.substring(matcher[0].length);
          }
          var buffer = stringToBuffer(serializedString);
          switch (type) {
            case TYPE_ARRAYBUFFER:
              return buffer;
            case TYPE_BLOB:
              return createBlob([buffer], { type: blobType });
            case TYPE_INT8ARRAY:
              return new Int8Array(buffer);
            case TYPE_UINT8ARRAY:
              return new Uint8Array(buffer);
            case TYPE_UINT8CLAMPEDARRAY:
              return new Uint8ClampedArray(buffer);
            case TYPE_INT16ARRAY:
              return new Int16Array(buffer);
            case TYPE_UINT16ARRAY:
              return new Uint16Array(buffer);
            case TYPE_INT32ARRAY:
              return new Int32Array(buffer);
            case TYPE_UINT32ARRAY:
              return new Uint32Array(buffer);
            case TYPE_FLOAT32ARRAY:
              return new Float32Array(buffer);
            case TYPE_FLOAT64ARRAY:
              return new Float64Array(buffer);
            default:
              throw new Error("Unkown type: " + type);
          }
        }
        var localforageSerializer = {
          serialize,
          deserialize,
          stringToBuffer,
          bufferToString
        };
        function createDbTable(t, dbInfo, callback, errorCallback) {
          t.executeSql("CREATE TABLE IF NOT EXISTS " + dbInfo.storeName + " (id INTEGER PRIMARY KEY, key unique, value)", [], callback, errorCallback);
        }
        function _initStorage$1(options) {
          var self2 = this;
          var dbInfo = {
            db: null
          };
          if (options) {
            for (var i in options) {
              dbInfo[i] = typeof options[i] !== "string" ? options[i].toString() : options[i];
            }
          }
          var dbInfoPromise = new Promise$1(function(resolve, reject) {
            try {
              dbInfo.db = openDatabase(dbInfo.name, String(dbInfo.version), dbInfo.description, dbInfo.size);
            } catch (e) {
              return reject(e);
            }
            dbInfo.db.transaction(function(t) {
              createDbTable(t, dbInfo, function() {
                self2._dbInfo = dbInfo;
                resolve();
              }, function(t2, error) {
                reject(error);
              });
            }, reject);
          });
          dbInfo.serializer = localforageSerializer;
          return dbInfoPromise;
        }
        function tryExecuteSql(t, dbInfo, sqlStatement, args, callback, errorCallback) {
          t.executeSql(sqlStatement, args, callback, function(t2, error) {
            if (error.code === error.SYNTAX_ERR) {
              t2.executeSql("SELECT name FROM sqlite_master WHERE type='table' AND name = ?", [dbInfo.storeName], function(t3, results) {
                if (!results.rows.length) {
                  createDbTable(t3, dbInfo, function() {
                    t3.executeSql(sqlStatement, args, callback, errorCallback);
                  }, errorCallback);
                } else {
                  errorCallback(t3, error);
                }
              }, errorCallback);
            } else {
              errorCallback(t2, error);
            }
          }, errorCallback);
        }
        function getItem$1(key2, callback) {
          var self2 = this;
          key2 = normalizeKey(key2);
          var promise = new Promise$1(function(resolve, reject) {
            self2.ready().then(function() {
              var dbInfo = self2._dbInfo;
              dbInfo.db.transaction(function(t) {
                tryExecuteSql(t, dbInfo, "SELECT * FROM " + dbInfo.storeName + " WHERE key = ? LIMIT 1", [key2], function(t2, results) {
                  var result = results.rows.length ? results.rows.item(0).value : null;
                  if (result) {
                    result = dbInfo.serializer.deserialize(result);
                  }
                  resolve(result);
                }, function(t2, error) {
                  reject(error);
                });
              });
            })["catch"](reject);
          });
          executeCallback(promise, callback);
          return promise;
        }
        function iterate$1(iterator, callback) {
          var self2 = this;
          var promise = new Promise$1(function(resolve, reject) {
            self2.ready().then(function() {
              var dbInfo = self2._dbInfo;
              dbInfo.db.transaction(function(t) {
                tryExecuteSql(t, dbInfo, "SELECT * FROM " + dbInfo.storeName, [], function(t2, results) {
                  var rows = results.rows;
                  var length2 = rows.length;
                  for (var i = 0; i < length2; i++) {
                    var item = rows.item(i);
                    var result = item.value;
                    if (result) {
                      result = dbInfo.serializer.deserialize(result);
                    }
                    result = iterator(result, item.key, i + 1);
                    if (result !== void 0) {
                      resolve(result);
                      return;
                    }
                  }
                  resolve();
                }, function(t2, error) {
                  reject(error);
                });
              });
            })["catch"](reject);
          });
          executeCallback(promise, callback);
          return promise;
        }
        function _setItem(key2, value, callback, retriesLeft) {
          var self2 = this;
          key2 = normalizeKey(key2);
          var promise = new Promise$1(function(resolve, reject) {
            self2.ready().then(function() {
              if (value === void 0) {
                value = null;
              }
              var originalValue = value;
              var dbInfo = self2._dbInfo;
              dbInfo.serializer.serialize(value, function(value2, error) {
                if (error) {
                  reject(error);
                } else {
                  dbInfo.db.transaction(function(t) {
                    tryExecuteSql(t, dbInfo, "INSERT OR REPLACE INTO " + dbInfo.storeName + " (key, value) VALUES (?, ?)", [key2, value2], function() {
                      resolve(originalValue);
                    }, function(t2, error2) {
                      reject(error2);
                    });
                  }, function(sqlError) {
                    if (sqlError.code === sqlError.QUOTA_ERR) {
                      if (retriesLeft > 0) {
                        resolve(_setItem.apply(self2, [key2, originalValue, callback, retriesLeft - 1]));
                        return;
                      }
                      reject(sqlError);
                    }
                  });
                }
              });
            })["catch"](reject);
          });
          executeCallback(promise, callback);
          return promise;
        }
        function setItem$1(key2, value, callback) {
          return _setItem.apply(this, [key2, value, callback, 1]);
        }
        function removeItem$1(key2, callback) {
          var self2 = this;
          key2 = normalizeKey(key2);
          var promise = new Promise$1(function(resolve, reject) {
            self2.ready().then(function() {
              var dbInfo = self2._dbInfo;
              dbInfo.db.transaction(function(t) {
                tryExecuteSql(t, dbInfo, "DELETE FROM " + dbInfo.storeName + " WHERE key = ?", [key2], function() {
                  resolve();
                }, function(t2, error) {
                  reject(error);
                });
              });
            })["catch"](reject);
          });
          executeCallback(promise, callback);
          return promise;
        }
        function clear$1(callback) {
          var self2 = this;
          var promise = new Promise$1(function(resolve, reject) {
            self2.ready().then(function() {
              var dbInfo = self2._dbInfo;
              dbInfo.db.transaction(function(t) {
                tryExecuteSql(t, dbInfo, "DELETE FROM " + dbInfo.storeName, [], function() {
                  resolve();
                }, function(t2, error) {
                  reject(error);
                });
              });
            })["catch"](reject);
          });
          executeCallback(promise, callback);
          return promise;
        }
        function length$1(callback) {
          var self2 = this;
          var promise = new Promise$1(function(resolve, reject) {
            self2.ready().then(function() {
              var dbInfo = self2._dbInfo;
              dbInfo.db.transaction(function(t) {
                tryExecuteSql(t, dbInfo, "SELECT COUNT(key) as c FROM " + dbInfo.storeName, [], function(t2, results) {
                  var result = results.rows.item(0).c;
                  resolve(result);
                }, function(t2, error) {
                  reject(error);
                });
              });
            })["catch"](reject);
          });
          executeCallback(promise, callback);
          return promise;
        }
        function key$1(n, callback) {
          var self2 = this;
          var promise = new Promise$1(function(resolve, reject) {
            self2.ready().then(function() {
              var dbInfo = self2._dbInfo;
              dbInfo.db.transaction(function(t) {
                tryExecuteSql(t, dbInfo, "SELECT key FROM " + dbInfo.storeName + " WHERE id = ? LIMIT 1", [n + 1], function(t2, results) {
                  var result = results.rows.length ? results.rows.item(0).key : null;
                  resolve(result);
                }, function(t2, error) {
                  reject(error);
                });
              });
            })["catch"](reject);
          });
          executeCallback(promise, callback);
          return promise;
        }
        function keys$1(callback) {
          var self2 = this;
          var promise = new Promise$1(function(resolve, reject) {
            self2.ready().then(function() {
              var dbInfo = self2._dbInfo;
              dbInfo.db.transaction(function(t) {
                tryExecuteSql(t, dbInfo, "SELECT key FROM " + dbInfo.storeName, [], function(t2, results) {
                  var keys2 = [];
                  for (var i = 0; i < results.rows.length; i++) {
                    keys2.push(results.rows.item(i).key);
                  }
                  resolve(keys2);
                }, function(t2, error) {
                  reject(error);
                });
              });
            })["catch"](reject);
          });
          executeCallback(promise, callback);
          return promise;
        }
        function getAllStoreNames(db) {
          return new Promise$1(function(resolve, reject) {
            db.transaction(function(t) {
              t.executeSql("SELECT name FROM sqlite_master WHERE type='table' AND name <> '__WebKitDatabaseInfoTable__'", [], function(t2, results) {
                var storeNames = [];
                for (var i = 0; i < results.rows.length; i++) {
                  storeNames.push(results.rows.item(i).name);
                }
                resolve({
                  db,
                  storeNames
                });
              }, function(t2, error) {
                reject(error);
              });
            }, function(sqlError) {
              reject(sqlError);
            });
          });
        }
        function dropInstance$1(options, callback) {
          callback = getCallback.apply(this, arguments);
          var currentConfig = this.config();
          options = typeof options !== "function" && options || {};
          if (!options.name) {
            options.name = options.name || currentConfig.name;
            options.storeName = options.storeName || currentConfig.storeName;
          }
          var self2 = this;
          var promise;
          if (!options.name) {
            promise = Promise$1.reject("Invalid arguments");
          } else {
            promise = new Promise$1(function(resolve) {
              var db;
              if (options.name === currentConfig.name) {
                db = self2._dbInfo.db;
              } else {
                db = openDatabase(options.name, "", "", 0);
              }
              if (!options.storeName) {
                resolve(getAllStoreNames(db));
              } else {
                resolve({
                  db,
                  storeNames: [options.storeName]
                });
              }
            }).then(function(operationInfo) {
              return new Promise$1(function(resolve, reject) {
                operationInfo.db.transaction(function(t) {
                  function dropTable(storeName) {
                    return new Promise$1(function(resolve2, reject2) {
                      t.executeSql("DROP TABLE IF EXISTS " + storeName, [], function() {
                        resolve2();
                      }, function(t2, error) {
                        reject2(error);
                      });
                    });
                  }
                  var operations = [];
                  for (var i = 0, len = operationInfo.storeNames.length; i < len; i++) {
                    operations.push(dropTable(operationInfo.storeNames[i]));
                  }
                  Promise$1.all(operations).then(function() {
                    resolve();
                  })["catch"](function(e) {
                    reject(e);
                  });
                }, function(sqlError) {
                  reject(sqlError);
                });
              });
            });
          }
          executeCallback(promise, callback);
          return promise;
        }
        var webSQLStorage = {
          _driver: "webSQLStorage",
          _initStorage: _initStorage$1,
          _support: isWebSQLValid(),
          iterate: iterate$1,
          getItem: getItem$1,
          setItem: setItem$1,
          removeItem: removeItem$1,
          clear: clear$1,
          length: length$1,
          key: key$1,
          keys: keys$1,
          dropInstance: dropInstance$1
        };
        function isLocalStorageValid() {
          try {
            return typeof localStorage !== "undefined" && "setItem" in localStorage && // in IE8 typeof localStorage.setItem === 'object'
            !!localStorage.setItem;
          } catch (e) {
            return false;
          }
        }
        function _getKeyPrefix(options, defaultConfig) {
          var keyPrefix = options.name + "/";
          if (options.storeName !== defaultConfig.storeName) {
            keyPrefix += options.storeName + "/";
          }
          return keyPrefix;
        }
        function checkIfLocalStorageThrows() {
          var localStorageTestKey = "_localforage_support_test";
          try {
            localStorage.setItem(localStorageTestKey, true);
            localStorage.removeItem(localStorageTestKey);
            return false;
          } catch (e) {
            return true;
          }
        }
        function _isLocalStorageUsable() {
          return !checkIfLocalStorageThrows() || localStorage.length > 0;
        }
        function _initStorage$2(options) {
          var self2 = this;
          var dbInfo = {};
          if (options) {
            for (var i in options) {
              dbInfo[i] = options[i];
            }
          }
          dbInfo.keyPrefix = _getKeyPrefix(options, self2._defaultConfig);
          if (!_isLocalStorageUsable()) {
            return Promise$1.reject();
          }
          self2._dbInfo = dbInfo;
          dbInfo.serializer = localforageSerializer;
          return Promise$1.resolve();
        }
        function clear$2(callback) {
          var self2 = this;
          var promise = self2.ready().then(function() {
            var keyPrefix = self2._dbInfo.keyPrefix;
            for (var i = localStorage.length - 1; i >= 0; i--) {
              var key2 = localStorage.key(i);
              if (key2.indexOf(keyPrefix) === 0) {
                localStorage.removeItem(key2);
              }
            }
          });
          executeCallback(promise, callback);
          return promise;
        }
        function getItem$2(key2, callback) {
          var self2 = this;
          key2 = normalizeKey(key2);
          var promise = self2.ready().then(function() {
            var dbInfo = self2._dbInfo;
            var result = localStorage.getItem(dbInfo.keyPrefix + key2);
            if (result) {
              result = dbInfo.serializer.deserialize(result);
            }
            return result;
          });
          executeCallback(promise, callback);
          return promise;
        }
        function iterate$2(iterator, callback) {
          var self2 = this;
          var promise = self2.ready().then(function() {
            var dbInfo = self2._dbInfo;
            var keyPrefix = dbInfo.keyPrefix;
            var keyPrefixLength = keyPrefix.length;
            var length2 = localStorage.length;
            var iterationNumber = 1;
            for (var i = 0; i < length2; i++) {
              var key2 = localStorage.key(i);
              if (key2.indexOf(keyPrefix) !== 0) {
                continue;
              }
              var value = localStorage.getItem(key2);
              if (value) {
                value = dbInfo.serializer.deserialize(value);
              }
              value = iterator(value, key2.substring(keyPrefixLength), iterationNumber++);
              if (value !== void 0) {
                return value;
              }
            }
          });
          executeCallback(promise, callback);
          return promise;
        }
        function key$2(n, callback) {
          var self2 = this;
          var promise = self2.ready().then(function() {
            var dbInfo = self2._dbInfo;
            var result;
            try {
              result = localStorage.key(n);
            } catch (error) {
              result = null;
            }
            if (result) {
              result = result.substring(dbInfo.keyPrefix.length);
            }
            return result;
          });
          executeCallback(promise, callback);
          return promise;
        }
        function keys$2(callback) {
          var self2 = this;
          var promise = self2.ready().then(function() {
            var dbInfo = self2._dbInfo;
            var length2 = localStorage.length;
            var keys2 = [];
            for (var i = 0; i < length2; i++) {
              var itemKey = localStorage.key(i);
              if (itemKey.indexOf(dbInfo.keyPrefix) === 0) {
                keys2.push(itemKey.substring(dbInfo.keyPrefix.length));
              }
            }
            return keys2;
          });
          executeCallback(promise, callback);
          return promise;
        }
        function length$2(callback) {
          var self2 = this;
          var promise = self2.keys().then(function(keys2) {
            return keys2.length;
          });
          executeCallback(promise, callback);
          return promise;
        }
        function removeItem$2(key2, callback) {
          var self2 = this;
          key2 = normalizeKey(key2);
          var promise = self2.ready().then(function() {
            var dbInfo = self2._dbInfo;
            localStorage.removeItem(dbInfo.keyPrefix + key2);
          });
          executeCallback(promise, callback);
          return promise;
        }
        function setItem$2(key2, value, callback) {
          var self2 = this;
          key2 = normalizeKey(key2);
          var promise = self2.ready().then(function() {
            if (value === void 0) {
              value = null;
            }
            var originalValue = value;
            return new Promise$1(function(resolve, reject) {
              var dbInfo = self2._dbInfo;
              dbInfo.serializer.serialize(value, function(value2, error) {
                if (error) {
                  reject(error);
                } else {
                  try {
                    localStorage.setItem(dbInfo.keyPrefix + key2, value2);
                    resolve(originalValue);
                  } catch (e) {
                    if (e.name === "QuotaExceededError" || e.name === "NS_ERROR_DOM_QUOTA_REACHED") {
                      reject(e);
                    }
                    reject(e);
                  }
                }
              });
            });
          });
          executeCallback(promise, callback);
          return promise;
        }
        function dropInstance$2(options, callback) {
          callback = getCallback.apply(this, arguments);
          options = typeof options !== "function" && options || {};
          if (!options.name) {
            var currentConfig = this.config();
            options.name = options.name || currentConfig.name;
            options.storeName = options.storeName || currentConfig.storeName;
          }
          var self2 = this;
          var promise;
          if (!options.name) {
            promise = Promise$1.reject("Invalid arguments");
          } else {
            promise = new Promise$1(function(resolve) {
              if (!options.storeName) {
                resolve(options.name + "/");
              } else {
                resolve(_getKeyPrefix(options, self2._defaultConfig));
              }
            }).then(function(keyPrefix) {
              for (var i = localStorage.length - 1; i >= 0; i--) {
                var key2 = localStorage.key(i);
                if (key2.indexOf(keyPrefix) === 0) {
                  localStorage.removeItem(key2);
                }
              }
            });
          }
          executeCallback(promise, callback);
          return promise;
        }
        var localStorageWrapper = {
          _driver: "localStorageWrapper",
          _initStorage: _initStorage$2,
          _support: isLocalStorageValid(),
          iterate: iterate$2,
          getItem: getItem$2,
          setItem: setItem$2,
          removeItem: removeItem$2,
          clear: clear$2,
          length: length$2,
          key: key$2,
          keys: keys$2,
          dropInstance: dropInstance$2
        };
        var sameValue = function sameValue2(x, y) {
          return x === y || typeof x === "number" && typeof y === "number" && isNaN(x) && isNaN(y);
        };
        var includes = function includes2(array, searchElement) {
          var len = array.length;
          var i = 0;
          while (i < len) {
            if (sameValue(array[i], searchElement)) {
              return true;
            }
            i++;
          }
          return false;
        };
        var isArray = Array.isArray || function(arg) {
          return Object.prototype.toString.call(arg) === "[object Array]";
        };
        var DefinedDrivers = {};
        var DriverSupport = {};
        var DefaultDrivers = {
          INDEXEDDB: asyncStorage,
          WEBSQL: webSQLStorage,
          LOCALSTORAGE: localStorageWrapper
        };
        var DefaultDriverOrder = [DefaultDrivers.INDEXEDDB._driver, DefaultDrivers.WEBSQL._driver, DefaultDrivers.LOCALSTORAGE._driver];
        var OptionalDriverMethods = ["dropInstance"];
        var LibraryMethods = ["clear", "getItem", "iterate", "key", "keys", "length", "removeItem", "setItem"].concat(OptionalDriverMethods);
        var DefaultConfig = {
          description: "",
          driver: DefaultDriverOrder.slice(),
          name: "localforage",
          // Default DB size is _JUST UNDER_ 5MB, as it's the highest size
          // we can use without a prompt.
          size: 4980736,
          storeName: "keyvaluepairs",
          version: 1
        };
        function callWhenReady(localForageInstance, libraryMethod) {
          localForageInstance[libraryMethod] = function() {
            var _args = arguments;
            return localForageInstance.ready().then(function() {
              return localForageInstance[libraryMethod].apply(localForageInstance, _args);
            });
          };
        }
        function extend() {
          for (var i = 1; i < arguments.length; i++) {
            var arg = arguments[i];
            if (arg) {
              for (var _key in arg) {
                if (arg.hasOwnProperty(_key)) {
                  if (isArray(arg[_key])) {
                    arguments[0][_key] = arg[_key].slice();
                  } else {
                    arguments[0][_key] = arg[_key];
                  }
                }
              }
            }
          }
          return arguments[0];
        }
        var LocalForage = function() {
          function LocalForage2(options) {
            _classCallCheck(this, LocalForage2);
            for (var driverTypeKey in DefaultDrivers) {
              if (DefaultDrivers.hasOwnProperty(driverTypeKey)) {
                var driver = DefaultDrivers[driverTypeKey];
                var driverName = driver._driver;
                this[driverTypeKey] = driverName;
                if (!DefinedDrivers[driverName]) {
                  this.defineDriver(driver);
                }
              }
            }
            this._defaultConfig = extend({}, DefaultConfig);
            this._config = extend({}, this._defaultConfig, options);
            this._driverSet = null;
            this._initDriver = null;
            this._ready = false;
            this._dbInfo = null;
            this._wrapLibraryMethodsWithReady();
            this.setDriver(this._config.driver)["catch"](function() {
            });
          }
          LocalForage2.prototype.config = function config(options) {
            if ((typeof options === "undefined" ? "undefined" : _typeof(options)) === "object") {
              if (this._ready) {
                return new Error("Can't call config() after localforage has been used.");
              }
              for (var i in options) {
                if (i === "storeName") {
                  options[i] = options[i].replace(/\W/g, "_");
                }
                if (i === "version" && typeof options[i] !== "number") {
                  return new Error("Database version must be a number.");
                }
                this._config[i] = options[i];
              }
              if ("driver" in options && options.driver) {
                return this.setDriver(this._config.driver);
              }
              return true;
            } else if (typeof options === "string") {
              return this._config[options];
            } else {
              return this._config;
            }
          };
          LocalForage2.prototype.defineDriver = function defineDriver(driverObject, callback, errorCallback) {
            var promise = new Promise$1(function(resolve, reject) {
              try {
                var driverName = driverObject._driver;
                var complianceError = new Error("Custom driver not compliant; see https://mozilla.github.io/localForage/#definedriver");
                if (!driverObject._driver) {
                  reject(complianceError);
                  return;
                }
                var driverMethods = LibraryMethods.concat("_initStorage");
                for (var i = 0, len = driverMethods.length; i < len; i++) {
                  var driverMethodName = driverMethods[i];
                  var isRequired = !includes(OptionalDriverMethods, driverMethodName);
                  if ((isRequired || driverObject[driverMethodName]) && typeof driverObject[driverMethodName] !== "function") {
                    reject(complianceError);
                    return;
                  }
                }
                var configureMissingMethods = function configureMissingMethods2() {
                  var methodNotImplementedFactory = function methodNotImplementedFactory2(methodName) {
                    return function() {
                      var error = new Error("Method " + methodName + " is not implemented by the current driver");
                      var promise2 = Promise$1.reject(error);
                      executeCallback(promise2, arguments[arguments.length - 1]);
                      return promise2;
                    };
                  };
                  for (var _i = 0, _len = OptionalDriverMethods.length; _i < _len; _i++) {
                    var optionalDriverMethod = OptionalDriverMethods[_i];
                    if (!driverObject[optionalDriverMethod]) {
                      driverObject[optionalDriverMethod] = methodNotImplementedFactory(optionalDriverMethod);
                    }
                  }
                };
                configureMissingMethods();
                var setDriverSupport = function setDriverSupport2(support) {
                  if (DefinedDrivers[driverName]) {
                    console.info("Redefining LocalForage driver: " + driverName);
                  }
                  DefinedDrivers[driverName] = driverObject;
                  DriverSupport[driverName] = support;
                  resolve();
                };
                if ("_support" in driverObject) {
                  if (driverObject._support && typeof driverObject._support === "function") {
                    driverObject._support().then(setDriverSupport, reject);
                  } else {
                    setDriverSupport(!!driverObject._support);
                  }
                } else {
                  setDriverSupport(true);
                }
              } catch (e) {
                reject(e);
              }
            });
            executeTwoCallbacks(promise, callback, errorCallback);
            return promise;
          };
          LocalForage2.prototype.driver = function driver() {
            return this._driver || null;
          };
          LocalForage2.prototype.getDriver = function getDriver(driverName, callback, errorCallback) {
            var getDriverPromise = DefinedDrivers[driverName] ? Promise$1.resolve(DefinedDrivers[driverName]) : Promise$1.reject(new Error("Driver not found."));
            executeTwoCallbacks(getDriverPromise, callback, errorCallback);
            return getDriverPromise;
          };
          LocalForage2.prototype.getSerializer = function getSerializer(callback) {
            var serializerPromise = Promise$1.resolve(localforageSerializer);
            executeTwoCallbacks(serializerPromise, callback);
            return serializerPromise;
          };
          LocalForage2.prototype.ready = function ready(callback) {
            var self2 = this;
            var promise = self2._driverSet.then(function() {
              if (self2._ready === null) {
                self2._ready = self2._initDriver();
              }
              return self2._ready;
            });
            executeTwoCallbacks(promise, callback, callback);
            return promise;
          };
          LocalForage2.prototype.setDriver = function setDriver(drivers, callback, errorCallback) {
            var self2 = this;
            if (!isArray(drivers)) {
              drivers = [drivers];
            }
            var supportedDrivers = this._getSupportedDrivers(drivers);
            function setDriverToConfig() {
              self2._config.driver = self2.driver();
            }
            function extendSelfWithDriver(driver) {
              self2._extend(driver);
              setDriverToConfig();
              self2._ready = self2._initStorage(self2._config);
              return self2._ready;
            }
            function initDriver(supportedDrivers2) {
              return function() {
                var currentDriverIndex = 0;
                function driverPromiseLoop() {
                  while (currentDriverIndex < supportedDrivers2.length) {
                    var driverName = supportedDrivers2[currentDriverIndex];
                    currentDriverIndex++;
                    self2._dbInfo = null;
                    self2._ready = null;
                    return self2.getDriver(driverName).then(extendSelfWithDriver)["catch"](driverPromiseLoop);
                  }
                  setDriverToConfig();
                  var error = new Error("No available storage method found.");
                  self2._driverSet = Promise$1.reject(error);
                  return self2._driverSet;
                }
                return driverPromiseLoop();
              };
            }
            var oldDriverSetDone = this._driverSet !== null ? this._driverSet["catch"](function() {
              return Promise$1.resolve();
            }) : Promise$1.resolve();
            this._driverSet = oldDriverSetDone.then(function() {
              var driverName = supportedDrivers[0];
              self2._dbInfo = null;
              self2._ready = null;
              return self2.getDriver(driverName).then(function(driver) {
                self2._driver = driver._driver;
                setDriverToConfig();
                self2._wrapLibraryMethodsWithReady();
                self2._initDriver = initDriver(supportedDrivers);
              });
            })["catch"](function() {
              setDriverToConfig();
              var error = new Error("No available storage method found.");
              self2._driverSet = Promise$1.reject(error);
              return self2._driverSet;
            });
            executeTwoCallbacks(this._driverSet, callback, errorCallback);
            return this._driverSet;
          };
          LocalForage2.prototype.supports = function supports(driverName) {
            return !!DriverSupport[driverName];
          };
          LocalForage2.prototype._extend = function _extend(libraryMethodsAndProperties) {
            extend(this, libraryMethodsAndProperties);
          };
          LocalForage2.prototype._getSupportedDrivers = function _getSupportedDrivers(drivers) {
            var supportedDrivers = [];
            for (var i = 0, len = drivers.length; i < len; i++) {
              var driverName = drivers[i];
              if (this.supports(driverName)) {
                supportedDrivers.push(driverName);
              }
            }
            return supportedDrivers;
          };
          LocalForage2.prototype._wrapLibraryMethodsWithReady = function _wrapLibraryMethodsWithReady() {
            for (var i = 0, len = LibraryMethods.length; i < len; i++) {
              callWhenReady(this, LibraryMethods[i]);
            }
          };
          LocalForage2.prototype.createInstance = function createInstance(options) {
            return new LocalForage2(options);
          };
          return LocalForage2;
        }();
        var localforage_js = new LocalForage();
        module3.exports = localforage_js;
      }, { "3": 3 }] }, {}, [4])(4);
    });
  }
});

// ../../node_modules/.pnpm/@sentry+integrations@7.120.1/node_modules/@sentry/integrations/cjs/offline.js
var require_offline2 = __commonJS({
  "../../node_modules/.pnpm/@sentry+integrations@7.120.1/node_modules/@sentry/integrations/cjs/offline.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var utils = require_cjs();
    var localForage = require_localforage();
    var debugBuild = require_debug_build5();
    var WINDOW = utils.GLOBAL_OBJ;
    var Offline = class _Offline {
      /**
       * @inheritDoc
       */
      static __initStatic() {
        this.id = "Offline";
      }
      /**
       * @inheritDoc
       */
      /**
       * the current hub instance
       */
      /**
       * maximum number of events to store while offline
       */
      /**
       * event cache
       */
      /**
       * @inheritDoc
       */
      constructor(options = {}) {
        this.name = _Offline.id;
        this.maxStoredEvents = options.maxStoredEvents || 30;
        this.offlineEventStore = localForage.createInstance({
          name: "sentry/offlineEventStore"
        });
      }
      /**
       * @inheritDoc
       */
      setupOnce(addGlobalEventProcessor, getCurrentHub) {
        this.hub = getCurrentHub();
        if ("addEventListener" in WINDOW) {
          WINDOW.addEventListener("online", () => {
            void this._sendEvents().catch(() => {
              debugBuild.DEBUG_BUILD && utils.logger.warn("could not send cached events");
            });
          });
        }
        const eventProcessor = (event) => {
          if (this.hub && this.hub.getIntegration(_Offline)) {
            if ("navigator" in WINDOW && "onLine" in WINDOW.navigator && !WINDOW.navigator.onLine) {
              debugBuild.DEBUG_BUILD && utils.logger.log("Event dropped due to being a offline - caching instead");
              void this._cacheEvent(event).then((_event) => this._enforceMaxEvents()).catch((_error) => {
                debugBuild.DEBUG_BUILD && utils.logger.warn("could not cache event while offline");
              });
              return null;
            }
          }
          return event;
        };
        eventProcessor.id = this.name;
        addGlobalEventProcessor(eventProcessor);
        if ("navigator" in WINDOW && "onLine" in WINDOW.navigator && WINDOW.navigator.onLine) {
          void this._sendEvents().catch(() => {
            debugBuild.DEBUG_BUILD && utils.logger.warn("could not send cached events");
          });
        }
      }
      /**
       * cache an event to send later
       * @param event an event
       */
      async _cacheEvent(event) {
        return this.offlineEventStore.setItem(utils.uuid4(), utils.normalize(event));
      }
      /**
       * purge excess events if necessary
       */
      async _enforceMaxEvents() {
        const events = [];
        return this.offlineEventStore.iterate((event, cacheKey, _index) => {
          events.push({ cacheKey, event });
        }).then(
          () => (
            // this promise resolves when the iteration is finished
            this._purgeEvents(
              // purge all events past maxStoredEvents in reverse chronological order
              events.sort((a, b) => (b.event.timestamp || 0) - (a.event.timestamp || 0)).slice(this.maxStoredEvents < events.length ? this.maxStoredEvents : events.length).map((event) => event.cacheKey)
            )
          )
        ).catch((_error) => {
          debugBuild.DEBUG_BUILD && utils.logger.warn("could not enforce max events");
        });
      }
      /**
       * purge event from cache
       */
      async _purgeEvent(cacheKey) {
        return this.offlineEventStore.removeItem(cacheKey);
      }
      /**
       * purge events from cache
       */
      async _purgeEvents(cacheKeys) {
        return Promise.all(cacheKeys.map((cacheKey) => this._purgeEvent(cacheKey))).then();
      }
      /**
       * send all events
       */
      async _sendEvents() {
        return this.offlineEventStore.iterate((event, cacheKey, _index) => {
          if (this.hub) {
            this.hub.captureEvent(event);
            void this._purgeEvent(cacheKey).catch((_error) => {
              debugBuild.DEBUG_BUILD && utils.logger.warn("could not purge event from cache");
            });
          } else {
            debugBuild.DEBUG_BUILD && utils.logger.warn("no hub found - could not send cached event");
          }
        });
      }
    };
    Offline.__initStatic();
    exports.Offline = Offline;
  }
});

// ../../node_modules/.pnpm/@sentry+integrations@7.120.1/node_modules/@sentry/integrations/cjs/reportingobserver.js
var require_reportingobserver = __commonJS({
  "../../node_modules/.pnpm/@sentry+integrations@7.120.1/node_modules/@sentry/integrations/cjs/reportingobserver.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var core = require_cjs2();
    var utils = require_cjs();
    var WINDOW = utils.GLOBAL_OBJ;
    var INTEGRATION_NAME = "ReportingObserver";
    var SETUP_CLIENTS = /* @__PURE__ */ new WeakMap();
    var _reportingObserverIntegration = (options = {}) => {
      const types = options.types || ["crash", "deprecation", "intervention"];
      function handler(reports) {
        if (!SETUP_CLIENTS.has(core.getClient())) {
          return;
        }
        for (const report of reports) {
          core.withScope((scope) => {
            scope.setExtra("url", report.url);
            const label = `ReportingObserver [${report.type}]`;
            let details = "No details available";
            if (report.body) {
              const plainBody = {};
              for (const prop in report.body) {
                plainBody[prop] = report.body[prop];
              }
              scope.setExtra("body", plainBody);
              if (report.type === "crash") {
                const body = report.body;
                details = [body.crashId || "", body.reason || ""].join(" ").trim() || details;
              } else {
                const body = report.body;
                details = body.message || details;
              }
            }
            core.captureMessage(`${label}: ${details}`);
          });
        }
      }
      return {
        name: INTEGRATION_NAME,
        setupOnce() {
          if (!utils.supportsReportingObserver()) {
            return;
          }
          const observer = new WINDOW.ReportingObserver(handler, {
            buffered: true,
            types
          });
          observer.observe();
        },
        setup(client) {
          SETUP_CLIENTS.set(client, true);
        }
      };
    };
    var reportingObserverIntegration = core.defineIntegration(_reportingObserverIntegration);
    var ReportingObserver = core.convertIntegrationFnToClass(
      INTEGRATION_NAME,
      reportingObserverIntegration
    );
    exports.ReportingObserver = ReportingObserver;
    exports.reportingObserverIntegration = reportingObserverIntegration;
  }
});

// ../../node_modules/.pnpm/@sentry+integrations@7.120.1/node_modules/@sentry/integrations/cjs/rewriteframes.js
var require_rewriteframes = __commonJS({
  "../../node_modules/.pnpm/@sentry+integrations@7.120.1/node_modules/@sentry/integrations/cjs/rewriteframes.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var core = require_cjs2();
    var utils = require_cjs();
    var INTEGRATION_NAME = "RewriteFrames";
    var _rewriteFramesIntegration = (options = {}) => {
      const root = options.root;
      const prefix = options.prefix || "app:///";
      const iteratee = options.iteratee || ((frame) => {
        if (!frame.filename) {
          return frame;
        }
        const isWindowsFrame = /^[a-zA-Z]:\\/.test(frame.filename) || // or the presence of a backslash without a forward slash (which are not allowed on Windows)
        frame.filename.includes("\\") && !frame.filename.includes("/");
        const startsWithSlash = /^\//.test(frame.filename);
        if (isWindowsFrame || startsWithSlash) {
          const filename = isWindowsFrame ? frame.filename.replace(/^[a-zA-Z]:/, "").replace(/\\/g, "/") : frame.filename;
          const base = root ? utils.relative(root, filename) : utils.basename(filename);
          frame.filename = `${prefix}${base}`;
        }
        return frame;
      });
      function _processExceptionsEvent(event) {
        try {
          return {
            ...event,
            exception: {
              ...event.exception,
              // The check for this is performed inside `process` call itself, safe to skip here
              // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
              values: event.exception.values.map((value) => ({
                ...value,
                ...value.stacktrace && { stacktrace: _processStacktrace(value.stacktrace) }
              }))
            }
          };
        } catch (_oO) {
          return event;
        }
      }
      function _processStacktrace(stacktrace) {
        return {
          ...stacktrace,
          frames: stacktrace && stacktrace.frames && stacktrace.frames.map((f) => iteratee(f))
        };
      }
      return {
        name: INTEGRATION_NAME,
        // TODO v8: Remove this
        setupOnce() {
        },
        // eslint-disable-line @typescript-eslint/no-empty-function
        processEvent(originalEvent) {
          let processedEvent = originalEvent;
          if (originalEvent.exception && Array.isArray(originalEvent.exception.values)) {
            processedEvent = _processExceptionsEvent(processedEvent);
          }
          return processedEvent;
        }
      };
    };
    var rewriteFramesIntegration = core.defineIntegration(_rewriteFramesIntegration);
    var RewriteFrames = core.convertIntegrationFnToClass(
      INTEGRATION_NAME,
      rewriteFramesIntegration
    );
    exports.RewriteFrames = RewriteFrames;
    exports.rewriteFramesIntegration = rewriteFramesIntegration;
  }
});

// ../../node_modules/.pnpm/@sentry+integrations@7.120.1/node_modules/@sentry/integrations/cjs/sessiontiming.js
var require_sessiontiming = __commonJS({
  "../../node_modules/.pnpm/@sentry+integrations@7.120.1/node_modules/@sentry/integrations/cjs/sessiontiming.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var core = require_cjs2();
    var INTEGRATION_NAME = "SessionTiming";
    var _sessionTimingIntegration = () => {
      const startTime = Date.now();
      return {
        name: INTEGRATION_NAME,
        // TODO v8: Remove this
        setupOnce() {
        },
        // eslint-disable-line @typescript-eslint/no-empty-function
        processEvent(event) {
          const now = Date.now();
          return {
            ...event,
            extra: {
              ...event.extra,
              ["session:start"]: startTime,
              ["session:duration"]: now - startTime,
              ["session:end"]: now
            }
          };
        }
      };
    };
    var sessionTimingIntegration = core.defineIntegration(_sessionTimingIntegration);
    var SessionTiming = core.convertIntegrationFnToClass(
      INTEGRATION_NAME,
      sessionTimingIntegration
    );
    exports.SessionTiming = SessionTiming;
    exports.sessionTimingIntegration = sessionTimingIntegration;
  }
});

// ../../node_modules/.pnpm/@sentry+integrations@7.120.1/node_modules/@sentry/integrations/cjs/transaction.js
var require_transaction2 = __commonJS({
  "../../node_modules/.pnpm/@sentry+integrations@7.120.1/node_modules/@sentry/integrations/cjs/transaction.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var core = require_cjs2();
    var INTEGRATION_NAME = "Transaction";
    var transactionIntegration = () => {
      return {
        name: INTEGRATION_NAME,
        // TODO v8: Remove this
        setupOnce() {
        },
        // eslint-disable-line @typescript-eslint/no-empty-function
        processEvent(event) {
          const frames = _getFramesFromEvent(event);
          for (let i = frames.length - 1; i >= 0; i--) {
            const frame = frames[i];
            if (frame.in_app === true) {
              event.transaction = _getTransaction(frame);
              break;
            }
          }
          return event;
        }
      };
    };
    var Transaction = core.convertIntegrationFnToClass(INTEGRATION_NAME, transactionIntegration);
    function _getFramesFromEvent(event) {
      const exception = event.exception && event.exception.values && event.exception.values[0];
      return exception && exception.stacktrace && exception.stacktrace.frames || [];
    }
    function _getTransaction(frame) {
      return frame.module || frame.function ? `${frame.module || "?"}/${frame.function || "?"}` : "<unknown>";
    }
    exports.Transaction = Transaction;
  }
});

// ../../node_modules/.pnpm/@sentry+integrations@7.120.1/node_modules/@sentry/integrations/cjs/httpclient.js
var require_httpclient = __commonJS({
  "../../node_modules/.pnpm/@sentry+integrations@7.120.1/node_modules/@sentry/integrations/cjs/httpclient.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var core = require_cjs2();
    var utils = require_cjs();
    var debugBuild = require_debug_build5();
    var INTEGRATION_NAME = "HttpClient";
    var _httpClientIntegration = (options = {}) => {
      const _options = {
        failedRequestStatusCodes: [[500, 599]],
        failedRequestTargets: [/.*/],
        ...options
      };
      return {
        name: INTEGRATION_NAME,
        // TODO v8: Remove this
        setupOnce() {
        },
        // eslint-disable-line @typescript-eslint/no-empty-function
        setup(client) {
          _wrapFetch(client, _options);
          _wrapXHR(client, _options);
        }
      };
    };
    var httpClientIntegration = core.defineIntegration(_httpClientIntegration);
    var HttpClient = core.convertIntegrationFnToClass(INTEGRATION_NAME, httpClientIntegration);
    function _fetchResponseHandler(options, requestInfo, response, requestInit) {
      if (_shouldCaptureResponse(options, response.status, response.url)) {
        const request = _getRequest(requestInfo, requestInit);
        let requestHeaders, responseHeaders, requestCookies, responseCookies;
        if (_shouldSendDefaultPii()) {
          [{ headers: requestHeaders, cookies: requestCookies }, { headers: responseHeaders, cookies: responseCookies }] = [
            { cookieHeader: "Cookie", obj: request },
            { cookieHeader: "Set-Cookie", obj: response }
          ].map(({ cookieHeader, obj }) => {
            const headers = _extractFetchHeaders(obj.headers);
            let cookies;
            try {
              const cookieString = headers[cookieHeader] || headers[cookieHeader.toLowerCase()] || void 0;
              if (cookieString) {
                cookies = _parseCookieString(cookieString);
              }
            } catch (e) {
              debugBuild.DEBUG_BUILD && utils.logger.log(`Could not extract cookies from header ${cookieHeader}`);
            }
            return {
              headers,
              cookies
            };
          });
        }
        const event = _createEvent({
          url: request.url,
          method: request.method,
          status: response.status,
          requestHeaders,
          responseHeaders,
          requestCookies,
          responseCookies
        });
        core.captureEvent(event);
      }
    }
    function _xhrResponseHandler(options, xhr, method, headers) {
      if (_shouldCaptureResponse(options, xhr.status, xhr.responseURL)) {
        let requestHeaders, responseCookies, responseHeaders;
        if (_shouldSendDefaultPii()) {
          try {
            const cookieString = xhr.getResponseHeader("Set-Cookie") || xhr.getResponseHeader("set-cookie") || void 0;
            if (cookieString) {
              responseCookies = _parseCookieString(cookieString);
            }
          } catch (e) {
            debugBuild.DEBUG_BUILD && utils.logger.log("Could not extract cookies from response headers");
          }
          try {
            responseHeaders = _getXHRResponseHeaders(xhr);
          } catch (e) {
            debugBuild.DEBUG_BUILD && utils.logger.log("Could not extract headers from response");
          }
          requestHeaders = headers;
        }
        const event = _createEvent({
          url: xhr.responseURL,
          method,
          status: xhr.status,
          requestHeaders,
          // Can't access request cookies from XHR
          responseHeaders,
          responseCookies
        });
        core.captureEvent(event);
      }
    }
    function _getResponseSizeFromHeaders(headers) {
      if (headers) {
        const contentLength = headers["Content-Length"] || headers["content-length"];
        if (contentLength) {
          return parseInt(contentLength, 10);
        }
      }
      return void 0;
    }
    function _parseCookieString(cookieString) {
      return cookieString.split("; ").reduce((acc, cookie) => {
        const [key, value] = cookie.split("=");
        acc[key] = value;
        return acc;
      }, {});
    }
    function _extractFetchHeaders(headers) {
      const result = {};
      headers.forEach((value, key) => {
        result[key] = value;
      });
      return result;
    }
    function _getXHRResponseHeaders(xhr) {
      const headers = xhr.getAllResponseHeaders();
      if (!headers) {
        return {};
      }
      return headers.split("\r\n").reduce((acc, line) => {
        const [key, value] = line.split(": ");
        acc[key] = value;
        return acc;
      }, {});
    }
    function _isInGivenRequestTargets(failedRequestTargets, target) {
      return failedRequestTargets.some((givenRequestTarget) => {
        if (typeof givenRequestTarget === "string") {
          return target.includes(givenRequestTarget);
        }
        return givenRequestTarget.test(target);
      });
    }
    function _isInGivenStatusRanges(failedRequestStatusCodes, status) {
      return failedRequestStatusCodes.some((range) => {
        if (typeof range === "number") {
          return range === status;
        }
        return status >= range[0] && status <= range[1];
      });
    }
    function _wrapFetch(client, options) {
      if (!utils.supportsNativeFetch()) {
        return;
      }
      utils.addFetchInstrumentationHandler((handlerData) => {
        if (core.getClient() !== client) {
          return;
        }
        const { response, args } = handlerData;
        const [requestInfo, requestInit] = args;
        if (!response) {
          return;
        }
        _fetchResponseHandler(options, requestInfo, response, requestInit);
      });
    }
    function _wrapXHR(client, options) {
      if (!("XMLHttpRequest" in utils.GLOBAL_OBJ)) {
        return;
      }
      utils.addXhrInstrumentationHandler((handlerData) => {
        if (core.getClient() !== client) {
          return;
        }
        const xhr = handlerData.xhr;
        const sentryXhrData = xhr[utils.SENTRY_XHR_DATA_KEY];
        if (!sentryXhrData) {
          return;
        }
        const { method, request_headers: headers } = sentryXhrData;
        try {
          _xhrResponseHandler(options, xhr, method, headers);
        } catch (e) {
          debugBuild.DEBUG_BUILD && utils.logger.warn("Error while extracting response event form XHR response", e);
        }
      });
    }
    function _shouldCaptureResponse(options, status, url) {
      return _isInGivenStatusRanges(options.failedRequestStatusCodes, status) && _isInGivenRequestTargets(options.failedRequestTargets, url) && !core.isSentryRequestUrl(url, core.getClient());
    }
    function _createEvent(data) {
      const message = `HTTP Client Error with status code: ${data.status}`;
      const event = {
        message,
        exception: {
          values: [
            {
              type: "Error",
              value: message
            }
          ]
        },
        request: {
          url: data.url,
          method: data.method,
          headers: data.requestHeaders,
          cookies: data.requestCookies
        },
        contexts: {
          response: {
            status_code: data.status,
            headers: data.responseHeaders,
            cookies: data.responseCookies,
            body_size: _getResponseSizeFromHeaders(data.responseHeaders)
          }
        }
      };
      utils.addExceptionMechanism(event, {
        type: "http.client",
        handled: false
      });
      return event;
    }
    function _getRequest(requestInfo, requestInit) {
      if (!requestInit && requestInfo instanceof Request) {
        return requestInfo;
      }
      if (requestInfo instanceof Request && requestInfo.bodyUsed) {
        return requestInfo;
      }
      return new Request(requestInfo, requestInit);
    }
    function _shouldSendDefaultPii() {
      const client = core.getClient();
      return client ? Boolean(client.getOptions().sendDefaultPii) : false;
    }
    exports.HttpClient = HttpClient;
    exports.httpClientIntegration = httpClientIntegration;
  }
});

// ../../node_modules/.pnpm/@sentry+integrations@7.120.1/node_modules/@sentry/integrations/cjs/contextlines.js
var require_contextlines2 = __commonJS({
  "../../node_modules/.pnpm/@sentry+integrations@7.120.1/node_modules/@sentry/integrations/cjs/contextlines.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var core = require_cjs2();
    var utils = require_cjs();
    var WINDOW = utils.GLOBAL_OBJ;
    var DEFAULT_LINES_OF_CONTEXT = 7;
    var INTEGRATION_NAME = "ContextLines";
    var _contextLinesIntegration = (options = {}) => {
      const contextLines = options.frameContextLines != null ? options.frameContextLines : DEFAULT_LINES_OF_CONTEXT;
      return {
        name: INTEGRATION_NAME,
        // TODO v8: Remove this
        setupOnce() {
        },
        // eslint-disable-line @typescript-eslint/no-empty-function
        processEvent(event) {
          return addSourceContext(event, contextLines);
        }
      };
    };
    var contextLinesIntegration = core.defineIntegration(_contextLinesIntegration);
    var ContextLines = core.convertIntegrationFnToClass(INTEGRATION_NAME, contextLinesIntegration);
    function addSourceContext(event, contextLines) {
      const doc = WINDOW.document;
      const htmlFilename = WINDOW.location && utils.stripUrlQueryAndFragment(WINDOW.location.href);
      if (!doc || !htmlFilename) {
        return event;
      }
      const exceptions = event.exception && event.exception.values;
      if (!exceptions || !exceptions.length) {
        return event;
      }
      const html = doc.documentElement.innerHTML;
      if (!html) {
        return event;
      }
      const htmlLines = ["<!DOCTYPE html>", "<html>", ...html.split("\n"), "</html>"];
      exceptions.forEach((exception) => {
        const stacktrace = exception.stacktrace;
        if (stacktrace && stacktrace.frames) {
          stacktrace.frames = stacktrace.frames.map(
            (frame) => applySourceContextToFrame(frame, htmlLines, htmlFilename, contextLines)
          );
        }
      });
      return event;
    }
    function applySourceContextToFrame(frame, htmlLines, htmlFilename, linesOfContext) {
      if (frame.filename !== htmlFilename || !frame.lineno || !htmlLines.length) {
        return frame;
      }
      utils.addContextToFrame(htmlLines, frame, linesOfContext);
      return frame;
    }
    exports.ContextLines = ContextLines;
    exports.applySourceContextToFrame = applySourceContextToFrame;
    exports.contextLinesIntegration = contextLinesIntegration;
  }
});

// ../../node_modules/.pnpm/@sentry+integrations@7.120.1/node_modules/@sentry/integrations/cjs/index.js
var require_cjs4 = __commonJS({
  "../../node_modules/.pnpm/@sentry+integrations@7.120.1/node_modules/@sentry/integrations/cjs/index.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var captureconsole = require_captureconsole();
    var debug = require_debug();
    var dedupe = require_dedupe();
    var extraerrordata = require_extraerrordata();
    var offline = require_offline2();
    var reportingobserver = require_reportingobserver();
    var rewriteframes = require_rewriteframes();
    var sessiontiming = require_sessiontiming();
    var transaction = require_transaction2();
    var httpclient = require_httpclient();
    var contextlines = require_contextlines2();
    exports.CaptureConsole = captureconsole.CaptureConsole;
    exports.captureConsoleIntegration = captureconsole.captureConsoleIntegration;
    exports.Debug = debug.Debug;
    exports.debugIntegration = debug.debugIntegration;
    exports.Dedupe = dedupe.Dedupe;
    exports.dedupeIntegration = dedupe.dedupeIntegration;
    exports.ExtraErrorData = extraerrordata.ExtraErrorData;
    exports.extraErrorDataIntegration = extraerrordata.extraErrorDataIntegration;
    exports.Offline = offline.Offline;
    exports.ReportingObserver = reportingobserver.ReportingObserver;
    exports.reportingObserverIntegration = reportingobserver.reportingObserverIntegration;
    exports.RewriteFrames = rewriteframes.RewriteFrames;
    exports.rewriteFramesIntegration = rewriteframes.rewriteFramesIntegration;
    exports.SessionTiming = sessiontiming.SessionTiming;
    exports.sessionTimingIntegration = sessiontiming.sessionTimingIntegration;
    exports.Transaction = transaction.Transaction;
    exports.HttpClient = httpclient.HttpClient;
    exports.httpClientIntegration = httpclient.httpClientIntegration;
    exports.ContextLines = contextlines.ContextLines;
    exports.contextLinesIntegration = contextlines.contextLinesIntegration;
  }
});

// ../../node_modules/.pnpm/@sentry+node@7.120.1/node_modules/@sentry/node/cjs/cron/common.js
var require_common2 = __commonJS({
  "../../node_modules/.pnpm/@sentry+node@7.120.1/node_modules/@sentry/node/cjs/cron/common.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var replacements = [
      ["january", "1"],
      ["february", "2"],
      ["march", "3"],
      ["april", "4"],
      ["may", "5"],
      ["june", "6"],
      ["july", "7"],
      ["august", "8"],
      ["september", "9"],
      ["october", "10"],
      ["november", "11"],
      ["december", "12"],
      ["jan", "1"],
      ["feb", "2"],
      ["mar", "3"],
      ["apr", "4"],
      ["may", "5"],
      ["jun", "6"],
      ["jul", "7"],
      ["aug", "8"],
      ["sep", "9"],
      ["oct", "10"],
      ["nov", "11"],
      ["dec", "12"],
      ["sunday", "0"],
      ["monday", "1"],
      ["tuesday", "2"],
      ["wednesday", "3"],
      ["thursday", "4"],
      ["friday", "5"],
      ["saturday", "6"],
      ["sun", "0"],
      ["mon", "1"],
      ["tue", "2"],
      ["wed", "3"],
      ["thu", "4"],
      ["fri", "5"],
      ["sat", "6"]
    ];
    function replaceCronNames(cronExpression) {
      return replacements.reduce(
        // eslint-disable-next-line @sentry-internal/sdk/no-regexp-constructor
        (acc, [name, replacement]) => acc.replace(new RegExp(name, "gi"), replacement),
        cronExpression
      );
    }
    exports.replaceCronNames = replaceCronNames;
  }
});

// ../../node_modules/.pnpm/@sentry+node@7.120.1/node_modules/@sentry/node/cjs/cron/cron.js
var require_cron = __commonJS({
  "../../node_modules/.pnpm/@sentry+node@7.120.1/node_modules/@sentry/node/cjs/cron/cron.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var core = require_cjs2();
    var common = require_common2();
    var ERROR_TEXT = "Automatic instrumentation of CronJob only supports crontab string";
    function instrumentCron(lib, monitorSlug) {
      let jobScheduled = false;
      return new Proxy(lib, {
        construct(target, args) {
          const [cronTime, onTick, onComplete, start, timeZone, ...rest] = args;
          if (typeof cronTime !== "string") {
            throw new Error(ERROR_TEXT);
          }
          if (jobScheduled) {
            throw new Error(`A job named '${monitorSlug}' has already been scheduled`);
          }
          jobScheduled = true;
          const cronString = common.replaceCronNames(cronTime);
          function monitoredTick(context, onComplete2) {
            return core.withMonitor(
              monitorSlug,
              () => {
                return onTick(context, onComplete2);
              },
              {
                schedule: { type: "crontab", value: cronString },
                timezone: timeZone || void 0
              }
            );
          }
          return new target(cronTime, monitoredTick, onComplete, start, timeZone, ...rest);
        },
        get(target, prop) {
          if (prop === "from") {
            return (param) => {
              const { cronTime, onTick, timeZone } = param;
              if (typeof cronTime !== "string") {
                throw new Error(ERROR_TEXT);
              }
              if (jobScheduled) {
                throw new Error(`A job named '${monitorSlug}' has already been scheduled`);
              }
              jobScheduled = true;
              const cronString = common.replaceCronNames(cronTime);
              param.onTick = (context, onComplete) => {
                return core.withMonitor(
                  monitorSlug,
                  () => {
                    return onTick(context, onComplete);
                  },
                  {
                    schedule: { type: "crontab", value: cronString },
                    timezone: timeZone || void 0
                  }
                );
              };
              return target.from(param);
            };
          } else {
            return target[prop];
          }
        }
      });
    }
    exports.instrumentCron = instrumentCron;
  }
});

// ../../node_modules/.pnpm/@sentry+node@7.120.1/node_modules/@sentry/node/cjs/cron/node-cron.js
var require_node_cron = __commonJS({
  "../../node_modules/.pnpm/@sentry+node@7.120.1/node_modules/@sentry/node/cjs/cron/node-cron.js"(exports) {
    var {
      _optionalChain
    } = require_cjs();
    Object.defineProperty(exports, "__esModule", { value: true });
    var core = require_cjs2();
    var common = require_common2();
    function instrumentNodeCron(lib) {
      return new Proxy(lib, {
        get(target, prop) {
          if (prop === "schedule" && target.schedule) {
            return new Proxy(target.schedule, {
              apply(target2, thisArg, argArray) {
                const [expression, , options] = argArray;
                if (!_optionalChain([options, "optionalAccess", (_) => _.name])) {
                  throw new Error('Missing "name" for scheduled job. A name is required for Sentry check-in monitoring.');
                }
                return core.withMonitor(
                  options.name,
                  () => {
                    return target2.apply(thisArg, argArray);
                  },
                  {
                    schedule: { type: "crontab", value: common.replaceCronNames(expression) },
                    timezone: _optionalChain([options, "optionalAccess", (_2) => _2.timezone])
                  }
                );
              }
            });
          } else {
            return target[prop];
          }
        }
      });
    }
    exports.instrumentNodeCron = instrumentNodeCron;
  }
});

// ../../node_modules/.pnpm/@sentry+node@7.120.1/node_modules/@sentry/node/cjs/cron/node-schedule.js
var require_node_schedule = __commonJS({
  "../../node_modules/.pnpm/@sentry+node@7.120.1/node_modules/@sentry/node/cjs/cron/node-schedule.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var core = require_cjs2();
    var common = require_common2();
    function instrumentNodeSchedule(lib) {
      return new Proxy(lib, {
        get(target, prop) {
          if (prop === "scheduleJob") {
            return new Proxy(target.scheduleJob, {
              apply(target2, thisArg, argArray) {
                const [nameOrExpression, expressionOrCallback] = argArray;
                if (typeof nameOrExpression !== "string" || typeof expressionOrCallback !== "string") {
                  throw new Error(
                    "Automatic instrumentation of 'node-schedule' requires the first parameter of 'scheduleJob' to be a job name string and the second parameter to be a crontab string"
                  );
                }
                const monitorSlug = nameOrExpression;
                const expression = expressionOrCallback;
                return core.withMonitor(
                  monitorSlug,
                  () => {
                    return target2.apply(thisArg, argArray);
                  },
                  {
                    schedule: { type: "crontab", value: common.replaceCronNames(expression) }
                  }
                );
              }
            });
          }
          return target[prop];
        }
      });
    }
    exports.instrumentNodeSchedule = instrumentNodeSchedule;
  }
});

// ../../node_modules/.pnpm/@sentry+node@7.120.1/node_modules/@sentry/node/cjs/index.js
var require_cjs5 = __commonJS({
  "../../node_modules/.pnpm/@sentry+node@7.120.1/node_modules/@sentry/node/cjs/index.js"(exports) {
    Object.defineProperty(exports, "__esModule", { value: true });
    var core = require_cjs2();
    var index = require_tracing2();
    var client = require_client();
    var http = require_http();
    var sdk = require_sdk2();
    var utils = require_cjs();
    var utils$1 = require_utils4();
    var module$1 = require_module();
    var legacy = require_legacy();
    var handlers = require_handlers2();
    var index$5 = require_integrations2();
    var integrations$1 = require_integrations3();
    var integrations = require_cjs4();
    var console2 = require_console2();
    var onuncaughtexception = require_onuncaughtexception();
    var onunhandledrejection = require_onunhandledrejection();
    var modules = require_modules();
    var contextlines = require_contextlines();
    var context = require_context();
    var index$1 = require_local_variables();
    var spotlight = require_spotlight();
    var index$2 = require_anr2();
    var index$3 = require_hapi();
    var index$4 = require_undici();
    var http$1 = require_http3();
    var trpc = require_trpc();
    var cron$1 = require_cron();
    var nodeCron = require_node_cron();
    var nodeSchedule = require_node_schedule();
    var getModuleFromFilename = module$1.createGetModuleFromFilename();
    var Integrations = {
      // eslint-disable-next-line deprecation/deprecation
      ...core.Integrations,
      ...index$5,
      ...integrations$1
    };
    var cron = {
      instrumentCron: cron$1.instrumentCron,
      instrumentNodeCron: nodeCron.instrumentNodeCron,
      instrumentNodeSchedule: nodeSchedule.instrumentNodeSchedule
    };
    exports.Hub = core.Hub;
    exports.SDK_VERSION = core.SDK_VERSION;
    exports.SEMANTIC_ATTRIBUTE_SENTRY_OP = core.SEMANTIC_ATTRIBUTE_SENTRY_OP;
    exports.SEMANTIC_ATTRIBUTE_SENTRY_ORIGIN = core.SEMANTIC_ATTRIBUTE_SENTRY_ORIGIN;
    exports.SEMANTIC_ATTRIBUTE_SENTRY_SAMPLE_RATE = core.SEMANTIC_ATTRIBUTE_SENTRY_SAMPLE_RATE;
    exports.SEMANTIC_ATTRIBUTE_SENTRY_SOURCE = core.SEMANTIC_ATTRIBUTE_SENTRY_SOURCE;
    exports.Scope = core.Scope;
    exports.addBreadcrumb = core.addBreadcrumb;
    exports.addEventProcessor = core.addEventProcessor;
    exports.addGlobalEventProcessor = core.addGlobalEventProcessor;
    exports.addIntegration = core.addIntegration;
    exports.captureCheckIn = core.captureCheckIn;
    exports.captureEvent = core.captureEvent;
    exports.captureException = core.captureException;
    exports.captureMessage = core.captureMessage;
    exports.captureSession = core.captureSession;
    exports.close = core.close;
    exports.configureScope = core.configureScope;
    exports.continueTrace = core.continueTrace;
    exports.createTransport = core.createTransport;
    exports.endSession = core.endSession;
    exports.extractTraceparentData = core.extractTraceparentData;
    exports.flush = core.flush;
    exports.functionToStringIntegration = core.functionToStringIntegration;
    exports.getActiveSpan = core.getActiveSpan;
    exports.getActiveTransaction = core.getActiveTransaction;
    exports.getClient = core.getClient;
    exports.getCurrentHub = core.getCurrentHub;
    exports.getCurrentScope = core.getCurrentScope;
    exports.getGlobalScope = core.getGlobalScope;
    exports.getHubFromCarrier = core.getHubFromCarrier;
    exports.getIsolationScope = core.getIsolationScope;
    exports.getSpanStatusFromHttpCode = core.getSpanStatusFromHttpCode;
    exports.inboundFiltersIntegration = core.inboundFiltersIntegration;
    exports.isInitialized = core.isInitialized;
    exports.lastEventId = core.lastEventId;
    exports.linkedErrorsIntegration = core.linkedErrorsIntegration;
    exports.makeMain = core.makeMain;
    exports.metrics = core.metrics;
    exports.parameterize = core.parameterize;
    exports.requestDataIntegration = core.requestDataIntegration;
    exports.runWithAsyncContext = core.runWithAsyncContext;
    exports.setContext = core.setContext;
    exports.setCurrentClient = core.setCurrentClient;
    exports.setExtra = core.setExtra;
    exports.setExtras = core.setExtras;
    exports.setHttpStatus = core.setHttpStatus;
    exports.setMeasurement = core.setMeasurement;
    exports.setTag = core.setTag;
    exports.setTags = core.setTags;
    exports.setUser = core.setUser;
    exports.spanStatusfromHttpCode = core.spanStatusfromHttpCode;
    exports.startActiveSpan = core.startActiveSpan;
    exports.startInactiveSpan = core.startInactiveSpan;
    exports.startSession = core.startSession;
    exports.startSpan = core.startSpan;
    exports.startSpanManual = core.startSpanManual;
    exports.startTransaction = core.startTransaction;
    exports.trace = core.trace;
    exports.withActiveSpan = core.withActiveSpan;
    exports.withIsolationScope = core.withIsolationScope;
    exports.withMonitor = core.withMonitor;
    exports.withScope = core.withScope;
    exports.autoDiscoverNodePerformanceMonitoringIntegrations = index.autoDiscoverNodePerformanceMonitoringIntegrations;
    exports.NodeClient = client.NodeClient;
    exports.makeNodeTransport = http.makeNodeTransport;
    exports.defaultIntegrations = sdk.defaultIntegrations;
    exports.defaultStackParser = sdk.defaultStackParser;
    exports.getDefaultIntegrations = sdk.getDefaultIntegrations;
    exports.getSentryRelease = sdk.getSentryRelease;
    exports.init = sdk.init;
    exports.DEFAULT_USER_INCLUDES = utils.DEFAULT_USER_INCLUDES;
    exports.addRequestDataToEvent = utils.addRequestDataToEvent;
    exports.extractRequestData = utils.extractRequestData;
    exports.deepReadDirSync = utils$1.deepReadDirSync;
    exports.createGetModuleFromFilename = module$1.createGetModuleFromFilename;
    exports.enableAnrDetection = legacy.enableAnrDetection;
    exports.Handlers = handlers;
    exports.captureConsoleIntegration = integrations.captureConsoleIntegration;
    exports.debugIntegration = integrations.debugIntegration;
    exports.dedupeIntegration = integrations.dedupeIntegration;
    exports.extraErrorDataIntegration = integrations.extraErrorDataIntegration;
    exports.httpClientIntegration = integrations.httpClientIntegration;
    exports.reportingObserverIntegration = integrations.reportingObserverIntegration;
    exports.rewriteFramesIntegration = integrations.rewriteFramesIntegration;
    exports.sessionTimingIntegration = integrations.sessionTimingIntegration;
    exports.consoleIntegration = console2.consoleIntegration;
    exports.onUncaughtExceptionIntegration = onuncaughtexception.onUncaughtExceptionIntegration;
    exports.onUnhandledRejectionIntegration = onunhandledrejection.onUnhandledRejectionIntegration;
    exports.modulesIntegration = modules.modulesIntegration;
    exports.contextLinesIntegration = contextlines.contextLinesIntegration;
    exports.nodeContextIntegration = context.nodeContextIntegration;
    exports.localVariablesIntegration = index$1.localVariablesIntegration;
    exports.spotlightIntegration = spotlight.spotlightIntegration;
    exports.anrIntegration = index$2.anrIntegration;
    exports.hapiErrorPlugin = index$3.hapiErrorPlugin;
    exports.hapiIntegration = index$3.hapiIntegration;
    exports.Undici = index$4.Undici;
    exports.nativeNodeFetchintegration = index$4.nativeNodeFetchintegration;
    exports.Http = http$1.Http;
    exports.httpIntegration = http$1.httpIntegration;
    exports.trpcMiddleware = trpc.trpcMiddleware;
    exports.Integrations = Integrations;
    exports.cron = cron;
    exports.getModuleFromFilename = getModuleFromFilename;
  }
});
export default require_cjs5();
/*! Bundled license information:

@sentry/node/cjs/integrations/anr/worker-script.js:
  (*! @sentry/node 7.120.1 (17b8021) | https://github.com/getsentry/sentry-javascript *)

localforage/dist/localforage.js:
  (*!
      localForage -- Offline Storage, Improved
      Version 1.10.0
      https://localforage.github.io/localForage
      (c) 2013-2017 Mozilla, Apache License 2.0
  *)
*/
