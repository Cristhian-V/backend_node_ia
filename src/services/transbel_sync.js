const { getPool, sql } = require("../db_sqlserver");
const pg = require("../db");

const CLIENTE_ID = parseInt(process.env.TRANSBEL_CLIENTE_ID || "1047", 10);
const WORKATO_URL = process.env.TRANSBEL_WORKATO_URL || "";
const APP_KEY = process.env.TRANSBEL_APP_KEY || "";
const PROV3PL = process.env.TRANSBEL_PROV3PL || "CUMBRE";
const EXTYPE = process.env.TRANSBEL_EXTYPE || "AA";
const DEFAULT_LIMIT = parseInt(process.env.TRANSBEL_SYNC_LIMIT || "200", 10);

function fmtDate(value) {
  if (!value) return "";
  const d = value instanceof Date ? value : new Date(value);
  if (isNaN(d.getTime())) return "";
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${d.getUTCFullYear()}`;
}

function cleanReferencia(value) {
  return value == null ? "" : String(value).replace(/\s+/g, " ").trim();
}

function buildRecord(op) {
  return {
    ENTREGA: cleanReferencia(op.ReferenciaCliente),
    FLIBER: fmtDate(op.FechaValidacion),
    FULTDOC: fmtDate(op.FechaValidacion),
    FNACIONAL: fmtDate(op.PagoTributos),
    FETLAA: fmtDate(op.FechaLevante),
    CODEXC_AA: op.ExcepcionAA || "",
    FETL_TL: "",
    FENTCDP: "",
    CODEXC_TL: "",
  };
}

function pendingReason(op) {
  const reasons = [];
  if (!cleanReferencia(op.ReferenciaCliente)) reasons.push("Sin referencia de cliente (ENTREGA)");
  if (!op.NroRegistro) reasons.push("Sin datos de CLICK (checkpoints)");
  else {
    if (!op.FechaValidacion) reasons.push("Sin fecha de aceptación de declaración");
    if (!op.PagoTributos) reasons.push("Sin fecha de pago de tributos");
    if (!op.FechaLevante) reasons.push("Sin fecha de canal/levante");
  }
  return reasons;
}

async function findPendingFromInteggre(limit = DEFAULT_LIMIT) {
  const pool = await getPool();
  const request = pool.request();
  request.input("clienteId", sql.Int, CLIENTE_ID);
  request.input("limit", sql.Int, limit);
  const result = await request.query(`
    SELECT TOP (@limit)
      c.OperacionId,
      c.ReferenciaCliente,
      c.Gestion,
      c.RecintoId,
      c.NroDUI,
      oc.NroRegistro,
      MAX(CASE WHEN e.Tipo = 'ACEPTACION DE DECLARACION' THEN e.Fecha END) AS FechaValidacion,
      MAX(CASE WHEN e.Tipo = 'PAGO DE TRIBUTOS' THEN e.Fecha END) AS PagoTributos,
      MAX(CASE WHEN e.Tipo = 'DETERMINACION DE CANAL' THEN e.Fecha END) AS FechaCanal,
      MAX(CASE WHEN e.Tipo = 'AUTORIZACION DE LEVANTE' THEN e.Fecha END) AS FechaAutorizacion,
      MAX(CASE WHEN e.Tipo = 'EMISION DEL PASE DE SALIDA' THEN e.Fecha END) AS FechaPaseSalida,
      MAX(CASE WHEN e.Tipo = 'DETERMINACION DE CANAL' THEN e.Imagen END) AS Imagen,
      MAX(ex.ExcepcionId) AS ExcepcionAA
    FROM dbo.CME_Operacion c WITH(NOLOCK)
    LEFT JOIN dbo.WF_Operaciones wf WITH(NOLOCK)
      ON wf.CodigoReferenciaId = c.OperacionId AND wf.FlujoId = 1
    LEFT JOIN dbo.WF_ProcesoEjecucion ej WITH(NOLOCK)
      ON ej.OperacionId = wf.OperacionId AND ej.EstadoId = 'A' AND ej.ProcesoId = 11
    LEFT JOIN dbo.OperacionClick oc WITH(NOLOCK)
      ON oc.Gestion = c.Gestion AND oc.Aduana = c.RecintoId
      AND oc.Numero = TRY_CONVERT(INT, c.NroDUI)
    LEFT JOIN dbo.EventoClick e WITH(NOLOCK) ON e.NroRegistro = oc.NroRegistro
    OUTER APPLY (
      SELECT TOP 1 r.EstadoId
      FROM dbo.CME_RegistroExcepciones r WITH(NOLOCK)
      WHERE r.OperacionId = c.OperacionId
      ORDER BY r.FechaSync DESC
    ) psync
    OUTER APPLY (
      SELECT TOP 1 r.ExcepcionId
      FROM dbo.CME_RegistroExcepciones r WITH(NOLOCK)
      WHERE r.OperacionId = c.OperacionId AND r.Activo = 1 AND r.ExcepcionId LIKE 'AA%'
      ORDER BY r.FechaReg DESC
    ) ex
    WHERE c.ClienteId = @clienteId
      AND c.NroDUI IS NOT NULL AND c.NroDUI <> ''
      AND ej.OperacionId IS NULL
      AND (psync.EstadoId IS NULL OR psync.EstadoId <> 'F')
    GROUP BY c.OperacionId, c.ReferenciaCliente, c.Gestion, c.RecintoId, c.NroDUI, oc.NroRegistro
    ORDER BY c.OperacionId DESC
  `);
  return result.recordset.map((op) => ({
    ...op,
    FechaLevante:
      op.Imagen === "img/verde.jpg" ? op.FechaCanal : op.FechaAutorizacion,
  }));
}

async function getSentOperacionIds() {
  const res = await pg.query(
    "SELECT operacion_id FROM core.transbel_sync WHERE enviado = TRUE"
  );
  return new Set(res.rows.map((r) => r.operacion_id));
}

async function listPendientes(limit = DEFAULT_LIMIT) {
  const rows = await findPendingFromInteggre(limit);
  const enviados = await getSentOperacionIds();
  const seen = new Set();
  return rows
    .filter((op) => {
      if (enviados.has(op.OperacionId) || seen.has(op.OperacionId)) return false;
      seen.add(op.OperacionId);
      return true;
    })
    .map((op) => {
      const reasons = pendingReason(op);
      return {
        operacionId: op.OperacionId,
        entrega: cleanReferencia(op.ReferenciaCliente),
        nroRegistro: op.NroRegistro || "",
        gestion: op.Gestion,
        recinto: op.RecintoId,
        nroDui: op.NroDUI,
        canal: op.Imagen || "",
        completo: reasons.length === 0,
        motivo: reasons.join(" · "),
        record: buildRecord(op),
      };
    });
}

async function sendToWorkato(records) {
  if (!WORKATO_URL) throw new Error("TRANSBEL_WORKATO_URL no configurado");
  const res = await fetch(WORKATO_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      app_key: APP_KEY,
      prov3PL: PROV3PL,
      extype: EXTYPE,
    },
    body: JSON.stringify(records),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Workato respondió ${res.status}: ${text.slice(0, 300)}`);
  }
  return true;
}

