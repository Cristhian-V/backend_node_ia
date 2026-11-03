const crypto = require("crypto");
const XLSX = require("xlsx");
const pool = require("../db");
const core = require("./vacaciones_core");
const { getDirectorioIntegre } = require("./vacaciones");

const MONTHS = {
  ENERO: 1,
  FEBRERO: 2,
  MARZO: 3,
  ABRIL: 4,
  MAYO: 5,
  JUNIO: 6,
  JULIO: 7,
  AGOSTO: 8,
  SEPTIEMBRE: 9,
  OCTUBRE: 10,
  NOVIEMBRE: 11,
  DICIEMBRE: 12,
};

const ALIASES = {
  PJG: "PABLO JUNIOR GONZALES PEREZ",
  AMGM: "ANA MARIA GUZMAN MENDEZ",
  MPR: "MARGARITA PATRONI REA",
  NAP: "NATALIA APARICIO PARADA",
  SHS: "SAMUEL HURTADO SUAREZ",
  FVP: "FERNANDO VASQUEZ PINEDO",
  "RUDY ARTEAGA": "RUDDY ARTEAGA ORTIZ",
  "CARLOS RIVERO": "CARLOS ALBERTO RIVERO FERNANDEZ",
  "VICTOR HUGO GALLY": "VICTOR HUGO GALLY ANEZ",
  "LIA MILENA TORREZ": "LIA MILENA CLAURE TORREZ",
  "SAMUEL HURTADO": "SAMUEL HURTADO SUAREZ",
  "MARGARITA PATRONI": "MARGARITA PATRONI REA",
  "CARLOS TERRAZAS": "CARLOS ZABATT TERRAZAS ARDAYA",
  "DELFIN CHOQUE": "DELFIN CHOQUE SAIQUI",
  "NATALIA APARICIO": "NATALIA APARICIO PARADA",
  "HUAPACK PATEC FRANCO": "HUAPACK PATEC FRANCO STRELLI",
  "ALBERT GUZMAN": "ALBERT GUZMAN SANGUINO",
  "HUGO AGUILERA": "HUGO AGUILERA RIVERA",
  "SONIA VEDIA": "SONIA VEDIA",
  "CRISTHIAN VARGAS": "CRISTHIAN VARGAS",
  "ARIEL CRUZ": "ARIEL CRUZ GARCIA",
  "FERNANDO VASQUEZ": "FERNANDO VASQUEZ PINEDO",
  "NEIDA MANSILLA": "NEIDA MANSILLA",
  "ANA MARIA GUZMAN": "ANA MA GUZMAN MENDEZ",
  "JESUS RIVERO": "MANUEL JESUS RIVERO MONTANO",
  "KATTY ALBA": "KATTY ALBA ARTEAGA",
  "LOURDES SUAREZ": "MARIA LOURDES SUAREZ ARDAY",
  "ROBERTO MAGNE": "ROBERTO MAGNE CHOQUETILLA",
  "JOSE LUIS ARANDIA": "JOSE LUIS ARANDIA FLORES",
  "ANA LUISA CONDORI": "ANA LUISA CONDORI QUISPE",
  "FERNANDO ROMAN": "FERNANDO ROMAN",
  "GABRIELA ALIAGA": "GABRIELA ALIAGA",
  "PABLO JUNIOR GONZALES": "PABLO JUNIOR GONZALES PEREZ",
  "ANDREA MIER": "ANDREA MIER",
  "EVA MARTHA CALLISAYA": "EVA MARTHA CALLISAYA NINA",
  "JOSE LUIS QUISBERT": "JOSE LUIS QUISBERT VARGAS",
  "YERY ELOY HERRERA": "YERY ELOY HERRERA MAYAN",
};

function pad2(n) {
  return String(n).padStart(2, "0");
}

