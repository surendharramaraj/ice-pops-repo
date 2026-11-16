"use strict";
// Excel export of a business's data, in the same sheet layout the shop used before.

const ExcelJS = require("exceljs");

const MONEY = '"₹"#,##0.00';
const DATE = "dd-mmm-yyyy";

const SHEETS = [
  {
    name: "Items", key: "items",
    columns: [
      ["Item", "name", 22], ["Category", "category", 14], ["Price (₹)", "price", 11, MONEY], ["Outlet", "outlet", 18],
      ["In stock", "stock", 14], ["On menu", "onMenu", 10], ["Prep (min)", "prep", 10],
      ["Ingredients (one portion)", "ingredients", 50], ["Steps", "steps", 70]
    ]
  },
  {
    name: "Bills", key: "bills",
    columns: [
      ["Bill no", "billNo", 9], ["Date", "date", 13, DATE], ["Time", "time", 8], ["Outlet", "outlet", 18],
      ["Items", "summary", 46], ["Quantity", "qty", 10], ["Total (₹)", "total", 12, MONEY],
      ["Payment", "payment", 10], ["Customer", "customer", 22], ["Mobile", "phone", 14]
    ]
  },
  {
    name: "Bill items", key: "items_sold",
    columns: [
      ["Bill no", "billNo", 9], ["Date", "date", 13, DATE], ["Time", "time", 8], ["Outlet", "outlet", 18],
      ["Item", "flavour", 22], ["Quantity", "qty", 10], ["Unit price (₹)", "price", 14, MONEY],
      ["Line total (₹)", "lineTotal", 14, MONEY], ["Payment", "payment", 10]
    ]
  },
  {
    name: "Stock log", key: "stock",
    columns: [
      ["Date", "date", 13, DATE], ["Time", "time", 8], ["Outlet", "outlet", 18], ["Item", "item", 22],
      ["Change", "change", 9], ["Reason", "reason", 22], ["Stock after", "after", 12], ["By", "by", 18]
    ]
  }
];

function toExcelDate(s) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

async function exportWorkbook(data, businessName) {
  const wb = new ExcelJS.Workbook();
  wb.creator = businessName;
  wb.created = new Date();
  for (const spec of SHEETS) {
    const ws = wb.addWorksheet(spec.name, { views: [{ state: "frozen", ySplit: 1 }] });
    ws.columns = spec.columns.map(([header, key, width]) => ({ header, key, width }));
    for (const rec of data[spec.key]) {
      const row = {};
      for (const [, key, , fmt] of spec.columns) row[key] = fmt === DATE ? toExcelDate(rec[key]) : rec[key];
      ws.addRow(row);
    }
    spec.columns.forEach(([, , , fmt], i) => { if (fmt) ws.getColumn(i + 1).numFmt = fmt; });
    const head = ws.getRow(1);
    head.font = { bold: true, color: { argb: "FF10343D" } };
    head.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE4F3F5" } };
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: spec.columns.length } };
  }
  return wb.xlsx.writeBuffer();
}

module.exports = { exportWorkbook };
