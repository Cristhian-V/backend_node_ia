const test = require("node:test");
const assert = require("node:assert/strict");
const { buildDeclaracionXml } = require("./fnning_xml");

function makeOp(overrides = {}) {
  return {
    NroRegistro: "C2394867",
    Tramite: "00520/26",
    Patron: "IMA4",
    Incoterm: "DPU",
    Recinto: "701",
    Canal: "VERDE",
    MonedaId: "USD",
    FOB: 1000,
    TC: 11.68,
    PesoBruto: 10,
    PesoNeto: 10,
    ValorCIF: 1000,
    ValorCIFBS: 11680,
    GA: 0,
    FechaValidacion: null,
    FechaPago: null,
    FechaSalidadeMercancia: null,
    BrokerId: null,
    ImporterId: null,
    ExporterId: null,
    ManufacturerId: null,
    ...overrides,
  };
}

function makeItem(nroItem, overrides = {}) {
  return {
    NroItem: nroItem,
    CodArrancel: "8502131000",
    Descripcion: "Grupo electrogeno",
    CantidadSegPart: 1,
    UnidadMedida: "u",
    FOB: 500,
    Flete: 0,
    Flete2: 0,
    Seguro: 0,
    OtrosGastos: 0,
    OtrasErogaciones: 0,
    CIFUSD: 500,
    CIFBS: 5840,
    GA: 0,
    BaseImponible: 5840,
    IVA: 0,
    SIDUNEA: 0,
    IEHD: 0,
    PesoNeto: 5,
    PesoBruto: 5,
    ProductoCode: 123,
    PartNumber: "EPGR_DE110.AA",
    ProductoDescripcion: "Generador Diesel",
    Cantidad: 1,
    Acuerdo: 0,
    ...overrides,
  };
}

function parseDuties(xml, tag) {
  const re = new RegExp(
    `<${tag}>\\s*<dutyType>([^<]*)</dutyType>\\s*<dutyValue>([^<]*)</dutyValue>`,
    "g"
  );
  const duties = {};
  let match;
  while ((match = re.exec(xml)) !== null) duties[match[1]] = match[2];
  return duties;
}

function headerDuties(xml) {
  return parseDuties(xml.split("<declarationItem>")[0], "declarationDuty");
}

function itemDutySum(xml, dutyType) {
  return Array.from(xml.matchAll(/<declarationItemDuty>[\s\S]*?<\/declarationItemDuty>/g))
    .map((m) => parseDuties(m[0], "declarationItemDuty")[dutyType])
    .filter((v) => v != null)
    .reduce((sum, v) => sum + Number(v), 0);
}

function productDutySum(xml, dutyType) {
  return Array.from(xml.matchAll(/<productDuty>[\s\S]*?<\/productDuty>/g))
    .map((m) => parseDuties(m[0], "productDuty")[dutyType])
    .filter((v) => v != null)
    .reduce((sum, v) => sum + Number(v), 0);
}

test("GA del encabezado existe con valor 0 cuando todos los items son 0", () => {
  const items = [
    makeItem(1, { GA: 0, IVA: 104172, SIDUNEA: 50 }),
    makeItem(2, { GA: 0, IVA: 104172, SIDUNEA: 50 }),
  ];
  const xml = buildDeclaracionXml({ op: makeOp({ GA: 0 }), items });
  const duties = headerDuties(xml);

  assert.equal(duties.GA, "0");
  assert.equal(Number(duties.IVA), 208344);
  assert.equal(Number(duties["USO SIDUNEA ++"]), 100);
});

test("GA del encabezado es la suma de los items y no Operacion.GA", () => {
  const items = [
    makeItem(1, { GA: 1000, IVA: 100 }),
    makeItem(2, { GA: 1915, IVA: 200 }),
  ];
  const xml = buildDeclaracionXml({ op: makeOp({ GA: 9999 }), items });
  const duties = headerDuties(xml);

  assert.equal(duties.GA, "2915");
  assert.equal(itemDutySum(xml, "GA"), 2915);
  assert.equal(productDutySum(xml, "GA"), 2915);
  assert.equal(duties.IVA, "300");
});

test("SIDUNEA fraccionario del encabezado cuadra con los items", () => {
  const items = [
    makeItem(1, { SIDUNEA: 33.33 }),
    makeItem(2, { SIDUNEA: 33.33 }),
    makeItem(3, { SIDUNEA: 33.33 }),
  ];
  const xml = buildDeclaracionXml({ op: makeOp(), items });
  const duties = headerDuties(xml);

  assert.equal(duties["USO SIDUNEA ++"], "99.99");
  assert.equal(itemDutySum(xml, "USO SIDUNEA ++"), 99.99);
});

test("IHD ausente en todos los items no se emite en el encabezado", () => {
  const xml = buildDeclaracionXml({
    op: makeOp(),
    items: [makeItem(1, { IEHD: 0 }), makeItem(2, { IEHD: 0 })],
  });

  assert.equal(headerDuties(xml).IHD, undefined);
});

test("emite un declarationItem por item, en orden de NroItem", () => {
  const items = [makeItem(3), makeItem(1), makeItem(2)];
  const xml = buildDeclaracionXml({ op: makeOp(), items });

  const blocks = xml.split("<declarationItem>").slice(1);
  assert.equal(blocks.length, 3);
  const sequence = blocks.map((b) =>
    b.match(/<declarationItemSequenceNumber>([^<]*)<\/declarationItemSequenceNumber>/)[1]
  );
  assert.deepEqual(sequence, ["3", "1", "2"]);
  assert.ok(xml.startsWith('<?xml version="1.0" encoding="iso-8859-1"?>'));
  assert.ok(xml.endsWith("</Broker2Softway>"));
});

test("escapa caracteres especiales en descripciones", () => {
  const xml = buildDeclaracionXml({
    op: makeOp(),
    items: [makeItem(1, { ProductoDescripcion: 'A & B <C> "D"' })],
  });

  assert.ok(xml.includes("A &amp; B &lt;C&gt; &quot;D&quot;"));
});
