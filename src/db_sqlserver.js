const sql = require("mssql");

let pool = null;

const config = {
  server: process.env.FNNING_DB_HOST || "192.168.1.12\\Cumbre",
  database: process.env.FNNING_DB_NAME || "InteggreTest",
  user: process.env.FNNING_DB_USER || "sa",
  password: process.env.FNNING_DB_PASSWORD || "",
  options: {
    encrypt: false,
    trustServerCertificate: true,
  },
  pool: {
    max: 10,
    min: 0,
    idleTimeoutMillis: 30000,
  },
};

async function getPool() {
  if (!pool) {
    pool = await sql.connect(config);
    console.log("  [FNNING] SQL Server conectado:", config.server, "/", config.database);
  }
  return pool;
}

module.exports = { getPool, sql };
