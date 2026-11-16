"use strict";
// Icepops server: counter billing, inventory, reports and subscriptions for
// many businesses, each with its own outlets, staff and data.
//
//   npm start      your data (PGlite in data/pgdata, or PostgreSQL via DATABASE_URL)
//   npm run demo   a separate demo database with two years of example sales
//
// Settings (environment variables):
//   PORT=8000            port to listen on
//   HOST=127.0.0.1       set 0.0.0.0 to allow other devices on the network
//   DATABASE_URL=...     PostgreSQL connection string for hosting online
//   BILLING_MODE, RAZORPAY_*   see lib/billing.js
//   NODE_ENV=production  refuses to start without DATABASE_URL, and needs BILLING_MODE set
//   TRUST_PROXY=1        behind nginx: take the visitor's IP from X-Real-IP / X-Forwarded-For

const http = require("http");
const fsp = require("fs").promises;
const path = require("path");

const { connect, runSqlFile } = require("./lib/db");
const auth = require("./lib/auth");
const billing = require("./lib/billing");
const { billPdf, pdfFileName } = require("./lib/pdf");
const { exportWorkbook } = require("./lib/excel");

const ROOT = __dirname;
const DEMO = process.argv.includes("--demo");
const PORT = Number(process.env.PORT) || 8000;
const HOST = process.env.HOST || "127.0.0.1";
const PAYMENTS = ["Cash", "UPI", "Card"];
const PRODUCTION = process.env.NODE_ENV === "production";
const TRUST_PROXY = process.env.TRUST_PROXY === "1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const STARTER_MENU = [
  ["Alphonso Mango", 40, 24, "#F9A61A", "#FFD23F"],
  ["Strawberry", 35, 18, "#E8344E", "#FF8A9A"],
  ["Orange Bar", 30, 30, "#F26A1B", "#F26A1B"],
  ["Kala Khatta", 35, 12, "#5B2A86", "#9B5FC0"],
  ["Rose Milk", 40, 15, "#F58BB0", "#FBD3E0"],
  ["Lychee", 45, 10, "#F4C6CB", "#FFF0EE"],
  ["Chilli Guava", 45, 10, "#3FA34D", "#F0627A"],
  ["Tender Coconut", 50, 15, "#F5F1E3", "#CFE8C6"]
];

let db;

// The visitor's address. Behind nginx every request comes from 127.0.0.1, so
// read the header nginx sets instead (only when TRUST_PROXY=1).
function clientIp(req) {
  if (TRUST_PROXY) {
    const real = req.headers["x-real-ip"];
    const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
    if (real || forwarded) return String(real || forwarded);
  }
  return req.socket.remoteAddress || "";
}

// ---------- Errors and input checks ----------

function httpError(status, message, extra) {
  const e = new Error(message);
  e.status = status;
  e.extra = extra;
  return e;
}

function wholeNumber(v, min, label, max = 1000000) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw httpError(400, `Enter ${label} in whole numbers, ${min} or more.`);
  return n;
}

function priceToPaise(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 1 || n > 100000 || Math.round(n * 100) !== n * 100) {
    throw httpError(400, "Enter a price of ₹1 or more, with at most 2 decimal places.");
  }
  return Math.round(n * 100);
}

function text(v, label, { min = 0, max = 60 } = {}) {
  const s = String(v == null ? "" : v).trim().replace(/\s+/g, " ");
  if (s.length < min) throw httpError(400, min === 1 ? `Enter ${label}.` : `${label} needs at least ${min} characters.`);
  if (s.length > max) throw httpError(400, `${label} can be at most ${max} characters.`);
  return s;
}

function email(v) {
  const s = String(v || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) || s.length > 120) throw httpError(400, "Enter a valid email address.");
  return s;
}

function password(v) {
  const s = String(v || "");
  if (s.length < 8) throw httpError(400, "Use a password of at least 8 characters.");
  if (s.length > 200) throw httpError(400, "That password is too long.");
  return s;
}

function cleanPhone(v) {
  let phone = String(v || "").replace(/\D/g, "");
  if (phone.length === 12 && phone.startsWith("91")) phone = phone.slice(2);
  else if (phone.length === 11 && phone.startsWith("0")) phone = phone.slice(1);
  if (phone && !/^[6-9]\d{9}$/.test(phone)) throw httpError(400, "Enter a 10-digit mobile number, or leave the mobile box empty.");
  return phone;
}

const KINDS = ["pop", "cup", "fries", "dessert", "plate"];
function cleanKind(v) {
  if (!KINDS.includes(v)) throw httpError(400, "Choose a picture: pop, cup, fries, dessert or plate.");
  return v;
}
const cleanCategory = (v) => text(v || "Other", "The category", { min: 1, max: 30 });
const cleanPrep = (v) => (v === "" || v == null ? null : wholeNumber(v, 0, "the prep time in minutes", 240));

// Making instructions for one portion: ingredients with optional amounts, and steps.
function cleanRecipe(r) {
  if (r == null) return { ingredients: [], steps: [] };
  if (typeof r !== "object") throw httpError(400, "The recipe could not be read.");
  const rawIngredients = (Array.isArray(r.ingredients) ? r.ingredients : []).filter((i) => i && String(i.name || "").trim());
  const rawSteps = (Array.isArray(r.steps) ? r.steps : []).map((x) => String(x || "").trim()).filter(Boolean);
  if (rawIngredients.length > 40) throw httpError(400, "A recipe can have at most 40 ingredients.");
  if (rawSteps.length > 30) throw httpError(400, "A recipe can have at most 30 steps.");
  const ingredients = rawIngredients.map((i) => {
    const name = text(i.name, "an ingredient name", { min: 1, max: 60 });
    const unit = text(i.unit, `The unit for ${name}`, { max: 20 });
    let qty = i.qty === "" || i.qty == null ? null : Number(i.qty);
    if (qty !== null && (!Number.isFinite(qty) || qty <= 0 || qty > 100000)) {
      throw httpError(400, `Enter an amount above 0 for ${name}, or leave the amount empty.`);
    }
    if (qty !== null) qty = Math.round(qty * 1000) / 1000;
    return { qty, unit, name };
  });
  const steps = rawSteps.map((x, n) => {
    if (x.length > 300) throw httpError(400, `Step ${n + 1} is too long. Keep each step under 300 characters.`);
    return x;
  });
  return { ingredients, steps };
}

// Reuse the spelling of a category the business already has ("snacks" becomes "Snacks").
async function matchCategory(q, businessId, category) {
  const found = (await q.query(
    "SELECT category FROM items WHERE business_id = $1 AND lower(category) = lower($2) ORDER BY active DESC, created_at LIMIT 1",
    [businessId, category]
  )).rows[0];
  return found ? found.category : category;
}

