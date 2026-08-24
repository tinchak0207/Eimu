"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getDataPath = getDataPath;
exports.getGlobalPathConfig = getGlobalPathConfig;
exports.getConfigFilePath = getConfigFilePath;
exports.getAuthConfigFilePath = getAuthConfigFilePath;
exports.readGlobalConfigFlag = readGlobalConfigFlag;
// Zod-free path helpers so hot paths (e.g. the `vc.js` shim) can locate and
// read the global config without loading zod and the config schemas.
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const node_os_1 = require("node:os");
function isReadableDirectory(targetPath) {
    try {
        return node_fs_1.default.lstatSync(targetPath).isDirectory();
    }
    catch (_) {
        return false;
    }
}
function getDataDirectories(appName) {
    // xdg-app-paths infers a default app name when loaded, which requires a
    // process entrypoint that is not present in every server runtime.
    const XDGAppPaths = require('xdg-app-paths');
    return XDGAppPaths(appName).dataDirs();
}
/** Canonical platform application-data directory for the Vercel CLI. */
function getDataPath() {
    return getDataDirectories('com.vercel.cli')[0];
}
function getGlobalPathConfig() {
    const vercelDirectories = getDataDirectories('com.vercel.cli');
    const possibleConfigPaths = [
        ...vercelDirectories, // latest vercel directory
        node_path_1.default.join((0, node_os_1.homedir)(), '.now'), // legacy config in user's home directory
        ...getDataDirectories('now'), // legacy XDG directory
    ];
    return (possibleConfigPaths.find(configPath => isReadableDirectory(configPath)) ||
        vercelDirectories[0]);
}
function getConfigFilePath(configDir) {
    return node_path_1.default.join(configDir, 'config.json');
}
function getAuthConfigFilePath(configDir) {
    return node_path_1.default.join(configDir, 'auth.json');
}
// Reads a single key from the global config file without schema validation,
// for cheap feature-gate reads on hot paths.
function readGlobalConfigFlag(configPath, key) {
    try {
        const content = node_fs_1.default.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, '');
        const parsed = JSON.parse(content);
        if (parsed && typeof parsed === 'object') {
            return parsed[key];
        }
    }
    catch {
        // Missing/unreadable/invalid config is treated as "no value".
    }
    return undefined;
}
