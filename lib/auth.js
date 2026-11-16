"use strict";
// Passwords, sessions and permissions.

const crypto = require("crypto");
const { promisify } = require("util");

const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 16384, r: 8, p: 1 };
const SESSION_DAYS = 30;

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, 64, SCRYPT);
  return ["scrypt", SCRYPT.N, salt.toString("base64"), hash.toString("base64")].join("$");
}

async function verifyPassword(password, stored) {
  const [kind, n, salt, hash] = String(stored || "").split("$");
  if (kind !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const actual = await scrypt(password, Buffer.from(salt, "base64"), expected.length, { ...SCRYPT, N: Number(n) });
  return crypto.timingSafeEqual(actual, expected);
}

const newToken = () => crypto.randomBytes(32).toString("base64url");
const tokenHash = (token) => crypto.createHash("sha256").update(token).digest("hex");

function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function isHttps(req) {
  return process.env.COOKIE_SECURE === "1" || req.headers["x-forwarded-proto"] === "https" || !!req.socket.encrypted;
}

function sessionCookie(req, token, maxAgeSeconds) {
  return [
    `sid=${token}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${maxAgeSeconds}`,
    isHttps(req) ? "Secure" : ""
  ].filter(Boolean).join("; ");
}

async function createSession(db, req, userId) {
  const token = newToken();
  await db.query(
    "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + make_interval(days => $3))",
    [tokenHash(token), userId, SESSION_DAYS]
  );
  await db.query("UPDATE users SET last_login_at = now() WHERE id = $1", [userId]);
  return sessionCookie(req, token, SESSION_DAYS * 86400);
}

// Login attempts per email and per IP, to slow down password guessing.
const attempts = new Map();
function tooManyAttempts(key) {
  const now = Date.now();
  const recent = (attempts.get(key) || []).filter((t) => now - t < 15 * 60 * 1000);
  attempts.set(key, recent);
  return recent.length >= 10;
}
function recordFailedAttempt(key) {
  attempts.set(key, [...(attempts.get(key) || []), Date.now()]);
}

// What each role may do.
const PERMISSIONS = {
  sell:       ["owner", "manager", "cashier"],
  viewBills:  ["owner", "manager", "cashier"],
  inventory:  ["owner", "manager"],
  reports:    ["owner", "manager"],
  switchOutlet: ["owner", "manager"],
  account:    ["owner"]
};
const can = (role, action) => (PERMISSIONS[action] || []).includes(role);

module.exports = {
  hashPassword, verifyPassword, tokenHash, parseCookies, sessionCookie, createSession,
  tooManyAttempts, recordFailedAttempt, can, PERMISSIONS
};
