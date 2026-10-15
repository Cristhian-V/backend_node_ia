const test = require("node:test");
const assert = require("node:assert/strict");
const { parseClickHtml } = require("./click_scraper");
const {
  derivarCanal,
  seleccionarSinCanal,
  sincronizarCanal,
  SELECT_SIN_CANAL,
} = require("./control_clic_sync");

// Estructura real del CLICK (verificada en vivo): la fecha va en <th> dentro de la
// fila y el evento trae <img src="img/<color>.jpg"> + <td>HH:MM:SS<b>TIPO</b>desc</td>.
const HTML_CON_CANAL = `
<table>
  <tr>
    <th><b>09/10/2026</b></th>
    <td><img src="img/verde.jpg" border="0"></td>
    <td>02:06:43 <b>DETERMINACION DE CANAL</b>autorizada para el levante (canal verde).</td>
  </tr>
</table>`;

const HTML_SIN_CANAL = `
<table>
  <tr>
    <th><b>09/10/2026</b></th>
    <td><img src="img/registro.jpg"></td>
    <td>10:30:46 <b>ACEPTACION DE DECLARACION</b>número asignado.</td>
  </tr>
</table>`;

test("deriva el canal desde el HTML real de una operación sin canal", () => {
  const parsed = parseClickHtml(HTML_CON_CANAL);
  const c = derivarCanal(parsed);
  assert.deepEqual(c, { canal: "VERDE", fecha: "2026-10-09 02:06:43" });
});

test("sin evento de determinación de canal devuelve null", () => {
  assert.equal(derivarCanal(parseClickHtml(HTML_SIN_CANAL)), null);
  assert.equal(derivarCanal({ eventos: [] }), null);
  assert.equal(derivarCanal(null), null);
});

test("imagen de canal desconocida devuelve null", () => {
  assert.equal(
    derivarCanal({ eventos: [{ tipo: "DETERMINACION DE CANAL", imagen: "img/otro.jpg", fecha: null }] }),
    null
  );
});

function fakePool(ops) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/FROM core\.control_operaciones/.test(sql)) return { rows: ops };
      return { rows: [] };
    },
  };
}

function fakeSession(handler) {
  return {
    init: async () => "cookie",
    scrape: async (g, a, n) => handler(g, a, n),
    reset: () => {},
  };
}

test("selección: solo operaciones sin canal", () => {
  assert.match(SELECT_SIN_CANAL, /canal IS NULL OR canal = ''/);
  assert.doesNotMatch(SELECT_SIN_CANAL, /fecha_regularizacion/);
});

test("sincroniza el canal y NO toca fecha_regularizacion", async () => {
  const ops = [
    { id: 1, dim: "DI-2026-701-2374579", gestion: 2026, aduana: 701, dui: "2374579" },
    { id: 2, dim: "DI-2026-701-2374570", gestion: 2026, aduana: 701, dui: "2374570" },
  ];
  const pool = fakePool(ops);
  const session = fakeSession(() => parseClickHtml(HTML_CON_CANAL));

  const resumen = await sincronizarCanal({
    pool,
    limit: 10,
    throttleMs: 0,
    sessionFactory: () => session,
  });

  assert.equal(resumen.procesadas, 2);
  assert.equal(resumen.actualizadas, 2);
  assert.equal(resumen.errores, 0);

  const updates = pool.calls.filter((c) => /UPDATE core\.control_operaciones/.test(c.sql));
  assert.equal(updates.length, 2);
  for (const u of updates) {
    assert.match(u.sql, /canal = \$1/);
    assert.match(u.sql, /clic_ultima_sync = NOW\(\)/);
    assert.doesNotMatch(u.sql, /fecha_regularizacion/);
    assert.equal(u.params[0], "VERDE");
    assert.equal(u.params[1], "2026-10-09 02:06:43");
  }
});

test("un error en una operación no aborta el lote", async () => {
  const ops = [
    { id: 1, dim: "A", gestion: 2026, aduana: 701, dui: "1" },
    { id: 2, dim: "B", gestion: 2026, aduana: 701, dui: "2" },
  ];
  const pool = fakePool(ops);
  const session = fakeSession((g, a, n) => {
    if (n === "1") throw new Error("CLICK timeout");
    return parseClickHtml(HTML_CON_CANAL);
  });

  const resumen = await sincronizarCanal({
    pool,
    throttleMs: 0,
    sessionFactory: () => session,
  });

  assert.equal(resumen.errores, 1);
  assert.equal(resumen.actualizadas, 1);
});

test("operación sin evento de canal no se actualiza", async () => {
  const ops = [{ id: 1, dim: "A", gestion: 2026, aduana: 701, dui: "1" }];
  const pool = fakePool(ops);
  const session = fakeSession(() => parseClickHtml(HTML_SIN_CANAL));

  const resumen = await sincronizarCanal({
    pool,
    throttleMs: 0,
    sessionFactory: () => session,
  });

  assert.equal(resumen.actualizadas, 0);
  assert.equal(resumen.sin_canal, 1);
  assert.equal(pool.calls.filter((c) => /UPDATE/.test(c.sql)).length, 0);
});

test("dryRun no consulta ni actualiza", async () => {
  const ops = [{ id: 1, dim: "A", gestion: 2026, aduana: 701, dui: "1" }];
  const pool = fakePool(ops);
  const resumen = await sincronizarCanal({
    pool,
    dryRun: true,
    sessionFactory: () => fakeSession(() => parseClickHtml(HTML_CON_CANAL)),
  });
  assert.equal(resumen.dryRun, true);
  assert.equal(resumen.pendientes, 1);
  assert.equal(pool.calls.filter((c) => /UPDATE/.test(c.sql)).length, 0);
});
