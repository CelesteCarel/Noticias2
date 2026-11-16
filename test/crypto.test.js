/**
 * Pruebas unitarias de los mecanismos criptográficos.
 *
 * 1. Cifrado simétrico AES-256-GCM (src/utils/crypto.js)
 * 2. Firma asimétrica RSA-SHA256 de noticias (src/utils/crypto.service.js)
 *
 * Genera llaves RSA temporales y una DATA_ENCRYPTION_KEY aleatoria antes de
 * cargar los módulos: la suite nunca usa las llaves reales del proyecto.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const TMP_KEYS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-crypto-keys-'));
const PRIVATE_KEY_PATH = path.join(TMP_KEYS_DIR, 'jwt-private.pem');
const PUBLIC_KEY_PATH = path.join(TMP_KEYS_DIR, 'jwt-public.pem');

{
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 3072,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });
  fs.writeFileSync(PRIVATE_KEY_PATH, privateKey, { mode: 0o600 });
  fs.writeFileSync(PUBLIC_KEY_PATH, publicKey);
}

process.env.JWT_PRIVATE_KEY_PATH = PRIVATE_KEY_PATH;
process.env.JWT_PUBLIC_KEY_PATH = PUBLIC_KEY_PATH;
process.env.DATA_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');

const { encrypt, decrypt, isEncrypted } = require('../src/utils/crypto');
const { hashSha256, hashCoincide, esHashSha256 } = require('../src/utils/hash');
const {
  encryptSymmetric,
  decryptSymmetric,
  signNews,
  verifyNewsSignature,
  getPublicKey,
  getPublicKeyFingerprint
} = require('../src/utils/crypto.service');

let passed = 0;
let failed = 0;

function test(description, fn) {
  try {
    fn();
    console.log(`  ✓ ${description}`);
    passed++;
  } catch (error) {
    console.error(`  ✗ ${description}`);
    console.error(`    ${error.message}`);
    failed++;
  }
}

console.log('\n--- Ejecutando Pruebas de Criptografía (UNACH) ---');

// ============================================================================
// BLOQUE 1: CIFRADO SIMÉTRICO (AES-256-GCM)
// ============================================================================
console.log('\n[1. Mecanismo Simétrico: AES-256-GCM]');

test('El texto cifrado usa el formato v1:<iv>:<tag>:<datos> en Base64', () => {
  const plainText = 'Fuente anónima del Departamento de Finanzas: expediente #9012';
  const encrypted = encrypt(plainText);

  assert(typeof encrypted === 'string', 'El resultado debe ser una cadena');
  assert.ok(encrypted.startsWith('v1:'), 'Debe empezar con el prefijo de versión v1:');
  assert.ok(isEncrypted(encrypted), 'Debe reconocerse como dato cifrado');

  const parts = encrypted.split(':');
  assert.strictEqual(parts.length, 4, 'Debe contener exactamente 4 segmentos');
  assert.strictEqual(Buffer.from(parts[1], 'base64').length, 12, 'El IV debe tener 12 bytes');
  assert.strictEqual(Buffer.from(parts[2], 'base64').length, 16, 'El tag debe tener 16 bytes');
  assert.ok(parts[3].length > 0, 'El texto cifrado no debe estar vacío');
});

test('Ida y vuelta: cifrar y descifrar devuelve el texto original', () => {
  const original = 'Coordenadas del sensor de campo: 16.7532° N, 93.1158° O';
  const cipher = encrypt(original);
  assert.notStrictEqual(cipher, original, 'El texto cifrado debe ser diferente al original');
  assert.strictEqual(decrypt(cipher), original, 'El descifrado debe ser idéntico al original');
});

test('Dos cifrados del mismo texto producen salidas distintas (IV aleatorio)', () => {
  const original = 'Mismo texto confidencial';
  const cipher1 = encrypt(original);
  const cipher2 = encrypt(original);

  assert.notStrictEqual(cipher1, cipher2, 'Cada cifrado debe usar un IV nuevo');
  assert.notStrictEqual(cipher1.split(':')[1], cipher2.split(':')[1], 'Los IV deben diferir');
  assert.strictEqual(decrypt(cipher1), original);
  assert.strictEqual(decrypt(cipher2), original);
});

test('Un dato alterado hace fallar el descifrado (integridad GCM)', () => {
  const cipher = encrypt('Datos de prueba de no alteración');
  const parts = cipher.split(':');

  // Cambiamos un carácter del segmento de datos.
  const datos = parts[3];
  const alterado = datos.slice(0, -1) + (datos.endsWith('A') ? 'B' : 'A');
  const tampered = `${parts[0]}:${parts[1]}:${parts[2]}:${alterado}`;

  assert.throws(() => decrypt(tampered), /autenticación GCM falló/i,
    'El tag GCM debe detectar la alteración');
});

test('Un prefijo de formato desconocido se rechaza con un error claro', () => {
  assert.throws(() => decrypt('v2:a:b:c'), /prefijo "v1:"/i);
  assert.throws(() => decrypt('texto-en-claro'), /prefijo "v1:"/i);
});

test('encrypt devuelve null y cadena vacía tal cual', () => {
  assert.strictEqual(encrypt(null), null);
  assert.strictEqual(encrypt(''), '');
  assert.strictEqual(decrypt(''), '');
});

test('El servicio de noticias cifra en v1 y descifra correctamente', () => {
  const original = 'Nota confidencial de una fuente reservada';
  const cipher = encryptSymmetric(original);
  assert.ok(cipher.startsWith('v1:'), 'El servicio debe usar el formato v1');
  assert.strictEqual(decryptSymmetric(cipher), original);
});

// ============================================================================
// BLOQUE 1.5: HASH SHA-256 DE SECRETOS DE UN SOLO USO
// ============================================================================
console.log('\n[1.5. Hash SHA-256 de códigos y refresh tokens]');

test('El hash SHA-256 tiene 64 caracteres hexadecimales y no contiene el valor original', () => {
  const codigo = '123456';
  const hash = hashSha256(codigo);

  assert.strictEqual(hash.length, 64);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.notStrictEqual(hash, codigo);
  assert.ok(!hash.includes(codigo), 'El código no debe aparecer dentro del hash');
  assert.ok(esHashSha256(hash), 'Debe reconocerse como hash SHA-256');
});

test('La comparación en tiempo constante acepta el valor correcto y rechaza otro', () => {
  const hash = hashSha256('codigo-de-recuperacion');
  assert.strictEqual(hashCoincide('codigo-de-recuperacion', hash), true);
  assert.strictEqual(hashCoincide('codigo-de-recuperacion-2', hash), false);
  assert.strictEqual(hashCoincide('codigo-de-recuperacion', 'texto-en-claro'), false);
});

test('Dos códigos distintos producen hashes distintos', () => {
  assert.notStrictEqual(hashSha256('123456'), hashSha256('123457'));
});

// ============================================================================
// BLOQUE 2: FIRMA DIGITAL ASIMÉTRICA (RSA-SHA256)
// ============================================================================
console.log('\n[2. Mecanismo Asimétrico: RSA-SHA256 (3072 bits)]');

test('Existe y se carga correctamente la llave pública RSA en formato PEM', () => {
  const pubKey = getPublicKey();
  assert(pubKey.includes('-----BEGIN PUBLIC KEY-----'), 'Debe tener cabecera PEM de clave pública');
  assert(pubKey.includes('-----END PUBLIC KEY-----'), 'Debe tener pie PEM de clave pública');

  const fingerprint = getPublicKeyFingerprint();
  assert(fingerprint && fingerprint.length > 20, 'Debe generar una huella digital SHA-256');
});

test('La llave RSA es de 3072 bits', () => {
  const detalles = crypto.createPublicKey(getPublicKey()).asymmetricKeyDetails;
  assert.strictEqual(detalles.modulusLength, 3072);
});

test('Firma digital de una noticia: genera firma Base64 y la verificación es exitosa', () => {
  const news = {
    id: 99,
    titulo: 'Alumnos obtienen premio nacional de programación',
    contenido: 'La delegación estudiantil representó con éxito a la facultad en el concurso nacional.',
    categoria: 'Tecnología',
    id_autor: 1
  };

  const signature = signNews(news);
  assert(typeof signature === 'string' && signature.length > 50, 'La firma debe ser Base64');

  const verification = verifyNewsSignature(news, signature);
  assert.strictEqual(verification.valid, true, 'La verificación con la llave pública debe ser exitosa');
});

test('Detección de tampering: si cambia el contenido, la firma se invalida', () => {
  const originalNews = {
    titulo: 'Comunicado Oficial de Rectoría',
    contenido: 'Se informa que las actividades académicas se desarrollarán en horario normal.',
    categoria: 'Institucional',
    id_autor: 1
  };

  const signature = signNews(originalNews);
  const tamperedNews = {
    ...originalNews,
    contenido: 'Se informa que las actividades académicas quedan suspendidas indefinidamente.'
  };

  const verification = verifyNewsSignature(tamperedNews, signature);
  assert.strictEqual(verification.valid, false, 'La firma digital debe rechazar el contenido alterado');
});

test('Detección de tampering: si cambia el título, la firma también se invalida', () => {
  const originalNews = {
    titulo: 'Presupuesto Universitario 2026',
    contenido: 'El H. Consejo Universitario aprobó el presupuesto anual.',
    categoria: 'Finanzas',
    id_autor: 1
  };

  const signature = signNews(originalNews);
  const tamperedNews = { ...originalNews, titulo: 'Presupuesto Universitario Recortado 2026' };

  const verification = verifyNewsSignature(tamperedNews, signature);
  assert.strictEqual(verification.valid, false, 'La firma digital debe rechazar el título alterado');
});

// ============================================================================
// RESUMEN
// ============================================================================
console.log(`\nResultados: ${passed} pasadas, ${failed} fallidas.\n`);
if (failed > 0) {
  process.exit(1);
}
