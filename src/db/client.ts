import postgres from "postgres";

export type Sql = postgres.Sql;

/**
 * Database connection pool.
 *
 * The backend connects as the restricted role "soft_ai_service" (see
 * db/migrations/100_soft_ai_foundation.sql). That role can only read Soft AI
 * tables and call Soft AI functions; it has no direct access to ERP tables.
 *
 * Notes:
 *  - prepare: false  -> works behind Supabase's connection pooler (transaction mode).
 *  - NUMERIC values come back as strings, so credit amounts never lose precision
 *    through JavaScript floating point numbers.
 */
export function createSql(databaseUrl: string, options: { max?: number } = {}): Sql {
  return postgres(databaseUrl, {
    max: options.max ?? 10,
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: false,
    connection: { application_name: "soft-ai-backend" },
    onnotice: () => {},
  });
}
