/**
 * Test settings. Defaults point at the LOCAL Supabase in Docker.
 * The local passwords below are Supabase's public local defaults / our local-only
 * password, not real secrets.
 *
 * Safety: tests refuse to run against any database that is not on this computer.
 */
function localUrl(name: string, fallback: string): string {
  const url = process.env[name] ?? fallback;
  const host = new URL(url).hostname;
  if (host !== "127.0.0.1" && host !== "localhost") {
    throw new Error(`Refusing to run tests: ${name} points to "${host}", not to a local database.`);
  }
  return url;
}

export const TEST_ENV = {
  /** Full-power local connection, used ONLY to create and remove test data. */
  adminDatabaseUrl: localUrl("TEST_ADMIN_DATABASE_URL", "postgres://postgres:postgres@127.0.0.1:54322/postgres"),
  /** The restricted role the real backend uses. The app under test uses this. */
  serviceDatabaseUrl: localUrl(
    "TEST_SERVICE_DATABASE_URL",
    "postgres://soft_ai_service:local-dev-only@127.0.0.1:54322/postgres",
  ),
  supabaseUrl: "http://127.0.0.1:54321",
  /** Our own test signing secret; the app under test is configured with it. */
  jwtSecret: "soft-ai-test-secret-not-used-anywhere-real-0123456789",
  allowedOrigin: "http://localhost:3000",
};
