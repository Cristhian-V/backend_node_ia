const { getPool, sql } = require("../db_sqlserver");
const { scrapeClick } = require("./click_scraper");

const DEFAULT_LIMIT = parseInt(process.env.CLICK_BACKFILL_LIMIT || "100", 10);

function truncate(value, max) {
  const s = value == null ? "" : String(value);
  return s.length > max ? s.slice(0, max) : s;
}

async function findPendingClickOperations(limit = DEFAULT_LIMIT) {
  const pool = await getPool();
  const request = pool.request();
  request.input("limit", sql.Int, limit);
  const result = await request.query(`
    SELECT TOP (@limit)
      c.OperacionId,
      c.Gestion,
      c.RecintoId,
      c.NroDUI
    FROM dbo.CME_Operacion c WITH(NOLOCK)
    WHERE c.EstadoId IN ('P','F')
      AND c.Gestion IS NOT NULL AND c.Gestion > 0
      AND c.NroDUI IS NOT NULL AND c.NroDUI <> ''
      AND c.RecintoId IS NOT NULL
      AND TRY_CONVERT(INT, c.NroDUI) IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM dbo.OperacionClick oc WITH(NOLOCK)
        WHERE oc.Gestion = c.Gestion
          AND oc.Aduana = c.RecintoId
          AND oc.Numero = TRY_CONVERT(INT, c.NroDUI)
      )
    ORDER BY c.OperacionId DESC
  `);
  return result.recordset;
}

async function storeResult(pool, op, parsed) {
  const numEvents = parsed.eventos.length;
  const ultimaFecha =
    parsed.eventos
      .map((e) => e.fecha)
      .filter(Boolean)
      .sort((a, b) => b - a)[0] || new Date();
  const nroRegistro = truncate(parsed.nroRegistro, 20);

  const transaction = new sql.Transaction(pool);
  await transaction.begin();
  try {
    const delOc = new sql.Request(transaction);
    delOc.input("nro", sql.VarChar(20), nroRegistro);
    await delOc.query("DELETE FROM dbo.OperacionClick WHERE NroRegistro = @nro");

    const delEv = new sql.Request(transaction);
    delEv.input("nro", sql.VarChar(20), nroRegistro);
    await delEv.query("DELETE FROM dbo.EventoClick WHERE NroRegistro = @nro");

    const insOc = new sql.Request(transaction);
    insOc.input("nro", sql.VarChar(20), nroRegistro);
    insOc.input("regimen", sql.VarChar(50), truncate(parsed.regimen, 50));
    insOc.input("nroItem", sql.Int, parsed.nroItem);
    insOc.input("gestion", sql.Int, op.Gestion);
    insOc.input("aduana", sql.Int, op.RecintoId);
    insOc.input("numero", sql.Int, TRY_INT(op.NroDUI));
    insOc.input("fecha", sql.DateTime, ultimaFecha);
    await insOc.query(`
      INSERT INTO dbo.OperacionClick
        (NroRegistro, RegimenAduanero, NroItem, Gestion, Aduana, Numero, FechaUltimaActualizacion)
      VALUES (@nro, @regimen, @nroItem, @gestion, @aduana, @numero, @fecha)
    `);

    for (const ev of parsed.eventos) {
      const insEv = new sql.Request(transaction);
      insEv.input("descripcion", sql.VarChar(300), truncate(ev.descripcion, 300));
      insEv.input("tipo", sql.VarChar(100), truncate(ev.tipo, 100));
      insEv.input("imagen", sql.VarChar(100), truncate(ev.imagen, 100));
      insEv.input("fecha", sql.DateTime, ev.fecha);
      insEv.input("nro", sql.VarChar(20), nroRegistro);
      await insEv.query(`
        INSERT INTO dbo.EventoClick (Descripcion, Tipo, Imagen, Fecha, NroRegistro)
        VALUES (@descripcion, @tipo, @imagen, @fecha, @nro)
      `);
    }

    await transaction.commit();
    return { ultimaFecha, numEvents, nroRegistro };
  } catch (err) {
    await transaction.rollback();
    throw err;
  }
}

function TRY_INT(value) {
  const n = parseInt(value, 10);
  return Number.isNaN(n) ? null : n;
}

async function logJob(pool, result, message) {
  try {
    const req = pool.request();
    req.input("result", sql.Bit, result ? 1 : 0);
    req.input("message", sql.VarChar(sql.MAX), truncate(message || "", 4000));
    await req.query(`
      INSERT INTO dbo.JobLog (Proceso, Result, MessageError, Fecha)
      VALUES ('CLICK', @result, @message, GETDATE())
    `);
  } catch (err) {
    console.error("  [CLICK] no se pudo escribir JobLog:", err.message);
  }
}

async function logError(pool, op, message) {
  try {
    const req = pool.request();
    req.input("operacionId", sql.Int, op.OperacionId);
    req.input("gestion", sql.Int, op.Gestion);
    req.input("aduana", sql.Int, op.RecintoId);
    req.input("nroDui", sql.Int, TRY_INT(op.NroDUI));
    req.input("error", sql.VarChar(sql.MAX), truncate(message || "", 4000));
    await req.query(`
      INSERT INTO dbo.ErroresClick (OperacionId, Gestion, Aduana, NroDui, Error, Activo)
      VALUES (@operacionId, @gestion, @aduana, @nroDui, @error, 1)
    `);
  } catch (err) {
    console.error("  [CLICK] no se pudo escribir ErroresClick:", err.message);
  }
}

async function scrapeAndStore(pool, op) {
  try {
    const parsed = await scrapeClick(op.Gestion, op.RecintoId, op.NroDUI);
    if (!parsed.nroRegistro) {
      throw new Error(parsed.mensaje || "CLICK no devolvió número de registro");
    }
    const stored = await storeResult(pool, op, parsed);
    await logJob(pool, true, "OK");
    return {
      operacionId: op.OperacionId,
      ok: true,
      nroRegistro: stored.nroRegistro,
      eventos: stored.numEvents,
    };
  } catch (err) {
    await logError(pool, op, err.message);
    await logJob(pool, false, `${op.Gestion}${op.RecintoId}${op.NroDUI} *** ${err.message}`);
    return { operacionId: op.OperacionId, ok: false, error: err.message };
  }
}

async function backfillClickOperations({ limit = DEFAULT_LIMIT, dryRun = false } = {}) {
  const pool = await getPool();
  const pendientes = await findPendingClickOperations(limit);
  if (dryRun) {
    return { dryRun: true, pendientes: pendientes.length, operaciones: pendientes };
  }

  const results = [];
  for (const op of pendientes) {
    results.push(await scrapeAndStore(pool, op));
  }
  return {
    dryRun: false,
    procesadas: results.length,
    ok: results.filter((r) => r.ok).length,
    fallidas: results.filter((r) => !r.ok).length,
    results,
  };
}

module.exports = {
  findPendingClickOperations,
  backfillClickOperations,
  scrapeAndStore,
};
