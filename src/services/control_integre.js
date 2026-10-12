const sql = require("mssql");

/**
 * Control de Operaciones — enriquecimiento desde Integgre (solo lectura).
 * Busca la carpeta (OperacionId) y el responsable (Usuarios.NombreCompleto) por
 * NroDUI + gestión. Usa la base de datos de producción `Integgre` (no `InteggreTest`)
 * con un pool propio, para no afectar a Transbel/FNNING.
 */

const config = {
  server:
    process.env.CONTROL_DB_HOST ||
    process.env.FNNING_DB_HOST ||
    "192.168.1.12\\Cumbre",
  database: process.env.CONTROL_DB_NAME || "Integgre",
  user: process.env.CONTROL_DB_USER || process.env.FNNING_DB_USER || "sa",
  password:
    process.env.CONTROL_DB_PASSWORD || process.env.FNNING_DB_PASSWORD || "",
  options: {
    encrypt: false,
    trustServerCertificate: true,
  },
  requestTimeout: 60000,
  pool: {
    max: 10,
    min: 0,
    idleTimeoutMillis: 30000,
  },
};

let pool = null;

async function getControlPool() {
  if (!pool) {
    pool = new sql.ConnectionPool(config);
    pool.on("error", (err) =>
      console.error("  [CONTROL] SQL Server pool error:", err.message)
    );
    await pool.connect();
    console.log("  [CONTROL] SQL Server conectado:", config.server, "/", config.database);
  }
  return pool;
}

const RESOLVER_SQL = `
  SELECT TOP 1 c.OperacionId, u.NombreCompleto AS liquidador
  FROM dbo.CME_Operacion c WITH(NOLOCK)
  LEFT JOIN dbo.Usuarios u WITH(NOLOCK) ON u.UsuarioId = c.UsuarioId
  WHERE c.Gestion = @gestion
    AND TRY_CONVERT(INT, c.NroDUI) = @dui
  ORDER BY c.OperacionId DESC
`;

/**
 * @param {{ gestion?: number|null, aduana?: number|null, dui?: string|number|null }} key
 * @returns {Promise<{ operacionId: number, liquidador: string|null } | null>}
 */
async function resolverOperacion({ gestion, dui } = {}) {
  if (gestion == null || dui == null || dui === "") return null;
  const duiInt = parseInt(String(dui).replace(/\D/g, ""), 10);
  if (Number.isNaN(duiInt)) return null;

  const conn = await getControlPool();
  const request = conn.request();
  request.input("gestion", sql.Int, gestion);
  request.input("dui", sql.Int, duiInt);
  const result = await request.query(RESOLVER_SQL);
  if (!result.recordset.length) return null;

  const row = result.recordset[0];
  return { operacionId: row.OperacionId, liquidador: row.liquidador || null };
}

module.exports = { resolverOperacion, RESOLVER_SQL, config };
