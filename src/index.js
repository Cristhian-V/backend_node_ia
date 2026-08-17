require("dotenv").config();

const express = require("express");
const cors = require("cors");
const fileUpload = require("express-fileupload");
const config = require("./config");

const authRoutes = require("./routes/auth");
const adminRoutes = require("./routes/admin");
const liquidadorRoutes = require("./routes/liquidador");
const transbelRoutes = require("./routes/transbel");
const fnningRoutes = require("./routes/fnning");
const { ensureTables } = require("./db_migrations");
const { startTCScheduler } = require("./scheduler/tc_scheduler");
const { seedArancel } = require("./services/arancel_seed");

const app = express();

app.use(cors({ origin: "*", exposedHeaders: ["Content-Disposition"] }));
app.use(express.json());
app.use(fileUpload());

app.use("/auth", authRoutes);
app.use("/admin", adminRoutes);
app.use("/liquidador", liquidadorRoutes);
app.use("/transbel", transbelRoutes);
app.use("/fnning", fnningRoutes);

app.get("/health", (req, res) => res.json({ status: "ok" }));

app.listen(config.port, () => {
  console.log(`Hermes Admin API running on port ${config.port}`);
  ensureTables().then(() => {
    seedArancel().then(() => startTCScheduler());
  });
});
