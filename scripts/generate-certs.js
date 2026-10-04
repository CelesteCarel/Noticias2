const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const {
  resolveOpenSsl,
  opensslEnv,
  KEY_PATH,
  CERT_PATH,
} = require("../src/utils/openssl");

fs.mkdirSync(path.dirname(KEY_PATH), { recursive: true });

if (fs.existsSync(KEY_PATH) && fs.existsSync(CERT_PATH)) {
  console.log(
    "El certificado de desarrollo ya existe en ./certs (se conserva).",
  );
  console.log("Bórralo si quieres generar uno nuevo.");
  process.exit(0);
}

const openssl = resolveOpenSsl();

try {
  execFileSync(
    openssl,
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      KEY_PATH,
      "-out",
      CERT_PATH,
      "-days",
      "365",
      "-subj",
      "/C=MX/ST=Chiapas/L=Tuxtla/O=UNACH/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ],
    { stdio: "ignore", env: opensslEnv() },
  );

  console.log("Certificado de desarrollo generado en ./certs");
  console.log("Para usarlo, en tu .env:");
  console.log("  HTTPS_ENABLED=true");
  console.log("  TLS_KEY_PATH=./certs/dev-key.pem");
  console.log("  TLS_CERT_PATH=./certs/dev-cert.pem");
} catch (error) {
  console.error(
    `No se pudo generar el certificado con OpenSSL (${openssl}):`,
    error.message,
  );
  console.error("Alternativas:");
  console.error("  - Instalar Git for Windows, que incluye openssl en usr/bin");
  console.error("  - Windows con PowerShell como administrador:");
  console.error(
    "    New-SelfSignedCertificate -DnsName localhost -CertStoreLocation Cert:\\CurrentUser\\My",
  );
  process.exit(1);
}
