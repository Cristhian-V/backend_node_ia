const CLICK_BASE_URL =
  process.env.CLICK_BASE_URL || "http://anbsw01.aduana.gob.bo:7601/click";
const CLICK_TIMEOUT_MS = parseInt(process.env.CLICK_TIMEOUT_MS || "10000", 10);

const ENTITIES = {
  nbsp: " ",
  amp: "&",
  quot: '"',
  apos: "'",
  lt: "<",
  gt: ">",
  reg: "",
  copy: "",
  aacute: "á",
  eacute: "é",
  iacute: "í",
  oacute: "ó",
  uacute: "ú",
  ntilde: "ñ",
  Aacute: "Á",
  Eacute: "É",
  Iacute: "Í",
  Oacute: "Ó",
  Uacute: "Ú",
  Ntilde: "Ñ",
};

function decodeEntities(value) {
  if (!value) return "";
  return String(value)
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&([a-zA-Z]+);/g, (full, name) =>
      Object.prototype.hasOwnProperty.call(ENTITIES, name)
        ? ENTITIES[name]
        : full
    );
}

async function getWithCookies(url, signal, maxHops = 8) {
  let current = url;
  let cookie = "";
  for (let i = 0; i < maxHops; i++) {
    const res = await fetch(current, {
      redirect: "manual",
      signal,
      headers: {
        "User-Agent": "Hermes/1.0",
        ...(cookie ? { Cookie: cookie } : {}),
      },
    });
    const setCookies =
      typeof res.headers.getSetCookie === "function"
        ? res.headers.getSetCookie()
        : [];
    for (const c of setCookies) {
      const m = /JSESSIONID=([^;]+)/i.exec(c);
      if (m) cookie = `JSESSIONID=${m[1]}`;
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) return { res, cookie };
      current = new URL(location, current).toString();
      continue;
    }
    return { res, cookie };
  }
  throw new Error("Demasiadas redirecciones en CLICK");
}

async function fetchStatusHtml(cookie, gestion, aduana, numero, signal) {
  const body = new URLSearchParams({
    aduana: String(aduana),
    boton: "Consultar",
    gestion: String(gestion),
    numero: String(numero),
    ops: "S",
    serie: "C",
  }).toString();

  const res = await fetch(`${CLICK_BASE_URL}/status.do`, {
    method: "POST",
    redirect: "manual",
    signal,
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "Hermes/1.0",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body,
  });
  return await res.text();
}

async function openClickCookie(signal) {
  const { cookie } = await getWithCookies(CLICK_BASE_URL, signal);
  return cookie;
}

/**
 * Sesión de CLICK reutilizable: abre la sesión una vez y permite consultar
 * varias declaraciones (una por vez) reusando la cookie.
 */
function createClickSession() {
  let cookie = "";

  async function withTimeout(fn) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CLICK_TIMEOUT_MS);
    try {
      return await fn(controller.signal);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async init() {
      cookie = await withTimeout((signal) => openClickCookie(signal));
      return cookie;
    },
    async scrape(gestion, aduana, numero) {
      if (!cookie) await this.init();
      const html = await withTimeout((signal) =>
        fetchStatusHtml(cookie, gestion, aduana, numero, signal)
      );
      return parseClickHtml(html);
    },
    reset() {
      cookie = "";
    },
  };
}

function matchLabel(html, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`${escaped}\\s*</label>\\s*([^<]*)`, "i");
  const m = re.exec(html);
  return m ? decodeEntities(m[1]).replace(/\s+/g, " ").trim() : "";
}

function parseRowDate(text) {
  const m = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(text || "");
  if (!m) return null;
  return { d: parseInt(m[1], 10), m: parseInt(m[2], 10), y: parseInt(m[3], 10) };
}

function combineDate(dateParts, time) {
  if (!dateParts) return null;
  const t = /(\d{2}):(\d{2}):(\d{2})/.exec(time || "");
  if (!t) return null;
  return new Date(
    Date.UTC(
      dateParts.y,
      dateParts.m - 1,
      dateParts.d,
      parseInt(t[1], 10),
      parseInt(t[2], 10),
      parseInt(t[3], 10)
    )
  );
}

function parseClickHtml(html) {
  let mensaje = "";
  const msgMatch = /alert-message[^>]*>([\s\S]*?)<\/div>/i.exec(html);
  if (msgMatch) {
    mensaje = decodeEntities(msgMatch[1].replace(/<[^>]*>/g, " "))
      .replace(/\s+/g, " ")
      .replace(/^.*?Mensaje:\s*/i, "")
      .trim();
  }

  const nroRegistro =
    matchLabel(html, "N&uacute;mero de Registro") ||
    matchLabel(html, "Número de Registro");
  const regimen =
    matchLabel(html, "R&eacute;gimen aduanero") ||
    matchLabel(html, "Régimen aduanero");
  const nroItemRaw =
    matchLabel(html, "N&uacute;mero de Items") ||
    matchLabel(html, "Número de Items");

  const eventos = [];
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let row;
  while ((row = rowRe.exec(html))) {
    const th = /<th[^>]*>\s*<b>(.*?)<\/b>/i.exec(row[1]);
    const dateParts = th ? parseRowDate(decodeEntities(th[1])) : null;

    const evRe =
      /<img\s+src="img\/([a-zA-Z0-9_]+)\.jpg"[^>]*>[\s\S]*?<td[^>]*>\s*(\d{2}:\d{2}:\d{2})\s*<b>(.*?)<\/b>([\s\S]*?)<\/td>/gi;
    let ev;
    while ((ev = evRe.exec(row[1]))) {
      eventos.push({
        imagen: `img/${ev[1]}.jpg`,
        hora: ev[2],
        tipo: decodeEntities(ev[3]).replace(/[:.\s]+$/, "").trim(),
        descripcion: decodeEntities(ev[4]).replace(/\s+/g, " ").trim(),
        fecha: combineDate(dateParts, ev[2]),
      });
    }
  }

  const nroItem = parseInt(nroItemRaw, 10);
  return {
    nroRegistro: nroRegistro || "",
    regimen: regimen || "",
    nroItem: Number.isNaN(nroItem) ? null : nroItem,
    eventos,
    mensaje,
  };
}

async function scrapeClick(gestion, aduana, numero) {
  const session = createClickSession();
  await session.init();
  return session.scrape(gestion, aduana, numero);
}

module.exports = {
  scrapeClick,
  createClickSession,
  parseClickHtml,
  decodeEntities,
  CLICK_BASE_URL,
};
