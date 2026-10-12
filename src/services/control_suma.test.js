const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  parseSumaBuffer,
  parseSumaRows,
  mapColumns,
  deriveRegimen,
  deriveDuiDue,
  parseDim,
  detectFechaReportePago,
  OPERACION_COLUMNS,
} = require("./control_suma");

const SUMA_FILE = path.join(
  __dirname,
  "..",
  "..",
  "..",
  "referencias",
  "bd0dc735-4976-4ded-8605-e94229569052.xls"
);

test("parsea el reporte SUMA real: 36 filas de datos y 26 columnas", () => {
  const buffer = fs.readFileSync(SUMA_FILE);
  const { headerIndex, columns, operaciones } = parseSumaBuffer(buffer);
  assert.equal(headerIndex, 1, "el encabezado está en la fila 2 (índice 1)");
  assert.equal(Object.keys(columns).length, 26, "se mapean las 26 columnas");
  assert.equal(operaciones.length, 36, "36 filas de datos");
});

test("mapea los encabezados por nombre (no por posición)", () => {
  const map = mapColumns([
    "Código Aduana de despacho",
    "Descripción Aduana de despacho",
    "N° de DIM",
    "Fecha de aceptacion",
    "Estado",
    "NIT Declarante",
    "Razón social Declarante",
    "N° de Referencia",
    "Código Destino/Regimen aduanero",
    "Descripción Destino/Regimen aduanero",
    "Código Modalidad de Regimen",
    "Descripción Modalidad de Regimen",
    "Modalidad de despacho",
    "Total N° de items",
    "NIT Importador",
    "Razon social Importador",
    "Total valor CIF aduana (BOB)",
    "Peso Bruto",
    "Total tributos determinados",
    "N° RUP pago de tributos",
    "Fecha de pago",
    "Canal",
    "Fecha Asignacion de canal",
    "Fecha de levante",
    "Fecha de regularización",
    "Fecha de conclusión",
  ]);
  assert.equal(map.dim, 2);
  assert.equal(map.rup_pago, 19);
  assert.equal(map.tributos, 18);
  assert.equal(map.canal, 21);
  assert.equal(map.fecha_asignacion_canal, 22);
});

test("deriva el régimen desde modalidad de despacho y código", () => {
  assert.equal(deriveRegimen("GENERAL", "4000"), "IM 4");
  assert.equal(deriveRegimen("GENERAL", "6002"), "IM 6");
  assert.equal(deriveRegimen("ANTICIPADO", "4000"), "IMA 4");
  assert.equal(deriveRegimen("INMEDIATO", "4000"), "IMI 4");
  assert.equal(deriveRegimen("TEMPORAL", "4000"), "IM 5");
  assert.equal(deriveRegimen("OTRO", "4000"), "0");
  assert.equal(deriveRegimen("", ""), "0");
});

test("deriva DUI/DUE desde el DIM", () => {
  assert.equal(deriveDuiDue("DI-2026-701-2374785"), "C 2374785");
});

test("parsea gestión, aduana y DUI del DIM", () => {
  assert.deepEqual(parseDim("DI-2026-701-2374785"), {
    gestion: 2026,
    aduana: 701,
    dui: "2374785",
  });
});

test("detecta la fecha de pago del lote (la más frecuente)", () => {
  const ops = [
    { fecha_pago: "2026-10-08 10:00:00" },
    { fecha_pago: "2026-10-08 11:00:00" },
    { fecha_pago: "2026-10-07 09:00:00" },
  ];
  assert.equal(detectFechaReportePago(ops), "2026-10-08");
  assert.equal(detectFechaReportePago([]), null);
});

test("una fila sin DIM se ignora y la ausencia de encabezado es error", () => {
  const rows = [
    ["", "", ""],
    ["N° de DIM", "Fecha de pago", "Estado"],
    ["DI-2026-701-2374785", "2026-10-08 10:00:00", "PAGADA"],
    ["", "", ""],
  ];
  const { operaciones } = parseSumaRows(rows);
  assert.equal(operaciones.length, 1);
  assert.equal(operaciones[0].dim, "DI-2026-701-2374785");
  assert.throws(() => parseSumaRows([["sin", "encabezado"]]), /encabezado/);
});

test("la lista de columnas de operación tiene 36 campos", () => {
  assert.equal(OPERACION_COLUMNS.length, 36);
});