function normalizarNombre(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function normalizarCi(value) {
  return String(value || "").replace(/\D/g, "");
}

function normalizarAlias(value) {
  const norm = normalizarNombre(value);
  return normalizarNombre(ALIASES[norm] || norm);
}

function excelDateToString(value) {
  if (value == null || value === "") return null;
  if (value instanceof Date) {
    return `${value.getFullYear()}-${pad2(value.getMonth() + 1)}-${pad2(value.getDate())}`;
  }
  if (typeof value === "number") {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (parsed) return `${parsed.y}-${pad2(parsed.m)}-${pad2(parsed.d)}`;
  }
  const s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const dm = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (dm) return `${dm[3]}-${pad2(dm[2])}-${pad2(dm[1])}`;
  const date = new Date(s);
  if (!Number.isNaN(date.getTime())) {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  }
  return null;
}

function parseDias(value) {
  const match = String(value || "").replace(",", ".").match(/(\d+(?:\.\d+)?)/);
  return match ? Number(match[1]) : null;
}

function extractDiasLabel(value) {
  const match = String(value || "").match(/\(\s*(\d+(?:[.,]\d+)?)\s*D[IÍ]AS?/i);
  return match ? Number(match[1].replace(",", ".")) : null;
}

function cleanName(value) {
  return String(value || "")
    .replace(/\s*\([^)]*\).*$/, "")
    .replace(/\s+-\s+.*$/, "")
    .trim();
}

function mapearCategoria(cargo) {
  const value = normalizarNombre(cargo);
  if (!value) return null;
  if (value.includes("ANALISTA")) return "Analista";
  if (value.includes("GESTOR")) return "Gestor";
  if (value.includes("MENSAJERIA")) return "Mensajería";
  if (value.includes("SISTEMA")) return "Sistemas";
  if (value.includes("ARCHIVO")) return "Archivo";
  if (value.includes("ADMINISTRATIVO") || value.includes("ASISTENTE")) return "Administrativo";
  return null;
}

function findMatches(nombreNorm, ci, directory) {
  const ciNorm = normalizarCi(ci);
  if (ciNorm) {
    const byCi = directory.filter((u) => normalizarCi(u.ci) === ciNorm);
    if (byCi.length > 0) return byCi;
  }
  const nombre = normalizarNombre(nombreNorm);
  const exact = directory.filter((u) => normalizarNombre(u.nombre) === nombre);
  if (exact.length > 0) return exact;
  const tokens = new Set(nombre.split(" ").filter(Boolean));
  if (tokens.size === 0) return [];
  return directory.filter((u) => {
    const candidate = new Set(normalizarNombre(u.nombre).split(" ").filter(Boolean));
    const queryInside = Array.from(tokens).every((token) => candidate.has(token));
    const candidateInside = Array.from(candidate).every((token) => tokens.has(token));
    return queryInside || candidateInside;
  });
}

function rowsOf(sheet) {
  return XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null });
}

function parseListaPersonal(workbook) {
  const name = workbook.SheetNames.find((n) => n.toUpperCase().includes("ANTIGUEDAD"));
  if (!name) return [];
  const rows = rowsOf(workbook.Sheets[name]);
  const result = [];
  for (let i = 6; i < Math.min(rows.length, 60); i++) {
    const row = rows[i] || [];
    const nombre = String(row[2] || "").trim();
    const ciRaw = row[1] == null ? "" : String(row[1]).trim();
    if (!nombre || /^NOMBRE/i.test(nombre)) continue;
    if (/DIAS? H[?A]BILES/i.test(nombre) || /A[?N]OS|ADELANTE/i.test(ciRaw)) continue;
    const ci = ciRaw || null;
    const cargo = row[4] == null ? null : String(row[4]).trim();
    const fechaIngreso = excelDateToString(row[5]) || excelDateToString(row[14]);
    const dias = parseDias(row[7]);
    result.push({
      fila: i + 1,
      ci,
      nombre,
      nombreNorm: normalizarNombre(nombre),
      cargo,
      fechaIngreso,
      dias,
    });
  }
  return result;
}