const colour = (v, fallback) => (/^#[0-9a-f]{6}$/i.test(v) ? v.toUpperCase() : fallback);
const isUniqueViolation = (e) => e && e.code === "23505";

// ---------- Who is asking ----------

async function loadContext(req) {
  const sid = auth.parseCookies(req.headers.cookie).sid;
  if (!sid) return null;
  const hash = auth.tokenHash(sid);
  const { rows } = await db.query(
    `SELECT u.id AS user_id, u.name AS user_name, u.email, u.role, u.outlet_id AS home_outlet,
            s.outlet_id AS chosen_outlet,
            b.id AS business_id, b.name AS business_name, b.address, b.phone, b.gstin, b.timezone,
            sub.plan_id, sub.pending_plan_id, sub.status, sub.trial_ends_at, sub.current_period_end,
            sub.cancel_at_period_end, sub.provider, sub.provider_subscription_id,
            p.name AS plan_name, p.max_outlets, p.max_users, p.max_items, p.features, p.price_monthly_paise
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       JOIN businesses b ON b.id = u.business_id
       LEFT JOIN subscriptions sub ON sub.business_id = b.id
       LEFT JOIN plans p ON p.id = sub.plan_id
      WHERE s.token_hash = $1 AND s.expires_at > now() AND u.active`,
    [hash]
  );
  const r = rows[0];
  if (!r) return null;

  const outlets = (await db.query(
    "SELECT id, name, address FROM outlets WHERE business_id = $1 AND active ORDER BY created_at, name",
    [r.business_id]
  )).rows;
  const pick = (id) => outlets.find((o) => o.id === id);
  const outlet = r.role === "cashier"
    ? pick(r.home_outlet) || outlets[0] || null
    : pick(r.chosen_outlet) || pick(r.home_outlet) || outlets[0] || null;

  const sub = r.status ? {
    planId: r.plan_id, pendingPlanId: r.pending_plan_id, status: r.status, trial_ends_at: r.trial_ends_at,
    current_period_end: r.current_period_end, cancel_at_period_end: r.cancel_at_period_end,
    provider: r.provider, providerSubscriptionId: r.provider_subscription_id
  } : null;

  return {
    tokenHash: hash,
    user: { id: r.user_id, name: r.user_name, email: r.email, role: r.role },
    business: { id: r.business_id, name: r.business_name, address: r.address, phone: r.phone, gstin: r.gstin, timezone: r.timezone },
    outlets,
    outlet,
    sub,
    plan: r.plan_id ? { id: r.plan_id, name: r.plan_name, maxOutlets: r.max_outlets, maxUsers: r.max_users, maxItems: r.max_items, features: r.features, pricePaise: r.price_monthly_paise } : null,
    access: billing.accessState(sub)
  };
}

function need(ctx, action) {
  if (!auth.can(ctx.user.role, action)) throw httpError(403, "Your login doesn't have access to this. Ask the owner of the account.");
}
function needActive(ctx) {
  if (!ctx.access.ok) throw httpError(402, ctx.access.message);
}
function needOutlet(ctx) {
  if (!ctx.outlet) throw httpError(409, "There is no open outlet. The owner can add one on the Account page.");
}

// ---------- Menu and bills ----------

async function menuFor(q, ctx) {
  const { rows } = await q.query(
    `SELECT i.id, i.name, i.price_paise, i.colour_a, i.colour_b, i.category, i.kind, i.track_stock, i.recipe, i.prep_minutes, s.stock
       FROM items i
       JOIN outlet_stock s ON s.item_id = i.id AND s.outlet_id = $2
      WHERE i.business_id = $1 AND i.active
      ORDER BY i.created_at, i.name`,
    [ctx.business.id, ctx.outlet.id]
  );
  return rows.map((r) => ({
    id: r.id, name: r.name, price: r.price_paise / 100, stock: r.stock, a: r.colour_a, b: r.colour_b,
    category: r.category, kind: r.kind, trackStock: r.track_stock, recipe: r.recipe, prepMinutes: r.prep_minutes
  }));
}

const BILL_COLUMNS = `
  b.id, b.bill_no, b.qty, b.total_paise, b.payment_method, b.customer_name, b.customer_phone,
  to_char(b.created_at AT TIME ZONE bz.timezone, 'YYYY-MM-DD') AS date,
  to_char(b.created_at AT TIME ZONE bz.timezone, 'HH24:MI') AS time,
  o.name AS outlet_name,
  (SELECT string_agg(bi.qty || ' × ' || bi.item_name, ', ' ORDER BY bi.line_no) FROM bill_items bi WHERE bi.bill_id = b.id) AS summary`;

function billOut(r) {
  return {
    billNo: r.bill_no, date: r.date, time: r.time, summary: r.summary || "", qty: r.qty, total: r.total_paise / 100,
    payment: r.payment_method, customer: r.customer_name, phone: r.customer_phone, outlet: r.outlet_name
  };
}

async function findBill(q, ctx, no) {
  const outletLimit = ctx.user.role === "cashier" ? ctx.outlet && ctx.outlet.id : null;
  const { rows } = await q.query(
    `SELECT ${BILL_COLUMNS}
       FROM bills b JOIN businesses bz ON bz.id = b.business_id JOIN outlets o ON o.id = b.outlet_id
      WHERE b.business_id = $1 AND b.bill_no = $2 AND ($3::uuid IS NULL OR b.outlet_id = $3)`,
    [ctx.business.id, no, outletLimit]
  );
  if (!rows[0]) throw httpError(404, `There is no bill ${no}.`);
  const bill = billOut(rows[0]);
  const items = (await q.query(
    "SELECT item_id, item_name, qty, unit_price_paise, line_total_paise FROM bill_items WHERE bill_id = $1 ORDER BY line_no",
    [rows[0].id]
  )).rows.map((i) => ({
    billNo: bill.billNo, date: bill.date, time: bill.time, flavourId: i.item_id, flavour: i.item_name,
    qty: i.qty, price: i.unit_price_paise / 100, lineTotal: i.line_total_paise / 100, payment: bill.payment
  }));
  return { bill, items };
}

async function createSale(ctx, body) {
  need(ctx, "sell");
  needActive(ctx);
  needOutlet(ctx);
  const payment = PAYMENTS.includes(body.payment) ? body.payment : null;
  if (!payment) throw httpError(400, "Choose how the customer paid: Cash, UPI or Card.");
  if (!Array.isArray(body.items) || !body.items.length || body.items.length > 100) throw httpError(400, "Add at least one item to the order.");
  const customer = body.customer || {};
  const customerName = text(customer.name, "The customer name", { max: 40 });
  const customerPhone = cleanPhone(customer.phone);

  const wanted = new Map();
  for (const it of body.items) {
    const id = String(it && it.id);
    if (!UUID.test(id)) throw httpError(409, "An item in this order is no longer on the menu. Reload the page.");
    wanted.set(id, (wanted.get(id) || 0) + wholeNumber(it.qty, 1, "the quantity", 1000));
  }

  return db.tx(async (t) => {
    const { rows } = await t.query(
      `SELECT i.id, i.name, i.price_paise, i.track_stock, s.stock
         FROM items i JOIN outlet_stock s ON s.item_id = i.id AND s.outlet_id = $2
        WHERE i.business_id = $1 AND i.active AND i.id = ANY($3::uuid[])
          FOR UPDATE OF s`,
      [ctx.business.id, ctx.outlet.id, [...wanted.keys()]]
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    const lines = [];
    for (const [id, q] of wanted) {
      const it = byId.get(id);
      if (!it) throw httpError(409, "An item in this order is no longer on the menu.", { flavours: await menuFor(t, ctx) });
      if (it.track_stock && q > it.stock) {
        throw httpError(409, it.stock === 0 ? `${it.name} is sold out.` : `Only ${it.stock} ${it.name} left.`, { flavours: await menuFor(t, ctx) });
      }
      lines.push({ it, q });
    }

    const billNo = (await t.query(
      "UPDATE businesses SET next_bill_no = next_bill_no + 1 WHERE id = $1 RETURNING next_bill_no - 1 AS bill_no",
      [ctx.business.id]
    )).rows[0].bill_no;
    const qty = lines.reduce((s, l) => s + l.q, 0);
    const total = lines.reduce((s, l) => s + l.q * l.it.price_paise, 0);

    const billId = (await t.query(
      `INSERT INTO bills (business_id, outlet_id, bill_no, customer_name, customer_phone, payment_method, qty, total_paise, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [ctx.business.id, ctx.outlet.id, billNo, customerName, customerPhone, payment, qty, total, ctx.user.id]
    )).rows[0].id;

    await t.query(
      `INSERT INTO bill_items (bill_id, line_no, item_id, item_name, qty, unit_price_paise, line_total_paise)
       SELECT $1, * FROM unnest($2::int[], $3::uuid[], $4::text[], $5::int[], $6::int[], $7::int[])`,
      [billId, lines.map((_, i) => i + 1), lines.map((l) => l.it.id), lines.map((l) => l.it.name),
        lines.map((l) => l.q), lines.map((l) => l.it.price_paise), lines.map((l) => l.q * l.it.price_paise)]
    );

    for (const { it, q } of lines) {
      if (!it.track_stock) continue; // made to order: nothing to count
      const after = (await t.query(
        "UPDATE outlet_stock SET stock = stock - $3 WHERE outlet_id = $1 AND item_id = $2 RETURNING stock",
        [ctx.outlet.id, it.id, q]
      )).rows[0].stock;
      await t.query(
        `INSERT INTO stock_log (business_id, outlet_id, item_id, item_name, change, reason, stock_after, user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [ctx.business.id, ctx.outlet.id, it.id, it.name, -q, `Sale, bill ${billNo}`, after, ctx.user.id]
      );
    }

    const { bill, items } = await findBill(t, ctx, billNo);
    return { billNo, qty, total: total / 100, payment, bill, items, flavours: await menuFor(t, ctx) };
  });
}

// ---------- Inventory ----------

async function itemResult(ctx, id) {
  const flavours = await menuFor(db, ctx);
  return { flavour: flavours.find((f) => f.id === id) || null, flavours };
}

async function addItem(ctx, body) {
  need(ctx, "inventory");
  needActive(ctx);
  needOutlet(ctx);
  const name = text(body.name, "a name", { min: 1, max: 40 });
  const price = priceToPaise(body.price);
  const trackStock = body.trackStock !== false;
  const stock = trackStock ? wholeNumber(body.stock, 0, "the number of items") : 0;
  const c = colour(body.colour, "#F2C230");
  const kind = cleanKind(body.kind || "pop");
  let category = cleanCategory(body.category);
  const recipe = cleanRecipe(body.recipe);
  const prep = cleanPrep(body.prepMinutes);

  const id = await db.tx(async (t) => {
    category = await matchCategory(t, ctx.business.id, category);
    if (ctx.plan && ctx.plan.maxItems != null) {
      const count = (await t.query("SELECT count(*)::int AS n FROM items WHERE business_id = $1 AND active", [ctx.business.id])).rows[0].n;
      if (count >= ctx.plan.maxItems) throw httpError(402, `The ${ctx.plan.name} plan allows ${ctx.plan.maxItems} items on the menu. Remove one, or upgrade on the Account page.`);
    }
    const taken = (await t.query("SELECT 1 FROM items WHERE business_id = $1 AND active AND lower(name) = lower($2)", [ctx.business.id, name])).rows[0];
    if (taken) throw httpError(409, `${name} is already on the menu.`);
    const itemId = (await t.query(
      `INSERT INTO items (business_id, name, price_paise, colour_a, colour_b, category, kind, track_stock, recipe, prep_minutes)
       VALUES ($1, $2, $3, $4, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [ctx.business.id, name, price, c, category, kind, trackStock, JSON.stringify(recipe), prep]
    )).rows[0].id;
    await t.query(
      `INSERT INTO outlet_stock (outlet_id, item_id, stock)
       SELECT o.id, $2, CASE WHEN o.id = $3 THEN $4 ELSE 0 END FROM outlets o WHERE o.business_id = $1`,
      [ctx.business.id, itemId, ctx.outlet.id, stock]
    );
    if (trackStock) {
      await t.query(
        `INSERT INTO stock_log (business_id, outlet_id, item_id, item_name, change, reason, stock_after, user_id)
         VALUES ($1, $2, $3, $4, $5, 'Opening stock', $5, $6)`,
        [ctx.business.id, ctx.outlet.id, itemId, name, stock, ctx.user.id]
      );
    }
    return itemId;
  }).catch((e) => { throw isUniqueViolation(e) ? httpError(409, `${name} is already on the menu.`) : e; });
  return itemResult(ctx, id);
}

async function changeItem(ctx, id, body, restock) {
  need(ctx, "inventory");
  needActive(ctx);
  needOutlet(ctx);
  if (!UUID.test(id)) throw httpError(404, "That item is no longer on the menu. Reload the page.");

  await db.tx(async (t) => {
    const row = (await t.query(
      `SELECT i.id, i.name, s.stock FROM items i JOIN outlet_stock s ON s.item_id = i.id AND s.outlet_id = $3
        WHERE i.id = $1 AND i.business_id = $2 AND i.active FOR UPDATE OF s`,
      [id, ctx.business.id, ctx.outlet.id]
    )).rows[0];
    if (!row) throw httpError(404, "That item is no longer on the menu. Reload the page.");
    let name = row.name;

    if (restock) {
      const qty = wholeNumber(body.qty, 1, "the number to add", 100000);
      await setStock(t, ctx, row, row.stock + qty, qty, "Restock");
      return;
    }
    if ("name" in body) {
      name = text(body.name, "a name", { min: 1, max: 40 });
      const taken = (await t.query(
        "SELECT 1 FROM items WHERE business_id = $1 AND active AND lower(name) = lower($2) AND id <> $3",
        [ctx.business.id, name, id]
      )).rows[0];
      if (taken) throw httpError(409, `${name} is already on the menu.`);
      await t.query("UPDATE items SET name = $2 WHERE id = $1", [id, name]);
    }
    if ("price" in body) await t.query("UPDATE items SET price_paise = $2 WHERE id = $1", [id, priceToPaise(body.price)]);
    if ("category" in body) await t.query("UPDATE items SET category = $2 WHERE id = $1", [id, await matchCategory(t, ctx.business.id, cleanCategory(body.category))]);
    if ("kind" in body) await t.query("UPDATE items SET kind = $2 WHERE id = $1", [id, cleanKind(body.kind)]);
    if ("colour" in body) await t.query("UPDATE items SET colour_a = $2, colour_b = $2 WHERE id = $1", [id, colour(body.colour, "#F2C230")]);
    if ("trackStock" in body) await t.query("UPDATE items SET track_stock = $2 WHERE id = $1", [id, body.trackStock !== false]);
    if ("recipe" in body) await t.query("UPDATE items SET recipe = $2 WHERE id = $1", [id, JSON.stringify(cleanRecipe(body.recipe))]);
    if ("prepMinutes" in body) await t.query("UPDATE items SET prep_minutes = $2 WHERE id = $1", [id, cleanPrep(body.prepMinutes)]);
    if ("stock" in body) {
      const stock = wholeNumber(body.stock, 0, "the number of items");
      if (stock !== row.stock) await setStock(t, ctx, { ...row, name }, stock, stock - row.stock, "Stock count corrected");
    }
  }).catch((e) => { throw isUniqueViolation(e) ? httpError(409, "That name is already on the menu.") : e; });
  return itemResult(ctx, id);
}

async function setStock(t, ctx, row, stock, change, reason) {
  await t.query("UPDATE outlet_stock SET stock = $3 WHERE outlet_id = $1 AND item_id = $2", [ctx.outlet.id, row.id, stock]);
  await t.query(
    `INSERT INTO stock_log (business_id, outlet_id, item_id, item_name, change, reason, stock_after, user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [ctx.business.id, ctx.outlet.id, row.id, row.name, change, reason, stock, ctx.user.id]
  );
}

async function removeItem(ctx, id) {
  need(ctx, "inventory");
  needActive(ctx);
  needOutlet(ctx);
  if (!UUID.test(id)) throw httpError(404, "That item is no longer on the menu.");
  const { rows } = await db.query(
    "UPDATE items SET active = false WHERE id = $1 AND business_id = $2 AND active RETURNING id, name",
    [id, ctx.business.id]
  );
  if (!rows[0]) throw httpError(404, "That item is no longer on the menu. Reload the page.");
  return { flavour: { id, name: rows[0].name }, flavours: await menuFor(db, ctx) };
}

// ---------- Reports and export ----------

function scopeOutlet(ctx, scope) {
  if (scope === "all") return null;
  needOutlet(ctx);
  return ctx.outlet.id;
}

async function reportData(ctx, scope) {
  need(ctx, "reports");
  const outletId = scopeOutlet(ctx, scope);
  const args = [ctx.business.id, outletId];
  const bills = (await db.query(
    `SELECT ${BILL_COLUMNS}
       FROM bills b JOIN businesses bz ON bz.id = b.business_id JOIN outlets o ON o.id = b.outlet_id
      WHERE b.business_id = $1 AND ($2::uuid IS NULL OR b.outlet_id = $2)
      ORDER BY b.created_at`, args
  )).rows.map(billOut);
  const items = (await db.query(
    `SELECT b.bill_no, bi.item_id, bi.item_name, bi.qty, bi.unit_price_paise, bi.line_total_paise, b.payment_method,
            to_char(b.created_at AT TIME ZONE bz.timezone, 'YYYY-MM-DD') AS date,
            to_char(b.created_at AT TIME ZONE bz.timezone, 'HH24:MI') AS time
       FROM bill_items bi JOIN bills b ON b.id = bi.bill_id JOIN businesses bz ON bz.id = b.business_id
      WHERE b.business_id = $1 AND ($2::uuid IS NULL OR b.outlet_id = $2)
      ORDER BY b.created_at, bi.line_no`, args
  )).rows.map((r) => ({
    billNo: r.bill_no, date: r.date, time: r.time, flavourId: r.item_id, flavour: r.item_name, qty: r.qty,
    price: r.unit_price_paise / 100, lineTotal: r.line_total_paise / 100, payment: r.payment_method
  }));
  const flavours = (await db.query(
    "SELECT id, name, colour_a AS a, colour_b AS b, active, category, kind FROM items WHERE business_id = $1 ORDER BY created_at",
    [ctx.business.id]
  )).rows;
  return {
    demo: DEMO,
    scope: outletId ? "outlet" : "all",
    source: outletId ? `${ctx.business.name}, ${ctx.outlet.name}` : `${ctx.business.name}, all outlets`,
    outlets: ctx.outlets.map((o) => ({ id: o.id, name: o.name })),
    flavours, bills, items
  };
}

async function exportData(ctx, scope) {
  need(ctx, "reports");
  const outletId = scopeOutlet(ctx, scope);
  const args = [ctx.business.id, outletId];
  const data = await reportData(ctx, scope);
  const outletOf = new Map(data.bills.map((b) => [b.billNo, b.outlet]));
  const stockRows = (await db.query(
    `SELECT i.name, i.price_paise, i.active, i.category, i.track_stock, i.recipe, i.prep_minutes, o.name AS outlet, s.stock
       FROM items i JOIN outlet_stock s ON s.item_id = i.id JOIN outlets o ON o.id = s.outlet_id
      WHERE i.business_id = $1 AND ($2::uuid IS NULL OR o.id = $2) AND o.active
      ORDER BY i.created_at, o.created_at`, args
  )).rows;
  const log = (await db.query(
    `SELECT to_char(l.created_at AT TIME ZONE bz.timezone, 'YYYY-MM-DD') AS date,
            to_char(l.created_at AT TIME ZONE bz.timezone, 'HH24:MI') AS time,
            o.name AS outlet, l.item_name, l.change, l.reason, l.stock_after, u.name AS by
       FROM stock_log l JOIN businesses bz ON bz.id = l.business_id JOIN outlets o ON o.id = l.outlet_id
       LEFT JOIN users u ON u.id = l.user_id
      WHERE l.business_id = $1 AND ($2::uuid IS NULL OR l.outlet_id = $2)
      ORDER BY l.created_at, l.id`, args
  )).rows;
  return exportWorkbook({
    items: stockRows.map((r) => ({
      name: r.name, category: r.category, price: r.price_paise / 100, outlet: r.outlet,
      stock: r.track_stock ? r.stock : "Made to order", onMenu: r.active ? "Yes" : "No",
      prep: r.prep_minutes == null ? "" : r.prep_minutes,
      ingredients: (r.recipe.ingredients || []).map((i) => [i.qty, i.unit, i.name].filter((x) => x != null && x !== "").join(" ")).join("; "),
      steps: (r.recipe.steps || []).map((x, n) => `${n + 1}. ${x}`).join(" ")
    })),
    bills: data.bills,
    items_sold: data.items.map((i) => ({ ...i, outlet: outletOf.get(i.billNo) || "" })),
    stock: log.map((r) => ({ date: r.date, time: r.time, outlet: r.outlet, item: r.item_name, change: r.change, reason: r.reason, after: r.stock_after, by: r.by || "" }))
  }, ctx.business.name);
}

// ---------- Sign-up and login ----------

async function signup(req, body) {
  const ip = clientIp(req);
  if (auth.tooManyAttempts(`signup:${ip}`)) throw httpError(429, "Too many sign-ups from this network. Try again in 15 minutes.");
  auth.recordFailedAttempt(`signup:${ip}`);

  const businessName = text(body.businessName, "your business name", { min: 1, max: 60 });
  const outletName = text(body.outletName, "your first outlet's name", { min: 1, max: 60 });
  const name = text(body.name, "your name", { min: 1, max: 60 });
  const mail = email(body.email);
  const pass = password(body.password);
  const phone = String(body.phone || "").trim().slice(0, 20);
  const hash = await auth.hashPassword(pass);

  const exists = (await db.query("SELECT 1 FROM users WHERE lower(email) = $1", [mail])).rows[0];
  if (exists) throw httpError(409, "An account with this email already exists. Log in instead.");

  const userId = await db.tx(async (t) => {
    const businessId = (await t.query("INSERT INTO businesses (name, phone) VALUES ($1, $2) RETURNING id", [businessName, phone])).rows[0].id;
    const outletId = (await t.query("INSERT INTO outlets (business_id, name) VALUES ($1, $2) RETURNING id", [businessId, outletName])).rows[0].id;
    const uid = (await t.query(
      "INSERT INTO users (business_id, name, email, password_hash, role) VALUES ($1, $2, $3, $4, 'owner') RETURNING id",
      [businessId, name, mail, hash]
    )).rows[0].id;
    await t.query(
      "INSERT INTO subscriptions (business_id, plan_id, status, trial_ends_at) VALUES ($1, 'lite', 'trialing', now() + make_interval(days => $2))",
      [businessId, billing.TRIAL_DAYS]
    );
    if (body.starterMenu) {
      for (const [itemName, price, stock, a, b] of STARTER_MENU) {
        const itemId = (await t.query(
          "INSERT INTO items (business_id, name, price_paise, colour_a, colour_b, category, kind) VALUES ($1, $2, $3, $4, $5, 'Icepops', 'pop') RETURNING id",
          [businessId, itemName, price * 100, a, b]
        )).rows[0].id;
        await t.query("INSERT INTO outlet_stock (outlet_id, item_id, stock) VALUES ($1, $2, $3)", [outletId, itemId, stock]);
        await t.query(
          `INSERT INTO stock_log (business_id, outlet_id, item_id, item_name, change, reason, stock_after, user_id)
           VALUES ($1, $2, $3, $4, $5, 'Opening stock', $5, $6)`,
          [businessId, outletId, itemId, itemName, stock, uid]
        );
      }
    }
    return uid;
  }).catch((e) => { throw isUniqueViolation(e) ? httpError(409, "An account with this email already exists. Log in instead.") : e; });

  return { cookie: await auth.createSession(db, req, userId) };
}

async function login(req, body) {
  const mail = String(body.email || "").trim().toLowerCase();
  const keys = [`login:${mail}`, `login-ip:${clientIp(req)}`];
  if (keys.some(auth.tooManyAttempts)) throw httpError(429, "Too many attempts. Wait 15 minutes, then try again.");
  const user = (await db.query(
    "SELECT id, password_hash FROM users WHERE lower(email) = $1 AND active",
    [mail]
  )).rows[0];
  const ok = user && await auth.verifyPassword(String(body.password || ""), user.password_hash);
  if (!ok) {
    keys.forEach(auth.recordFailedAttempt);
    throw httpError(401, "That email and password don't match. Check them and try again.");
  }
  return { cookie: await auth.createSession(db, req, user.id) };
}

// ---------- Account: business, outlets, team ----------

async function usage(q, businessId) {
  return (await q.query(
    `SELECT (SELECT count(*)::int FROM outlets WHERE business_id = $1 AND active) AS outlets,
            (SELECT count(*)::int FROM users WHERE business_id = $1 AND active) AS users,
            (SELECT count(*)::int FROM items WHERE business_id = $1 AND active) AS items`,
    [businessId]
  )).rows[0];
}

async function accountData(ctx) {
  need(ctx, "account");
  const id = ctx.business.id;
  const [outlets, users, plans, payments, use] = await Promise.all([
    db.query("SELECT id, name, address, active FROM outlets WHERE business_id = $1 ORDER BY created_at", [id]),
    db.query(
      `SELECT u.id, u.name, u.email, u.role, u.active, u.outlet_id, o.name AS outlet_name, u.last_login_at
         FROM users u LEFT JOIN outlets o ON o.id = u.outlet_id
        WHERE u.business_id = $1 ORDER BY u.role = 'owner' DESC, u.created_at`, [id]),
    db.query("SELECT id, name, price_monthly_paise, max_outlets, max_users, max_items, features, self_serve FROM plans ORDER BY sort_order"),
    db.query("SELECT plan_id, amount_paise, status, provider, created_at FROM payments WHERE business_id = $1 ORDER BY created_at DESC LIMIT 24", [id]),
    usage(db, id)
  ]);
  return {
    business: ctx.business,
    outlets: outlets.rows,
    users: users.rows.map((u) => ({ ...u, self: u.id === ctx.user.id })),
    plans: plans.rows.map((p) => ({
      id: p.id, name: p.name, price: p.price_monthly_paise / 100, maxOutlets: p.max_outlets, maxUsers: p.max_users,
      maxItems: p.max_items, features: p.features, selfServe: p.self_serve
    })),
    payments: payments.rows.map((p) => ({ ...p, amount: p.amount_paise / 100 })),
    usage: use,
    subscription: ctx.sub,
    plan: ctx.plan,
    access: ctx.access,
    billingMode: billing.MODE
  };
}

async function updateBusiness(ctx, body) {
  need(ctx, "account");
  const name = text(body.name, "the business name", { min: 1, max: 60 });
  const address = text(body.address, "The address", { max: 160 });
  const phone = text(body.phone, "The phone number", { max: 20 });
  const gstin = String(body.gstin || "").trim().toUpperCase();
  if (gstin && !/^\d{2}[A-Z0-9]{10}\d[A-Z0-9]{2}$/.test(gstin)) throw httpError(400, "A GSTIN has 15 characters, like 29ABCDE1234F1Z5. Leave it empty if you don't have one.");
  await db.query("UPDATE businesses SET name = $2, address = $3, phone = $4, gstin = $5 WHERE id = $1", [ctx.business.id, name, address, phone, gstin]);
  return { ok: true };
}

async function addOutlet(ctx, body) {
  need(ctx, "account");
  needActive(ctx);
  const name = text(body.name, "the outlet name", { min: 1, max: 60 });
  const address = text(body.address, "The address", { max: 160 });
  await db.tx(async (t) => {
    const use = await usage(t, ctx.business.id);
    if (ctx.plan.maxOutlets != null && use.outlets >= ctx.plan.maxOutlets) {
      throw httpError(402, `The ${ctx.plan.name} plan allows ${ctx.plan.maxOutlets} outlet${ctx.plan.maxOutlets === 1 ? "" : "s"}. Upgrade to add more.`);
    }
    const id = (await t.query("INSERT INTO outlets (business_id, name, address) VALUES ($1, $2, $3) RETURNING id", [ctx.business.id, name, address])).rows[0].id;
    await t.query(
      "INSERT INTO outlet_stock (outlet_id, item_id, stock) SELECT $1, id, 0 FROM items WHERE business_id = $2",
      [id, ctx.business.id]
    );
  });
  return accountData(ctx);
}

async function changeOutlet(ctx, id, body) {
  need(ctx, "account");
  if (!UUID.test(id)) throw httpError(404, "That outlet doesn't exist.");
  await db.tx(async (t) => {
    const row = (await t.query("SELECT id, name, address, active FROM outlets WHERE id = $1 AND business_id = $2", [id, ctx.business.id])).rows[0];
    if (!row) throw httpError(404, "That outlet doesn't exist.");
    const name = "name" in body ? text(body.name, "the outlet name", { min: 1, max: 60 }) : row.name;
    const address = "address" in body ? text(body.address, "The address", { max: 160 }) : row.address;
    let active = row.active;
    if ("active" in body) {
      active = !!body.active;
      const use = await usage(t, ctx.business.id);
      if (!active && row.active && use.outlets <= 1) throw httpError(409, "You need at least one open outlet.");
      if (active && !row.active) {
        needActive(ctx);
        if (ctx.plan.maxOutlets != null && use.outlets >= ctx.plan.maxOutlets) throw httpError(402, `The ${ctx.plan.name} plan allows ${ctx.plan.maxOutlets} open outlet${ctx.plan.maxOutlets === 1 ? "" : "s"}.`);
      }
    }
    await t.query("UPDATE outlets SET name = $2, address = $3, active = $4 WHERE id = $1", [id, name, address, active]);
  });
  return accountData(ctx);
}

async function addUser(ctx, body) {
  need(ctx, "account");
  needActive(ctx);
  const name = text(body.name, "their name", { min: 1, max: 60 });
  const mail = email(body.email);
  const pass = password(body.password);
  const role = ["manager", "cashier"].includes(body.role) ? body.role : null;
  if (!role) throw httpError(400, "Choose Manager or Cashier.");
  const outletId = role === "cashier" ? String(body.outletId || "") : null;
  if (role === "cashier" && !ctx.outlets.some((o) => o.id === outletId)) throw httpError(400, "Choose the outlet this cashier works at.");
  const hash = await auth.hashPassword(pass);
  await db.tx(async (t) => {
    const use = await usage(t, ctx.business.id);
    if (ctx.plan.maxUsers != null && use.users >= ctx.plan.maxUsers) throw httpError(402, `The ${ctx.plan.name} plan allows ${ctx.plan.maxUsers} logins. Remove one, or upgrade.`);
    const taken = (await t.query("SELECT 1 FROM users WHERE lower(email) = $1", [mail])).rows[0];
    if (taken) throw httpError(409, "Someone already uses this email. Use a different one.");
    await t.query(
      "INSERT INTO users (business_id, outlet_id, name, email, password_hash, role) VALUES ($1, $2, $3, $4, $5, $6)",
      [ctx.business.id, outletId, name, mail, hash, role]
    );
  }).catch((e) => { throw isUniqueViolation(e) ? httpError(409, "Someone already uses this email.") : e; });
  return accountData(ctx);
}

async function changeUser(ctx, id, body) {
  need(ctx, "account");
  if (!UUID.test(id)) throw httpError(404, "That login doesn't exist.");
  if (id === ctx.user.id) throw httpError(409, "You can't change your own login here.");
  const newHash = "password" in body ? await auth.hashPassword(password(body.password)) : null;
  await db.tx(async (t) => {
    const row = (await t.query("SELECT id, role, active, outlet_id FROM users WHERE id = $1 AND business_id = $2", [id, ctx.business.id])).rows[0];
    if (!row) throw httpError(404, "That login doesn't exist.");
    if (row.role === "owner") throw httpError(409, "The owner's login can't be changed here.");
    let { active, role, outlet_id: outletId } = row;
    if ("active" in body) active = !!body.active;
    if ("role" in body) {
      if (!["manager", "cashier"].includes(body.role)) throw httpError(400, "Choose Manager or Cashier.");
      role = body.role;
    }
    if ("outletId" in body) outletId = body.outletId || null;
    if (role === "cashier" && !ctx.outlets.some((o) => o.id === outletId)) throw httpError(400, "Choose the outlet this cashier works at.");
    if (role === "manager") outletId = null;
    if (active && !row.active) {
      needActive(ctx);
      const use = await usage(t, ctx.business.id);
      if (ctx.plan.maxUsers != null && use.users >= ctx.plan.maxUsers) throw httpError(402, `The ${ctx.plan.name} plan allows ${ctx.plan.maxUsers} logins.`);
    }
    await t.query("UPDATE users SET active = $2, role = $3, outlet_id = $4 WHERE id = $1", [id, active, role, outletId]);
    if (newHash) await t.query("UPDATE users SET password_hash = $2 WHERE id = $1", [id, newHash]);
    if (!active || newHash) await t.query("DELETE FROM sessions WHERE user_id = $1", [id]); // log them out everywhere
  });
  return accountData(ctx);
}

// ---------- Subscription ----------

async function subscribe(ctx, body) {
  need(ctx, "account");
  const plan = (await db.query("SELECT * FROM plans WHERE id = $1", [String(body.planId || "")])).rows[0];
  if (!plan) throw httpError(404, "That plan doesn't exist.");
  if (!plan.self_serve) throw httpError(409, `${plan.name} is set up with you personally. Contact us and we'll get you started.`);

  const use = await usage(db, ctx.business.id);
  const over = [
    plan.max_outlets != null && use.outlets > plan.max_outlets && `${use.outlets} open outlets (the plan allows ${plan.max_outlets})`,
    plan.max_users != null && use.users > plan.max_users && `${use.users} logins (the plan allows ${plan.max_users})`,
    plan.max_items != null && use.items > plan.max_items && `${use.items} items (the plan allows ${plan.max_items})`
  ].filter(Boolean);
  if (over.length) throw httpError(409, `You have ${over.join(" and ")}. Reduce these first, then switch to ${plan.name}.`);

  if (billing.MODE === "test") {
    await db.tx(async (t) => {
      await t.query(
        `UPDATE subscriptions
            SET plan_id = $2, pending_plan_id = NULL, status = 'active', provider = 'test', cancel_at_period_end = false,
                current_period_end = GREATEST(now(), COALESCE(current_period_end, now())) + interval '1 month', updated_at = now()
          WHERE business_id = $1`,
        [ctx.business.id, plan.id]
      );
      await t.query(
        "INSERT INTO payments (business_id, plan_id, amount_paise, status, provider) VALUES ($1, $2, $3, 'test', 'test')",
        [ctx.business.id, plan.id, plan.price_monthly_paise]
      );
    });
    return { mode: "test", plan: plan.name };
  }

  // Razorpay: create a subscription, then the page opens Razorpay Checkout for the first payment.
  if (!plan.razorpay_plan_id) throw httpError(409, `${plan.name} can't be bought online yet. (razorpay_plan_id is not set for this plan.)`);
  if (ctx.sub && ctx.sub.provider === "razorpay" && ctx.access.ok && ctx.sub.status === "active" && !ctx.sub.cancel_at_period_end) {
    throw httpError(409, "To change plans, cancel your current plan first, or contact us and we'll switch it for you.");
  }
  const rz = await billing.razorpay("POST", "/subscriptions", {
    plan_id: plan.razorpay_plan_id,
    total_count: 120,
    customer_notify: 1,
    notes: { business_id: ctx.business.id, plan: plan.id }
  });
  await db.query(
    "UPDATE subscriptions SET pending_plan_id = $2, provider_subscription_id = $3, updated_at = now() WHERE business_id = $1",
    [ctx.business.id, plan.id, rz.id]
  );
  return {
    mode: "razorpay",
    keyId: billing.RZP.keyId,
    subscriptionId: rz.id,
    plan: plan.name,
    prefill: { name: ctx.user.name, email: ctx.user.email, contact: ctx.business.phone }
  };
}

async function verifyCheckout(ctx, body) {
  need(ctx, "account");
  if (billing.MODE !== "razorpay") throw httpError(409, "Online payment is not switched on.");
  if (!ctx.sub || body.razorpay_subscription_id !== ctx.sub.providerSubscriptionId) throw httpError(409, "This payment doesn't match your current checkout. Reload and try again.");
  if (!billing.checkoutSignatureValid(body)) throw httpError(400, "The payment couldn't be verified. If money was taken, contact us with the payment ID.");
  await db.tx(async (t) => {
    const sub = (await t.query(
      `UPDATE subscriptions
          SET plan_id = COALESCE(pending_plan_id, plan_id), pending_plan_id = NULL, status = 'active', provider = 'razorpay',
              cancel_at_period_end = false, current_period_end = now() + interval '1 month', updated_at = now()
        WHERE business_id = $1 RETURNING plan_id`,
      [ctx.business.id]
    )).rows[0];
    const price = (await t.query("SELECT price_monthly_paise FROM plans WHERE id = $1", [sub.plan_id])).rows[0].price_monthly_paise;
    await t.query(
      `INSERT INTO payments (business_id, plan_id, amount_paise, status, provider, provider_payment_id, provider_subscription_id)
       VALUES ($1, $2, $3, 'paid', 'razorpay', $4, $5) ON CONFLICT (provider, provider_payment_id) DO NOTHING`,
      [ctx.business.id, sub.plan_id, price, String(body.razorpay_payment_id), String(body.razorpay_subscription_id)]
    );
  });
  return { ok: true };
}

async function cancelSubscription(ctx) {
  need(ctx, "account");
  if (!ctx.sub || ctx.sub.status === "trialing") throw httpError(409, "You're on the free trial, so there's nothing to cancel. It simply ends if you don't choose a plan.");
  if (ctx.sub.provider === "razorpay" && ctx.sub.providerSubscriptionId) {
    await billing.razorpay("POST", `/subscriptions/${encodeURIComponent(ctx.sub.providerSubscriptionId)}/cancel`, { cancel_at_cycle_end: 1 });
  }
  await db.query("UPDATE subscriptions SET cancel_at_period_end = true, updated_at = now() WHERE business_id = $1", [ctx.business.id]);
  return { ok: true };
}

// Razorpay calls this on renewals, failures and cancellations.
async function razorpayWebhook(raw, signature) {
  if (!billing.webhookSignatureValid(raw, signature)) throw httpError(400, "Invalid signature.");
  const event = JSON.parse(raw);
  const s = event.payload && event.payload.subscription && event.payload.subscription.entity;
  const p = event.payload && event.payload.payment && event.payload.payment.entity;
  if (!s) return { ok: true };
  const sub = (await db.query("SELECT business_id FROM subscriptions WHERE provider_subscription_id = $1", [s.id])).rows[0];
  if (!sub) return { ok: true };

  switch (event.event) {
    case "subscription.activated":
    case "subscription.charged":
    case "subscription.resumed":
      await db.tx(async (t) => {
        const row = (await t.query(
          `UPDATE subscriptions
              SET status = 'active', provider = 'razorpay', plan_id = COALESCE(pending_plan_id, plan_id), pending_plan_id = NULL,
                  current_period_end = CASE WHEN $2::bigint IS NULL THEN now() + interval '1 month' ELSE to_timestamp($2::bigint) END,
                  updated_at = now()
            WHERE business_id = $1 RETURNING plan_id`,
          [sub.business_id, s.current_end || null]
        )).rows[0];
        if (p && p.id) {
          await t.query(
            `INSERT INTO payments (business_id, plan_id, amount_paise, status, provider, provider_payment_id, provider_subscription_id)
             VALUES ($1, $2, $3, 'paid', 'razorpay', $4, $5) ON CONFLICT (provider, provider_payment_id) DO NOTHING`,
            [sub.business_id, row.plan_id, Number(p.amount) || 0, p.id, s.id]
          );
        }
      });
      break;
    case "subscription.pending":
    case "subscription.halted":
      await db.query("UPDATE subscriptions SET status = 'past_due', updated_at = now() WHERE business_id = $1", [sub.business_id]);
      break;
    case "subscription.cancelled":
    case "subscription.completed":
      await db.query("UPDATE subscriptions SET status = 'cancelled', cancel_at_period_end = true, updated_at = now() WHERE business_id = $1", [sub.business_id]);
      break;
    default:
      break;
  }
  return { ok: true };
}

// ---------- Routing ----------

function meData(ctx) {
  const perms = Object.fromEntries(Object.keys(auth.PERMISSIONS).map((k) => [k, auth.can(ctx.user.role, k)]));
  return {
    user: ctx.user, business: ctx.business, outlet: ctx.outlet, outlets: ctx.outlets,
    plan: ctx.plan, subscription: ctx.sub, access: ctx.access, permissions: perms, demo: DEMO
  };
}

async function api(req, url, raw) {
  const { method } = req;
  const p = url.pathname;
  const body = () => {
    if (!raw.length) return {};
    try { return JSON.parse(raw.toString("utf8")); } catch (e) { throw httpError(400, "The request could not be read."); }
  };

  // No login needed
  if (method === "POST" && p === "/api/billing/webhook") return razorpayWebhook(raw.toString("utf8"), req.headers["x-razorpay-signature"]);
  if (method === "GET" && p === "/api/plans") {
    const { rows } = await db.query("SELECT id, name, price_monthly_paise, max_outlets, max_users, max_items, features, self_serve FROM plans ORDER BY sort_order");
    return { trialDays: billing.TRIAL_DAYS, plans: rows.map((r) => ({ id: r.id, name: r.name, price: r.price_monthly_paise / 100, maxOutlets: r.max_outlets, maxUsers: r.max_users, maxItems: r.max_items, features: r.features, selfServe: r.self_serve })) };
  }
  if (method === "POST" && p === "/api/auth/signup") return signup(req, body());
  if (method === "POST" && p === "/api/auth/login") return login(req, body());
  if (method === "POST" && p === "/api/auth/logout") {
    const sid = auth.parseCookies(req.headers.cookie).sid;
    if (sid) await db.query("DELETE FROM sessions WHERE token_hash = $1", [auth.tokenHash(sid)]);
    return { ok: true, cookie: auth.sessionCookie(req, "", 0) };
  }

  const ctx = await loadContext(req);
  if (!ctx) throw httpError(401, "Please log in.");

  if (method === "GET" && p === "/api/me") return meData(ctx);
  if (method === "POST" && p === "/api/me/outlet") {
    need(ctx, "switchOutlet");
    const id = String(body().outletId || "");
    if (!ctx.outlets.some((o) => o.id === id)) throw httpError(404, "That outlet doesn't exist.");
    await db.query("UPDATE sessions SET outlet_id = $2 WHERE token_hash = $1", [ctx.tokenHash, id]);
    return { ok: true };
  }

  if (method === "GET" && p === "/api/menu") { need(ctx, "sell"); needOutlet(ctx); return { flavours: await menuFor(db, ctx) }; }
  if (method === "POST" && p === "/api/sales") return createSale(ctx, body());

  const bm = p.match(/^\/api\/bills\/(\d{1,9})$/);
  if (method === "GET" && bm) { need(ctx, "viewBills"); return findBill(db, ctx, Number(bm[1])); }

  if (method === "POST" && p === "/api/items") return addItem(ctx, body());
  const im = p.match(/^\/api\/items\/([^/]+)(\/restock)?$/);
  if (im) {
    if (method === "POST" && im[2]) return changeItem(ctx, im[1], body(), true);
    if (method === "PATCH" && !im[2]) return changeItem(ctx, im[1], body(), false);
    if (method === "DELETE" && !im[2]) return removeItem(ctx, im[1]);
  }

  if (method === "GET" && p === "/api/report-data") return reportData(ctx, url.searchParams.get("scope"));

  if (method === "GET" && p === "/api/account") return accountData(ctx);
  if (method === "PATCH" && p === "/api/business") return updateBusiness(ctx, body());
  if (method === "POST" && p === "/api/outlets") return addOutlet(ctx, body());
  const om = p.match(/^\/api\/outlets\/([^/]+)$/);
  if (method === "PATCH" && om) return changeOutlet(ctx, om[1], body());
  if (method === "POST" && p === "/api/users") return addUser(ctx, body());
  const um = p.match(/^\/api\/users\/([^/]+)$/);
  if (method === "PATCH" && um) return changeUser(ctx, um[1], body());

  if (method === "POST" && p === "/api/billing/subscribe") return subscribe(ctx, body());
  if (method === "POST" && p === "/api/billing/verify") return verifyCheckout(ctx, body());
  if (method === "POST" && p === "/api/billing/cancel") return cancelSubscription(ctx);

  throw httpError(404, "Unknown address.");
}

// Files (PDF, Excel) need their own responses.
async function fileRoute(req, url) {
  const pdf = url.pathname.match(/^\/api\/bills\/(\d{1,9})\/pdf$/);
  const isExport = url.pathname === "/api/download";
  if (req.method !== "GET" || (!pdf && !isExport)) return null;
  const ctx = await loadContext(req);
  if (!ctx) throw httpError(401, "Please log in.");
  if (pdf) {
    need(ctx, "viewBills");
    const { bill, items } = await findBill(db, ctx, Number(pdf[1]));
    const shop = { ...ctx.business, outletName: ctx.outlets.length > 1 ? bill.outlet : "" };
    return {
      type: "application/pdf",
      body: await billPdf(shop, bill, items),
      headers: { "Content-Disposition": `${url.searchParams.has("download") ? "attachment" : "inline"}; filename="${pdfFileName(shop, bill)}"` }
    };
  }
  const scope = url.searchParams.get("scope");
  const stamp = new Date().toISOString().slice(0, 10);
  const name = `${ctx.business.name.replace(/[^A-Za-z0-9]+/g, "-")}-${stamp}.xlsx`;
  return {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    body: Buffer.from(await exportData(ctx, scope)),
    headers: { "Content-Disposition": `attachment; filename="${name}"` }
  };
}

const PAGES = {
  "/": "index.html", "/index.html": "index.html", "/admin-index.html": "admin-index.html",
  "/reports.html": "reports.html", "/bill.html": "bill.html", "/account.html": "account.html",
  "/login.html": "login.html", "/signup.html": "signup.html",
  "/styles.css": "styles.css", "/store.js": "store.js", "/analytics.js": "analytics.js"
};
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8" };
const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "same-origin",
  "Cache-Control": "no-store"
};

function send(res, status, body, type, extra = {}) {
  res.writeHead(status, { "Content-Type": type, ...SECURITY_HEADERS, ...extra });
  res.end(body);
}

function readRaw(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > 200000) { reject(httpError(413, "The request is too large.")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// Changes must come from our own pages: same origin, sent as JSON.
function checkSameSite(req, url) {
  if (req.method === "GET" || url.pathname === "/api/billing/webhook") return;
  const origin = req.headers.origin;
  if (origin) {
    let host = "";
    try { host = new URL(origin).host; } catch (e) { /* invalid origin */ }
    if (host !== req.headers.host) throw httpError(403, "Requests from other websites are not allowed.");
  }
  if (!String(req.headers["content-type"] || "").startsWith("application/json")) throw httpError(415, "Send the request as JSON.");
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    // For nginx, uptime monitors and the deploy script: is the app up and the database reachable?
    if (url.pathname === "/healthz") {
      try {
        await db.query("SELECT 1");
        return send(res, 200, "ok", "text/plain; charset=utf-8");
      } catch (e) {
        return send(res, 503, "database unreachable", "text/plain; charset=utf-8");
      }
    }
    if (url.pathname.startsWith("/api/")) {
      checkSameSite(req, url);
      const file = await fileRoute(req, url);
      if (file) return send(res, 200, file.body, file.type, file.headers);
      const raw = req.method === "GET" ? Buffer.alloc(0) : await readRaw(req);
      const data = await api(req, url, raw);
      const { cookie, ...rest } = data || {};
      return send(res, 200, JSON.stringify(rest), "application/json; charset=utf-8", cookie ? { "Set-Cookie": cookie } : {});
    }
    const file = PAGES[url.pathname];
    if (!file || req.method !== "GET") return send(res, 404, "Not found", "text/plain; charset=utf-8");
    return send(res, 200, await fsp.readFile(path.join(ROOT, file)), TYPES[path.extname(file)]);
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error(e);
    const message = status === 500 ? "Something went wrong on the server. Check the server's terminal for details." : e.message;
    return send(res, status, JSON.stringify({ error: message, ...(e.extra || {}) }), "application/json; charset=utf-8");
  }
});

async function start() {
  if (PRODUCTION) {
    if (!process.env.DATABASE_URL) throw new Error("NODE_ENV=production needs DATABASE_URL (your PostgreSQL connection string).");
    if (DEMO) throw new Error("Don't run the demo with NODE_ENV=production.");
    if (!process.env.BILLING_MODE) throw new Error("Set BILLING_MODE=razorpay (or BILLING_MODE=test while you set Razorpay up) in the environment file.");
  }
  billing.checkConfig();
  db = await connect({ demo: DEMO });
  if (DEMO) await require("./lib/demo").ensureDemo(db, runSqlFile);
  await db.query("DELETE FROM sessions WHERE expires_at < now()");
  server.listen(PORT, HOST, () => {
    const base = `http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`;
    console.log(`Icepops is running. Database: ${db.kind}. Billing: ${billing.MODE} mode.`);
    console.log(`  Open ${base}/  (new businesses sign up at ${base}/signup.html)`);
    if (DEMO) console.log("  Demo logins: demo@icepops.test (owner) and cashier@icepops.test, password icepops-demo");
    if (billing.MODE === "test") console.log("  Test billing: choosing a plan activates it without payment. Don't use this mode live.");
  });
}

// systemd sends SIGTERM on stop and restart: finish open requests, then close the database.
let stopping = false;
function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`${signal} received, shutting down.`);
  const force = setTimeout(() => process.exit(1), 10000);
  force.unref();
  server.close(async () => {
    try { if (db) await db.close(); } catch (e) { /* closing anyway */ }
    process.exit(0);
  });
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

start().catch((e) => { console.error(e.message || e); process.exit(1); });
