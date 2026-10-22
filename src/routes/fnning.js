const { Router } = require("express");
const { getPool, sql } = require("../db_sqlserver");
const pool = require("../db");
const { authMiddleware } = require("../middleware/auth");
const {
  readExcel, validateHDAV, detectKitLayout,
  extractOperacion, extractItems, mtdCalculo, parseDecimal,
} = require("../services/excel_parser");
const { buildDeclaracionXml } = require("../services/fnning_xml");

const router = Router();

const ALLOWED_SORT_COLS = [
  "OperacionId", "NroRegistro", "Patron", "Recinto",
  "FechaValidacion", "FechaPago", "FechaSalidadeMercancia",
  "Canal", "MonedaId", "FOB", "Flete", "ValorCIF",
  "UsuarioId", "FechaReg", "FechaMod", "UsuarioNombre",
];

const ITEMS_CHUNK_SIZE = 50;

const ITEM_FIELDS = [
  { name: "NroItem", type: () => sql.Int, value: (it) => it.NroItem || 1 },
  { name: "CodArrancel", type: () => sql.VarChar(20), value: (it) => it.CodArrancel || null },
  { name: "Descripcion", type: () => sql.VarChar(500), value: (it) => it.Descripcion || null },
  { name: "Cantidad", type: () => sql.Decimal(18, 2), value: (it) => it.Cantidad || null },
  { name: "UnidadMedida", type: () => sql.VarChar(10), value: (it) => it.UnidadMedida || null },
  { name: "ProductoCode", type: () => sql.Int, value: (it) => it.ProductoCode || null },
  { name: "PartNumber", type: () => sql.VarChar(100), value: (it) => it.PartNumber || null },
  { name: "ProductoDescripcion", type: () => sql.VarChar(500), value: (it) => it.ProductoDescripcion || null },
  { name: "FOB", type: () => sql.Decimal(18, 2), value: (it) => it.FOB || null },
  { name: "Flete", type: () => sql.Decimal(18, 2), value: (it) => it.Flete || null },
  { name: "Flete2", type: () => sql.Decimal(18, 2), value: (it) => it.Flete2 || null },
  { name: "Seguro", type: () => sql.Decimal(18, 2), value: (it) => it.Seguro || null },
  { name: "OtrosGastos", type: () => sql.Decimal(18, 2), value: (it) => it.OtrosGastos || it.OtroGastos || null },
  { name: "OtrasErogaciones", type: () => sql.Decimal(18, 2), value: (it) => it.OtrasErogaciones || null },
  { name: "PesoBruto", type: () => sql.Decimal(18, 2), value: (it) => it.PesoBruto || null },
  { name: "PesoNeto", type: () => sql.Decimal(18, 2), value: (it) => it.PesoNeto || null },
  { name: "Bultos", type: () => sql.Decimal(18, 2), value: (it) => it.Bultos || null },
  { name: "CantidadSegPart", type: () => sql.Decimal(18, 2), value: (it) => it.CantidadSegPart || null },
  { name: "CIFUSD", type: () => sql.Decimal(18, 2), value: (it) => it.CIFUSD || null },
  { name: "CIFBS", type: () => sql.Decimal(18, 2), value: (it) => it.CIFBS || null },
  { name: "Acuerdo", type: () => sql.Decimal(18, 2), value: (it) => it.Acuerdo || null },
  { name: "GA", type: () => sql.Decimal(18, 2), value: (it) => (it.GA ?? null) },
  { name: "BaseImponible", type: () => sql.Decimal(18, 2), value: (it) => it.BaseImponible || null },
  { name: "IVA", type: () => sql.Decimal(18, 2), value: (it) => it.IVA || null },
  { name: "ICE", type: () => sql.Decimal(18, 2), value: (it) => it.ICE || null },
  { name: "ICE_ALI", type: () => sql.Decimal(18, 2), value: (it) => it.ICE_ALI || null },
  { name: "CantLT", type: () => sql.Decimal(18, 2), value: (it) => it.CantLT || null },
  { name: "IEHD", type: () => sql.Decimal(18, 2), value: (it) => it.IEHD || null },
  { name: "SIDUNEA", type: () => sql.Decimal(18, 2), value: (it) => it.SIDUNEA || null },
  { name: "TotalTributos", type: () => sql.Decimal(18, 2), value: (it) => it.TotalTributos || null },
];

