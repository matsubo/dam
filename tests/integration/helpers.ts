import postgres from 'postgres';

export async function withTestDb<T>(fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');
  const sql = postgres(url, { max: 1, prepare: false });
  try {
    await sql`BEGIN`;
    try {
      const result = await fn(sql);
      await sql`ROLLBACK`;
      return result;
    } catch (err) {
      await sql`ROLLBACK`;
      throw err;
    }
  } finally {
    await sql.end();
  }
}
