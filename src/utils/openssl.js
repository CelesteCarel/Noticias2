const fs = require('fs');
const path = require('path');

/**
 * Localiza el ejecutable de OpenSSL.
 *
 * En Linux y macOS normalmente está en el PATH. En Windows rara vez lo está, pero
 * Git for Windows lo distribuye junto con su terminal y es la vía más común para
 * generar un certificado de desarrollo, así que se buscan también ahí antes de
 * rendirse.
 */
const WINDOWS_CANDIDATES = [
  'C:\\Program Files\\Git\\usr\\bin\\openssl.exe',
  'C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe',
  'C:\\Program Files (x86)\\Git\\usr\\bin\\openssl.exe',
  'C:\\Program Files\\OpenSSL-Win64\\bin\\openssl.exe',
  'C:\\Program Files\\OpenSSL\\bin\\openssl.exe'
];

const UNIX_CANDIDATES = ['/usr/bin/openssl', '/usr/local/bin/openssl', '/opt/homebrew/bin/openssl'];

function resolveOpenSsl() {
  if (process.platform !== 'win32') {
    for (const candidate of UNIX_CANDIDATES) {
      if (fs.existsSync(candidate)) return candidate;
    }
    return 'openssl';
  }

  for (const candidate of WINDOWS_CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate;
  }

  // Último recurso: el PATH del sistema.
  return 'openssl';
}

/**
 * Entorno para las subrutinas de OpenSSL.
 *
 * OPENSSL_CONF puede apuntar a un archivo inexistente (típico en Windows cuando
 * se desinstaló el cliente de PostgreSQL que lo había creado), y en ese caso
 * cualquier comando de OpenSSL aborta con "Can't open ... for reading". Si la
 * ruta configurada no existe, se descarta para que OpenSSL use su configuración
 * propia.
 */
function opensslEnv() {
  const env = { ...process.env };
  const configured = env.OPENSSL_CONF;

  if (configured && !fs.existsSync(configured)) {
    delete env.OPENSSL_CONF;
  }

  return env;
}

/**
 * Arranca del proyecto en el directorio de certificados de la raíz, que es la
 * ruta que documenta .env.example (TLS_KEY_PATH=./certs/dev-key.pem).
 */
const ROOT = path.join(__dirname, '..', '..');
const CERTS_DIR = path.join(ROOT, 'certs');
const KEY_PATH = path.join(CERTS_DIR, 'dev-key.pem');
const CERT_PATH = path.join(CERTS_DIR, 'dev-cert.pem');

module.exports = {
  resolveOpenSsl,
  opensslEnv,
  CERTS_DIR,
  KEY_PATH,
  CERT_PATH
};