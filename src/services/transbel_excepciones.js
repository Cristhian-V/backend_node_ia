const { getPool, sql } = require("../db_sqlserver");
const pg = require("../db");
const {
  TransbelExcepcionError,
  mapExcepcion,
  mapCatalogo,
  isValidReferenciaCliente,
  isAnticipadaIMA,
  requiereExcepcion,
  buildAuditPayload,
} = require("./transbel_excepciones_core");
const { splitIgnorados } = require("./transbel_sync_core");
const {
  listPendientes: listSincPendientes,
  sincronizar,
} = require("./transbel_sync");
const {
  getIgnoredOperacionIds,
  ignorar,
  restaurar,
} = require("./transbel_ignorados");

const CLIENTE_ID = parseInt(process.env.TRANSBEL_CLIENTE_ID || "1047", 10);

async function recordAudit({
  operacionId,
  excepcionId = null,
  accion,
  resultado,
  estadoId = null,
  usuario = null,
  motivo = null,
  payload = null,
}) {
  try {
    await pg.query(
      `INSERT INTO core.transbel_excepciones
         (operacion_id, excepcion_id, accion, resultado, estado_id, usuario_id, usuario_integre, motivo, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        operacionId,
        excepcionId,
        accion,
        resultado,
        estadoId,
        usuario && usuario.id != null ? Number(usuario.id) : null,
        usuario && usuario.usuario_integre != null
          ? Number(usuario.usuario_integre)
          : null,
        motivo,
        payload == null ? null : JSON.stringify(payload),
      ]
    );
  } catch (err) {
    console.error("transbel_excepciones auditoria error:", err.message);
  }
}

async function listPorTipo(estadoId) {
  const pool = await getPool();
  const request = pool.request();
  request.input("estadoId", sql.VarChar(10), estadoId);
  request.input("usuarioId", sql.Int, null);
  const result = await request.execute("dbo.SP_CME_GetExcepcionesClienteTransbel");
  return result.recordset.map(mapExcepcion);
}

async function listPendientesConIgnorados() {
  const rows = await listPorTipo("PENDIENTE");
  const ignorados = await getIgnoredOperacionIds();
  return splitIgnorados(rows, ignorados);
}

async function listPendientes() {
  const { pendientes } = await listPendientesConIgnorados();
  return pendientes;
}

async function listIgnorados() {
  const { ignorados } = await listPendientesConIgnorados();
  return ignorados;
}

async function listHistorial() {
  return listPorTipo("HIST");
}

async function getCatalogo() {
  const pool = await getPool();
  const result = await pool.request().query(`
    SELECT ExcepcionId, CausaGlobal, CausaPuntual, Responsable, Ajustable
    FROM dbo.ExcepcionesTransbel WITH(NOLOCK)
    ORDER BY ExcepcionId
  `);
  return result.recordset.map(mapCatalogo);
}

async function asignarExcepcion({ operacionId, excepcionId, usuario }) {
  const opId = Number.parseInt(operacionId, 10);
  if (!Number.isInteger(opId) || opId <= 0) {
    throw new TransbelExcepcionError("operacionId invalido", 400);
  }
  const excId = excepcionId == null ? "" : String(excepcionId).trim();
  if (!excId) {
    throw new TransbelExcepcionError("excepcionId es requerido", 400);
  }

  const usuarioIntegre =
    usuario && usuario.usuario_integre != null
      ? Number.parseInt(usuario.usuario_integre, 10)
      : null;
  if (!Number.isInteger(usuarioIntegre)) {
    const err = new TransbelExcepcionError(
      "El administrador no tiene usuario de Integgre configurado",
      409
    );
    await recordAudit({
      operacionId: opId,
      excepcionId: excId,
      accion: "asignar",
      resultado: "error",
      usuario,
      motivo: err.message,
      payload: buildAuditPayload({
        operacionId: opId,
        excepcionId: excId,
        accion: "asignar",
        motivo: err.message,
      }),
    });
    throw err;
  }

  const poolSql = await getPool();
  let accion = "asignar";
  let estadoPrevio = null;
  let clienteId = null;

  const transaction = new sql.Transaction(poolSql);
  await transaction.begin();
  try {
    const opReq = new sql.Request(transaction);
    opReq.input("operacionId", sql.Int, opId);
    const opRes = await opReq.query(
      "SELECT TOP 1 ClienteId FROM dbo.CME_Operacion WITH(NOLOCK) WHERE OperacionId = @operacionId"
    );
    if (opRes.recordset.length === 0) {
      throw new TransbelExcepcionError("Operacion no encontrada", 404);
    }
    clienteId = Number(opRes.recordset[0].ClienteId);
    if (clienteId !== CLIENTE_ID) {
      throw new TransbelExcepcionError(
        "La operacion no pertenece al cliente Transbel",
        400
      );
    }

    const exReq = new sql.Request(transaction);
    exReq.input("operacionId", sql.Int, opId);
    const exRes = await exReq.query(
      "SELECT TOP 1 EstadoId FROM dbo.CME_RegistroExcepciones WITH (UPDLOCK, HOLDLOCK) WHERE OperacionId = @operacionId"
    );
    const existing = exRes.recordset[0];
    if (existing) {
      estadoPrevio = existing.EstadoId;
      accion = "reasignar";
      if (existing.EstadoId === "F") {
        throw new TransbelExcepcionError("EL registro ya fue finalizado", 409);
      }
    }

    const writeReq = new sql.Request(transaction);
    writeReq.input("operacionId", sql.Int, opId);
    writeReq.input("excepcionId", sql.VarChar(10), excId);
    writeReq.input("usuarioId", sql.Int, usuarioIntegre);
    if (existing) {
      await writeReq.query(`
        UPDATE dbo.CME_RegistroExcepciones
           SET EstadoId = 'P',
               ExcepcionId = @excepcionId,
               UsuarioId = @usuarioId,
               Dias = NULL,
               FechaSync = NULL,
               Activo = 1,
               FechaReg = GETDATE()
         WHERE OperacionId = @operacionId
      `);
    } else {
      await writeReq.query(`
        INSERT INTO dbo.CME_RegistroExcepciones
          (OperacionId, EstadoId, ExcepcionId, UsuarioId, Dias, FechaSync, Activo, FechaReg)
        VALUES
          (@operacionId, 'P', @excepcionId, @usuarioId, NULL, NULL, 1, GETDATE())
      `);
    }

    await transaction.commit();
  } catch (err) {
    try {
      await transaction.rollback();
    } catch (rollbackErr) {
      console.error("transbel_excepciones rollback error:", rollbackErr.message);
    }
    await recordAudit({
      operacionId: opId,
      excepcionId: excId,
      accion,
      resultado: "error",
      estadoId: estadoPrevio,
      usuario,
      motivo: err.message,
      payload: buildAuditPayload({
        operacionId: opId,
        excepcionId: excId,
        accion,
        estadoPrevio,
        clienteId,
        motivo: err.message,
      }),
    });
    if (err instanceof TransbelExcepcionError) throw err;
    throw new TransbelExcepcionError(
      "Error al asignar la excepcion: " + err.message,
      500
    );
  }

  await recordAudit({
    operacionId: opId,
    excepcionId: excId,
    accion,
    resultado: "ok",
    estadoId: "P",
    usuario,
    payload: buildAuditPayload({
      operacionId: opId,
      excepcionId: excId,
      accion,
      estadoPrevio,
      clienteId,
    }),
  });

  return { operacionId: opId, excepcionId: excId, accion, estadoId: "P" };
}

async function finalizarExcepcion({
  operacionId,
  diferencia,
  excepcionId,
  usuario,
}) {
  const opId = Number.parseInt(operacionId, 10);
  const dias =
    diferencia == null || Number.isNaN(Number(diferencia))
      ? null
      : Number(diferencia);

  const poolSql = await getPool();
  const transaction = new sql.Transaction(poolSql);
  await transaction.begin();
  try {
    const exReq = new sql.Request(transaction);
    exReq.input("operacionId", sql.Int, opId);
    const exRes = await exReq.query(
      "SELECT TOP 1 EstadoId, ExcepcionId, UsuarioId FROM dbo.CME_RegistroExcepciones WITH (UPDLOCK, HOLDLOCK) WHERE OperacionId = @operacionId"
    );
    const existing = exRes.recordset[0];

    if (existing && existing.EstadoId === "F") {
      await transaction.commit();
      return {
        operacionId: opId,
        estadoId: "F",
        finalizado: false,
        yaFinalizado: true,
      };
    }

    const excId = existing?.ExcepcionId ?? (excepcionId || null);
    const usuarioId =
      existing && existing.UsuarioId != null
        ? Number(existing.UsuarioId)
        : 0;

    const req = new sql.Request(transaction);
    req.input("operacionId", sql.Int, opId);
    req.input("excepcionId", sql.VarChar(10), excId);
    req.input("usuarioId", sql.Int, usuarioId);
    req.input("dias", sql.Int, dias);
    if (existing) {
      await req.query(`
        UPDATE dbo.CME_RegistroExcepciones
           SET EstadoId = 'F',
               ExcepcionId = @excepcionId,
               UsuarioId = @usuarioId,
               Dias = @dias,
               FechaSync = GETDATE(),
               Activo = 1
         WHERE OperacionId = @operacionId
      `);
    } else {
      await req.query(`
        INSERT INTO dbo.CME_RegistroExcepciones
          (OperacionId, EstadoId, ExcepcionId, UsuarioId, Dias, FechaSync, Activo, FechaReg)
        VALUES
          (@operacionId, 'F', @excepcionId, @usuarioId, @dias, GETDATE(), 1, GETDATE())
      `);
    }

    await transaction.commit();
  } catch (err) {
    try {
      await transaction.rollback();
    } catch (rollbackErr) {
      console.error("transbel_excepciones rollback error:", rollbackErr.message);
    }
    throw err;
  }

  return {
    operacionId: opId,
    estadoId: "F",
    finalizado: true,
    yaFinalizado: false,
  };
}

async function actualizarReferencia({ operacionId, referenciaCliente, usuario }) {
  const opId = Number.parseInt(operacionId, 10);
  if (!Number.isInteger(opId) || opId <= 0) {
    throw new TransbelExcepcionError("operacionId invalido", 400);
  }
  const ref = referenciaCliente == null ? "" : String(referenciaCliente).trim();
  let anterior = null;

  try {
    if (!isValidReferenciaCliente(ref)) {
      throw new TransbelExcepcionError(
        "La referencia debe ser un numero de 9 digitos que comienza con 180",
        400
      );
    }

    const sent = await pg.query(
      "SELECT enviado FROM core.transbel_sync WHERE operacion_id = $1",
      [opId]
    );
    if (sent.rows.length > 0 && sent.rows[0].enviado === true) {
      throw new TransbelExcepcionError(
        "No se puede editar la referencia de una operacion ya enviada",
        409
      );
    }

    const poolSql = await getPool();
    const transaction = new sql.Transaction(poolSql);
    await transaction.begin();
    try {
      const opReq = new sql.Request(transaction);
      opReq.input("operacionId", sql.Int, opId);
      const opRes = await opReq.query(
        "SELECT TOP 1 ClienteId, ReferenciaCliente FROM dbo.CME_Operacion WITH (UPDLOCK, HOLDLOCK) WHERE OperacionId = @operacionId"
      );
      if (opRes.recordset.length === 0) {
        throw new TransbelExcepcionError("Operacion no encontrada", 404);
      }
      const op = opRes.recordset[0];
      if (Number(op.ClienteId) !== CLIENTE_ID) {
        throw new TransbelExcepcionError(
          "La operacion no pertenece al cliente Transbel",
          400
        );
      }
      anterior = op.ReferenciaCliente;

      const exReq = new sql.Request(transaction);
      exReq.input("operacionId", sql.Int, opId);
      const exRes = await exReq.query(
        "SELECT TOP 1 EstadoId FROM dbo.CME_RegistroExcepciones WITH(NOLOCK) WHERE OperacionId = @operacionId"
      );
      const ex = exRes.recordset[0];
      if (ex && ex.EstadoId === "F") {
        throw new TransbelExcepcionError(
          "No se puede editar la referencia de una operacion finalizada",
          409
        );
      }

      const upd = new sql.Request(transaction);
      upd.input("operacionId", sql.Int, opId);
      upd.input("referenciaCliente", sql.VarChar(50), ref);
      await upd.query(
        "UPDATE dbo.CME_Operacion SET ReferenciaCliente = @referenciaCliente WHERE OperacionId = @operacionId"
      );

      await transaction.commit();
    } catch (err) {
      try {
        await transaction.rollback();
      } catch (rollbackErr) {
        console.error(
          "transbel_excepciones rollback error:",
          rollbackErr.message
        );
      }
      throw err;
    }

    await recordAudit({
      operacionId: opId,
      accion: "editar_referencia",
      resultado: "ok",
      usuario,
      payload: { anterior, nueva: ref },
    });

    return { operacionId: opId, referenciaCliente: ref, anterior };
  } catch (err) {
    await recordAudit({
      operacionId: opId,
      accion: "editar_referencia",
      resultado: "error",
      usuario,
      motivo: err.message,
      payload: { anterior, nueva: ref },
    });
    if (err instanceof TransbelExcepcionError) throw err;
    throw new TransbelExcepcionError(
      "Error al actualizar la referencia: " + err.message,
      500
    );
  }
}

async function procesarPendiente({ operacionId, usuario }) {
  const opId = Number.parseInt(operacionId, 10);
  if (!Number.isInteger(opId) || opId <= 0) {
    throw new TransbelExcepcionError("operacionId invalido", 400);
  }

  try {
    const pendientes = await listPendientes();
    const row = pendientes.find((p) => p.operacionId === opId);
    if (!row) {
      throw new TransbelExcepcionError(
        "La operacion no figura en excepciones pendientes",
        404
      );
    }
    const esIMA = isAnticipadaIMA(row.patron);
    if (requiereExcepcion(row.diferencia, row.excepcionId, esIMA)) {
      throw new TransbelExcepcionError(
        "Debe asignar una excepcion antes de procesar (mas de 3 dias)",
        409
      );
    }

    const sentRow = await pg.query(
      "SELECT enviado FROM core.transbel_sync WHERE operacion_id = $1",
      [opId]
    );
    const yaEnviado =
      sentRow.rows.length > 0 && sentRow.rows[0].enviado === true;

    let enviados = 0;
    if (!yaEnviado) {
      const sincPendientes = await listSincPendientes(500);
      const sincRow = sincPendientes.find((p) => p.operacionId === opId);
      if (!sincRow) {
        throw new TransbelExcepcionError(
          "La operacion no esta lista para sincronizar (Facturacion o envio previo)",
          409
        );
      }
      if (!sincRow.completo) {
        throw new TransbelExcepcionError(
          "La operacion tiene datos incompletos: " +
            (sincRow.motivo || "sin detalle"),
          409
        );
      }
      const send = await sincronizar({ operacionIds: [opId], limit: 500 });
      enviados = send.enviados || 0;
      if (enviados === 0) {
        throw new TransbelExcepcionError(
          send.detalle || "No se pudo enviar a Workato",
          409
        );
      }
    }

    const finalizado = await finalizarExcepcion({
      operacionId: opId,
      diferencia: row.diferencia,
      excepcionId: row.excepcionId,
      usuario,
    });

    await recordAudit({
      operacionId: opId,
      excepcionId: row.excepcionId,
      accion: "procesar",
      resultado: "ok",
      estadoId: finalizado.estadoId,
      usuario,
      payload: {
        diferencia: row.diferencia,
        enviados,
        yaEnviado,
        finalizado: finalizado.finalizado,
        yaFinalizado: finalizado.yaFinalizado,
        esAnticipadaIMA: esIMA,
      },
    });

    return {
      operacionId: opId,
      enviados,
      yaEnviado,
      estadoId: finalizado.estadoId,
      finalizado: finalizado.finalizado,
      yaFinalizado: finalizado.yaFinalizado,
      esAnticipadaIMA: esIMA,
    };
  } catch (err) {
    await recordAudit({
      operacionId: opId,
      accion: "procesar",
      resultado: "error",
      usuario,
      motivo: err.message,
      payload: buildAuditPayload({
        operacionId: opId,
        accion: "procesar",
        motivo: err.message,
      }),
    });
    if (err instanceof TransbelExcepcionError) throw err;
    const status = /workato/i.test(err.message) ? 502 : 500;
    throw new TransbelExcepcionError(
      "Error al procesar la operacion: " + err.message,
      status
    );
  }
}

async function validarOperacionTransbel(opId) {
  const poolSql = await getPool();
  const req = poolSql.request();
  req.input("operacionId", sql.Int, opId);
  const res = await req.query(
    "SELECT TOP 1 ClienteId FROM dbo.CME_Operacion WITH(NOLOCK) WHERE OperacionId = @operacionId"
  );
  if (res.recordset.length === 0) {
    throw new TransbelExcepcionError("Operacion no encontrada", 404);
  }
  if (Number(res.recordset[0].ClienteId) !== CLIENTE_ID) {
    throw new TransbelExcepcionError(
      "La operacion no pertenece al cliente Transbel",
      400
    );
  }
}

async function ignorarPendiente({ operacionId, usuario, motivo }) {
  const opId = Number.parseInt(operacionId, 10);
  if (!Number.isInteger(opId) || opId <= 0) {
    throw new TransbelExcepcionError("operacionId invalido", 400);
  }
  const texto = motivo == null ? "" : String(motivo).trim();

  try {
    await validarOperacionTransbel(opId);
    await ignorar({
      operacionId: opId,
      usuario,
      motivo: texto || null,
    });
    await recordAudit({
      operacionId: opId,
      accion: "ignorar",
      resultado: "ok",
      usuario,
      motivo: texto || "Ignorado manualmente desde Hermes",
      payload: { motivo: texto || null },
    });
    return { operacionId: opId, ignorado: true };
  } catch (err) {
    await recordAudit({
      operacionId: opId,
      accion: "ignorar",
      resultado: "error",
      usuario,
      motivo: err.message,
      payload: buildAuditPayload({
        operacionId: opId,
        accion: "ignorar",
        motivo: err.message,
      }),
    });
    if (err instanceof TransbelExcepcionError) throw err;
    throw new TransbelExcepcionError(
      "Error al ignorar la operacion: " + err.message,
      500
    );
  }
}

async function restaurarPendiente({ operacionId, usuario }) {
  const opId = Number.parseInt(operacionId, 10);
  if (!Number.isInteger(opId) || opId <= 0) {
    throw new TransbelExcepcionError("operacionId invalido", 400);
  }

  try {
    const restaurado = await restaurar({ operacionId: opId });
    await recordAudit({
      operacionId: opId,
      accion: "restaurar",
      resultado: "ok",
      usuario,
      payload: { restaurado },
    });
    return { operacionId: opId, restaurado };
  } catch (err) {
    await recordAudit({
      operacionId: opId,
      accion: "restaurar",
      resultado: "error",
      usuario,
      motivo: err.message,
      payload: buildAuditPayload({
        operacionId: opId,
        accion: "restaurar",
        motivo: err.message,
      }),
    });
    if (err instanceof TransbelExcepcionError) throw err;
    throw new TransbelExcepcionError(
      "Error al restaurar la operacion: " + err.message,
      500
    );
  }
}

module.exports = {
  listPendientes,
  listPendientesConIgnorados,
  listIgnorados,
  listHistorial,
  getCatalogo,
  asignarExcepcion,
  actualizarReferencia,
  ignorarPendiente,
  restaurarPendiente,
  finalizarExcepcion,
  procesarPendiente,
  recordAudit,
  CLIENTE_ID,
};
