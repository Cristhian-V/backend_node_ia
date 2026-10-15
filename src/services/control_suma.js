const XLSX = require("xlsx");

/**
 * Control de Operaciones — importación del reporte de SUMA.
 * Parsea el .xls (header detectado por "N° de DIM"), mapea por nombre de columna,
 * deriva régimen y DUI/DUE, y hace upsert idempotente por DIM.
 */

// Orden de prioridad: el primer matcher que hace match con un encabezado se queda con la columna.
const COLUMN_MATCHERS = [
  ["aduana_codigo", (h) => h.includes("codigo aduana")],
  ["aduana_descripcion", (h) => h.includes("descripcion aduana")],
  ["dim", (h) => h === "dim" || h.includes("de dim")],
  ["fecha_aceptacion", (h) => h.includes("aceptacion")],
  ["estado", (h) => h === "estado"],
  ["nit_declarante", (h) => h.includes("nit declarante")],
  ["razon_social_declarante", (h) => h.includes("declarante")],
  ["nro_referencia", (h) => h.includes("referencia")],
  ["destino_regimen_codigo", (h) => h.includes("codigo destino")],
  ["destino_regimen_descripcion", (h) => h.includes("descripcion destino")],
  ["modalidad_regimen_codigo", (h) => h.includes("codigo modalidad")],
  ["modalidad_regimen_descripcion", (h) => h.includes("descripcion modalidad")],
  ["modalidad_despacho", (h) => h.includes("modalidad de despacho")],
  ["total_items", (h) => h.includes("items")],
  ["nit_importador", (h) => h.includes("nit importador")],
  ["razon_social_importador", (h) => h.includes("importador")],
  ["valor_cif", (h) => h.includes("cif")],
  ["peso_bruto", (h) => h.includes("peso bruto")],
  ["rup_pago", (h) => h.includes("rup")],
  ["tributos", (h) => h.includes("tributos")],
  ["fecha_pago", (h) => h.includes("fecha de pago")],
  ["canal", (h) => h === "canal"],
  ["fecha_asignacion_canal", (h) => h.includes("asignacion")],
  ["fecha_levante", (h) => h.includes("levante")],
  ["fecha_inicio_plazo", (h) => h.includes("regularizacion")],
  ["fecha_conclusion", (h) => h.includes("conclusion")],
];

const OPERACION_COLUMNS = [
  "dim", "gestion", "aduana", "dui",
  "aduana_codigo", "aduana_descripcion", "fecha_aceptacion", "estado",
  "nit_declarante", "razon_social_declarante", "nro_referencia",
  "destino_regimen_codigo", "destino_regimen_descripcion",
  "modalidad_regimen_codigo", "modalidad_regimen_descripcion", "modalidad_despacho",
  "total_items", "nit_importador", "razon_social_importador",
  "valor_cif", "peso_bruto", "tributos", "rup_pago", "fecha_pago",
  "canal", "fecha_asignacion_canal", "fecha_levante", "fecha_inicio_plazo", "fecha_conclusion",
  "regimen", "dui_due",
  "liquidador", "planilla", "observaciones",
  "fecha_reporte_pago", "archivo_origen",
];