async function insertItems(conn, operacionId, items) {
  const columns = ["OperacionId", ...ITEM_FIELDS.map((f) => f.name), "Activo"];
  const colSql = columns.join(", ");

  for (let start = 0; start < items.length; start += ITEMS_CHUNK_SIZE) {
    const chunk = items.slice(start, start + ITEMS_CHUNK_SIZE);
    const request = conn.request();
    request.input("OperacionId", sql.Int, operacionId);

    const valueRows = chunk.map((it, idx) => {
      const params = ITEM_FIELDS.map((f) => {
        const pname = `p${idx}_${f.name}`;
        request.input(pname, f.type(), f.value(it));
        return `@${pname}`;
      });
      return `(@OperacionId, ${params.join(", ")}, 1)`;
    });

    await request.query(`INSERT INTO Item (${colSql}) VALUES ${valueRows.join(", ")}`);
  }
}

router.use(authMiddleware);

router.use(async (req, res, next) => {
  try {
    const toolsResult = await pool.query(
      "SELECT tool_key FROM core.user_tools WHERE user_id = $1",
      [req.user.id]
    );
    const hasFnning = toolsResult.rows.some(
      (t) => t.tool_key === "fnning"
    );
    if (!hasFnning && !req.user.is_admin) {
      return res.status(403).json({ detail: "Acceso denegado" });
    }
    next();
  } catch (err) {
    return res.status(500).json({ detail: "Error verificando permisos" });
  }
});

router.get("/operaciones", async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const size = Math.min(100, Math.max(1, parseInt(req.query.size) || 30));
    const offset = (page - 1) * size;

    const orderBy = ALLOWED_SORT_COLS.includes(req.query.sort)
      ? req.query.sort
      : "OperacionId";
    const orderDir = req.query.dir === "asc" ? "ASC" : "DESC";

    const p = await getPool();

    const countResult = await p.request().query("SELECT COUNT(*) AS total FROM Operacion");
    const total = countResult.recordset[0].total;

    const dataResult = await p.request()
      .input("offset", sql.Int, offset)
      .input("size", sql.Int, size)
      .query(`
        SELECT
          o.OperacionId, o.NroRegistro, o.Patron, o.Recinto,
          o.FechaValidacion, o.FechaPago, o.FechaSalidadeMercancia,
          o.Canal, o.MonedaId, o.FOB, o.Flete, o.ValorCIF,
          o.UsuarioId, u.NombreCompleto AS UsuarioNombre,
          o.FechaReg, o.FechaMod
        FROM Operacion o
        LEFT JOIN Usuarios u ON o.UsuarioId = u.UsuarioId
        ORDER BY ${orderBy} ${orderDir}
        OFFSET @offset ROWS
        FETCH NEXT @size ROWS ONLY
      `);

    return res.json({
      data: dataResult.recordset,
      total,
      page,
      size,
      pages: Math.ceil(total / size),
    });
  } catch (err) {
    console.error("fnning list error:", err);
    return res.status(500).json({ detail: "Error al listar operaciones" });
  }
});

router.post("/operaciones/parse-excel", async (req, res) => {
  try {
    if (!req.files || !req.files.excel) {
      return res.status(400).json({ detail: "Archivo Excel requerido (campo: excel)" });
    }

    const file = req.files.excel;
    const extension = file.name.toLowerCase().split(".").pop();
    if (!["xls", "xlsx", "xlsm"].includes(extension)) {
      return res.status(400).json({ detail: "Formato no soportado. Use .xls, .xlsx o .xlsm" });
    }

    const hdav = readExcel(file.data, "HDAV");
    const itemsSheet = readExcel(file.data, "ITEMS");
    const datosSheet = readExcel(file.data, "DATOSRECIBIDOS");

    const errors = validateHDAV(hdav);
    if (errors.length > 0) {
      return res.status(400).json({ detail: `Errores de validacion:\n${errors.join("\n")}` });
    }

    detectKitLayout(hdav);
    const op = extractOperacion(hdav, itemsSheet, req.user);
    op.UsuarioId = req.user.usuario_integre ?? null;

    const p = await getPool();
    const partidasResult = await p.request().query(
      "SELECT CAST(ArancelId AS VARCHAR(20)) AS prdId, Descripcion AS prdDesc, CAST(GA AS FLOAT) AS GA, ISNULL(IC_IEHD, '') AS IC_IEHD, ISNULL(UnidadMedida, '') AS UnidadMedida FROM Arancel"
    );
    const partidas = {};
    for (const row of partidasResult.recordset) {
      partidas[row.prdId] = row;
    }

    let items;
    try {
      items = extractItems(itemsSheet, datosSheet, partidas, false);
    } catch (e) {
      return res.status(400).json({ detail: e.message });
    }

    if (!items || items.length === 0) {
      return res.status(400).json({ detail: "No se encontraron items en el archivo" });
    }

    /**
     * NOTA: El Excel solo contiene FOB, Cantidad y algunos impuestos por item.
     * Las columnas Flete, Seguro, CIF, GA, IVA, etc. son VALORES CALCULADOS
     * que se generan al hacer clic en el boton "Ajustar" (prorrateo).
     * Sin el ajuste, esos campos aparecen en 0.00 porque no existen en el Excel.
     */
    const opResponse = {};
    for (const [k, v] of Object.entries(op)) {
      opResponse[k] = v;
    }

    return res.json({ operacion: opResponse, items });
  } catch (err) {
    console.error("fnning parse error:", err);
    return res.status(500).json({ detail: "Error al procesar el archivo: " + err.message });
  }
});

