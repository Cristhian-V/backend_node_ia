const pool = require("../db");
const { getPool, sql } = require("../db_sqlserver");
const core = require("./vacaciones_core");

class VacacionesError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "VacacionesError";
    this.status = status;
  }
}

function asInt(value, field = "valor") {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new VacacionesError(`${field} invalido`);
  }
  return n;
}

function asNumber(value, field = "valor", { min = null } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new VacacionesError(`${field} invalido`);
  if (min != null && n < min) throw new VacacionesError(`${field} no puede ser menor que ${min}`);
  return core.round2(n);
}

function asBool(value, fallback = false) {
  if (value == null) return fallback;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (["1", "true", "si", "sí", "yes"].includes(v)) return true;
    if (["0", "false", "no"].includes(v)) return false;
  }
  return Boolean(value);
}

function asDateOrNull(value, field = "fecha") {
  if (value == null || value === "") return null;
  try {
    return core.formatDate(value);
  } catch {
    throw new VacacionesError(`${field} invalida`);
  }
}

function normalizeGestion(value) {
  const n = Number(value);
  const current = new Date().getFullYear();
  if (!Number.isInteger(n)) return current;
  if (n < 2000 || n > 2100) throw new VacacionesError("Gestion invalida");
  return n;
}

function normalizeYearList(desde, hasta) {
  const start = Math.min(Number(desde), Number(hasta));
  const end = Math.max(Number(desde), Number(hasta));
  const years = [];
  for (let year = start; year <= end; year++) years.push(year);
  return years;
}

function buildInClause(ids) {
  const clean = Array.from(new Set((ids || []).map(Number).filter((n) => Number.isInteger(n) && n > 0)));
  if (clean.length === 0) return null;
  return clean.join(",");
}

function toIsoDate(value) {
  if (!value) return null;
  return core.formatDate(value);
}

async function getRoster() {
  const result = await pool.query(
    `SELECT usuario_id, incluido, TO_CHAR(fecha_ingreso, 'YYYY-MM-DD') AS fecha_ingreso,
            categoria, notas
       FROM core.vac_funcionarios
      ORDER BY usuario_id`
  );
  return result.rows.map((row) => ({
    usuarioId: Number(row.usuario_id),
    incluido: Boolean(row.incluido),
    fechaIngreso: row.fecha_ingreso || null,
    categoria: row.categoria || null,
    notas: row.notas || null,
  }));
}

async function getSaldosIniciales() {
  const result = await pool.query(
    `SELECT usuario_id, gestion, dias_corresponden, dias_pendientes, dias_pagados, notas
       FROM core.vac_saldos_iniciales
      ORDER BY usuario_id, gestion`
  );
  return result.rows.map((row) => ({
    usuarioId: Number(row.usuario_id),
    gestion: Number(row.gestion),
    diasCorresponden: Number(row.dias_corresponden),
    diasPendientes: Number(row.dias_pendientes),
    diasPagados: Number(row.dias_pagados),
    notas: row.notas || null,
  }));
}

async function getAjustes(desde, hasta) {
  const result = await pool.query(
    `SELECT id, usuario_id, gestion, dias, tipo, motivo
       FROM core.vac_ajustes
      WHERE gestion BETWEEN $1 AND $2
      ORDER BY usuario_id, gestion, id`,
    [Number(desde), Number(hasta)]
  );
  return result.rows.map((row) => ({
    id: Number(row.id),
    usuarioId: Number(row.usuario_id),
    gestion: Number(row.gestion),
    dias: Number(row.dias),
    tipo: row.tipo,
    motivo: row.motivo || null,
  }));
}

async function getPlanes(gestion) {
  const result = await pool.query(
    `SELECT id, usuario_id, gestion,
            TO_CHAR(fecha_desde, 'YYYY-MM-DD') AS fecha_desde,
            TO_CHAR(fecha_hasta, 'YYYY-MM-DD') AS fecha_hasta,
            dias_planificados, origen, notas
       FROM core.vac_planes
      WHERE gestion = $1
      ORDER BY fecha_desde, id`,
    [Number(gestion)]
  );
  return result.rows.map((row) => ({
    id: Number(row.id),
    usuarioId: Number(row.usuario_id),
    gestion: Number(row.gestion),
    fechaDesde: row.fecha_desde,
    fechaHasta: row.fecha_hasta,
    diasPlanificados: Number(row.dias_planificados),
    origen: row.origen,
    notas: row.notas || null,
  }));
}

async function getPlanEstado(gestion) {
  const result = await pool.query(
    `SELECT gestion, estado, bloqueado_por,
            TO_CHAR(bloqueado_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS bloqueado_at
       FROM core.vac_plan_estado
      WHERE gestion = $1`,
    [Number(gestion)]
  );
  if (result.rows.length === 0) {
    return { gestion: Number(gestion), estado: "borrador", bloqueadoPor: null, bloqueadoAt: null };
  }
  const row = result.rows[0];
  return {
    gestion: Number(row.gestion),
    estado: row.estado,
    bloqueadoPor: row.bloqueado_por ? Number(row.bloqueado_por) : null,
    bloqueadoAt: row.bloqueado_at || null,
  };
}

async function isPlanLocked(gestion) {
  const estado = await getPlanEstado(gestion);
  return estado.estado === "bloqueado";
}

async function assertPlanUnlocked(gestion) {
  if (await isPlanLocked(gestion)) {
    throw new VacacionesError("El plan de esta gestión está bloqueado", 409);
  }
}

async function getFeriadosRango(desde, hasta) {
  const result = await pool.query(
    `SELECT id, TO_CHAR(fecha, 'YYYY-MM-DD') AS fecha, descripcion, ambito, descuenta
       FROM core.vac_feriados
      WHERE EXTRACT(YEAR FROM fecha) BETWEEN $1 AND $2
      ORDER BY fecha`,
    [Number(desde), Number(hasta)]
  );
  return result.rows.map((row) => ({
    id: Number(row.id),
    fecha: row.fecha,
    descripcion: row.descripcion || "",
    ambito: row.ambito,
    descuenta: Boolean(row.descuenta),
  }));
}

async function getFeriados(gestion) {
  return getFeriadosRango(gestion, gestion);
}

async function getOverrides() {
  const result = await pool.query(
    `SELECT usuario_licencia_id, dias_computados, incluida, notas
       FROM core.vac_licencia_overrides`
  );
  const map = new Map();
  for (const row of result.rows) {
    map.set(Number(row.usuario_licencia_id), {
      usuarioLicenciaId: Number(row.usuario_licencia_id),
      diasComputados: row.dias_computados == null ? null : Number(row.dias_computados),
      incluida: Boolean(row.incluida),
      notas: row.notas || null,
    });
  }
  return map;
}

async function getGruposRaw() {
  const result = await pool.query(
    `SELECT g.id, g.nombre, g.cliente, g.notas, m.usuario_id
       FROM core.vac_grupos g
       LEFT JOIN core.vac_grupo_miembros m ON m.grupo_id = g.id
      ORDER BY g.nombre, g.id, m.usuario_id`
  );
  const map = new Map();
  for (const row of result.rows) {
    const id = Number(row.id);
    if (!map.has(id)) {
      map.set(id, {
        id,
        nombre: row.nombre,
        cliente: row.cliente || null,
        notas: row.notas || null,
        miembros: [],
      });
    }
    if (row.usuario_id) map.get(id).miembros.push(Number(row.usuario_id));
  }
  return Array.from(map.values());
}

