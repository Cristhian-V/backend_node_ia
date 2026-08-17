const { Router } = require("express");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const config = require("../config");
const pool = require("../db");
const { authMiddleware } = require("../middleware/auth");
const { VALID_TOOLS } = require("../constants");

const router = Router();

router.post("/register", async (req, res) => {
  try {
    const { email, password, full_name } = req.body;
    if (!email || !password || !full_name) {
      return res.status(422).json({ detail: "email, password y full_name son requeridos" });
    }
    if (password.length < 6) {
      return res.status(422).json({ detail: "La contrasena debe tener al menos 6 caracteres" });
    }

    const exists = await pool.query("SELECT id FROM auth.users WHERE email = $1", [email]);
    if (exists.rows.length > 0) {
      return res.status(409).json({ detail: "El email ya esta registrado" });
    }

    const hashed = await bcrypt.hash(password, 10);
    const result = await pool.query(
      "INSERT INTO auth.users (email, hashed_password, full_name) VALUES ($1, $2, $3) RETURNING id",
      [email, hashed, full_name]
    );

    const userId = result.rows[0].id;

    // Assign default tool
    await pool.query(
      "INSERT INTO core.user_tools (user_id, tool_key, role) VALUES ($1, $2, $3)",
      [userId, VALID_TOOLS[0], "consultor"]
    );

    const token = jwt.sign({ sub: String(userId) }, config.secretKey, {
      algorithm: "HS256",
      expiresIn: `${config.jwtExpireMinutes}m`,
    });

    return res.status(201).json({ access_token: token, token_type: "bearer" });
  } catch (err) {
    console.error("register error:", err);
    return res.status(500).json({ detail: "Error interno" });
  }
});

router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const result = await pool.query(
      "SELECT id, hashed_password, must_change_password FROM auth.users WHERE email = $1",
      [email]
    );
    if (result.rows.length === 0) {
      return res.status(401).json({ detail: "Email o contrasena incorrectos" });
    }

    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.hashed_password);
    if (!valid) {
      return res.status(401).json({ detail: "Email o contrasena incorrectos" });
    }

    const token = jwt.sign({ sub: String(user.id) }, config.secretKey, {
      algorithm: "HS256",
      expiresIn: `${config.jwtExpireMinutes}m`,
    });

    return res.json({
      access_token: token,
      token_type: "bearer",
      must_change_password: user.must_change_password === true,
    });
  } catch (err) {
    console.error("login error:", err);
    return res.status(500).json({ detail: "Error interno" });
  }
});

router.get("/me", authMiddleware, async (req, res) => {
  try {
    const toolsResult = await pool.query(
      "SELECT tool_key, role FROM core.user_tools WHERE user_id = $1",
      [req.user.id]
    );

    let tools = toolsResult.rows.map(r => ({ tool_key: r.tool_key, role: r.role || null }));

    return res.json({
      id: req.user.id,
      email: req.user.email,
      full_name: req.user.full_name,
      is_admin: req.user.is_admin,
      must_change_password: req.user.must_change_password === true,
      usuario_integre: req.user.usuario_integre ?? null,
      tools: tools,
    });
  } catch (err) {
    console.error("me error:", err);
    return res.status(500).json({ detail: "Error interno" });
  }
});

router.post("/change-password", authMiddleware, async (req, res) => {
  try {
    const { old_password, new_password } = req.body;
    if (!old_password || !new_password) {
      return res.status(422).json({ detail: "old_password y new_password son requeridos" });
    }
    if (new_password.length < 6) {
      return res.status(422).json({ detail: "La contrasena debe tener al menos 6 caracteres" });
    }

    const result = await pool.query(
      "SELECT hashed_password FROM auth.users WHERE id = $1",
      [req.user.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ detail: "Usuario no encontrado" });
    }

    const valid = await bcrypt.compare(old_password, result.rows[0].hashed_password);
    if (!valid) {
      return res.status(401).json({ detail: "La contrasena actual es incorrecta" });
    }

    const hashed = await bcrypt.hash(new_password, 10);
    await pool.query(
      "UPDATE auth.users SET hashed_password = $1, must_change_password = FALSE WHERE id = $2",
      [hashed, req.user.id]
    );

    return res.json({ status: "ok" });
  } catch (err) {
    console.error("change-password error:", err);
    return res.status(500).json({ detail: "Error interno" });
  }
});

module.exports = router;
