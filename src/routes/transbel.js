const { Router } = require("express");
const XLSX = require("xlsx");
const path = require("path");
const pool = require("../db");
const { authMiddleware } = require("../middleware/auth");
const { findMatch } = require("../services/arancel_matcher");

const router = Router();

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

module.exports = router;