async function getGrupos() {
  const grupos = await getGruposRaw();
  const memberIds = grupos.flatMap((g) => g.miembros);
  const users = await getIntegreUsers(memberIds);
  const names = new Map(users.map((u) => [u.usuarioId, u.nombre]));
  return grupos.map((grupo) => ({
    ...grupo,
    miembros: grupo.miembros.map((usuarioId) => ({
      usuarioId,
      nombre: names.get(usuarioId) || `Usuario ${usuarioId}`,
    })),
  }));
}

async function getIntegreUsers(usuarioIds) {
  const inClause = buildInClause(usuarioIds);
  if (usuarioIds != null && !inClause) return [];
  const poolSql = await getPool();
  const where = inClause ? `WHERE UsuarioId IN (${inClause})` : "";
  const result = await poolSql.request().query(
    `SELECT UsuarioId, NombreCompleto, Email, CI, SucursalId, EstadoId, Activo
       FROM Usuarios
       ${where}
      ORDER BY NombreCompleto`
  );
  return result.recordset.map((row) => ({
    usuarioId: Number(row.UsuarioId),
    nombre: String(row.NombreCompleto || "").trim(),
    email: row.Email || null,
    ci: row.CI || null,
    sucursalId: row.SucursalId == null ? null : Number(row.SucursalId),
    estadoId: row.EstadoId || null,
    activo: Boolean(row.Activo),
  }));
}

async function getDirectorioIntegre() {
  const poolSql = await getPool();
  const result = await poolSql.request().query(
    `SELECT UsuarioId, NombreCompleto, Email, CI, SucursalId, EstadoId
       FROM Usuarios
      WHERE Activo = 1 AND (EsCliente = 0 OR EsCliente IS NULL)
      ORDER BY NombreCompleto`
  );
  return result.recordset.map((row) => ({
    usuarioId: Number(row.UsuarioId),
    nombre: String(row.NombreCompleto || "").trim(),
    email: row.Email || null,
    ci: row.CI || null,
    sucursalId: row.SucursalId == null ? null : Number(row.SucursalId),
    estadoId: row.EstadoId || null,
  }));
}

async function getCandidatos() {
  const all = await getDirectorioIntegre();
  const roster = await getRoster();
  const existing = new Set(roster.filter((r) => r.incluido).map((r) => r.usuarioId));
  return all.filter((row) => !existing.has(row.usuarioId));
}

async function getLicencias(desde, hasta, usuarioIds = null, incluirInactivas = false) {
  const inClause = buildInClause(usuarioIds);
  if (usuarioIds != null && !inClause) return [];
  const poolSql = await getPool();
  const request = poolSql
    .request()
    .input("desde", sql.Int, Number(desde))
    .input("hasta", sql.Int, Number(hasta))
    .input("incluirInactivas", sql.Bit, incluirInactivas ? 1 : 0);
  const filters = [
    "ul.MotivoLicenciaId = 'V'",
    "YEAR(ul.FechaDesde) BETWEEN @desde AND @hasta",
    "(@incluirInactivas = 1 OR ul.Activo = 1)",
  ];
  if (inClause) filters.push(`ul.UsuarioId IN (${inClause})`);
  const result = await request.query(
    `SELECT ul.UsuarioLicenciaId, ul.UsuarioId, u.NombreCompleto,
            CONVERT(varchar(10), ul.FechaDesde, 23) AS FechaDesde,
            CONVERT(varchar(10), ul.FechaHasta, 23) AS FechaHasta,
            ul.Activo, ul.Comentarios
       FROM UsuarioLicencias ul
       JOIN Usuarios u ON u.UsuarioId = ul.UsuarioId
      WHERE ${filters.join(" AND ")}
      ORDER BY ul.FechaDesde, ul.UsuarioLicenciaId`
  );
  return result.recordset.map((row) => ({
    id: Number(row.UsuarioLicenciaId),
    usuarioId: Number(row.UsuarioId),
    nombre: String(row.NombreCompleto || "").trim(),
    fechaDesde: row.FechaDesde,
    fechaHasta: row.FechaHasta,
    activo: Boolean(row.Activo),
    comentarios: row.Comentarios || null,
  }));
}

function diasDeLicencia(licencia, overrides, feriados) {
  const override = overrides.get(licencia.id);
  if (override && override.incluida === false) return 0;
  if (override && override.diasComputados != null) return core.round2(override.diasComputados);
  return core.contarDiasHabiles(licencia.fechaDesde, licencia.fechaHasta, feriados);
}

function agruparPorUsuario(items) {
  const map = new Map();
  for (const item of items) {
    if (!map.has(item.usuarioId)) map.set(item.usuarioId, []);
    map.get(item.usuarioId).push(item);
  }
  return map;
}

function agruparAjustes(ajustes) {
  const map = new Map();
  for (const ajuste of ajustes) {
    if (!map.has(ajuste.usuarioId)) map.set(ajuste.usuarioId, new Map());
    const byYear = map.get(ajuste.usuarioId);
    if (!byYear.has(ajuste.gestion)) {
      byYear.set(ajuste.gestion, { pagados: 0, ajustes: 0 });
    }
    const acc = byYear.get(ajuste.gestion);
    if (ajuste.tipo === "pago") acc.pagados += ajuste.dias;
    else acc.ajustes += ajuste.dias;
  }
  return map;
}

async function loadContext(gestion, { incluirInactivas = false, soloRoster = true } = {}) {
  const g = normalizeGestion(gestion);
  const roster = await getRoster();
  const rosterActivos = roster.filter((r) => r.incluido);
  const usuarioIds = rosterActivos.map((r) => r.usuarioId);
  const initial = await getSaldosIniciales();
  const initialByUser = new Map();
  for (const row of initial) {
    if (!initialByUser.has(row.usuarioId)) initialByUser.set(row.usuarioId, []);
    initialByUser.get(row.usuarioId).push(row);
  }
  for (const rows of initialByUser.values()) rows.sort((a, b) => a.gestion - b.gestion);

  const minInitial = initial.length ? Math.min(...initial.map((r) => r.gestion)) : g;
  const desde = Math.min(minInitial, g);
  const hasta = Math.max(minInitial, g);

  const [users, licencias, feriados, ajustes, planes, planEstado, grupos, categorias] = await Promise.all([
    getIntegreUsers(usuarioIds),
    getLicencias(desde, hasta, usuarioIds, incluirInactivas),
    getFeriadosRango(desde, hasta),
    getAjustes(desde, hasta),
    getPlanes(g),
    getPlanEstado(g),
    getGruposRaw(),
    getCategorias(),
  ]);

  const usersById = new Map(users.map((u) => [u.usuarioId, u]));
  const categoriasByNombre = new Map(categorias.map((c) => [c.nombre, c]));
  const overrides = await getOverrides();
  const licenciasPorUsuario = agruparPorUsuario(licencias);
  const ajustesPorUsuario = agruparAjustes(ajustes);
  const planesPorUsuario = agruparPorUsuario(planes);
  const feriadosDescuenta = feriados.filter((f) => f.descuenta).map((f) => f.fecha);

  return {
    gestion: g,
    minInitial,
    roster,
    rosterActivos,
    usuarioIds,
    usersById,
    initialByUser,
    licencias,
    licenciasPorUsuario,
    overrides,
    feriados,
    feriadosDescuenta,
    ajustes,
    ajustesPorUsuario,
    planes,
    planesPorUsuario,
    planEstado,
    grupos,
    categorias,
    categoriasByNombre,
    soloRoster,
  };
}

