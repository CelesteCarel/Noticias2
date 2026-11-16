const { execFileSync } = require("child_process");
const fs = require("fs");
const net = require("net");
const path = require("path");
const {
  resolveOpenSsl,
  opensslEnv,
  KEY_PATH,
  CERT_PATH,
} = require("../src/utils/openssl");

/**
 * Genera el certificado autofirmado de desarrollo.
 *
 * La IP del servidor debe ir como Subject Alternative Name (SAN); si solo está
 * el nombre "localhost", el navegador del cliente rechaza el certificado al
 * entrar por IP y muestra una advertencia que se puede evitar.
 *
 * Uso:
 *   npm run certs
 *   npm run certs -- --ip 192.168.188.10
 *   npm run certs -- --ip 192.168.188.10 --host portal.unach.local --force
 *   TLS_IP=192.168.188.10 TLS_HOSTS=portal.unach.local npm run certs
 */

const args = process.argv.slice(2);
const force = args.includes("--force");

function valorDeArgumento(nombre) {
  const indice = args.indexOf(nombre);
  return indice >= 0 && args[indice + 1] ? args[indice + 1] : null;
}

const hosts = new Set(["localhost"]);
const ips = new Set(["127.0.0.1", "192.168.188.10"]);

for (const valor of [valorDeArgumento("--host"), process.env.TLS_HOSTS]) {
  if (!valor) continue;
  for (const host of valor.split(",").map((h) => h.trim()).filter(Boolean)) {
    if (!/^[a-zA-Z0-9.-]+$/.test(host)) {
      console.error(`Host inválido para el certificado: ${host}`);
      process.exit(1);
    }
    hosts.add(host);
  }
}

for (const valor of [valorDeArgumento("--ip"), process.env.TLS_IP]) {
  if (!valor) continue;
  for (const ip of valor.split(",").map((i) => i.trim()).filter(Boolean)) {
    if (!net.isIP(ip)) {
      console.error(`Dirección IP inválida para el certificado: ${ip}`);
      process.exit(1);
    }
    ips.add(ip);
  }
}

fs.mkdirSync(path.dirname(KEY_PATH), { recursive: true });

if (fs.existsSync(KEY_PATH) && fs.existsSync(CERT_PATH) && !force) {
  console.log("El certificado de desarrollo ya existe en ./certs (se conserva).");
  console.log("Para regenerarlo con otras IPs usa: npm run certs -- --ip 192.168.188.10 --force");
  process.exit(0);
}

if (force) {
  fs.rmSync(KEY_PATH, { force: true });
  fs.rmSync(CERT_PATH, { force: true });
}

const openssl = resolveOpenSsl();
const subjectAltName = [
  ...[...hosts].map((host) => `DNS:${host}`),
  ...[...ips].map((ip) => `IP:${ip}`),
].join(",");

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
      `subjectAltName=${subjectAltName}`,
    ],
    { stdio: "ignore", env: opensslEnv() },
  );

  console.log("Certificado de desarrollo generado en ./certs");
  console.log(`Nombres e IPs incluidas (SAN): ${subjectAltName}`);
  console.log("Para usarlo, en tu .env:");
  console.log("  HTTPS_ENABLED=true");
  console.log("  TLS_KEY_PATH=./certs/dev-key.pem");
  console.log("  TLS_CERT_PATH=./certs/dev-cert.pem");
  console.log("  HTTP_REDIRECT_PORT=3080   # opcional: redirige HTTP a HTTPS");
} catch (error) {
  console.error(
    `No se pudo generar el certificado con OpenSSL (${openssl}):`,
    error.message,
  );
  console.error("Alternativas:");
  console.error("  - Instalar Git for Windows, que incluye openssl en usr/bin");
  console.error("  - Windows con PowerShell como administrador:");
  console.error(
    "    New-SelfSignedCertificate -DnsName localhost,192.168.188.10 -CertStoreLocation Cert:\\CurrentUser\\My",
  );
  process.exit(1);
}
