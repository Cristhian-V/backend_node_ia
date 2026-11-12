const test = require("node:test");
const assert = require("node:assert/strict");
const {
  TransbelExcepcionError,
  normalizeCausa,
  formatDateOnly,
  mapExcepcion,
  mapCatalogo,
  isValidReferenciaCliente,
  isAnticipadaIMA,
  requiereExcepcion,
  buildAuditPayload,
} = require("./transbel_excepciones_core");

test("normalizeCausa quita tabs y espacios sobrantes", () => {
  assert.equal(normalizeCausa("\tDEMORA   EN EL PAGO\t"), "DEMORA EN EL PAGO");
  assert.equal(normalizeCausa("  AGENTE DE ADUANA "), "AGENTE DE ADUANA");
  assert.equal(normalizeCausa(null), "");
  assert.equal(normalizeCausa(undefined), "");
});

test("formatDateOnly devuelve YYYY-MM-DD sin corrimiento de zona", () => {
  assert.equal(formatDateOnly(new Date(2024, 0, 2, 10, 25)), "2024-01-02");
  assert.equal(formatDateOnly("2024-01-02T10:25:54.000Z"), "2024-01-02");
  assert.equal(formatDateOnly(null), null);
  assert.equal(formatDateOnly(""), null);
  assert.equal(formatDateOnly("no-es-fecha"), null);
});

test("mapExcepcion normaliza columnas del SP", () => {
  const mapped = mapExcepcion({
    OperacionId: 39490,
    Cliente: "TRANSBEL S.A.",
    Patron: "IMA 4",
    NroDUI: "C-2000473",
    NroEmbarque: "234096467",
    Imagen: "VERDE",
    Recinto: " INTERIOR SANTA CRUZ ",
    ReferenciaCliente: "180360263",
    TipoTransporteId: "M",
    Transporte: "Maritimo",
    FechaPaseSalida: new Date(2024, 0, 6),
    FechaValidacion: new Date(2024, 0, 2),
    PagoTributos: new Date(2024, 0, 2),
    FechaLevante: new Date(2024, 0, 6),
    Diferencia: 4,
    ExcepcionId: null,
    CausaGlobal: null,
    CausaPuntual: null,
    Responsable: null,
    Ajustable: null,
    RequiereEx: "SI",
    Usuario: "Cristhian Vargas",
    AsignadoId: 0,
    Asignado: null,
    FechaSync: null,
    FechaReg: null,
  });
  assert.equal(mapped.operacionId, 39490);
  assert.equal(mapped.imagen, "VERDE");
  assert.equal(mapped.fechaPaseSalida, "2024-01-06");
  assert.equal(mapped.fechaValidacion, "2024-01-02");
  assert.equal(mapped.diferencia, 4);
  assert.equal(mapped.excepcionId, null);
  assert.equal(mapped.causaPuntual, "");
  assert.equal(mapped.requiereEx, "SI");
  assert.equal(mapped.asignadoId, 0);
});

test("mapCatalogo normaliza causas del catalogo", () => {
  const item = mapCatalogo({
    ExcepcionId: "AA01",
    CausaGlobal: "DEMORAS EN PROCESO ADUANERO\t",
    CausaPuntual: "\tDEMORA EN LA SOLICITUD EN EL PAGO DE IMPUESTOS\t",
    Responsable: "\tAGENTE DE ADUANA",
    Ajustable: "N",
  });
  assert.deepEqual(item, {
    excepcionId: "AA01",
    causaGlobal: "DEMORAS EN PROCESO ADUANERO",
    causaPuntual: "DEMORA EN LA SOLICITUD EN EL PAGO DE IMPUESTOS",
    responsable: "AGENTE DE ADUANA",
    ajustable: "N",
  });
});

test("isValidReferenciaCliente exige 180 + 6 digitos exactos", () => {
  assert.equal(isValidReferenciaCliente("180361023"), true);
  assert.equal(isValidReferenciaCliente(" 180361023 "), true);
  assert.equal(isValidReferenciaCliente("18036102"), false);
  assert.equal(isValidReferenciaCliente("1803610234"), false);
  assert.equal(isValidReferenciaCliente("EE: 180361021 GE: 906384"), false);
  assert.equal(isValidReferenciaCliente("150398420"), false);
  assert.equal(isValidReferenciaCliente("18036102A"), false);
  assert.equal(isValidReferenciaCliente(null), false);
  assert.equal(isValidReferenciaCliente(""), false);
});

test("isAnticipadaIMA detecta el patron IMA", () => {
  assert.equal(isAnticipadaIMA("IMA 4"), true);
  assert.equal(isAnticipadaIMA("ima 4"), true);
  assert.equal(isAnticipadaIMA("  IMA 4 "), true);
  assert.equal(isAnticipadaIMA("IM 4"), false);
  assert.equal(isAnticipadaIMA("IMI 4"), false);
  assert.equal(isAnticipadaIMA("EX 1"), false);
  assert.equal(isAnticipadaIMA(null), false);
});

test("requiereExcepcion exige excepcion solo con mas de 3 dias y sin asignar", () => {
  assert.equal(requiereExcepcion(4, null), true);
  assert.equal(requiereExcepcion(3, null), false);
  assert.equal(requiereExcepcion(2, null), false);
  assert.equal(requiereExcepcion(null, null), false);
  assert.equal(requiereExcepcion(5, "AA01"), false);
});

test("requiereExcepcion no exige excepcion para IMA anticipada", () => {
  assert.equal(requiereExcepcion(5, null, true), false);
  assert.equal(requiereExcepcion(5, null, false), true);
  assert.equal(requiereExcepcion(10, "AA01", true), false);
});

test("buildAuditPayload arma el payload de auditoria", () => {
  assert.deepEqual(
    buildAuditPayload({
      operacionId: 10,
      excepcionId: "AA01",
      accion: "asignar",
      estadoPrevio: null,
      clienteId: 1047,
    }),
    {
      operacionId: 10,
      excepcionId: "AA01",
      accion: "asignar",
      estadoPrevio: null,
      clienteId: 1047,
      motivo: null,
    }
  );
});

test("TransbelExcepcionError conserva el status HTTP", () => {
  const err = new TransbelExcepcionError("EL registro ya fue finalizado", 409);
  assert.equal(err.message, "EL registro ya fue finalizado");
  assert.equal(err.status, 409);
  assert.ok(err instanceof Error);
});
