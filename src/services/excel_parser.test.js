const test = require("node:test");
const assert = require("node:assert/strict");
const { extractItems, mtdCalculo } = require("./excel_parser");

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

function calcItem({ fob = 0, acuerdo = 0, codArrancel = null } = {}) {
  return { FOB: fob, Acuerdo: acuerdo, CodArrancel: codArrancel, Cantidad: 1, UnidadMedida: "u" };
}

test("mtdCalculo cuadra el GA redondeado con el total informado (sin GA real + residuo)", () => {
  const items = [];
  for (let i = 0; i < 58; i++) items.push(calcItem({ fob: 0, acuerdo: 0 }));
  items.push(calcItem({ fob: 40, acuerdo: 1, codArrancel: "0000" }));
  items.push(calcItem({ fob: 59, acuerdo: 1, codArrancel: "0000" }));

  const op = { FOB: 99, TC: 1, ImpSIDUNEA: 0, GA: 100 };
  mtdCalculo(op, items);

  const sumRounded = items.reduce((s, it) => s + Math.round(it.GA), 0);
  assert.equal(sumRounded, 100, "Σ round(item.GA) debe cuadrar con el total");
  assert.equal(op.GA, 100);
  assert.equal(items.filter((it) => it.GA === 0).length, 58, "los items sin GA real quedan en 0");
  assert.equal(items[items.length - 1].GA, 60, "el residuo entero va al ultimo item con GA real");
});

test("mtdCalculo sin GA informado usa la suma redondeada", () => {
  const items = [];
  for (let i = 0; i < 3; i++) items.push(calcItem({ fob: 0, acuerdo: 0 }));
  items.push(calcItem({ fob: 10, acuerdo: 1, codArrancel: "0000" }));

  const op = { FOB: 10, TC: 1, ImpSIDUNEA: 0 };
  mtdCalculo(op, items);

  assert.equal(op.GA, 10);
  assert.equal(items.reduce((s, it) => s + Math.round(it.GA), 0), 10);
});

test("mtdCalculo reconcilia CIFBS de los items con el declarado", () => {
  const items = [
    calcItem({ fob: 10.1, codArrancel: "0000" }),
    calcItem({ fob: 20.2, codArrancel: "0000" }),
  ];
  const op = { FOB: 30.3, ValorCIF: 30.3, TC: 1, ImpSIDUNEA: 0, ValorCIFBS: 30 };

  mtdCalculo(op, items);

  const sum = Math.round(items.reduce((s, it) => s + (Number(it.CIFBS) || 0), 0) * 100) / 100;
  assert.equal(sum, 30, "Σ item.CIFBS debe cuadrar con el declarado");
  assert.equal(op.ValorCIFBS, 30);
});

test("mtdCalculo sin item con GA real no fuerza el total", () => {
  const items = [calcItem({ acuerdo: 0 }), calcItem({ acuerdo: 0 })];

  const op = { FOB: 0, TC: 1, ImpSIDUNEA: 0, GA: 5 };
  mtdCalculo(op, items);

  assert.equal(items.every((it) => it.GA === 0), true);
  assert.equal(op.GA, 0);
});

test("mtdCalculo deja IVA en 0 en partidas exentas y conserva la base imponible", () => {
  const items = [
    calcItem({ fob: 100, acuerdo: 0.05, codArrancel: "8431490000" }),
    calcItem({ fob: 100, acuerdo: 0.05, codArrancel: "8413919000" }),
  ];
  items[0].IVA = 1960; // IVA previo del Excel: la exencion lo quita

  const op = { FOB: 200, TC: 1, ImpSIDUNEA: 0, IVA: 9999 };
  mtdCalculo(op, items, 14.94, new Set(["8431490000"]));

  const exento = items[0];
  const normal = items[1];

  assert.equal(exento.IVA, 0, "la partida exenta no paga IVA");
  assert.ok(exento.BaseImponible > 0, "la base imponible se conserva");
  assert.equal(exento.TotalTributos, exento.GA, "el total de tributos excluye el IVA");

  assert.equal(normal.IVA, Math.round(normal.BaseImponible * 0.1494));
  assert.equal(op.IVA, normal.IVA, "el IVA de la operacion es la suma de los items");
});