function calcularFuncionario(ctx, rosterRow) {
  const usuarioId = rosterRow.usuarioId;
  const user = ctx.usersById.get(usuarioId) || {
    usuarioId,
    nombre: `Usuario ${usuarioId}`,
    email: null,
    ci: null,
    sucursalId: null,
    estadoId: null,
    activo: true,
  };
  const fechaIngreso = rosterRow.fechaIngreso || null;
  const iniciales = ctx.initialByUser.get(usuarioId) || [];
  const initialRow = iniciales.length ? iniciales[0] : null;
  const initialRowSerie =
    initialRow && ctx.gestion >= initialRow.gestion ? initialRow : null;

  const baseGestion = initialRowSerie ? initialRowSerie.gestion : ctx.gestion;
  const startYear = Math.min(baseGestion, ctx.gestion);
  const endYear = Math.max(baseGestion, ctx.gestion);
  const years = normalizeYearList(startYear, endYear);

  const licenciasUsuario = ctx.licenciasPorUsuario.get(usuarioId) || [];
  const tomadosPorYear = new Map();
  for (const licencia of licenciasUsuario) {
    const year = Number(String(licencia.fechaDesde).slice(0, 4));
    const dias = diasDeLicencia(licencia, ctx.overrides, ctx.feriadosDescuenta);
    tomadosPorYear.set(year, core.round2((tomadosPorYear.get(year) || 0) + dias));
  }

  const ajustesUsuario = ctx.ajustesPorUsuario.get(usuarioId) || new Map();
  const registros = years.map((year) => {
    let corresponden = 0;
    if (fechaIngreso) {
      corresponden =
        initialRowSerie && year === initialRowSerie.gestion
          ? initialRowSerie.diasCorresponden
          : core.diasCorrespondenParaGestion(fechaIngreso, year);
    }
    const ajusteYear = ajustesUsuario.get(year) || { pagados: 0, ajustes: 0 };
    return {
      gestion: year,
      corresponden,
      tomados: tomadosPorYear.get(year) || 0,
      pagados: ajusteYear.pagados,
      ajustes: ajusteYear.ajustes,
    };
  });

  const pendientesIniciales = initialRowSerie ? initialRowSerie.diasPendientes : 0;
  const pagadosIniciales = initialRowSerie ? initialRowSerie.diasPagados : 0;
  const serie = core.calcularSerieSaldos({
    gestionInicial: startYear,
    pendientesIniciales,
    pagadosIniciales,
    registros,
  });
  const row = serie.find((r) => r.gestion === ctx.gestion) || serie[serie.length - 1] || {
    arrastre: 0,
    corresponden: 0,
    tomados: 0,
    pagados: 0,
    ajustes: 0,
    disponible: 0,
    saldoCierre: 0,
  };

  const planificado = core.round2(
    (ctx.planesPorUsuario.get(usuarioId) || []).reduce(
      (sum, bloque) => sum + Number(bloque.diasPlanificados || 0),
      0
    )
  );
  const tieneFecha = Boolean(fechaIngreso);
  const tieneSaldoInicial = Boolean(initialRowSerie);
  const antiguedad = fechaIngreso
    ? core.antiguedadParaGestion(fechaIngreso, ctx.gestion)
    : null;

  return {
    usuarioId,
    nombre: user.nombre,
    email: user.email,
    ci: user.ci,
    sucursalId: user.sucursalId,
    estadoId: user.estadoId,
    activo: user.activo,
    categoria: rosterRow.categoria,
    categoriaColor: ctx.categoriasByNombre.get(rosterRow.categoria)?.color || "#64748b",
    notas: rosterRow.notas,
    fechaIngreso,
    antiguedad,
    sinConfigurar: !tieneFecha || !tieneSaldoInicial,
    corresponden: core.round2(row.corresponden),
    arrastre: core.round2(row.arrastre),
    disponible: core.round2(row.disponible),
    tomado: core.round2(row.tomados),
    pagados: core.round2(row.pagados),
    ajustes: core.round2(row.ajustes),
    planificado,
    porPlanificar: core.round2(row.disponible - planificado),
    saldoCierre: core.round2(row.saldoCierre),
    estadoColor: core.colorPorSaldo(row.arrastre, tieneFecha, tieneSaldoInicial),
    saldoInicial: initialRow
      ? {
          gestion: initialRow.gestion,
          diasCorresponden: initialRow.diasCorresponden,
          diasPendientes: initialRow.diasPendientes,
          diasPagados: initialRow.diasPagados,
          notas: initialRow.notas,
        }
      : null,
  };
}

async function getFuncionarios(gestion) {
  const ctx = await loadContext(gestion);
  const funcionarios = ctx.rosterActivos.map((row) => calcularFuncionario(ctx, row));
  funcionarios.sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));
  return funcionarios;
}

function bloquesConColor(funcionarios, planes) {
  const byUser = new Map(funcionarios.map((f) => [f.usuarioId, f]));
  return planes.map((bloque) => {
    const f = byUser.get(bloque.usuarioId);
    return {
      ...bloque,
      nombre: f?.nombre || `Usuario ${bloque.usuarioId}`,
      estadoColor: f?.estadoColor || "gris",
      categoriaColor: f?.categoriaColor || "#64748b",
      conflicto: false,
      celdas: [],
    };
  });
}

async function getCronograma(gestion) {
  const ctx = await loadContext(gestion);
  const funcionarios = ctx.rosterActivos.map((row) => calcularFuncionario(ctx, row));
  funcionarios.sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));
  const bloques = core.asignarCeldas(
    funcionarios,
    bloquesConColor(funcionarios, ctx.planes)
  );
  const licenciasGestion = ctx.licencias.filter(
    (l) => Number(String(l.fechaDesde).slice(0, 4)) === ctx.gestion
  );
  const conflictos = core.detectarConflictos({
    bloques,
    licencias: licenciasGestion,
    grupos: ctx.grupos,
    feriados: ctx.feriadosDescuenta,
  });
  core.marcarBloquesEnConflicto(bloques, conflictos, ctx.feriadosDescuenta);
  return {
    gestion: ctx.gestion,
    estado: ctx.planEstado,
    funcionarios,
    bloques,
    conflictos,
    categorias: ctx.categorias,
    feriados: ctx.feriados.filter((f) => Number(String(f.fecha).slice(0, 4)) === ctx.gestion),
  };
}

async function getConflictos(gestion) {
  const ctx = await loadContext(gestion);
  const funcionarios = ctx.rosterActivos.map((row) => calcularFuncionario(ctx, row));
  const bloques = bloquesConColor(funcionarios, ctx.planes);
  const licenciasGestion = ctx.licencias.filter(
    (l) => Number(String(l.fechaDesde).slice(0, 4)) === ctx.gestion
  );
  const conflictos = core.detectarConflictos({
    bloques,
    licencias: licenciasGestion,
    grupos: ctx.grupos,
    feriados: ctx.feriadosDescuenta,
  });
  const grupos = await getGrupos();
  return { gestion: ctx.gestion, grupos, conflictos };
}

