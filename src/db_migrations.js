const pool = require("./db");
const { VALID_TOOLS } = require("./constants");

async function fixUserToolsConstraint() {
  try {
    const toolsList = VALID_TOOLS.map((t) => `'${t}'`).join(", ");
    await pool.query(
      "ALTER TABLE core.user_tools DROP CONSTRAINT IF EXISTS ck_user_tools_key"
    );
    await pool.query(
      `ALTER TABLE core.user_tools ADD CONSTRAINT ck_user_tools_key CHECK (tool_key IN (${toolsList}))`
    );
    console.log("  [DB] Constraint ck_user_tools_key actualizada");
  } catch (err) {
    console.error("  [DB] Error actualizando ck_user_tools_key:", err.message);
  }
}

async function fixUsersPasswordColumn() {
  try {
    await pool.query(
      "ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE"
    );
    console.log("  [DB] Columna auth.users.must_change_password verificada");
  } catch (err) {
    console.error("  [DB] Error agregando must_change_password:", err.message);
  }
}

async function fixUsersIntegreColumn() {
  try {
    await pool.query(
      "ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS usuario_integre INTEGER"
    );
    console.log("  [DB] Columna auth.users.usuario_integre verificada");
  } catch (err) {
    console.error("  [DB] Error agregando usuario_integre:", err.message);
  }
}

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

  await fixUserToolsConstraint();
  await fixUsersPasswordColumn();
  await fixUsersIntegreColumn();
}

module.exports = { ensureTables };
