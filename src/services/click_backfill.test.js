const test = require("node:test");
const assert = require("node:assert/strict");
const {
  pendingReason,
  isClickRelatedMotivo,
  splitIgnorados,
  selectProcessablePendientes,
} = require("./transbel_sync_core");

test("pendingReason detecta referencia y datos CLICK faltantes", () => {
  assert.deepEqual(
    pendingReason({
      ReferenciaCliente: "180360263",
      NroRegistro: "R-1",
      FechaValidacion: "2024-01-02",
      PagoTributos: "2024-01-02",
      FechaLevante: "2024-01-06",
    }),
    []
  );

  assert.deepEqual(
    pendingReason({
      ReferenciaCliente: "",
      NroRegistro: null,
      FechaValidacion: null,
      PagoTributos: null,
      FechaLevante: null,
    }),
    [
      "Sin referencia de cliente (ENTREGA)",
      "Sin datos de CLICK (checkpoints)",
    ]
  );

  assert.deepEqual(
    pendingReason({
      ReferenciaCliente: "180360263",
      NroRegistro: "R-1",
      FechaValidacion: null,
      PagoTributos: "2024-01-02",
      FechaLevante: null,
    }),
    [
      "Sin fecha de aceptación de declaración",
      "Sin fecha de canal/levante",
    ]
  );
});

test("pendingReason marca referencias con formato invalido", () => {
  assert.deepEqual(
    pendingReason({
      ReferenciaCliente: "EE: 180361021 GE: 906384",
      NroRegistro: "R-1",
      FechaValidacion: "2024-01-02",
      PagoTributos: "2024-01-02",
      FechaLevante: "2024-01-06",
    }),
    ["Referencia de cliente inválida (debe ser 180XXXXXX)"]
  );

  assert.deepEqual(
    pendingReason({
      ReferenciaCliente: "150398420",
      NroRegistro: "R-1",
      FechaValidacion: "2024-01-02",
      PagoTributos: "2024-01-02",
      FechaLevante: "2024-01-06",
    }),
    ["Referencia de cliente inválida (debe ser 180XXXXXX)"]
  );

  assert.deepEqual(
    pendingReason({
      ReferenciaCliente: "180361023",
      NroRegistro: "R-1",
      FechaValidacion: "2024-01-02",
      PagoTributos: "2024-01-02",
      FechaLevante: "2024-01-06",
    }),
    []
  );
});

test("isClickRelatedMotivo distingue motivos CLICK de los que no lo son", () => {
  assert.equal(isClickRelatedMotivo("Sin datos de CLICK (checkpoints)"), true);
  assert.equal(
    isClickRelatedMotivo("Sin fecha de aceptación de declaración"),
    true
  );
  assert.equal(isClickRelatedMotivo("Sin fecha de pago de tributos"), true);
  assert.equal(isClickRelatedMotivo("Sin referencia de cliente (ENTREGA)"), false);
  assert.equal(
    isClickRelatedMotivo(
      "Sin referencia de cliente (ENTREGA) · Sin datos de CLICK (checkpoints)"
    ),
    true
  );
  assert.equal(isClickRelatedMotivo(""), false);
});

test("splitIgnorados separa pendientes de ignorados", () => {
  const rows = [
    { operacionId: 1, referenciaCliente: "180000001" },
    { operacionId: 2, referenciaCliente: "180000002" },
    { operacionId: 3, referenciaCliente: "180000003" },
  ];
  const result = splitIgnorados(rows, new Set([2]));
  assert.deepEqual(
    result.pendientes.map((r) => r.operacionId),
    [1, 3]
  );
  assert.deepEqual(
    result.ignorados.map((r) => r.operacionId),
    [2]
  );

  const none = splitIgnorados(rows, []);
  assert.equal(none.pendientes.length, 3);
  assert.equal(none.ignorados.length, 0);

  const all = splitIgnorados(rows, [1, 2, 3]);
  assert.equal(all.pendientes.length, 0);
  assert.equal(all.ignorados.length, 3);

  assert.deepEqual(splitIgnorados(null, [1]), {
    pendientes: [],
    ignorados: [],
  });
});

test("selectProcessablePendientes filtra por id, incompleto y clasifica", () => {
  const pendientes = [
    {
      operacionId: 1,
      completo: false,
      motivo: "Sin datos de CLICK (checkpoints)",
      motivos: ["Sin datos de CLICK (checkpoints)"],
    },
    {
      operacionId: 2,
      completo: false,
      motivo: "Sin referencia de cliente (ENTREGA)",
      motivos: ["Sin referencia de cliente (ENTREGA)"],
    },
    { operacionId: 3, completo: true, motivo: "" },
    {
      operacionId: 4,
      completo: false,
      motivo: "",
      motivos: ["Sin fecha de pago de tributos"],
    },
  ];

  const selected = selectProcessablePendientes(pendientes, [1, 2, 3, "4", 99]);
  assert.deepEqual(
    selected.map((p) => p.operacionId),
    [1, 2, 4]
  );
  assert.equal(selected[0].procesable, true);
  assert.equal(selected[1].procesable, false);
  assert.equal(selected[2].procesable, true);

  assert.deepEqual(selectProcessablePendientes(pendientes, []), []);
  assert.deepEqual(selectProcessablePendientes(null, [1]), []);
});
