"use strict";
// Database connection.
//   DATABASE_URL set  -> a real PostgreSQL server (use this when hosting online)
//   DATABASE_URL unset -> PGlite, PostgreSQL running inside Node, saved in data/pgdata
// Both get the same SQL, so what works locally works in production.

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

async function runSqlFile(db, file) {
  await db.exec(fs.readFileSync(path.join(ROOT, "sql", file), "utf8"));
}

async function connectPostgres(url) {
  const { Pool } = require("pg");
  const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  const pool = new Pool({
    connectionString: url,
    ssl: process.env.PGSSL === "off" || local ? false : { rejectUnauthorized: process.env.PGSSL === "verify" },
    max: Number(process.env.PGPOOL) || 10
  });
  return {
    kind: "PostgreSQL",
    query: (text, params) => pool.query(text, params),
    exec: (text) => pool.query(text),
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await fn({ query: (t, p) => client.query(t, p) });
        await client.query("COMMIT");
        return result;
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },
    close: () => pool.end()
  };
}

async function connectPglite(dir) {
  const { PGlite } = await import("@electric-sql/pglite");
  fs.mkdirSync(dir, { recursive: true });
  const pg = new PGlite(dir);
  await pg.waitReady;
  // PGlite has a single connection, so run one statement or transaction at a time.
  // Inside a transaction, use only the `t.query` it is given.
  let chain = Promise.resolve();
  const serial = (fn) => {
    const run = chain.then(fn);
    chain = run.catch(() => {});
    return run;
  };
  return {
    kind: `PGlite (${path.relative(ROOT, dir)})`,
    query: (text, params) => serial(() => pg.query(text, params)),
    exec: (text) => serial(() => pg.exec(text)),
    tx: (fn) => serial(() => pg.transaction((t) => fn({ query: (q, p) => t.query(q, p) }))),
    close: () => pg.close()
  };
}

async function connect({ demo = false } = {}) {
  const db = process.env.DATABASE_URL
    ? await connectPostgres(process.env.DATABASE_URL)
    : await connectPglite(process.env.PGLITE_DIR || path.join(ROOT, "data", demo ? "pgdemo" : "pgdata"));
  await runSqlFile(db, "001_schema.sql");
  await runSqlFile(db, "002_plans.sql");
  await runSqlFile(db, "003_menu_recipes.sql");
  return db;
}

module.exports = { connect, runSqlFile };
