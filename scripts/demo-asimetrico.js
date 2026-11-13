/**
 * Demostración guiada del mecanismo ASIMÉTRICO, con datos reales del portal.
 *
 *   npm run demo:asimetrico
 *
 * A diferencia de scripts/demo-cripto.js (que usa una base temporal), este
 * script lee una noticia YA guardada en database.sqlite y muestra:
 *
 *   1. Las dos llaves: privada (firma) y pública (verifica).
 *   2. El payload canónico y la firma real almacenada en la base de datos.
 *   3. La verificación con la llave pública: VÁLIDA.
 *   4. La misma verificación tras alterar el título: INVÁLIDA.
 *   5. Que otra llave pública distinta no valida la firma.
 *   6. Un token JWT RS256: encabezado, verificación, payload alterado y HS256.
 *
 * Solo lee la base de datos; no modifica ninguna noticia.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const DB_PATH = path.resolve(process.env.DB_PATH || './database.sqlite');

const LINE = '='.repeat(76);
const SUB = '-'.repeat(76);

function titulo(texto) {
  console.log(`\n${LINE}\n${texto}\n${LINE}`);
}

function paso(texto) {
  console.log(`\n${texto}`);
}

if (!fs.existsSync(DB_PATH)) {
  console.error(`No se encontró la base de datos en ${DB_PATH}.`);
  console.error('Arranca la aplicación una vez con `npm start` para que se cree y se firme el contenido de ejemplo.');
  process.exit(1);
}

if (!process.env.JWT_PRIVATE_KEY_PATH || !process.env.JWT_PUBLIC_KEY_PATH) {
  console.error('Faltan JWT_PRIVATE_KEY_PATH y/o JWT_PUBLIC_KEY_PATH en el .env.');
  console.error('Genera las llaves con `npm run keys` y define ambas rutas.');
  process.exit(1);
}

const { DatabaseSync } = require('node:sqlite');
const { generateAccessToken } = require('../src/middleware/auth');
const {
  verifyNewsSignature,
  buildCanonicalPayload,
  getPublicKey,
  getPublicKeyFingerprint
} = require('../src/utils/crypto.service');

const db = new DatabaseSync(DB_PATH, { readOnly: true });

const noticia = db.prepare(`
  SELECT id, titulo, contenido, categoria, id_autor, firma_digital, firma_fecha
  FROM noticias
  ORDER BY id
  LIMIT 1
`).get();

const usuario = db.prepare(`
  SELECT u.id, u.email, u.id_rol, r.nombre_rol
  FROM usuarios u
  JOIN roles r ON r.id = u.id_rol
  ORDER BY u.id DESC
  LIMIT 1
`).get();

if (!noticia) {
  console.error('La base de datos no tiene noticias. Arranca la app para generar el seed.');
  db.close();
  process.exit(1);
}

const publicKey = getPublicKey();
const publicKeyPath = path.resolve(process.env.JWT_PUBLIC_KEY_PATH);
const privateKeyPath = path.resolve(process.env.JWT_PRIVATE_KEY_PATH);

// ============================================================================
// 1. LAS DOS LLAVES
// ============================================================================
titulo('1. LAS DOS LLAVES DEL MECANISMO ASIMÉTRICO');

const detalles = crypto.createPublicKey(publicKey).asymmetricKeyDetails;

console.log('  Llave PRIVADA (firma):   ', path.basename(privateKeyPath));
console.log('    - Vive solo en el servidor, en keys/ (ignorada por git).');
console.log('    - Con ella se firma; si se filtra, cualquiera puede hacerse pasar por el portal.');
console.log('');
console.log('  Llave PÚBLICA (verifica):', path.basename(publicKeyPath));
console.log('    - Se puede repartir sin riesgo: solo sirve para verificar firmas.');
console.log('');
console.log(`  Algoritmo: RSA de ${detalles.modulusLength} bits + SHA-256 (RS256)`);
console.log(`  Huella SHA-256 de la pública: ${getPublicKeyFingerprint()}`);
console.log('');
console.log('  Analogía: la privada es el sello oficial que solo tiene la universidad;');
console.log('  la pública es la lupa con la que cualquiera comprueba que el sello es real.');

// ============================================================================
// 2. FIRMA REAL GUARDADA EN SQLITE
// ============================================================================
titulo('2. UNA NOTICIA REAL Y SU FIRMA GUARDADA EN SQLITE');

const payload = buildCanonicalPayload(noticia);

console.log(`  Noticia #${noticia.id}: ${noticia.titulo}`);
console.log(`  Autor (id): ${noticia.id_autor}   Categoría: ${noticia.categoria}`);
console.log(`  Firmada el: ${noticia.firma_fecha}`);

paso('  Paso A. El servidor construye un "payload canónico" con los datos del documento:');
console.log(`    ${payload}`);
console.log('    (incluye el SHA-256 del contenido: si cambia una sola letra, cambia el hash)');

paso('  Paso B. Firma ese payload con la llave PRIVADA. Esto es lo que queda en la BD:');
console.log(`    noticias.firma_digital = ${noticia.firma_digital.slice(0, 64)}...`);
console.log(`    Longitud: ${noticia.firma_digital.length} caracteres Base64 (firma RSA de 3072 bits)`);

paso('  Paso C. Cualquiera verifica con la llave PÚBLICA:');
const verificacion = verifyNewsSignature(noticia, noticia.firma_digital);
console.log(`    Resultado: ${verificacion.valid ? 'VÁLIDA ✔' : 'INVÁLIDA ✘'}`);
console.log('    La firma coincide con el contenido: el documento es auténtico y no fue alterado.');

// ============================================================================
// 3. ALTERACIÓN DEL CONTENIDO
// ============================================================================
titulo('3. ¿QUÉ PASA SI ALGUIEN ALTERA LA NOTICIA?');

const noticiaAlterada = {
  ...noticia,
  titulo: noticia.titulo.replace(/^(\S+)/, 'FALSA:')
};
const payloadAlterado = buildCanonicalPayload(noticiaAlterada);
const verificacionAlterada = verifyNewsSignature(noticiaAlterada, noticia.firma_digital);

console.log(`  Título original: ${noticia.titulo}`);
console.log(`  Título alterado: ${noticiaAlterada.titulo}`);
console.log('');
console.log('  Payload canónico alterado:');
console.log(`    ${payloadAlterado}`);
console.log('');
console.log('  El payload canónico cambió (otro título), así que ya no es el mismo texto');
console.log('  que se firmó: la firma RSA no coincide.');
console.log(`  Verificación: ${verificacionAlterada.valid ? 'VÁLIDA (ERROR)' : 'INVÁLIDA ✘  → alteración detectada'}`);
console.log('');
console.log('  Importante: la noticia de la base de datos NO se modificó; la alteración');
console.log('  ocurrió solo en memoria para demostrar que la firma la detectaría.');

// ============================================================================
// 4. SOLO LA LLAVE PÚBLICA CORRECTA VALIDA
// ============================================================================
titulo('4. OTRA LLAVE PÚBLICA DISTINTA NO PUEDE VALIDAR LA FIRMA');

const parAjeno = crypto.generateKeyPairSync('rsa', {
  modulusLength: 3072,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
});

const verificacionAjena = crypto.createVerify('SHA256');
verificacionAjena.update(payload, 'utf8');
verificacionAjena.end();
const validaConOtra = verificacionAjena.verify(parAjeno.publicKey, noticia.firma_digital, 'base64');

console.log('  Se generó un par RSA temporal (como el de un atacante).');
console.log(`  ¿La firma del portal valida con esa llave pública ajena? ${validaConOtra ? 'SÍ (ERROR)' : 'NO ✔'}`);
console.log('  Cada firma está atada a su llave: no se puede suplantar al portal con otra.');

// ============================================================================
// 5. TOKEN JWT RS256
// ============================================================================
titulo('5. EL MISMO MECANISMO EN LOS TOKENS DE SESIÓN (JWT RS256)');

const token = generateAccessToken(usuario);
const [headerB64, bodyB64, firmaB64] = token.split('.');
const header = JSON.parse(Buffer.from(headerB64, 'base64url').toString());
const body = JSON.parse(Buffer.from(bodyB64, 'base64url').toString());

paso('  Paso A. El servidor firma el token con la llave PRIVADA:');
console.log(`    Encabezado: ${JSON.stringify(header)}`);
console.log(`    Payload:    ${JSON.stringify(body)}`);
console.log('    El payload NO va cifrado: se puede leer. Lo que no se puede es modificarlo.');

paso('  Paso B. Verificación con la llave PÚBLICA:');
try {
  const decoded = jwt.verify(token, publicKey, { algorithms: ['RS256'] });
  console.log(`    VÁLIDA ✔  → usuario: ${decoded.email} (${decoded.nombre_rol})`);
} catch (error) {
  console.log(`    INVÁLIDA ✘ (${error.message})`);
}

paso('  Paso C. Intento de escalar privilegios: cambiar el rol a Administrador.');
const bodyAlterado = { ...body, id_rol: 1, nombre_rol: 'Administrador' };
const bodyAlteradoB64 = Buffer.from(JSON.stringify(bodyAlterado)).toString('base64url');
const tokenAlterado = `${headerB64}.${bodyAlteradoB64}.${firmaB64}`;
try {
  jwt.verify(tokenAlterado, publicKey, { algorithms: ['RS256'] });
  console.log('    RECHAZADO ✘ (no debería ocurrir: el token alterado fue aceptado)');
} catch (error) {
  console.log(`    RECHAZADO ✔ (${error.message})`);
}

paso('  Paso D. Un token firmado con otro algoritmo (HS256) tampoco se acepta:');
const tokenHS256 = jwt.sign(body, crypto.randomBytes(32).toString('hex'), { algorithm: 'HS256' });
try {
  jwt.verify(tokenHS256, publicKey, { algorithms: ['RS256'] });
  console.log('    RECHAZADO ✘ (no debería ocurrir: HS256 fue aceptado)');
} catch (error) {
  console.log(`    RECHAZADO ✔ (${error.message})`);
}

// ============================================================================
// RESUMEN
// ============================================================================
titulo('RESUMEN');
console.log('  PRIVADA  → firma los datos (solo el servidor la tiene).');
console.log('  PÚBLICA  → verifica la firma (se puede repartir).');
console.log('  Si el dato cambia, la verificación falla: se detecta la alteración.');
console.log('  El JWT usa el mismo par: el servidor firma y el cliente/servidor verifica.');
console.log('');
console.log('  En la app web puedes repetirlo sin consola: abre una noticia y usa');
console.log('  "Verificar Firma con Llave Pública" y "Probar Detección de Alteración".');
console.log(SUB + '\n');

db.close();
