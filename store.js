// Shared helpers for the Icepops pages. Menu, stock and sales live in the
// server's database; only the counter's unfinished cart is kept in this browser.

const CURRENCY = "₹";
const LOW_STOCK = 3; // At or below this many, a flavour is marked "Low".
const PAYMENTS = ["Cash", "UPI", "Card"];

// Set to true to make the customer's name and mobile number required at checkout.
const REQUIRE_CUSTOMER = false;

// Filled in by startPage() from the logged-in business. Printed on e-bills.
let SHOP = { name: "", address: "", phone: "", gstin: "" };
let ME = null;

async function api(path, options = {}) {
  const method = options.method || "GET";
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: method === "GET" ? {} : { "Content-Type": "application/json" },
      body: method === "GET" ? undefined : JSON.stringify(options.body || {})
    });
  } catch (e) {
    throw new Error(location.protocol === "file:"
      ? "This page needs the Icepops server. Run npm start in the icepops folder, then open http://localhost:8000/."
      : "Can't reach the server. Check your internet connection, then reload this page.");
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !options.noRedirect) {
    location.href = `login.html?next=${encodeURIComponent(location.pathname.slice(1) + location.search)}`;
    throw new Error("Please log in.");
  }
  if (!res.ok) {
    const err = new Error(data.error || `The server answered with an error (${res.status}).`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

// ---------- Page start: who is logged in, the page menu and the plan banner ----------

const PAGE_LINKS = [
  ["counter", "index.html", "Counter", "sell"],
  ["inventory", "admin-index.html", "Inventory", "inventory"],
  ["reports", "reports.html", "Reports", "reports"],
  ["account", "account.html", "Account", "account"]
];
const PAGE_NEEDS = { counter: "sell", inventory: "inventory", reports: "reports", account: "account", bill: "viewBills" };

async function startPage(page) {
  try {
    ME = await api("/api/me");
  } catch (e) {
    showBanner(e.message);
    return null;
  }
  const need = PAGE_NEEDS[page];
  if (need && !ME.permissions[need]) {
    location.replace("index.html");
    return null;
  }
  SHOP = { name: ME.business.name, address: ME.business.address, phone: ME.business.phone, gstin: ME.business.gstin };
  renderNav(page);
  renderPlanBanner();
  const eyebrow = document.querySelector(".eyebrow");
  if (eyebrow) eyebrow.textContent = [ME.business.name, ME.outlet && ME.outlet.name].filter(Boolean).join(" · ");
  return ME;
}

function renderNav(page) {
  const nav = document.getElementById("nav");
  if (!nav) return;
  const links = PAGE_LINKS.filter(([, , , perm]) => ME.permissions[perm]).map(([key, href, label]) =>
    `<a class="nav-link quiet" href="${href}"${key === page ? ' aria-current="page"' : ""}>${label}</a>`);
  const switcher = ME.permissions.switchOutlet && ME.outlets.length > 1
    ? `<label class="outlet-switch" for="outlet-switch"><span class="sr-only">Outlet</span>
        <select id="outlet-switch">${ME.outlets.map((o) => `<option value="${esc(o.id)}"${ME.outlet && o.id === ME.outlet.id ? " selected" : ""}>${esc(o.name)}</option>`).join("")}</select>
      </label>`
    : "";
  nav.innerHTML = links.join("") + switcher +
    `<button class="nav-link quiet" type="button" id="logout" title="Logged in as ${esc(ME.user.name)} (${esc(ME.user.role)})">Log out</button>`;

  const sel = document.getElementById("outlet-switch");
  if (sel) sel.addEventListener("change", async () => {
    try { await api("/api/me/outlet", { method: "POST", body: { outletId: sel.value } }); location.reload(); }
    catch (e) { showBanner(e.message); }
  });
  document.getElementById("logout").addEventListener("click", async () => {
    try { await api("/api/auth/logout", { method: "POST", noRedirect: true }); } catch (e) { /* logged out anyway */ }
    location.href = "login.html";
  });
}

function renderPlanBanner() {
  const el = document.getElementById("plan-banner");
  if (!el) return;
  const a = ME.access;
  const owner = ME.permissions.account;
  const link = owner ? ` <a href="account.html#plan">Choose a plan</a>` : " Ask the owner to choose a plan.";
  let html = "", tone = "";
  if (!a.ok) { html = esc(a.message.replace(" on the Account page", "")) + link; tone = "bad"; }
  else if (a.state === "trial") { html = `Free trial: ${a.daysLeft} day${a.daysLeft === 1 ? "" : "s"} left on the ${esc(ME.plan.name)} plan.` + (owner ? link : ""); tone = a.daysLeft <= 3 ? "warn" : ""; }
  else if (a.inGrace) { html = "Your last payment didn't go through. Billing stops in a few days." + (owner ? ` <a href="account.html#plan">Pay now</a>` : ""); tone = "bad"; }
  else if (a.cancelling) { html = `Your ${esc(ME.plan.name)} plan ends on ${fmtLongDate(a.endsAt)}.` + (owner ? ` <a href="account.html#plan">Renew</a>` : ""); tone = "warn"; }
  el.innerHTML = html;
  el.className = "plan-banner" + (tone ? " " + tone : "");
  el.hidden = !html;
}

function fmtLongDate(iso) {
  return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" });
}

// One cart per outlet, so two businesses on one browser never mix orders.
function cartKey() { return `icepops-cart-v3-${ME && ME.outlet ? ME.outlet.id : "none"}`; }

function loadCart() {
  try {
    const saved = JSON.parse(localStorage.getItem(cartKey()));
    if (saved && saved.order && typeof saved.order === "object") {
      const c = saved.customer || {};
      return {
        order: { ...saved.order },
        payment: PAYMENTS.includes(saved.payment) ? saved.payment : "Cash",
        customer: { name: String(c.name || ""), phone: String(c.phone || "") }
      };
    }
  } catch (e) { /* storage blocked or corrupt */ }
  return { order: {}, payment: "Cash", customer: { name: "", phone: "" } };
}

// Mobile numbers: 10 digits, with +91 or a leading 0 removed.
function cleanPhone(v) {
  let d = String(v || "").replace(/\D/g, "");
  if (d.length === 12 && d.startsWith("91")) d = d.slice(2);
  else if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
  return d;
}
function validPhone(d) { return /^[6-9]\d{9}$/.test(d); }
function formatPhone(d) { return d && d.length === 10 ? `${d.slice(0, 5)} ${d.slice(5)}` : (d || ""); }

function billDate(bill) {
  const [y, m, d] = bill.date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-IN", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" });
}

