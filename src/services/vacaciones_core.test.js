const test = require("node:test");
const assert = require("node:assert/strict");
const {
  addDays,
  addYears,
  antiguedadParaGestion,
  buildBlock,
  calcularAntiguedad,
  calcularSerieSaldos,
  colorPorSaldo,
  contarDiasHabiles,
  detectarConflictos,
  diasCorresponden,
  diasCorrespondenParaGestion,
  generarPropuesta,
  referenciaGestion,
  solapamientoDiasHabiles,
} = require("./vacaciones_core");

test("cuenta lunes a sabado y excluye domingos", () => {
  assert.equal(contarDiasHabiles("2026-08-13", "2026-08-30"), 15);
  assert.equal(contarDiasHabiles("2026-08-16", "2026-08-16"), 0);
});

test("excluye feriados marcados como descontables", () => {
  assert.equal(
    contarDiasHabiles("2026-08-13", "2026-08-30", ["2026-08-15"]),
    14
  );
  assert.equal(
    contarDiasHabiles("2026-08-13", "2026-08-30", [{ fecha: "2026-08-15", descuenta: false }]),
    15
  );
});

test("calcula antiguedad exacta", () => {
  const a = calcularAntiguedad("2013-01-02", "2027-12-31");
  assert.deepEqual(a, { anios: 14, meses: 11, dias: 29 });
  assert.equal(calcularAntiguedad("2027-01-01", "2026-12-31").anios, 0);
});

test("tramos de dias que corresponden", () => {
  assert.equal(diasCorresponden(0), 0);
  assert.equal(diasCorresponden(1), 15);
  assert.equal(diasCorresponden(5), 20);
  assert.equal(diasCorresponden(7), 20);
  assert.equal(diasCorresponden(10), 30);
  assert.equal(diasCorresponden(12), 30);
});

test("serie de saldos con arrastre positivo", () => {
  const serie = calcularSerieSaldos({
    gestionInicial: 2026,
    pendientesIniciales: 5,
    registros: [
      { gestion: 2026, corresponden: 20, tomados: 8, pagados: 0, ajustes: 0 },
      { gestion: 2027, corresponden: 20, tomados: 0, pagados: 0, ajustes: 0 },
    ],
  });
  assert.equal(serie[0].arrastre, 5);
  assert.equal(serie[0].saldoCierre, 17);
  assert.equal(serie[1].arrastre, 17);
  assert.equal(serie[1].disponible, 37);
});

test("serie de saldos con arrastre negativo", () => {
  const serie = calcularSerieSaldos({
    gestionInicial: 2026,
    pendientesIniciales: 0,
    registros: [
      { gestion: 2026, corresponden: 15, tomados: 20, pagados: 0, ajustes: 0 },
      { gestion: 2027, corresponden: 20, tomados: 0, pagados: 0, ajustes: 0 },
    ],
  });
  assert.equal(serie[0].saldoCierre, -5);
  assert.equal(serie[1].arrastre, -5);
  assert.equal(serie[1].disponible, 15);
  assert.equal(colorPorSaldo(-5, true, true), "rojo");
});

test("genera bloques de hasta 15 dias que cubren los disponibles", () => {
  const { bloques, conflictos } = generarPropuesta({
    gestion: 2027,
    funcionarios: [
      {
        usuarioId: 1,
        nombre: "Cristhian Vargas",
        fechaIngreso: "2019-12-01",
        disponible: 37,
      },
    ],
    planesAnteriores: {
      1: [{ fechaDesde: "2026-05-01", fechaHasta: "2026-05-21" }],
    },
    grupos: [],
  });
  assert.equal(conflictos.length, 0);
  assert.ok(bloques.length >= 3);
  assert.ok(bloques.every((b) => b.diasPlanificados <= 15));
  assert.equal(
    bloques.reduce((sum, b) => sum + b.diasPlanificados, 0),
    37
  );
});

test("detecta conflicto de grupo en dias habiles y no en domingo", () => {
  const grupos = [{ id: 1, nombre: "Cliente A", miembros: [1, 2] }];
  const conflicto = detectarConflictos({
    bloques: [
      { usuarioId: 1, nombre: "A", fechaDesde: "2027-05-03", fechaHasta: "2027-05-08" },
      { usuarioId: 2, nombre: "B", fechaDesde: "2027-05-06", fechaHasta: "2027-05-10" },
    ],
    grupos,
  });
  assert.equal(conflicto.length, 1);
  assert.equal(conflicto[0].desde, "2027-05-06");
  assert.equal(conflicto[0].hasta, "2027-05-08");

  const soloDomingo = detectarConflictos({
    bloques: [
      { usuarioId: 1, nombre: "A", fechaDesde: "2027-05-08", fechaHasta: "2027-05-08" },
      { usuarioId: 2, nombre: "B", fechaDesde: "2027-05-09", fechaHasta: "2027-05-09" },
    ],
    grupos,
  });
  assert.equal(soloDomingo.length, 0);
});

test("buildBlock respeta feriados y addYears maneja 29 de febrero", () => {
  const block = buildBlock("2027-05-01", 15, ["2027-05-03"]);
  assert.equal(block.dias, 15);
  assert.equal(addYears("2024-02-29", 1), "2025-02-28");
  assert.equal(addDays("2027-12-31", 1), "2028-01-01");
  assert.ok(solapamientoDiasHabiles(
    { fechaDesde: "2027-05-01", fechaHasta: "2027-05-10" },
    { fechaDesde: "2027-05-05", fechaHasta: "2027-05-12" }
  ));
});


test("la referencia de la gestion es el 31/12 del anio anterior", () => {
  assert.equal(referenciaGestion(2026), "2025-12-31");
  assert.equal(referenciaGestion(2027), "2026-12-31");
});

test("los dias de 2026 usan la antiguedad de 2025", () => {
  // 2021-06-01 -> al 31/12/2025 tiene 4 anios (15 dias); al 31/12/2026 tendria 5 (20).
  assert.equal(diasCorrespondenParaGestion("2021-06-01", 2026), 15);
  assert.equal(diasCorrespondenParaGestion("2021-06-01", 2027), 20);
  // 2016-06-01 -> al 31/12/2025 tiene 9 anios (20); al 31/12/2026 cumple 10 (30).
  assert.equal(diasCorrespondenParaGestion("2016-06-01", 2026), 20);
  assert.equal(diasCorrespondenParaGestion("2016-06-01", 2027), 30);
});

test("la antiguedad mostrada tambien usa el 31/12 de la gestion anterior", () => {
  const a = antiguedadParaGestion("2021-06-01", 2026);
  assert.equal(a.anios, 4);
  assert.equal(a.meses, 6);
});
