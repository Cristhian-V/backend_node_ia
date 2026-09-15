require("dotenv").config();

const fs = require("fs");
const path = require("path");

function readKey(filePath) {
  if (!filePath) throw new Error("JWT key file path is not configured");
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`JWT key file not found: ${resolved}`);
  }
  return fs.readFileSync(resolved, "utf8");
}

module.exports = {
  port: process.env.PORT || 4000,
  databaseUrl: process.env.DATABASE_URL || "postgresql://cumbre:cumbre123@localhost:5433/cumbre_ia",
  jwtExpireMinutes: parseInt(process.env.ACCESS_TOKEN_EXPIRE_MINUTES || "1440"),
  jwtPrivateKey: readKey(process.env.JWT_PRIVATE_KEY_FILE || "jwt-private.pem"),
  jwtPublicKey: readKey(process.env.JWT_PUBLIC_KEY_FILE || "jwt-public.pem"),
};
