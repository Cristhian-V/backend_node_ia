const XLSX = require("xlsx");
const path = require("path");
const pool = require("../db");
const { normArancel } = require("./arancel_utils");

const ARANCEL_PATH = path.join(__dirname, "..", "..", "..", "referencias", "Arancel 2026 - GA reducido.xlsx");

function parseNum(val) {
  if (val == null || val === "") return null;
  const n = Number(val);
  return isNaN(n) ? null : n;
}

function str(val) {
  if (val == null) return null;
  const s = String(val).trim();
  return s === "" ? null : s;
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
      const codigoRaw = String(row[0] || "").trim();
      if (!codigoRaw || codigoRaw.length < 4) continue;

      const descripcion = String(row[1] || "").trim();
      if (!descripcion) continue;

      const codigo = normArancel(codigoRaw);
      const prefijo6 = codigo.substring(0, 6);
      const gaPorcentaje = parseNum(row[2]);
      const gaDecimal = parseNum(row[3]);
      const gaReducido = parseNum(row[15]);
      const iva = parseNum(row[14]) || 14.94;
      const iceIehd = str(row[4]);
      const unidadMedida = str(row[5]);
      const despachoFrontera = str(row[6]);
      const tipoDoc = str(row[7]);
      const entidadEmite = str(row[8]);
      const dispLegal = str(row[9]);
      const canAce36_47 = str(row[10]);
      const chi = str(row[11]);
      const prot = str(row[12]);
      const ace66Mexico = str(row[13]);

      try {
        await pool.query(
          `INSERT INTO core.arancel_nacional
             (codigo, prefijo6, descripcion, ga_porcentaje, ga_decimal, ga_reducido, iva, ice_iehd, unidad_medida, tipo_doc, entidad_emite, disp_legal, despacho_frontera, can_ace36_47, chi, prot, ace66_mexico)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
           ON CONFLICT (codigo) DO NOTHING`,
          [codigo, prefijo6, descripcion, gaPorcentaje, gaDecimal, gaReducido, iva, iceIehd, unidadMedida, tipoDoc, entidadEmite, dispLegal, despachoFrontera, canAce36_47, chi, prot, ace66Mexico]
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
