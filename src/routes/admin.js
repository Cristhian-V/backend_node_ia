const { Router } = require("express");
const bcrypt = require("bcrypt");
const pool = require("../db");
const { adminMiddleware } = require("../middleware/auth");
const { VALID_TOOLS, VALID_ROLES } = require("../constants");

const router = Router();
router.use(adminMiddleware);

// Parse tools from body: supports both string[] and {tool_key, role}[]
function parseTools(tools) {
  if (!tools || !Array.isArray(tools)) return [];
  return tools.map(t => {
    if (typeof t === "string") {
      return { tool_key: t, role: null };
    }
    return {
      tool_key: t.tool_key,
      role: t.role && VALID_ROLES.includes(t.role) ? t.role : null,
    };
  }).filter(t => VALID_TOOLS.includes(t.tool_key));
}

// List all users with their tools
router.get("/users", async (req, res) => {
  try {
    const users = await pool.query(
      "SELECT id, email, full_name, is_admin, created_at FROM auth.users ORDER BY created_at DESC"
    );

    const allTools = await pool.query("SELECT user_id, tool_key, role FROM core.user_tools");

    const toolsByUser = {};
    for (const t of allTools.rows) {
      if (!toolsByUser[t.user_id]) toolsByUser[t.user_id] = [];
      toolsByUser[t.user_id].push({ tool_key: t.tool_key, role: t.role || null });
    }

    const result = users.rows.map(u => ({
      ...u,
      tools: toolsByUser[String(u.id)] || [],
    }));

    return res.json(result);
  } catch (err) {
    console.error("list users error:", err);
    return res.status(500).json({ detail: "Error interno" });
  }
});

// Create user
router.post("/users", async (req, res) => {
  try {
    const { email, password, full_name, is_admin, tools } = req.body;
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
      "INSERT INTO auth.users (email, hashed_password, full_name, is_admin) VALUES ($1, $2, $3, $4) RETURNING id",
      [email, hashed, full_name, is_admin || false]
    );

    const userId = result.rows[0].id;

    // Assign tools with roles
    const parsed = parseTools(tools);
    for (const t of parsed) {
      await pool.query(
        "INSERT INTO core.user_tools (user_id, tool_key, role) VALUES ($1, $2, $3) ON CONFLICT (user_id, tool_key) DO UPDATE SET role = $3",
        [userId, t.tool_key, t.role]
      );
    }

    return res.status(201).json({ id: userId, email, full_name, is_admin: is_admin || false, tools: parsed });
  } catch (err) {
    console.error("create user error:", err);
    return res.status(500).json({ detail: "Error interno" });
  }
});

// Update user
router.put("/users/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { full_name, password, is_admin, tools } = req.body;

    const user = await pool.query("SELECT id FROM auth.users WHERE id = $1", [id]);
    if (user.rows.length === 0) {
      return res.status(404).json({ detail: "Usuario no encontrado" });
    }

    if (full_name !== undefined) {
      await pool.query("UPDATE auth.users SET full_name = $1 WHERE id = $2", [full_name, id]);
    }
    if (password !== undefined && password.length >= 6) {
      const hashed = await bcrypt.hash(password, 10);
      await pool.query("UPDATE auth.users SET hashed_password = $1 WHERE id = $2", [hashed, id]);
    }
    if (is_admin !== undefined) {
      await pool.query("UPDATE auth.users SET is_admin = $1 WHERE id = $2", [is_admin, id]);
    }

    // Replace tools with roles
    if (tools !== undefined) {
      await pool.query("DELETE FROM core.user_tools WHERE user_id = $1", [id]);
      const parsed = parseTools(tools);
      for (const t of parsed) {
        await pool.query(
          "INSERT INTO core.user_tools (user_id, tool_key, role) VALUES ($1, $2, $3)",
          [id, t.tool_key, t.role]
        );
      }
    }

    return res.json({ status: "ok" });
  } catch (err) {
    console.error("update user error:", err);
    return res.status(500).json({ detail: "Error interno" });
  }
});

// Delete user
router.delete("/users/:id", async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query("DELETE FROM auth.users WHERE id = $1", [id]);
    return res.json({ status: "ok" });
  } catch (err) {
    console.error("delete user error:", err);
    return res.status(500).json({ detail: "Error interno" });
  }
});

module.exports = router;
