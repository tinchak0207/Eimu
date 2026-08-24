import { z } from 'zod';
export declare const telemetryConfigSchema: z.ZodObject<{
    enabled: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strip>;
export declare const guidanceConfigSchema: z.ZodObject<{
    enabled: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strip>;
export declare const updatesConfigSchema: z.ZodObject<{
    auto: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strip>;
export declare const credStorageSchema: z.ZodUnion<readonly [z.ZodLiteral<"auto">, z.ZodLiteral<"file">, z.ZodLiteral<"keyring">]>;
export declare const authConfigSchema: z.ZodObject<{
    '// Note': z.ZodOptional<z.ZodString>;
    '// Docs': z.ZodOptional<z.ZodString>;
    skipWrite: z.ZodOptional<z.ZodBoolean>;
    token: z.ZodOptional<z.ZodString>;
    userId: z.ZodOptional<z.ZodString>;
    refreshToken: z.ZodOptional<z.ZodString>;
    expiresAt: z.ZodOptional<z.ZodNumber>;
    tokenSource: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"flag">, z.ZodLiteral<"env">]>>;
}, z.core.$strip>;
export declare const authFileConfigSchema: z.ZodObject<{
    '// Note': z.ZodOptional<z.ZodString>;
    '// Docs': z.ZodOptional<z.ZodString>;
    skipWrite: z.ZodOptional<z.ZodBoolean>;
    token: z.ZodOptional<z.ZodString>;
    userId: z.ZodOptional<z.ZodString>;
    refreshToken: z.ZodOptional<z.ZodString>;
    expiresAt: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
export declare const globalConfigSchema: z.ZodObject<{
    '// Note': z.ZodOptional<z.ZodString>;
    '// Docs': z.ZodOptional<z.ZodString>;
    credStorage: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"auto">, z.ZodLiteral<"file">, z.ZodLiteral<"keyring">]>>;
    currentTeam: z.ZodOptional<z.ZodString>;
    api: z.ZodOptional<z.ZodString>;
    telemetry: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
    guidance: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
    updates: z.ZodOptional<z.ZodObject<{
        auto: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
    useNativeBinary: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strip>;
