const { Router } = require("express");
const pool = require("../db");
const { authMiddleware } = require("../middleware/auth");
const { importSuma, parseDate } = require("../services/control_suma");
const { resolverOperacion } = require("../services/control_integre");
const { enriquecerResultado } = require("../services/control_resultado");

const router = Router();

const OPERACION_SELECT = `
  SELECT
    o.id, o.dim, o.gestion, o.aduana, o.dui,
    o.aduana_codigo, o.aduana_descripcion,
    TO_CHAR(o.fecha_aceptacion, 'YYYY-MM-DD') AS fecha_aceptacion,
    o.estado, o.nit_declarante, o.razon_social_declarante, o.nro_referencia,
    o.destino_regimen_codigo, o.destino_regimen_descripcion,
    o.modalidad_regimen_codigo, o.modalidad_regimen_descripcion, o.modalidad_despacho,
    o.total_items, o.nit_importador, o.razon_social_importador,
    o.valor_cif, o.peso_bruto, o.tributos, o.rup_pago,
    TO_CHAR(o.fecha_pago, 'YYYY-MM-DD') AS fecha_pago,
    o.canal,
    TO_CHAR(o.fecha_asignacion_canal, 'YYYY-MM-DD') AS fecha_asignacion_canal,
    TO_CHAR(o.fecha_levante, 'YYYY-MM-DD') AS fecha_levante,
    TO_CHAR(o.fecha_regularizacion, 'YYYY-MM-DD') AS fecha_regularizacion,
    TO_CHAR(o.fecha_conclusion, 'YYYY-MM-DD') AS fecha_conclusion,
    o.regimen, o.dui_due, o.liquidador, o.planilla, o.planillado, o.planillador, o.observaciones,
    TO_CHAR(o.fecha_reporte_pago, 'YYYY-MM-DD') AS fecha_reporte_pago,
    o.archivo_origen,
    c.nombre AS cliente_nombre
  FROM core.control_operaciones o
  LEFT JOIN core.control_clientes c ON c.nit = o.nit_importador
`;

const NUMERIC_FIELDS = ["valor_cif", "peso_bruto", "tributos"];

async function requireControl(req, res, next) {
  try {
    const toolsResult = await pool.query(
      "SELECT tool_key FROM core.user_tools WHERE user_id = $1",
      [req.user.id]
    );
    const hasControl = toolsResult.rows.some(
      (t) => t.tool_key === "control_operaciones"
    );
    if (!hasControl && !req.user.is_admin) {
      return res.status(403).json({ detail: "Acceso denegado" });
    }
    next();
  } catch (err) {
    return res.status(500).json({ detail: "Error interno: " + err.message });
  }
}

function buildFilters(query) {
  const where = [];
  const params = [];
  const add = (value, clause) => {
    if (value == null || value === "") return;
    params.push(value);
    where.push(clause(params.length));
  };
  add(query.fecha_desde, (n) => `o.fecha_pago::date >= $${n}`);
  add(query.fecha_hasta, (n) => `o.fecha_pago::date <= $${n}`);
  add(query.regimen, (n) => `o.regimen = $${n}`);
  add(query.canal, (n) => `o.canal = $${n}`);
  if (query.cliente) {
    params.push(query.cliente);
    const n = params.length;
    where.push(`(o.nit_importador = $${n} OR c.nombre ILIKE '%' || $${n} || '%')`);
  }
  return { where: where.length ? `WHERE ${where.join(" AND ")}` : "", params };
}

function mapRow(row) {
  const result = { ...row };
  for (const f of NUMERIC_FIELDS) {
    if (result[f] != null) result[f] = Number(result[f]);
  }
  return result;
}

router.post("/suma/import", authMiddleware, requireControl, async (req, res) => {
  try {
    if (!req.files || !req.files.archivo) {
      return res.status(400).json({ detail: "Archivo requerido (campo: archivo)" });
    }
    const file = req.files.archivo;
    const summary = await importSuma(
      { buffer: file.data, fileName: file.name },
      { pool, resolver: resolverOperacion }
    );
    return res.json(summary);
  } catch (err) {
    console.error("control/suma/import error:", err);
    return res
      .status(err.statusCode || 500)
      .json({ detail: err.statusCode ? err.message : "Error interno: " + err.message });
  }
});

