const test = require("node:test");
const assert = require("node:assert/strict");
const { extractItems } = require("./excel_parser");

function blank(n) {
  return Array.from({ length: n }, () => "");
}

function itemRow(partNumber, codArrancel, qty, fob) {
  const r = blank(31);
  r[3] = codArrancel;
  r[5] = fob;
  r[12] = String(qty);
  r[15] = "u";
  r[30] = partNumber;
  return r;
}

function datosRows(partNumber, prdId, qty) {
  return [
    ["invoice Item Reference Code", "invoice Item Line", "invoice Item PartNumber", "invoice Item Description", "invoice Item HTS", "invoice Item Quantity"],
    [prdId, "1", partNumber, "FILTRO", "99999999999", String(qty)],
  ];
}

const PARTIDAS = {
  "8421219000": { prdId: "8421219000", prdDesc: "desc", GA: 0, IC_IEHD: "", UnidadMedida: "u" },
};

test("extractItems no fusiona lineas que comparten ProductoCode", () => {
  const itemsSheet = [];
  for (let i = 0; i < 13; i++) itemsSheet.push(blank(31));
  itemsSheet.push(itemRow("4238525", "8421219000", 1, "504.14"));
  itemsSheet.push(itemRow("4238525", "8421219000", 1, "504.14"));
  itemsSheet.push(itemRow("4238525", "8421219000", 2, "1008.27"));

  const res = extractItems(itemsSheet, datosRows("4238525", "999", 4), PARTIDAS, false);

  assert.equal(new Set(res.map((it) => it.ProductoCode)).size, 1, "el fixture debe compartir ProductoCode");
  assert.equal(res.length, 3);
  assert.deepEqual(res.map((it) => it.NroItem), [1, 2, 3]);
  assert.deepEqual(res.map((it) => it.Cantidad), [1, 1, 2]);
  assert.deepEqual(res.map((it) => it.FOB), [504.14, 504.14, 1008.27]);
});

test("extractItems conserva el orden y la numeracion cuando los PartNumber difieren", () => {
  const itemsSheet = [];
  for (let i = 0; i < 13; i++) itemsSheet.push(blank(31));
  itemsSheet.push(itemRow("1095381", "8421219000", 1, "148.78"));
  itemsSheet.push(itemRow("2324872", "8421219000", 1, "70.68"));

  const datosSheet = [
    ["invoice Item Reference Code", "invoice Item Line", "invoice Item PartNumber", "invoice Item Description", "invoice Item HTS", "invoice Item Quantity"],
    ["1000", "1", "1095381", "A", "99999999999", "1"],
    ["1001", "2", "2324872", "B", "99999999999", "1"],
  ];

  const res = extractItems(itemsSheet, datosSheet, PARTIDAS, false);

  assert.equal(res.length, 2);
  assert.deepEqual(res.map((it) => it.NroItem), [1, 2]);
  assert.deepEqual(res.map((it) => it.PartNumber), ["1095381.000", "2324872.000"]);
  assert.deepEqual(res.map((it) => it.ProductoCode), [1000, 1001]);
});