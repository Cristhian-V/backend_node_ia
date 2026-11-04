const { Router } = require("express");
const pool = require("../db");
const { authMiddleware } = require("../middleware/auth");
const {
  VacacionesError,
  actualizarLicencia,
  bloquearPlan,
  crearAjuste,
  crearBloque,
  crearCategoria,
  crearDiaTomado,
  crearFeriado,
  crearGrupo,
  desbloquearPlan,
  editarBloque,
  editarAjuste,
  editarCategoria,
  editarFeriado,
  editarGrupo,
  eliminarAjuste,
  eliminarBloque,
  eliminarCategoria,
  eliminarFeriado,
  eliminarGrupo,
  getCandidatos,
  getCategorias,
  getConflictos,
  getCronograma,
  getDiasTomados,
  getFeriados,
  getFuncionarios,
  getGrupos,
  getPlanEstado,
  getSaldosIniciales,
  listAjustes,
  recalcularCorresponden,
  recalcularTodos,
  saveSaldosIniciales,
  upsertFuncionario,
} = require("../services/vacaciones");
const { applyImport, previewImport } = require("../services/vacaciones_import");

const router = Router();

function isIntegreError(err) {
  return (
    err &&
    !(err instanceof VacacionesError) &&
    (err.name === "ConnectionError" ||
      ["ESOCKET", "ETIMEOUT", "ECONNCLOSED", "ENOTOPEN"].includes(err.code) ||
      /Failed to connect|connect ECONNREFUSED|timeout/i.test(err.message || ""))
  );
}

function handle(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof VacacionesError || err.status) {
        return res.status(err.status || 400).json({ detail: err.message });
      }
      if (isIntegreError(err)) {
        console.error("vacaciones integre error:", err.message);
        return res.status(503).json({
          detail: "No se pudo conectar con Integgre. Intente nuevamente en unos minutos.",
        });
      }
      console.error("vacaciones error:", err);
      return res.status(500).json({ detail: "Error interno: " + err.message });
    }
  };
}

async function requireVacaciones(req, res, next) {
  try {
    if (req.user.is_admin) return next();
    const toolsResult = await pool.query(
      "SELECT tool_key FROM core.user_tools WHERE user_id = $1",
      [req.user.id]
    );
    const hasTool = toolsResult.rows.some((t) => t.tool_key === "cronograma_vacaciones");
    if (!hasTool) return res.status(403).json({ detail: "Acceso denegado" });
    next();
  } catch (err) {
    return res.status(500).json({ detail: "Error interno: " + err.message });
  }
}

function requireAdmin(req, res, next) {
  if (!req.user || !req.user.is_admin) {
    return res.status(403).json({ detail: "Acceso denegado: se requiere administrador" });
  }
  next();
}

router.use(authMiddleware);
router.use(requireVacaciones);

router.get(
  "/funcionarios",
  handle(async (req, res) => {
    const funcionarios = await getFuncionarios(req.query.gestion);
    return res.json(funcionarios);
  })
);

router.get(
  "/candidatos",
  requireAdmin,
  handle(async (req, res) => {
    return res.json(await getCandidatos());
  })
);

router.patch(
  "/funcionarios/:usuarioId",
  requireAdmin,
  handle(async (req, res) => {
    const row = await upsertFuncionario(req.params.usuarioId, req.body, req.user.id);
    return res.json(row);
  })
);

router.post(
  "/funcionarios/recalcular-todos",
  requireAdmin,
  handle(async (req, res) => {
    return res.json(await recalcularTodos(req.body.gestion, req.user.id));
  })
);

router.post(
  "/funcionarios/:usuarioId/recalcular",
  requireAdmin,
  handle(async (req, res) => {
    return res.json(
      await recalcularCorresponden(req.params.usuarioId, req.body.gestion, req.user.id)
    );
  })
);

router.get(
  "/categorias",
  handle(async (req, res) => {
    return res.json(await getCategorias());
  })
);

router.post(
  "/categorias",
  requireAdmin,
  handle(async (req, res) => {
    return res.status(201).json(await crearCategoria(req.body));
  })
);

router.patch(
  "/categorias/:id",
  requireAdmin,
  handle(async (req, res) => {
    return res.json(await editarCategoria(req.params.id, req.body));
  })
);

router.delete(
  "/categorias/:id",
  requireAdmin,
  handle(async (req, res) => {
    return res.json(await eliminarCategoria(req.params.id));
  })
);

router.get(
  "/saldos-iniciales",
  handle(async (req, res) => {
    const all = await getSaldosIniciales();
    const gestion = req.query.gestion ? Number(req.query.gestion) : null;
    return res.json(gestion ? all.filter((s) => s.gestion === gestion) : all);
  })
);

router.post(
  "/saldos-iniciales",
  requireAdmin,
  handle(async (req, res) => {
    const items = req.body.items ?? req.body;
    return res.json(await saveSaldosIniciales(items, req.user.id));
  })
);