function parseCronograma(workbook, gestion) {
  const sheetName = workbook.SheetNames.find(
    (n) => n.toUpperCase().includes("CRONOGRAMA") && n.includes(String(gestion))
  );
  if (!sheetName) return [];
  const ws = workbook.Sheets[sheetName];
  if (!ws["!ref"]) return [];
  const range = XLSX.utils.decode_range(ws["!ref"]);
  const merges = (ws["!merges"] || []).map((m) => ({
    s: { r: m.s.r, c: m.s.c },
    e: { r: m.e.r, c: m.e.c },
  }));

  const monthRows = [];
  for (let r = range.s.r; r <= range.e.r; r++) {
    const cell = ws[XLSX.utils.encode_cell({ r, c: 0 })];
    const value = cell ? String(cell.v || "").trim().toUpperCase() : "";
    if (MONTHS[value]) monthRows.push({ r, month: MONTHS[value] });
  }

  const segments = [];
  for (let index = 0; index < monthRows.length; index++) {
    const { r: monthRow, month } = monthRows[index];
    const endRow = index + 1 < monthRows.length ? monthRows[index + 1].r - 1 : range.e.r;
    const daysInMonth = new Date(Date.UTC(Number(gestion), month, 0)).getUTCDate();
    for (let r = monthRow + 1; r <= endRow; r++) {
      for (let c = 1; c <= 31; c++) {
        const cell = ws[XLSX.utils.encode_cell({ r, c })];
        if (!cell || typeof cell.v !== "string") continue;
        const raw = cell.v.trim();
        if (raw.length < 2) continue;
        if (MONTHS[raw.toUpperCase()] || /^OBSERVACIONES$/i.test(raw)) continue;

        const containingMerge = merges.find(
          (m) => m.s.r <= r && m.e.r >= r && m.s.c <= c && m.e.c >= c
        );
        if (containingMerge) {
          if (containingMerge.s.r !== r || containingMerge.s.c !== c) continue;
          if (containingMerge.e.r !== r) continue;
        }
        const c1 = containingMerge ? containingMerge.s.c : c;
        const c2 = containingMerge ? containingMerge.e.c : c;
        const day1 = Math.max(1, Math.min(c1, daysInMonth));
        const day2 = Math.max(day1, Math.min(c2, daysInMonth));
        const nombreRaw = cleanName(raw);
        if (!nombreRaw || nombreRaw.length < 2) continue;
        const nombreNorm = normalizarAlias(nombreRaw);
        if (!nombreNorm) continue;
        const diasLabel = extractDiasLabel(raw);
        const fechaDesde = `${gestion}-${pad2(month)}-${pad2(day1)}`;
        const fechaHasta = `${gestion}-${pad2(month)}-${pad2(day2)}`;
        segments.push({
          gestion: Number(gestion),
          nombreRaw,
          nombreNorm,
          fechaDesde,
          fechaHasta,
          diasLabel,
        });
      }
    }
  }

  const byName = new Map();
  for (const segment of segments) {
    if (!byName.has(segment.nombreNorm)) byName.set(segment.nombreNorm, []);
    byName.get(segment.nombreNorm).push(segment);
  }

  const merged = [];
  for (const [, list] of byName) {
    list.sort((a, b) => a.fechaDesde.localeCompare(b.fechaDesde));
    let current = null;
    for (const segment of list) {
      if (!current) {
        current = { ...segment };
        continue;
      }
      const gap = Math.round(
        (new Date(`${segment.fechaDesde}T00:00:00Z`) - new Date(`${current.fechaHasta}T00:00:00Z`)) /
          (24 * 60 * 60 * 1000)
      );
      const sameLabel =
        !current.diasLabel || !segment.diasLabel || current.diasLabel === segment.diasLabel;
      const sameOrNextMonth =
        segment.fechaDesde.slice(0, 7) === current.fechaDesde.slice(0, 7) ||
        segment.fechaDesde.slice(0, 7) > current.fechaDesde.slice(0, 7);
      if (gap <= 3 && sameLabel && sameOrNextMonth) {
        if (segment.fechaHasta > current.fechaHasta) current.fechaHasta = segment.fechaHasta;
        current.diasLabel = current.diasLabel ?? segment.diasLabel;
      } else {
        merged.push(current);
        current = { ...segment };
      }
    }
    if (current) merged.push(current);
  }

  return merged
    .map((segment) => {
      const calculados = core.contarDiasHabiles(segment.fechaDesde, segment.fechaHasta);
      const diasLabel = segment.diasLabel == null ? null : Number(segment.diasLabel);
      if (diasLabel != null && diasLabel > calculados + 3 && calculados <= 2) {
        const expandido = core.buildBlock(segment.fechaDesde, diasLabel);
        if (expandido) {
          return {
            gestion: segment.gestion,
            nombreRaw: segment.nombreRaw,
            nombreNorm: segment.nombreNorm,
            fechaDesde: expandido.fechaDesde,
            fechaHasta: expandido.fechaHasta,
            dias: expandido.dias,
          };
        }
      }
      const usarLabel = diasLabel != null && Math.abs(diasLabel - calculados) <= 3;
      return {
        gestion: segment.gestion,
        nombreRaw: segment.nombreRaw,
        nombreNorm: segment.nombreNorm,
        fechaDesde: segment.fechaDesde,
        fechaHasta: segment.fechaHasta,
        dias: usarLabel ? diasLabel : calculados,
      };
    })
    .filter((segment) => segment.dias > 0);
}

function elegirUsuario(matches, ci) {
  if (matches.length === 0) {
    return { usuarioId: null, nombreIntegre: null, estado: "no_encontrado", opciones: [] };
  }
  const opciones = matches.map((u) => ({
    usuarioId: u.usuarioId,
    nombre: u.nombre,
    ci: u.ci,
  }));
  if (matches.length === 1) {
    return {
      usuarioId: matches[0].usuarioId,
      nombreIntegre: matches[0].nombre,
      estado: "ok",
      opciones,
    };
  }
  const conCi = normalizarCi(ci)
    ? matches.find((u) => normalizarCi(u.ci) === normalizarCi(ci))
    : matches.find((u) => normalizarCi(u.ci));
  return {
    usuarioId: (conCi || matches[0]).usuarioId,
    nombreIntegre: (conCi || matches[0]).nombre,
    estado: "duplicado",
    opciones,
  };
}

