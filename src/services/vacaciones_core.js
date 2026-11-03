/**
 * Reglas puras de vacaciones: fechas, días hábiles, antigüedad, saldos,
 * generación automática de cronograma y detección de conflictos.
 * No accede a base de datos para poder testearse de forma aislada.
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

function pad2(n) {
  return String(n).padStart(2, "0");
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function parseDateOnly(value) {
  if (value instanceof Date) {
    return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
  }
  const raw = String(value || "").slice(0, 10);
  if (!DATE_RE.test(raw)) throw new Error(`Fecha invalida: ${value}`);
  const [y, m, d] = raw.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) {
    throw new Error(`Fecha invalida: ${value}`);
  }
  return date;
}

function formatDate(value) {
  if (typeof value === "string" && DATE_RE.test(value.slice(0, 10))) {
    return value.slice(0, 10);
  }
  return parseDateOnly(value).toISOString().slice(0, 10);
}

function datePart(value) {
  return formatDate(value);
}

function toDateOnlyString(value) {
  return formatDate(value);
}

function addDays(value, days) {
  const date = parseDateOnly(value);
  return formatDate(new Date(date.getTime() + Number(days) * DAY_MS));
}

function addMonths(value, months) {
  const date = parseDateOnly(value);
  const day = date.getUTCDate();
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + Number(months), 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, last));
  return formatDate(target);
}

function addYears(value, years) {
  const date = parseDateOnly(value);
  const year = date.getUTCFullYear() + Number(years);
  const month = date.getUTCMonth();
  const day = date.getUTCDate();
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return formatDate(new Date(Date.UTC(year, month, Math.min(day, last))));
}

function startOfYear(gestion) {
  return `${Number(gestion)}-01-01`;
}

function endOfYear(gestion) {
  return `${Number(gestion)}-12-31`;
}

function* eachDate(desde, hasta) {
  const start = parseDateOnly(desde);
  const end = parseDateOnly(hasta);
  if (start > end) return;
  let current = start;
  while (current <= end) {
    yield formatDate(current);
    current = new Date(current.getTime() + DAY_MS);
  }
}

function normalizarFeriados(feriados = []) {
  if (feriados instanceof Set) return feriados;
  const set = new Set();
  for (const item of feriados || []) {
    if (!item) continue;
    if (typeof item === "string") {
      set.add(item.slice(0, 10));
      continue;
    }
    if (item.descuenta === false) continue;
    if (item.fecha) set.add(String(item.fecha).slice(0, 10));
  }
  return set;
}

function isBusinessDay(value, feriados = []) {
  const date = parseDateOnly(value);
  if (date.getUTCDay() === 0) return false;
  return !normalizarFeriados(feriados).has(formatDate(date));
}

function contarDiasHabiles(desde, hasta, feriados = []) {
  const off = normalizarFeriados(feriados);
  let count = 0;
  for (const fecha of eachDate(desde, hasta)) {
    const date = parseDateOnly(fecha);
    if (date.getUTCDay() === 0) continue;
    if (off.has(fecha)) continue;
    count++;
  }
  return count;
}

function rangoSolapado(a, b) {
  const desde = datePart(a.fechaDesde || a.desde);
  const hasta = datePart(a.fechaHasta || a.hasta);
  const desdeB = datePart(b.fechaDesde || b.desde);
  const hastaB = datePart(b.fechaHasta || b.hasta);
  const start = desde > desdeB ? desde : desdeB;
  const end = hasta < hastaB ? hasta : hastaB;
  if (start > end) return null;
  return { desde: start, hasta: end };
}

function solapamientoDiasHabiles(a, b, feriados = []) {
  const range = rangoSolapado(a, b);
  if (!range) return null;
  const off = normalizarFeriados(feriados);
  let dias = 0;
  let primero = null;
  let ultimo = null;
  for (const fecha of eachDate(range.desde, range.hasta)) {
    const date = parseDateOnly(fecha);
    if (date.getUTCDay() === 0) continue;
    if (off.has(fecha)) continue;
    if (!primero) primero = fecha;
    ultimo = fecha;
    dias++;
  }
  if (dias <= 0) return null;
  return { desde: primero, hasta: ultimo, dias };
}

function calcularAntiguedad(fechaIngreso, fechaReferencia) {
  if (!fechaIngreso) return null;
  const start = parseDateOnly(fechaIngreso);
  const ref = parseDateOnly(fechaReferencia);
  if (start > ref) return { anios: 0, meses: 0, dias: 0 };
  let anios = ref.getUTCFullYear() - start.getUTCFullYear();
  let meses = ref.getUTCMonth() - start.getUTCMonth();
  let dias = ref.getUTCDate() - start.getUTCDate();
  if (dias < 0) {
    meses--;
    const lastDayPrevMonth = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), 0));
    dias += lastDayPrevMonth.getUTCDate();
  }
  if (meses < 0) {
    anios--;
    meses += 12;
  }
  return { anios, meses, dias };
}

function diasCorresponden(anios) {
  const value = Number(anios) || 0;
  if (value >= 10) return 30;
  if (value >= 5) return 20;
  if (value >= 1) return 15;
  return 0;
}

function diasCorrespondenPorFecha(fechaIngreso, fechaReferencia) {
  const antiguedad = calcularAntiguedad(fechaIngreso, fechaReferencia);
  return antiguedad ? diasCorresponden(antiguedad.anios) : 0;
}

function colorPorSaldo(saldo, tieneFecha, tieneSaldoInicial) {
  if (!tieneFecha || !tieneSaldoInicial) return "gris";
  const value = Number(saldo) || 0;
  if (value < 0) return "rojo";
  if (value === 0) return "verde";
  return "ambar";
}

function calcularSerieSaldos({
  gestionInicial,
  pendientesIniciales = 0,
  pagadosIniciales = 0,
  registros = [],
}) {
  const map = new Map();
  for (const row of registros) {
    map.set(Number(row.gestion), row);
  }
  if (!map.has(Number(gestionInicial))) {
    map.set(Number(gestionInicial), {
      gestion: Number(gestionInicial),
      corresponden: 0,
      tomados: 0,
      pagados: 0,
      ajustes: 0,
    });
  }
  const years = Array.from(map.keys()).sort((a, b) => a - b);
  let saldoAnterior = round2(pendientesIniciales);
  const result = [];
  for (const year of years) {
    if (year < Number(gestionInicial)) continue;
    const row = map.get(year);
    const corresponden = round2(row.corresponden);
    const tomados = round2(row.tomados);
    const pagados = round2(row.pagados) + (year === Number(gestionInicial) ? round2(pagadosIniciales) : 0);
    const ajustes = round2(row.ajustes);
    const disponible = round2(saldoAnterior + corresponden);
    const saldoCierre = round2(disponible - tomados - pagados + ajustes);
    result.push({
      gestion: year,
      arrastre: saldoAnterior,
      corresponden,
      tomados,
      pagados,
      ajustes,
      disponible,
      saldoCierre,
    });
    saldoAnterior = saldoCierre;
  }
  return result;
}

function firstBusinessDayOfMonth(gestion, month, feriados = []) {
  const off = normalizarFeriados(feriados);
  const days = new Date(Date.UTC(Number(gestion), Number(month), 0)).getUTCDate();
  for (let day = 1; day <= days; day++) {
    const fecha = `${Number(gestion)}-${pad2(month)}-${pad2(day)}`;
    const date = parseDateOnly(fecha);
    if (date.getUTCDay() !== 0 && !off.has(fecha)) return fecha;
  }
  return `${Number(gestion)}-${pad2(month)}-01`;
}

function buildBlock(start, targetDays, feriados = []) {
  const off = normalizarFeriados(feriados);
  const target = Math.max(1, Math.round(Number(targetDays) || 0));
  let date = parseDateOnly(start);
  let count = 0;
  let primero = null;
  let ultimo = null;
  let guard = 0;
  while (count < target && guard < 500) {
    const fecha = formatDate(date);
    if (date.getUTCDay() !== 0 && !off.has(fecha)) {
      if (!primero) primero = fecha;
      ultimo = fecha;
      count++;
    }
    date = new Date(date.getTime() + DAY_MS);
    guard++;
  }
  if (!primero) return null;
  return { fechaDesde: primero, fechaHasta: ultimo, dias: count };
}

function findFreeStart(start, targetDays, existingBlocks = [], feriados = []) {
  let candidate = start;
  for (let attempt = 0; attempt < 104; attempt++) {
    const block = buildBlock(candidate, targetDays, feriados);
    if (!block) return null;
    const overlaps = existingBlocks.some((existing) =>
      solapamientoDiasHabiles(block, existing, feriados)
    );
    if (!overlaps) return block;
    candidate = addDays(block.fechaDesde, 7);
  }
  return null;
}

function marcarBloquesEnConflicto(bloques = [], conflictos = [], feriados = []) {
  for (const bloque of bloques) {
    bloque.conflicto = conflictos.some((conflicto) => {
      const mismoUsuario = conflicto.usuarioA === bloque.usuarioId || conflicto.usuarioB === bloque.usuarioId;
      if (!mismoUsuario) return false;
      return Boolean(
        solapamientoDiasHabiles(
          { fechaDesde: bloque.fechaDesde, fechaHasta: bloque.fechaHasta },
          { fechaDesde: conflicto.desde, fechaHasta: conflicto.hasta },
          feriados
        )
      );
    });
  }
  return bloques;
}

function detectarConflictos({ bloques = [], licencias = [], grupos = [], feriados = [] }) {
  const off = normalizarFeriados(feriados);
  const itemsByUser = new Map();
  const addItem = (item, tipo) => {
    const usuarioId = Number(item.usuarioId);
    if (!usuarioId) return;
    if (!itemsByUser.has(usuarioId)) itemsByUser.set(usuarioId, []);
    itemsByUser.get(usuarioId).push({ ...item, _tipo: tipo });
  };
  for (const bloque of bloques) addItem(bloque, "plan");
  for (const licencia of licencias) addItem(licencia, "licencia");

  const conflictos = [];
  const seen = new Set();
  for (const grupo of grupos) {
    const miembros = (grupo.miembros || []).map(Number);
    for (let i = 0; i < miembros.length; i++) {
      for (let j = i + 1; j < miembros.length; j++) {
        const usuarioA = miembros[i];
        const usuarioB = miembros[j];
        const itemsA = itemsByUser.get(usuarioA) || [];
        const itemsB = itemsByUser.get(usuarioB) || [];
        for (const itemA of itemsA) {
          for (const itemB of itemsB) {
            const overlap = solapamientoDiasHabiles(
              { fechaDesde: itemA.fechaDesde, fechaHasta: itemA.fechaHasta },
              { fechaDesde: itemB.fechaDesde, fechaHasta: itemB.fechaHasta },
              off
            );
            if (!overlap) continue;
            const key = `${grupo.id}|${usuarioA}|${usuarioB}|${overlap.desde}|${overlap.hasta}|${itemA._tipo}|${itemB._tipo}`;
            if (seen.has(key)) continue;
            seen.add(key);
            conflictos.push({
              grupoId: grupo.id,
              grupoNombre: grupo.nombre,
              usuarioA,
              usuarioB,
              nombreA: itemA.nombre || "",
              nombreB: itemB.nombre || "",
              desde: overlap.desde,
              hasta: overlap.hasta,
              dias: overlap.dias,
              origen: itemA._tipo === itemB._tipo ? itemA._tipo : "mixto",
            });
          }
        }
      }
    }
  }
  return conflictos;
}

function generarPropuesta({
  gestion,
  funcionarios = [],
  feriados = [],
  planesAnteriores = {},
  grupos = [],
  maxBlock = 15,
}) {
  const off = normalizarFeriados(feriados);
  const bloques = [];

  funcionarios.forEach((funcionario, index) => {
    if (!funcionario.fechaIngreso) return;
    let remaining = round2(funcionario.disponible);
    if (remaining <= 0) return;

    const usuarioId = Number(funcionario.usuarioId);
    const existentes = [];
    const previos = (planesAnteriores[usuarioId] || [])
      .slice()
      .sort((a, b) => String(a.fechaDesde).localeCompare(String(b.fechaDesde)));

    let starts = previos.map((bloque) => addYears(bloque.fechaDesde, 1));
    if (starts.length === 0) {
      const month = (index % 12) + 1;
      starts = [firstBusinessDayOfMonth(gestion, month, off)];
    }

    const agregar = (block) => {
      if (!block) return;
      bloques.push({
        usuarioId,
        nombre: funcionario.nombre || "",
        gestion: Number(gestion),
        fechaDesde: block.fechaDesde,
        fechaHasta: block.fechaHasta,
        diasPlanificados: block.dias,
        origen: "auto",
        notas: null,
      });
      existentes.push(block);
    };

    for (const start of starts) {
      if (remaining <= 0) break;
      const target = Math.min(maxBlock, remaining);
      const block = findFreeStart(start, target, existentes, off);
      if (!block) continue;
      agregar(block);
      remaining = round2(remaining - block.dias);
    }

    let extraStart =
      existentes.length > 0
        ? addDays(existentes[existentes.length - 1].fechaHasta, 30)
        : firstBusinessDayOfMonth(gestion, 1, off);
    let guard = 0;
    while (remaining > 0 && guard < 12) {
      const target = Math.min(maxBlock, remaining);
      const block = findFreeStart(extraStart, target, existentes, off);
      if (!block) break;
      agregar(block);
      remaining = round2(remaining - block.dias);
      extraStart = addDays(block.fechaHasta, 30);
      guard++;
    }
  });

  const conflictos = detectarConflictos({ bloques, grupos, feriados: off });
  marcarBloquesEnConflicto(bloques, conflictos, off);
  return { bloques, conflictos };
}

module.exports = {
  addDays,
  addMonths,
  addYears,
  buildBlock,
  calcularAntiguedad,
  calcularSerieSaldos,
  colorPorSaldo,
  contarDiasHabiles,
  detectarConflictos,
  diasCorresponden,
  diasCorrespondenPorFecha,
  eachDate,
  endOfYear,
  findFreeStart,
  firstBusinessDayOfMonth,
  formatDate,
  generarPropuesta,
  isBusinessDay,
  marcarBloquesEnConflicto,
  normalizarFeriados,
  parseDateOnly,
  rangoSolapado,
  round2,
  solapamientoDiasHabiles,
  startOfYear,
  toDateOnlyString,
};
