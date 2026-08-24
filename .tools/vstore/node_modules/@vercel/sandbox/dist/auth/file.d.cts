import { z } from "zod";

//#region src/auth/file.d.ts
declare const AuthFile: z.ZodObject<{
  token: z.ZodOptional<z.ZodString>;
  refreshToken: z.ZodOptional<z.ZodString>;
  expiresAt: z.ZodOptional<z.ZodPipe<z.ZodNumber, z.ZodTransform<Date, number>>>;
}, z.core.$strip>;
type AuthFile = z.infer<typeof AuthFile>;
declare const getAuth: () => {
  token?: string | undefined;
  refreshToken?: string | undefined;
  expiresAt?: Date | undefined;
} | null;
declare function updateAuthConfig(config: AuthFile): void;
//#endregion
export { getAuth, updateAuthConfig };
//# sourceMappingURL=file.d.cts.map