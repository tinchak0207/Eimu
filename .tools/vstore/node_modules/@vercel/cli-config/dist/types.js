"use strict";
/**
 * Pure TypeScript interface definitions for Vercel global config types.
 *
 * These interfaces serve as the source of truth for types.
 * Zod schemas are generated from these using ts-to-zod.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_CRED_STORAGE = exports.CRED_STORAGE_VALUES = exports.CRED_STORAGE_CONFIG_VALUES = void 0;
exports.CRED_STORAGE_CONFIG_VALUES = [
    'auto',
    'file',
    'keyring',
];
exports.CRED_STORAGE_VALUES = exports.CRED_STORAGE_CONFIG_VALUES.filter((storage) => storage !== 'auto');
exports.DEFAULT_CRED_STORAGE = 'file';
