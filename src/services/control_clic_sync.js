const defaultPool = require("../db");
const { createClickSession } = require("./click_scraper");

/**
 * Control de Operaciones — sincronización diaria del CANAL desde el CLICK.
 * Completa `canal` y `fecha_asignacion_canal` de las operaciones sin canal,
 * reusando una única sesión y con throttle. No toca la fecha de regularización.
 */

const CANAL_BY_IMAGE = {
  "img/verde.jpg": "VERDE",
  "img/amarillo.jpg": "AMARILLO",
  "img/rojo.jpg": "ROJO",
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fmtFechaUTC(d) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return null;
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(
    d.getUTCHours()
  )}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

/** Canal y fecha desde el evento DETERMINACION DE CANAL (imagen = color). */
function derivarCanal(parsed) {
  if (!parsed || !Array.isArray(parsed.eventos)) return null;
  const ev = parsed.eventos.find((e) =>
    /DETERMINACION DE CANAL/i.test(e.tipo || "")
  );
  if (!ev) return null;
  const canal = CANAL_BY_IMAGE[ev.imagen];
  if (!canal) return null;
  return { canal, fecha: fmtFechaUTC(ev.fecha) };
}

const SELECT_SIN_CANAL = `
  SELECT id, dim, gestion, aduana, dui
  FROM core.control_operaciones
  WHERE (canal IS NULL OR canal = '')
    AND gestion IS NOT NULL
    AND aduana IS NOT NULL
    AND dui IS NOT NULL AND dui <> ''
  ORDER BY fecha_pago NULLS LAST, id
  LIMIT $1`;

async function seleccionarSinCanal(pool, limit) {
  const res = await pool.query(SELECT_SIN_CANAL, [limit]);
  return res.rows;
}

async function actualizarCanal(pool, id, canal, fecha) {
  await pool.query(
    `UPDATE core.control_operaciones
       SET canal = $1,
           fecha_asignacion_canal = $2,
           clic_ultima_sync = NOW(),
           updated_at = NOW()
     WHERE id = $3`,
    [canal, fecha, id]
  );
}

/**
 * Sincroniza el canal de todas las operaciones sin canal.
 * @param {{ pool?, limit?, throttleMs?, dryRun?, sessionFactory?, onProgress? }} opts
 */
async function sincronizarCanal({
  pool = defaultPool,
  limit = 500,
  throttleMs = 1500,
  dryRun = false,
  sessionFactory = createClickSession,
  onProgress,
} = {}) {
  const ops = await seleccionarSinCanal(pool, limit);
  if (dryRun) {
    return { dryRun: true, pendientes: ops.length, operaciones: ops };
  }

  const report = (extra) =>
    onProgress &&
    onProgress({
      total: ops.length,
      processed: 0,
      updated: 0,
      sin_canal: 0,
      errores: 0,
      currentDim: null,
      ...extra,
    });

  if (ops.length === 0) {
    report({ phase: "done" });
    return { procesadas: 0, actualizadas: 0, sin_canal: 0, errores: 0, results: [] };
  }

  const session = sessionFactory();
  await session.init();

  let actualizadas = 0;
  let sinCanal = 0;
  let errores = 0;
  const results = [];

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    report({
      phase: "scrape",
      processed: i,
      updated: actualizadas,
      sin_canal: sinCanal,
      errores,
      currentDim: op.dim,
    });
    try {
      const parsed = await session.scrape(op.gestion, op.aduana, op.dui);
      const c = derivarCanal(parsed);
      if (!c) {
        sinCanal++;
        results.push({ id: op.id, dim: op.dim, ok: true, canal: null });
      } else {
        await actualizarCanal(pool, op.id, c.canal, c.fecha);
        actualizadas++;
        results.push({ id: op.id, dim: op.dim, ok: true, canal: c.canal });
      }
    } catch (err) {
      errores++;
      results.push({ id: op.id, dim: op.dim, ok: false, error: err.message });
    }
    report({
      phase: "scrape",
      processed: i + 1,
      updated: actualizadas,
      sin_canal: sinCanal,
      errores,
      currentDim: op.dim,
      lastCanal: results[results.length - 1].canal || null,
    });
    if (i < ops.length - 1) await sleep(throttleMs);
  }

  return { procesadas: ops.length, actualizadas, sin_canal: sinCanal, errores, results };
}

// --- Estado en memoria del job manual (para la barra de progreso del frontend) ---
let progress = {
  running: false,
  phase: "idle",
  total: 0,
  processed: 0,
  updated: 0,
  sin_canal: 0,
  errores: 0,
  currentDim: null,
  startedAt: null,
  finishedAt: null,
  error: null,
};

function getProgress() {
  return { ...progress };
}

/** Lanza la sincronización en segundo plano (no bloquea). Una sola a la vez. */
async function startSyncBackground({ limit = 500, throttleMs = 1500 } = {}) {
  if (progress.running) return { started: false, reason: "already_running" };

  progress = {
    running: true,
    phase: "start",
    total: 0,
    processed: 0,
    updated: 0,
    sin_canal: 0,
    errores: 0,
    currentDim: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
  };

  sincronizarCanal({
    limit,
    throttleMs,
    onProgress: (p) => {
      progress = { ...progress, ...p };
    },
  })
    .then((res) => {
      progress = {
        ...progress,
        running: false,
        phase: "done",
        total: res.procesadas,
        processed: res.procesadas,
        updated: res.actualizadas,
        sin_canal: res.sin_canal,
        errores: res.errores,
        currentDim: null,
        finishedAt: new Date().toISOString(),
      };
    })
    .catch((err) => {
      progress = {
        ...progress,
        running: false,
        phase: "error",
        error: err.message,
        finishedAt: new Date().toISOString(),
      };
    });

  return { started: true };
}

module.exports = {
  sincronizarCanal,
  startSyncBackground,
  getProgress,
  seleccionarSinCanal,
  derivarCanal,
  fmtFechaUTC,
  CANAL_BY_IMAGE,
  SELECT_SIN_CANAL,
};