router.post("/operaciones/recalcular", async (req, res) => {
  try {
    const { operacion, items } = req.body;
    if (!operacion || !items || !Array.isArray(items)) {
      return res.status(400).json({ detail: "Se requieren operacion e items" });
    }

    const op = { ...operacion };

    /**
     * RECALCULO DESDE FORMULARIO (boton "Ajustar")
     * 
     * Misma logica que post-carga del Excel pero usando los valores ACTUALES
     * del formulario (que el usuario pudo haber editado manualmente):
     *   1. Prorratea los costos actuales a cada item segun % FOB
     *   2. Recalcula GA, IVA, CIF por item con los valores vigentes
     *   3. Ajusta diferencias de redondeo al ultimo item
     * 
     * Esto permite que si el usuario cambia manualmente el FOB total,
     * el Flete, o cualquier valor en la seccion Valores, al hacer clic
     * en "Ajustar" los items se recalculen distribuyendo las diferencias.
     */
    const calc = mtdCalculo(op, items);

    return res.json({ operacion: op, items, calc });
  } catch (err) {
    console.error("fnning recalcular error:", err);
    return res.status(500).json({ detail: "Error al recalcular: " + err.message });
  }
});

router.post("/operaciones", async (req, res) => {
  try {
    const p = await getPool();
    const {
      NroRegistro, Tramite, Patron, Incoterm, Recinto,
      FechaValidacion, BrokerId, FechaPago, ImporterId,
      FechaSalidadeMercancia, ExporterId, Canal, ManufacturerId,
      FOB, TC, MonedaId, Flete, PesoBruto, PesoNeto,
      Flete2, Seguro, Bultos, OtroGastos, ImpSIDUNEA, OtrasErogaciones,
      ValorCIF, ValorCIFBS, GA, IVA, UserName,
      EstadoMercancia, Contenedor, DocEmbarque, IdConten1, IdConten2,
      IdConten3, Embalaje, ReferenciaInt, Regimen, Proveedor,
      MercanciaPeligrosa, NITImportador,
    } = req.body;

    const result = await p.request()
      .input("NroRegistro", sql.VarChar(18), NroRegistro || null)
      .input("Tramite", sql.VarChar(24), Tramite || null)
      .input("Patron", sql.VarChar(50), Patron || null)
      .input("Incoterm", sql.VarChar(25), Incoterm || null)
      .input("Recinto", sql.Int, Recinto ? parseInt(Recinto) : null)
      .input("FechaValidacion", sql.DateTime, FechaValidacion || null)
      .input("BrokerId", sql.Int, BrokerId ? parseInt(BrokerId) : null)
      .input("FechaPago", sql.DateTime, FechaPago || null)
      .input("ImporterId", sql.Int, ImporterId ? parseInt(ImporterId) : null)
      .input("FechaSalidadeMercancia", sql.DateTime, FechaSalidadeMercancia || null)
      .input("ExporterId", sql.Int, ExporterId ? parseInt(ExporterId) : null)
      .input("Canal", sql.VarChar(10), Canal || null)
      .input("ManufacturerId", sql.Int, ManufacturerId ? parseInt(ManufacturerId) : null)
      .input("FOB", sql.Decimal(18, 2), FOB || null)
      .input("TC", sql.Decimal(18, 2), TC || null)
      .input("MonedaId", sql.VarChar(5), MonedaId || null)
      .input("Flete", sql.Decimal(18, 2), Flete || null)
      .input("PesoBruto", sql.Decimal(18, 2), PesoBruto || null)
      .input("PesoNeto", sql.Decimal(18, 2), PesoNeto || null)
      .input("Flete2", sql.Decimal(18, 2), Flete2 || null)
      .input("Seguro", sql.Decimal(18, 2), Seguro || null)
      .input("Bultos", sql.Decimal(18, 2), Bultos || null)
      .input("OtroGastos", sql.Decimal(18, 2), OtroGastos || null)
      .input("ImpSIDUNEA", sql.Decimal(18, 2), ImpSIDUNEA || null)
      .input("OtrasErogaciones", sql.Decimal(18, 2), OtrasErogaciones || null)
      .input("ValorCIF", sql.Decimal(18, 2), ValorCIF || null)
      .input("ValorCIFBS", sql.Decimal(18, 2), ValorCIFBS || null)
      .input("GA", sql.Decimal(18, 2), GA || null)
      .input("IVA", sql.Decimal(18, 2), IVA || null)
      .input("EstadoMercancia", sql.VarChar(50), EstadoMercancia || null)
      .input("Contenedor", sql.VarChar(50), Contenedor || null)
      .input("DocEmbarque", sql.VarChar(50), DocEmbarque || null)
      .input("IdConten1", sql.VarChar(50), IdConten1 || null)
      .input("IdConten2", sql.VarChar(50), IdConten2 || null)
      .input("IdConten3", sql.VarChar(50), IdConten3 || null)
      .input("Embalaje", sql.VarChar(50), Embalaje || null)
      .input("ReferenciaInt", sql.VarChar(50), ReferenciaInt || null)
      .input("Regimen", sql.VarChar(50), Regimen || null)
      .input("Proveedor", sql.VarChar(120), Proveedor || null)
      .input("MercanciaPeligrosa", sql.VarChar(50), MercanciaPeligrosa || null)
      .input("NITImportador", sql.VarChar(20), NITImportador || null)
      .input("UsuarioId", sql.Int, req.user.usuario_integre || null)
      .query(`
        INSERT INTO Operacion (
          NroRegistro, Tramite, Patron, Incoterm, Recinto,
          FechaValidacion, BrokerId, FechaPago, ImporterId,
          FechaSalidadeMercancia, ExporterId, Canal, ManufacturerId,
          FOB, TC, MonedaId, Flete, PesoBruto, PesoNeto,
          Flete2, Seguro, Bultos, OtroGastos, ImpSIDUNEA, OtrasErogaciones,
          ValorCIF, ValorCIFBS, GA, IVA,
          EstadoMercancia, Contenedor, DocEmbarque, IdConten1, IdConten2,
          IdConten3, Embalaje, ReferenciaInt, Regimen, Proveedor,
          MercanciaPeligrosa, NITImportador,
          UsuarioId, FechaReg, Activo
        )
        OUTPUT INSERTED.OperacionId
        VALUES (
          @NroRegistro, @Tramite, @Patron, @Incoterm, @Recinto,
          @FechaValidacion, @BrokerId, @FechaPago, @ImporterId,
          @FechaSalidadeMercancia, @ExporterId, @Canal, @ManufacturerId,
          @FOB, @TC, @MonedaId, @Flete, @PesoBruto, @PesoNeto,
          @Flete2, @Seguro, @Bultos, @OtroGastos, @ImpSIDUNEA, @OtrasErogaciones,
          @ValorCIF, @ValorCIFBS, @GA, @IVA,
          @EstadoMercancia, @Contenedor, @DocEmbarque, @IdConten1, @IdConten2,
          @IdConten3, @Embalaje, @ReferenciaInt, @Regimen, @Proveedor,
          @MercanciaPeligrosa, @NITImportador,
          @UsuarioId, GETDATE(), 1
        )
      `);
    const operacionId = result.recordset[0].OperacionId;

    const { items } = req.body;
    if (items && Array.isArray(items) && items.length > 0) {
      const transaction = new sql.Transaction(p);
      await transaction.begin();
      try {
        await insertItems(transaction, operacionId, items);
        await transaction.commit();
      } catch (itemErr) {
        await transaction.rollback();
        await p.request().input("id", sql.Int, operacionId).query("DELETE FROM Operacion WHERE OperacionId = @id");
        console.error("fnning items insert error:", itemErr);
        return res.status(500).json({ detail: "Error al guardar items: " + itemErr.message });
      }
    }

    return res.status(201).json({ OperacionId: operacionId, detail: "Operacion creada" });
  } catch (err) {
    console.error("fnning create error:", err);
    return res.status(500).json({ detail: "Error al crear operacion" });
  }
});

