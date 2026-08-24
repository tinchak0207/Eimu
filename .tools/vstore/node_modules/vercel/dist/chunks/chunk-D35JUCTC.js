import { createRequire as __createRequire } from 'node:module';
import { fileURLToPath as __fileURLToPath } from 'node:url';
import { dirname as __dirname_ } from 'node:path';
const require = __createRequire(import.meta.url);
const __filename = __fileURLToPath(import.meta.url);
const __dirname = __dirname_(__filename);
import {
  require_semver
} from "./chunk-IB5L4LKZ.js";
import {
  require_execa
} from "./chunk-R6IGDGX3.js";
import {
  VERCEL_CONFIG_EXTENSIONS,
  VERCEL_DIR,
  readJSONFile,
  require_dist3 as require_dist2,
  require_lib,
  require_minimatch,
  require_pluralize
} from "./chunk-KDL2L4KL.js";
import {
  isNativeBinaryInstall
} from "./chunk-CYNB6LL4.js";
import {
  CantParseJSONFile,
  cmd,
  code
} from "./chunk-SOFC4MLS.js";
import {
  pkg_default
} from "./chunk-P4QNYOFB.js";
import {
  output_manager_default,
  require_dist
} from "./chunk-OX7KI3LF.js";
import {
  __commonJS,
  __export,
  __require,
  __toESM
} from "./chunk-TZ2YI2VH.js";

// ../../node_modules/.pnpm/builtins@1.0.3/node_modules/builtins/builtins.json
var require_builtins = __commonJS({
  "../../node_modules/.pnpm/builtins@1.0.3/node_modules/builtins/builtins.json"(exports, module) {
    module.exports = [
      "assert",
      "buffer",
      "child_process",
      "cluster",
      "console",
      "constants",
      "crypto",
      "dgram",
      "dns",
      "domain",
      "events",
      "fs",
      "http",
      "https",
      "module",
      "net",
      "os",
      "path",
      "process",
      "punycode",
      "querystring",
      "readline",
      "repl",
      "stream",
      "string_decoder",
      "timers",
      "tls",
      "tty",
      "url",
      "util",
      "v8",
      "vm",
      "zlib"
    ];
  }
});

