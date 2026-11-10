const { Router } = require("express");
const XLSX = require("xlsx");
const pool = require("../db");
const { authMiddleware } = require("../middleware/auth");
const { normArancel } = require("../services/arancel_utils");
const { extraerPartidasDeFilas, toDateStr } = require("../services/iva_exencion");

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

router.get("/exenciones", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT e.id, e.decreto, e.vigente_desde, e.vigente_hasta, e.observacion, e.activo,
             COUNT(p.partida_arancel)::int AS partidas
        FROM core.fnning_iva_exencion e
        LEFT JOIN core.fnning_iva_exencion_partida p ON p.exencion_id = e.id
       GROUP BY e.id
       ORDER BY e.vigente_desde DESC, e.id DESC
    `);
    const hoy = new Date().toISOString().slice(0, 10);
    return res.json(
      result.rows.map((row) => ({
        ...row,
        vigente_desde: toDateStr(row.vigente_desde),
        vigente_hasta: row.vigente_hasta ? toDateStr(row.vigente_hasta) : null,
        estado: estadoExencion(row, hoy),
      }))
    );
  } catch (err) {
    console.error("admin-finning exenciones list error:", err);
    return res.status(500).json({ detail: "Error al listar decretos" });
  }
});

router.get("/exenciones/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ detail: "ID invalido" });

    const result = await pool.query(
      "SELECT * FROM core.fnning_iva_exencion WHERE id = $1",
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ detail: "Decreto no encontrado" });
    }

    const partidas = await pool.query(
      `SELECT p.partida_arancel, COALESCE(a.descripcion, '') AS descripcion
         FROM core.fnning_iva_exencion_partida p
         LEFT JOIN core.arancel_nacional a ON a.codigo = p.partida_arancel
        WHERE p.exencion_id = $1
        ORDER BY p.partida_arancel`,
      [id]
    );

    const row = result.rows[0];
    const hoy = new Date().toISOString().slice(0, 10);
    return res.json({
      ...row,
      vigente_desde: toDateStr(row.vigente_desde),
      vigente_hasta: row.vigente_hasta ? toDateStr(row.vigente_hasta) : null,
      estado: estadoExencion(row, hoy),
      partidas: partidas.rows,
    });
  } catch (err) {
    console.error("admin-finning exencion detail error:", err);
    return res.status(500).json({ detail: "Error al obtener el decreto" });
  }
});

router.post("/exenciones", async (req, res) => {
  try {
    const parsed = validarExencion(req.body);
    if (parsed.error) return res.status(422).json({ detail: parsed.error });
    const { decreto, desde, hasta, observacion, activo } = parsed.data;

    const result = await pool.query(
      `INSERT INTO core.fnning_iva_exencion
         (decreto, vigente_desde, vigente_hasta, observacion, activo)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [decreto, desde, hasta, observacion, activo]
    );
    return res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("admin-finning exencion create error:", err);
    return res.status(500).json({ detail: "Error al crear el decreto" });
  }
});

router.put("/exenciones/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ detail: "ID invalido" });

    const parsed = validarExencion(req.body);
    if (parsed.error) return res.status(422).json({ detail: parsed.error });
    const { decreto, desde, hasta, observacion, activo } = parsed.data;

    const result = await pool.query(
      `UPDATE core.fnning_iva_exencion SET
         decreto = $1, vigente_desde = $2, vigente_hasta = $3,
         observacion = $4, activo = $5, updated_at = NOW()
       WHERE id = $6
       RETURNING *`,
      [decreto, desde, hasta, observacion, activo, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ detail: "Decreto no encontrado" });
    }
    return res.json(result.rows[0]);
  } catch (err) {
    console.error("admin-finning exencion update error:", err);
    return res.status(500).json({ detail: "Error al actualizar el decreto" });
  }
});

router.delete("/exenciones/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ detail: "ID invalido" });

    const result = await pool.query(
      "DELETE FROM core.fnning_iva_exencion WHERE id = $1 RETURNING id",
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ detail: "Decreto no encontrado" });
    }
    return res.json({ detail: "Decreto eliminado correctamente" });
  } catch (err) {
    console.error("admin-finning exencion delete error:", err);
    return res.status(500).json({ detail: "Error al eliminar el decreto" });
  }
});

