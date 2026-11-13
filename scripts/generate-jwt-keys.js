/**
 * Genera el par de llaves RSA usado para firmar los tokens JWT y las noticias.
 *
 * - Llave privada: PKCS#8 en PEM, se guarda en keys/jwt-private.pem con modo 0600.
 * - Llave pública: SPKI en PEM, se guarda en keys/jwt-public.pem.
 *
 * La carpeta keys/ está ignorada por git: las llaves nunca se versionan.
 *
 *   npm run keys
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const KEYS_DIR = path.join(__dirname, '..', 'keys');
const PRIVATE_KEY_PATH = path.join(KEYS_DIR, 'jwt-private.pem');
const PUBLIC_KEY_PATH = path.join(KEYS_DIR, 'jwt-public.pem');

function main() {
  const force = process.argv.includes('--force');

  if (!force && (fs.existsSync(PRIVATE_KEY_PATH) || fs.existsSync(PUBLIC_KEY_PATH))) {
    console.error('Ya existen llaves en keys/.');
    console.error('Si deseas reemplazarlas (esto invalida todos los tokens emitidos), ejecuta:');
    console.error('  npm run keys -- --force');
    process.exit(1);
  }

  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 3072,
    publicKeyEncoding: {
      type: 'spki',
      format: 'pem'
    },
    privateKeyEncoding: {
      type: 'pkcs8',
      format: 'pem'
    }
  });

  fs.mkdirSync(KEYS_DIR, { recursive: true });
  fs.writeFileSync(PRIVATE_KEY_PATH, privateKey, { mode: 0o600 });
  fs.writeFileSync(PUBLIC_KEY_PATH, publicKey, { mode: 0o644 });

  // En sistemas POSIX, writeFileSync solo aplica el modo al crear el archivo;
  // se refuerza por si el archivo ya existía (por ejemplo tras --force).
  if (process.platform !== 'win32') {
    fs.chmodSync(PRIVATE_KEY_PATH, 0o600);
  }

  console.log('Par de llaves RSA de 3072 bits generado correctamente:');
  console.log(`  Privada (PKCS#8): ${PRIVATE_KEY_PATH}`);
  console.log(`  Pública (SPKI):   ${PUBLIC_KEY_PATH}`);
  console.log('');
  console.log('Configura en tu .env:');
  console.log('  JWT_PRIVATE_KEY_PATH=./keys/jwt-private.pem');
  console.log('  JWT_PUBLIC_KEY_PATH=./keys/jwt-public.pem');
}

main();