router.get("/operaciones/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ detail: "ID invalido" });

    const p = await getPool();
    const result = await p.request()
      .input("id", sql.Int, id)
      .query("SELECT * FROM Operacion WHERE OperacionId = @id");

    if (result.recordset.length === 0) {
      return res.status(404).json({ detail: "Operacion no encontrada" });
    }

    return res.json(result.recordset[0]);
  } catch (err) {
    console.error("fnning detail error:", err);
    return res.status(500).json({ detail: "Error al obtener operacion" });
  }
});

router.get("/operaciones/:id/full", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ detail: "ID invalido" });

    const p = await getPool();

    const opResult = await p.request()
      .input("id", sql.Int, id)
      .query("SELECT * FROM Operacion WHERE OperacionId = @id");

    if (opResult.recordset.length === 0) {
      return res.status(404).json({ detail: "Operacion no encontrada" });
    }

    const itemsResult = await p.request()
      .input("id", sql.Int, id)
      .query("SELECT * FROM Item WHERE OperacionId = @id");

    return res.json({
      operacion: opResult.recordset[0],
      items: itemsResult.recordset,
    });
  } catch (err) {
    console.error("fnning full error:", err);
    return res.status(500).json({ detail: "Error al obtener operacion completa" });
  }
});

router.get("/operaciones/:id/xml", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ detail: "ID invalido" });
    const p = await getPool();

    const opResult = await p.request().input("id", sql.Int, id)
      .query("SELECT o.* FROM Operacion o WHERE o.OperacionId = @id");
    if (opResult.recordset.length === 0) return res.status(404).json({ detail: "Operacion no encontrada" });
    const op = opResult.recordset[0];

    const items = await p.request().input("id", sql.Int, id)
      .query("SELECT * FROM Item WHERE OperacionId = @id ORDER BY NroItem");

    const entidades = {};
    for (const f of ["BrokerId", "ImporterId", "ExporterId", "ManufacturerId"]) {
      if (op[f]) {
        const er = await p.request().input("id", sql.Int, op[f])
          .query("SELECT * FROM Entidad WHERE EntidadId = @id");
        if (er.recordset.length > 0) entidades[f] = er.recordset[0];
      }
    }

    // lookup Recinto description
    const recintoNum = String(op.Recinto || "").match(/\d+/)?.[0] || "";
    let recintoDesc = "";
    if (recintoNum) {
      const rr = await p.request().input("id", sql.Int, parseInt(recintoNum) || 0)
        .query("SELECT Descripcion FROM Recinto WHERE RecintoId = @id");
      if (rr.recordset.length > 0) recintoDesc = rr.recordset[0].Descripcion || "";
    }

    const xml = buildDeclaracionXml({
      op,
      items: items.recordset,
      entidades,
      recintoDesc,
    });
    const tramite = (op.Tramite || "00000/00").replace("/", "-");
    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const filename = `BO_CUMBRE_B2S_${tramite}_${ts}.xml`;
    res.setHeader("Content-Type", "application/xml");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    return res.send(xml);
  } catch (err) {
    console.error("fnning xml error:", err);
    return res.status(500).json({ detail: "Error al generar XML" });
  }
});

