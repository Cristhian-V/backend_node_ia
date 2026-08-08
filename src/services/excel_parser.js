/**
 * Excel parser: extrae operacion e items de archivos Excel de Finning.
 * Portado de carga-tool/src/parser.js + calculator.js
 */

function readExcel(buffer, sheetName) {
  const XLSX = require("xlsx");
  const wb = XLSX.read(buffer, { type: "buffer" });
  const ws = wb.Sheets[sheetName];
  if (!ws) throw new Error(`Hoja "${sheetName}" no encontrada en el Excel`);
  const range = XLSX.utils.decode_range(ws["!ref"] || "A1");
  const rows = [];
  for (let r = range.s.r; r <= range.e.r; r++) {
    const row = [];
    for (let c = range.s.c; c <= range.e.c; c++) {
      const cell = ws[XLSX.utils.encode_cell({ r, c })];
      row.push(cell ? String(cell.v ?? "").trim() : "");
    }
    rows.push(row);
  }
  return rows;
}

function parseDecimal(value, defaultVal = 0) {
  if (!value && value !== 0) return defaultVal;
  if (typeof value === "number") return value;
  return parseFloat(String(value).replace(/,/g, "")) || defaultVal;
}

function validateHDAV(hdav) {
  const errors = [];
  if (hdav.length < 6) errors.push("HDAV: Menos de 6 filas");
  for (let i = 1; i <= 5; i++) {
    if (!hdav[i] || hdav[i].length < 99) errors.push(`HDAV: Fila ${i + 1} no tiene 99+ columnas (tiene ${hdav[i] ? hdav[i].length : 0})`);
  }
  return errors;
}

let kitOffset = 0;

function detectKitLayout(hdav) {
  if (hdav.length >= 7 && hdav[6] && hdav[6][88] && String(hdav[6][88]).trim().toUpperCase() !== "PESO BRUTO" &&
      hdav[6] && hdav[6][87] && String(hdav[6][87]).trim().toUpperCase().includes("KIT")) {
    kitOffset = 1;
  } else {
    kitOffset = 0;
  }
}

function extractOperacion(hdav, items, user) {
  const C1 = 93 + kitOffset, C2 = 96 + kitOffset, C3 = 98 + kitOffset;

  const trunc = (val, len) => val ? String(val).slice(0, len) : val;

  const op = {
    NroRegistro: trunc((hdav[5] && hdav[5][C1]) || "", 18),
    Recinto: ((hdav[2] && hdav[2][C1]) || "").match(/\d+/)?.[0] || (hdav[2] && hdav[2][C1]) || "",
    RecintoOriginal: (hdav[2] && hdav[2][C1]) || "",
    Patron: trunc(((hdav[1] && hdav[1][C1]) || "") + ((hdav[1] && hdav[1][C1 + 1]) || ""), 50),
    Embalaje: trunc((hdav[3] && hdav[3][C1]) || "", 50),
    Regimen: trunc(((hdav[4] && hdav[4][C1]) || "") + ((hdav[4] && hdav[4][C1 + 1]) || ""), 50),
    EstadoMercancia: trunc((hdav[1] && hdav[1][C2]) || "", 50),
    DocEmbarque: trunc((hdav[2] && hdav[2][C2]) || "", 50),
    NITImportador: trunc((hdav[3] && hdav[3][C2]) || "", 20),
    ReferenciaInt: trunc((hdav[4] && hdav[4][C2]) || "", 50),
    Proveedor: trunc((hdav[5] && hdav[5][C2]) || "", 120),
    Contenedor: trunc((hdav[1] && hdav[1][C3]) || "", 50),
    IdConten1: trunc((hdav[2] && hdav[2][C3]) || "", 50),
    IdConten2: trunc((hdav[3] && hdav[3][C3]) || "", 50),
    IdConten3: trunc((hdav[4] && hdav[4][C3]) || "", 50),
    MercanciaPeligrosa: trunc((hdav[5] && hdav[5][C3]) || "", 50),
    Incoterm: trunc((hdav[5] && hdav[5][14]) || "", 25),
    Tramite: trunc("00000/" + new Date().getFullYear().toString().slice(2), 24),
    MonedaId: (items[1] && items[1][7]) || "",
    FOB: parseDecimal((items[2] && items[2][7]) || ""),
    Flete: parseDecimal((items[3] && items[3][7]) || ""),
    Flete2: parseDecimal((items[4] && items[4][7]) || ""),
    Seguro: parseDecimal((items[5] && items[5][7]) || ""),
    OtroGastos: parseDecimal((items[6] && items[6][7]) || ""),
    OtrasErogaciones: parseDecimal((items[7] && items[7][7]) || ""),
    ValorCIF: parseDecimal((items[8] && items[8][7]) || ""),
    TC: parseDecimal((items[2] && items[2][10]) || ""),
    PesoBruto: parseDecimal((items[3] && items[3][10]) || ""),
    PesoNeto: parseDecimal((items[4] && items[4][10]) || ""),
    Bultos: parseDecimal((items[5] && items[5][10]) || ""),
    ImpSIDUNEA: parseDecimal((items[6] && items[6][10]) || ""),
    FechaValidacion: null,
    FechaPago: null,
    FechaSalidadeMercancia: null,
    Canal: null,
    BrokerId: null,
    ImporterId: null,
    ExporterId: null,
    ManufacturerId: null,
  };

  op.ValorCIFBS = Math.round((op.ValorCIF || 0) * (op.TC || 0) * 100) / 100;

  return op;
}