function normalizeHeader(value) {
  return String(value == null ? "" : value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[º°]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function cellAt(row, index) {
  if (index == null || index < 0) return "";
  const v = row[index];
  return v == null ? "" : String(v).trim();
}

/** Asigna cada campo a un índice de columna, por nombre de encabezado. */
function mapColumns(headerRow) {
  const normalized = (headerRow || []).map(normalizeHeader);
  const assigned = new Set();
  const map = {};
  for (const [field, test] of COLUMN_MATCHERS) {
    for (let c = 0; c < normalized.length; c++) {
      if (assigned.has(c)) continue;
      if (test(normalized[c])) {
        map[field] = c;
        assigned.add(c);
        break;
      }
    }
  }
  return map;
}

function findHeaderRow(rows) {
  for (let i = 0; i < rows.length; i++) {
    const map = mapColumns(rows[i] || []);
    if (map.dim != null && map.fecha_pago != null) return i;
  }
  return -1;
}

function toInt(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? Math.trunc(value) : null;
  const n = parseInt(String(value).replace(/[^\d-]/g, ""), 10);
  return Number.isNaN(n) ? null : n;
}

function toNum(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const n = parseFloat(String(value).replace(/,/g, ""));
  return Number.isNaN(n) ? null : n;
}

/** Normaliza una fecha a 'YYYY-MM-DD[ HH:MM:SS]' (string) para columnas TIMESTAMP. */
function parseDate(value) {
  if (value == null || value === "") return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    const p = (n) => String(n).padStart(2, "0");
    return `${value.getFullYear()}-${p(value.getMonth() + 1)}-${p(value.getDate())} ${p(value.getHours())}:${p(value.getMinutes())}:${p(value.getSeconds())}`;
  }
  const s = String(value).trim();
  const dt = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (dt) return `${dt[1]}-${dt[2]}-${dt[3]} ${dt[4]}:${dt[5]}:${dt[6] || "00"}`;
  const d = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (d) return `${d[1]}-${d[2]}-${d[3]}`;
  const dmy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (dmy) {
    const p = (n) => String(n).padStart(2, "0");
    return `${dmy[3]}-${p(dmy[2])}-${p(dmy[1])}`;
  }
  return null;
}

/** Extrae gestión, aduana y DUI de un DIM tipo 'DI-2026-711-2375679'. */
function parseDim(dim) {
  const s = String(dim || "").trim();
  const parts = s.split("-");
  if (parts.length >= 4) {
    return { gestion: toInt(parts[1]), aduana: toInt(parts[2]), dui: parts[3] || null };
  }
  return { gestion: null, aduana: null, dui: s ? s.slice(-7) : null };
}

/** DUI/DUE = 'C ' + últimos 7 caracteres del DIM. */
function deriveDuiDue(dim) {
  return dim ? `C ${String(dim).slice(-7)}` : null;
}

/** Régimen a partir de la modalidad de despacho (M) y el código de modalidad (K). */
function deriveRegimen(modalidadDespacho, modalidadRegimenCodigo) {
  const m = String(modalidadDespacho || "").trim().toUpperCase();
  const k = String(modalidadRegimenCodigo || "").trim();
  if (m === "GENERAL") return k === "6002" ? "IM 6" : "IM 4";
  if (m === "ANTICIPADO") return "IMA 4";
  if (m === "INMEDIATO") return "IMI 4";
  if (m === "TEMPORAL") return "IM 5";
  return "0";
}

function buildOperacion(row, columns) {
  const get = (field) => cellAt(row, columns[field]);
  const dim = get("dim");
  const { gestion, aduana, dui } = parseDim(dim);
  const regimen = deriveRegimen(get("modalidad_despacho"), get("modalidad_regimen_codigo"));
  return {
    dim,
    gestion,
    aduana,
    dui,
    aduana_codigo: get("aduana_codigo") || null,
    aduana_descripcion: get("aduana_descripcion") || null,
    fecha_aceptacion: parseDate(get("fecha_aceptacion")),
    estado: get("estado") || null,
    nit_declarante: get("nit_declarante") || null,
    razon_social_declarante: get("razon_social_declarante") || null,
    nro_referencia: get("nro_referencia") || null,
    destino_regimen_codigo: get("destino_regimen_codigo") || null,
    destino_regimen_descripcion: get("destino_regimen_descripcion") || null,
    modalidad_regimen_codigo: get("modalidad_regimen_codigo") || null,
    modalidad_regimen_descripcion: get("modalidad_regimen_descripcion") || null,
    modalidad_despacho: get("modalidad_despacho") || null,
    total_items: toInt(get("total_items")),
    nit_importador: get("nit_importador") || null,
    razon_social_importador: get("razon_social_importador") || null,
    valor_cif: toNum(get("valor_cif")),
    peso_bruto: toNum(get("peso_bruto")),
    tributos: toNum(get("tributos")),
    rup_pago: get("rup_pago") || null,
    fecha_pago: parseDate(get("fecha_pago")),
    canal: get("canal") || null,
    fecha_asignacion_canal: parseDate(get("fecha_asignacion_canal")),
    fecha_levante: parseDate(get("fecha_levante")),
    fecha_inicio_plazo: parseDate(get("fecha_inicio_plazo")),
    fecha_conclusion: parseDate(get("fecha_conclusion")),
    regimen,
    dui_due: deriveDuiDue(dim),
    liquidador: null,
    planilla: null,
    observacion_sugerida:
      regimen === "IMA 4" || regimen === "IMI 4" ? "PENDIENTE REGULARIZAR" : null,
  };
}

function parseSumaRows(rows) {
  const headerIndex = findHeaderRow(rows);
  if (headerIndex < 0) {
    const err = new Error("No se encontró la fila de encabezado (columna N° de DIM)");
    err.statusCode = 400;
    throw err;
  }
  const columns = mapColumns(rows[headerIndex] || []);
  const operaciones = [];
  for (let r = headerIndex + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    if (!cellAt(row, columns.dim)) continue;
    operaciones.push(buildOperacion(row, columns));
  }
  return { headerIndex, columns, operaciones, total: operaciones.length };
}

function readWorkbookRows(buffer) {
  const wb = XLSX.read(buffer, { type: "buffer", raw: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) {
    const err = new Error("El archivo no contiene hojas");
    err.statusCode = 400;
    throw err;
  }
  return XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: "" });
}

