const pg = require("../db");

async function getIgnoredOperacionIds() {
  const res = await pg.query("SELECT operacion_id FROM core.transbel_ignorados");
  return new Set(res.rows.map((r) => Number(r.operacion_id)));
}

async function ignorar({ operacionId, usuario, motivo }) {
  await pg.query(
    `INSERT INTO core.transbel_ignorados
       (operacion_id, motivo, usuario_id, usuario_integre, created_at, updated_at)
     VALUES ($1, $2, $3, $4, NOW(), NOW())
     ON CONFLICT (operacion_id) DO UPDATE SET
       motivo = EXCLUDED.motivo,
       usuario_id = EXCLUDED.usuario_id,
       usuario_integre = EXCLUDED.usuario_integre,
       updated_at = NOW()`,
    [
      operacionId,
      motivo || null,
      usuario && usuario.id != null ? Number(usuario.id) : null,
      usuario && usuario.usuario_integre != null
        ? Number(usuario.usuario_integre)
        : null,
    ]
  );
}

async function restaurar({ operacionId }) {
  const res = await pg.query(
    "DELETE FROM core.transbel_ignorados WHERE operacion_id = $1",
    [operacionId]
  );
  return res.rowCount > 0;
}

module.exports = {
  getIgnoredOperacionIds,
  ignorar,
  restaurar,
};
