const { normArancel } = require("./arancel_utils");

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function toDateStr(value) {
  if (value == null || value === "") return null;
  if (value instanceof Date) {
    if (isNaN(value.getTime())) return null;
    return value.toISOString().slice(0, 10);
  }
  const text = String(value).trim();
  if (!text) return null;
  if (DATE_RE.test(text)) return text;
  const parsed = new Date(text);
  if (isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function resolverFechaReferencia(op = {}) {
  for (const field of ["FechaValidacion", "FechaPago", "FechaReg"]) {
    const value = toDateStr(op[field]);
    if (value) return value;
  }
  return toDateStr(new Date());
}

async function resolverPartidasExentas(client, fechaRef) {
  const { rows } = await client.query(
    `SELECT p.partida_arancel, e.id AS exencion_id, e.decreto
       FROM core.fnning_iva_exencion e
       JOIN core.fnning_iva_exencion_partida p ON p.exencion_id = e.id
      WHERE e.activo
        AND e.vigente_desde <= $1::date
        AND (e.vigente_hasta IS NULL OR e.vigente_hasta >= $1::date)
      ORDER BY e.vigente_desde DESC, e.id DESC`,
    [fechaRef]
  );

  const partidas = new Map();
  for (const row of rows) {
    const partida = normArancel(row.partida_arancel);
    if (!partida || partidas.has(partida)) continue;
    partidas.set(partida, {
      exencionId: row.exencion_id,
      decreto: row.decreto,
    });
  }
  return partidas;
}

function extraerPartidasDeFilas(rows) {
  const partidas = new Set();
  let invalidas = 0;

  for (const row of rows || []) {
    if (!Array.isArray(row)) continue;
    for (const cell of row) {
      if (cell == null || cell === "" || typeof cell === "boolean") continue;

      if (typeof cell === "number") {
        if (!Number.isInteger(cell) || cell < 0) continue;
        const digits = String(cell);
        if (digits.length === 10) partidas.add(digits);
        else if (digits.length >= 4 && digits.length < 10) partidas.add(digits.padStart(10, "0"));
        else if (digits.length > 10) invalidas++;
        continue;
      }

      const text = String(cell).trim().replace(/^['"]+|['"]+$/g, "");
      if (!text) continue;
      if (!/^[\d.\-\s/]+$/.test(text)) continue;

      const digits = text.replace(/\D/g, "");
      if (digits.length === 10) partidas.add(digits);
      else if (digits.length >= 4) invalidas++;
    }
  }

  return { partidas: [...partidas].sort(), invalidas };
}

async function getSnapshot(client, operacionId) {
  const { rows } = await client.query(
    `SELECT nro_item, partida_arancel, exencion_id, decreto, fecha_referencia
       FROM core.fnning_iva_exencion_aplicada
      WHERE operacion_id = $1`,
    [operacionId]
  );

  const snapshot = new Map();
  for (const row of rows) {
    snapshot.set(Number(row.nro_item), {
      partida: normArancel(row.partida_arancel),
      exencionId: row.exencion_id,
      decreto: row.decreto,
      fechaReferencia: toDateStr(row.fecha_referencia),
    });
  }
  return snapshot;
}

async function saveSnapshot(client, operacionId, filas) {
  await client.query(
    "DELETE FROM core.fnning_iva_exencion_aplicada WHERE operacion_id = $1",
    [operacionId]
  );
  if (!filas || filas.length === 0) return 0;

  const operacionIds = filas.map(() => operacionId);
  const nroItems = filas.map((f) => f.nro_item);
  const partidas = filas.map((f) => f.partida_arancel);
  const exencionIds = filas.map((f) => f.exencion_id ?? null);
  const decretos = filas.map((f) => f.decreto);
  const fechas = filas.map((f) => f.fecha_referencia);

  await client.query(
    `INSERT INTO core.fnning_iva_exencion_aplicada
       (operacion_id, nro_item, partida_arancel, exencion_id, decreto, fecha_referencia)
     SELECT * FROM unnest(
       $1::int[], $2::int[], $3::varchar[], $4::int[], $5::varchar[], $6::date[]
     )`,
    [operacionIds, nroItems, partidas, exencionIds, decretos, fechas]
  );
  return filas.length;
}

function resolverExencionItem(item, partidasExentas, snapshotMap) {
  const partida = normArancel(item.CodArrancel);
  if (!partida) return null;

  const nroItem = Number(item.NroItem);
  const snap = Number.isFinite(nroItem) && snapshotMap ? snapshotMap.get(nroItem) : null;
  if (snap && snap.partida === partida) {
    return {
      exencionId: snap.exencionId,
      decreto: snap.decreto,
      fechaReferencia: snap.fechaReferencia,
      origen: "snapshot",
    };
  }

  const vigente = partidasExentas ? partidasExentas.get(partida) : null;
  if (vigente) {
    return {
      exencionId: vigente.exencionId,
      decreto: vigente.decreto,
      fechaReferencia: null,
      origen: "decreto",
    };
  }

  return null;
}

function aplicarExenciones(items, partidasExentas, snapshotMap, fechaRef) {
  const aplicadas = [];
  let huboExencion = false;

  (items || []).forEach((item, index) => {
    const exencion = resolverExencionItem(item, partidasExentas, snapshotMap);
    if (!exencion) return;

    huboExencion = true;
    item.IVA = 0;
    const total =
      (Number(item.GA) || 0) +
      (Number(item.ICE) || 0) +
      (Number(item.ICE_ALI) || 0) +
      (Number(item.IEHD) || 0) +
      (Number(item.SIDUNEA) || 0);
    item.TotalTributos = Math.round(total * 100) / 100;

    aplicadas.push({
      nro_item: Number(item.NroItem) || index + 1,
      partida_arancel: normArancel(item.CodArrancel),
      exencion_id: exencion.exencionId ?? null,
      decreto: exencion.decreto,
      fecha_referencia: exencion.fechaReferencia || fechaRef,
    });
  });

  return { aplicadas, huboExencion, items };
}

module.exports = {
  toDateStr,
  resolverFechaReferencia,
  resolverPartidasExentas,
  extraerPartidasDeFilas,
  getSnapshot,
  saveSnapshot,
  resolverExencionItem,
  aplicarExenciones,
};
