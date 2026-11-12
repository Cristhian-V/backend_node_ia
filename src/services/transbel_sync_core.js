const { isValidReferenciaCliente } = require("./transbel_excepciones_core");

function cleanReferencia(value) {
  return value == null ? "" : String(value).replace(/\s+/g, " ").trim();
}

const CLICK_REASON_MARKERS = [
  "Sin datos de CLICK",
  "Sin fecha de aceptación de declaración",
  "Sin fecha de pago de tributos",
  "Sin fecha de canal/levante",
];

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function pendingReason(op) {
  const reasons = [];
  const referencia = cleanReferencia(op.ReferenciaCliente);
  if (!referencia) {
    reasons.push("Sin referencia de cliente (ENTREGA)");
  } else if (!isValidReferenciaCliente(referencia)) {
    reasons.push("Referencia de cliente inválida (debe ser 180XXXXXX)");
  }
  if (!op.NroRegistro) {
    reasons.push("Sin datos de CLICK (checkpoints)");
  } else {
    if (!op.FechaValidacion) reasons.push("Sin fecha de aceptación de declaración");
    if (!op.PagoTributos) reasons.push("Sin fecha de pago de tributos");
    if (!op.FechaLevante) reasons.push("Sin fecha de canal/levante");
  }
  return reasons;
}

function isClickRelatedMotivo(motivo) {
  const text = normalizeText(motivo);
  return CLICK_REASON_MARKERS.some((marker) =>
    text.includes(normalizeText(marker))
  );
}

function splitIgnorados(rows, ignoredIds) {
  const ids =
    ignoredIds instanceof Set
      ? ignoredIds
      : new Set(
          (Array.isArray(ignoredIds) ? ignoredIds : []).map((n) =>
            Number.parseInt(n, 10)
          )
        );
  const pendientes = [];
  const ignorados = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (ids.has(row.operacionId)) ignorados.push(row);
    else pendientes.push(row);
  }
  return { pendientes, ignorados };
}

function selectProcessablePendientes(pendientes, operacionIds) {
  const ids = new Set(
    (Array.isArray(operacionIds) ? operacionIds : [])
      .map((n) => Number.parseInt(n, 10))
      .filter((n) => Number.isInteger(n) && n > 0)
  );
  return (Array.isArray(pendientes) ? pendientes : [])
    .filter((p) => !p.completo && ids.has(p.operacionId))
    .map((p) => {
      const motivos = Array.isArray(p.motivos)
        ? p.motivos
        : p.motivo
          ? String(p.motivo)
              .split(" · ")
              .map((s) => s.trim())
              .filter(Boolean)
          : pendingReason(p);
      return {
        ...p,
        motivos,
        procesable: motivos.some(isClickRelatedMotivo),
      };
    });
}

module.exports = {
  cleanReferencia,
  pendingReason,
  isClickRelatedMotivo,
  splitIgnorados,
  selectProcessablePendientes,
};