async function previewImport(buffer) {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const directory = await getDirectorioIntegre();
  const roster = parseListaPersonal(workbook).map((row) => {
    const match = elegirUsuario(findMatches(row.nombreNorm, row.ci, directory), row.ci);
    return { ...row, categoria: mapearCategoria(row.cargo), ...match };
  });
  const planes = [];
  for (const gestion of [2025, 2026]) {
    for (const plan of parseCronograma(workbook, gestion)) {
      const match = elegirUsuario(findMatches(plan.nombreNorm, null, directory), null);
      planes.push({ ...plan, ...match });
    }
  }

  const contar = (items) => ({
    total: items.length,
    ok: items.filter((i) => i.estado === "ok").length,
    duplicados: items.filter((i) => i.estado === "duplicado").length,
    noEncontrados: items.filter((i) => i.estado === "no_encontrado").length,
  });

  return {
    archivoHash: crypto.createHash("sha256").update(buffer).digest("hex"),
    roster,
    planes,
    resumen: {
      roster: contar(roster),
      planes: contar(planes),
    },
  };
}

async function applyImport(payload, userId, archivoHash = null) {
  const roster = Array.isArray(payload.roster) ? payload.roster : [];
  const planes = Array.isArray(payload.planes) ? payload.planes : [];
  let rosterCreados = 0;
  let rosterActualizados = 0;
  let planesCreados = 0;
  let planesOmitidos = 0;
  const errores = [];

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const row of roster) {
      const usuarioId = Number(row.usuarioId);
      if (!Number.isInteger(usuarioId) || usuarioId <= 0) {
        errores.push(`Roster sin usuario: ${row.nombre || row.fila}`);
        continue;
      }
      const exists = await client.query(
        "SELECT 1 FROM core.vac_funcionarios WHERE usuario_id = $1",
        [usuarioId]
      );
      await client.query(
        `INSERT INTO core.vac_funcionarios
           (usuario_id, incluido, fecha_ingreso, categoria, notas, updated_by, updated_at)
         VALUES ($1, TRUE, $2, $3, $4, $5, NOW())
         ON CONFLICT (usuario_id) DO UPDATE SET
           incluido = TRUE,
           fecha_ingreso = COALESCE(EXCLUDED.fecha_ingreso, core.vac_funcionarios.fecha_ingreso),
           categoria = COALESCE(EXCLUDED.categoria, core.vac_funcionarios.categoria),
           updated_by = EXCLUDED.updated_by,
           updated_at = NOW()`,
        [
          usuarioId,
          row.fechaIngreso || null,
          mapearCategoria(row.cargo),
          "Importado desde Excel",
          userId || null,
        ]
      );
      if (exists.rows.length) rosterActualizados++;
      else rosterCreados++;
    }

    for (const row of planes) {
      const usuarioId = Number(row.usuarioId);
      const gestion = Number(row.gestion);
      if (!Number.isInteger(usuarioId) || usuarioId <= 0 || !Number.isInteger(gestion)) {
        errores.push(`Plan sin usuario o gestión: ${row.nombreRaw || row.nombreNorm}`);
        continue;
      }
      const fechaDesde = core.formatDate(row.fechaDesde);
      const fechaHasta = core.formatDate(row.fechaHasta);
      const dias = Number.isFinite(Number(row.dias))
        ? Number(row.dias)
        : core.contarDiasHabiles(fechaDesde, fechaHasta);
      const exists = await client.query(
        `SELECT 1 FROM core.vac_planes
          WHERE usuario_id = $1 AND gestion = $2 AND fecha_desde = $3
            AND fecha_hasta = $4 AND origen = 'importado'`,
        [usuarioId, gestion, fechaDesde, fechaHasta]
      );
      if (exists.rows.length) {
        planesOmitidos++;
        continue;
      }
      await client.query(
        `INSERT INTO core.vac_planes
           (usuario_id, gestion, fecha_desde, fecha_hasta, dias_planificados, origen, notas, created_by, updated_at)
         VALUES ($1, $2, $3, $4, $5, 'importado', $6, $7, NOW())`,
        [usuarioId, gestion, fechaDesde, fechaHasta, dias, "Importado desde Excel", userId || null]
      );
      planesCreados++;
    }

    await client.query(
      `INSERT INTO core.vac_import_log (archivo_hash, entidad, clave, accion)
       VALUES ($1, 'excel', $2, 'apply')`,
      [archivoHash, `${roster.length}|${planes.length}`]
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  return {
    rosterCreados,
    rosterActualizados,
    planesCreados,
    planesOmitidos,
    errores,
  };
}

module.exports = {
  applyImport,
  excelDateToString,
  extractDiasLabel,
  findMatches,
  mapearCategoria,
  normalizarAlias,
  normalizarCi,
  normalizarNombre,
  parseCronograma,
  parseListaPersonal,
  previewImport,
};