// Plain-text e-bill for WhatsApp and copying.
function billText(bill, items) {
  const lines = [`*${SHOP.name}* e-bill`, `Bill ${bill.billNo}, ${billDate(bill)} ${bill.time}`];
  if (bill.customer) lines.push(`Customer: ${bill.customer}`);
  lines.push("");
  items.forEach((i) => lines.push(`${i.qty} × ${i.flavour} @ ${money(i.price)} = ${money(i.lineTotal)}`));
  lines.push("", `*Total: ${money(bill.total)}* (${pops(bill.qty)})`, `Paid by ${bill.payment}`, "", "Thank you! Please visit again.");
  return lines.join("\n");
}
function whatsappLink(bill, items) {
  return bill.phone ? `https://wa.me/91${bill.phone}?text=${encodeURIComponent(billText(bill, items))}` : "";
}

// ---------- PDF bills ----------
// A WhatsApp link can only fill in text, so the PDF is attached by hand:
// on a phone or tablet the share sheet attaches it; on a computer it downloads
// and the customer's chat opens, ready for the file to be dropped in.

function pdfName(bill) { return `${String(SHOP.name).replace(/[^A-Za-z0-9]+/g, "-")}-bill-${bill.billNo}.pdf`; }
function pdfUrl(bill, download) { return `/api/bills/${bill.billNo}/pdf${download ? "?download=1" : ""}`; }

function pdfChatLink(bill) {
  if (!bill.phone) return "";
  const hi = bill.customer ? `Hi ${bill.customer}, here` : "Hi, here";
  const text = `${hi} is your ${SHOP.name} bill ${bill.billNo} for ${money(bill.total)}. The PDF is attached. Thank you!`;
  return `https://wa.me/91${bill.phone}?text=${encodeURIComponent(text)}`;
}