function mtdGetCode(partNumber, cantidad, pDR, pDRPivote) {
  let clean = partNumber.toUpperCase().replace(/PN:/g, "").replace(/-/g, "").trim();
  let isZero = false;
  if (/^0/.test(clean)) {
    isZero = true;
    const intVal = parseInt(clean, 10);
    if (!isNaN(intVal) && intVal > 0) clean = String(intVal);
  }

  let result = null;
  for (const p of pDRPivote) {
    if ((p.prdDesc === clean || removeLeadingZeros(p.prdDesc) === clean) && p.prdCandidad >= cantidad) {
      p.prdCandidad -= cantidad;
      result = p;
      break;
    }
  }

  if (!result) {
    const withQty = pDRPivote.find(p => p.prdCandidad > 0 && p.prdDesc === clean);
    if (withQty) result = withQty;
    else {
      const inDR = pDR.find(p => p.prdDesc === clean);
      if (inDR) result = inDR;
    }
  }

  if (isZero && result && !result.prdNombre.includes("-")) result.prdNombre = partNumber;
  return result;
}

function removeLeadingZeros(value) {
  return String(value || "").replace(/^0+/, "");
}

function extractItems(itemsSheet, datosSheet, partidas, agrupar = true) {
  const pDR = [];
  const pDRPivote = [];

  for (let j = 1; j < datosSheet.length; j++) {
    const row = datosSheet[j];
    if (!row || row.length < 6 || !row[2] || !row[2].trim()) continue;
    const desc = row[2].replace(/\.000/g, "").replace(/-/g, "").trim();
    const descSplit = desc.split(".");
    const parte = {
      prdId: row[0] || "",
      prdDesc: desc,
      prdDescripcion: row[3] || "",
      prdCandidad: parseDecimal(row[5]),
      prdNombre: descSplit[0] || "",
      prdExtension: descSplit.length > 1 ? descSplit[1] : "000",
    };
    pDR.push(parte);
    pDRPivote.push({ ...parte });
  }
  pDRPivote.sort((a, b) => a.prdCandidad - b.prdCandidad);

  const result = [];
  let nroItem = 0;

  for (let i = 13; i < itemsSheet.length; i++) {
    const row = itemsSheet[i];
    if (!row || row.length <= 5 || !row[3] || !row[3].trim()) continue;

    const codArrancel = row[3].trim();
    const partida = Object.values(partidas).find(p => String(p.prdId) === codArrancel);
    if (!partida) throw new Error(`No se encontro la partida: ${codArrancel}`);

    const partNumber = (row[30] || "").toUpperCase().replace(/PN:/g, "").replace(/-/g, "").trim();
    const cantidad = parseDecimal(row[12]);
    const parte = mtdGetCode(partNumber, cantidad, pDR, pDRPivote);
    if (!parte) throw new Error(`No se encontro el PartNumber: ${partNumber}`);

    nroItem++;
    const item = {
      NroItem: nroItem,
      ItemId: nroItem,
      CodArrancel: codArrancel,
      FOB: Math.round(parseDecimal(row[5]) * 100) / 100,
      Flete: Math.round(parseDecimal(row[6]) * 100) / 100,
      Flete2: Math.round(parseDecimal(row[7]) * 100) / 100,
      Seguro: Math.round(parseDecimal(row[8]) * 100) / 100,
      OtrosGastos: Math.round(parseDecimal(row[9]) * 100) / 100,
      PesoBruto: Math.round(parseDecimal(row[10]) * 100) / 100,
      PesoNeto: Math.round(parseDecimal(row[11]) * 100) / 100,
      Cantidad: Math.round(parseDecimal(row[12]) * 100) / 100,
      Bultos: Math.round(parseDecimal(row[13]) * 100) / 100,
      CantidadSegPart: Math.round(parseDecimal(row[12]) * 100) / 100,
      UnidadMedida: row[15] || partida.UnidadMedida || "UN",
      CIFBS: Math.round(parseDecimal(row[17]) * 100) / 100,
      Acuerdo: Math.round(parseDecimal(row[18] || "0") * 100) / 100,
      GA: Math.round(parseDecimal(row[19]) * 100) / 100,
      OtrasErogaciones: Math.round(parseDecimal(row[20] || "0") * 100) / 100,
      BaseImponible: Math.round(parseDecimal(row[21]) * 100) / 100,
      IVA: Math.round(parseDecimal(row[22]) * 100) / 100,
      ICE: Math.round(parseDecimal(row[23] || "0") * 100) / 100,
      CantLT: Math.round(parseDecimal(row[24] || "0") * 100) / 100,
      ICE_ALI: Math.round(parseDecimal(row[25] || "0") * 100) / 100,
      IEHD: Math.round(parseDecimal(row[26] || "0") * 100) / 100,
      SIDUNEA: Math.round(parseDecimal(row[27]) * 100) / 100,
      TotalTributos: Math.round(parseDecimal(row[28]) * 100) / 100,
      PartNumber: parte.prdNombre + "." + parte.prdExtension,
      ProductoCode: parseInt(parte.prdId, 10) || 0,
      ProductoDescripcion: parte.prdDescripcion || "",
      Descripcion: partida.prdDesc || "",
      Activo: true,
    };
    // CIFUSD = FOB + Flete1 + Seguro + OtrosGastos
    item.CIFUSD = Math.round(((item.FOB || 0) + (item.Flete || 0) + (item.Seguro || 0) + (item.OtrosGastos || 0)) * 100) / 100;
    result.push(item);
  }

  if (agrupar) {
    const grouped = [];
    let gi = 0;
    const sumFields = ["FOB", "Flete", "Flete2", "Seguro", "OtrosGastos", "PesoBruto", "PesoNeto",
      "Cantidad", "Bultos", "CantidadSegPart", "CIFUSD", "CIFBS", "Acuerdo", "GA",
      "OtrasErogaciones", "BaseImponible", "IVA", "ICE", "CantLT", "ICE_ALI", "IEHD",
      "SIDUNEA", "TotalTributos"];
    for (const it of result) {
      const existing = grouped.find(g => g.ProductoCode === it.ProductoCode && g.ItemId < it.ItemId);
      if (existing) {
        for (const f of sumFields) {
          const v = parseDecimal(it[f], 0);
          existing[f] = Math.round(((existing[f] || 0) + v) * 100) / 100;
        }
      } else {
        gi++;
        it.NroItem = gi;
        it.ItemId = gi;
        grouped.push(it);
      }
    }
    return grouped;
  }

  return result;
}

