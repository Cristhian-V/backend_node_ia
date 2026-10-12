const { Router } = require("express");
const XLSX = require("xlsx");
const path = require("path");
const pool = require("../db");
const { authMiddleware } = require("../middleware/auth");
const { findMatch } = require("../services/arancel_matcher");
const {
  findPendingClickOperations,
  backfillClickOperations,
} = require("../services/click_backfill");
const { listPendientes, sincronizar } = require("../services/transbel_sync");

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
    const pendientes = await listPendientes(limit);
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

module.exports = router;
