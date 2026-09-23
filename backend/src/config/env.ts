import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export const env = {
  port: Number(process.env.PORT ?? 4000),
  databaseUrl: required("DATABASE_URL"),
  jwtSecret: required("JWT_SECRET"),
  tokenEncryptionKey: required("TOKEN_ENCRYPTION_KEY"), // 32-byte hex
  gocardless: {
    secretId: required("GOCARDLESS_SECRET_ID"),
    secretKey: required("GOCARDLESS_SECRET_KEY"),
    redirectUri: required("GOCARDLESS_REDIRECT_URI"),
    baseUrl: "https://bankaccountdata.gocardless.com/api/v2",
  },
};
