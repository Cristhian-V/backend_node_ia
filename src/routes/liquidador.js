const { Router } = require("express");
const pool = require("../db");
const { authMiddleware } = require("../middleware/auth");

const router = Router();

router.get("/tc", authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT TO_CHAR(fecha, 'YYYY-MM-DD') AS fecha, compra, venta FROM core.tipo_cambio ORDER BY fecha DESC LIMIT 1"
    );
    if (result.rows.length === 0) {
      return res.json(null);
    }
    const row = result.rows[0];
    return res.json({
      fecha: row.fecha,
      compra: parseFloat(row.compra),
      venta: parseFloat(row.venta),
    });
  } catch (err) {
    console.error("tc error:", err);
    return res.status(500).json({ detail: "Error interno" });
  }
});

router.get("/tc/historico", authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT TO_CHAR(fecha, 'YYYY-MM-DD') AS fecha, compra, venta FROM core.tipo_cambio ORDER BY fecha DESC"
    );
    return res.json(
      result.rows.map((row) => ({
        fecha: row.fecha,
        compra: parseFloat(row.compra),
        venta: parseFloat(row.venta),
      }))
    );
  } catch (err) {
    console.error("tc historico error:", err);
    return res.status(500).json({ detail: "Error interno" });
  }
});

module.exports = router;