async function saveResult(operacionId, entrega, record, estado, motivo) {
  await pg.query(
    `INSERT INTO core.transbel_sync (operacion_id, entrega, payload, estado, motivo, enviado, fecha_envio, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
     ON CONFLICT (operacion_id) DO UPDATE SET
       entrega = EXCLUDED.entrega,
       payload = EXCLUDED.payload,
       estado = EXCLUDED.estado,
       motivo = EXCLUDED.motivo,
       enviado = EXCLUDED.enviado,
       fecha_envio = EXCLUDED.fecha_envio,
       updated_at = NOW()`,
    [
      operacionId,
      entrega,
      JSON.stringify(record),
      estado,
      motivo || null,
      estado === "enviado",
      estado === "enviado" ? new Date() : null,
    ]
  );
}

async function sincronizar({ operacionIds } = {}) {
  const pendientes = await listPendientes();
  const objetivo = operacionIds && operacionIds.length
    ? pendientes.filter((p) => operacionIds.includes(p.operacionId))
    : pendientes;

  const completos = objetivo.filter((p) => p.completo);
  if (completos.length === 0) {
    return { enviados: 0, omitidos: objetivo.length, detalle: "Sin registros completos para enviar" };
  }

  const records = completos.map((p) => p.record);
  await sendToWorkato(records);

  for (const p of completos) {
    await saveResult(p.operacionId, p.entrega, p.record, "enviado", null);
  }

  return {
    enviados: completos.length,
    omitidos: objetivo.length - completos.length,
    operaciones: completos.map((p) => p.operacionId),
  };
}

module.exports = {
  listPendientes,
  sincronizar,
  findPendingFromInteggre,
  buildRecord,
  fmtDate,
  config: { CLIENTE_ID, WORKATO_URL, PROV3PL, EXTYPE },
};
