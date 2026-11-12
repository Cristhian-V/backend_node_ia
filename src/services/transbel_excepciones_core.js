class TransbelExcepcionError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "TransbelExcepcionError";
    this.status = status;
  }
}

function normalizeCausa(value) {
  return value == null ? "" : String(value).replace(/\s+/g, " ").trim();
}

function formatDateOnly(value) {
  if (value == null || value === "") return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function mapExcepcion(row) {
  return {
    operacionId: row.OperacionId,
    cliente: row.Cliente || "",
    patron: row.Patron || "",
    nroDui: row.NroDUI || "",
    nroEmbarque: row.NroEmbarque || "",
    imagen: row.Imagen || "",
    recinto: row.Recinto || "",
    referenciaCliente: row.ReferenciaCliente || "",
    tipoTransporteId: row.TipoTransporteId || "",
    transporte: row.Transporte || "",
    fechaPaseSalida: formatDateOnly(row.FechaPaseSalida),
    fechaValidacion: formatDateOnly(row.FechaValidacion),
    pagoTributos: formatDateOnly(row.PagoTributos),
    fechaLevante: formatDateOnly(row.FechaLevante),
    diferencia: row.Diferencia == null ? null : Number(row.Diferencia),
    excepcionId: row.ExcepcionId || null,
    causaGlobal: normalizeCausa(row.CausaGlobal),
    causaPuntual: normalizeCausa(row.CausaPuntual),
    responsable: normalizeCausa(row.Responsable),
    ajustable: row.Ajustable || "",
    requiereEx: row.RequiereEx || "NO",
    usuario: row.Usuario || "",
    asignadoId: row.AsignadoId == null ? 0 : Number(row.AsignadoId),
    asignado: row.Asignado || null,
    fechaSync: formatDateOnly(row.FechaSync),
    fechaReg: formatDateOnly(row.FechaReg),
  };
}

function mapCatalogo(row) {
  return {
    excepcionId: row.ExcepcionId,
    causaGlobal: normalizeCausa(row.CausaGlobal),
    causaPuntual: normalizeCausa(row.CausaPuntual),
    responsable: normalizeCausa(row.Responsable),
    ajustable: row.Ajustable || "",
  };
}

const DEDUPE_DATE_FIELDS = [
  "pagoTributos",
  "fechaPaseSalida",
  "fechaValidacion",
  "fechaLevante",
  "fechaReg",
  "fechaSync",
];

function compareExcepcionReciente(a, b) {
  for (const field of DEDUPE_DATE_FIELDS) {
    const va = a[field] || "";
    const vb = b[field] || "";
    if (va === vb) continue;
    if (!va) return 1;
    if (!vb) return -1;
    return vb.localeCompare(va);
  }
  return 0;
}

function dedupeExcepciones(rows) {
  const groups = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!groups.has(row.operacionId)) groups.set(row.operacionId, []);
    groups.get(row.operacionId).push(row);
  }

  const result = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      result.push(group[0]);
      continue;
    }
    const sorted = [...group].sort(compareExcepcionReciente);
    const primary = { ...sorted[0] };
    for (const other of sorted.slice(1)) {
      for (const [key, value] of Object.entries(other)) {
        if (primary[key] == null || primary[key] === "") {
          primary[key] = value;
        }
      }
    }
    result.push(primary);
  }
  return result;
}

const REFERENCIA_CLIENTE_RE = /^180\d{6}$/;

function isValidReferenciaCliente(value) {
  const ref = value == null ? "" : String(value).trim();
  return REFERENCIA_CLIENTE_RE.test(ref);
}

function isAnticipadaIMA(patron) {
  return /^IMA\b/i.test(String(patron || "").trim());
}

function requiereExcepcion(diferencia, excepcionId, esAnticipadaIMA = false) {
  if (esAnticipadaIMA) return false;
  return diferencia != null && Number(diferencia) > 3 && !excepcionId;
}

function buildAuditPayload({
  operacionId,
  excepcionId = null,
  accion,
  estadoPrevio = null,
  clienteId = null,
  motivo = null,
}) {
  return {
    operacionId,
    excepcionId,
    accion,
    estadoPrevio,
    clienteId,
    motivo,
  };
}

module.exports = {
  TransbelExcepcionError,
  normalizeCausa,
  formatDateOnly,
  mapExcepcion,
  mapCatalogo,
  dedupeExcepciones,
  isValidReferenciaCliente,
  isAnticipadaIMA,
  requiereExcepcion,
  buildAuditPayload,
};
