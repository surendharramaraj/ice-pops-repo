"use strict";
// Imports a workbook from the earlier spreadsheet version of Icepops
// (data/icepops-data.xlsx) into a business in the database.
//
//   1. Sign up (or log in) once, so your business exists.
//   2. Stop the server (Ctrl+C).
//   3. node scripts/import-excel.js data/icepops-data.xlsx you@example.com
//
// Flavours, stock and every bill are imported into the business's first outlet.
// It refuses to run if the business already has bills, so nothing is doubled.

const path = require("path");
const ExcelJS = require("exceljs");
const { connect } = require("../lib/db");

function plain(v) {
  if (v == null) return null;
  if (v instanceof Date) return v;
  if (typeof v === "object") {
    if ("result" in v) return plain(v.result);
    if (Array.isArray(v.richText)) return v.richText.map((t) => t.text).join("");
    if ("text" in v) return v.text;
    return null;
  }
  return v;
}
const str = (v) => (v == null ? "" : v instanceof Date ? v.toISOString() : String(v).trim());
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
function day(v) {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "number") return new Date(Math.round((v - 25569) * 86400000)).toISOString().slice(0, 10);
  const s = str(v);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : "";
}
function time(v) {
  if (v instanceof Date) return v.toISOString().slice(11, 16);
  const s = str(v);
  return /^\d{1,2}:\d{2}$/.test(s) ? s.padStart(5, "0") : "12:00";
}

function readSheet(wb, name) {
  const ws = wb.getWorksheet(name);
  if (!ws) return [];
  const head = [];
  ws.getRow(1).eachCell((c, i) => { head[i] = str(plain(c.value)); });
  const rows = [];
  ws.eachRow((r, n) => {
    if (n === 1) return;
    const o = {};
    head.forEach((h, i) => { if (h) o[h] = plain(r.getCell(i).value); });
    rows.push(o);
  });
  return rows;
}

async function serverRunning() {
  const port = Number(process.env.PORT) || 8000;
  try { await fetch(`http://127.0.0.1:${port}/api/plans`, { signal: AbortSignal.timeout(1500) }); return true; } catch (e) { return false; }
}

