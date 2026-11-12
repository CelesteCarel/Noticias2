/**
 * Pruebas Unitarias y de Integración para los Mecanismos Criptográficos
 * Portal de Noticias UNACH
 * 
 * Verifica:
 * 1. Cifrado Simétrico AES-256-GCM (Confidencialidad e Integridad de datos)
 * 2. Firma Digital Asimétrica RSA-SHA256 (Autenticidad e Integridad de documentos)
 */

const assert = require('assert');
const {
  encryptSymmetric,
  decryptSymmetric,
  isEncrypted,
  signNews,
  verifyNewsSignature,
  getPublicKey,
  getPublicKeyFingerprint,
  buildCanonicalPayload
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

test('El texto en claro se cifra en formato iv:authTag:ciphertext (3 componentes hex)', () => {
  const plainText = 'Fuente anónima del Departamento de Finanzas: expediente #9012';
  const encrypted = encryptSymmetric(plainText);

  assert(typeof encrypted === 'string', 'El resultado debe ser una cadena');
  assert(isEncrypted(encrypted), 'Debe cumplir con el formato estándar iv:authTag:cipher');

  const parts = encrypted.split(':');
  assert.strictEqual(parts.length, 3, 'Debe contener exactamente 3 partes');
  assert.strictEqual(parts[0].length, 24, 'El IV debe tener 12 bytes = 24 caracteres hex');
  assert.strictEqual(parts[1].length, 32, 'El Auth Tag debe tener 16 bytes = 32 caracteres hex');
  assert(parts[2].length > 0, 'El texto cifrado no debe estar vacío');
});

test('Flujo completo: Cifrado en claro -> Guardado cifrado -> Descifrado idéntico', () => {
  const original = 'Coordenadas del sensor de campo: 16.7532° N, 93.1158° O';
  const cipher = encryptSymmetric(original);
  assert.notStrictEqual(cipher, original, 'El texto cifrado debe ser completamente diferente al original');

  const decrypted = decryptSymmetric(cipher);
  assert.strictEqual(decrypted, original, 'El texto descifrado debe ser exactamente igual al original');
});

test('Seguridad probabilística: Dos textos idénticos producen cifrados distintos (IV aleatorio)', () => {
  const original = 'Mismo texto confidencial';
  const cipher1 = encryptSymmetric(original);
  const cipher2 = encryptSymmetric(original);

  assert.notStrictEqual(cipher1, cipher2, 'Dos cifrados del mismo texto deben tener IVs y ciphertexts diferentes');
  assert.strictEqual(decryptSymmetric(cipher1), original);
  assert.strictEqual(decryptSymmetric(cipher2), original);
});

test('Detección de alteración (Integridad GCM): Si se altera el ciphertext, el descifrado falla', () => {
  const original = 'Datos de prueba de no alteración';
  const cipher = encryptSymmetric(original);
  const parts = cipher.split(':');

  // Alteramos el último caracter del ciphertext
  const tamperedCipher = parts[0] + ':' + parts[1] + ':' + parts[2].slice(0, -2) + 'aa';
  const result = decryptSymmetric(tamperedCipher);

  assert.strictEqual(result, '[ERROR_DESCIFRADO_INTEGRIDAD_COMPROMETIDA]', 'Debe abortar ante alteración');
});

// ============================================================================
// BLOQUE 2: FIRMA DIGITAL ASIMÉTRICA (RSA-SHA256)
// ============================================================================
console.log('\n[2. Mecanismo Asimétrico: RSA-SHA256 (2048 bits)]');

test('Existe y se carga correctamente la llave pública RSA en formato PEM', () => {
  const pubKey = getPublicKey();
  assert(pubKey.includes('-----BEGIN PUBLIC KEY-----'), 'Debe tener cabecera PEM de clave pública');
  assert(pubKey.includes('-----END PUBLIC KEY-----'), 'Debe tener pie PEM de clave pública');

  const fingerprint = getPublicKeyFingerprint();
  assert(fingerprint && fingerprint.length > 20, 'Debe generar una huella digital SHA-256');
});

test('Firma digital de una noticia: Genera firma en Base64 y la verificación es exitosa', () => {
  const news = {
    id: 99,
    titulo: 'Alumnos obtienen premio nacional de programación',
    contenido: 'La delegación estudiantil representó con éxito a la facultad en el concurso nacional.',
    categoria: 'Tecnología',
    id_autor: 1
  };

  const signature = signNews(news);
  assert(typeof signature === 'string' && signature.length > 50, 'La firma debe ser una cadena Base64 válida');

  const verification = verifyNewsSignature(news, signature);
  assert.strictEqual(verification.valid, true, 'La verificación con la llave pública debe ser exitosa');
});

test('Detección de Tampering: Si se modifica el contenido de la noticia, la firma se invalida', () => {
  const originalNews = {
    titulo: 'Comunicado Oficial de Rectoría',
    contenido: 'Se informa que las actividades académicas se desarrollarán en horario normal.',
    categoria: 'Institucional',
    id_autor: 1
  };

  const signature = signNews(originalNews);

  // Intentamos validar con un texto alterado maliciosamente
  const tamperedNews = {
    ...originalNews,
    contenido: 'Se informa que las actividades académicas quedan suspendidas indefinidamente.'
  };

  const verification = verifyNewsSignature(tamperedNews, signature);
  assert.strictEqual(verification.valid, false, 'La firma digital debe rechazar el contenido alterado');
});

test('Detección de Tampering: Si se modifica el título, la firma también se invalida', () => {
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
