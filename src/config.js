require("dotenv").config();

module.exports = {
  port: process.env.PORT || 4000,
  databaseUrl: process.env.DATABASE_URL || "postgresql://cumbre:cumbre123@localhost:5433/cumbre_ia",
  secretKey: process.env.SECRET_KEY || "change-me-to-a-random-secret-key",
  jwtExpireMinutes: parseInt(process.env.ACCESS_TOKEN_EXPIRE_MINUTES || "1440"),
};
