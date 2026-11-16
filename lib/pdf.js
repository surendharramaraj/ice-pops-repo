"use strict";
// PDF bill: an 80 mm till-receipt page, as tall as its content.
// DejaVu Sans is used because the PDF's built-in fonts have no ₹ sign.

const path = require("path");
const PDFDocument = require("pdfkit");

const FONT_DIR = path.join(__dirname, "..", "node_modules", "dejavu-fonts-ttf", "ttf");
const PDF_W = 227; // 80 mm
const PDF_M = 16;

const rupees = (n) => "₹" + (Math.round(n * 100) / 100).toLocaleString("en-IN");
const fmtPhone = (d) => (d && d.length === 10 ? `${d.slice(0, 5)} ${d.slice(5)}` : d || "");
function fmtDate(s) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-IN", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" });
}
function pdfFileName(shop, bill) { return `${String(shop.name).replace(/[^A-Za-z0-9]+/g, "-")}-bill-${bill.billNo}.pdf`; }

// Draws the bill and returns the y position where it ends.
function drawBill(doc, shop, bill, items) {
  const W = PDF_W, M = PDF_M, inner = W - 2 * M;
  const ink = "#10343D", muted = "#4A6A72", accent = "#C4184F", rule = "#9FC3C8";
  const dashed = (yy) => doc.save().moveTo(M, yy).lineTo(W - M, yy).dash(3, { space: 2 }).lineWidth(0.8).strokeColor(rule).stroke().restore();
  let y = M + 2;

  doc.font("bold").fontSize(20).fillColor(accent).text(shop.name, M, y, { width: inner, align: "center" });
  y = doc.y + 2;
  const shopLines = [shop.outletName, shop.address, shop.phone && `Phone ${shop.phone}`, shop.gstin && `GSTIN ${shop.gstin}`].filter(Boolean);
  doc.font("regular").fontSize(8).fillColor(muted);
  for (const l of shopLines) { doc.text(l, M, y, { width: inner, align: "center" }); y = doc.y + 1; }
  doc.fontSize(7).text("E-BILL", M, y + 4, { width: inner, align: "center", characterSpacing: 1.5 });
  y = doc.y + 8;
  dashed(y);
  y += 9;

  const meta = [
    ["Bill no", String(bill.billNo)],
    ["Date", `${fmtDate(bill.date)}, ${bill.time}`],
    bill.customer && ["Customer", bill.customer],
    bill.phone && ["Mobile", fmtPhone(bill.phone)]
  ].filter(Boolean);
  for (const [k, v] of meta) {
    doc.font("regular").fontSize(8.5).fillColor(muted).text(k, M, y, { width: 64 });
    doc.font("bold").fillColor(ink).text(v, M + 64, y, { width: inner - 64, align: "right" });
    y = doc.y + 3;
  }
  y += 3;
  dashed(y);
  y += 9;

  const amountW = 64;
  for (const i of items) {
    doc.font("regular").fontSize(9).fillColor(ink).text(rupees(i.lineTotal), W - M - amountW, y, { width: amountW, align: "right" });
    doc.font("bold").fontSize(9).fillColor(ink).text(i.flavour, M, y, { width: inner - amountW - 6 });
    doc.font("regular").fontSize(8).fillColor(muted).text(`${i.qty} × ${rupees(i.price)}`, M, doc.y + 1, { width: inner - amountW - 6 });
    y = doc.y + 7;
  }
  dashed(y);
  y += 10;

  doc.font("regular").fontSize(8).fillColor(muted).text("TOTAL", M, y + 9, { characterSpacing: 1 });
  doc.font("bold").fontSize(20).fillColor(accent).text(rupees(bill.total), M, y, { width: inner, align: "right" });
  y = doc.y + 3;
  doc.font("regular").fontSize(8.5).fillColor(muted).text(`${bill.qty} ${bill.qty === 1 ? "item" : "items"}`, M, y);
  doc.text(`Paid by ${bill.payment}`, M, y, { width: inner, align: "right" });
  y = doc.y + 14;
  doc.font("bold").fontSize(8).fillColor(ink).text("Thank you! Please visit again.", M, y, { width: inner, align: "center" });
  return doc.y;
}

function billPdf(shop, bill, items) {
  const make = (height) => {
    const doc = new PDFDocument({
      size: [PDF_W, height],
      margins: { top: PDF_M, bottom: 0, left: PDF_M, right: PDF_M },
      info: { Title: `${shop.name} bill ${bill.billNo}`, Author: shop.name }
    });
    doc.registerFont("regular", path.join(FONT_DIR, "DejaVuSans.ttf"));
    doc.registerFont("bold", path.join(FONT_DIR, "DejaVuSans-Bold.ttf"));
    return doc;
  };
  // First pass measures the bill on a tall page, second pass draws it at that height.
  const probe = make(10000);
  const end = drawBill(probe, shop, bill, items);
  probe.end();

  return new Promise((resolve, reject) => {
    const doc = make(Math.ceil(end + PDF_M + 6));
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    drawBill(doc, shop, bill, items);
    doc.end();
  });
}

module.exports = { billPdf, pdfFileName };
