const test = require("node:test");
const assert = require("node:assert/strict");
const {
  resolverFechaReferencia,
  resolverPartidasExentas,
  extraerPartidasDeFilas,
  getSnapshot,
  saveSnapshot,
  resolverExencionItem,
  aplicarExenciones,
} = require("./iva_exencion");

function clientWithRows(rows) {
  return { query: async () => ({ rows }) };
}

test("resolverFechaReferencia prioriza Validacion, luego Pago, luego Registro", () => {
  assert.equal(
    resolverFechaReferencia({
      FechaValidacion: "2026-03-01T00:00:00.000Z",
      FechaPago: "2026-02-01T00:00:00.000Z",
      FechaReg: "2026-01-01T00:00:00.000Z",
    }),
    "2026-03-01"
  );
  assert.equal(
    resolverFechaReferencia({ FechaValidacion: null, FechaPago: "2026-02-01", FechaReg: "2026-01-01" }),
    "2026-02-01"
  );
  assert.equal(
    resolverFechaReferencia({ FechaReg: "2026-01-01T10:00:00.000Z" }),
    "2026-01-01"
  );
});

test("resolverFechaReferencia usa la fecha del servidor si no hay datos", () => {
  const hoy = new Date().toISOString().slice(0, 10);
  assert.equal(resolverFechaReferencia({}), hoy);
});

test("resolverPartidasExentas normaliza y prioriza el decreto mas reciente", async () => {
  const client = clientWithRows([
    { partida_arancel: "8431490000", exencion_id: 2, decreto: "DS NUEVO" },
    { partida_arancel: "8431.49.00.00", exencion_id: 1, decreto: "DS VIEJO" },
    { partida_arancel: "0101210000", exencion_id: 3, decreto: "DS OTRO" },
  ]);

  const partidas = await resolverPartidasExentas(client, "2026-05-01");

  assert.equal(partidas.size, 2);
  assert.equal(partidas.get("8431490000").decreto, "DS NUEVO");
  assert.equal(partidas.get("0101210000").exencionId, 3);
});

test("extraerPartidasDeFilas normaliza, deduplica e ignora descripciones", () => {
  const rows = [
    ["PARTIDA ARANCEL", "DESCRIPCION"],
    ["8431.49.00.00", "Partes de maquinas"],
    ["8431490000", "Duplicada"],
    [101210000, "Numero sin ceros a la izquierda"],
    ["12345", "Codigo invalido"],
    [null, "", true],
  ];

  const { partidas, invalidas } = extraerPartidasDeFilas(rows);

  assert.deepEqual(partidas, ["0101210000", "8431490000"]);
  assert.equal(invalidas, 1);
});

test("resolverExencionItem da prioridad al snapshot sobre el decreto vigente", () => {
  const snapshot = new Map([
    [1, { partida: "8431490000", exencionId: 9, decreto: "DS CONGELADO", fechaReferencia: "2026-01-01" }],
  ]);
  const vigentes = new Map([["8431490000", { exencionId: 2, decreto: "DS VIGENTE" }]]);

  const snapHit = resolverExencionItem({ NroItem: 1, CodArrancel: "8431.49.00.00" }, vigentes, snapshot);
  assert.equal(snapHit.decreto, "DS CONGELADO");
  assert.equal(snapHit.origen, "snapshot");

  const reglaHit = resolverExencionItem({ NroItem: 2, CodArrancel: "8431490000" }, vigentes, snapshot);
  assert.equal(reglaHit.decreto, "DS VIGENTE");
  assert.equal(reglaHit.origen, "decreto");

  assert.equal(resolverExencionItem({ NroItem: 3, CodArrancel: "9999999999" }, vigentes, snapshot), null);
  assert.equal(resolverExencionItem({ NroItem: 4, CodArrancel: "" }, vigentes, snapshot), null);
});

test("aplicarExenciones deja IVA en 0, conserva la base y recalcula tributos", () => {
  const items = [
    {
      NroItem: 1,
      CodArrancel: "8431.49.00.00",
      GA: 625,
      IVA: 1960,
      ICE: 0,
      ICE_ALI: 0,
      IEHD: 7.69,
      SIDUNEA: 0,
      BaseImponible: 13119,
      TotalTributos: 2592.69,
    },
    {
      NroItem: 2,
      CodArrancel: "8413919000",
      GA: 89,
      IVA: 280,
      BaseImponible: 1876.7,
      TotalTributos: 376.69,
    },
  ];
  const vigentes = new Map([["8431490000", { exencionId: 5, decreto: "DS 1234" }]]);

  const result = aplicarExenciones(items, vigentes, new Map(), "2026-05-01");

  assert.equal(result.huboExencion, true);
  assert.equal(result.aplicadas.length, 1);
  assert.equal(result.aplicadas[0].nro_item, 1);
  assert.equal(result.aplicadas[0].exencion_id, 5);
  assert.equal(result.aplicadas[0].fecha_referencia, "2026-05-01");

  assert.equal(items[0].IVA, 0);
  assert.equal(items[0].BaseImponible, 13119);
  assert.equal(items[0].TotalTributos, 632.69);

  assert.equal(items[1].IVA, 280);
  assert.equal(items[1].TotalTributos, 376.69);
});

test("aplicarExenciones sin coincidencias no modifica items", () => {
  const items = [{ NroItem: 1, CodArrancel: "8413919000", IVA: 280, GA: 89, TotalTributos: 376.69 }];
  const result = aplicarExenciones(items, new Map(), new Map(), "2026-05-01");

  assert.equal(result.huboExencion, false);
  assert.equal(result.aplicadas.length, 0);
  assert.equal(items[0].IVA, 280);
  assert.equal(items[0].TotalTributos, 376.69);
});

test("getSnapshot mapea por NroItem y normaliza la fecha", async () => {
  const client = clientWithRows([
    {
      nro_item: 1,
      partida_arancel: "8431490000",
      exencion_id: 2,
      decreto: "DS 1234",
      fecha_referencia: "2026-01-15",
    },
  ]);

  const snapshot = await getSnapshot(client, 5);
  const row = snapshot.get(1);

  assert.equal(row.partida, "8431490000");
  assert.equal(row.exencionId, 2);
  assert.equal(row.decreto, "DS 1234");
  assert.equal(row.fechaReferencia, "2026-01-15");
});

test("saveSnapshot borra el snapshot previo e inserta las filas aplicadas", async () => {
  const calls = [];
  const client = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      return { rows: [] };
    },
  };

  const inserted = await saveSnapshot(client, 7, [
    {
      nro_item: 1,
      partida_arancel: "8431490000",
      exencion_id: null,
      decreto: "DS 1234",
      fecha_referencia: "2026-05-01",
    },
  ]);

  assert.equal(inserted, 1);
  assert.equal(calls.length, 2);
  assert.match(calls[0].sql, /DELETE FROM core\.fnning_iva_exencion_aplicada/);
  assert.match(calls[1].sql, /INSERT INTO core\.fnning_iva_exencion_aplicada/);
  assert.deepEqual(calls[1].params[0], [7]);
  assert.deepEqual(calls[1].params[3], [null]);
});
