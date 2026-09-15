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

async function fixArancelColumns() {
  const cols = [
    ["despacho_frontera", "VARCHAR(50)"],
    ["can_ace36_47", "VARCHAR(50)"],
    ["chi", "VARCHAR(50)"],
    ["prot", "VARCHAR(50)"],
    ["ace66_mexico", "VARCHAR(50)"],
  ];
  for (const [name, type] of cols) {
    try {
      await pool.query(
        `ALTER TABLE core.arancel_nacional ADD COLUMN IF NOT EXISTS ${name} ${type}`
      );
    } catch (err) {
      console.error(`  [DB] Error agregando arancel_nacional.${name}:`, err.message);
    }
  }
  console.log("  [DB] Columnas extra de core.arancel_nacional verificadas");
}

async function ensureFnningTables() {
  try {
    const old = await pool.query(`
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'core' AND table_name = 'fnning_items' AND column_name = 'item_id'
    `);
    if (old.rows.length > 0) {
      await pool.query("DROP TABLE core.fnning_items");
      console.log("  [DB] Tabla core.fnning_items antigua (espejo de Item) eliminada");
    }
  } catch (err) {
    console.error("  [DB] Error eliminando tabla fnning_items antigua:", err.message);
  }

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS core.fnning_items (
        id SERIAL PRIMARY KEY,
        codigo_sap VARCHAR(50) NOT NULL,
        codigo_mod VARCHAR(50),
        material VARCHAR(200),
        partida_arancel VARCHAR(10) NOT NULL DEFAULT '',
        descripcion_dim TEXT,
        resuelto BOOLEAN NOT NULL DEFAULT FALSE,
        cargado_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(
      "CREATE INDEX IF NOT EXISTS ix_fnning_items_codigo_sap ON core.fnning_items (codigo_sap)"
    );
    await pool.query(
      "CREATE INDEX IF NOT EXISTS ix_fnning_items_partida_arancel ON core.fnning_items (partida_arancel)"
    );
    console.log("  [DB] Tabla core.fnning_items verificada");
  } catch (err) {
    console.error("  [DB] Error creando tabla fnning_items:", err.message);
  }

  try {
    await pool.query("DROP TABLE IF EXISTS core.fnning_sync_state");
    await pool.query("DROP TABLE IF EXISTS core.fnning_partnumber_resolucion");
    console.log("  [DB] Tablas de control de sincronizacion FNNING eliminadas");
  } catch (err) {
    console.error("  [DB] Error eliminando tablas de control FNNING:", err.message);
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
        disp_legal VARCHAR(300),
        despacho_frontera VARCHAR(50),
        can_ace36_47 VARCHAR(50),
        chi VARCHAR(50),
        prot VARCHAR(50),
        ace66_mexico VARCHAR(50)
      )
    `);
    await pool.query(
      "CREATE INDEX IF NOT EXISTS ix_arancel_prefijo6 ON core.arancel_nacional (prefijo6)"
    );
    console.log("  [DB] Tabla core.arancel_nacional verificada");
  } catch (err) {
    console.error("  [DB] Error creando tabla arancel_nacional:", err.message);
  }

  await fixArancelColumns();
  await ensureFnningTables();

  await fixUserToolsConstraint();
  await fixUsersPasswordColumn();
  await fixUsersIntegreColumn();
}

module.exports = { ensureTables };