async function getDiasTomados(gestion, { incluirInactivas = false } = {}) {
  const g = normalizeGestion(gestion);
  const licencias = await getLicencias(g, g, null, incluirInactivas);
  const overrides = await getOverrides();
  const feriados = await getFeriados(g);
  const feriadosDescuenta = feriados.filter((f) => f.descuenta).map((f) => f.fecha);
  const rows = licencias.map((licencia) => {
    const override = overrides.get(licencia.id) || null;
    const diasCalculados = core.contarDiasHabiles(
      licencia.fechaDesde,
      licencia.fechaHasta,
      feriadosDescuenta
    );
    let diasComputados = diasCalculados;
    if (override && override.incluida === false) diasComputados = 0;
    else if (override && override.diasComputados != null) diasComputados = override.diasComputados;
    return {
      ...licencia,
      diasCalculados,
      diasComputados: core.round2(diasComputados),
      override: override
        ? {
            diasComputados: override.diasComputados,
            incluida: override.incluida,
            notas: override.notas,
          }
        : null,
    };
  });
  rows.sort((a, b) => a.nombre.localeCompare(b.nombre, "es") || a.fechaDesde.localeCompare(b.fechaDesde));
  return {
    gestion: g,
    licencias: rows,
    total: core.round2(rows.reduce((sum, row) => sum + row.diasComputados, 0)),
    feriados,
  };
}

async function upsertFuncionario(usuarioId, body, userId) {
  const id = asInt(usuarioId, "usuarioId");
  const payload = body || {};
  const has = (key) => Object.prototype.hasOwnProperty.call(payload, key);
  const hasFechaIngreso = has("fecha_ingreso") || has("fechaIngreso");
  const hasIncluido = has("incluido");
  const hasCategoria = has("categoria");
  const hasNotas = has("notas");

  const fechaIngreso = hasFechaIngreso
    ? asDateOrNull(payload.fecha_ingreso ?? payload.fechaIngreso, "fecha de ingreso")
    : null;
  const incluido = hasIncluido ? asBool(payload.incluido, true) : null;
  const categoriaRaw =
    hasCategoria && payload.categoria != null ? String(payload.categoria).trim() : null;
  const categoria = categoriaRaw || null;
  if (hasCategoria && categoria) {
    const cat = await pool.query(
      "SELECT 1 FROM core.vac_categorias WHERE nombre = $1",
      [categoria]
    );
    if (cat.rows.length === 0) {
      throw new VacacionesError("Categoría inválida", 400);
    }
  }
  const notas = hasNotas ? (payload.notas == null ? null : String(payload.notas)) : null;

  const result = await pool.query(
    `INSERT INTO core.vac_funcionarios
       (usuario_id, incluido, fecha_ingreso, categoria, notas, updated_by, updated_at)
     VALUES ($1, COALESCE($2, TRUE), $3, $4, $5, $6, NOW())
     ON CONFLICT (usuario_id) DO UPDATE SET
       incluido = CASE WHEN $7 THEN EXCLUDED.incluido ELSE core.vac_funcionarios.incluido END,
       fecha_ingreso = CASE WHEN $8 THEN EXCLUDED.fecha_ingreso ELSE core.vac_funcionarios.fecha_ingreso END,
       categoria = CASE WHEN $9 THEN EXCLUDED.categoria ELSE core.vac_funcionarios.categoria END,
       notas = CASE WHEN $10 THEN EXCLUDED.notas ELSE core.vac_funcionarios.notas END,
       updated_by = EXCLUDED.updated_by,
       updated_at = NOW()
     RETURNING usuario_id, incluido, TO_CHAR(fecha_ingreso, 'YYYY-MM-DD') AS fecha_ingreso,
               categoria, notas`,
    [
      id,
      incluido,
      fechaIngreso,
      categoria,
      notas,
      userId || null,
      hasIncluido,
      hasFechaIngreso,
      hasCategoria,
      hasNotas,
    ]
  );
  const row = result.rows[0];
  return {
    usuarioId: Number(row.usuario_id),
    incluido: Boolean(row.incluido),
    fechaIngreso: row.fecha_ingreso || null,
    categoria: row.categoria || null,
    notas: row.notas || null,
  };
}

async function saveSaldosIniciales(items, userId) {
  const list = Array.isArray(items) ? items : [items];
  if (list.length === 0) throw new VacacionesError("No se recibieron saldos iniciales");
  const saved = [];
  for (const item of list) {
    const usuarioId = asInt(item.usuarioId ?? item.usuario_id, "usuarioId");
    const gestion = normalizeGestion(item.gestion);
    const diasCorresponden = asNumber(
      item.diasCorresponden ?? item.dias_corresponden,
      "dias que corresponden",
      { min: 0 }
    );
    const diasPendientes = asNumber(
      item.diasPendientes ?? item.dias_pendientes ?? 0,
      "dias pendientes",
      { min: 0 }
    );
    const diasPagados = asNumber(
      item.diasPagados ?? item.dias_pagados ?? 0,
      "dias pagados",
      { min: 0 }
    );
    const notas = item.notas == null ? null : String(item.notas);
    const result = await pool.query(
      `INSERT INTO core.vac_saldos_iniciales
         (usuario_id, gestion, dias_corresponden, dias_pendientes, dias_pagados, notas, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       ON CONFLICT (usuario_id, gestion) DO UPDATE SET
         dias_corresponden = EXCLUDED.dias_corresponden,
         dias_pendientes = EXCLUDED.dias_pendientes,
         dias_pagados = EXCLUDED.dias_pagados,
         notas = EXCLUDED.notas,
         updated_by = EXCLUDED.updated_by,
         updated_at = NOW()
       RETURNING usuario_id, gestion, dias_corresponden, dias_pendientes, dias_pagados, notas`,
      [usuarioId, gestion, diasCorresponden, diasPendientes, diasPagados, notas, userId || null]
    );
    const row = result.rows[0];
    saved.push({
      usuarioId: Number(row.usuario_id),
      gestion: Number(row.gestion),
      diasCorresponden: Number(row.dias_corresponden),
      diasPendientes: Number(row.dias_pendientes),
      diasPagados: Number(row.dias_pagados),
      notas: row.notas || null,
    });
  }
  return { guardados: saved.length, items: saved };
}

async function crearAjuste(body, userId) {
  const usuarioId = asInt(body.usuarioId ?? body.usuario_id, "usuarioId");
  const gestion = normalizeGestion(body.gestion);
  const dias = asNumber(body.dias, "dias");
  const tipo = String(body.tipo || "");
  if (!["arrastre", "pago", "correccion", "compensacion"].includes(tipo)) {
    throw new VacacionesError("Tipo de ajuste invalido");
  }
  const motivo = body.motivo == null ? null : String(body.motivo);
  const result = await pool.query(
    `INSERT INTO core.vac_ajustes (usuario_id, gestion, dias, tipo, motivo, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, usuario_id, gestion, dias, tipo, motivo, created_at`,
    [usuarioId, gestion, dias, tipo, motivo, userId || null]
  );
  const row = result.rows[0];
  return {
    id: Number(row.id),
    usuarioId: Number(row.usuario_id),
    gestion: Number(row.gestion),
    dias: Number(row.dias),
    tipo: row.tipo,
    motivo: row.motivo || null,
    createdAt: row.created_at,
  };
}

async function editarAjuste(id, body) {
  const ajusteId = asInt(id, "id");
  const dias = body.dias == null ? null : asNumber(body.dias, "dias");
  const tipo = body.tipo == null ? null : String(body.tipo);
  if (tipo && !["arrastre", "pago", "correccion", "compensacion"].includes(tipo)) {
    throw new VacacionesError("Tipo de ajuste invalido");
  }
  const motivo = body.motivo == null ? null : String(body.motivo);
  const result = await pool.query(
    `UPDATE core.vac_ajustes
        SET dias = COALESCE($1, dias),
            tipo = COALESCE($2, tipo),
            motivo = CASE WHEN $3::text IS NULL THEN motivo ELSE $3 END
      WHERE id = $4
      RETURNING id, usuario_id, gestion, dias, tipo, motivo, created_at`,
    [dias, tipo, motivo, ajusteId]
  );
  if (result.rows.length === 0) throw new VacacionesError("Ajuste no encontrado", 404);
  const row = result.rows[0];
  return {
    id: Number(row.id),
    usuarioId: Number(row.usuario_id),
    gestion: Number(row.gestion),
    dias: Number(row.dias),
    tipo: row.tipo,
    motivo: row.motivo || null,
    createdAt: row.created_at,
  };
}