// Touch devices that can share files get the share sheet; computers get download + chat.
const SHARE_FILES = (() => {
  try {
    return matchMedia("(pointer: coarse)").matches && !!navigator.canShare &&
      navigator.canShare({ files: [new File(["x"], "test.pdf", { type: "application/pdf" })] });
  } catch (e) { return false; }
})();

// The share sheet must open straight from the tap, so fetch the PDF ahead of time.
const pdfCache = new Map();
function prefetchPdf(bill) {
  if (!SHARE_FILES || pdfCache.has(bill.billNo)) return;
  fetch(pdfUrl(bill))
    .then((r) => (r.ok ? r.blob() : null))
    .then((b) => { if (b) pdfCache.set(bill.billNo, new File([b], pdfName(bill), { type: "application/pdf" })); })
    .catch(() => {});
}

// Click handler for a "Send PDF on WhatsApp" link whose href is pdfChatLink(bill).
// Returns what to tell the person at the counter.
function sendPdfOnWhatsApp(e, bill) {
  const file = pdfCache.get(bill.billNo);
  if (SHARE_FILES && file) {
    e.preventDefault();
    navigator.share({ files: [file], title: `Bill ${bill.billNo}` }).catch(() => {});
    return "Choose WhatsApp, pick the customer's chat, then press Send.";
  }
  const a = document.createElement("a");
  a.href = pdfUrl(bill, true);
  a.download = pdfName(bill);
  document.body.appendChild(a);
  a.click();
  a.remove();
  return `${pdfName(bill)} is downloading. In the WhatsApp chat that opens, drag the PDF in (or use the paperclip, then Document) and press Send.`;
}
function saveCart(cart) {
  try { localStorage.setItem(cartKey(), JSON.stringify(cart)); } catch (e) { /* the page still works without saving */ }
}

function showBanner(msg) {
  const el = document.getElementById("banner");
  if (!el) return;
  el.textContent = msg || "";
  el.hidden = !msg;
}

function money(n) { return CURRENCY + Math.round(n).toLocaleString("en-IN"); }
function pops(n) { return n + (n === 1 ? " item" : " items"); }
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function stockState(left) {
  if (left <= 0) return { cls: "out", text: "Sold out" };
  if (left <= LOW_STOCK) return { cls: "low", text: "Low" };
  return { cls: "ok", text: "In stock" };
}

// Picture for any menu item, by its kind. All share one tall viewBox so cards line up.
const KIND_LABELS = { pop: "Ice pop", cup: "Drink (cup)", fries: "Fries box", dessert: "Dessert slice", plate: "Plate (anything else)" };
function itemArt(f, scope) {
  const a = esc(f.a || "#F2C230");
  const b = esc(f.b || f.a || "#F2C230");
  const ground = `<ellipse cx="30" cy="108" rx="24" ry="3" fill="#000" opacity=".08"/>`;
  switch (f.kind) {
    case "cup":
      return `<svg viewBox="0 0 60 112" aria-hidden="true">${ground}
        <path d="M37 38 44 6" stroke="${b}" stroke-width="4" stroke-linecap="round"/>
        <path d="M13 42h34l-4 60a5 5 0 0 1-5 5H22a5 5 0 0 1-5-5z" fill="${a}" stroke="rgba(0,0,0,.12)"/>
        <rect x="15.5" y="62" width="29" height="16" fill="#fff" opacity=".35"/>
        <rect x="9" y="34" width="42" height="9" rx="3.5" fill="#fff" stroke="rgba(0,0,0,.15)"/>
      </svg>`;
    case "fries": {
      // A box close to fries-yellow would hide the fries, so use red instead.
      const rgb = (h) => [1, 3, 5].map((i) => parseInt(String(h).slice(i, i + 2), 16));
      const [r1, g1, b1] = rgb(f.a || "#F2C230"), [r2, g2, b2] = [244, 196, 48];
      const box = Math.hypot(r1 - r2, g1 - g2, b1 - b2) < 90 ? "#D9342B" : a;
      return `<svg viewBox="0 0 60 112" aria-hidden="true">${ground}
        ${[[15, 30, -8], [21, 22, -3], [27, 26, 2], [33, 20, 5], [39, 28, 9], [24, 34, 0], [35, 33, 4]]
          .map(([x, y, r]) => `<rect x="${x}" y="${y}" width="6" height="40" rx="2" fill="#F4C430" stroke="#D9A21B" stroke-width=".8" transform="rotate(${r} ${x + 3} ${y + 20})"/>`).join("")}
        <path d="M11 56q19 9 38 0l-5 49a3 3 0 0 1-3 3H19a3 3 0 0 1-3-3z" fill="${box}" stroke="rgba(0,0,0,.12)"/>
        <path d="M21 70h18" stroke="#fff" stroke-width="3" stroke-linecap="round" opacity=".55"/>
      </svg>`;
    }
    case "dessert":
      return `<svg viewBox="0 0 60 112" aria-hidden="true">${ground}
        <rect x="8" y="64" width="44" height="40" rx="5" fill="${a}" stroke="rgba(0,0,0,.12)"/>
        <rect x="8" y="58" width="44" height="13" rx="5" fill="${b}"/>
        <rect x="8" y="58" width="44" height="13" rx="5" fill="#fff" opacity="${a === b ? ".22" : "0"}"/>
        <path d="M14 66c3 8 6 8 8 0s5 9 8 0 6 7 8 0 5 6 8 0" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" opacity=".55"/>
        <circle cx="30" cy="52" r="5" fill="#C4184F"/>
      </svg>`;
    case "plate":
      return `<svg viewBox="0 0 60 112" aria-hidden="true">
        <ellipse cx="30" cy="100" rx="28" ry="8" fill="#fff" stroke="rgba(0,0,0,.15)"/>
        <path d="M10 98a20 20 0 0 1 40 0z" fill="${a}" stroke="rgba(0,0,0,.12)"/>
        <circle cx="24" cy="84" r="4" fill="${b}"/><circle cx="35" cy="88" r="3" fill="${b}"/>
        <path d="M17 90a14 14 0 0 1 8-12" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" opacity=".5"/>
      </svg>`;
    default:
      return popArt(f, scope);
  }
}

