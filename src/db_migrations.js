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

async function ensureControlTables() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS core.control_clientes (
        id SERIAL PRIMARY KEY,
        nit TEXT NOT NULL UNIQUE,
        nombre TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    console.log("  [DB] Tabla core.control_clientes verificada");
  } catch (err) {
    console.error("  [DB] Error creando control_clientes:", err.message);
  }

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS core.control_operaciones (
        id SERIAL PRIMARY KEY,
        dim TEXT NOT NULL UNIQUE,
        gestion INTEGER,
        aduana INTEGER,
        dui TEXT,

        aduana_codigo TEXT,
        aduana_descripcion TEXT,
        fecha_aceptacion TIMESTAMP,
        estado TEXT,
        nit_declarante TEXT,
        razon_social_declarante TEXT,
        nro_referencia TEXT,
        destino_regimen_codigo TEXT,
        destino_regimen_descripcion TEXT,
        modalidad_regimen_codigo TEXT,
        modalidad_regimen_descripcion TEXT,
        modalidad_despacho TEXT,
        total_items INTEGER,
        nit_importador TEXT,
        razon_social_importador TEXT,
        valor_cif NUMERIC(18,2),
        peso_bruto NUMERIC(18,3),
        tributos NUMERIC(18,2),
        rup_pago TEXT,
        fecha_pago TIMESTAMP,
        canal TEXT,
        fecha_asignacion_canal TIMESTAMP,
        fecha_levante TIMESTAMP,
        fecha_regularizacion TIMESTAMP,
        fecha_inicio_plazo TIMESTAMP,
        fecha_conclusion TIMESTAMP,

        regimen TEXT,
        dui_due TEXT,

        liquidador TEXT,
        planilla INTEGER,
        planillado INTEGER,
        planillador TEXT DEFAULT 'NARDA MARIACA',
        observaciones TEXT,

        fecha_reporte_pago DATE,
        archivo_origen TEXT,
        clic_ultima_sync TIMESTAMPTZ,
        fecha_carga TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(
      "ALTER TABLE core.control_operaciones ADD COLUMN IF NOT EXISTS clic_ultima_sync TIMESTAMPTZ"
    );
    await pool.query(
      "ALTER TABLE core.control_operaciones ADD COLUMN IF NOT EXISTS fecha_inicio_plazo TIMESTAMP"
    );
    await pool.query(
      "CREATE INDEX IF NOT EXISTS ix_control_op_fecha_pago ON core.control_operaciones (fecha_pago)"
    );
    await pool.query(
      "CREATE INDEX IF NOT EXISTS ix_control_op_nit ON core.control_operaciones (nit_importador)"
    );
    console.log("  [DB] Tabla core.control_operaciones verificada");
  } catch (err) {
    console.error("  [DB] Error creando control_operaciones:", err.message);
  }
}

