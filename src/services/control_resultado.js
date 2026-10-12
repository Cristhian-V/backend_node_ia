const MESES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

const DIAS_MES = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeap(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year, month) {
  if (month === 2 && isLeap(year)) return 29;
  return DIAS_MES[month - 1];
}

function isLastDayOfMonth(year, month, day) {
  return day === daysInMonth(year, month);
}

/** Normaliza una fecha (Date o string) a [year, month, day]. Devuelve null si no es válida. */
function parseYMD(value) {
  if (value == null || value === "") return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return [value.getFullYear(), value.getMonth() + 1, value.getDate()];
  }
  const s = String(value).trim();
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return [parseInt(iso[1], 10), parseInt(iso[2], 10), parseInt(iso[3], 10)];
  const dmy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (dmy) return [parseInt(dmy[3], 10), parseInt(dmy[2], 10), parseInt(dmy[1], 10)];
  return null;
}

/**
 * Excel DAYS360 con método US (NASD) por defecto.
 * - Si la fecha inicial es el último día de un mes, pasa a ser el día 30.
 * - Si la fecha final es el último día de un mes: si el inicio es anterior al día 30
 *   pasa a ser el día 1 del mes siguiente; si no, el día 30.
 */
function days360(start, end) {
  let [y1, m1, d1] = start;
  let [y2, m2, d2] = end;
  if (isLastDayOfMonth(y1, m1, d1)) d1 = 30;
  if (isLastDayOfMonth(y2, m2, d2)) {
    if (d1 < 30) {
      d2 = 1;
      m2 += 1;
      if (m2 > 12) {
        m2 = 1;
        y2 += 1;
      }
    } else {
      d2 = 30;
    }
  }
  return (y2 - y1) * 360 + (m2 - m1) * 30 + (d2 - d1);
}

function todayYMD(today = new Date()) {
  return [today.getFullYear(), today.getMonth() + 1, today.getDate()];
}

/** Categoría A-K según el total de ítems (bandas del Excel). */
function categoriaPorItems(total) {
  const n = Number(total);
  if (!Number.isFinite(n) || n < 1) return "";
  if (n < 4) return "A";
  if (n < 7) return "B";
  if (n < 16) return "C";
  if (n < 31) return "D";
  if (n < 51) return "E";
  if (n < 81) return "F";
  if (n < 131) return "G";
  if (n < 201) return "H";
  if (n < 301) return "I";
  if (n < 501) return "J";
  return "K";
}

/** Etiqueta de mes + año (p. ej. "octubre 2026"). */
function mesLabel(fechaPago) {
  const ymd = parseYMD(fechaPago);
  if (!ymd) return "";
  return `${MESES[ymd[1] - 1]} ${ymd[0]}`;
}

/**
 * Días transcurridos a hoy (30/360) para regímenes con plazo de regularización (IMA 4 / IMI 4).
 * Sin fecha de regularización → días transcurridos; con fecha → "Regularizada"; otro régimen → "N/A".
 */
function calcDias(regimen, fechaCanal, fechaRegularizacion, today = new Date()) {
  if (regimen !== "IMA 4" && regimen !== "IMI 4") return "N/A";
  if (fechaRegularizacion) return "Regularizada";
  const start = parseYMD(fechaCanal);
  if (!start) return "S/F";
  return days360(start, todayYMD(today));
}

/**
 * Cancelación de plazo (30/360) para regímenes EX 2 / IM 5.
 * Sin fecha de canal → "S/F"; sin fecha de regularización → días transcurridos; con fecha → "Cancelada".
 */
function calcCancelPlazo(regimen, fechaCanal, fechaRegularizacion, today = new Date()) {
  if (regimen !== "EX 2" && regimen !== "IM 5") return "N/A";
  if (!fechaCanal) return "S/F";
  if (fechaRegularizacion) return "Cancelada";
  const start = parseYMD(fechaCanal);
  if (!start) return "S/F";
  return days360(start, todayYMD(today));
}

/** Deriva las columnas calculadas del reporte Resultado para una fila de operación. */
function enriquecerResultado(row, today = new Date()) {
  const fechaCanal = row.fecha_asignacion_canal || row.fecha_canal_plazo || null;
  const fechaRegularizacion = row.fecha_regularizacion || null;
  return {
    ...row,
    mes: mesLabel(row.fecha_pago),
    cat: categoriaPorItems(row.total_items),
    dias: calcDias(row.regimen, fechaCanal, fechaRegularizacion, today),
    cancel_plazo: calcCancelPlazo(row.regimen, fechaCanal, fechaRegularizacion, today),
  };
}

module.exports = {
  days360,
  parseYMD,
  categoriaPorItems,
  mesLabel,
  calcDias,
  calcCancelPlazo,
  enriquecerResultado,
};