router.get("/operaciones/:id/excel", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ detail: "ID invalido" });
    const p = await getPool();
    const items = await p.request().input("id", sql.Int, id)
      .query("SELECT * FROM Item WHERE OperacionId = @id ORDER BY NroItem");

    const XLSX = require("xlsx");
    const headers = [
      "Nro Item", "Cod Arrancel", "Cantidad", "Unidad Medida", "Producto Code",
      "PartNumber", "Producto Descripcion", "FOB", "Flete", "Flete2", "Seguro",
      "Otros Gastos", "Peso Bruto", "Peso Neto", "Bultos", "Cantidad SegPart",
      "CIFBS", "CIFUSD", "Acuerdo", "GA", "Otras Erogaciones", "Base Imponible",
      "IVA", "ICE", "ICE Alic.", "CantLT", "IEHD", "Uso SIDUNEA++", "Total Tributos",
    ];
    const fields = [
      "NroItem", "CodArrancel", "Cantidad", "UnidadMedida", "ProductoCode",
      "PartNumber", "ProductoDescripcion", "FOB", "Flete", "Flete2", "Seguro",
      "OtroGastos", "PesoBruto", "PesoNeto", "Bultos", "CantidadSegPart",
      "CIFBS", "CIFUSD", "Acuerdo", "GA", "OtrasErogaciones", "BaseImponible",
      "IVA", "ICE", "ICE_ALI", "CantLT", "IEHD", "SIDUNEA", "TotalTributos",
    ];

    const rows = [headers];
    for (const it of items.recordset) {
      rows.push(fields.map((f) => it[f] ?? ""));
    }

    const ws = XLSX.utils.aoa_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Items");
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="items_operacion_${id}.xlsx"`);
    return res.send(buf);
  } catch (err) {
    console.error("fnning excel error:", err);
    return res.status(500).json({ detail: "Error al generar Excel" });
  }
});

router.put("/operaciones/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ detail: "ID invalido" });
    const {
      NroRegistro, Tramite, Patron, Incoterm, Recinto,
      FechaValidacion, BrokerId, FechaPago, ImporterId,
      FechaSalidadeMercancia, ExporterId, Canal, ManufacturerId,
      FOB, TC, MonedaId, Flete, PesoBruto, PesoNeto,
      Flete2,       Seguro, Bultos, OtroGastos, ImpSIDUNEA, OtrasErogaciones,
      ValorCIF, ValorCIFBS, GA, IVA,
      EstadoMercancia, Contenedor, DocEmbarque, IdConten1, IdConten2,
      IdConten3, Embalaje, ReferenciaInt, Regimen, Proveedor,
      MercanciaPeligrosa, NITImportador,
    } = req.body;

    const p = await getPool();
    const result = await p.request()
      .input("id", sql.Int, id)
      .input("NroRegistro", sql.VarChar(18), NroRegistro || null)
      .input("Tramite", sql.VarChar(24), Tramite || null)
      .input("Patron", sql.VarChar(50), Patron || null)
      .input("Incoterm", sql.VarChar(25), Incoterm || null)
      .input("Recinto", sql.Int, Recinto ? parseInt(Recinto) : null)
      .input("FechaValidacion", sql.DateTime, FechaValidacion || null)
      .input("BrokerId", sql.Int, BrokerId ? parseInt(BrokerId) : null)
      .input("FechaPago", sql.DateTime, FechaPago || null)
      .input("ImporterId", sql.Int, ImporterId ? parseInt(ImporterId) : null)
      .input("FechaSalidadeMercancia", sql.DateTime, FechaSalidadeMercancia || null)
      .input("ExporterId", sql.Int, ExporterId ? parseInt(ExporterId) : null)
      .input("Canal", sql.VarChar(10), Canal || null)
      .input("ManufacturerId", sql.Int, ManufacturerId ? parseInt(ManufacturerId) : null)
      .input("FOB", sql.Decimal(18, 2), FOB || null)
      .input("TC", sql.Decimal(18, 2), TC || null)
      .input("MonedaId", sql.VarChar(5), MonedaId || null)
      .input("Flete", sql.Decimal(18, 2), Flete || null)
      .input("PesoBruto", sql.Decimal(18, 2), PesoBruto || null)
      .input("PesoNeto", sql.Decimal(18, 2), PesoNeto || null)
      .input("Flete2", sql.Decimal(18, 2), Flete2 || null)
      .input("Seguro", sql.Decimal(18, 2), Seguro || null)
      .input("Bultos", sql.Decimal(18, 2), Bultos || null)
      .input("OtroGastos", sql.Decimal(18, 2), OtroGastos || null)
      .input("ImpSIDUNEA", sql.Decimal(18, 2), ImpSIDUNEA || null)
      .input("OtrasErogaciones", sql.Decimal(18, 2), OtrasErogaciones || null)
      .input("ValorCIF", sql.Decimal(18, 2), ValorCIF || null)
      .input("ValorCIFBS", sql.Decimal(18, 2), ValorCIFBS || null)
      .input("GA", sql.Decimal(18, 2), GA || null)
      .input("IVA", sql.Decimal(18, 2), IVA || null)
      .input("EstadoMercancia", sql.VarChar(50), EstadoMercancia || null)
      .input("Contenedor", sql.VarChar(50), Contenedor || null)
      .input("DocEmbarque", sql.VarChar(50), DocEmbarque || null)
      .input("IdConten1", sql.VarChar(50), IdConten1 || null)
      .input("IdConten2", sql.VarChar(50), IdConten2 || null)
      .input("IdConten3", sql.VarChar(50), IdConten3 || null)
      .input("Embalaje", sql.VarChar(50), Embalaje || null)
      .input("ReferenciaInt", sql.VarChar(50), ReferenciaInt || null)
      .input("Regimen", sql.VarChar(50), Regimen || null)
      .input("Proveedor", sql.VarChar(120), Proveedor || null)
      .input("MercanciaPeligrosa", sql.VarChar(50), MercanciaPeligrosa || null)
      .input("NITImportador", sql.VarChar(20), NITImportador || null)
      .query(`
        UPDATE Operacion SET
          NroRegistro = @NroRegistro, Tramite = @Tramite, Patron = @Patron,
          Incoterm = @Incoterm, Recinto = @Recinto,
          FechaValidacion = @FechaValidacion, BrokerId = @BrokerId,
          FechaPago = @FechaPago, ImporterId = @ImporterId,
          FechaSalidadeMercancia = @FechaSalidadeMercancia, ExporterId = @ExporterId,
          Canal = @Canal, ManufacturerId = @ManufacturerId,
          FOB = @FOB, TC = @TC, MonedaId = @MonedaId,
          Flete = @Flete, PesoBruto = @PesoBruto, PesoNeto = @PesoNeto,
          Flete2 = @Flete2, Seguro = @Seguro, Bultos = @Bultos,
          OtroGastos = @OtroGastos, ImpSIDUNEA = @ImpSIDUNEA, OtrasErogaciones = @OtrasErogaciones,
          ValorCIF = @ValorCIF, ValorCIFBS = @ValorCIFBS,
          GA = @GA, IVA = @IVA,
          EstadoMercancia = @EstadoMercancia, Contenedor = @Contenedor,
          DocEmbarque = @DocEmbarque, IdConten1 = @IdConten1, IdConten2 = @IdConten2,
          IdConten3 = @IdConten3, Embalaje = @Embalaje, ReferenciaInt = @ReferenciaInt,
          Regimen = @Regimen, Proveedor = @Proveedor, MercanciaPeligrosa = @MercanciaPeligrosa,
          NITImportador = @NITImportador,
          FechaMod = GETDATE()
        WHERE OperacionId = @id
      `);
    if (result.rowsAffected[0] === 0)
      return res.status(404).json({ detail: "Operacion no encontrada" });

    // Delete and re-insert items
    const { items } = req.body;
    if (items && Array.isArray(items) && items.length > 0) {
      await p.request().input("id", sql.Int, id).query("DELETE FROM Item WHERE OperacionId = @id");
      const transaction = new sql.Transaction(p);
      await transaction.begin();
      try {
        await insertItems(transaction, id, items);
        await transaction.commit();
      } catch (itemErr) {
        await transaction.rollback();
        console.error("fnning update items error:", itemErr);
        return res.status(500).json({ detail: "Error al guardar items: " + itemErr.message });
      }
    }

    return res.json({ detail: "Operacion actualizada correctamente" });
  } catch (err) {
    console.error("fnning update error:", err);
    return res.status(500).json({ detail: "Error al actualizar operacion" });
  }
});

router.delete("/operaciones/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ detail: "ID invalido" });

    const p = await getPool();
    await p.request()
      .input("id", sql.Int, id)
      .query("DELETE FROM Item WHERE OperacionId = @id");

    const result = await p.request()
      .input("id", sql.Int, id)
      .query("DELETE FROM Operacion WHERE OperacionId = @id");

    if (result.rowsAffected[0] === 0) {
      return res.status(404).json({ detail: "Operacion no encontrada" });
    }

    return res.json({ detail: "Operacion eliminada correctamente" });
  } catch (err) {
    console.error("fnning delete error:", err);
    return res.status(500).json({ detail: "Error al eliminar operacion" });
  }
});

router.get("/entidades", async (req, res) => {
  try {
    const p = await getPool();
    const result = await p.request().query(`
      SELECT e.*, t.Descripcion AS TipoEntidadDesc
      FROM Entidad e
      LEFT JOIN TipoEntidad t ON e.TipoEntidadId = t.TipoEntidadId
      WHERE e.Activo = 1
      ORDER BY e.Nombre
    `);
    return res.json(result.recordset);
  } catch (err) {
    console.error("fnning entidades error:", err);
    return res.status(500).json({ detail: "Error al listar entidades" });
  }
});

router.post("/entidades", async (req, res) => {
  try {
    const { TipoEntidadId, Nit, Nombre, Pais, Direccion, Ciudad, Estado, DireccionPostal, Telefono, UsuarioId } = req.body;
    const p = await getPool();
    const result = await p.request()
      .input("TipoEntidadId", sql.VarChar(20), TipoEntidadId || null)
      .input("Nit", sql.VarChar(20), Nit || null)
      .input("Nombre", sql.VarChar(120), Nombre || null)
      .input("Pais", sql.VarChar(80), Pais || null)
      .input("Direccion", sql.VarChar(200), Direccion || null)
      .input("Ciudad", sql.VarChar(80), Ciudad || null)
      .input("Estado", sql.VarChar(80), Estado || null)
      .input("DireccionPostal", sql.VarChar(20), DireccionPostal || null)
      .input("Telefono", sql.VarChar(40), Telefono || null)
      .input("UsuarioId", sql.Int, UsuarioId || 0)
      .query(`
        INSERT INTO Entidad (TipoEntidadId, Nit, Nombre, Pais, Direccion, Ciudad, Estado, DireccionPostal, Telefono, UsuarioId, FechaReg, Activo)
        OUTPUT INSERTED.EntidadId
        VALUES (@TipoEntidadId, @Nit, @Nombre, @Pais, @Direccion, @Ciudad, @Estado, @DireccionPostal, @Telefono, @UsuarioId, GETDATE(), 1)
      `);
    return res.status(201).json({ EntidadId: result.recordset[0].EntidadId, detail: "Entidad creada" });
  } catch (err) {
    console.error("fnning entidad create error:", err);
    return res.status(500).json({ detail: "Error al crear entidad" });
  }
});

router.put("/entidades/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ detail: "ID invalido" });
    const { TipoEntidadId, Nit, Nombre, Pais, Direccion, Ciudad, Estado, DireccionPostal, Telefono } = req.body;
    const p = await getPool();
    const result = await p.request()
      .input("id", sql.Int, id)
      .input("TipoEntidadId", sql.VarChar(20), TipoEntidadId || null)
      .input("Nit", sql.VarChar(20), Nit || null)
      .input("Nombre", sql.VarChar(120), Nombre || null)
      .input("Pais", sql.VarChar(80), Pais || null)
      .input("Direccion", sql.VarChar(200), Direccion || null)
      .input("Ciudad", sql.VarChar(80), Ciudad || null)
      .input("Estado", sql.VarChar(80), Estado || null)
      .input("DireccionPostal", sql.VarChar(20), DireccionPostal || null)
      .input("Telefono", sql.VarChar(40), Telefono || null)
      .query(`
        UPDATE Entidad SET
          TipoEntidadId = @TipoEntidadId, Nit = @Nit, Nombre = @Nombre,
          Pais = @Pais, Direccion = @Direccion, Ciudad = @Ciudad,
          Estado = @Estado, DireccionPostal = @DireccionPostal, Telefono = @Telefono,
          FechaModificacion = GETDATE()
        WHERE EntidadId = @id
      `);
    if (result.rowsAffected[0] === 0)
      return res.status(404).json({ detail: "Entidad no encontrada" });
    return res.json({ detail: "Entidad actualizada" });
  } catch (err) {
    console.error("fnning entidad update error:", err);
    return res.status(500).json({ detail: "Error al actualizar entidad" });
  }
});

router.delete("/entidades/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ detail: "ID invalido" });
    const p = await getPool();
    const result = await p.request()
      .input("id", sql.Int, id)
      .query("UPDATE Entidad SET Activo = 0 WHERE EntidadId = @id");
    if (result.rowsAffected[0] === 0)
      return res.status(404).json({ detail: "Entidad no encontrada" });
    return res.json({ detail: "Entidad eliminada" });
  } catch (err) {
    console.error("fnning entidad delete error:", err);
    return res.status(500).json({ detail: "Error al eliminar entidad" });
  }
});

module.exports = router;
