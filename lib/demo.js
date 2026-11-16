"use strict";
// Demo database: runs sql/demo_seed.sql, then adds about two years of example
// sales with summer peaks, busier weekends and afternoons.

const crypto = require("crypto");

const BUSINESS = "00000000-0000-4000-8000-000000000001";
const OUTLET = "00000000-0000-4000-8000-000000000101";
const CASHIER = "00000000-0000-4000-8000-000000000202";

async function ensureDemo(db, runSqlFile) {
  const exists = (await db.query("SELECT 1 FROM businesses WHERE id = $1", [BUSINESS])).rows[0];
  if (exists) return;
  await runSqlFile(db, "demo_seed.sql");

  const items = (await db.query("SELECT id, name, price_paise FROM items WHERE business_id = $1 ORDER BY id", [BUSINESS])).rows;
  const weightByName = { "Alphonso Mango": 1.7, "Strawberry": 1, "Orange Bar": 0.9, "Kala Khatta": 1.15, "Rose Milk": 0.7, "Lychee": 0.55, "Chilli Guava": 0.8, "Tender Coconut": 0.95 };

  let s = 20261116;
  const rand = () => { s |= 0; s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const pick = (weights) => { const total = weights.reduce((a, w) => a + w[1], 0); let r = rand() * total; for (const [v, w] of weights) { if ((r -= w) <= 0) return v; } return weights[0][0]; };
  const pad = (n) => String(n).padStart(2, "0");

  const season = [0.55, 0.65, 0.95, 1.4, 1.65, 1.5, 1.1, 1.0, 1.0, 0.9, 0.7, 0.6];
  const itemWeights = items.map((i) => [i, weightByName[i.name] || 1]);
  const hourWeights = [[11, 1], [12, 2], [13, 3], [14, 4], [15, 5], [16, 5.5], [17, 4.5], [18, 3.5], [19, 3], [20, 2], [21, 1]];
  const payWeights = [["UPI", 0.58], ["Cash", 0.32], ["Card", 0.10]];
  const names = ["Priya", "Arjun", "Meera", "Rahul", "Ananya", "Karthik", "Divya", "Vikram", "Sneha", "Rohan"];

  // Shop time is India Standard Time (UTC+5:30).
  const nowIst = new Date(Date.now() + 5.5 * 3600000);
  const today = nowIst.toISOString().slice(0, 10);
  const bills = [];
  for (let t = Date.UTC(2025, 0, 1); ; t += 86400000) {
    const d = new Date(t);
    const date = d.toISOString().slice(0, 10);
    if (date > today) break;
    const weekend = d.getUTCDay() === 0 || d.getUTCDay() === 6;
    const growth = d.getUTCFullYear() === 2026 ? 1.18 : 1;
    const count = Math.round(9 * season[d.getUTCMonth()] * (weekend ? 1.35 : 1) * growth * (0.7 + rand() * 0.6));
    for (let i = 0; i < count; i++) {
      const hour = pick(hourWeights);
      if (date === today && hour >= nowIst.getUTCHours()) continue;
      const lines = new Map();
      const kinds = pick([[1, 0.55], [2, 0.32], [3, 0.13]]);
      for (let k = 0; k < kinds; k++) {
        const it = pick(itemWeights);
        lines.set(it, (lines.get(it) || 0) + pick([[1, 0.6], [2, 0.3], [3, 0.1]]));
      }
      const named = rand() < 0.35;
      bills.push({
        at: `${date}T${pad(hour)}:${pad(Math.floor(rand() * 60))}:00+05:30`,
        payment: pick(payWeights),
        customer: named ? names[Math.floor(rand() * names.length)] : "",
        phone: named ? `9${String(Math.floor(rand() * 1e9)).padStart(9, "0")}` : "",
        lines
      });
    }
  }
  bills.sort((x, y) => x.at.localeCompare(y.at));

  // Insert in batches with arrays, which is far faster than one row at a time.
  let billNo = 1000;
  for (let start = 0; start < bills.length; start += 1000) {
    const batch = bills.slice(start, start + 1000);
    const b = { id: [], no: [], at: [], name: [], phone: [], pay: [], qty: [], total: [] };
    const li = { bill: [], line: [], item: [], name: [], qty: [], price: [], total: [] };
    for (const bill of batch) {
      const id = crypto.randomUUID();
      billNo += 1;
      let qty = 0, total = 0, line = 0;
      for (const [it, q] of bill.lines) {
        qty += q;
        total += q * it.price_paise;
        li.bill.push(id); li.line.push(++line); li.item.push(it.id); li.name.push(it.name);
        li.qty.push(q); li.price.push(it.price_paise); li.total.push(q * it.price_paise);
      }
      b.id.push(id); b.no.push(billNo); b.at.push(bill.at); b.name.push(bill.customer); b.phone.push(bill.phone);
      b.pay.push(bill.payment); b.qty.push(qty); b.total.push(total);
    }
    await db.tx(async (t) => {
      await t.query(
        `INSERT INTO bills (id, business_id, outlet_id, bill_no, created_at, customer_name, customer_phone, payment_method, qty, total_paise, created_by)
         SELECT u.id, $1, $2, u.no, u.at, u.name, u.phone, u.pay, u.qty, u.total, $3
           FROM unnest($4::uuid[], $5::int[], $6::timestamptz[], $7::text[], $8::text[], $9::text[], $10::int[], $11::int[])
             AS u(id, no, at, name, phone, pay, qty, total)`,
        [BUSINESS, OUTLET, CASHIER, b.id, b.no, b.at, b.name, b.phone, b.pay, b.qty, b.total]
      );
      await t.query(
        `INSERT INTO bill_items (bill_id, line_no, item_id, item_name, qty, unit_price_paise, line_total_paise)
         SELECT * FROM unnest($1::uuid[], $2::int[], $3::uuid[], $4::text[], $5::int[], $6::int[], $7::int[])`,
        [li.bill, li.line, li.item, li.name, li.qty, li.price, li.total]
      );
    });
  }
  await db.query("UPDATE businesses SET next_bill_no = $2 WHERE id = $1", [BUSINESS, billNo + 1]);
  console.log(`Demo database created with ${bills.length} example bills.`);
}

module.exports = { ensureDemo };
