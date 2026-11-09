import pg from "pg";

export function createPool(databaseUrl: string) {
  return new pg.Pool({
    connectionString: databaseUrl,
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    application_name: "ironnews-executor",
  });
}

export type Pool = pg.Pool;

/** Retorna null se o banco respondeu, ou a mensagem do erro (para log). */
export async function pingDb(pool: Pool): Promise<string | null> {
  try {
    await pool.query("select 1");
    return null;
  } catch (err) {
    const e = err as Error & { code?: string };
    return e.code ? `${e.code}: ${e.message}` : e.message;
  }
}
