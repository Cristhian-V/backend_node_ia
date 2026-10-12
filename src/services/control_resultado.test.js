const test = require("node:test");
const assert = require("node:assert/strict");
const {
  days360,
  categoriaPorItems,
  mesLabel,
  calcDias,
  calcCancelPlazo,
} = require("./control_resultado");

test("categoriaPorItems cubre las bandas A-K", () => {
  assert.equal(categoriaPorItems(2), "A");
  assert.equal(categoriaPorItems(3), "A");
  assert.equal(categoriaPorItems(4), "B");
  assert.equal(categoriaPorItems(6), "B");
  assert.equal(categoriaPorItems(7), "C");
  assert.equal(categoriaPorItems(15), "C");
  assert.equal(categoriaPorItems(20), "D");
  assert.equal(categoriaPorItems(30), "D");
  assert.equal(categoriaPorItems(31), "E");
  assert.equal(categoriaPorItems(500), "J");
  assert.equal(categoriaPorItems(501), "K");
  assert.equal(categoriaPorItems(0), "");
  assert.equal(categoriaPorItems(null), "");
});

test("mesLabel arma mes y año", () => {
  assert.equal(mesLabel("2026-10-08 14:28:16"), "octubre 2026");
  assert.equal(mesLabel("2024-01-02"), "enero 2024");
  assert.equal(mesLabel(null), "");
});

test("days360 método US", () => {
  assert.equal(days360([2024, 1, 1], [2024, 1, 31]), 30);
  assert.equal(days360([2024, 1, 30], [2024, 3, 31]), 60);
  assert.equal(days360([2024, 1, 1], [2025, 1, 1]), 360);
});

const TODAY = new Date(2026, 9, 20); // 2026-10-20

test("calcDias: regímenes IMA 4 / IMI 4", () => {
  assert.equal(calcDias("IM 4", "2026-10-01", null, TODAY), "N/A");
  assert.equal(calcDias("IMA 4", "2026-10-01", null, TODAY), 19);
  assert.equal(calcDias("IMA 4", "2026-10-01", "2026-10-10", TODAY), "Regularizada");
  assert.equal(calcDias("IMI 4", "2026-10-01", null, TODAY), 19);
  assert.equal(calcDias("IMA 4", null, null, TODAY), "S/F");
});

test("calcCancelPlazo: regímenes EX 2 / IM 5", () => {
  assert.equal(calcCancelPlazo("IM 4", "2026-10-01", null, TODAY), "N/A");
  assert.equal(calcCancelPlazo("IM 5", null, null, TODAY), "S/F");
  assert.equal(calcCancelPlazo("IM 5", "2026-10-01", null, TODAY), 19);
  assert.equal(calcCancelPlazo("EX 2", "2026-10-01", "2026-10-15", TODAY), "Cancelada");
});
