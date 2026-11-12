const { Router } = require("express");
const XLSX = require("xlsx");
const path = require("path");
const pool = require("../db");
const { authMiddleware, adminMiddleware } = require("../middleware/auth");
const { findMatch } = require("../services/arancel_matcher");
const {
  findPendingClickOperations,
  backfillClickOperations,
  processClickOperations,
} = require("../services/click_backfill");
const {
  listPendientes: listSincPendientes,
  sincronizar,
  selectProcessablePendientes,
} = require("../services/transbel_sync");
const {
  listPendientesConIgnorados,
  listHistorial,
  getCatalogo,
  asignarExcepcion,
  actualizarReferencia,
  ignorarPendiente,
  restaurarPendiente,
  procesarPendiente,
  recordAudit,
} = require("../services/transbel_excepciones");

const router = Router();

async function requireTransbel(req, res, next) {
  try {
    const toolsResult = await pool.query(
      "SELECT tool_key FROM core.user_tools WHERE user_id = $1",
      [req.user.id]
    );
    const hasTransbel = toolsResult.rows.some(
      (t) => t.tool_key === "herramientas_transbel"
    );
    if (!hasTransbel && !req.user.is_admin) {
      return res.status(403).json({ detail: "Acceso denegado" });
    }
    next();
  } catch (err) {
    return res.status(500).json({ detail: "Error interno: " + err.message });
  }
}

router.post("/clasificar", authMiddleware, async (req, res) => {
  try {
    const toolsResult = await pool.query(
      "SELECT tool_key FROM core.user_tools WHERE user_id = $1",
      [req.user.id]
    );
    const hasTransbel = toolsResult.rows.some(
      (t) => t.tool_key === "herramientas_transbel"
    );
    if (!hasTransbel && !req.user.is_admin) {
      return res.status(403).json({ detail: "Acceso denegado" });
    }

    if (!req.files || !req.files.archivo) {
      return res.status(400).json({ detail: "Archivo Excel requerido (campo: archivo)" });
    }

    const file = req.files.archivo;
    const wb = XLSX.read(file.data, { type: "buffer" });
    const sn = wb.SheetNames.find(
      (name) => name.toUpperCase().includes("FICHA") || name.toUpperCase().includes("COMEX")
    ) || wb.SheetNames[0];

    const ws = wb.Sheets[sn];
    const data = XLSX.utils.sheet_to_json(ws, { header: 1 });

    if (data.length < 18) {
      return res.status(400).json({ detail: "El archivo no tiene el formato esperado" });
    }

    const colBol = 2;
    const colCol = 4;

    const codigoCO = String(data[11]?.[colCol] || "").trim();
    const descripcionCO = String(data[12]?.[colCol] || "").trim();
    const certOrigenCO = String(data[14]?.[colCol] || "").trim();

    if (!codigoCO) {
      return res.status(400).json({ detail: "No se encontro la partida arancelaria de Colombia (fila 12, columna E)" });
    }

    const match = await findMatch(codigoCO, descripcionCO);

    const ROW_FILL = [
      { r: 12, val: match ? match.codigo : "No encontrado" },
      { r: 13, val: descripcionCO },
      { r: 14, val: match ? match.descripcion_partida : "" },
      { r: 15, val: certOrigenCO || "NA" },
      { r: 16, val: "-" },
      { r: 17, val: match && match.arancel != null ? String(match.arancel) : "-" },
      { r: 18, val: "14.94" },
      { r: 19, val: "-" },
      { r: 20, val: "-" },
      { r: 21, val: "-" },
      { r: 22, val: "-" },
    ];

    for (const fill of ROW_FILL) {
      const cellRef = XLSX.utils.encode_cell({ r: fill.r - 1, c: colBol });
      ws[cellRef] = { v: fill.val, t: "s" };
    }

    const buf = XLSX.write(wb, { type: "buffer", bookType: "xls" });

    const origName = path.parse(file.name).name;
    const downloadName = `${origName} - Procesado.xls`;

    res.setHeader("Content-Type", "application/vnd.ms-excel");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${downloadName}"`
    );
    return res.send(buf);
  } catch (err) {
    console.error("clasificar error:", err);
    return res.status(500).json({ detail: "Error interno: " + err.message });
  }
});

