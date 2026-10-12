const test = require("node:test");
const assert = require("node:assert/strict");
const XLSX = require("xlsx");
const { importSuma, OPERACION_COLUMNS } = require("./control_suma");

const IDX = (name) => OPERACION_COLUMNS.indexOf(name);

const HEADER = [
  "Código Aduana de despacho",
  "N° de DIM",
  "Modalidad de despacho",
  "Código Modalidad de Regimen",
  "NIT Importador",
  "Razon social Importador",
  "Fecha de pago",
  "Canal",
];

function buildBuffer(rows) {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, ws, "Hoja excel");
  return XLSX.write(wb, { type: "buffer", bookType: "xls" });
}

function fakePool() {
  const calls = [];
  const client = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/RETURNING \(xmax = 0\)/.test(sql)) return { rows: [{ created: true }] };
      return { rows: [] };
    },
    release: () => {},
  };
  return { pool: { connect: async () => client }, calls };
}

const ROWS = [
  [],
  HEADER,
  ["711", "DI-2026-711-1111111", "GENERAL", "4000", "1026469026", "IMCRUZ S.A.", "2026-10-08 10:00:00", "VERDE"],
  ["701", "DI-2026-701-2222222", "ANTICIPADO", "4000", "334750021", "PROVETECMAR S.R.L.", "2026-10-08 11:00:00", ""],
];

test("inserta dos operaciones y cuenta creados, con fecha de lote y archivo", async () => {
  const buffer = buildBuffer(ROWS);
  const { pool, calls } = fakePool();
  const summary = await importSuma(
    { buffer, fileName: "pagos.xls" },
    { pool, resolver: async () => null }
  );

  assert.equal(summary.total, 2);
  assert.equal(summary.creados, 2);
  assert.equal(summary.actualizados, 0);
  assert.equal(summary.fecha_reporte_pago, "2026-10-08");

  const inserts = calls.filter((c) => /INSERT INTO core\.control_operaciones/.test(c.sql));
  assert.equal(inserts.length, 2);
  const rowA = inserts.find((c) => c.params[IDX("dim")] === "DI-2026-711-1111111");
  assert.equal(rowA.params[IDX("fecha_reporte_pago")], "2026-10-08");
  assert.equal(rowA.params[IDX("archivo_origen")], "pagos.xls");
  assert.equal(rowA.params[IDX("regimen")], "IM 4");
  assert.equal(rowA.params[IDX("dui_due")], "C 1111111");
});

test("el upsert es idempotente por dim y preserva los campos curados", async () => {
  const buffer = buildBuffer(ROWS);
  const { pool, calls } = fakePool();
  await importSuma({ buffer, fileName: "pagos.xls" }, { pool });

  const stmt = calls.find((c) => /ON CONFLICT \(dim\) DO UPDATE/.test(c.sql));
  assert.ok(stmt, "usa ON CONFLICT (dim) DO UPDATE");
  const updateClause = stmt.sql.split("DO UPDATE SET")[1];
  assert.ok(!/planillador\s*=/.test(updateClause), "no pisa planillador");
  assert.ok(!/observaciones\s*=/.test(updateClause), "no pisa observaciones");
  assert.ok(!/planillado\s*=/.test(updateClause), "no pisa planillado");
  assert.ok(/liquidador = COALESCE/.test(updateClause), "rellena liquidador solo si está vacío");
});

test("enriquece planilla y liquidador desde Integgre (match y no-match)", async () => {
  const buffer = buildBuffer(ROWS);
  const { pool, calls } = fakePool();
  const resolver = async ({ dui }) =>
    dui === "1111111" ? { operacionId: 555, liquidador: "JUAN PEREZ" } : null;

  await importSuma({ buffer, fileName: "pagos.xls" }, { pool, resolver });

  const inserts = calls.filter((c) => /INSERT INTO core\.control_operaciones/.test(c.sql));
  const rowA = inserts.find((c) => c.params[IDX("dim")] === "DI-2026-711-1111111");
  const rowB = inserts.find((c) => c.params[IDX("dim")] === "DI-2026-701-2222222");

  assert.equal(rowA.params[IDX("planilla")], 555);
  assert.equal(rowA.params[IDX("liquidador")], "JUAN PEREZ");
  assert.equal(rowA.params[IDX("observaciones")], null);

  assert.equal(rowB.params[IDX("planilla")], null);
  assert.equal(rowB.params[IDX("liquidador")], null);
  assert.equal(rowB.params[IDX("observaciones")], "PENDIENTE REGULARIZAR");
});

test("actualiza el maestro de clientes por NIT", async () => {
  const buffer = buildBuffer(ROWS);
  const { pool, calls } = fakePool();
  await importSuma({ buffer, fileName: "pagos.xls" }, { pool });

  const clientes = calls.filter((c) => /INSERT INTO core\.control_clientes/.test(c.sql));
  assert.equal(clientes.length, 2);
  const imcruz = clientes.find((c) => c.params[0] === "1026469026");
  assert.equal(imcruz.params[1], "IMCRUZ S.A.");
  assert.ok(/ON CONFLICT \(nit\) DO UPDATE/.test(imcruz.sql));
});