async function ensureVacacionesTables() {
  const statements = [
    [
      "vac_funcionarios",
      `CREATE TABLE IF NOT EXISTS core.vac_funcionarios (
        usuario_id INTEGER PRIMARY KEY,
        incluido BOOLEAN NOT NULL DEFAULT TRUE,
        fecha_ingreso DATE,
        categoria VARCHAR(40),
        notas TEXT,
        updated_by INTEGER,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
    ],
    [
      "vac_saldos_iniciales",
      `CREATE TABLE IF NOT EXISTS core.vac_saldos_iniciales (
        id SERIAL PRIMARY KEY,
        usuario_id INTEGER NOT NULL,
        gestion INTEGER NOT NULL CHECK (gestion BETWEEN 2000 AND 2100),
        dias_corresponden NUMERIC(6,2) NOT NULL CHECK (dias_corresponden >= 0),
        dias_pendientes NUMERIC(6,2) NOT NULL DEFAULT 0 CHECK (dias_pendientes >= 0),
        dias_pagados NUMERIC(6,2) NOT NULL DEFAULT 0 CHECK (dias_pagados >= 0),
        notas TEXT,
        updated_by INTEGER,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (usuario_id, gestion)
      )`,
    ],
    [
      "vac_ajustes",
      `CREATE TABLE IF NOT EXISTS core.vac_ajustes (
        id SERIAL PRIMARY KEY,
        usuario_id INTEGER NOT NULL,
        gestion INTEGER NOT NULL CHECK (gestion BETWEEN 2000 AND 2100),
        dias NUMERIC(6,2) NOT NULL,
        tipo VARCHAR(20) NOT NULL CHECK (tipo IN ('arrastre','pago','correccion','compensacion')),
        motivo TEXT,
        created_by INTEGER,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
    ],
    [
      "vac_planes",
      `CREATE TABLE IF NOT EXISTS core.vac_planes (
        id SERIAL PRIMARY KEY,
        usuario_id INTEGER NOT NULL,
        gestion INTEGER NOT NULL CHECK (gestion BETWEEN 2000 AND 2100),
        fecha_desde DATE NOT NULL,
        fecha_hasta DATE NOT NULL,
        dias_planificados NUMERIC(6,2) NOT NULL CHECK (dias_planificados >= 0),
        origen VARCHAR(20) NOT NULL DEFAULT 'manual' CHECK (origen IN ('auto','manual','importado')),
        notas TEXT,
        created_by INTEGER,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CHECK (fecha_hasta >= fecha_desde)
      )`,
    ],
    [
      "vac_plan_estado",
      `CREATE TABLE IF NOT EXISTS core.vac_plan_estado (
        gestion INTEGER PRIMARY KEY CHECK (gestion BETWEEN 2000 AND 2100),
        estado VARCHAR(20) NOT NULL DEFAULT 'borrador' CHECK (estado IN ('borrador','bloqueado')),
        bloqueado_por INTEGER,
        bloqueado_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
    ],
    [
      "vac_grupos",
      `CREATE TABLE IF NOT EXISTS core.vac_grupos (
        id SERIAL PRIMARY KEY,
        nombre TEXT NOT NULL,
        cliente TEXT,
        notas TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
    ],
    [
      "vac_grupo_miembros",
      `CREATE TABLE IF NOT EXISTS core.vac_grupo_miembros (
        grupo_id INTEGER NOT NULL REFERENCES core.vac_grupos(id) ON DELETE CASCADE,
        usuario_id INTEGER NOT NULL,
        PRIMARY KEY (grupo_id, usuario_id)
      )`,
    ],
    [
      "vac_feriados",
      `CREATE TABLE IF NOT EXISTS core.vac_feriados (
        id SERIAL PRIMARY KEY,
        fecha DATE NOT NULL UNIQUE,
        descripcion TEXT,
        ambito VARCHAR(20) NOT NULL DEFAULT 'nacional' CHECK (ambito IN ('nacional','departamental')),
        descuenta BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
    ],
    [
      "vac_licencia_overrides",
      `CREATE TABLE IF NOT EXISTS core.vac_licencia_overrides (
        usuario_licencia_id INTEGER PRIMARY KEY,
        dias_computados NUMERIC(6,2) CHECK (dias_computados IS NULL OR dias_computados >= 0),
        incluida BOOLEAN NOT NULL DEFAULT TRUE,
        notas TEXT,
        updated_by INTEGER,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
    ],
    [
      "vac_import_log",
      `CREATE TABLE IF NOT EXISTS core.vac_import_log (
        id SERIAL PRIMARY KEY,
        archivo_hash TEXT,
        entidad VARCHAR(40) NOT NULL,
        clave TEXT,
        accion VARCHAR(20) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
    ],
    [
      "vac_categorias",
      `CREATE TABLE IF NOT EXISTS core.vac_categorias (
        id SERIAL PRIMARY KEY,
        nombre VARCHAR(60) NOT NULL UNIQUE,
        color VARCHAR(20) NOT NULL DEFAULT '#64748b',
        activo BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
    ],
    [
      "vac_migrations",
      `CREATE TABLE IF NOT EXISTS core.vac_migrations (
        key TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
    ],
  ];

  for (const [name, sql] of statements) {
    try {
      await pool.query(sql);
      console.log(`  [DB] Tabla core.${name} verificada`);
    } catch (err) {
      console.error(`  [DB] Error creando core.${name}:`, err.message);
    }
  }

  const indexes = [
    "CREATE INDEX IF NOT EXISTS ix_vac_planes_usuario_gestion ON core.vac_planes (usuario_id, gestion)",
    "CREATE INDEX IF NOT EXISTS ix_vac_ajustes_usuario_gestion ON core.vac_ajustes (usuario_id, gestion)",
    "CREATE INDEX IF NOT EXISTS ix_vac_grupo_miembros_usuario ON core.vac_grupo_miembros (usuario_id)",
    "CREATE INDEX IF NOT EXISTS ix_vac_import_log_hash ON core.vac_import_log (archivo_hash)",
  ];
  for (const sql of indexes) {
    try {
      await pool.query(sql);
    } catch (err) {
      console.error("  [DB] Error creando indice de vacaciones:", err.message);
    }
  }

  await seedVacacionesFeriados();
  await seedVacacionesCategorias();
  await runVacacionesDataFixes();
}

async function seedVacacionesCategorias() {
  const categorias = [
    ["Analista", "#3b82f6"],
    ["Administrativo", "#8b5cf6"],
    ["Gestor", "#10b981"],
    ["Mensajería", "#f59e0b"],
    ["Sistemas", "#06b6d4"],
    ["Archivo", "#ec4899"],
  ];
  try {
    for (const [nombre, color] of categorias) {
      await pool.query(
        `INSERT INTO core.vac_categorias (nombre, color)
         VALUES ($1, $2) ON CONFLICT (nombre) DO NOTHING`,
        [nombre, color]
      );
    }
    console.log("  [DB] Categorías de vacaciones verificadas");
  } catch (err) {
    console.error("  [DB] Error cargando categorías de vacaciones:", err.message);
  }
}

async function runVacacionesDataFixes() {
  const key = "2026-10-categorias-cargo";
  try {
    const done = await pool.query("SELECT 1 FROM core.vac_migrations WHERE key = $1", [key]);
    if (done.rows.length === 0) {
    const result = await pool.query(
      `UPDATE core.vac_funcionarios
          SET categoria = CASE
            WHEN UPPER(categoria) LIKE '%ANALISTA%' THEN 'Analista'
            WHEN UPPER(categoria) LIKE '%GESTOR%' THEN 'Gestor'
            WHEN UPPER(categoria) LIKE '%MENSAJERIA%' OR UPPER(categoria) LIKE '%MENSAJERÍA%' THEN 'Mensajería'
            WHEN UPPER(categoria) LIKE '%SISTEMA%' THEN 'Sistemas'
            WHEN UPPER(categoria) LIKE '%ARCHIVO%' THEN 'Archivo'
            WHEN UPPER(categoria) LIKE '%ADMINISTRATIVO%' OR UPPER(categoria) LIKE '%ASISTENTE%' THEN 'Administrativo'
            ELSE categoria
          END
        WHERE categoria IS NOT NULL`
    );
    await pool.query(
      "INSERT INTO core.vac_migrations (key) VALUES ($1) ON CONFLICT DO NOTHING",
      [key]
    );
    console.log(`  [DB] Migración de categorías de vacaciones aplicada (${result.rowCount} filas)`);
    }
  } catch (err) {
    console.error("  [DB] Error en migración de categorías de vacaciones:", err.message);
  }

  const fixKey = "2026-10-fix-mensajeria";
  try {
    const done = await pool.query("SELECT 1 FROM core.vac_migrations WHERE key = $1", [fixKey]);
    if (done.rows.length > 0) return;
    await pool.query(
      `UPDATE core.vac_funcionarios
          SET categoria = 'Mensajería'
        WHERE categoria LIKE 'Mensajer%a' AND categoria <> 'Mensajería'`
    );
    await pool.query(
      "DELETE FROM core.vac_categorias WHERE nombre LIKE 'Mensajer%a' AND nombre <> 'Mensajería'"
    );
    await pool.query(
      "INSERT INTO core.vac_migrations (key) VALUES ($1) ON CONFLICT DO NOTHING",
      [fixKey]
    );
    console.log("  [DB] Corrección de categoría Mensajería aplicada");
  } catch (err) {
    console.error("  [DB] Error corrigiendo categoría Mensajería:", err.message);
  }
}

async function seedVacacionesFeriados() {
  const feriados = [
    ["2026-01-01", "Año Nuevo", "nacional", true],
    ["2026-01-22", "Estado Plurinacional", "nacional", true],
    ["2026-02-14", "Efeméride de Santa Cruz", "departamental", false],
    ["2026-02-16", "Carnaval", "nacional", true],
    ["2026-02-17", "Carnaval", "nacional", true],
    ["2026-04-03", "Viernes Santo", "nacional", true],
    ["2026-05-01", "Día del Trabajo", "nacional", true],
    ["2026-06-04", "Corpus Christi", "nacional", true],
    ["2026-06-21", "Año Nuevo Andino", "nacional", true],
    ["2026-08-06", "Independencia de Bolivia", "nacional", true],
    ["2026-09-24", "Efeméride de Santa Cruz", "departamental", false],
    ["2026-11-02", "Todos Santos", "nacional", true],
    ["2026-12-25", "Navidad", "nacional", true],
    ["2027-01-01", "Año Nuevo", "nacional", true],
    ["2027-01-22", "Estado Plurinacional", "nacional", true],
    ["2027-02-08", "Carnaval", "nacional", true],
    ["2027-02-09", "Carnaval", "nacional", true],
    ["2027-02-14", "Efeméride de Santa Cruz", "departamental", false],
    ["2027-03-26", "Viernes Santo", "nacional", true],
    ["2027-05-01", "Día del Trabajo", "nacional", true],
    ["2027-05-27", "Corpus Christi", "nacional", true],
    ["2027-06-21", "Año Nuevo Andino", "nacional", true],
    ["2027-08-06", "Independencia de Bolivia", "nacional", true],
    ["2027-09-24", "Efeméride de Santa Cruz", "departamental", false],
    ["2027-11-02", "Todos Santos", "nacional", true],
    ["2027-12-25", "Navidad", "nacional", true],
  ];

  try {
    for (const [fecha, descripcion, ambito, descuenta] of feriados) {
      await pool.query(
        `INSERT INTO core.vac_feriados (fecha, descripcion, ambito, descuenta)
         VALUES ($1, $2, $3, $4) ON CONFLICT (fecha) DO NOTHING`,
        [fecha, descripcion, ambito, descuenta]
      );
    }
    console.log("  [DB] Feriados de vacaciones 2026/2027 verificados");
  } catch (err) {
    console.error("  [DB] Error cargando feriados de vacaciones:", err.message);
  }
}

async function runControlDataFixes() {
  try {
    await pool.query(
      "CREATE TABLE IF NOT EXISTS core.control_migrations (key TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())"
    );
    const key = "2026-10-fecha-inicio-plazo";
    const done = await pool.query("SELECT 1 FROM core.control_migrations WHERE key = $1", [key]);
    if (done.rows.length > 0) return;

    // La columna Y del SUMA ("Fecha de regularización") está mal nombrada: es el
    // inicio del plazo. Se mueve a fecha_inicio_plazo y se limpia fecha_regularizacion
    // (que pasa a ser manual). Corre una sola vez.
    const moved = await pool.query(
      `UPDATE core.control_operaciones
         SET fecha_inicio_plazo = COALESCE(fecha_inicio_plazo, fecha_regularizacion),
             fecha_regularizacion = NULL
       WHERE fecha_regularizacion IS NOT NULL`
    );
    await pool.query(
      "INSERT INTO core.control_migrations (key) VALUES ($1) ON CONFLICT DO NOTHING",
      [key]
    );
    console.log(`  [DB] Migración fecha_inicio_plazo aplicada (${moved.rowCount} filas)`);
  } catch (err) {
    console.error("  [DB] Error en migración fecha_inicio_plazo:", err.message);
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

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS core.transbel_sync (
        id SERIAL PRIMARY KEY,
        operacion_id INTEGER NOT NULL UNIQUE,
        entrega VARCHAR(80),
        payload JSONB,
        estado VARCHAR(20) NOT NULL DEFAULT 'pendiente',
        motivo TEXT,
        enviado BOOLEAN NOT NULL DEFAULT FALSE,
        fecha_envio TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    console.log("  [DB] Tabla core.transbel_sync verificada");
  } catch (err) {
    console.error("  [DB] Error creando tabla transbel_sync:", err.message);
  }

  await fixArancelColumns();
  await ensureFnningTables();
  await ensureControlTables();
  await ensureVacacionesTables();
  await runControlDataFixes();

  await fixUserToolsConstraint();
  await fixUsersPasswordColumn();
  await fixUsersIntegreColumn();
}

module.exports = { ensureTables };
