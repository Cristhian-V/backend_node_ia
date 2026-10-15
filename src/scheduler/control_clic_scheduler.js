const { startSyncBackground } = require("../services/control_clic_sync");

const ENABLED = String(process.env.CONTROL_CLIC_ENABLED || "true") !== "false";
const HOUR_UTC = parseInt(process.env.CONTROL_CLIC_HOUR_UTC || "7", 10);
const THROTTLE_MS = parseInt(process.env.CONTROL_CLIC_THROTTLE_MS || "1500", 10);
const LIMIT = parseInt(process.env.CONTROL_CLIC_LIMIT || "500", 10);

async function run() {
  try {
    const res = await startSyncBackground({ limit: LIMIT, throttleMs: THROTTLE_MS });
    console.log(
      res.started
        ? "  [CONTROL-CLIC] Sincronización de canal iniciada"
        : "  [CONTROL-CLIC] Ya hay una sincronización en curso"
    );
  } catch (err) {
    console.error("  [CONTROL-CLIC] Error:", err.message);
  }
}

function startControlClicScheduler() {
  if (!ENABLED) {
    console.log("  [CONTROL-CLIC] Deshabilitado (CONTROL_CLIC_ENABLED=false)");
    return;
  }

  run();

  const scheduleNext = () => {
    const now = new Date();
    const target = new Date(now);
    target.setUTCHours(HOUR_UTC, 0, 0, 0);
    if (target <= now) target.setUTCDate(target.getUTCDate() + 1);
    const ms = target - now;
    console.log(
      `  [CONTROL-CLIC] Prox sync: ${target.toISOString()} (en ${Math.round(ms / 60000)} min)`
    );
    setTimeout(() => {
      run();
      setInterval(run, 24 * 60 * 60 * 1000);
    }, ms);
  };

  scheduleNext();
}

module.exports = { startControlClicScheduler, run };