test("mtdCalculo con todos los items exentos deja el IVA de la operacion en 0", () => {
  const items = [
    calcItem({ fob: 100, acuerdo: 0.05, codArrancel: "8431490000" }),
    calcItem({ fob: 50, acuerdo: 0.05, codArrancel: "0101210000" }),
  ];
  items[0].IVA = 1960;
  items[1].IVA = 980;
  const op = { FOB: 150, TC: 1, ImpSIDUNEA: 0, IVA: 5000 };

  mtdCalculo(op, items, 14.94, new Set(["8431490000", "0101210000"]));

  assert.equal(items.every((it) => it.IVA === 0), true);
  assert.equal(op.IVA, 0);
  assert.equal(op.ImpuestoIVA, 0);
});

test("mtdCalculo conserva el IVA declarado y ajusta la diferencia en el ultimo item", () => {
  const items = [
    calcItem({ fob: 100, acuerdo: 0.05, codArrancel: "8412210000" }),
    calcItem({ fob: 100, acuerdo: 0.05, codArrancel: "8413919000" }),
  ];
  const op = { FOB: 200, TC: 1, ImpSIDUNEA: 0, IVA: 18 };

  mtdCalculo(op, items, 14.94, new Set(["8412210000"]));

  const suma = items.reduce((s, it) => s + it.IVA, 0);
  assert.equal(items[0].IVA, 0, "la partida exenta queda en 0");
  assert.equal(suma, 18, "la suma de los items cuadra con el IVA declarado");
  assert.equal(op.IVA, 18, "el IVA de Valores se conserva");
  assert.equal(items[1].IVA, 18, "la diferencia de redondeo va al ultimo item");
  assert.equal(items[1].TotalTributos, items[1].GA + 18, "el total del item ajustado cuadra");
});

test("mtdCalculo respeta el total corregido aunque la exencion haya quitado IVA previo", () => {
  const items = [
    calcItem({ fob: 100, acuerdo: 0.05, codArrancel: "8412210000" }),
    calcItem({ fob: 100, acuerdo: 0.05, codArrancel: "8413919000" }),
  ];
  items[0].IVA = 1960; // IVA previo del Excel que la exencion elimina
  const op = { FOB: 200, TC: 1, ImpSIDUNEA: 0, IVA: 18 };

  mtdCalculo(op, items, 14.94, new Set(["8412210000"]));

  const suma = items.reduce((s, it) => s + it.IVA, 0);
  assert.equal(items[0].IVA, 0);
  assert.equal(suma, 18, "se respeta el total ya corregido por el usuario");
  assert.equal(op.IVA, 18);
});

test("mtdCalculo descuenta el IVA declarado menor desde el ultimo item", () => {
  const items = [
    calcItem({ fob: 100, acuerdo: 0.05, codArrancel: "8413919000" }),
    calcItem({ fob: 100, acuerdo: 0.05, codArrancel: "8413919000" }),
  ];
  const op = { FOB: 200, TC: 1, ImpSIDUNEA: 0, IVA: 27 };

  mtdCalculo(op, items);

  const suma = items.reduce((s, it) => s + it.IVA, 0);
  assert.equal(suma, 27);
  assert.equal(op.IVA, 27);
  assert.equal(items[1].IVA, 11, "el ultimo item absorbe los 5 de diferencia");
});

test("mtdCalculo reparte el descuento de IVA en varios items sin negativos", () => {
  const items = [
    calcItem({ fob: 100, acuerdo: 0.05, codArrancel: "8413919000" }),
    calcItem({ fob: 100, acuerdo: 0.05, codArrancel: "8413919000" }),
  ];
  const op = { FOB: 200, TC: 1, ImpSIDUNEA: 0, IVA: 10 };

  mtdCalculo(op, items);

  const suma = items.reduce((s, it) => s + it.IVA, 0);
  assert.equal(suma, 10);
  assert.equal(op.IVA, 10);
  assert.equal(items[1].IVA, 0);
  assert.equal(items[0].IVA, 10);
  assert.equal(items.every((it) => it.IVA >= 0), true);
});

test("mtdCalculo ignora el flag EXENCION DE IVA del Excel: manda el decreto", () => {
  const item = calcItem({ fob: 100, acuerdo: 0.05, codArrancel: "8431490000" });
  item.ExencionIVA = "NO";

  const op = { FOB: 100, TC: 1, ImpSIDUNEA: 0 };
  mtdCalculo(op, [item], 14.94, new Set(["8431490000"]));

  assert.equal(item.IVA, 0);
});