async function main() {
  const [file, email] = process.argv.slice(2);
  if (!file || !email) {
    console.log("Usage: node scripts/import-excel.js <workbook.xlsx> <owner email>");
    process.exit(1);
  }
  if (!process.env.DATABASE_URL && await serverRunning()) {
    console.error("The Icepops server is running. Stop it first (Ctrl+C in its terminal), then run this again.");
    process.exit(1);
  }

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path.resolve(file));
  const flavours = readSheet(wb, "Flavours");
  const bills = readSheet(wb, "Bills");
  const lines = readSheet(wb, "Bill items");
  if (!flavours.length) throw new Error(`No "Flavours" sheet found in ${file}. Is this an Icepops workbook?`);

  const db = await connect();
  try {
    const owner = (await db.query(
      `SELECT u.business_id, u.id, b.timezone, b.name
         FROM users u JOIN businesses b ON b.id = u.business_id
        WHERE lower(u.email) = lower($1) AND u.role = 'owner'`, [email]
    )).rows[0];
    if (!owner) throw new Error(`No owner login with the email ${email}. Sign up first, then run this again.`);
    const outlet = (await db.query("SELECT id, name FROM outlets WHERE business_id = $1 AND active ORDER BY created_at LIMIT 1", [owner.business_id])).rows[0];
    const existing = (await db.query("SELECT count(*)::int AS n FROM bills WHERE business_id = $1", [owner.business_id])).rows[0].n;
    if (existing) throw new Error(`${owner.name} already has ${existing} bills, so the import was stopped to avoid doubling them.`);

    const summary = await db.tx(async (t) => {
      const idMap = new Map();
      const outlets = (await t.query("SELECT id FROM outlets WHERE business_id = $1", [owner.business_id])).rows.map((r) => r.id);

      async function ensureItem(name, pricePaise, active, a, b) {
        const found = (await t.query(
          "SELECT id FROM items WHERE business_id = $1 AND lower(name) = lower($2) ORDER BY active DESC LIMIT 1",
          [owner.business_id, name]
        )).rows[0];
        if (found) {
          await t.query("UPDATE items SET price_paise = $2, active = $3 WHERE id = $1", [found.id, pricePaise, active]);
          return found.id;
        }
        const id = (await t.query(
          "INSERT INTO items (business_id, name, price_paise, colour_a, colour_b, active) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
          [owner.business_id, name, pricePaise, a, b, active]
        )).rows[0].id;
        for (const o of outlets) await t.query("INSERT INTO outlet_stock (outlet_id, item_id, stock) VALUES ($1, $2, 0) ON CONFLICT DO NOTHING", [o, id]);
        return id;
      }

      for (const f of flavours) {
        const name = str(f["Name"]).slice(0, 40);
        if (!name) continue;
        const colourA = /^#[0-9a-f]{6}$/i.test(str(f["Colour 1"])) ? str(f["Colour 1"]) : "#F2C230";
        const colourB = /^#[0-9a-f]{6}$/i.test(str(f["Colour 2"])) ? str(f["Colour 2"]) : colourA;
        const active = !/^(no|n|false|0)$/i.test(str(f["On menu"]));
        const id = await ensureItem(name, Math.max(100, Math.round(num(f["Price (₹)"]) * 100)), active, colourA, colourB);
        idMap.set(str(f["Flavour ID"]), { id, name });
        const stock = Math.max(0, Math.round(num(f["In stock"])));
        await t.query("UPDATE outlet_stock SET stock = $3 WHERE outlet_id = $1 AND item_id = $2", [outlet.id, id, stock]);
        await t.query(
          `INSERT INTO stock_log (business_id, outlet_id, item_id, item_name, change, reason, stock_after, user_id)
           VALUES ($1, $2, $3, $4, $5, 'Imported from Excel', $5, $6)`,
          [owner.business_id, outlet.id, id, name, stock, owner.id]
        );
      }

      const linesByBill = new Map();
      for (const l of lines) {
        const no = Math.round(num(l["Bill no"]));
        if (!linesByBill.has(no)) linesByBill.set(no, []);
        linesByBill.get(no).push(l);
      }

      let maxNo = 1000, imported = 0;
      for (const b of bills) {
        const no = Math.round(num(b["Bill no"]));
        const date = day(b["Date"]);
        if (!no || !date) continue;
        const payment = ["Cash", "UPI", "Card"].includes(str(b["Payment"])) ? str(b["Payment"]) : "Cash";
        const its = linesByBill.get(no) || [];
        const qty = its.reduce((s, l) => s + Math.round(num(l["Quantity"])), 0) || Math.round(num(b["Pops"])) || 1;
        const totalPaise = Math.round(num(b["Total (₹)"]) * 100);
        const billId = (await t.query(
          `INSERT INTO bills (business_id, outlet_id, bill_no, created_at, customer_name, customer_phone, payment_method, qty, total_paise, created_by)
           VALUES ($1, $2, $3, ($4 || ' ' || $5)::timestamp AT TIME ZONE $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
          [owner.business_id, outlet.id, no, date, time(b["Time"]), owner.timezone,
            str(b["Customer"]).slice(0, 40), str(b["Mobile"]).replace(/\D/g, "").slice(-10), payment, qty, totalPaise, owner.id]
        )).rows[0].id;
        let lineNo = 0;
        for (const l of its) {
          const old = idMap.get(str(l["Flavour ID"]));
          const name = str(l["Flavour"]) || (old && old.name) || "Unknown item";
          const price = Math.round(num(l["Unit price (₹)"]) * 100);
          const itemId = old ? old.id : await ensureItem(name, Math.max(100, price), false, "#9AA9AD", "#9AA9AD");
          const q = Math.max(1, Math.round(num(l["Quantity"])));
          await t.query(
            `INSERT INTO bill_items (bill_id, line_no, item_id, item_name, qty, unit_price_paise, line_total_paise)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [billId, ++lineNo, itemId, name, q, price, Math.round(num(l["Line total (₹)"]) * 100) || q * price]
          );
        }
        maxNo = Math.max(maxNo, no);
        imported += 1;
      }
      await t.query("UPDATE businesses SET next_bill_no = GREATEST(next_bill_no, $2) WHERE id = $1", [owner.business_id, maxNo + 1]);
      return { flavours: idMap.size, bills: imported, nextBill: maxNo + 1 };
    });

    console.log(`Imported into ${owner.name}, ${outlet.name}: ${summary.flavours} flavours with stock, ${summary.bills} bills. The next bill will be number ${summary.nextBill}.`);
  } finally {
    await db.close();
  }
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
