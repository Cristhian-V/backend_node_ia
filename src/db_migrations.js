const pool = require("./db");

async function ensureTables() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS core.tipo_cambio (
        id SERIAL PRIMARY KEY,
        fecha DATE NOT NULL UNIQUE,
        compra NUMERIC(10,2) NOT NULL,
        venta NUMERIC(10,2) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    console.log("  [DB] Tabla core.tipo_cambio verificada");
  } catch (err) {
    console.error("  [DB] Error creando tabla tipo_cambio:", err.message);
  }

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS core.arancel_nacional (
        codigo VARCHAR(15) PRIMARY KEY,
        prefijo6 VARCHAR(6) NOT NULL,
        descripcion TEXT NOT NULL,
        ga_porcentaje NUMERIC(5,2),
        ga_decimal NUMERIC(5,4),
        ga_reducido NUMERIC(5,4),
        iva NUMERIC(5,2) DEFAULT 14.94,
        ice_iehd VARCHAR(50),
        unidad_medida VARCHAR(10),
        tipo_doc VARCHAR(50),
        entidad_emite VARCHAR(200),
        disp_legal VARCHAR(300)
      )
    `);
    await pool.query(
      "CREATE INDEX IF NOT EXISTS ix_arancel_prefijo6 ON core.arancel_nacional (prefijo6)"
    );
    console.log("  [DB] Tabla core.arancel_nacional verificada");
  } catch (err) {
    console.error("  [DB] Error creando tabla arancel_nacional:", err.message);
  }
}

module.exports = { ensureTables };
