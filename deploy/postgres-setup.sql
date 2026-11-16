-- Creates the PostgreSQL login and database for Icepops. setup-server.sh runs
-- this for you; to run it by hand on the Ubuntu server:
--
--   sudo -u postgres psql -v db_password='a-long-random-password' -f deploy/postgres-setup.sql
--
-- Safe to run again: it only creates what's missing and resets the password.
-- The app creates its own tables when it starts (sql/001_schema.sql onwards).

\set ON_ERROR_STOP on

SELECT format('CREATE ROLE icepops LOGIN PASSWORD %L', :'db_password')
 WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'icepops')
\gexec

SELECT format('ALTER ROLE icepops WITH LOGIN PASSWORD %L', :'db_password')
\gexec

SELECT 'CREATE DATABASE icepops OWNER icepops ENCODING ''UTF8'' TEMPLATE template0'
 WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'icepops')
\gexec

\connect icepops

-- The app's tables live in the public schema, owned by the icepops role.
ALTER SCHEMA public OWNER TO icepops;
-- Other database users on this server can't connect to the Icepops data.
REVOKE ALL ON DATABASE icepops FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE icepops TO icepops;
