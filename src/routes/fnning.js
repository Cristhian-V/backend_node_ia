const { Router } = require("express");
const { getPool, sql } = require("../db_sqlserver");
const pool = require("../db");
const { authMiddleware } = require("../middleware/auth");
const {
  readExcel, validateHDAV, detectKitLayout,
  extractOperacion, extractItems, mtdCalculo, parseDecimal,
} = require("../services/excel_parser");

const router = Router();

const ALLOWED_SORT_COLS = [
  "OperacionId", "NroRegistro", "Patron", "Recinto",
  "FechaValidacion", "FechaPago", "FechaSalidadeMercancia",
  "Canal", "MonedaId", "FOB", "Flete", "ValorCIF",
  "UsuarioId", "FechaReg", "FechaMod", "UsuarioNombre",
];

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
    op.UsuarioId = req.user.id;

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
      items = extractItems(itemsSheet, datosSheet, partidas, true);
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
          FechaReg, Activo
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
          GETDATE(), 1
        )
      `);
    const operacionId = result.recordset[0].OperacionId;

    const { items } = req.body;
    if (items && Array.isArray(items) && items.length > 0) {
      const transaction = new sql.Transaction(p);
      await transaction.begin();
      try {
        for (const it of items) {
          await transaction.request()
            .input("OperacionId", sql.Int, operacionId)
            .input("NroItem", sql.Int, it.NroItem || 1)
            .input("CodArrancel", sql.VarChar(20), it.CodArrancel || null)
            .input("Descripcion", sql.VarChar(500), it.Descripcion || null)
            .input("Cantidad", sql.Decimal(18, 2), it.Cantidad || null)
            .input("UnidadMedida", sql.VarChar(10), it.UnidadMedida || null)
            .input("ProductoCode", sql.Int, it.ProductoCode || null)
            .input("PartNumber", sql.VarChar(100), it.PartNumber || null)
            .input("ProductoDescripcion", sql.VarChar(500), it.ProductoDescripcion || null)
            .input("FOB", sql.Decimal(18, 2), it.FOB || null)
            .input("Flete", sql.Decimal(18, 2), it.Flete || null)
            .input("Flete2", sql.Decimal(18, 2), it.Flete2 || null)
            .input("Seguro", sql.Decimal(18, 2), it.Seguro || null)
            .input("OtroGastos", sql.Decimal(18, 2), it.OtrosGastos || it.OtroGastos || null)
            .input("OtrasErogaciones", sql.Decimal(18, 2), it.OtrasErogaciones || null)
            .input("PesoBruto", sql.Decimal(18, 2), it.PesoBruto || null)
            .input("PesoNeto", sql.Decimal(18, 2), it.PesoNeto || null)
            .input("Bultos", sql.Decimal(18, 2), it.Bultos || null)
            .input("CantidadSegPart", sql.Decimal(18, 2), it.CantidadSegPart || null)
            .input("CIFUSD", sql.Decimal(18, 2), it.CIFUSD || null)
            .input("CIFBS", sql.Decimal(18, 2), it.CIFBS || null)
            .input("Acuerdo", sql.Decimal(18, 2), it.Acuerdo || null)
            .input("GA", sql.Decimal(18, 2), it.GA || null)
            .input("BaseImponible", sql.Decimal(18, 2), it.BaseImponible || null)
            .input("IVA", sql.Decimal(18, 2), it.IVA || null)
            .input("ICE", sql.Decimal(18, 2), it.ICE || null)
            .input("ICE_ALI", sql.Decimal(18, 2), it.ICE_ALI || null)
            .input("CantLT", sql.Decimal(18, 2), it.CantLT || null)
            .input("IEHD", sql.Decimal(18, 2), it.IEHD || null)
            .input("SIDUNEA", sql.Decimal(18, 2), it.SIDUNEA || null)
            .input("TotalTributos", sql.Decimal(18, 2), it.TotalTributos || null)
            .query(`
              INSERT INTO Item (
                OperacionId, NroItem, CodArrancel, Descripcion, Cantidad, UnidadMedida,
                ProductoCode, PartNumber, ProductoDescripcion,
                FOB, Flete, Flete2, Seguro, OtrosGastos, OtrasErogaciones,
                PesoBruto, PesoNeto, Bultos, CantidadSegPart,
                CIFUSD, CIFBS, Acuerdo, GA, BaseImponible, IVA,
                ICE, ICE_ALI, CantLT, IEHD, SIDUNEA, TotalTributos, Activo
              ) VALUES (
                @OperacionId, @NroItem, @CodArrancel, @Descripcion, @Cantidad, @UnidadMedida,
                @ProductoCode, @PartNumber, @ProductoDescripcion,
                @FOB, @Flete, @Flete2, @Seguro, @OtroGastos, @OtrasErogaciones,
                @PesoBruto, @PesoNeto, @Bultos, @CantidadSegPart,
                @CIFUSD, @CIFBS, @Acuerdo, @GA, @BaseImponible, @IVA,
                @ICE, @ICE_ALI, @CantLT, @IEHD, @SIDUNEA, @TotalTributos, 1
              )
            `);
        }
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

    const esc = (v) => String(v || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    const d = (v) => v != null ? Number(v).toFixed(2) : "0.00";
    const di = (v) => v != null ? Math.round(Number(v)) : 0;
    const dt = (v) => v ? new Date(v).toISOString().slice(0, 19) : "";

    const exp = (tp, val) => {
      const n = Number(val) || 0;
      if (n === 0 && tp === "OTROS GASTOS") return "";
      return `      <expenseType>${tp}</expenseType>\n      <expenseValue>${d(val)}</expenseValue>\n      <expenseCurrency>USD</expenseCurrency>`;
    };
    const expLine = (tp, val, indent = "    ") => {
      const n = Number(val) || 0;
      if (n === 0 && tp === "OTROS GASTOS") return "";
      return `${indent}<declarationExpense>\n${indent}  <expenseType>${tp}</expenseType>\n${indent}  <expenseValue>${d(val)}</expenseValue>\n${indent}  <expenseCurrency>USD</expenseCurrency>\n${indent}</declarationExpense>\n`;
    };
    const expItem = (tp, val, indent = "      ") => {
      const n = Number(val) || 0;
      if (n === 0 && tp === "OTROS GASTOS") return "";
      return `${indent}<declarationItemExpense>\n${indent}  <expenseType>${tp}</expenseType>\n${indent}  <expenseValue>${d(val)}</expenseValue>\n${indent}  <expenseCurrency>USD</expenseCurrency>\n${indent}</declarationItemExpense>\n`;
    };
    const expProd = (tp, val, indent = "        ") => {
      const n = Number(val) || 0;
      if (n === 0 && tp === "OTROS GASTOS") return "";
      return `${indent}<productExpense>\n${indent}  <expenseType>${tp}</expenseType>\n${indent}  <expenseValue>${d(val)}</expenseValue>\n${indent}  <expenseCurrency>USD</expenseCurrency>\n${indent}</productExpense>\n`;
    };
    const entityBlock = (tp, e, indent = "    ") => {
      if (!e) return "";
      return `${indent}<declarationEntity>\n${indent}  <entityType>${tp}</entityType>\n${indent}  <entityReferenceCode>${esc(e.Nit)}</entityReferenceCode>\n${indent}  <entityName>${esc(e.Nombre)}</entityName>\n${indent}  <entityCountry>${esc(e.Pais)}</entityCountry>\n${indent}  <entityAddress>${esc(e.Direccion)}</entityAddress>\n${indent}  <entityCity>${esc(e.Ciudad)}</entityCity>\n${indent}  <entityState>${esc(e.Estado)}</entityState>\n${indent}  <entityPostalCode>${esc(e.DireccionPostal)}</entityPostalCode>\n${indent}  <entityPhone>${esc(e.Telefono)}</entityPhone>\n${indent}</declarationEntity>\n`;
    };
    const entityItem = (tp, e, indent = "      ") => {
      if (!e) return "";
      return `${indent}<declarationItemEntity>\n${indent}  <entityType>${tp}</entityType>\n${indent}  <entityReferenceCode>${esc(e.Nit)}</entityReferenceCode>\n${indent}  <entityName>${esc(e.Nombre)}</entityName>\n${indent}  <entityCountry>${esc(e.Pais)}</entityCountry>\n${indent}  <entityAddress>${esc(e.Direccion)}</entityAddress>\n${indent}  <entityCity>${esc(e.Ciudad)}</entityCity>\n${indent}  <entityState>${esc(e.Estado)}</entityState>\n${indent}  <entityPostalCode>${esc(e.DireccionPostal)}</entityPostalCode>\n${indent}  <entityPhone>${esc(e.Telefono)}</entityPhone>\n${indent}</declarationItemEntity>\n`;
    };
    const dutyBlock = (tp, val, base, pct, indent = "    ") =>
      `${indent}<declarationDuty>\n${indent}  <dutyType>${tp}</dutyType>\n${indent}  <dutyValue>${di(val)}</dutyValue>\n${indent}  <dutyCurrency>BOB</dutyCurrency>\n${indent}  <dutyBasisOfCalculus>${di(base)}</dutyBasisOfCalculus>\n${indent}  <dutyPercentage>${pct}</dutyPercentage>\n${indent}</declarationDuty>\n`;
    const dutyItem = (tp, val, base, pct, indent = "      ") =>
      `${indent}<declarationItemDuty>\n${indent}  <dutyType>${tp}</dutyType>\n${indent}  <dutyValue>${di(val)}</dutyValue>\n${indent}  <dutyCurrency>BOB</dutyCurrency>\n${indent}  <dutyBasisOfCalculus>${di(base)}</dutyBasisOfCalculus>\n${indent}  <dutyPercentage>${pct}</dutyPercentage>\n${indent}</declarationItemDuty>\n`;
    const dutyProd = (tp, val, base, pct, indent = "        ") =>
      `${indent}<productDuty>\n${indent}  <dutyType>${tp}</dutyType>\n${indent}  <dutyValue>${di(val)}</dutyValue>\n${indent}  <dutyCurrency>BOB</dutyCurrency>\n${indent}  <dutyBasicOfCalculus>${di(base)}</dutyBasicOfCalculus>\n${indent}  <dutyPercentage>${pct}</dutyPercentage>\n${indent}</productDuty>\n`;

    let xml = `<?xml version="1.0" encoding="iso-8859-1"?>\n`;
    xml += `<Broker2Softway xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\n`;
    xml += `  <importDeclaration>\n`;
    xml += `    <declarationNumber>${esc(op.NroRegistro)}</declarationNumber>\n`;
    xml += `    <declarationType>IMA4</declarationType>\n`;
    xml += `    <declarationCustomsHouse>${esc(op.RecintoOriginal || op.Recinto)}</declarationCustomsHouse>\n`;
    xml += `    <declarationProcessReferenceCode>${esc(op.Tramite)}</declarationProcessReferenceCode>\n`;
    xml += `    <declarationBrokerReferenceCode>${esc(op.Tramite)}</declarationBrokerReferenceCode>\n`;

    for (const [et, edt] of [["Validacion", "FechaValidacion"], ["Pago", "FechaPago"], ["Salida de Mercancia", "FechaSalidadeMercancia"]]) {
      xml += `    <declarationEvent>\n      <eventType>${et}</eventType>\n      <eventDateTime>${dt(op[edt])}</eventDateTime>\n    </declarationEvent>\n`;
    }

    xml += `    <declarationChannel>${esc(op.Canal)}</declarationChannel>\n`;
    xml += entityBlock("Broker", entidades["BrokerId"]);
    xml += entityBlock("Importer", entidades["ImporterId"]);

    xml += `    <declarationFOBValue>${d(op.FOB)}</declarationFOBValue>\n`;
    xml += expLine("FLETE", op.Flete);
    xml += expLine("FYS_FLETE", op.Flete2);
    xml += expLine("FYS_SEGURO", op.Seguro);
    xml += expLine("SEGURO", op.Seguro);
    xml += expLine("OTROS GASTOS", op.OtroGastos);

    const cif = (Number(op.FOB) || 0) + (Number(op.Flete) || 0) + (Number(op.Seguro) || 0);
    xml += `    <declarationCIFValue>${cif.toFixed(2)}</declarationCIFValue>\n`;
    xml += `    <declarationUSDRate>${d(op.TC)}</declarationUSDRate>\n`;
    const customsVal = Math.round(cif * (Number(op.TC) || 0));
    xml += `    <declarationCustomsValue>${customsVal}</declarationCustomsValue>\n`;

    xml += dutyBlock("GA", op.GA, "", "");
    xml += dutyBlock("IVA", op.IVA, "", "");
    xml += dutyBlock("USO SIDUNEA ++", op.ImpSIDUNEA, "", "");

    xml += `    <declarationNetWeight>${d(op.PesoNeto)}</declarationNetWeight>\n`;
    xml += `    <declarationGrossWeight>${d(op.PesoBruto)}</declarationGrossWeight>\n`;

    for (const it of items.recordset) {
      xml += `    <declarationItem>\n`;
      xml += `      <declarationItemSequenceNumber>${it.NroItem || 1}</declarationItemSequenceNumber>\n`;
      xml += `      <declarationItemHTS>${esc(it.CodArrancel)}</declarationItemHTS>\n`;
      xml += `      <declarationItemHTSDescription>${esc(it.Descripcion || it.ProductoDescripcion)}</declarationItemHTSDescription>\n`;
      xml += `      <declarationItemStatisticalQuantity>${d(it.Cantidad)}</declarationItemStatisticalQuantity>\n`;
      xml += `      <declarationItemStatisticalUnity>${esc(it.UnidadMedida)}</declarationItemStatisticalUnity>\n`;
      xml += `      <declarationItemIncoterm>${esc(op.Incoterm)}</declarationItemIncoterm>\n`;
      xml += `      <declarationItemCurrency>${esc(op.MonedaId)}</declarationItemCurrency>\n`;

      xml += entityItem("Exporter", entidades["ExporterId"]);
      xml += entityItem("Manufacturer", entidades["ManufacturerId"]);

      xml += `      <declarationItemFOBValue>${d(it.FOB)}</declarationItemFOBValue>\n`;
      xml += expItem("FLETE", it.Flete);
      xml += expItem("FYS_FLETE", it.Flete2);
      xml += expItem("FYS_SEGURO", it.Seguro);
      xml += expItem("SEGURO", it.Seguro);
      xml += expItem("OTROS GASTOS", it.OtroGastos);

      const itemCif = (Number(it.FOB) || 0) + (Number(it.Flete) || 0) + (Number(it.Seguro) || 0);
      xml += `      <declarationItemCIFValue>${itemCif.toFixed(2)}</declarationItemCIFValue>\n`;
      const itemCustoms = Math.round(itemCif * (Number(op.TC) || 0));
      xml += `      <declarationItemCustomsValue>${itemCustoms}</declarationItemCustomsValue>\n`;

      const gaPct = (Number(it.GA) || 0) > 0 ? "5.00" : "";
      xml += dutyItem("GA", it.GA, it.BaseImponible, gaPct);
      xml += dutyItem("IVA", it.IVA, it.BaseImponible, "14.94");
      xml += dutyItem("USO SIDUNEA ++", it.SIDUNEA, "", "");

      xml += `      <declarationItemNetWeight>${d(it.PesoNeto)}</declarationItemNetWeight>\n`;
      xml += `      <declarationItemGrossWeight>${d(it.PesoBruto)}</declarationItemGrossWeight>\n`;

      xml += `      <declarationItemProduct>\n`;
      xml += `        <productReferenceCode>${esc(it.ProductoCode)}</productReferenceCode>\n`;
      xml += `        <productReferenceCodeKit></productReferenceCodeKit>\n`;
      xml += `        <productSequenceNumber>${it.NroItem || 1}</productSequenceNumber>\n`;
      xml += `        <productPartNumber>${esc(it.PartNumber)}</productPartNumber>\n`;
      xml += `        <productDescription>${esc(it.ProductoDescripcion)}</productDescription>\n`;
      xml += `        <productQuantity>${d(it.Cantidad)}</productQuantity>\n`;
      xml += `        <productUnityFOBValue>${(Number(it.FOB || 0) / Math.max(1, Number(it.Cantidad || 1))).toFixed(2)}</productUnityFOBValue>\n`;
      xml += `        <productTotalFobValue>${d(it.FOB)}</productTotalFobValue>\n`;
      xml += expProd("FLETE", it.Flete);
      xml += expProd("FYS_FLETE", it.Flete2);
      xml += expProd("FYS_SEGURO", it.Seguro);
      xml += expProd("SEGURO", it.Seguro);
      xml += expProd("OTROS GASTOS", it.OtroGastos);
      const unityCif = itemCif / Math.max(1, Number(it.Cantidad || 1));
      xml += `        <productUnityCIFValue>${unityCif.toFixed(2)}</productUnityCIFValue>\n`;
      xml += `        <productCIFValue>${itemCif.toFixed(2)}</productCIFValue>\n`;
      xml += `        <productCustomsValue>${itemCustoms}</productCustomsValue>\n`;
      const gaPctProduct = (Number(it.GA) || 0) > 0 ? "5.00" : (it.CodArrancel && it.CodArrancel !== "0" ? "0.00" : "");
      xml += dutyProd("GA", it.GA, it.BaseImponible, gaPctProduct);
      xml += dutyProd("IVA", it.IVA, it.BaseImponible, "14.94");
      xml += dutyProd("USO SIDUNEA ++", it.SIDUNEA, "", "");
      xml += `        <productUnityNetWeight>${(Number(it.PesoNeto || 0) / Math.max(1, Number(it.Cantidad || 1))).toFixed(2)}</productUnityNetWeight>\n`;
      xml += `        <productNetWeight>${d(it.PesoNeto)}</productNetWeight>\n`;
      xml += `      </declarationItemProduct>\n`;
      xml += `    </declarationItem>\n`;
    }

    xml += `  </importDeclaration>\n`;
    xml += `</Broker2Softway>`;

    const filename = `BO_CUMBRE_B2S_${op.Tramite || "00000-00"}_${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}.xml`;
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
