/**
 * Generador de la declaración XML de una operación Finning (Broker2Softway).
 * Funcion pura: recibe la operacion, sus items, las entidades resueltas y la
 * descripcion del recinto, y devuelve el XML como string.
 */

function buildDeclaracionXml({ op, items, entidades = {}, recintoDesc = "" }) {
  const esc = (v) => String(v || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const d2 = (v) => (v != null ? Number(v).toFixed(2) : "0.00");
  const di = (v) => (v != null ? String(Math.round(Number(v))) : "0");
  const dt = (v) => v ? new Date(v).toISOString().slice(0, 10) + "T00:00:00" : "";

  const recintoNum = String(op.Recinto || "").match(/\d+/)?.[0] || "";

  const tramiteParts = (op.Tramite || "00000/00").split("/");
  const year = tramiteParts[1] || String(new Date().getFullYear()).slice(2);

  // Tributos del encabezado derivados de los valores que se emiten por item,
  // con el mismo redondeo que usa cada nivel (GA/IVA enteros, SIDUNEA/IHD con 2 decimales).
  const sumDuties = (predicate, formatter) =>
    items
      .filter((it) => predicate(it))
      .reduce((sum, it) => sum + Number(formatter(it)), 0);

  const hasItemGA = items.some((it) => it.GA != null);
  const sumGA = sumDuties((it) => it.GA != null, (it) => di(it.GA));
  const sumIVA = sumDuties((it) => Number(it.IVA) > 0, (it) => di(it.IVA));
  const sumSIDUNEA = sumDuties((it) => Number(it.SIDUNEA) > 0, (it) => d2(it.SIDUNEA));
  const sumIEHD = sumDuties((it) => Number(it.IEHD) > 0, (it) => d2(it.IEHD));

  // GA siempre en el encabezado. Si ningun item declara GA (dato legado),
  // se usa Operacion.GA como respaldo para no subdeclarar.
  const declGA = hasItemGA ? sumGA : Math.round(Number(op.GA) || 0);

  let xml = `<?xml version="1.0" encoding="iso-8859-1"?>\n`;
  xml += `<Broker2Softway xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\n`;
  xml += `  <importDeclaration>\n`;
  xml += `    <declarationNumber>20${year}${recintoNum}${esc(op.NroRegistro)}</declarationNumber>\n`;
  xml += `    <declarationType>${esc(op.Patron)}</declarationType>\n`;
  xml += `    <declarationCustomsHouse>${recintoNum} - ${recintoNum} - ${esc(recintoDesc)}</declarationCustomsHouse>\n`;
  xml += `    <declarationProcessReferenceCode>${esc(op.Tramite)}</declarationProcessReferenceCode>\n`;
  xml += `    <declarationBrokerReferenceCode>${esc(op.Tramite)}</declarationBrokerReferenceCode>\n`;

  for (const [et, edt] of [["Validacion", "FechaValidacion"], ["Pago", "FechaPago"], ["Salida de Mercancia", "FechaSalidadeMercancia"]]) {
    xml += `    <declarationEvent>\n      <eventType>${et}</eventType>\n      <eventDateTime>${dt(op[edt])}</eventDateTime>\n    </declarationEvent>\n`;
  }

  xml += `    <declarationChannel>${esc((op.Canal || "").toUpperCase())}</declarationChannel>\n`;

  // Broker + Importer entity blocks
  for (const [tp, fk] of [["Broker", "BrokerId"], ["Importer", "ImporterId"]]) {
    const e = entidades[fk];
    if (e) {
      xml += `    <declarationEntity>\n`;
      xml += `      <entityType>${tp}</entityType>\n`;
      xml += `      <entityReferenceCode>${esc(e.Nit)}</entityReferenceCode>\n`;
      xml += `      <entityName>${esc(e.Nombre)}</entityName>\n`;
      xml += `      <entityCountry>${esc(e.Pais)}</entityCountry>\n`;
      xml += `      <entityAddress>${esc(e.Direccion)}</entityAddress>\n`;
      xml += `      <entityCity>${esc(e.Ciudad)}</entityCity>\n`;
      xml += `      <entityState>${esc(e.Estado)}</entityState>\n`;
      xml += `      <entityPostalCode>${esc(e.DireccionPostal)}</entityPostalCode>\n`;
      xml += `      <entityPhone>${esc(e.Telefono)}</entityPhone>\n`;
      xml += `    </declarationEntity>\n`;
    }
  }

  xml += `    <declarationFOBValue>${d2(op.FOB)}</declarationFOBValue>\n`;

  // Expenses: conditional (only if > 0)
  if (Number(op.Flete) > 0)
    xml += `    <declarationExpense>\n      <expenseType>FLETE</expenseType>\n      <expenseValue>${d2(op.Flete)}</expenseValue>\n      <expenseCurrency>USD</expenseCurrency>\n    </declarationExpense>\n`;
  if (Number(op.Flete2) > 0)
    xml += `    <declarationExpense>\n      <expenseType>FYS_FLETE</expenseType>\n      <expenseValue>${d2(op.Flete2)}</expenseValue>\n      <expenseCurrency>USD</expenseCurrency>\n    </declarationExpense>\n`;
  if (Number(op.Seguro) > 0) {
    xml += `    <declarationExpense>\n      <expenseType>FYS_SEGURO</expenseType>\n      <expenseValue>${d2(op.Seguro)}</expenseValue>\n      <expenseCurrency>USD</expenseCurrency>\n    </declarationExpense>\n`;
    xml += `    <declarationExpense>\n      <expenseType>SEGURO</expenseType>\n      <expenseValue>${d2(op.Seguro)}</expenseValue>\n      <expenseCurrency>USD</expenseCurrency>\n    </declarationExpense>\n`;
  }
  if (Number(op.OtroGastos) > 0)
    xml += `    <declarationExpense>\n      <expenseType>OTROS GASTOS</expenseType>\n      <expenseValue>${d2(op.OtroGastos)}</expenseValue>\n      <expenseCurrency>USD</expenseCurrency>\n    </declarationExpense>\n`;
  if (Number(op.OtrasErogaciones) > 0)
    xml += `    <declarationExpense>\n      <expenseType>OTRAS EROGACIONES</expenseType>\n      <expenseValue>${d2(op.OtrasErogaciones)}</expenseValue>\n      <expenseCurrency>USD</expenseCurrency>\n    </declarationExpense>\n`;

  xml += `    <declarationCIFValue>${d2(op.ValorCIF)}</declarationCIFValue>\n`;
  xml += `    <declarationUSDRate>${d2(op.TC)}</declarationUSDRate>\n`;
  xml += `    <declarationCustomsValue>${d2(op.ValorCIFBS)}</declarationCustomsValue>\n`;

  // Duties: GA siempre; IVA/SIDUNEA/IHD segun el total emitido en los items.
  xml += `    <declarationDuty>\n      <dutyType>GA</dutyType>\n      <dutyValue>${declGA}</dutyValue>\n      <dutyCurrency>BOB</dutyCurrency>\n    </declarationDuty>\n`;
  if (sumIVA > 0)
    xml += `    <declarationDuty>\n      <dutyType>IVA</dutyType>\n      <dutyValue>${di(sumIVA)}</dutyValue>\n      <dutyCurrency>BOB</dutyCurrency>\n    </declarationDuty>\n`;
  if (sumSIDUNEA > 0)
    xml += `    <declarationDuty>\n      <dutyType>USO SIDUNEA ++</dutyType>\n      <dutyValue>${d2(sumSIDUNEA)}</dutyValue>\n      <dutyCurrency>BOB</dutyCurrency>\n    </declarationDuty>\n`;
  if (sumIEHD > 0)
    xml += `    <declarationDuty>\n      <dutyType>IHD</dutyType>\n      <dutyValue>${d2(sumIEHD)}</dutyValue>\n      <dutyCurrency>BOB</dutyCurrency>\n    </declarationDuty>\n`;

  xml += `    <declarationNetWeight>${di(op.PesoNeto)}</declarationNetWeight>\n`;
  xml += `    <declarationGrossWeight>${di(op.PesoBruto)}</declarationGrossWeight>\n`;

  for (const it of items) {
    xml += `    <declarationItem>\n`;
    xml += `      <declarationItemSequenceNumber>${it.NroItem || 1}</declarationItemSequenceNumber>\n`;
    xml += `      <declarationItemHTS>${esc(it.CodArrancel)}</declarationItemHTS>\n`;
    xml += `      <declarationItemHTSDescription>${esc(it.Descripcion || it.ProductoDescripcion)}</declarationItemHTSDescription>\n`;
    xml += `      <declarationItemStatisticalQuantity>${d2(it.CantidadSegPart)}</declarationItemStatisticalQuantity>\n`;
    xml += `      <declarationItemStatisticalUnity>${esc(it.UnidadMedida)}</declarationItemStatisticalUnity>\n`;
    xml += `      <declarationItemIncoterm>${esc(op.Incoterm)}</declarationItemIncoterm>\n`;
    xml += `      <declarationItemCurrency>${esc(op.MonedaId)}</declarationItemCurrency>\n`;

    // Item entities: same for all items (from operation level)
    for (const [tp, fk] of [["Exporter", "ExporterId"], ["Manufacturer", "ManufacturerId"]]) {
      const e = entidades[fk];
      if (e) {
        xml += `      <declarationItemEntity>\n`;
        xml += `        <entityType>${tp}</entityType>\n`;
        xml += `        <entityReferenceCode>${esc(e.Nit)}</entityReferenceCode>\n`;
        xml += `        <entityName>${esc(e.Nombre)}</entityName>\n`;
        xml += `        <entityCountry>${esc(e.Pais)}</entityCountry>\n`;
        xml += `        <entityAddress>${esc(e.Direccion)}</entityAddress>\n`;
        xml += `        <entityCity>${esc(e.Ciudad)}</entityCity>\n`;
        xml += `        <entityState>${esc(e.Estado)}</entityState>\n`;
        xml += `        <entityPostalCode>${esc(e.DireccionPostal)}</entityPostalCode>\n`;
        xml += `        <entityPhone>${esc(e.Telefono)}</entityPhone>\n`;
        xml += `      </declarationItemEntity>\n`;
      }
    }

    xml += `      <declarationItemFOBValue>${d2(it.FOB)}</declarationItemFOBValue>\n`;

    if (Number(it.Flete) > 0)
      xml += `      <declarationItemExpense>\n        <expenseType>FLETE</expenseType>\n        <expenseValue>${d2(it.Flete)}</expenseValue>\n        <expenseCurrency>USD</expenseCurrency>\n      </declarationItemExpense>\n`;
    if (Number(it.Flete2) > 0)
      xml += `      <declarationItemExpense>\n        <expenseType>FYS_FLETE</expenseType>\n        <expenseValue>${d2(it.Flete2)}</expenseValue>\n        <expenseCurrency>USD</expenseCurrency>\n      </declarationItemExpense>\n`;
    if (Number(it.Seguro) > 0) {
      xml += `      <declarationItemExpense>\n        <expenseType>FYS_SEGURO</expenseType>\n        <expenseValue>${d2(it.Seguro)}</expenseValue>\n        <expenseCurrency>USD</expenseCurrency>\n      </declarationItemExpense>\n`;
      xml += `      <declarationItemExpense>\n        <expenseType>SEGURO</expenseType>\n        <expenseValue>${d2(it.Seguro)}</expenseValue>\n        <expenseCurrency>USD</expenseCurrency>\n      </declarationItemExpense>\n`;
    }
    if (Number(it.OtrosGastos) > 0)
      xml += `      <declarationItemExpense>\n        <expenseType>OTROS GASTOS</expenseType>\n        <expenseValue>${d2(it.OtrosGastos)}</expenseValue>\n        <expenseCurrency>USD</expenseCurrency>\n      </declarationItemExpense>\n`;
    if (Number(it.OtrasErogaciones) > 0)
      xml += `      <declarationItemExpense>\n        <expenseType>OTRAS EROGACIONES</expenseType>\n        <expenseValue>${d2(it.OtrasErogaciones)}</expenseValue>\n        <expenseCurrency>USD</expenseCurrency>\n      </declarationItemExpense>\n`;

    xml += `      <declarationItemCIFValue>${d2(it.CIFUSD)}</declarationItemCIFValue>\n`;
    xml += `      <declarationItemCustomsValue>${d2(it.CIFBS)}</declarationItemCustomsValue>\n`;

    if (it.GA != null)
      xml += `      <declarationItemDuty>\n        <dutyType>GA</dutyType>\n        <dutyValue>${di(it.GA)}</dutyValue>\n        <dutyCurrency>BOB</dutyCurrency>\n        <dutyBasisOfCalculus>${di(it.BaseImponible)}</dutyBasisOfCalculus>\n        <dutyPercentage></dutyPercentage>\n      </declarationItemDuty>\n`;
    if (Number(it.IVA) > 0)
      xml += `      <declarationItemDuty>\n        <dutyType>IVA</dutyType>\n        <dutyValue>${di(it.IVA)}</dutyValue>\n        <dutyCurrency>BOB</dutyCurrency>\n        <dutyBasisOfCalculus>${di(it.BaseImponible)}</dutyBasisOfCalculus>\n        <dutyPercentage>14.94</dutyPercentage>\n      </declarationItemDuty>\n`;
    if (Number(it.SIDUNEA) > 0)
      xml += `      <declarationItemDuty>\n        <dutyType>USO SIDUNEA ++</dutyType>\n        <dutyValue>${d2(it.SIDUNEA)}</dutyValue>\n        <dutyCurrency>BOB</dutyCurrency>\n        <dutyBasisOfCalculus></dutyBasisOfCalculus>\n        <dutyPercentage></dutyPercentage>\n      </declarationItemDuty>\n`;
    if (Number(it.IEHD) > 0)
      xml += `      <declarationItemDuty>\n        <dutyType>IHD</dutyType>\n        <dutyValue>${d2(it.IEHD)}</dutyValue>\n        <dutyCurrency>BOB</dutyCurrency>\n        <dutyBasisOfCalculus>${di(it.BaseImponible)}</dutyBasisOfCalculus>\n        <dutyPercentage>1.4</dutyPercentage>\n      </declarationItemDuty>\n`;

    xml += `      <declarationItemNetWeight>${d2(it.PesoNeto)}</declarationItemNetWeight>\n`;
    xml += `      <declarationItemGrossWeight>${d2(it.PesoBruto)}</declarationItemGrossWeight>\n`;

    // Product section
    const unidadFob = (Number(it.FOB) || 0) / Math.max(1, Number(it.Cantidad) || 1);
    const unidadCif = (Number(it.CIFUSD) || 0) / Math.max(1, Number(it.Cantidad) || 1);
    const unidadPn = (Number(it.PesoNeto) || 0) / Math.max(1, Number(it.Cantidad) || 1);
    const gaPct = (Number(it.Acuerdo) || 0) * 100;

    xml += `      <declarationItemProduct>\n`;
    xml += `        <productReferenceCode>${esc(it.ProductoCode)}</productReferenceCode>\n`;
    xml += `        <productReferenceCodeKit></productReferenceCodeKit>\n`;
    xml += `        <productSequenceNumber>${it.NroItem || 1}</productSequenceNumber>\n`;
    xml += `        <productPartNumber>${esc(it.PartNumber)}</productPartNumber>\n`;
    xml += `        <productDescription>${esc(it.ProductoDescripcion)}</productDescription>\n`;
    xml += `        <productQuantity>${d2(it.Cantidad)}</productQuantity>\n`;
    xml += `        <productUnityFOBValue>${Math.round(unidadFob * 100) / 100}</productUnityFOBValue>\n`;
    xml += `        <productTotalFobValue>${d2(it.FOB)}</productTotalFobValue>\n`;

    if (Number(it.Flete) > 0)
      xml += `        <productExpense>\n          <expenseType>FLETE</expenseType>\n          <expenseValue>${d2(it.Flete)}</expenseValue>\n          <expenseCurrency>USD</expenseCurrency>\n        </productExpense>\n`;
    if (Number(it.Flete2) > 0)
      xml += `        <productExpense>\n          <expenseType>FYS_FLETE</expenseType>\n          <expenseValue>${d2(it.Flete2)}</expenseValue>\n          <expenseCurrency>USD</expenseCurrency>\n        </productExpense>\n`;
    if (Number(it.Seguro) > 0) {
      xml += `        <productExpense>\n          <expenseType>FYS_SEGURO</expenseType>\n          <expenseValue>${d2(it.Seguro)}</expenseValue>\n          <expenseCurrency>USD</expenseCurrency>\n        </productExpense>\n`;
      xml += `        <productExpense>\n          <expenseType>SEGURO</expenseType>\n          <expenseValue>${d2(it.Seguro)}</expenseValue>\n          <expenseCurrency>USD</expenseCurrency>\n        </productExpense>\n`;
    }
    if (Number(it.OtrosGastos) > 0)
      xml += `        <productExpense>\n          <expenseType>OTROS GASTOS</expenseType>\n          <expenseValue>${d2(it.OtrosGastos)}</expenseValue>\n          <expenseCurrency>USD</expenseCurrency>\n        </productExpense>\n`;
    if (Number(it.OtrasErogaciones) > 0)
      xml += `        <productExpense>\n          <expenseType>OTRAS EROGACIONES</expenseType>\n          <expenseValue>${d2(it.OtrasErogaciones)}</expenseValue>\n          <expenseCurrency>USD</expenseCurrency>\n        </productExpense>\n`;

    xml += `        <productUnityCIFValue>${Math.round(unidadCif * 100) / 100}</productUnityCIFValue>\n`;
    xml += `        <productCIFValue>${d2(it.CIFUSD)}</productCIFValue>\n`;
    xml += `        <productCustomsValue>${d2(it.CIFBS)}</productCustomsValue>\n`;

    if (it.GA != null)
      xml += `        <productDuty>\n          <dutyType>GA</dutyType>\n          <dutyValue>${di(it.GA)}</dutyValue>\n          <dutyCurrency>BOB</dutyCurrency>\n          <dutyBasicOfCalculus>${di(it.BaseImponible)}</dutyBasicOfCalculus>\n          <dutyPercentage>${d2(gaPct)}</dutyPercentage>\n        </productDuty>\n`;
    if (Number(it.IVA) > 0)
      xml += `        <productDuty>\n          <dutyType>IVA</dutyType>\n          <dutyValue>${di(it.IVA)}</dutyValue>\n          <dutyCurrency>BOB</dutyCurrency>\n          <dutyBasicOfCalculus>${di(it.BaseImponible)}</dutyBasicOfCalculus>\n          <dutyPercentage>14.94</dutyPercentage>\n        </productDuty>\n`;
    if (Number(it.SIDUNEA) > 0)
      xml += `        <productDuty>\n          <dutyType>USO SIDUNEA ++</dutyType>\n          <dutyValue>${d2(it.SIDUNEA)}</dutyValue>\n          <dutyCurrency>BOB</dutyCurrency>\n          <dutyBasicOfCalculus></dutyBasicOfCalculus>\n          <dutyPercentage></dutyPercentage>\n        </productDuty>\n`;
    if (Number(it.IEHD) > 0)
      xml += `        <productDuty>\n          <dutyType>IHD</dutyType>\n          <dutyValue>${d2(it.IEHD)}</dutyValue>\n          <dutyCurrency>BOB</dutyCurrency>\n          <dutyBasicOfCalculus>${di(it.BaseImponible)}</dutyBasicOfCalculus>\n          <dutyPercentage>1.4</dutyPercentage>\n        </productDuty>\n`;

    xml += `        <productUnityNetWeight>${Math.round(unidadPn * 100) / 100}</productUnityNetWeight>\n`;
    xml += `        <productNetWeight>${d2(it.PesoNeto)}</productNetWeight>\n`;
    xml += `      </declarationItemProduct>\n`;
    xml += `    </declarationItem>\n`;
  }

  xml += `  </importDeclaration>\n`;
  xml += `</Broker2Softway>`;

  return xml;
}

module.exports = { buildDeclaracionXml };
