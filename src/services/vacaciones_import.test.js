const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const XLSX = require("xlsx");
const {
  findMatches,
  mapearCategoria,
  normalizarCi,
  normalizarNombre,
  parseCronograma,
  parseListaPersonal,
} = require("./vacaciones_import");

const EXCEL = path.join(
  __dirname,
  "..",
  "..",
  "..",
  "referencias",
  "CRONOGRAMA VACIONES 2022-2025-2026.xlsx"
);

function workbook() {
  return XLSX.readFile(EXCEL);
}

test("parsea la lista de personal con antiguedad", () => {
  const roster = parseListaPersonal(workbook());
  assert.equal(roster.length, 38);
  const freddy = roster.find((r) => r.nombre.includes("MELGAR SALAZAR"));
  assert.ok(freddy);
  assert.equal(freddy.fechaIngreso, "2006-01-15");
  assert.equal(freddy.dias, 30);
  const andrea = roster.find((r) => r.nombre.includes("MIER VACA ANDREA"));
  assert.ok(andrea);
  assert.equal(andrea.fechaIngreso, "2022-02-01");
});

test("reconstruye bloques continuos del cronograma 2025", () => {
  const planes = parseCronograma(workbook(), 2025);
  const carlos = planes.find(
    (p) => p.nombreNorm === "CARLOS ALBERTO RIVERO FERNANDEZ"
  );
  assert.ok(carlos);
  assert.equal(carlos.fechaDesde, "2025-01-09");
  assert.equal(carlos.fechaHasta, "2025-01-25");
  assert.equal(carlos.dias, 15);
  const lia = planes.find((p) => p.nombreNorm === "LIA MILENA CLAURE TORREZ");
  assert.ok(lia);
  assert.equal(lia.fechaDesde, "2025-01-24");
  assert.equal(lia.fechaHasta, "2025-02-15");
  assert.equal(lia.dias, 20);
});

test("parsea el cronograma 2026 y resuelve alias", () => {
  const planes = parseCronograma(workbook(), 2026);
  assert.ok(planes.length > 20);
  const pablo = planes.find((p) => p.nombreNorm === "PABLO JUNIOR GONZALES PEREZ");
  assert.ok(pablo);
  const margarita = planes.find((p) => p.nombreNorm === "MARGARITA PATRONI REA");
  assert.ok(margarita);
  assert.equal(margarita.fechaDesde, "2026-02-05");
  assert.equal(margarita.dias, 15);
});

test("normaliza nombres, CI y busca coincidencias", () => {
  assert.equal(normalizarNombre("  AÑEZ  GALLY "), "ANEZ GALLY");
  assert.equal(normalizarCi("1100131 CH"), "1100131");
  const directory = [
    { usuarioId: 1, nombre: "Carlos Alberto Rivero Fernandez", ci: "8862151" },
    { usuarioId: 2, nombre: "Cristhian Vargas", ci: "9732287" },
    { usuarioId: 3, nombre: "Cristhian Sergio Vargas Flores", ci: null },
  ];
  const byCi = findMatches("carlos rivero", "8862151", directory);
  assert.equal(byCi.length, 1);
  assert.equal(byCi[0].usuarioId, 1);
  const byToken = findMatches("cristhian vargas", null, directory);
  assert.ok(byToken.length >= 1);
});


test("mapea cargos del Excel a las categor?as configurables", () => {
  assert.equal(mapearCategoria("ANALISTA DE OPERACIONES"), "Analista");
  assert.equal(mapearCategoria("ASISTENTE ADMINISTRATIVO"), "Administrativo");
  assert.equal(mapearCategoria("GESTOR"), "Gestor");
  assert.equal(mapearCategoria("ENCARGADO DE MENSAJERIA"), "Mensajería");
  assert.equal(mapearCategoria("ASISTENTE DE SISTEMAS"), "Sistemas");
  assert.equal(mapearCategoria("ASISTENTE DE ARCHIVO"), "Archivo");
  assert.equal(mapearCategoria("ASESOR LEGAL"), null);
});