/**
 * mtdCalculo — Prorrateo + calculo tributario + ajuste de redondeo
 * 
 * Flujo:
 *  1. Prorratea cada costo de la operacion a los items (por % FOB)
 *  2. Calcula CIFUSD, CIFBS, GA, BaseImponible, IVA, TotalTributos por item
 *  3. Llama a mtdAjuste para distribuir diferencias de redondeo al ultimo item
 * 
 * @param {object} op    — operacion con campos FOB, Flete, Seguro, TC, etc.
 * @param {array}  items — items con FOB y Acuerdo (del Excel)
 * @param {number} pIVA  — porcentaje de IVA (default 14.94)
 * @returns {object} calc — sumas acumuladas de todos los campos
 */
function mtdCalculo(op, items, pIVA = 14.94) {
  const calc = {
    FOB: 0, Flete: 0, Flete2: 0, Seguro: 0, OtrosGastos: 0,
    OtrasErogaciones: 0, PesoBruto: 0, PesoNeto: 0, Bultos: 0,
    CIFBS: 0, CIFUSD: 0, SIDUNEA: 0, GA: 0, IVA: 0,
    ICE: 0, ICE_ALI: 0, CantLT: 0, IEHD: 0, TotalTributos: 0,
    BaseImponible: 0, Cantidad: 0,
  };

  const count = items.length;
  op.Cantidad = count;
  op.ValorCIFBS = Math.round((op.ValorCIF || 0) * (op.TC || 0) * 100) / 100;

  for (const item of items) {
    const ratio = op.FOB > 0 ? item.FOB / op.FOB : 0;
    const m100 = (v) => Math.trunc(v * 100) / 100;
    const d01 = 0.01;

    item.Flete = m100(ratio * (op.Flete || 0));
    item.Flete2 = m100(ratio * (op.Flete2 || 0));
    item.Seguro = m100(ratio * (op.Seguro || 0));
    item.OtroGastos = m100(ratio * (op.OtroGastos || 0));
    item.PesoBruto = m100(ratio * (op.PesoBruto || 0));
    item.PesoNeto = m100(ratio * (op.PesoNeto || 0));
    item.Bultos = m100(ratio * (op.Bultos || 0));
    item.OtrasErogaciones = m100(ratio * (op.OtrasErogaciones || 0));

    if (op.Flete > 0 && item.Flete === 0) item.Flete = d01;
    if (op.Flete2 > 0 && item.Flete2 === 0) item.Flete2 = d01;
    if (op.Seguro > 0 && item.Seguro === 0) item.Seguro = d01;
    if (op.OtroGastos > 0 && item.OtroGastos === 0) item.OtroGastos = d01;
    if (op.PesoBruto > 0 && item.PesoBruto === 0) item.PesoBruto = d01;
    if (op.PesoNeto > 0 && item.PesoNeto === 0) item.PesoNeto = d01;
    if (op.Bultos > 0 && item.Bultos === 0) item.Bultos = d01;
    if (op.OtrasErogaciones > 0 && item.OtrasErogaciones === 0) item.OtrasErogaciones = d01;

    item.CIFUSD = item.FOB + item.Flete + item.Seguro + item.OtroGastos;
    item.CIFUSD = Math.round(item.CIFUSD * 100) / 100;
    item.CIFBS = Math.round(item.CIFUSD * (op.TC || 0) * 100) / 100;
    item.CantidadSegPart = item.UnidadMedida === "UN" ? item.Cantidad : item.PesoNeto;
    item.SIDUNEA = m100((op.ImpSIDUNEA || 0) / count);

    if (!item.CodArrancel) {
      item.GA = d01;
      item.BaseImponible = 0;
      item.IVA = 0;
      item.TotalTributos = 0;
    } else {
      item.GA = Math.round((item.Acuerdo || 0) * item.CIFBS);
      if (item.GA === 0) item.GA = d01;
      item.BaseImponible = Math.round(item.GA + item.CIFBS + item.OtrasErogaciones);
      item.IVA = Math.round(item.BaseImponible * pIVA / 100);
      item.TotalTributos = item.GA + item.IVA + (item.ICE || 0) + (item.ICE_ALI || 0) + (item.IEHD || 0) + (item.SIDUNEA || 0);
    }

    calc.FOB += item.FOB;
    calc.Flete += item.Flete;
    calc.Flete2 += item.Flete2;
    calc.Seguro += item.Seguro;
    calc.OtroGastos += item.OtroGastos;
    calc.OtrasErogaciones += item.OtrasErogaciones;
    calc.PesoBruto += item.PesoBruto;
    calc.PesoNeto += item.PesoNeto;
    calc.Bultos += item.Bultos;
    calc.CIFUSD += item.CIFUSD;
    calc.CIFBS += item.CIFBS;
    calc.SIDUNEA += item.SIDUNEA;
    calc.GA += item.GA;
    calc.IVA += item.IVA;
    calc.ICE += (item.ICE || 0);
    calc.ICE_ALI += (item.ICE_ALI || 0);
    calc.CantLT += (item.CantLT || 0);
    calc.IEHD += (item.IEHD || 0);
    calc.BaseImponible += item.BaseImponible || 0;
    calc.Cantidad += item.Cantidad || 0;
  }

  calc.TotalTributos = Math.round(calc.GA + calc.IVA + calc.ICE + calc.ICE_ALI + calc.IEHD + calc.SIDUNEA);

  mtdAjuste(op, items, calc);

  op.GA = calc.GA;
  op.IVA = calc.IVA;
  op.ImpuestoGA = calc.GA;
  op.ImpuestoIVA = calc.IVA;

  return calc;
}

