import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { closeGenerationSql, getGenerationSql } from "../src/lib/generation-core/database";

async function main() {
  const sql = getGenerationSql();
  const directory = path.join(process.cwd(), "db", "migrations");
  const names = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();

  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS generation_schema_migration (
      name text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  await sql`SELECT pg_advisory_lock(hashtext('image-studio-generation-migrations'))`;
  try {
    for (const name of names) {
      const body = await readFile(path.join(directory, name), "utf8");
      const checksum = createHash("sha256").update(body).digest("hex");
      const existing = await sql<{ checksum: string }[]>`
        SELECT checksum FROM generation_schema_migration WHERE name = ${name}
      `;
      if (existing[0]) {
        if (existing[0].checksum !== checksum) throw new Error(`Applied migration ${name} has changed.`);
        continue;
      }

      await sql.begin(async (tx) => {
        await tx.unsafe(body);
        await tx`
          INSERT INTO generation_schema_migration (name, checksum)
          VALUES (${name}, ${checksum})
        `;
      });
      console.log(`[generation-migrate] applied ${name}`);
    }
  } finally {
    await sql`SELECT pg_advisory_unlock(hashtext('image-studio-generation-migrations'))`;
    await closeGenerationSql();
  }
}

main().catch((error) => {
  console.error("[generation-migrate] failed", error);
  process.exitCode = 1;
});
