"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.defaultAuthConfig = exports.defaultGlobalConfig = exports.getGlobalPathConfig = exports.getDataPath = exports.getConfigFilePath = exports.getAuthConfigFilePath = void 0;
exports.getDefaultAuthConfig = getDefaultAuthConfig;
exports.parseGlobalConfig = parseGlobalConfig;
exports.parseAuthConfig = parseAuthConfig;
exports.parseAuthFileConfig = parseAuthFileConfig;
exports.readConfigFile = readConfigFile;
exports.writeConfigFile = writeConfigFile;
exports.readGlobalConfigFile = readGlobalConfigFile;
exports.writeGlobalConfigFile = writeGlobalConfigFile;
exports.readAuthConfigFile = readAuthConfigFile;
exports.readAuthFileConfig = readAuthFileConfig;
exports.readAuthConfig = readAuthConfig;
exports.tryReadAuthConfig = tryReadAuthConfig;
exports.writeAuthConfigFile = writeAuthConfigFile;
exports.writeAuthConfig = writeAuthConfig;
exports.deleteAuthConfigFile = deleteAuthConfigFile;
exports.deleteAuthConfig = deleteAuthConfig;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const zod_1 = require("zod");
const schema_1 = require("./schema");
const paths_1 = require("./paths");
Object.defineProperty(exports, "getAuthConfigFilePath", { enumerable: true, get: function () { return paths_1.getAuthConfigFilePath; } });
Object.defineProperty(exports, "getConfigFilePath", { enumerable: true, get: function () { return paths_1.getConfigFilePath; } });
Object.defineProperty(exports, "getDataPath", { enumerable: true, get: function () { return paths_1.getDataPath; } });
Object.defineProperty(exports, "getGlobalPathConfig", { enumerable: true, get: function () { return paths_1.getGlobalPathConfig; } });
const DOCS_URL = 'https://vercel.com/docs/projects/project-configuration/global-configuration';
exports.defaultGlobalConfig = {
    '// Note': 'This is your Vercel config file. For more information see the global configuration documentation.',
    '// Docs': `${DOCS_URL}#config.json`,
};
function getDefaultAuthConfig() {
    return {
        '// Note': 'This is your Vercel credentials file. DO NOT SHARE!',
        '// Docs': `${DOCS_URL}#auth.json`,
    };
}
exports.defaultAuthConfig = getDefaultAuthConfig();
function normalizeConfigError(error) {
    if (error instanceof zod_1.z.ZodError) {
        const credStorageIssue = error.issues.find(issue => issue.path[0] === 'credStorage');
        if (credStorageIssue) {
            throw new Error(credStorageIssue.message);
        }
    }
    throw error;
}
function parseGlobalConfig(value) {
    try {
        return schema_1.globalConfigSchema.parse(value);
    }
    catch (error) {
        normalizeConfigError(error);
    }
}
function parseAuthConfig(value) {
    return schema_1.authConfigSchema.parse(value);
}
function parseAuthFileConfig(value) {
    const { tokenSource, ...authConfig } = parseAuthConfig(value);
    return authConfig;
}
function readJsonFileSync(filePath) {
    const content = node_fs_1.default.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(content);
}
function writeJsonFileSync(filePath, value, options = {}) {
    const directory = node_path_1.default.dirname(filePath);
    const tempFilePath = node_path_1.default.join(directory, `.${node_path_1.default.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
    const content = `${JSON.stringify(value, null, options.indent ?? 2)}\n`;
    node_fs_1.default.mkdirSync(directory, { recursive: true });
    try {
        node_fs_1.default.writeFileSync(tempFilePath, content, {
            encoding: 'utf8',
            mode: options.mode,
        });
        node_fs_1.default.renameSync(tempFilePath, filePath);
    }
    catch (error) {
        try {
            node_fs_1.default.rmSync(tempFilePath, { force: true });
        }
        catch {
            // Best-effort cleanup for failed atomic writes.
        }
        throw error;
    }
}
function readConfigFile(configPath, schema) {
    return schema.parse(readJsonFileSync(configPath));
}
function writeConfigFile(configPath, schema, config, options) {
    const normalizedConfig = zod_1.z.encode(schema, config);
    writeJsonFileSync(configPath, normalizedConfig, {
        indent: 2,
        ...options,
    });
}
function readGlobalConfigFile(configPath) {
    try {
        return readConfigFile(configPath, schema_1.globalConfigSchema);
    }
    catch (error) {
        normalizeConfigError(error);
    }
}
function writeGlobalConfigFile(configPath, config) {
    writeConfigFile(configPath, schema_1.globalConfigSchema, config);
}
function readAuthConfigFile(configPath) {
    return readConfigFile(configPath, schema_1.authConfigSchema);
}
function readAuthFileConfig(configPath) {
    return parseAuthFileConfig(readJsonFileSync(configPath));
}
function readAuthConfig(configDir) {
    return readAuthConfigFile((0, paths_1.getAuthConfigFilePath)(configDir));
}
function tryReadAuthConfig(configDir) {
    try {
        return readAuthConfig(configDir);
    }
    catch {
        return null;
    }
}
function writeAuthConfigFile(configPath, authConfig) {
    if (authConfig.skipWrite) {
        return;
    }
    writeConfigFile(configPath, schema_1.authConfigSchema, authConfig, {
        mode: 0o600,
    });
}
function writeAuthConfig(configDir, authConfig) {
    writeAuthConfigFile((0, paths_1.getAuthConfigFilePath)(configDir), authConfig);
}
function deleteAuthConfigFile(configPath) {
    node_fs_1.default.rmSync(configPath, { force: true });
}
function deleteAuthConfig(configDir) {
    deleteAuthConfigFile((0, paths_1.getAuthConfigFilePath)(configDir));
}