function parseSumaBuffer(buffer) {
  return parseSumaRows(readWorkbookRows(buffer));
}

/** Fecha de pago del lote: la más frecuente entre las filas del reporte. */
function detectFechaReportePago(operaciones) {
  const counts = new Map();
  for (const op of operaciones) {
    if (!op.fecha_pago) continue;
    const day = op.fecha_pago.slice(0, 10);
    counts.set(day, (counts.get(day) || 0) + 1);
  }
  let best = null;
  let bestN = -1;
  for (const [day, n] of counts) {
    if (n > bestN) {
      best = day;
      bestN = n;
    }
  }
  return best;
}

async function upsertClientes(client, operaciones) {
  const byNit = new Map();
  for (const op of operaciones) {
    if (!op.nit_importador) continue;
    byNit.set(String(op.nit_importador), op.razon_social_importador || null);
  }
  let count = 0;
  for (const [nit, nombre] of byNit) {
    await client.query(
      `INSERT INTO core.control_clientes (nit, nombre, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (nit) DO UPDATE SET
         nombre = COALESCE(NULLIF(EXCLUDED.nombre, ''), control_clientes.nombre),
         updated_at = NOW()`,
      [nit, nombre]
    );
    count++;
  }
  return count;
}

async function upsertOperacion(client, op, meta) {
  const values = OPERACION_COLUMNS.map((c) => {
    if (c === "observaciones") return op.observacion_sugerida ?? null;
    if (c === "fecha_reporte_pago") return meta.fechaReportePago || null;
    if (c === "archivo_origen") return meta.archivoOrigen || null;
    return op[c] === undefined ? null : op[c];
  });
  const placeholders = OPERACION_COLUMNS.map((_, i) => `$${i + 1}`).join(", ");
  const result = await client.query(
    `INSERT INTO core.control_operaciones (${OPERACION_COLUMNS.join(", ")})
     VALUES (${placeholders})
     ON CONFLICT (dim) DO UPDATE SET
       gestion = EXCLUDED.gestion,
       aduana = EXCLUDED.aduana,
       dui = EXCLUDED.dui,
       aduana_codigo = EXCLUDED.aduana_codigo,
       aduana_descripcion = EXCLUDED.aduana_descripcion,
       fecha_aceptacion = EXCLUDED.fecha_aceptacion,
       estado = EXCLUDED.estado,
       nit_declarante = EXCLUDED.nit_declarante,
       razon_social_declarante = EXCLUDED.razon_social_declarante,
       nro_referencia = EXCLUDED.nro_referencia,
       destino_regimen_codigo = EXCLUDED.destino_regimen_codigo,
       destino_regimen_descripcion = EXCLUDED.destino_regimen_descripcion,
       modalidad_regimen_codigo = EXCLUDED.modalidad_regimen_codigo,
       modalidad_regimen_descripcion = EXCLUDED.modalidad_regimen_descripcion,
       modalidad_despacho = EXCLUDED.modalidad_despacho,
       total_items = EXCLUDED.total_items,
       nit_importador = EXCLUDED.nit_importador,
       razon_social_importador = EXCLUDED.razon_social_importador,
       valor_cif = EXCLUDED.valor_cif,
       peso_bruto = EXCLUDED.peso_bruto,
       tributos = EXCLUDED.tributos,
       rup_pago = EXCLUDED.rup_pago,
       fecha_pago = EXCLUDED.fecha_pago,
       canal = CASE
         WHEN EXCLUDED.canal IS NULL OR EXCLUDED.canal = '' THEN control_operaciones.canal
         ELSE EXCLUDED.canal END,
       fecha_asignacion_canal = EXCLUDED.fecha_asignacion_canal,
       fecha_levante = EXCLUDED.fecha_levante,
       fecha_inicio_plazo = EXCLUDED.fecha_inicio_plazo,
       fecha_conclusion = EXCLUDED.fecha_conclusion,
       regimen = EXCLUDED.regimen,
       dui_due = EXCLUDED.dui_due,
       liquidador = COALESCE(control_operaciones.liquidador, EXCLUDED.liquidador),
       planilla = COALESCE(control_operaciones.planilla, EXCLUDED.planilla),
       fecha_reporte_pago = EXCLUDED.fecha_reporte_pago,
       archivo_origen = EXCLUDED.archivo_origen,
       updated_at = NOW()
     RETURNING (xmax = 0) AS created`,
    values
  );
  return result.rows[0].created ? "creado" : "actualizado";
}

