const XLSX = require("xlsx");
const path = require("path");
const pool = require("../db");

const ARANCEL_PATH = path.join(__dirname, "..", "..", "data", "Arancel 2026 - GA reducido.xlsx");

function parseNum(val) {
  if (val == null || val === "") return null;
  const n = Number(val);
  return isNaN(n) ? null : n;
}

async function seedArancel() {
  try {
    const count = await pool.query("SELECT COUNT(*) FROM core.arancel_nacional");
    if (parseInt(count.rows[0].count) > 0) {
      console.log("  [Arancel] Ya tiene datos, saltando seed");
      return;
    }
  } catch (err) {
    console.error("  [Arancel] Error verificando tabla:", err.message);
    return;
  }

  try {
    const wb = XLSX.readFile(ARANCEL_PATH);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });
    if (rows.length < 2) {
      console.log("  [Arancel] Excel vacio, saltando seed");
      return;
    }

    let inserted = 0;
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      const codigo = String(row[0] || "").trim();
      if (!codigo || codigo.length < 4) continue;

      const descripcion = String(row[1] || "").trim();
      if (!descripcion) continue;

      const prefijo6 = codigo.substring(0, 6);
      const gaPorcentaje = parseNum(row[2]);
      const gaDecimal = parseNum(row[3]);
      const gaReducido = parseNum(row[15]);
      const iva = parseNum(row[14]) || 14.94;
      const iceIehd = row[4] ? String(row[4]).trim() : null;
      const unidadMedida = row[5] ? String(row[5]).trim() : null;
      const tipoDoc = row[7] ? String(row[7]).trim() : null;
      const entidadEmite = row[8] ? String(row[8]).trim() : null;
      const dispLegal = row[9] ? String(row[9]).trim() : null;

      try {
        await pool.query(
          `INSERT INTO core.arancel_nacional
             (codigo, prefijo6, descripcion, ga_porcentaje, ga_decimal, ga_reducido, iva, ice_iehd, unidad_medida, tipo_doc, entidad_emite, disp_legal)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
           ON CONFLICT (codigo) DO NOTHING`,
          [codigo, prefijo6, descripcion, gaPorcentaje, gaDecimal, gaReducido, iva, iceIehd, unidadMedida, tipoDoc, entidadEmite, dispLegal]
        );
        inserted++;
      } catch (e) {
        console.error(`  [Arancel] Error insertando ${codigo}:`, e.message);
      }
    }

    console.log(`  [Arancel] Seed completado: ${inserted} registros`);
  } catch (err) {
    console.error("  [Arancel] Error leyendo Excel:", err.message);
  }
}

module.exports = { seedArancel };