router.put("/exenciones/:id/partidas", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ detail: "ID invalido" });
    if (!Array.isArray(req.body?.partidas)) {
      return res.status(422).json({ detail: "partidas debe ser un arreglo" });
    }

    const exists = await pool.query("SELECT id FROM core.fnning_iva_exencion WHERE id = $1", [id]);
    if (exists.rows.length === 0) {
      return res.status(404).json({ detail: "Decreto no encontrado" });
    }

    const partidas = [...new Set(req.body.partidas.map(normArancel).filter((p) => p.length === 10))];

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "DELETE FROM core.fnning_iva_exencion_partida WHERE exencion_id = $1",
        [id]
      );
      if (partidas.length > 0) {
        await client.query(
          `INSERT INTO core.fnning_iva_exencion_partida (exencion_id, partida_arancel)
           SELECT $1, p FROM unnest($2::varchar[]) AS p
           ON CONFLICT DO NOTHING`,
          [id, partidas]
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    return res.json({ total: partidas.length });
  } catch (err) {
    console.error("admin-finning exencion partidas error:", err);
    return res.status(500).json({ detail: "Error al guardar las partidas" });
  }
});

router.get("/arancel", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    if (q.length < 2) return res.json([]);

    const code = normArancel(q);
    const codePrefix = code.length >= 4 ? code.slice(0, code.length) + "%" : null;

    const result = await pool.query(
      `SELECT codigo, descripcion, ga_porcentaje, ga_reducido, iva
         FROM core.arancel_nacional
        WHERE descripcion ILIKE $1
           OR ($2::text IS NOT NULL AND codigo LIKE $2)
        ORDER BY codigo
        LIMIT 50`,
      [`%${q}%`, codePrefix]
    );
    return res.json(result.rows);
  } catch (err) {
    console.error("admin-finning arancel search error:", err);
    return res.status(500).json({ detail: "Error al buscar partidas" });
  }
});

router.post("/exenciones/:id/importar-partidas", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ detail: "ID invalido" });
    if (!req.files || !req.files.excel) {
      return res.status(400).json({ detail: "Archivo Excel requerido (campo: excel)" });
    }

    const exists = await pool.query("SELECT id FROM core.fnning_iva_exencion WHERE id = $1", [id]);
    if (exists.rows.length === 0) {
      return res.status(404).json({ detail: "Decreto no encontrado" });
    }

    const file = req.files.excel;
    const extension = String(file.name || "").toLowerCase().split(".").pop();
    if (!["xls", "xlsx", "xlsm"].includes(extension)) {
      return res.status(400).json({ detail: "Formato no soportado. Use .xls, .xlsx o .xlsm" });
    }

    const workbook = XLSX.read(file.data, { type: "buffer" });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, defval: "" });
    const { partidas, invalidas } = extraerPartidasDeFilas(rows);

    if (partidas.length === 0) {
      return res.status(400).json({ detail: "El archivo no contiene partidas de 10 digitos" });
    }

    const insert = await pool.query(
      `INSERT INTO core.fnning_iva_exencion_partida (exencion_id, partida_arancel)
       SELECT $1, p FROM unnest($2::varchar[]) AS p
       ON CONFLICT DO NOTHING`,
      [id, partidas]
    );

    return res.json({
      leidas: partidas.length,
      agregadas: insert.rowCount,
      yaExistian: partidas.length - insert.rowCount,
      invalidas,
    });
  } catch (err) {
    console.error("admin-finning importar partidas error:", err);
    return res.status(500).json({ detail: "Error al importar las partidas: " + err.message });
  }
});

function estadoExencion(row, hoy) {
  if (!row.activo) return "inactivo";
  const desde = toDateStr(row.vigente_desde);
  const hasta = row.vigente_hasta ? toDateStr(row.vigente_hasta) : null;
  if (desde && desde > hoy) return "futuro";
  if (hasta && hasta < hoy) return "vencido";
  return "vigente";
}

function validarExencion(body) {
  const data = body || {};
  const decreto = String(data.decreto || "").trim();
  if (!decreto) return { error: "El nombre del decreto es requerido" };

  const desde = toDateStr(data.vigente_desde);
  if (!desde) return { error: "La vigencia desde es requerida" };

  const hasta = data.vigente_hasta ? toDateStr(data.vigente_hasta) : null;
  if (data.vigente_hasta && !hasta) return { error: "La vigencia hasta es invalida" };
  if (hasta && hasta < desde) {
    return { error: "La vigencia hasta no puede ser anterior a la vigencia desde" };
  }

  return {
    data: {
      decreto,
      desde,
      hasta,
      observacion: data.observacion ? String(data.observacion).trim() : null,
      activo: data.activo !== false,
    },
  };
}

module.exports = router;
