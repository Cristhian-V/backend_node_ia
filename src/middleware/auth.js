const jwt = require("jsonwebtoken");
const config = require("../config");
const pool = require("../db");

async function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ detail: "Token requerido" });
  }

  const token = header.slice(7);
  try {
    const payload = jwt.verify(token, config.secretKey);
    const userId = parseInt(payload.sub);
    if (!userId) throw new Error("Invalid sub");

    const result = await pool.query(
      "SELECT id, email, full_name, is_admin FROM auth.users WHERE id = $1",
      [userId]
    );
    if (result.rows.length === 0) {
      return res.status(401).json({ detail: "Usuario no encontrado" });
    }

    req.user = result.rows[0];
    next();
  } catch (err) {
    return res.status(401).json({ detail: "Token invalido" });
  }
}

async function adminMiddleware(req, res, next) {
  await authMiddleware(req, res, () => {
    if (!req.user.is_admin) {
      return res.status(403).json({ detail: "Acceso denegado: se requiere administrador" });
    }
    next();
  });
}

module.exports = { authMiddleware, adminMiddleware };
