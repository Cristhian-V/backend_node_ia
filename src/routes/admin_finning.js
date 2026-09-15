const { Router } = require("express");
const XLSX = require("xlsx");
const pool = require("../db");
const { authMiddleware } = require("../middleware/auth");
const { normArancel } = require("../services/arancel_utils");

const router = Router();

const REQUIRED_COLUMNS = {
  codigo_sap: ["CODIGO_SAP"],
  codigo_mod: ["CODIGO_MOD"],
  material: ["MATERIAL"],
  partida_arancel: ["PARTIDA_ARANCEL"],
  descripcion_dim: ["DESCRIPCION_DIM"],
};

const INSERT_BATCH = 500;

function normHeader(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "_");
}

function cellText(row, idx) {
  const value = row[idx];
  if (value == null) return "";
  return String(value).trim();
}

router.use(authMiddleware);

router.use(async (req, res, next) => {
  try {
    const toolsResult = await pool.query(
      "SELECT tool_key FROM core.user_tools WHERE user_id = $1",
      [req.user.id]
    );
    const hasTool = toolsResult.rows.some((t) => t.tool_key === "admin_finning");
    if (!hasTool && !req.user.is_admin) {
      return res.status(403).json({ detail: "Acceso denegado" });
    }
    next();
  } catch (err) {
    return res.status(500).json({ detail: "Error verificando permisos" });
  }
});

router.get("/estado", async (req, res) => {
  try {
    const result = await pool.query("SELECT COUNT(*)::int AS total FROM core.fnning_items");
    const total = result.rows[0].total;
    return res.json({ total, vacia: total === 0 });
  } catch (err) {
    console.error("admin-finning estado error:", err);
    return res.status(500).json({ detail: "Error al obtener el estado" });
  }
});

router.post("/cargar-excel", async (req, res) => {
  try {
    if (!req.files || !req.files.excel) {
      return res.status(400).json({ detail: "Archivo Excel requerido (campo: excel)" });
    }

    const countResult = await pool.query("SELECT COUNT(*)::int AS total FROM core.fnning_items");
    if (countResult.rows[0].total > 0) {
      return res.status(409).json({
        detail: "La tabla ya contiene datos. La carga solo se permite cuando esta vacia.",
      });
    }

    const file = req.files.excel;
    const extension = String(file.name || "").toLowerCase().split(".").pop();
    if (!["xls", "xlsx", "xlsm"].includes(extension)) {
      return res.status(400).json({ detail: "Formato no soportado. Use .xls, .xlsx o .xlsm" });
    }

    const workbook = XLSX.read(file.data, { type: "buffer" });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false });
    if (rows.length < 2) {
      return res.status(400).json({ detail: "El Excel no contiene registros" });
    }

    const headerRow = rows[0].map(normHeader);
    const columnIndex = {};
    for (const key of Object.keys(REQUIRED_COLUMNS)) {
      const found = headerRow.findIndex((h) => REQUIRED_COLUMNS[key].includes(h));
      if (found === -1) {
        return res.status(400).json({ detail: `Falta la columna ${REQUIRED_COLUMNS[key][0]}` });
      }
      columnIndex[key] = found;
    }

    const records = [];
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      const codigoSap = cellText(row, columnIndex.codigo_sap);
      if (!codigoSap) continue;
      records.push([
        codigoSap,
        cellText(row, columnIndex.codigo_mod) || null,
        cellText(row, columnIndex.material) || null,
        normArancel(row[columnIndex.partida_arancel]),
        cellText(row, columnIndex.descripcion_dim) || null,
      ]);
    }

    if (records.length === 0) {
      return res.status(400).json({ detail: "No se encontraron registros validos" });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (let start = 0; start < records.length; start += INSERT_BATCH) {
        const chunk = records.slice(start, start + INSERT_BATCH);
        const values = [];
        const placeholders = chunk.map((record, ri) => {
          const base = ri * 5;
          values.push(...record);
          return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`;
        });
        await client.query(
          `INSERT INTO core.fnning_items (codigo_sap, codigo_mod, material, partida_arancel, descripcion_dim)
           VALUES ${placeholders.join(", ")}`,
          values
        );
      }
      await client.query("COMMIT");
    } catch (insertErr) {
      await client.query("ROLLBACK");
      throw insertErr;
    } finally {
      client.release();
    }

    return res.json({ insertados: records.length });
  } catch (err) {
    console.error("admin-finning cargar error:", err);
    return res.status(500).json({ detail: "Error al cargar el Excel: " + err.message });
  }
});

router.get("/validacion", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT codigo_sap, MIN(codigo_mod) AS codigo_mod,
             COUNT(DISTINCT partida_arancel) AS n, array_agg(DISTINCT partida_arancel) AS partidas
      FROM core.fnning_items
      WHERE codigo_sap <> '' AND partida_arancel <> ''
      GROUP BY codigo_sap
      HAVING COUNT(DISTINCT partida_arancel) > 1
      ORDER BY n DESC
      LIMIT 1000
    `);

    const allCodes = new Set();
    for (const r of result.rows) for (const c of r.partidas) allCodes.add(c);
    const descMap = {};
    if (allCodes.size > 0) {
      const descResult = await pool.query(
        "SELECT codigo, descripcion FROM core.arancel_nacional WHERE codigo = ANY($1)",
        [[...allCodes]]
      );
      for (const row of descResult.rows) descMap[row.codigo] = row.descripcion;
    }

    return res.json(
      result.rows.map((r) => ({
        codigo_sap: r.codigo_sap,
        codigo_mod: r.codigo_mod || "",
        n: parseInt(r.n),
        partidas: r.partidas.map((c) => ({ codigo: c, descripcion: descMap[c] || "" })),
      }))
    );
  } catch (err) {
    console.error("admin-finning validacion error:", err);
    return res.status(500).json({ detail: "Error al validar" });
  }
});

router.get("/items", async (req, res) => {
  try {
    const { codigo_sap } = req.query;
    if (!codigo_sap) {
      return res.status(422).json({ detail: "codigo_sap es requerido" });
    }
    const result = await pool.query(
      `SELECT id, codigo_sap, codigo_mod, material, partida_arancel, descripcion_dim, resuelto
       FROM core.fnning_items WHERE codigo_sap = $1 ORDER BY id`,
      [String(codigo_sap)]
    );
    return res.json(result.rows);
  } catch (err) {
    console.error("admin-finning items error:", err);
    return res.status(500).json({ detail: "Error al obtener registros" });
  }
});

router.post("/resolver", async (req, res) => {
  try {
    const { codigo_sap, partida_arancel } = req.body || {};
    if (!codigo_sap || !partida_arancel) {
      return res.status(422).json({ detail: "codigo_sap y partida_arancel son requeridos" });
    }
    const cod = normArancel(partida_arancel);
    const upd = await pool.query(
      "UPDATE core.fnning_items SET partida_arancel = $1, resuelto = TRUE WHERE codigo_sap = $2",
      [cod, codigo_sap]
    );
    return res.json({ status: "ok", actualizados: upd.rowCount, codigo_sap, partida_arancel: cod });
  } catch (err) {
    console.error("admin-finning resolver error:", err);
    return res.status(500).json({ detail: "Error al resolver" });
  }
});

module.exports = router;