router.get("/operaciones", authMiddleware, requireControl, async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page || "1", 10) || 1, 1);
    const size = Math.min(Math.max(parseInt(req.query.size || "30", 10) || 30, 1), 200);
    const { where, params } = buildFilters(req.query);

    const totalResult = await pool.query(
      `SELECT COUNT(*) AS n FROM core.control_operaciones o
       LEFT JOIN core.control_clientes c ON c.nit = o.nit_importador ${where}`,
      params
    );
    const total = parseInt(totalResult.rows[0].n, 10);

    const dataResult = await pool.query(
      `${OPERACION_SELECT} ${where} ORDER BY o.fecha_pago DESC NULLS LAST, o.id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, size, (page - 1) * size]
    );

    return res.json({
      data: dataResult.rows.map(mapRow),
      total,
      page,
      pages: Math.max(Math.ceil(total / size), 1),
    });
  } catch (err) {
    console.error("control/operaciones error:", err);
    return res.status(500).json({ detail: "Error interno: " + err.message });
  }
});

const CURATED_FIELDS = [
  "liquidador",
  "planilla",
  "planillado",
  "planillador",
  "canal",
  "fecha_regularizacion",
  "observaciones",
];

router.patch("/operaciones/:id", authMiddleware, requireControl, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ detail: "id inválido" });

    const sets = [];
    const params = [];
    for (const field of CURATED_FIELDS) {
      if (!(field in (req.body || {}))) continue;
      let value = req.body[field];
      if (field === "planilla" || field === "planillado") {
        value = value === "" || value == null ? null : parseInt(value, 10);
        if (value != null && Number.isNaN(value)) value = null;
      } else if (field === "fecha_regularizacion") {
        value = parseDate(value);
      } else if (value === "") {
        value = null;
      }
      params.push(value);
      sets.push(`${field} = $${params.length}`);
    }
    if (sets.length === 0) {
      return res.status(400).json({ detail: "Sin campos para actualizar" });
    }
    params.push(id);
    await pool.query(
      `UPDATE core.control_operaciones SET ${sets.join(", ")}, updated_at = NOW() WHERE id = $${params.length}`,
      params
    );
    const result = await pool.query(`${OPERACION_SELECT} WHERE o.id = $1`, [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ detail: "Operación no encontrada" });
    }
    return res.json(mapRow(result.rows[0]));
  } catch (err) {
    console.error("control/operaciones patch error:", err);
    return res.status(500).json({ detail: "Error interno: " + err.message });
  }
});

router.get("/resultado", authMiddleware, requireControl, async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit || "1000", 10) || 1000, 1), 5000);
    const { where, params } = buildFilters(req.query);
    const result = await pool.query(
      `${OPERACION_SELECT} ${where} ORDER BY o.fecha_pago DESC NULLS LAST, o.id DESC LIMIT $${params.length + 1}`,
      [...params, limit]
    );
    const data = result.rows.map(mapRow).map((row) => enriquecerResultado(row));
    return res.json({ total: data.length, data });
  } catch (err) {
    console.error("control/resultado error:", err);
    return res.status(500).json({ detail: "Error interno: " + err.message });
  }
});

router.post("/operaciones/:id/refresh-integre", authMiddleware, requireControl, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ detail: "id inválido" });

    const current = await pool.query(
      "SELECT id, gestion, aduana, dui FROM core.control_operaciones WHERE id = $1",
      [id]
    );
    if (current.rows.length === 0) {
      return res.status(404).json({ detail: "Operación no encontrada" });
    }
    const op = current.rows[0];
    const info = await resolverOperacion({ gestion: op.gestion, aduana: op.aduana, dui: op.dui });
    if (!info) {
      return res.json({ actualizado: false, detalle: "No se encontró la operación en Integgre" });
    }
    await pool.query(
      "UPDATE core.control_operaciones SET liquidador = $1, planilla = $2, updated_at = NOW() WHERE id = $3",
      [info.liquidador, info.operacionId, id]
    );
    const result = await pool.query(`${OPERACION_SELECT} WHERE o.id = $1`, [id]);
    return res.json({ actualizado: true, operacion: mapRow(result.rows[0]) });
  } catch (err) {
    console.error("control/operaciones refresh error:", err);
    return res.status(500).json({ detail: "Error interno: " + err.message });
  }
});

router.get("/clientes", authMiddleware, requireControl, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT nit, nombre FROM core.control_clientes ORDER BY nombre"
    );
    return res.json(result.rows);
  } catch (err) {
    console.error("control/clientes error:", err);
    return res.status(500).json({ detail: "Error interno: " + err.message });
  }
});

router.get("/filtros", authMiddleware, requireControl, async (req, res) => {
  try {
    const [reg, can, cli] = await Promise.all([
      pool.query(
        "SELECT DISTINCT regimen FROM core.control_operaciones WHERE regimen IS NOT NULL AND regimen <> '' ORDER BY regimen"
      ),
      pool.query(
        "SELECT DISTINCT canal FROM core.control_operaciones WHERE canal IS NOT NULL AND canal <> '' ORDER BY canal"
      ),
      pool.query("SELECT nit, nombre FROM core.control_clientes ORDER BY nombre"),
    ]);
    return res.json({
      regimenes: reg.rows.map((r) => r.regimen),
      canales: can.rows.map((r) => r.canal),
      clientes: cli.rows,
    });
  } catch (err) {
    console.error("control/filtros error:", err);
    return res.status(500).json({ detail: "Error interno: " + err.message });
  }
});

module.exports = router;