async function listAjustes(usuarioId, gestion) {
  const params = [];
  const where = [];
  if (usuarioId) {
    params.push(asInt(usuarioId, "usuarioId"));
    where.push(`usuario_id = $${params.length}`);
  }
  if (gestion) {
    params.push(normalizeGestion(gestion));
    where.push(`gestion = $${params.length}`);
  }
  const result = await pool.query(
    `SELECT id, usuario_id, gestion, dias, tipo, motivo, created_at
       FROM core.vac_ajustes
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY gestion DESC, id DESC`,
    params
  );
  return result.rows.map((row) => ({
    id: Number(row.id),
    usuarioId: Number(row.usuario_id),
    gestion: Number(row.gestion),
    dias: Number(row.dias),
    tipo: row.tipo,
    motivo: row.motivo || null,
    createdAt: row.created_at,
  }));
}

async function eliminarAjuste(id) {
  const result = await pool.query("DELETE FROM core.vac_ajustes WHERE id = $1", [asInt(id, "id")]);
  if (result.rowCount === 0) throw new VacacionesError("Ajuste no encontrado", 404);
  return { ok: true };
}

async function getBloque(id) {
  const result = await pool.query(
    `SELECT id, usuario_id, gestion,
            TO_CHAR(fecha_desde, 'YYYY-MM-DD') AS fecha_desde,
            TO_CHAR(fecha_hasta, 'YYYY-MM-DD') AS fecha_hasta,
            dias_planificados, origen, notas
       FROM core.vac_planes WHERE id = $1`,
    [asInt(id, "id")]
  );
  if (result.rows.length === 0) throw new VacacionesError("Bloque no encontrado", 404);
  return {
    id: Number(result.rows[0].id),
    usuarioId: Number(result.rows[0].usuario_id),
    gestion: Number(result.rows[0].gestion),
    fechaDesde: result.rows[0].fecha_desde,
    fechaHasta: result.rows[0].fecha_hasta,
    diasPlanificados: Number(result.rows[0].dias_planificados),
    origen: result.rows[0].origen,
    notas: result.rows[0].notas || null,
  };
}

async function validarSolapamiento(usuarioId, gestion, fechaDesde, fechaHasta, excluirId = null) {
  const feriados = await getFeriados(gestion);
  const feriadosDescuenta = feriados.filter((f) => f.descuenta).map((f) => f.fecha);
  const result = await pool.query(
    `SELECT id, TO_CHAR(fecha_desde, 'YYYY-MM-DD') AS fecha_desde,
            TO_CHAR(fecha_hasta, 'YYYY-MM-DD') AS fecha_hasta
       FROM core.vac_planes
      WHERE usuario_id = $1 AND gestion = $2 ${excluirId ? "AND id <> $3" : ""}`,
    excluirId ? [usuarioId, gestion, excluirId] : [usuarioId, gestion]
  );
  for (const row of result.rows) {
    const overlap = core.solapamientoDiasHabiles(
      { fechaDesde, fechaHasta },
      { fechaDesde: row.fecha_desde, fechaHasta: row.fecha_hasta },
      feriadosDescuenta
    );
    if (overlap) {
      throw new VacacionesError(
        `El bloque se superpone con otro del mismo funcionario (${overlap.desde} a ${overlap.hasta})`,
        409
      );
    }
  }
}

async function crearBloque(body, userId) {
  const usuarioId = asInt(body.usuarioId ?? body.usuario_id, "usuarioId");
  const gestion = normalizeGestion(body.gestion);
  await assertPlanUnlocked(gestion);
  const fechaDesde = asDateOrNull(body.fechaDesde ?? body.fecha_desde, "fecha desde");
  const fechaHasta = asDateOrNull(body.fechaHasta ?? body.fecha_hasta, "fecha hasta");
  if (!fechaDesde || !fechaHasta) throw new VacacionesError("Las fechas son obligatorias");
  if (fechaHasta < fechaDesde) throw new VacacionesError("La fecha hasta no puede ser anterior a la fecha desde");
  const feriados = await getFeriados(gestion);
  const feriadosDescuenta = feriados.filter((f) => f.descuenta).map((f) => f.fecha);
  const dias = body.diasPlanificados == null
    ? core.contarDiasHabiles(fechaDesde, fechaHasta, feriadosDescuenta)
    : asNumber(body.diasPlanificados, "dias planificados", { min: 0 });
  await validarSolapamiento(usuarioId, gestion, fechaDesde, fechaHasta);
  const notas = body.notas == null ? null : String(body.notas);
  const result = await pool.query(
    `INSERT INTO core.vac_planes
       (usuario_id, gestion, fecha_desde, fecha_hasta, dias_planificados, origen, notas, created_by, updated_at)
     VALUES ($1, $2, $3, $4, $5, 'manual', $6, $7, NOW())
     RETURNING id`,
    [usuarioId, gestion, fechaDesde, fechaHasta, dias, notas, userId || null]
  );
  return getBloque(result.rows[0].id);
}

async function editarBloque(id, body, userId) {
  const existing = await getBloque(id);
  await assertPlanUnlocked(existing.gestion);
  const fechaDesde = body.fechaDesde != null || body.fecha_desde != null
    ? asDateOrNull(body.fechaDesde ?? body.fecha_desde, "fecha desde")
    : existing.fechaDesde;
  const fechaHasta = body.fechaHasta != null || body.fecha_hasta != null
    ? asDateOrNull(body.fechaHasta ?? body.fecha_hasta, "fecha hasta")
    : existing.fechaHasta;
  if (!fechaDesde || !fechaHasta) throw new VacacionesError("Las fechas son obligatorias");
  if (fechaHasta < fechaDesde) throw new VacacionesError("La fecha hasta no puede ser anterior a la fecha desde");
  const feriados = await getFeriados(existing.gestion);
  const feriadosDescuenta = feriados.filter((f) => f.descuenta).map((f) => f.fecha);
  const dias = body.diasPlanificados == null
    ? core.contarDiasHabiles(fechaDesde, fechaHasta, feriadosDescuenta)
    : asNumber(body.diasPlanificados, "dias planificados", { min: 0 });
  await validarSolapamiento(existing.usuarioId, existing.gestion, fechaDesde, fechaHasta, existing.id);
  const notas = body.notas == null ? existing.notas : String(body.notas);
  await pool.query(
    `UPDATE core.vac_planes
        SET fecha_desde = $1, fecha_hasta = $2, dias_planificados = $3, notas = $4, updated_at = NOW()
      WHERE id = $5`,
    [fechaDesde, fechaHasta, dias, notas, existing.id]
  );
  return getBloque(existing.id);
}

async function eliminarBloque(id) {
  const existing = await getBloque(id);
  await assertPlanUnlocked(existing.gestion);
  await pool.query("DELETE FROM core.vac_planes WHERE id = $1", [existing.id]);
  return { ok: true, id: existing.id };
}

