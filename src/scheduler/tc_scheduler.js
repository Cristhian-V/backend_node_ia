const https = require("https");
const pool = require("../db");

const BCB_API_URL = "https://apibcb.cucu.bo/api/v1/tc/oficial";

function fetchBCB() {
  return new Promise((resolve, reject) => {
    https
      .get(BCB_API_URL, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            const json = JSON.parse(data);
            if (json.tc_oficial) {
              resolve(json.tc_oficial);
            } else {
              reject(new Error("Respuesta sin tc_oficial"));
            }
          } catch (e) {
            reject(new Error("JSON invalido: " + e.message));
          }
        });
      })
      .on("error", reject);
  });
}

async function fetchAndStore() {
  try {
    const tc = await fetchBCB();
    const result = await pool.query(
      `INSERT INTO core.tipo_cambio (fecha, compra, venta)
       VALUES ($1, $2, $3)
       ON CONFLICT (fecha) DO NOTHING
       RETURNING id`,
      [tc.fecha, tc.compra, tc.venta]
    );
    if (result.rows.length > 0) {
      console.log(
        `  [TC] Guardado: ${tc.fecha} | Compra ${tc.compra} | Venta ${tc.venta}`
      );
    } else {
      console.log(`  [TC] Ya existia: ${tc.fecha}`);
    }
  } catch (err) {
    console.error("  [TC] Error:", err.message);
  }
}

function startTCScheduler() {
  fetchAndStore();

  const scheduleNext = () => {
    const now = new Date();
    const target = new Date(now);
    target.setUTCHours(5, 0, 0, 0);
    if (target <= now) {
      target.setUTCDate(target.getUTCDate() + 1);
    }
    const ms = target - now;
    console.log(
      `  [TC] Prox fetch: ${target.toISOString()} (en ${Math.round(ms / 1000 / 60)} min)`
    );
    setTimeout(() => {
      fetchAndStore();
      setInterval(fetchAndStore, 24 * 60 * 60 * 1000);
    }, ms);
  };

  scheduleNext();
}

module.exports = { startTCScheduler };