router.get("/click/pendientes", authMiddleware, requireTransbel, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || "100", 10) || 100, 500);
    const pendientes = await findPendingClickOperations(limit);
    return res.json({ total: pendientes.length, operaciones: pendientes });
  } catch (err) {
    console.error("click/pendientes error:", err);
    return res.status(500).json({ detail: "Error interno: " + err.message });
  }
});

router.post("/click/backfill", authMiddleware, requireTransbel, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.body?.limit || "100", 10) || 100, 500);
    const dryRun = req.body?.dryRun === true || req.query.dryRun === "true";
    const result = await backfillClickOperations({ limit, dryRun });
    return res.json(result);
  } catch (err) {
    console.error("click/backfill error:", err);
    return res.status(500).json({ detail: "Error interno: " + err.message });
  }
});

router.get("/sincronizacion/pendientes", authMiddleware, requireTransbel, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || "200", 10) || 200, 500);
    const pendientes = await listSincPendientes(limit);
    return res.json({
      total: pendientes.length,
      completos: pendientes.filter((p) => p.completo).length,
      pendientes,
    });
  } catch (err) {
    console.error("transbel/sincronizacion/pendientes error:", err);
    return res.status(500).json({ detail: "Error interno: " + err.message });
  }
});

router.post("/sincronizacion/enviar", authMiddleware, requireTransbel, async (req, res) => {
  try {
    const operacionIds = Array.isArray(req.body?.operacionIds)
      ? req.body.operacionIds.map((n) => parseInt(n, 10)).filter((n) => !Number.isNaN(n))
      : undefined;
    const result = await sincronizar({ operacionIds });
    return res.json(result);
  } catch (err) {
    console.error("transbel/sincronizacion/enviar error:", err);
    return res.status(502).json({ detail: err.message || "Error al enviar a Workato" });
  }
});

router.get("/excepciones/pendientes", adminMiddleware, async (req, res) => {
  try {
    const { pendientes, ignorados } = await listPendientesConIgnorados();
    return res.json({
      total: pendientes.length,
      pendientes,
      totalIgnorados: ignorados.length,
      ignorados,
    });
  } catch (err) {
    console.error("transbel/excepciones/pendientes error:", err);
    return res.status(500).json({ detail: "Error interno: " + err.message });
  }
});

router.get("/excepciones/historial", adminMiddleware, async (req, res) => {
  try {
    const pendientes = await listHistorial();
    return res.json({ total: pendientes.length, pendientes });
  } catch (err) {
    console.error("transbel/excepciones/historial error:", err);
    return res.status(500).json({ detail: "Error interno: " + err.message });
  }
});

router.get("/excepciones/catalogo", adminMiddleware, async (req, res) => {
  try {
    const catalogo = await getCatalogo();
    return res.json({ total: catalogo.length, catalogo });
  } catch (err) {
    console.error("transbel/excepciones/catalogo error:", err);
    return res.status(500).json({ detail: "Error interno: " + err.message });
  }
});

router.post("/excepciones", adminMiddleware, async (req, res) => {
  try {
    const result = await asignarExcepcion({
      operacionId: req.body?.operacionId,
      excepcionId: req.body?.excepcionId,
      usuario: req.user,
    });
    return res.json(result);
  } catch (err) {
    const status =
      err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
    if (status >= 500) console.error("transbel/excepciones error:", err);
    return res
      .status(status)
      .json({ detail: err.message || "Error al asignar excepcion" });
  }
});

router.post("/excepciones/ignorar", adminMiddleware, async (req, res) => {
  try {
    const result = await ignorarPendiente({
      operacionId: req.body?.operacionId,
      motivo: req.body?.motivo,
      usuario: req.user,
    });
    return res.json(result);
  } catch (err) {
    const status =
      err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
    if (status >= 500)
      console.error("transbel/excepciones/ignorar error:", err);
    return res
      .status(status)
      .json({ detail: err.message || "Error al ignorar la operacion" });
  }
});

router.post("/excepciones/restaurar", adminMiddleware, async (req, res) => {
  try {
    const result = await restaurarPendiente({
      operacionId: req.body?.operacionId,
      usuario: req.user,
    });
    return res.json(result);
  } catch (err) {
    const status =
      err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
    if (status >= 500)
      console.error("transbel/excepciones/restaurar error:", err);
    return res
      .status(status)
      .json({ detail: err.message || "Error al restaurar la operacion" });
  }
});