router.get(
  "/ajustes",
  handle(async (req, res) => {
    return res.json(await listAjustes(req.query.usuarioId, req.query.gestion));
  })
);

router.post(
  "/ajustes",
  requireAdmin,
  handle(async (req, res) => {
    return res.status(201).json(await crearAjuste(req.body, req.user.id));
  })
);

router.patch(
  "/ajustes/:id",
  requireAdmin,
  handle(async (req, res) => {
    return res.json(await editarAjuste(req.params.id, req.body));
  })
);

router.delete(
  "/ajustes/:id",
  requireAdmin,
  handle(async (req, res) => {
    return res.json(await eliminarAjuste(req.params.id));
  })
);

router.get(
  "/cronograma",
  handle(async (req, res) => {
    return res.json(await getCronograma(req.query.gestion));
  })
);

router.get(
  "/cronograma/estado",
  handle(async (req, res) => {
    return res.json(await getPlanEstado(req.query.gestion));
  })
);

router.post(
  "/cronograma/generar",
  requireAdmin,
  handle(async (req, res) => {
    const { generarCronograma } = require("../services/vacaciones");
    const result = await generarCronograma(req.body.gestion, req.user.id, req.body.confirmar);
    return res.json(result);
  })
);

router.post(
  "/cronograma/bloquear",
  requireAdmin,
  handle(async (req, res) => {
    return res.json(await bloquearPlan(req.body.gestion, req.user.id));
  })
);

router.post(
  "/cronograma/desbloquear",
  requireAdmin,
  handle(async (req, res) => {
    return res.json(await desbloquearPlan(req.body.gestion, req.user.id));
  })
);

router.post(
  "/planes",
  requireAdmin,
  handle(async (req, res) => {
    return res.status(201).json(await crearBloque(req.body, req.user.id));
  })
);

router.patch(
  "/planes/:id",
  requireAdmin,
  handle(async (req, res) => {
    return res.json(await editarBloque(req.params.id, req.body, req.user.id));
  })
);

router.delete(
  "/planes/:id",
  requireAdmin,
  handle(async (req, res) => {
    return res.json(await eliminarBloque(req.params.id));
  })
);

router.get(
  "/dias-tomados",
  handle(async (req, res) => {
    const incluirInactivas = String(req.query.incluirInactivas || "") === "true";
    return res.json(await getDiasTomados(req.query.gestion, { incluirInactivas }));
  })
);

router.post(
  "/dias-tomados",
  requireAdmin,
  handle(async (req, res) => {
    return res.status(201).json(
      await crearDiaTomado(req.body, req.user.id, req.user.email)
    );
  })
);

router.patch(
  "/licencias/:id",
  requireAdmin,
  handle(async (req, res) => {
    return res.json(await actualizarLicencia(req.params.id, req.body, req.user.id));
  })
);

router.get(
  "/conflictos",
  handle(async (req, res) => {
    return res.json(await getConflictos(req.query.gestion));
  })
);

router.get(
  "/grupos",
  handle(async (req, res) => {
    return res.json(await getGrupos());
  })
);

router.post(
  "/grupos",
  requireAdmin,
  handle(async (req, res) => {
    return res.status(201).json(await crearGrupo(req.body));
  })
);

router.put(
  "/grupos/:id",
  requireAdmin,
  handle(async (req, res) => {
    return res.json(await editarGrupo(req.params.id, req.body));
  })
);

router.delete(
  "/grupos/:id",
  requireAdmin,
  handle(async (req, res) => {
    return res.json(await eliminarGrupo(req.params.id));
  })
);

router.get(
  "/feriados",
  handle(async (req, res) => {
    return res.json(await getFeriados(req.query.gestion));
  })
);

router.post(
  "/feriados",
  requireAdmin,
  handle(async (req, res) => {
    return res.status(201).json(await crearFeriado(req.body));
  })
);

router.patch(
  "/feriados/:id",
  requireAdmin,
  handle(async (req, res) => {
    return res.json(await editarFeriado(req.params.id, req.body));
  })
);

router.delete(
  "/feriados/:id",
  requireAdmin,
  handle(async (req, res) => {
    return res.json(await eliminarFeriado(req.params.id));
  })
);

router.post(
  "/importar/preview",
  requireAdmin,
  handle(async (req, res) => {
    if (!req.files || !req.files.archivo) {
      return res.status(400).json({ detail: "Archivo Excel requerido (campo: archivo)" });
    }
    const file = req.files.archivo;
    return res.json(await previewImport(file.data));
  })
);

router.post(
  "/importar/apply",
  requireAdmin,
  handle(async (req, res) => {
    return res.json(await applyImport(req.body, req.user.id, req.body.archivoHash || null));
  })
);

module.exports = router;