// ../../node_modules/.pnpm/validate-npm-package-name@3.0.0/node_modules/validate-npm-package-name/index.js
var require_validate_npm_package_name = __commonJS({
  "../../node_modules/.pnpm/validate-npm-package-name@3.0.0/node_modules/validate-npm-package-name/index.js"(exports, module) {
    "use strict";
    var scopedPackagePattern = new RegExp("^(?:@([^/]+?)[/])?([^/]+?)$");
    var builtins = require_builtins();
    var blacklist = [
      "node_modules",
      "favicon.ico"
    ];
    var validate = module.exports = function(name) {
      var warnings = [];
      var errors = [];
      if (name === null) {
        errors.push("name cannot be null");
        return done(warnings, errors);
      }
      if (name === void 0) {
        errors.push("name cannot be undefined");
        return done(warnings, errors);
      }
      if (typeof name !== "string") {
        errors.push("name must be a string");
        return done(warnings, errors);
      }
      if (!name.length) {
        errors.push("name length must be greater than zero");
      }
      if (name.match(/^\./)) {
        errors.push("name cannot start with a period");
      }
      if (name.match(/^_/)) {
        errors.push("name cannot start with an underscore");
      }
      if (name.trim() !== name) {
        errors.push("name cannot contain leading or trailing spaces");
      }
      blacklist.forEach(function(blacklistedName) {
        if (name.toLowerCase() === blacklistedName) {
          errors.push(blacklistedName + " is a blacklisted name");
        }
      });
      builtins.forEach(function(builtin) {
        if (name.toLowerCase() === builtin) {
          warnings.push(builtin + " is a core module name");
        }
      });
      if (name.length > 214) {
        warnings.push("name can no longer contain more than 214 characters");
      }
      if (name.toLowerCase() !== name) {
        warnings.push("name can no longer contain capital letters");
      }
      if (/[~'!()*]/.test(name.split("/").slice(-1)[0])) {
        warnings.push(`name can no longer contain special characters ("~'!()*")`);
      }
      if (encodeURIComponent(name) !== name) {
        var nameMatch = name.match(scopedPackagePattern);
        if (nameMatch) {
          var user = nameMatch[1];
          var pkg = nameMatch[2];
          if (encodeURIComponent(user) === user && encodeURIComponent(pkg) === pkg) {
            return done(warnings, errors);
          }
        }
        errors.push("name can only contain URL-friendly characters");
      }
      return done(warnings, errors);
    };
    validate.scopedPackagePattern = scopedPackagePattern;
    var done = function(warnings, errors) {
      var result = {
        validForNewPackages: errors.length === 0 && warnings.length === 0,
        validForOldPackages: errors.length === 0,
        warnings,
        errors
      };
      if (!result.warnings.length)
        delete result.warnings;
      if (!result.errors.length)
        delete result.errors;
      return result;
    };
  }
});

// ../../node_modules/.pnpm/hosted-git-info@2.8.9/node_modules/hosted-git-info/git-host-info.js
var require_git_host_info = __commonJS({
  "../../node_modules/.pnpm/hosted-git-info@2.8.9/node_modules/hosted-git-info/git-host-info.js"(exports, module) {
    "use strict";
    var gitHosts = module.exports = {
      github: {
        // First two are insecure and generally shouldn't be used any more, but
        // they are still supported.
        "protocols": ["git", "http", "git+ssh", "git+https", "ssh", "https"],
        "domain": "github.com",
        "treepath": "tree",
        "filetemplate": "https://{auth@}raw.githubusercontent.com/{user}/{project}/{committish}/{path}",
        "bugstemplate": "https://{domain}/{user}/{project}/issues",
        "gittemplate": "git://{auth@}{domain}/{user}/{project}.git{#committish}",
        "tarballtemplate": "https://codeload.{domain}/{user}/{project}/tar.gz/{committish}"
      },
      bitbucket: {
        "protocols": ["git+ssh", "git+https", "ssh", "https"],
        "domain": "bitbucket.org",
        "treepath": "src",
        "tarballtemplate": "https://{domain}/{user}/{project}/get/{committish}.tar.gz"
      },
      gitlab: {
        "protocols": ["git+ssh", "git+https", "ssh", "https"],
        "domain": "gitlab.com",
        "treepath": "tree",
        "bugstemplate": "https://{domain}/{user}/{project}/issues",
        "httpstemplate": "git+https://{auth@}{domain}/{user}/{projectPath}.git{#committish}",
        "tarballtemplate": "https://{domain}/{user}/{project}/repository/archive.tar.gz?ref={committish}",
        "pathmatch": /^[/]([^/]+)[/]((?!.*(\/-\/|\/repository\/archive\.tar\.gz\?=.*|\/repository\/[^/]+\/archive.tar.gz$)).*?)(?:[.]git|[/])?$/
      },
      gist: {
        "protocols": ["git", "git+ssh", "git+https", "ssh", "https"],
        "domain": "gist.github.com",
        "pathmatch": /^[/](?:([^/]+)[/])?([a-z0-9]{32,})(?:[.]git)?$/,
        "filetemplate": "https://gist.githubusercontent.com/{user}/{project}/raw{/committish}/{path}",
        "bugstemplate": "https://{domain}/{project}",
        "gittemplate": "git://{domain}/{project}.git{#committish}",
        "sshtemplate": "git@{domain}:/{project}.git{#committish}",
        "sshurltemplate": "git+ssh://git@{domain}/{project}.git{#committish}",
        "browsetemplate": "https://{domain}/{project}{/committish}",
        "browsefiletemplate": "https://{domain}/{project}{/committish}{#path}",
        "docstemplate": "https://{domain}/{project}{/committish}",
        "httpstemplate": "git+https://{domain}/{project}.git{#committish}",
        "shortcuttemplate": "{type}:{project}{#committish}",
        "pathtemplate": "{project}{#committish}",
        "tarballtemplate": "https://codeload.github.com/gist/{project}/tar.gz/{committish}",
        "hashformat": function(fragment) {
          return "file-" + formatHashFragment(fragment);
        }
      }
    };
    var gitHostDefaults = {
      "sshtemplate": "git@{domain}:{user}/{project}.git{#committish}",
      "sshurltemplate": "git+ssh://git@{domain}/{user}/{project}.git{#committish}",
      "browsetemplate": "https://{domain}/{user}/{project}{/tree/committish}",
      "browsefiletemplate": "https://{domain}/{user}/{project}/{treepath}/{committish}/{path}{#fragment}",
      "docstemplate": "https://{domain}/{user}/{project}{/tree/committish}#readme",
      "httpstemplate": "git+https://{auth@}{domain}/{user}/{project}.git{#committish}",
      "filetemplate": "https://{domain}/{user}/{project}/raw/{committish}/{path}",
      "shortcuttemplate": "{type}:{user}/{project}{#committish}",
      "pathtemplate": "{user}/{project}{#committish}",
      "pathmatch": /^[/]([^/]+)[/]([^/]+?)(?:[.]git|[/])?$/,
      "hashformat": formatHashFragment
    };
    Object.keys(gitHosts).forEach(function(name) {
      Object.keys(gitHostDefaults).forEach(function(key) {
        if (gitHosts[name][key])
          return;
        gitHosts[name][key] = gitHostDefaults[key];
      });
      gitHosts[name].protocols_re = RegExp("^(" + gitHosts[name].protocols.map(function(protocol) {
        return protocol.replace(/([\\+*{}()[\]$^|])/g, "\\$1");
      }).join("|") + "):$");
    });
    function formatHashFragment(fragment) {
      return fragment.toLowerCase().replace(/^\W+|\/|\W+$/g, "").replace(/\W+/g, "-");
    }
  }
});

// ../../node_modules/.pnpm/hosted-git-info@2.8.9/node_modules/hosted-git-info/git-host.js
var require_git_host = __commonJS({
  "../../node_modules/.pnpm/hosted-git-info@2.8.9/node_modules/hosted-git-info/git-host.js"(exports, module) {
    "use strict";
    var gitHosts = require_git_host_info();
    var extend = Object.assign || function _extend(target, source) {
      if (source === null || typeof source !== "object")
        return target;
      var keys = Object.keys(source);
      var i = keys.length;
      while (i--) {
        target[keys[i]] = source[keys[i]];
      }
      return target;
    };
    module.exports = GitHost;
    function GitHost(type, user, auth, project, committish, defaultRepresentation, opts) {
      var gitHostInfo = this;
      gitHostInfo.type = type;
      Object.keys(gitHosts[type]).forEach(function(key) {
        gitHostInfo[key] = gitHosts[type][key];
      });
      gitHostInfo.user = user;
      gitHostInfo.auth = auth;
      gitHostInfo.project = project;
      gitHostInfo.committish = committish;
      gitHostInfo.default = defaultRepresentation;
      gitHostInfo.opts = opts || {};
    }
    GitHost.prototype.hash = function() {
      return this.committish ? "#" + this.committish : "";
    };
    GitHost.prototype._fill = function(template, opts) {
      if (!template)
        return;
      var vars = extend({}, opts);
      vars.path = vars.path ? vars.path.replace(/^[/]+/g, "") : "";
      opts = extend(extend({}, this.opts), opts);
      var self = this;
      Object.keys(this).forEach(function(key) {
        if (self[key] != null && vars[key] == null)
          vars[key] = self[key];
      });
      var rawAuth = vars.auth;
      var rawcommittish = vars.committish;
      var rawFragment = vars.fragment;
      var rawPath = vars.path;
      var rawProject = vars.project;
      Object.keys(vars).forEach(function(key) {
        var value = vars[key];
        if ((key === "path" || key === "project") && typeof value === "string") {
          vars[key] = value.split("/").map(function(pathComponent) {
            return encodeURIComponent(pathComponent);
          }).join("/");
        } else {
          vars[key] = encodeURIComponent(value);
        }
      });
      vars["auth@"] = rawAuth ? rawAuth + "@" : "";
      vars["#fragment"] = rawFragment ? "#" + this.hashformat(rawFragment) : "";
      vars.fragment = vars.fragment ? vars.fragment : "";
      vars["#path"] = rawPath ? "#" + this.hashformat(rawPath) : "";
      vars["/path"] = vars.path ? "/" + vars.path : "";
      vars.projectPath = rawProject.split("/").map(encodeURIComponent).join("/");
      if (opts.noCommittish) {
        vars["#committish"] = "";
        vars["/tree/committish"] = "";
        vars["/committish"] = "";
        vars.committish = "";
      } else {
        vars["#committish"] = rawcommittish ? "#" + rawcommittish : "";
        vars["/tree/committish"] = vars.committish ? "/" + vars.treepath + "/" + vars.committish : "";
        vars["/committish"] = vars.committish ? "/" + vars.committish : "";
        vars.committish = vars.committish || "master";
      }
      var res = template;
      Object.keys(vars).forEach(function(key) {
        res = res.replace(new RegExp("[{]" + key + "[}]", "g"), vars[key]);
      });
      if (opts.noGitPlus) {
        return res.replace(/^git[+]/, "");
      } else {
        return res;
      }
    };
    GitHost.prototype.ssh = function(opts) {
      return this._fill(this.sshtemplate, opts);
    };
    GitHost.prototype.sshurl = function(opts) {
      return this._fill(this.sshurltemplate, opts);
    };
    GitHost.prototype.browse = function(P, F, opts) {
      if (typeof P === "string") {
        if (typeof F !== "string") {
          opts = F;
          F = null;
        }
        return this._fill(this.browsefiletemplate, extend({
          fragment: F,
          path: P
        }, opts));
      } else {
        return this._fill(this.browsetemplate, P);
      }
    };
    GitHost.prototype.docs = function(opts) {
      return this._fill(this.docstemplate, opts);
    };
    GitHost.prototype.bugs = function(opts) {
      return this._fill(this.bugstemplate, opts);
    };
    GitHost.prototype.https = function(opts) {
      return this._fill(this.httpstemplate, opts);
    };
    GitHost.prototype.git = function(opts) {
      return this._fill(this.gittemplate, opts);
    };
    GitHost.prototype.shortcut = function(opts) {
      return this._fill(this.shortcuttemplate, opts);
    };
    GitHost.prototype.path = function(opts) {
      return this._fill(this.pathtemplate, opts);
    };
    GitHost.prototype.tarball = function(opts_) {
      var opts = extend({}, opts_, { noCommittish: false });
      return this._fill(this.tarballtemplate, opts);
    };
    GitHost.prototype.file = function(P, opts) {
      return this._fill(this.filetemplate, extend({ path: P }, opts));
    };
    GitHost.prototype.getDefaultRepresentation = function() {
      return this.default;
    };
    GitHost.prototype.toString = function(opts) {
      if (this.default && typeof this[this.default] === "function")
        return this[this.default](opts);
      return this.sshurl(opts);
    };
  }
});

// ../../node_modules/.pnpm/hosted-git-info@2.8.9/node_modules/hosted-git-info/index.js
var require_hosted_git_info = __commonJS({
  "../../node_modules/.pnpm/hosted-git-info@2.8.9/node_modules/hosted-git-info/index.js"(exports, module) {
    "use strict";
    var url = __require("url");
    var gitHosts = require_git_host_info();
    var GitHost = module.exports = require_git_host();
    var protocolToRepresentationMap = {
      "git+ssh:": "sshurl",
      "git+https:": "https",
      "ssh:": "sshurl",
      "git:": "git"
    };
    function protocolToRepresentation(protocol) {
      return protocolToRepresentationMap[protocol] || protocol.slice(0, -1);
    }
    var authProtocols = {
      "git:": true,
      "https:": true,
      "git+https:": true,
      "http:": true,
      "git+http:": true
    };
    var cache = {};
    module.exports.fromUrl = function(giturl, opts) {
      if (typeof giturl !== "string")
        return;
      var key = giturl + JSON.stringify(opts || {});
      if (!(key in cache)) {
        cache[key] = fromUrl(giturl, opts);
      }
      return cache[key];
    };
    function fromUrl(giturl, opts) {
      if (giturl == null || giturl === "")
        return;
      var url2 = fixupUnqualifiedGist(
        isGitHubShorthand(giturl) ? "github:" + giturl : giturl
      );
      var parsed = parseGitUrl(url2);
      var shortcutMatch = url2.match(/^([^:]+):(?:[^@]+@)?(?:([^/]*)\/)?([^#]+)/);
      var matches = Object.keys(gitHosts).map(function(gitHostName) {
        try {
          var gitHostInfo = gitHosts[gitHostName];
          var auth = null;
          if (parsed.auth && authProtocols[parsed.protocol]) {
            auth = parsed.auth;
          }
          var committish = parsed.hash ? decodeURIComponent(parsed.hash.substr(1)) : null;
          var user = null;
          var project = null;
          var defaultRepresentation = null;
          if (shortcutMatch && shortcutMatch[1] === gitHostName) {
            user = shortcutMatch[2] && decodeURIComponent(shortcutMatch[2]);
            project = decodeURIComponent(shortcutMatch[3].replace(/\.git$/, ""));
            defaultRepresentation = "shortcut";
          } else {
            if (parsed.host && parsed.host !== gitHostInfo.domain && parsed.host.replace(/^www[.]/, "") !== gitHostInfo.domain)
              return;
            if (!gitHostInfo.protocols_re.test(parsed.protocol))
              return;
            if (!parsed.path)
              return;
            var pathmatch = gitHostInfo.pathmatch;
            var matched = parsed.path.match(pathmatch);
            if (!matched)
              return;
            if (matched[1] !== null && matched[1] !== void 0) {
              user = decodeURIComponent(matched[1].replace(/^:/, ""));
            }
            project = decodeURIComponent(matched[2]);
            defaultRepresentation = protocolToRepresentation(parsed.protocol);
          }
          return new GitHost(gitHostName, user, auth, project, committish, defaultRepresentation, opts);
        } catch (ex) {
          if (ex instanceof URIError) {
          } else
            throw ex;
        }
      }).filter(function(gitHostInfo) {
        return gitHostInfo;
      });
      if (matches.length !== 1)
        return;
      return matches[0];
    }
    function isGitHubShorthand(arg) {
      return /^[^:@%/\s.-][^:@%/\s]*[/][^:@\s/%]+(?:#.*)?$/.test(arg);
    }
    function fixupUnqualifiedGist(giturl) {
      var parsed = url.parse(giturl);
      if (parsed.protocol === "gist:" && parsed.host && !parsed.path) {
        return parsed.protocol + "/" + parsed.host;
      } else {
        return giturl;
      }
    }
    function parseGitUrl(giturl) {
      var matched = giturl.match(/^([^@]+)@([^:/]+):[/]?((?:[^/]+[/])?[^/]+?)(?:[.]git)?(#.*)?$/);
      if (!matched) {
        var legacy = url.parse(giturl);
        if (legacy.auth && typeof url.URL === "function") {
          var authmatch = giturl.match(/[^@]+@[^:/]+/);
          if (authmatch) {
            var whatwg = new url.URL(authmatch[0]);
            legacy.auth = whatwg.username || "";
            if (whatwg.password)
              legacy.auth += ":" + whatwg.password;
          }
        }
        return legacy;
      }
      return {
        protocol: "git+ssh:",
        slashes: true,
        auth: matched[1],
        host: matched[2],
        port: null,
        hostname: matched[2],
        hash: matched[4],
        search: null,
        query: null,
        pathname: "/" + matched[3],
        path: "/" + matched[3],
        href: "git+ssh://" + matched[1] + "@" + matched[2] + "/" + matched[3] + (matched[4] || "")
      };
    }
  }
});

// ../../node_modules/.pnpm/os-tmpdir@1.0.2/node_modules/os-tmpdir/index.js
var require_os_tmpdir = __commonJS({
  "../../node_modules/.pnpm/os-tmpdir@1.0.2/node_modules/os-tmpdir/index.js"(exports, module) {
    "use strict";
    var isWindows = process.platform === "win32";
    var trailingSlashRe = isWindows ? /[^:]\\$/ : /.\/$/;
    module.exports = function() {
      var path;
      if (isWindows) {
        path = process.env.TEMP || process.env.TMP || (process.env.SystemRoot || process.env.windir) + "\\temp";
      } else {
        path = process.env.TMPDIR || process.env.TMP || process.env.TEMP || "/tmp";
      }
      if (trailingSlashRe.test(path)) {
        path = path.slice(0, -1);
      }
      return path;
    };
  }
});

// ../../node_modules/.pnpm/os-homedir@1.0.2/node_modules/os-homedir/index.js
var require_os_homedir = __commonJS({
  "../../node_modules/.pnpm/os-homedir@1.0.2/node_modules/os-homedir/index.js"(exports, module) {
    "use strict";
    var os = __require("os");
    function homedir() {
      var env = process.env;
      var home = env.HOME;
      var user = env.LOGNAME || env.USER || env.LNAME || env.USERNAME;
      if (process.platform === "win32") {
        return env.USERPROFILE || env.HOMEDRIVE + env.HOMEPATH || home || null;
      }
      if (process.platform === "darwin") {
        return home || (user ? "/Users/" + user : null);
      }
      if (process.platform === "linux") {
        return home || (process.getuid() === 0 ? "/root" : user ? "/home/" + user : null);
      }
      return home || null;
    }
    module.exports = typeof os.homedir === "function" ? os.homedir : homedir;
  }
});

// ../../node_modules/.pnpm/osenv@0.1.5/node_modules/osenv/osenv.js
var require_osenv = __commonJS({
  "../../node_modules/.pnpm/osenv@0.1.5/node_modules/osenv/osenv.js"(exports) {
    var isWindows = process.platform === "win32";
    var path = __require("path");
    var exec = __require("child_process").exec;
    var osTmpdir = require_os_tmpdir();
    var osHomedir = require_os_homedir();
    function memo(key, lookup, fallback) {
      var fell = false;
      var falling = false;
      exports[key] = function(cb) {
        var val = lookup();
        if (!val && !fell && !falling && fallback) {
          fell = true;
          falling = true;
          exec(fallback, function(er, output, stderr) {
            falling = false;
            if (er)
              return;
            val = output.trim();
          });
        }
        exports[key] = function(cb2) {
          if (cb2)
            process.nextTick(cb2.bind(null, null, val));
          return val;
        };
        if (cb && !falling)
          process.nextTick(cb.bind(null, null, val));
        return val;
      };
    }
    memo("user", function() {
      return isWindows ? process.env.USERDOMAIN + "\\" + process.env.USERNAME : process.env.USER;
    }, "whoami");
    memo("prompt", function() {
      return isWindows ? process.env.PROMPT : process.env.PS1;
    });
    memo("hostname", function() {
      return isWindows ? process.env.COMPUTERNAME : process.env.HOSTNAME;
    }, "hostname");
    memo("tmpdir", function() {
      return osTmpdir();
    });
    memo("home", function() {
      return osHomedir();
    });
    memo("path", function() {
      return (process.env.PATH || process.env.Path || process.env.path).split(isWindows ? ";" : ":");
    });
    memo("editor", function() {
      return process.env.EDITOR || process.env.VISUAL || (isWindows ? "notepad.exe" : "vi");
    });
    memo("shell", function() {
      return isWindows ? process.env.ComSpec || "cmd" : process.env.SHELL || "bash";
    });
  }
});

// ../../node_modules/.pnpm/npm-package-arg@6.1.0/node_modules/npm-package-arg/npa.js
var require_npa = __commonJS({
  "../../node_modules/.pnpm/npm-package-arg@6.1.0/node_modules/npm-package-arg/npa.js"(exports, module) {
    "use strict";
    module.exports = npa;
    module.exports.resolve = resolve;
    module.exports.Result = Result;
    var url;
    var HostedGit;
    var semver;
    var path;
    var validatePackageName;
    var osenv;
    var isWindows = process.platform === "win32" || global.FAKE_WINDOWS;
    var hasSlashes = isWindows ? /\\|[/]/ : /[/]/;
    var isURL = /^(?:git[+])?[a-z]+:/i;
    var isFilename = /[.](?:tgz|tar.gz|tar)$/i;
    function npa(arg, where) {
      let name;
      let spec;
      if (typeof arg === "object") {
        if (arg instanceof Result && (!where || where === arg.where)) {
          return arg;
        } else if (arg.name && arg.rawSpec) {
          return npa.resolve(arg.name, arg.rawSpec, where || arg.where);
        } else {
          return npa(arg.raw, where || arg.where);
        }
      }
      const nameEndsAt = arg[0] === "@" ? arg.slice(1).indexOf("@") + 1 : arg.indexOf("@");
      const namePart = nameEndsAt > 0 ? arg.slice(0, nameEndsAt) : arg;
      if (isURL.test(arg)) {
        spec = arg;
      } else if (namePart[0] !== "@" && (hasSlashes.test(namePart) || isFilename.test(namePart))) {
        spec = arg;
      } else if (nameEndsAt > 0) {
        name = namePart;
        spec = arg.slice(nameEndsAt + 1);
      } else {
        if (!validatePackageName)
          validatePackageName = require_validate_npm_package_name();
        const valid = validatePackageName(arg);
        if (valid.validForOldPackages) {
          name = arg;
        } else {
          spec = arg;
        }
      }
      return resolve(name, spec, where, arg);
    }
    var isFilespec = isWindows ? /^(?:[.]|~[/]|[/\\]|[a-zA-Z]:)/ : /^(?:[.]|~[/]|[/]|[a-zA-Z]:)/;
    function resolve(name, spec, where, arg) {
      const res = new Result({
        raw: arg,
        name,
        rawSpec: spec,
        fromArgument: arg != null
      });
      if (name)
        res.setName(name);
      if (spec && (isFilespec.test(spec) || /^file:/i.test(spec))) {
        return fromFile(res, where);
      } else if (spec && /^npm:/i.test(spec)) {
        return fromAlias(res, where);
      }
      if (!HostedGit)
        HostedGit = require_hosted_git_info();
      const hosted = HostedGit.fromUrl(spec, { noGitPlus: true, noCommittish: true });
      if (hosted) {
        return fromHostedGit(res, hosted);
      } else if (spec && isURL.test(spec)) {
        return fromURL(res);
      } else if (spec && (hasSlashes.test(spec) || isFilename.test(spec))) {
        return fromFile(res, where);
      } else {
        return fromRegistry(res);
      }
    }
    function invalidPackageName(name, valid) {
      const err = new Error(`Invalid package name "${name}": ${valid.errors.join("; ")}`);
      err.code = "EINVALIDPACKAGENAME";
      return err;
    }
    function invalidTagName(name) {
      const err = new Error(`Invalid tag name "${name}": Tags may not have any characters that encodeURIComponent encodes.`);
      err.code = "EINVALIDTAGNAME";
      return err;
    }
    function Result(opts) {
      this.type = opts.type;
      this.registry = opts.registry;
      this.where = opts.where;
      if (opts.raw == null) {
        this.raw = opts.name ? opts.name + "@" + opts.rawSpec : opts.rawSpec;
      } else {
        this.raw = opts.raw;
      }
      this.name = void 0;
      this.escapedName = void 0;
      this.scope = void 0;
      this.rawSpec = opts.rawSpec == null ? "" : opts.rawSpec;
      this.saveSpec = opts.saveSpec;
      this.fetchSpec = opts.fetchSpec;
      if (opts.name)
        this.setName(opts.name);
      this.gitRange = opts.gitRange;
      this.gitCommittish = opts.gitCommittish;
      this.hosted = opts.hosted;
    }
    Result.prototype = {};
    Result.prototype.setName = function(name) {
      if (!validatePackageName)
        validatePackageName = require_validate_npm_package_name();
      const valid = validatePackageName(name);
      if (!valid.validForOldPackages) {
        throw invalidPackageName(name, valid);
      }
      this.name = name;
      this.scope = name[0] === "@" ? name.slice(0, name.indexOf("/")) : void 0;
      this.escapedName = name.replace("/", "%2f");
      return this;
    };
    Result.prototype.toString = function() {
      const full = [];
      if (this.name != null && this.name !== "")
        full.push(this.name);
      const spec = this.saveSpec || this.fetchSpec || this.rawSpec;
      if (spec != null && spec !== "")
        full.push(spec);
      return full.length ? full.join("@") : this.raw;
    };
    Result.prototype.toJSON = function() {
      const result = Object.assign({}, this);
      delete result.hosted;
      return result;
    };
    function setGitCommittish(res, committish) {
      if (committish != null && committish.length >= 7 && committish.slice(0, 7) === "semver:") {
        res.gitRange = decodeURIComponent(committish.slice(7));
        res.gitCommittish = null;
      } else {
        res.gitCommittish = committish === "" ? null : committish;
      }
      return res;
    }
    var isAbsolutePath = /^[/]|^[A-Za-z]:/;
    function resolvePath(where, spec) {
      if (isAbsolutePath.test(spec))
        return spec;
      if (!path)
        path = __require("path");
      return path.resolve(where, spec);
    }
    function isAbsolute(dir) {
      if (dir[0] === "/")
        return true;
      if (/^[A-Za-z]:/.test(dir))
        return true;
      return false;
    }
    function fromFile(res, where) {
      if (!where)
        where = process.cwd();
      res.type = isFilename.test(res.rawSpec) ? "file" : "directory";
      res.where = where;
      const spec = res.rawSpec.replace(/\\/g, "/").replace(/^file:[/]*([A-Za-z]:)/, "$1").replace(/^file:(?:[/]*([~./]))?/, "$1");
      if (/^~[/]/.test(spec)) {
        if (!osenv)
          osenv = require_osenv();
        res.fetchSpec = resolvePath(osenv.home(), spec.slice(2));
        res.saveSpec = "file:" + spec;
      } else {
        res.fetchSpec = resolvePath(where, spec);
        if (isAbsolute(spec)) {
          res.saveSpec = "file:" + spec;
        } else {
          if (!path)
            path = __require("path");
          res.saveSpec = "file:" + path.relative(where, res.fetchSpec);
        }
      }
      return res;
    }
    function fromHostedGit(res, hosted) {
      res.type = "git";
      res.hosted = hosted;
      res.saveSpec = hosted.toString({ noGitPlus: false, noCommittish: false });
      res.fetchSpec = hosted.getDefaultRepresentation() === "shortcut" ? null : hosted.toString();
      return setGitCommittish(res, hosted.committish);
    }
    function unsupportedURLType(protocol, spec) {
      const err = new Error(`Unsupported URL Type "${protocol}": ${spec}`);
      err.code = "EUNSUPPORTEDPROTOCOL";
      return err;
    }
    function matchGitScp(spec) {
      const matched = spec.match(/^git\+ssh:\/\/([^:#]+:[^#]+(?:\.git)?)(?:#(.*))?$/i);
      return matched && !matched[1].match(/:[0-9]+\/?.*$/i) && {
        fetchSpec: matched[1],
        gitCommittish: matched[2] == null ? null : matched[2]
      };
    }
    function fromURL(res) {
      if (!url)
        url = __require("url");
      const urlparse = url.parse(res.rawSpec);
      res.saveSpec = res.rawSpec;
      switch (urlparse.protocol) {
        case "git:":
        case "git+http:":
        case "git+https:":
        case "git+rsync:":
        case "git+ftp:":
        case "git+file:":
        case "git+ssh:":
          res.type = "git";
          const match = urlparse.protocol === "git+ssh:" && matchGitScp(res.rawSpec);
          if (match) {
            setGitCommittish(res, match.gitCommittish);
            res.fetchSpec = match.fetchSpec;
          } else {
            setGitCommittish(res, urlparse.hash != null ? urlparse.hash.slice(1) : "");
            urlparse.protocol = urlparse.protocol.replace(/^git[+]/, "");
            delete urlparse.hash;
            res.fetchSpec = url.format(urlparse);
          }
          break;
        case "http:":
        case "https:":
          res.type = "remote";
          res.fetchSpec = res.saveSpec;
          break;
        default:
          throw unsupportedURLType(urlparse.protocol, res.rawSpec);
      }
      return res;
    }
    function fromAlias(res, where) {
      const subSpec = npa(res.rawSpec.substr(4), where);
      if (subSpec.type === "alias") {
        throw new Error("nested aliases not supported");
      }
      if (!subSpec.registry) {
        throw new Error("aliases only work for registry deps");
      }
      res.subSpec = subSpec;
      res.registry = true;
      res.type = "alias";
      res.saveSpec = null;
      res.fetchSpec = null;
      return res;
    }
    function fromRegistry(res) {
      res.registry = true;
      const spec = res.rawSpec === "" ? "latest" : res.rawSpec;
      res.saveSpec = null;
      res.fetchSpec = spec;
      if (!semver)
        semver = require_semver();
      const version2 = semver.valid(spec, true);
      const range = semver.validRange(spec, true);
      if (version2) {
        res.type = "version";
      } else if (range) {
        res.type = "range";
      } else {
        if (encodeURIComponent(spec) !== spec) {
          throw invalidTagName(spec);
        }
        res.type = "tag";
      }
      return res;
    }
  }
});

// ../../internals/builder-orchestration/dist/import-builders.js
var require_import_builders = __commonJS({
  "../../internals/builder-orchestration/dist/import-builders.js"(exports, module) {
    "use strict";
    var __create = Object.create;
    var __defProp = Object.defineProperty;
    var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
    var __getOwnPropNames = Object.getOwnPropertyNames;
    var __getProtoOf = Object.getPrototypeOf;
    var __hasOwnProp = Object.prototype.hasOwnProperty;
    var __export2 = (target, all) => {
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
    var import_builders_exports = {};
    __export2(import_builders_exports, {
      createImportBuilders: () => createImportBuilders2,
      formatResolvedBuilders: () => formatResolvedBuilders2,
      getBuildersDir: () => getBuildersDir2
    });
    module.exports = __toCommonJS(import_builders_exports);
    var import_npm_package_arg = __toESM2(require_npa());
    var import_semver = require_semver();
    var import_path = __require("path");
    var import_fs_extra = require_lib();
    var import_fs_detectors = require_dist2();
    var import_error_utils = require_dist();
    function isRemoteBuilderPin(pin) {
      return /^https?:\/\//i.test(pin);
    }
    function isBareSpec(parsed) {
      return parsed.type === "tag" && parsed.rawSpec === "";
    }
    function formatResolvedBuilders2(builders) {
      return Array.from(
        builders.values(),
        (b) => b.pkgPath ? `${b.pkg.name}@${b.pkg.version}=${(0, import_path.dirname)(b.pkgPath)}` : `${b.pkg.name}=built-in`
      ).join(",");
    }
    function pinBuilderSpecs(specs, pins) {
      const pinnedSpecs = /* @__PURE__ */ new Map();
      for (const spec of specs) {
        const parsed = (0, import_npm_package_arg.default)(spec);
        if (parsed.name && isBareSpec(parsed)) {
          const version2 = pins.get(parsed.name);
          if (version2) {
            pinnedSpecs.set(
              spec,
              isRemoteBuilderPin(version2) ? version2 : `${parsed.name}@${version2}`
            );
          }
        }
      }
      return pinnedSpecs;
    }
    function getBuildersDir2(cwd, vercelDir = ".vercel") {
      const override = process.env.VERCEL_BUILDERS_DIR;
      if (override) {
        return (0, import_path.isAbsolute)(override) ? override : (0, import_path.resolve)(cwd, override);
      }
      return (0, import_path.join)(cwd, vercelDir, "builders");
    }
    function createImportBuilders2(dependencies) {
      const {
        debug,
        installBuilders: installBuilders2,
        isNativeBinaryInstall: isNativeBinaryInstall2,
        require: require2,
        staticBuilder,
        vercelDir
      } = dependencies;
      const builderPins = /* @__PURE__ */ new Map();
      for (const [name, version2] of Object.entries(dependencies.builderPins)) {
        if ((0, import_semver.validRange)(version2) || isRemoteBuilderPin(version2)) {
          builderPins.set(name, version2);
        }
      }
      const resolveDependencies = {
        builderPins,
        debug,
        isNativeBinaryInstall: isNativeBinaryInstall2,
        require: require2,
        staticBuilder
      };
      return async function importBuilders2(builderSpecs, cwd, span) {
        const buildersDir = getBuildersDir2(cwd, vercelDir);
        let importResult = await resolveBuilders(
          buildersDir,
          builderSpecs,
          resolveDependencies
        );
        if ("buildersToAdd" in importResult) {
          const { buildersToAdd, installReasons } = importResult;
          const pinnedSpecs = pinBuilderSpecs(buildersToAdd, builderPins);
          const installResult = await installBuilders2(
            buildersDir,
            new Set(
              Array.from(buildersToAdd, (spec) => pinnedSpecs.get(spec) ?? spec)
            ),
            span,
            installReasons,
            pinnedSpecs
          );
          const allowedPinDriftSpecs = new Set(
            Array.from(pinnedSpecs.keys()).filter((spec) => installResult.has(spec))
          );
          importResult = await resolveBuilders(
            buildersDir,
            builderSpecs,
            resolveDependencies,
            installResult,
            allowedPinDriftSpecs
          );
          if ("buildersToAdd" in importResult) {
            const { buildersToAdd: failed, installReasons: reasons } = importResult;
            const failures = Array.from(failed, (spec) => {
              const reason = reasons.get(spec);
              return reason ? `${spec} (${reason})` : spec;
            });
            const err = new Error(
              `Failed to load Builders after installing them: ${failures.join(
                ", "
              )}. Retry the build. If the failure persists, contact Vercel Support.`
            );
            Object.assign(err, {
              link: "https://vercel.link/builder-dependencies-install-failed"
            });
            throw err;
          }
        }
        const resolvedBuildersDebug = [];
        for (const [spec, builderSpec] of importResult.builders) {
          resolvedBuildersDebug.push(`${spec} => ${builderSpec.pkg.version}`);
        }
        debug(`Resolved builders: "${resolvedBuildersDebug.join(", ")}"`);
        return importResult.builders;
      };
    }
    function missingModuleId(err) {
      const match = /Cannot find module '([^']+)'/.exec(err.message);
      const id = match?.[1];
      if (!id) {
        return void 0;
      }
      if (id.startsWith("/") || id.startsWith(".") || /^[A-Za-z]:[\\/]/.test(id)) {
        return void 0;
      }
      return id.replace(/[,=]/g, "_").slice(0, 100);
    }
    async function resolveBuilders(buildersDir, builderSpecs, dependencies, resolvedSpecs, allowedPinDriftSpecs) {
      const builders = /* @__PURE__ */ new Map();
      const buildersToAdd = /* @__PURE__ */ new Set();
      const installReasons = /* @__PURE__ */ new Map();
      for (const spec of builderSpecs) {
        const resolvedSpec = resolvedSpecs?.get(spec) || spec;
        const parsed = (0, import_npm_package_arg.default)(resolvedSpec);
        const { name } = parsed;
        if (!name) {
          buildersToAdd.add(spec);
          installReasons.set(spec, "url-spec");
          continue;
        }
        if ((0, import_fs_detectors.isStaticRuntime)(name)) {
          builders.set(name, {
            builder: dependencies.staticBuilder,
            pkg: { name },
            path: "",
            pkgPath: "",
            dynamicallyInstalled: false
          });
          continue;
        }
        let entrypointLoadFailed = false;
        try {
          let pkgPath;
          let builderPkg;
          try {
            pkgPath = (0, import_path.join)(buildersDir, "node_modules", name, "package.json");
            builderPkg = await (0, import_fs_extra.readJSON)(pkgPath);
          } catch (error) {
            if (!(0, import_error_utils.isErrnoException)(error)) {
              throw error;
            }
            if (error.code !== "ENOENT") {
              throw error;
            }
            if (dependencies.isNativeBinaryInstall()) {
              buildersToAdd.add(spec);
              installReasons.set(spec, "not-installed");
              continue;
            }
            pkgPath = dependencies.require.resolve(`${name}/package.json`);
            builderPkg = await (0, import_fs_extra.readJSON)(pkgPath);
          }
          if (!builderPkg || !pkgPath) {
            throw new Error(`Failed to load \`package.json\` for "${name}"`);
          }
          if (typeof builderPkg.version !== "string") {
            throw new Error(
              `\`package.json\` for "${name}" does not contain a "version" field`
            );
          }
          const peerVersion = dependencies.builderPins.get(name);
          if (isBareSpec(parsed) && peerVersion && (0, import_semver.valid)(peerVersion) && builderPkg.version !== peerVersion && !allowedPinDriftSpecs?.has(spec)) {
            dependencies.debug(
              `Resolved "${name}@${builderPkg.version}" does not match pin "${peerVersion}"`
            );
            buildersToAdd.add(spec);
            installReasons.set(spec, "pin-version-mismatch");
            continue;
          }
          if (isBareSpec(parsed) && peerVersion && isRemoteBuilderPin(peerVersion) && pkgPath.startsWith(buildersDir)) {
            let installedSpec;
            try {
              const buildersPkg = await (0, import_fs_extra.readJSON)((0, import_path.join)(buildersDir, "package.json"));
              installedSpec = buildersPkg.dependencies?.[name];
            } catch (error) {
              if (!(0, import_error_utils.isErrnoException)(error) || error.code !== "ENOENT") {
                throw error;
              }
            }
            if (installedSpec !== peerVersion) {
              dependencies.debug(
                `Installed source for "${name}@${builderPkg.version}" is "${installedSpec ?? "unknown"}", not pin "${peerVersion}"`
              );
              buildersToAdd.add(spec);
              installReasons.set(spec, "preview-pack-mismatch");
              continue;
            }
          }
          if (parsed.type === "version" && parsed.rawSpec !== builderPkg.version) {
            dependencies.debug(
              `Installed version "${name}@${builderPkg.version}" does not match "${parsed.rawSpec}"`
            );
            buildersToAdd.add(spec);
            installReasons.set(spec, "version-mismatch");
            continue;
          }
          if (parsed.type === "range" && !(0, import_semver.satisfies)(builderPkg.version, parsed.rawSpec)) {
            dependencies.debug(
              `Installed version "${name}@${builderPkg.version}" is not compatible with "${parsed.rawSpec}"`
            );
            buildersToAdd.add(spec);
            installReasons.set(spec, "range-mismatch");
            continue;
          }
          const path = (0, import_path.join)((0, import_path.dirname)(pkgPath), builderPkg.main || "index.js");
          let builder;
          try {
            builder = dependencies.require(path);
          } catch (requireErr) {
            entrypointLoadFailed = true;
            throw requireErr;
          }
          const dynamicallyInstalled = pkgPath.startsWith(buildersDir);
          builders.set(spec, {
            builder,
            pkg: {
              name,
              ...builderPkg
            },
            path,
            pkgPath,
            dynamicallyInstalled
          });
          dependencies.debug(
            `Imported Builder "${name}" from "${(0, import_path.dirname)(pkgPath)}"`
          );
        } catch (error) {
          if (!(error instanceof Error)) {
            throw error;
          }
          const err = error;
          if ((err.code === "MODULE_NOT_FOUND" || err.code === "ENOENT") && !resolvedSpecs) {
            dependencies.debug(`Failed to import "${name}": ${err}`);
            buildersToAdd.add(spec);
            if (entrypointLoadFailed) {
              const missing = missingModuleId(err);
              installReasons.set(
                spec,
                missing ? `entrypoint-load-failed:${missing}` : "entrypoint-load-failed"
              );
            } else {
              installReasons.set(spec, "not-installed");
            }
          } else {
            err.message = `Importing "${name}": ${err.message}`;
            throw err;
          }
        }
      }
      if (buildersToAdd.size > 0) {
        return { buildersToAdd, installReasons };
      }
      return { builders };
    }
  }
});

// ../../internals/builder-orchestration/dist/static-builder.js
var require_static_builder = __commonJS({
  "../../internals/builder-orchestration/dist/static-builder.js"(exports, module) {
    "use strict";
    var __create = Object.create;
    var __defProp = Object.defineProperty;
    var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
    var __getOwnPropNames = Object.getOwnPropertyNames;
    var __getProtoOf = Object.getPrototypeOf;
    var __hasOwnProp = Object.prototype.hasOwnProperty;
    var __export2 = (target, all) => {
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
    var static_builder_exports2 = {};
    __export2(static_builder_exports2, {
      createStaticBuilder: () => createStaticBuilder2,
      version: () => version2
    });
    module.exports = __toCommonJS(static_builder_exports2);
    var import_minimatch = __toESM2(require_minimatch());
    var import_build_utils = __require("@vercel/build-utils");
    var version2 = 2;
    var ALWAYS_EXCLUDED_PREFIXES = [".git/", "node_modules/"];
    var DEFAULT_EXCLUDED_FILES = [
      ".gitignore",
      "package.json",
      "package-lock.json",
      "yarn.lock",
      "pnpm-lock.yaml",
      "bun.lock",
      "bun.lockb",
      "README.md"
    ];
    function createStaticBuilder2(vercelConfigExtensions) {
      const alwaysExcludedFiles = [
        "vercel.json",
        "vercel.toml",
        ...vercelConfigExtensions.map((ext) => `vercel.${ext}`),
        ".vercelignore",
        "now.json",
        ".nowignore"
      ];
      const build2 = async ({ entrypoint, files, config }) => {
        const output = {};
        const outputDirectory = config.zeroConfig ? config.outputDirectory : "";
        for (let [filename, fileFsRef] of Object.entries(files)) {
          if (ALWAYS_EXCLUDED_PREFIXES.some((prefix) => filename.startsWith(prefix)) || alwaysExcludedFiles.includes(filename) || DEFAULT_EXCLUDED_FILES.includes(filename) || filename.startsWith(".env")) {
            continue;
          }
          if (entrypoint && !(entrypoint === filename || (0, import_minimatch.default)(filename, entrypoint, { dot: true }))) {
            continue;
          }
          if (outputDirectory) {
            const outputMatch = outputDirectory + "/";
            if (filename.startsWith(outputMatch)) {
              filename = filename.slice(outputMatch.length);
            }
          }
          output[filename] = fileFsRef;
        }
        return { output };
      };
      const shouldServe2 = (_opts) => {
        const opts = { ..._opts };
        const {
          config: { zeroConfig, outputDirectory }
        } = opts;
        if (zeroConfig && outputDirectory) {
          opts.entrypoint = `${outputDirectory}/${opts.entrypoint}`;
          opts.requestPath = `${outputDirectory}/${opts.requestPath}`;
        }
        return (0, import_build_utils.shouldServe)(opts);
      };
      return { version: version2, build: build2, shouldServe: shouldServe2 };
    }
  }
});

// ../../internals/builder-orchestration/dist/install-builders.js
var require_install_builders = __commonJS({
  "../../internals/builder-orchestration/dist/install-builders.js"(exports, module) {
    "use strict";
    var __create = Object.create;
    var __defProp = Object.defineProperty;
    var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
    var __getOwnPropNames = Object.getOwnPropertyNames;
    var __getProtoOf = Object.getPrototypeOf;
    var __hasOwnProp = Object.prototype.hasOwnProperty;
    var __export2 = (target, all) => {
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
    var install_builders_exports = {};
    __export2(install_builders_exports, {
      createInstallBuilders: () => createInstallBuilders2
    });
    module.exports = __toCommonJS(install_builders_exports);
    var import_url = __require("url");
    var import_pluralize = __toESM2(require_pluralize());
    var import_path = __require("path");
    var import_semver = require_semver();
    var import_fs_extra = require_lib();
    var import_error_utils = require_dist();
    function getErrorMessage(err, execaMessage) {
      if (!err || !("stderr" in err)) {
        return execaMessage;
      }
      if (typeof err.stderr === "string") {
        return err.stderr;
      }
      return execaMessage;
    }
    async function untracedInstallBuilders(buildersDir, buildersToAdd, dependencies) {
      const { buildUtilsVersion, code: code2, cmd: cmd2, output, readJSONFile: readJSONFile2, run } = dependencies;
      const resolvedSpecs = /* @__PURE__ */ new Map();
      const buildersPkgPath = (0, import_path.join)(buildersDir, "package.json");
      try {
        const emptyPkgJson = {
          private: true,
          license: "UNLICENSED"
        };
        await (0, import_fs_extra.outputJSON)(buildersPkgPath, emptyPkgJson, {
          flag: "wx"
        });
      } catch (error) {
        if (!(0, import_error_utils.isErrnoException)(error) || error.code !== "EEXIST")
          throw error;
      }
      output.log(
        `Installing ${(0, import_pluralize.default)("Builder", buildersToAdd.size)}: ${Array.from(
          buildersToAdd
        ).join(", ")}`
      );
      const buildUtilsSpec = buildUtilsVersion && (0, import_semver.validRange)(buildUtilsVersion) ? `@vercel/build-utils@${buildUtilsVersion}` : "@vercel/build-utils";
      const installArgs = ["install", buildUtilsSpec, ...buildersToAdd];
      try {
        const { stderr } = await run("npm", installArgs, {
          cwd: buildersDir,
          stdio: "pipe",
          reject: true
        });
        stderr.split("/\r?\n/").filter((line) => line.includes("npm WARN deprecated")).forEach((line) => {
          output.warn(line);
        });
      } catch (err) {
        if ((0, import_error_utils.isError)(err)) {
          const execaMessage = err.message;
          let message = getErrorMessage(err, execaMessage);
          if (execaMessage.startsWith("Command failed with ENOENT")) {
            message = `Please install ${cmd2("npm")} before continuing`;
          } else {
            const notFound = /GET (.*) - Not found/.exec(message);
            const notFoundUrl = notFound?.[1];
            if (notFoundUrl) {
              const url = new import_url.URL(notFoundUrl);
              const packagePath = decodeURIComponent(url.pathname);
              const packageName = /(@[^/]+\/[^/]+)$/.exec(packagePath)?.[1] ?? packagePath.split("/").filter(Boolean).at(-1) ?? packagePath;
              message = `The package ${code2(
                packageName
              )} is not published on the npm registry`;
            }
          }
          err.message = message;
          Object.assign(err, {
            link: "https://vercel.link/builder-dependencies-install-failed"
          });
        }
        throw err;
      }
      const nowScopePath = (0, import_path.join)(buildersDir, "node_modules/@now");
      await (0, import_fs_extra.mkdirp)(nowScopePath);
      try {
        await (0, import_fs_extra.symlink)("../@vercel/build-utils", (0, import_path.join)(nowScopePath, "build-utils"));
      } catch (err) {
        if (!(0, import_error_utils.isErrnoException)(err) || err.code !== "EEXIST") {
          throw err;
        }
      }
      const buildersPkg = await readJSONFile2(buildersPkgPath);
      if (dependencies.isCantParseJSONFile(buildersPkg))
        throw buildersPkg;
      if (!buildersPkg) {
        throw new Error(`Failed to load "${buildersPkgPath}"`);
      }
      for (const spec of buildersToAdd) {
        for (const [name, version2] of Object.entries(
          buildersPkg.dependencies || {}
        )) {
          if (version2 === spec) {
            output.debug(`Resolved Builder spec "${spec}" to name "${name}"`);
            resolvedSpecs.set(spec, name);
          }
        }
      }
      return resolvedSpecs;
    }
    function createInstallBuilders2(dependencies) {
      const { output } = dependencies;
      return async function installBuilders2(buildersDir, buildersToAdd, span, installReasons, pinnedSpecs) {
        const install = async () => {
          try {
            return await untracedInstallBuilders(
              buildersDir,
              buildersToAdd,
              dependencies
            );
          } catch (err) {
            if (!pinnedSpecs?.size) {
              throw err;
            }
            const fallbackSpecs = new Set(
              Array.from(buildersToAdd, (spec) => {
                for (const [originalSpec, pinnedSpec] of pinnedSpecs) {
                  if (pinnedSpec === spec) {
                    return originalSpec;
                  }
                }
                return spec;
              })
            );
            output.warn(
              "Could not install the Builder versions pinned by this Vercel CLI release. Retrying with versions allowed by your npm settings."
            );
            const resolvedSpecs = await untracedInstallBuilders(
              buildersDir,
              fallbackSpecs,
              dependencies
            );
            for (const originalSpec of pinnedSpecs.keys()) {
              if (fallbackSpecs.has(originalSpec)) {
                resolvedSpecs.set(originalSpec, originalSpec);
              }
            }
            return resolvedSpecs;
          }
        };
        if (!span) {
          return install();
        }
        const attributes = {
          packages: Array.from(buildersToAdd).join(",")
        };
        if (installReasons && installReasons.size > 0) {
          attributes.reasons = Array.from(installReasons).map(([spec, reason]) => `${spec}=${reason}`).join(",");
        }
        if (pinnedSpecs && pinnedSpecs.size > 0) {
          attributes.pinned = "true";
          attributes.pinnedPackages = Array.from(pinnedSpecs.values()).join(",");
        }
        const installSpan = span.child("vc.installBuilders", attributes);
        return installSpan.trace(async (s) => {
          try {
            return await install();
          } catch (err) {
            s.setAttributes({
              error: (0, import_error_utils.isError)(err) ? err.message : String(err)
            });
            throw err;
          }
        });
      };
    }
  }
});

// src/builders/import-builders.ts
var import_import_builders = __toESM(require_import_builders(), 1);

// src/builders/static-builder.ts
var static_builder_exports = {};
__export(static_builder_exports, {
  build: () => build,
  shouldServe: () => shouldServe,
  version: () => version
});
var import_static_builder = __toESM(require_static_builder(), 1);
var { version, build, shouldServe } = (0, import_static_builder.createStaticBuilder)(
  VERCEL_CONFIG_EXTENSIONS
);

// src/builders/install-builders.ts
var import_install_builders = __toESM(require_install_builders(), 1);
var import_execa = __toESM(require_execa(), 1);
var installBuilders = (0, import_install_builders.createInstallBuilders)({
  buildUtilsVersion: pkg_default.dependencies?.["@vercel/build-utils"],
  code,
  cmd,
  isCantParseJSONFile: (value) => value instanceof CantParseJSONFile,
  output: output_manager_default,
  readJSONFile,
  run: import_execa.default
});

// src/builders/import-builders.ts
import { createRequire } from "module";
var require_ = createRequire(__filename);
var importBuilders = (0, import_import_builders.createImportBuilders)({
  builderPins: pkg_default.builders ?? {},
  debug: (message) => output_manager_default.debug(message),
  installBuilders,
  isNativeBinaryInstall,
  require: require_,
  staticBuilder: static_builder_exports,
  vercelDir: VERCEL_DIR
});

export {
  require_npa,
  import_import_builders,
  importBuilders
};
