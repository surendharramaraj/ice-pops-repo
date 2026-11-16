// Report calculations for reports.html. Pure functions over the Bills and
// Bill items sheets, so they can be checked outside the browser:
//   node -e "const A=require('./analytics.js'); ..."
// Dates are "YYYY-MM-DD" strings and times are "HH:MM", in the shop's local time.

(function (root) {
  const DAY = 86400000;
  const pad = (n) => String(n).padStart(2, "0");

  const parseDay = (s) => { const [y, m, d] = s.split("-").map(Number); return Date.UTC(y, m - 1, d); };
  const fmtDay = (t) => new Date(t).toISOString().slice(0, 10);
  const addDays = (s, n) => fmtDay(parseDay(s) + n * DAY);
  const daysIn = (r) => Math.round((parseDay(r.to) - parseDay(r.from)) / DAY) + 1;
  const weekday = (s) => (new Date(parseDay(s)).getUTCDay() + 6) % 7; // Monday = 0
  function localToday(d = new Date()) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }

  const PRESETS = [
    { key: "today", label: "Today" },
    { key: "yesterday", label: "Yesterday" },
    { key: "7d", label: "Last 7 days" },
    { key: "30d", label: "Last 30 days" },
    { key: "month", label: "This month" },
    { key: "lastmonth", label: "Last month" },
    { key: "year", label: "This year" },
    { key: "lastyear", label: "Last year" },
    { key: "all", label: "All time" }
  ];

  function presetRange(key, today, firstDay) {
    switch (key) {
      case "today": return { from: today, to: today };
      case "yesterday": { const y = addDays(today, -1); return { from: y, to: y }; }
      case "7d": return { from: addDays(today, -6), to: today };
      case "30d": return { from: addDays(today, -29), to: today };
      case "month": return { from: today.slice(0, 8) + "01", to: today };
      case "lastmonth": { const end = addDays(today.slice(0, 8) + "01", -1); return { from: end.slice(0, 8) + "01", to: end }; }
      case "year": return { from: today.slice(0, 4) + "-01-01", to: today };
      case "lastyear": { const y = Number(today.slice(0, 4)) - 1; return { from: `${y}-01-01`, to: `${y}-12-31` }; }
      default: return { from: firstDay && firstDay < today ? firstDay : today, to: today };
    }
  }

  // The same number of days just before the range, for "vs previous period".
  function previousRange(r) {
    const n = daysIn(r);
    return { from: addDays(r.from, -n), to: addDays(r.from, -1) };
  }

  const within = (rows, r) => rows.filter((x) => x.date >= r.from && x.date <= r.to);

  function summarize(bills) {
    let sales = 0, qty = 0;
    for (const b of bills) { sales += b.total; qty += b.qty; }
    return { sales, qty, bills: bills.length, avg: bills.length ? sales / bills.length : 0 };
  }

  // Fractional change, or null when there is nothing to compare with.
  function change(cur, prev) {
    if (!prev) return null;
    return (cur - prev) / prev;
  }

  function keyOf(date, unit) {
    if (unit === "day") return date;
    if (unit === "month") return date.slice(0, 7);
    return date.slice(0, 4);
  }

  function bucketKeys(r, unit) {
    const keys = [];
    if (unit === "day") {
      for (let d = r.from; d <= r.to; d = addDays(d, 1)) keys.push(d);
    } else if (unit === "month") {
      let y = Number(r.from.slice(0, 4)), m = Number(r.from.slice(5, 7));
      const end = r.to.slice(0, 7);
      for (;;) {
        const k = `${y}-${pad(m)}`;
        keys.push(k);
        if (k >= end) break;
        m += 1;
        if (m > 12) { m = 1; y += 1; }
      }
    } else {
      for (let y = Number(r.from.slice(0, 4)); y <= Number(r.to.slice(0, 4)); y++) keys.push(String(y));
    }
    return keys;
  }

  // One entry per day, month or year in the range, including empty ones.
  function trend(bills, r, unit) {
    const map = new Map(bucketKeys(r, unit).map((k) => [k, { key: k, sales: 0, bills: 0, qty: 0 }]));
    for (const b of bills) {
      const e = map.get(keyOf(b.date, unit));
      if (e) { e.sales += b.total; e.bills += 1; e.qty += b.qty; }
    }
    return [...map.values()].map((e) => ({ ...e, avg: e.bills ? e.sales / e.bills : 0 }));
  }

  function byFlavour(items, flavours) {
    const known = new Map(flavours.map((f) => [f.id, f]));
    const map = new Map();
    for (const it of items) {
      let e = map.get(it.flavourId);
      if (!e) {
        const f = known.get(it.flavourId);
        e = { id: it.flavourId, name: f ? f.name : it.flavour, a: f ? f.a : "#9AA9AD", b: f ? f.b : "#9AA9AD", active: f ? f.active !== false : false, qty: 0, sales: 0, billSet: new Set() };
        map.set(it.flavourId, e);
      }
      e.qty += it.qty;
      e.sales += it.lineTotal;
      e.billSet.add(it.billNo);
    }
    const total = [...map.values()].reduce((s, e) => s + e.sales, 0);
    return [...map.values()]
      .map(({ billSet, ...e }) => ({ ...e, bills: billSet.size, share: total ? e.sales / total : 0 }))
      .sort((x, y) => y.sales - x.sales || y.qty - x.qty);
  }

  // Sales per menu category. Items sold before categories existed count as "Other".
  function byCategory(items, flavours) {
    const categoryOf = new Map(flavours.map((f) => [f.id, f.category || "Other"]));
    const map = new Map();
    for (const it of items) {
      const name = categoryOf.get(it.flavourId) || "Other";
      const e = map.get(name) || { name, qty: 0, sales: 0 };
      e.qty += it.qty;
      e.sales += it.lineTotal;
      map.set(name, e);
    }
    const total = [...map.values()].reduce((s, e) => s + e.sales, 0);
    return [...map.values()].map((e) => ({ ...e, share: total ? e.sales / total : 0 })).sort((x, y) => y.sales - x.sales);
  }

  const PAYMENT_ORDER = ["UPI", "Cash", "Card"];
  function byPayment(bills) {
    const map = new Map(PAYMENT_ORDER.map((p) => [p, { method: p, sales: 0, bills: 0 }]));
    for (const b of bills) {
      const k = map.has(b.payment) ? b.payment : "Other";
      if (!map.has(k)) map.set(k, { method: k, sales: 0, bills: 0 });
      const e = map.get(k);
      e.sales += b.total;
      e.bills += 1;
    }
    const total = bills.reduce((s, b) => s + b.total, 0);
    return [...map.values()].map((e) => ({ ...e, share: total ? e.sales / total : 0 }));
  }

  function byHour(bills) {
    const hours = Array.from({ length: 24 }, (_, h) => ({ hour: h, sales: 0, bills: 0, qty: 0 }));
    for (const b of bills) {
      const h = parseInt(b.time, 10);
      if (h >= 0 && h < 24) { hours[h].sales += b.total; hours[h].bills += 1; hours[h].qty += b.qty; }
    }
    return hours;
  }

  // Average sales per day for each weekday, so a range with more Saturdays isn't favoured.
  function byWeekday(bills, r) {
    const names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    const days = names.map(() => 0);
    for (let d = r.from; d <= r.to; d = addDays(d, 1)) days[weekday(d)] += 1;
    const rows = names.map((name, i) => ({ name, days: days[i], sales: 0, bills: 0 }));
    for (const b of bills) { const e = rows[weekday(b.date)]; e.sales += b.total; e.bills += 1; }
    return rows.map((e) => ({ ...e, avg: e.days ? e.sales / e.days : 0 }));
  }

  function bestDay(bills) {
    const map = new Map();
    for (const b of bills) map.set(b.date, (map.get(b.date) || 0) + b.total);
    let best = null;
    for (const [date, sales] of map) if (!best || sales > best.sales) best = { date, sales };
    return best;
  }

  // Year-wise totals for all data. The current year is compared with the same dates last year.
  function yearly(bills, today) {
    const years = [...new Set(bills.map((b) => b.date.slice(0, 4)))].sort();
    const thisYear = today.slice(0, 4);
    return years.map((y) => {
      const cur = summarize(bills.filter((b) => b.date.slice(0, 4) === y));
      const py = String(Number(y) - 1);
      const partial = y === thisYear;
      const prevBills = bills.filter((b) => b.date.slice(0, 4) === py && (!partial || b.date.slice(5) <= today.slice(5)));
      const prev = prevBills.length ? summarize(prevBills) : null;
      return { year: y, partial, ...cur, growth: prev ? change(cur.sales, prev.sales) : null };
    });
  }

  const api = {
    PRESETS, PAYMENT_ORDER, parseDay, fmtDay, addDays, daysIn, weekday, localToday,
    presetRange, previousRange, within, summarize, change, keyOf, bucketKeys, trend,
    byFlavour, byCategory, byPayment, byHour, byWeekday, bestDay, yearly
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Analytics = api;
})(this);
