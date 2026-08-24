"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.authConfigHasUsableTokenData = authConfigHasUsableTokenData;
exports.getLikelyEffectiveCredStorage = getLikelyEffectiveCredStorage;
const types_1 = require("./types");
const cli_config_1 = require("./cli-config");
const TOKEN_STORAGE_ENV = 'VERCEL_TOKEN_STORAGE';
function isErrnoException(error) {
    return typeof error === 'object' && error !== null && 'code' in error;
}
function isCredStorage(value) {
    return types_1.CRED_STORAGE_CONFIG_VALUES.includes(value);
}
function formatCredStorageError(value, source) {
    return `Invalid value for \`${source}\`: ${JSON.stringify(value)}. Expected one of: ${types_1.CRED_STORAGE_CONFIG_VALUES.map(storage => JSON.stringify(storage)).join(', ')}.`;
}
function parseCredStorage(value, source = 'credStorage') {
    if (typeof value === 'undefined') {
        return undefined;
    }
    if (isCredStorage(value)) {
        return value;
    }
    throw new Error(formatCredStorageError(value, source));
}
function authConfigHasUsableTokenData(value) {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const authConfig = value;
    return ((typeof authConfig.token === 'string' && authConfig.token.length > 0) ||
        (typeof authConfig.refreshToken === 'string' &&
            authConfig.refreshToken.length > 0));
}
function getLikelyAutoCredStorage(configDir) {
    try {
        return authConfigHasUsableTokenData((0, cli_config_1.readAuthConfigFile)((0, cli_config_1.getAuthConfigFilePath)(configDir)))
            ? 'file'
            : 'keyring';
    }
    catch {
        return 'keyring';
    }
}
function getLikelyConfiguredCredStorage(configDir, credStorage) {
    if (credStorage === 'keyring') {
        return 'keyring';
    }
    if (credStorage !== 'auto') {
        return types_1.DEFAULT_CRED_STORAGE;
    }
    return getLikelyAutoCredStorage(configDir);
}
function getLikelyEffectiveCredStorage(configDir) {
    let config = {};
    const credStorageOverride = process.env[TOKEN_STORAGE_ENV];
    if (typeof credStorageOverride !== 'undefined') {
        return getLikelyConfiguredCredStorage(configDir, parseCredStorage(credStorageOverride, TOKEN_STORAGE_ENV));
    }
    try {
        const parsed = (0, cli_config_1.readGlobalConfigFile)((0, cli_config_1.getConfigFilePath)(configDir));
        config = {
            ...parsed,
            credStorage: parseCredStorage(parsed.credStorage),
        };
    }
    catch (error) {
        if (!(isErrnoException(error) && error.code === 'ENOENT')) {
            throw error;
        }
    }
    return getLikelyConfiguredCredStorage(configDir, config.credStorage);
}
