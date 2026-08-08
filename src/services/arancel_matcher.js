const pool = require("../db");

const STOPWORDS = new Set([
  "de", "la", "el", "los", "las", "del", "en", "con", "por", "para", "sin",
  "que", "y", "o", "a", "e", "u", "un", "una", "su", "al", "lo", "se",
  "no", "le", "es", "son", "ha", "han", "las", "los",
]);

function normalize(text) {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function textSimilarity(descColombia, descArancel) {
  const a = normalize(descColombia);
  const b = normalize(descArancel);

  const wordsA = new Set(a.split(" ").filter((w) => w.length > 1 && !STOPWORDS.has(w)));
  const wordsB = b.split(" ").filter((w) => w.length > 1);

  if (wordsA.size === 0) return 0;

  const matches = wordsB.filter((w) => wordsA.has(w)).length;
  return matches / wordsA.size;
}

function formatWithDots(codigo) {
  if (codigo.length !== 10) return codigo;
  return `${codigo.slice(0, 4)}.${codigo.slice(4, 6)}.${codigo.slice(6, 8)}.${codigo.slice(8, 10)}`;
}

function cleanDescription(desc) {
  return desc.replace(/^[\s\-–—]+/, "").trim();
}

async function findMatch(codigoColombia, descripcionColombia) {
  const codigoSinPuntos = codigoColombia.replace(/\./g, "");
  const prefijo6 = codigoSinPuntos.substring(0, 6);

  const result = await pool.query(
    "SELECT * FROM core.arancel_nacional WHERE prefijo6 = $1",
    [prefijo6]
  );

  if (result.rows.length === 0) {
    return null;
  }

  const scored = result.rows.map((row) => ({
    ...row,
    score: textSimilarity(descripcionColombia, row.descripcion),
  }));

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.codigo.length - b.codigo.length;
  });

  const best = scored[0];
  return {
    codigo: formatWithDots(best.codigo),
    descripcion_partida: cleanDescription(best.descripcion),
    arancel: best.ga_reducido != null ? Math.round(best.ga_reducido * 100) : null,
    iva: best.iva != null ? Number(best.iva) : 14.94,
    score: Math.round(best.score * 100) / 100,
  };
}

module.exports = { findMatch };