/**
 * mtdAjuste — Distribuye diferencias de redondeo al ultimo item
 * 
 * El prorrateo trunca valores a 2 decimales, por lo que la suma de items
 * no coincide exactamente con el total de la operacion.
 * 
 * Para cada campo (FOB, Flete, Seguro, etc.):
 *   - Suma la diferencia (op.total - calc.total) al ULTIMO item
 * 
 * Para GA:
 *   - Si sobra: suma al ultimo item con GA > 0.01
 *   - Si falta: descuenta progresivamente desde el ultimo hacia atras
 * 
 * Para IVA:
 *   - Misma logica que GA: suma al ultimo o descuenta progresivamente
 */
function mtdAjuste(op, items, calc) {
  const last = items[items.length - 1];
  if (!last) return;

  last.FOB += (op.FOB || 0) - calc.FOB;
  last.Flete += (op.Flete || 0) - calc.Flete;
  last.Flete2 += (op.Flete2 || 0) - calc.Flete2;
  last.Seguro += (op.Seguro || 0) - calc.Seguro;
  last.PesoBruto += (op.PesoBruto || 0) - calc.PesoBruto;
  last.OtrosGastos += (op.OtroGastos || 0) - calc.OtrosGastos;
  last.PesoNeto += (op.PesoNeto || 0) - calc.PesoNeto;
  last.Bultos += (op.Bultos || 0) - calc.Bultos;
  last.CIFBS += (op.ValorCIFBS || 0) - calc.CIFBS;
  last.CIFUSD += (op.ValorCIF || 0) - calc.CIFUSD;
  last.OtrasErogaciones += (op.OtrasErogaciones || 0) - calc.OtrasErogaciones;
  last.SIDUNEA += (op.ImpSIDUNEA || 0) - calc.SIDUNEA;

  if ((op.GA || 0) > 0 && op.GA !== calc.GA) {
    let liLastGA = items.length - 1;
    while (liLastGA > 0 && items[liLastGA].GA === 0.01) liLastGA--;

    if (op.GA > calc.GA) {
      items[liLastGA].GA += (op.GA - calc.GA);
    } else {
      let luDiferencia = calc.GA - op.GA;
      if (items[liLastGA].GA > luDiferencia) {
        items[liLastGA].GA -= luDiferencia;
      } else {
        let liJ = 0;
        while (luDiferencia > 0 && liJ < items.length - 1) {
          luDiferencia = luDiferencia - items[liLastGA - liJ].GA + 0;
          items[liLastGA - liJ].GA = 0;
          liJ++;
        }
      }
    }
  }

  if ((op.IVA || 0) > 0 && op.IVA !== calc.IVA) {
    if (op.IVA > calc.IVA) {
      last.IVA += (op.IVA - calc.IVA);
    } else {
      let luDiferencia = calc.IVA - op.IVA;
      if (last.IVA > luDiferencia) {
        last.IVA -= luDiferencia;
      } else {
        let liJ = 0;
        while (luDiferencia > 0 && liJ < items.length - 1) {
          luDiferencia = luDiferencia - items[items.length - 1 - liJ].IVA + 1;
          items[items.length - 1 - liJ].IVA = 1;
          liJ++;
        }
      }
    }
  }
}

module.exports = {
  readExcel,
  validateHDAV,
  detectKitLayout,
  extractOperacion,
  extractItems,
  mtdCalculo,
  parseDecimal,
};
