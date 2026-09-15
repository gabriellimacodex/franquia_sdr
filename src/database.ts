import pg from 'pg';

export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}
export interface Database extends Queryable {
  transaction<T>(fn: (db: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
export function connectDatabase(url: string, ssl = true): Database {
  const pool = new pg.Pool({ connectionString: url, ssl: ssl ? { rejectUnauthorized: true } : false,
    max: 8, connectionTimeoutMillis: 5000, statement_timeout: 8000 });
  return {
    query: async <T>(sql:string, params?:unknown[]) => ({rows:(await pool.query(sql,params)).rows as T[]}),
    async transaction(fn) {
      const client = await pool.connect();
      try { await client.query('BEGIN'); const result = await fn({query:async <R>(sql:string,params?:unknown[])=>({rows:(await client.query(sql,params)).rows as R[]})}); await client.query('COMMIT'); return result; }
      catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    },
    close: () => pool.end(),
  };
}

export interface Scope { tenantId: string; brandId: string }
export async function scoped<T>(db: Database, scope: Scope, fn: (tx: Queryable) => Promise<T>): Promise<T> {
  return db.transaction(async tx => {
    // Pilot: one short DB transaction per brand. No network calls inside this lock.
    // All paths take this lock before row locks, avoiding ingest/complete/handoff deadlocks.
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0)), set_config('sdr.tenant_id',$2,true), set_config('sdr.brand_id',$3,true)", [scope.tenantId+':'+scope.brandId, scope.tenantId, scope.brandId]);
    return fn(tx);
  });
}