// "2 × 1.5 tbsp" → "3 tbsp": amounts in a recipe multiplied by how many were ordered.
function scaledQty(qty, times) {
  if (qty == null) return "";
  const n = Math.round(qty * times * 100) / 100;
  return String(n);
}

// Making instructions as HTML, for one portion or scaled to an order quantity.
function recipeHtml(f, times = 1) {
  const r = f.recipe || { ingredients: [], steps: [] };
  if (!r.ingredients.length && !r.steps.length) {
    return `<p class="recipe-empty">No making instructions yet. A manager can add them on the Inventory page.</p>`;
  }
  const ing = r.ingredients.map((i) => {
    const amount = [scaledQty(i.qty, times), i.unit].filter(Boolean).join(" ");
    return `<li>${amount ? `<b>${esc(amount)}</b> ` : ""}${esc(i.name)}</li>`;
  }).join("");
  const steps = r.steps.map((x) => `<li>${esc(x)}</li>`).join("");
  return `${ing ? `<h4 class="recipe-h">Ingredients${times > 1 ? ` for ${times}` : ""}</h4><ul class="recipe-ing">${ing}</ul>` : ""}
    ${steps ? `<h4 class="recipe-h">Steps</h4><ol class="recipe-steps">${steps}</ol>` : ""}`;
}

function popArt(f, scope) {
  const g = `g-${scope}-${esc(f.id)}`;
  return `<svg viewBox="0 0 60 112" aria-hidden="true">
    <defs><linearGradient id="${g}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${esc(f.a)}"/><stop offset=".56" stop-color="${esc(f.a)}"/>
      <stop offset=".56" stop-color="${esc(f.b)}"/><stop offset="1" stop-color="${esc(f.b)}"/>
    </linearGradient></defs>
    <rect x="24" y="74" width="12" height="36" rx="6" fill="var(--stick)"/>
    <path d="M8 27a22 22 0 0 1 44 0v50a6 6 0 0 1-6 6H14a6 6 0 0 1-6-6z" fill="url(#${g})" stroke="rgba(0,0,0,.12)" stroke-width="1"/>
    <rect x="20" y="24" width="5" height="46" rx="2.5" fill="#000" opacity=".1"/>
    <rect x="35" y="24" width="5" height="46" rx="2.5" fill="#000" opacity=".1"/>
    <path d="M14 30a16 16 0 0 1 9-14" fill="none" stroke="#fff" stroke-width="3.5" stroke-linecap="round" opacity=".6"/>
  </svg>`;
}