async function upsertOperaciones(client, operaciones, meta) {
  let creados = 0;
  let actualizados = 0;
  for (const op of operaciones) {
    const estado = await upsertOperacion(client, op, meta);
    if (estado === "creado") creados++;
    else actualizados++;
  }
  return { creados, actualizados };
}

/**
 * Importa un reporte SUMA completo.
 * @param {{ buffer: Buffer, fileName?: string }} input
 * @param {{ resolver?: Function, pool: import('pg').Pool }} deps
 */
async function importSuma({ buffer, fileName }, { resolver, pool } = {}) {
  const parsed = parseSumaBuffer(buffer);
  const fechaReportePago = detectFechaReportePago(parsed.operaciones);

  if (resolver) {
    for (const op of parsed.operaciones) {
      try {
        const info = await resolver({ gestion: op.gestion, aduana: op.aduana, dui: op.dui });
        if (info) {
          op.planilla = info.operacionId ?? null;
          op.liquidador = info.liquidador ?? null;
        }
      } catch {
        // el enriquecimiento es best-effort: si Integgre falla, la fila se registra igual
      }
    }
  }

  if (!pool) throw new Error("Se requiere un pool PostgreSQL para importar");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const clientes = await upsertClientes(client, parsed.operaciones);
    const resumen = await upsertOperaciones(client, parsed.operaciones, {
      archivoOrigen: fileName || null,
      fechaReportePago,
    });
    await client.query("COMMIT");
    return {
      total: parsed.operaciones.length,
      creados: resumen.creados,
      actualizados: resumen.actualizados,
      clientes,
      fecha_reporte_pago: fechaReportePago,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  importSuma,
  parseSumaBuffer,
  parseSumaRows,
  mapColumns,
  findHeaderRow,
  buildOperacion,
  deriveRegimen,
  deriveDuiDue,
  parseDim,
  parseDate,
  detectFechaReportePago,
  upsertClientes,
  upsertOperaciones,
  normalizeHeader,
  COLUMN_MATCHERS,
  OPERACION_COLUMNS,
};
