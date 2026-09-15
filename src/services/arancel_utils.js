function normArancel(cod) {
  if (cod == null) return "";
  const digits = String(cod).replace(/\D/g, "");
  return digits.slice(0, 10);
}

module.exports = { normArancel };