async function generarCronograma(gestion, userId, confirmar = false) {
  const g = normalizeGestion(gestion);
  await assertPlanUnlocked(g);
  const existentes = await pool.query("SELECT COUNT(*)::int AS n FROM core.vac_planes WHERE gestion = $1", [g]);
  const totalExistentes = Number(existentes.rows[0].n);
  if (totalExistentes > 0 && !asBool(confirmar, false)) {
    throw new VacacionesError(
      `Ya existen ${totalExistentes} bloques para ${g}. Reenvía con confirmar=true para reemplazarlos.`,
      409
    );
  }

  const ctx = await loadContext(g);
  const funcionarios = ctx.rosterActivos
    .map((row) => calcularFuncionario(ctx, row))
    .filter((f) => f.fechaIngreso && f.disponible > 0)
    .map((f, index) => ({
      usuarioId: f.usuarioId,
      nombre: f.nombre,
      fechaIngreso: f.fechaIngreso,
      disponible: f.disponible,
      orden: index,
    }));

  const anteriores = await getPlanes(g - 1);
  const planesAnteriores = {};
  for (const bloque of anteriores) {
    if (!planesAnteriores[bloque.usuarioId]) planesAnteriores[bloque.usuarioId] = [];
    planesAnteriores[bloque.usuarioId].push({
      fechaDesde: bloque.fechaDesde,
      fechaHasta: bloque.fechaHasta,
    });
  }

  const propuesta = core.generarPropuesta({
    gestion: g,
    funcionarios,
    feriados: ctx.feriadosDescuenta,
    planesAnteriores,
    grupos: ctx.grupos,
  });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM core.vac_planes WHERE gestion = $1", [g]);
    for (const bloque of propuesta.bloques) {
      await client.query(
        `INSERT INTO core.vac_planes
           (usuario_id, gestion, fecha_desde, fecha_hasta, dias_planificados, origen, notas, created_by, updated_at)
         VALUES ($1, $2, $3, $4, $5, 'auto', NULL, $6, NOW())`,
        [bloque.usuarioId, g, bloque.fechaDesde, bloque.fechaHasta, bloque.diasPlanificados, userId || null]
      );
    }
    await client.query(
      `INSERT INTO core.vac_plan_estado (gestion, estado, updated_at)
       VALUES ($1, 'borrador', NOW())
       ON CONFLICT (gestion) DO UPDATE SET estado = 'borrador', bloqueado_por = NULL, bloqueado_at = NULL, updated_at = NOW()`,
      [g]
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  return {
    gestion: g,
    generados: propuesta.bloques.length,
    reemplazados: totalExistentes,
    conflictos: propuesta.conflictos,
  };
}

async function bloquearPlan(gestion, userId) {
  const g = normalizeGestion(gestion);
  const result = await pool.query(
    `INSERT INTO core.vac_plan_estado (gestion, estado, bloqueado_por, bloqueado_at, updated_at)
     VALUES ($1, 'bloqueado', $2, NOW(), NOW())
     ON CONFLICT (gestion) DO UPDATE SET
       estado = 'bloqueado', bloqueado_por = EXCLUDED.bloqueado_por,
       bloqueado_at = NOW(), updated_at = NOW()
     RETURNING gestion, estado, bloqueado_por,
               TO_CHAR(bloqueado_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS bloqueado_at`,
    [g, userId || null]
  );
  const row = result.rows[0];
  return {
    gestion: Number(row.gestion),
    estado: row.estado,
    bloqueadoPor: row.bloqueado_por ? Number(row.bloqueado_por) : null,
    bloqueadoAt: row.bloqueado_at || null,
  };
}

async function desbloquearPlan(gestion, userId) {
  const g = normalizeGestion(gestion);
  const result = await pool.query(
    `INSERT INTO core.vac_plan_estado (gestion, estado, bloqueado_por, bloqueado_at, updated_at)
     VALUES ($1, 'borrador', NULL, NULL, NOW())
     ON CONFLICT (gestion) DO UPDATE SET
       estado = 'borrador', bloqueado_por = NULL, bloqueado_at = NULL, updated_at = NOW()
     RETURNING gestion, estado`,
    [g]
  );
  return { gestion: Number(result.rows[0].gestion), estado: result.rows[0].estado, updatedBy: userId || null };
}

function mapCategoriaRow(row) {
  return {
    id: Number(row.id),
    nombre: row.nombre,
    color: row.color,
    activo: Boolean(row.activo),
  };
}

async function getCategorias() {
  const result = await pool.query(
    `SELECT id, nombre, color, activo
       FROM core.vac_categorias
      ORDER BY nombre`
  );
  return result.rows.map(mapCategoriaRow);
}

function validarColor(color) {
  const value = String(color || "").trim();
  if (!/^#[0-9a-fA-F]{6}$/.test(value)) {
    throw new VacacionesError("Color inválido: usá el formato #RRGGBB");
  }
  return value;
}

async function crearCategoria(body) {
  const nombre = String(body.nombre || "").trim();
  if (!nombre) throw new VacacionesError("El nombre de la categoría es obligatorio");
  const color = validarColor(body.color || "#64748b");
  const activo = asBool(body.activo, true);
  try {
    const result = await pool.query(
      `INSERT INTO core.vac_categorias (nombre, color, activo)
       VALUES ($1, $2, $3)
       RETURNING id, nombre, color, activo`,
      [nombre, color, activo]
    );
    return mapCategoriaRow(result.rows[0]);
  } catch (err) {
    if (err.code === "23505") {
      throw new VacacionesError("Ya existe una categoría con ese nombre", 409);
    }
    throw err;
  }
}

async function editarCategoria(id, body) {
  const categoriaId = asInt(id, "id");
  const nombre = body.nombre == null ? null : String(body.nombre).trim();
  if (nombre === "") throw new VacacionesError("El nombre de la categoría es obligatorio");
  const color = body.color == null ? null : validarColor(body.color);
  const activo = body.activo == null ? null : asBool(body.activo, true);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const current = await client.query(
      "SELECT id, nombre FROM core.vac_categorias WHERE id = $1",
      [categoriaId]
    );
    if (current.rows.length === 0) throw new VacacionesError("Categoría no encontrada", 404);
    const oldName = current.rows[0].nombre;
    const result = await client.query(
      `UPDATE core.vac_categorias
          SET nombre = COALESCE($1, nombre),
              color = COALESCE($2, color),
              activo = COALESCE($3, activo),
              updated_at = NOW()
        WHERE id = $4
        RETURNING id, nombre, color, activo`,
      [nombre, color, activo, categoriaId]
    );
    if (nombre && nombre !== oldName) {
      await client.query(
        "UPDATE core.vac_funcionarios SET categoria = $1 WHERE categoria = $2",
        [nombre, oldName]
      );
    }
    await client.query("COMMIT");
    return mapCategoriaRow(result.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    if (err.code === "23505") {
      throw new VacacionesError("Ya existe una categoría con ese nombre", 409);
    }
    throw err;
  } finally {
    client.release();
  }
}

async function eliminarCategoria(id) {
  const categoriaId = asInt(id, "id");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const current = await client.query(
      "SELECT nombre FROM core.vac_categorias WHERE id = $1",
      [categoriaId]
    );
    if (current.rows.length === 0) throw new VacacionesError("Categoría no encontrada", 404);
    await client.query(
      "UPDATE core.vac_funcionarios SET categoria = NULL WHERE categoria = $1",
      [current.rows[0].nombre]
    );
    await client.query("DELETE FROM core.vac_categorias WHERE id = $1", [categoriaId]);
    await client.query("COMMIT");
    return { ok: true };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function recalcularCorresponden(usuarioId, gestion, userId) {
  const id = asInt(usuarioId, "usuarioId");
  const g = normalizeGestion(gestion);
  const rostro = await pool.query(
    `SELECT usuario_id, TO_CHAR(fecha_ingreso, 'YYYY-MM-DD') AS fecha_ingreso
       FROM core.vac_funcionarios
      WHERE usuario_id = $1`,
    [id]
  );
  if (rostro.rows.length === 0) {
    throw new VacacionesError("Funcionario no encontrado en el roster", 404);
  }
  const fechaIngreso = rostro.rows[0].fecha_ingreso;
  if (!fechaIngreso) {
    throw new VacacionesError("El funcionario no tiene fecha de ingreso configurada", 400);
  }
  const inicial = await pool.query(
    "SELECT gestion FROM core.vac_saldos_iniciales WHERE usuario_id = $1 ORDER BY gestion LIMIT 1",
    [id]
  );
  const targetGestion = inicial.rows.length > 0 ? Number(inicial.rows[0].gestion) : g;
  const dias = core.diasCorrespondenParaGestion(fechaIngreso, targetGestion);
  const antiguedad = core.antiguedadParaGestion(fechaIngreso, targetGestion);
  const result = await pool.query(
    `INSERT INTO core.vac_saldos_iniciales
       (usuario_id, gestion, dias_corresponden, dias_pendientes, dias_pagados, updated_by, updated_at)
     VALUES ($1, $2, $3, 0, 0, $4, NOW())
     ON CONFLICT (usuario_id, gestion) DO UPDATE SET
       dias_corresponden = EXCLUDED.dias_corresponden,
       updated_by = EXCLUDED.updated_by,
       updated_at = NOW()
     RETURNING usuario_id, gestion, dias_corresponden, dias_pendientes, dias_pagados`,
    [id, targetGestion, dias, userId || null]
  );
  const row = result.rows[0];
  return {
    usuarioId: Number(row.usuario_id),
    gestion: Number(row.gestion),
    diasCorresponden: Number(row.dias_corresponden),
    antiguedad,
  };
}

async function recalcularTodos(gestion, userId) {
  const g = normalizeGestion(gestion);
  const roster = (await getRoster()).filter((r) => r.incluido);
  const iniciales = await getSaldosIniciales();
  const initialByUser = new Map();
  for (const row of iniciales) {
    if (!initialByUser.has(row.usuarioId)) initialByUser.set(row.usuarioId, []);
    initialByUser.get(row.usuarioId).push(row);
  }
  for (const rows of initialByUser.values()) {
    rows.sort((a, b) => a.gestion - b.gestion);
  }

  let actualizados = 0;
  const sinFecha = [];
  const gestiones = new Set();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const row of roster) {
      if (!row.fechaIngreso) {
        sinFecha.push(row.usuarioId);
        continue;
      }
      const targetGestion = initialByUser.get(row.usuarioId)?.[0]?.gestion ?? g;
      const dias = core.diasCorrespondenParaGestion(row.fechaIngreso, targetGestion);
      await client.query(
        `INSERT INTO core.vac_saldos_iniciales
           (usuario_id, gestion, dias_corresponden, dias_pendientes, dias_pagados, updated_by, updated_at)
         VALUES ($1, $2, $3, 0, 0, $4, NOW())
         ON CONFLICT (usuario_id, gestion) DO UPDATE SET
           dias_corresponden = EXCLUDED.dias_corresponden,
           updated_by = EXCLUDED.updated_by,
           updated_at = NOW()`,
        [row.usuarioId, targetGestion, dias, userId || null]
      );
      actualizados++;
      gestiones.add(targetGestion);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  return {
    actualizados,
    sinFecha,
    gestiones: Array.from(gestiones).sort((a, b) => a - b),
  };
}

async function crearDiaTomado(body, userId, userEmail) {
  const usuarioId = asInt(body.usuarioId ?? body.usuario_id, "usuarioId");
  const fechaDesde = asDateOrNull(body.fechaDesde ?? body.fecha_desde, "fecha desde");
  const fechaHasta = asDateOrNull(body.fechaHasta ?? body.fecha_hasta, "fecha hasta");
  if (!fechaDesde || !fechaHasta) {
    throw new VacacionesError("Las fechas desde y hasta son obligatorias");
  }
  if (fechaHasta < fechaDesde) {
    throw new VacacionesError("La fecha hasta no puede ser anterior a la fecha desde");
  }
  const comentario = body.comentarios == null ? "" : String(body.comentarios).trim();
  if (comentario.length > 300) {
    throw new VacacionesError("El comentario no puede superar los 300 caracteres");
  }

  const directorio = await getDirectorioIntegre();
  const funcionario = directorio.find((u) => u.usuarioId === usuarioId);
  if (!funcionario) {
    throw new VacacionesError("El funcionario no está activo o no es funcionario en Integgre", 400);
  }

  const poolSql = await getPool();
  const overlap = await poolSql
    .request()
    .input("usuarioId", sql.Int, usuarioId)
    .input("desde", sql.VarChar(10), fechaDesde)
    .input("hasta", sql.VarChar(10), fechaHasta)
    .query(`
      SELECT TOP 1
        UsuarioLicenciaId,
        CONVERT(varchar(10), FechaDesde, 23) AS FechaDesde,
        CONVERT(varchar(10), FechaHasta, 23) AS FechaHasta
      FROM dbo.UsuarioLicencias
      WHERE UsuarioId = @usuarioId
        AND MotivoLicenciaId = 'V'
        AND Activo = 1
        AND FechaDesde <= CONVERT(date, @hasta, 23)
        AND FechaHasta >= CONVERT(date, @desde, 23)
    `);
  if (overlap.recordset.length > 0) {
    const existente = overlap.recordset[0];
    throw new VacacionesError(
      `Ya existe una licencia de vacaciones activa del ${existente.FechaDesde} al ${existente.FechaHasta}`,
      409
    );
  }

  const audit = [
    comentario.slice(0, 230),
    `Creado desde Hermes${userEmail ? ` por ${userEmail}` : ""}`,
  ]
    .filter(Boolean)
    .join(" · ")
    .slice(0, 300);

  const inserted = await poolSql
    .request()
    .input("usuarioId", sql.Int, usuarioId)
    .input("desde", sql.VarChar(10), fechaDesde)
    .input("hasta", sql.VarChar(10), fechaHasta)
    .input("comentarios", sql.VarChar(300), audit)
    .query(`
      INSERT INTO dbo.UsuarioLicencias
        (UsuarioId, FechaDesde, FechaHasta, MotivoLicenciaId, Comentarios, Activo)
      VALUES
        (@usuarioId, CONVERT(date, @desde, 23), CONVERT(date, @hasta, 23), 'V', @comentarios, 1);

      SELECT CAST(SCOPE_IDENTITY() AS int) AS UsuarioLicenciaId;
    `);
  const id = Number(inserted.recordset[0].UsuarioLicenciaId);

  const gestion = Number(fechaDesde.slice(0, 4));
  const feriados = await getFeriados(gestion);
  const feriadosDescuenta = feriados.filter((f) => f.descuenta).map((f) => f.fecha);
  const dias = core.contarDiasHabiles(fechaDesde, fechaHasta, feriadosDescuenta);

  return {
    id,
    usuarioId,
    nombre: funcionario.nombre,
    fechaDesde,
    fechaHasta,
    diasCalculados: dias,
    diasComputados: dias,
    activo: true,
    comentarios: audit,
    override: null,
  };
}

async function crearFeriado(body) {
  const fecha = asDateOrNull(body.fecha, "fecha");
  if (!fecha) throw new VacacionesError("La fecha es obligatoria");
  const descripcion = body.descripcion == null ? null : String(body.descripcion);
  const ambito = String(body.ambito || "nacional");
  if (!["nacional", "departamental"].includes(ambito)) throw new VacacionesError("Ambito invalido");
  const descuenta = asBool(body.descuenta, true);
  try {
    const result = await pool.query(
      `INSERT INTO core.vac_feriados (fecha, descripcion, ambito, descuenta)
       VALUES ($1, $2, $3, $4)
       RETURNING id, TO_CHAR(fecha, 'YYYY-MM-DD') AS fecha, descripcion, ambito, descuenta`,
      [fecha, descripcion, ambito, descuenta]
    );
    const row = result.rows[0];
    return {
      id: Number(row.id),
      fecha: row.fecha,
      descripcion: row.descripcion || "",
      ambito: row.ambito,
      descuenta: Boolean(row.descuenta),
    };
  } catch (err) {
    if (err.code === "23505") throw new VacacionesError("Ya existe un feriado en esa fecha", 409);
    throw err;
  }
}

async function editarFeriado(id, body) {
  const fecha = body.fecha != null ? asDateOrNull(body.fecha, "fecha") : null;
  const descripcion = body.descripcion == null ? null : String(body.descripcion);
  const ambito = body.ambito == null ? null : String(body.ambito);
  if (ambito && !["nacional", "departamental"].includes(ambito)) throw new VacacionesError("Ambito invalido");
  const descuenta = body.descuenta == null ? null : asBool(body.descuenta, true);
  try {
    const result = await pool.query(
      `UPDATE core.vac_feriados
          SET fecha = COALESCE($1, fecha),
              descripcion = COALESCE($2, descripcion),
              ambito = COALESCE($3, ambito),
              descuenta = COALESCE($4, descuenta)
        WHERE id = $5
        RETURNING id, TO_CHAR(fecha, 'YYYY-MM-DD') AS fecha, descripcion, ambito, descuenta`,
      [fecha, descripcion, ambito, descuenta, asInt(id, "id")]
    );
    if (result.rows.length === 0) throw new VacacionesError("Feriado no encontrado", 404);
    const row = result.rows[0];
    return {
      id: Number(row.id),
      fecha: row.fecha,
      descripcion: row.descripcion || "",
      ambito: row.ambito,
      descuenta: Boolean(row.descuenta),
    };
  } catch (err) {
    if (err.code === "23505") throw new VacacionesError("Ya existe un feriado en esa fecha", 409);
    throw err;
  }
}

async function eliminarFeriado(id) {
  const result = await pool.query("DELETE FROM core.vac_feriados WHERE id = $1", [asInt(id, "id")]);
  if (result.rowCount === 0) throw new VacacionesError("Feriado no encontrado", 404);
  return { ok: true };
}

async function crearGrupo(body) {
  const nombre = String(body.nombre || "").trim();
  if (!nombre) throw new VacacionesError("El nombre del grupo es obligatorio");
  const cliente = body.cliente == null ? null : String(body.cliente);
  const notas = body.notas == null ? null : String(body.notas);
  const miembros = Array.from(
    new Set((Array.isArray(body.miembros) ? body.miembros : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))
  );
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `INSERT INTO core.vac_grupos (nombre, cliente, notas)
       VALUES ($1, $2, $3) RETURNING id`,
      [nombre, cliente, notas]
    );
    const groupId = result.rows[0].id;
    for (const usuarioId of miembros) {
      await client.query(
        "INSERT INTO core.vac_grupo_miembros (grupo_id, usuario_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        [groupId, usuarioId]
      );
    }
    await client.query("COMMIT");
    const grupos = await getGrupos();
    return grupos.find((g) => g.id === Number(groupId));
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function editarGrupo(id, body) {
  const groupId = asInt(id, "id");
  const nombre = body.nombre == null ? null : String(body.nombre).trim();
  if (nombre === "") throw new VacacionesError("El nombre del grupo es obligatorio");
  const cliente = body.cliente == null ? null : String(body.cliente);
  const notas = body.notas == null ? null : String(body.notas);
  const miembros = Array.isArray(body.miembros)
    ? Array.from(new Set(body.miembros.map(Number).filter((n) => Number.isInteger(n) && n > 0)))
    : null;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `UPDATE core.vac_grupos
          SET nombre = COALESCE($1, nombre),
              cliente = CASE WHEN $2::text IS NULL THEN cliente ELSE $2 END,
              notas = CASE WHEN $3::text IS NULL THEN notas ELSE $3 END,
              updated_at = NOW()
        WHERE id = $4
        RETURNING id`,
      [nombre, cliente, notas, groupId]
    );
    if (result.rows.length === 0) throw new VacacionesError("Grupo no encontrado", 404);
    if (miembros) {
      await client.query("DELETE FROM core.vac_grupo_miembros WHERE grupo_id = $1", [groupId]);
      for (const usuarioId of miembros) {
        await client.query(
          "INSERT INTO core.vac_grupo_miembros (grupo_id, usuario_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
          [groupId, usuarioId]
        );
      }
    }
    await client.query("COMMIT");
    const grupos = await getGrupos();
    return grupos.find((g) => g.id === groupId);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function eliminarGrupo(id) {
  const result = await pool.query("DELETE FROM core.vac_grupos WHERE id = $1", [asInt(id, "id")]);
  if (result.rowCount === 0) throw new VacacionesError("Grupo no encontrado", 404);
  return { ok: true };
}

async function actualizarLicencia(id, body, userId) {
  const licenciaId = asInt(id, "id");
  const diasComputados = body.diasComputados == null && body.dias_computados == null
    ? null
    : asNumber(body.diasComputados ?? body.dias_computados, "dias computados", { min: 0 });
  const incluida = asBool(body.incluida, true);
  const notas = body.notas == null ? null : String(body.notas);
  const result = await pool.query(
    `INSERT INTO core.vac_licencia_overrides
       (usuario_licencia_id, dias_computados, incluida, notas, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (usuario_licencia_id) DO UPDATE SET
       dias_computados = EXCLUDED.dias_computados,
       incluida = EXCLUDED.incluida,
       notas = EXCLUDED.notas,
       updated_by = EXCLUDED.updated_by,
       updated_at = NOW()
     RETURNING usuario_licencia_id, dias_computados, incluida, notas`,
    [licenciaId, diasComputados, incluida, notas, userId || null]
  );
  const row = result.rows[0];
  return {
    usuarioLicenciaId: Number(row.usuario_licencia_id),
    diasComputados: row.dias_computados == null ? null : Number(row.dias_computados),
    incluida: Boolean(row.incluida),
    notas: row.notas || null,
  };
}

module.exports = {
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
  editarAjuste,
  editarBloque,
  editarCategoria,
  editarFeriado,
  editarGrupo,
  eliminarAjuste,
  eliminarBloque,
  eliminarCategoria,
  eliminarFeriado,
  eliminarGrupo,
  generarCronograma,
  getCandidatos,
  getCategorias,
  getConflictos,
  getCronograma,
  getDiasTomados,
  getDirectorioIntegre,
  getFeriados,
  getFuncionarios,
  getGrupos,
  getIntegreUsers,
  getLicencias,
  getPlanEstado,
  getRoster,
  getSaldosIniciales,
  isPlanLocked,
  listAjustes,
  recalcularCorresponden,
  recalcularTodos,
  saveSaldosIniciales,
  upsertFuncionario,
};