router.post("/excepciones/referencia", adminMiddleware, async (req, res) => {
  try {
    const result = await actualizarReferencia({
      operacionId: req.body?.operacionId,
      referenciaCliente: req.body?.referenciaCliente,
      usuario: req.user,
    });
    return res.json(result);
  } catch (err) {
    const status =
      err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
    if (status >= 500)
      console.error("transbel/excepciones/referencia error:", err);
    return res
      .status(status)
      .json({ detail: err.message || "Error al actualizar la referencia" });
  }
});

router.post("/excepciones/procesar", adminMiddleware, async (req, res) => {
  try {
    const result = await procesarPendiente({
      operacionId: req.body?.operacionId,
      usuario: req.user,
    });
    return res.json(result);
  } catch (err) {
    const status =
      err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
    if (status >= 500) console.error("transbel/excepciones/procesar error:", err);
    return res
      .status(status)
      .json({ detail: err.message || "Error al procesar la operacion" });
  }
});

router.get("/sincronizacion/incompletos", adminMiddleware, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || "500", 10) || 500, 500);
    const pendientes = await listSincPendientes(limit);
    const incompletos = pendientes.filter((p) => !p.completo);
    return res.json({ total: incompletos.length, pendientes: incompletos });
  } catch (err) {
    console.error("transbel/sincronizacion/incompletos error:", err);
    return res.status(500).json({ detail: "Error interno: " + err.message });
  }
});

router.post("/sincronizacion/procesar", adminMiddleware, async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.operacionIds)
      ? req.body.operacionIds
          .map((n) => parseInt(n, 10))
          .filter((n) => !Number.isNaN(n))
      : [];
    if (ids.length === 0) {
      return res.status(400).json({ detail: "operacionIds requerido" });
    }

    const pendientes = await listSincPendientes(500);
    const incompletos = pendientes.filter((p) => !p.completo);
    const byId = new Map(incompletos.map((p) => [p.operacionId, p]));
    const seleccionadas = selectProcessablePendientes(incompletos, ids);
    const procesables = seleccionadas.filter((p) => p.procesable);
    const noProcesables = [];

    for (const id of ids) {
      const p = byId.get(id);
      if (!p) {
        noProcesables.push({
          operacionId: id,
          motivo: "No figura como dato incompleto pendiente",
        });
        continue;
      }
      if (!p.procesable) {
        noProcesables.push({
          operacionId: id,
          motivo:
            p.motivo ||
            "No procesable automaticamente: el motivo no depende de CLICK",
        });
      }
    }

    const ops = procesables.map((p) => ({
      OperacionId: p.operacionId,
      Gestion: p.gestion,
      RecintoId: p.recinto,
      NroDUI: p.nroDui,
    }));

    const rawResults = await processClickOperations(ops);
    const refreshed = await listSincPendientes(500);
    const afterById = new Map(refreshed.map((p) => [p.operacionId, p]));
    const results = rawResults.map((r) => {
      const after = afterById.get(r.operacionId);
      return {
        ...r,
        completo: after ? after.completo : false,
        motivo: after ? after.motivo : "",
      };
    });

    for (const r of results) {
      await recordAudit({
        operacionId: r.operacionId,
        accion: "procesar",
        resultado: r.ok ? "ok" : "error",
        usuario: req.user,
        motivo: r.ok ? r.motivo || null : r.error || "Error en backfill CLICK",
        payload: { nroRegistro: r.nroRegistro || null, completo: r.completo },
      });
    }
    for (const n of noProcesables) {
      await recordAudit({
        operacionId: n.operacionId,
        accion: "procesar",
        resultado: "error",
        usuario: req.user,
        motivo: n.motivo,
        payload: { noProcesable: true },
      });
    }

    return res.json({
      procesadas: procesables.length,
      ok: results.filter((r) => r.ok).length,
      fallidas: results.filter((r) => !r.ok).length,
      noProcesables,
      results,
    });
  } catch (err) {
    console.error("transbel/sincronizacion/procesar error:", err);
    return res.status(500).json({ detail: "Error interno: " + err.message });
  }
});

module.exports = router;
