import postgres from "postgres";

export type GenerationSql = ReturnType<typeof postgres>;

let client: GenerationSql | null = null;

export function generationDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env.GENERATION_DATABASE_URL ?? env.DATABASE_URL ?? "").trim();
}

export function generationDatabaseConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(generationDatabaseUrl(env));
}

export function generationControlPlaneEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.GENERATION_CONTROL_PLANE_ENABLED?.trim().toLowerCase() === "true" && generationDatabaseConfigured(env);
}

export function getGenerationSql(): GenerationSql {
  if (client) return client;
  const url = generationDatabaseUrl();
  if (!url) throw new Error("GENERATION_DATABASE_URL or DATABASE_URL is required for the generation control plane.");

  client = postgres(url, {
    max: Math.max(1, Number(process.env.GENERATION_DATABASE_POOL_SIZE ?? 5)),
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: false,
    transform: { undefined: null },
  });
  return client;
}

export async function closeGenerationSql(): Promise<void> {
  if (!client) return;
  const current = client;
  client = null;
  await current.end({ timeout: 5 });
}

