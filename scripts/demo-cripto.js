/**
 * Demostración en vivo de los dos mecanismos criptográficos del portal.
 *
 *   node scripts/demo-cripto.js
 *
 * 1. CIFRADO SIMÉTRICO: guarda un RFC inventado en SQLite con AES-256-GCM,
 *    muestra el valor tal como queda en la base de datos y luego lo descifra.
 * 2. FIRMA ASIMÉTRICA: emite un access token RS256 real, muestra su encabezado,
 *    lo verifica con la llave pública y comprueba que un token con el payload
 *    alterado es rechazado.
 *
 * Por defecto usa una base de datos temporal para no tocar la del proyecto.
 * Para ejecutarla contra otra base:
 *
 *   DB_PATH=./database.sqlite node scripts/demo-cripto.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
require('dotenv').config();

// Base de datos temporal si no se indica otra: solo datos inventados.
if (!process.env.DB_PATH) {
  process.env.DB_PATH = path.join(os.tmpdir(), `portal-demo-cripto-${process.pid}.sqlite`);
}

const db = require('../src/database/db');
const { encrypt, decrypt } = require('../src/utils/crypto');
const { generateAccessToken } = require('../src/middleware/auth');

const LINE = '='.repeat(74);
const SUB = '-'.repeat(74);

function titulo(texto) {
  console.log(`\n${LINE}\n${texto}\n${LINE}`);
}

// ---------------------------------------------------------------------------
// 1. CIFRADO SIMÉTRICO AES-256-GCM
// ---------------------------------------------------------------------------

// Datos completamente inventados.
const DEMO_EMAIL = 'demo.cripto@portalnoticias.com';
const DEMO_RFC = 'DEMO900101ABC';
const DEMO_TELEFONO = '9610000000';
const DEMO_DIRECCION = 'Calle Ficticia 123, Tuxtla Gutiérrez, Chiapas';

const rolLector = db.prepare("SELECT id, nombre_rol FROM roles WHERE nombre_rol = 'Usuario Regular'").get();

db.prepare('DELETE FROM usuarios WHERE email = ?').run(DEMO_EMAIL);
db.prepare(`
  INSERT INTO usuarios (nombre, email, password, id_rol, telefono, rfc, direccion)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`).run(
  'Usuario de Demostración',
  DEMO_EMAIL,
  bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), 10),
  rolLector.id,
  encrypt(DEMO_TELEFONO),
  encrypt(DEMO_RFC),
  encrypt(DEMO_DIRECCION)
);

// Lectura directa de la fila, como la vería alguien con acceso al archivo .sqlite.
const fila = db.prepare('SELECT id, nombre, email, id_rol, telefono, rfc, direccion FROM usuarios WHERE email = ?').get(DEMO_EMAIL);

titulo('MECANISMO 1 — CIFRADO SIMÉTRICO AES-256-GCM');
console.log(`Base de datos SQLite: ${process.env.DB_PATH}`);
console.log(`\nDato que escribe el usuario (texto en claro):`);
console.log(`  RFC: ${DEMO_RFC}`);
console.log(`\nValor REAL guardado en la columna usuarios.rfc (lo que vería un atacante):`);
console.log(`  ${fila.rfc}`);
console.log(`\nEstructura del campo almacenado:`);
const [version, iv, tag, datos] = fila.rfc.split(':');
console.log(`  ${version}  versión del formato`);
console.log(`  ${iv}  IV aleatorio (12 bytes, Base64)`);
console.log(`  ${tag}  tag de autenticación GCM (16 bytes, Base64)`);
console.log(`  ${datos}  datos cifrados (Base64)`);
console.log(`\nEl usuario vuelve a ver el dato descifrado por la aplicación:`);
console.log(`  RFC descifrado: ${decrypt(fila.rfc)}`);
console.log(`  Teléfono:       ${decrypt(fila.telefono)}`);
console.log(`  Dirección:      ${decrypt(fila.direccion)}`);

// Dos cifrados del mismo RFC: distinto IV y distinto resultado.
const cifradoA = encrypt(DEMO_RFC);
const cifradoB = encrypt(DEMO_RFC);
console.log(`\nDos cifrados del mismo RFC producen resultados distintos (IV nuevo):`);
console.log(`  A: ${cifradoA}`);
console.log(`  B: ${cifradoB}`);
console.log(`  ¿Son iguales? ${cifradoA === cifradoB ? 'SÍ (incorrecto)' : 'NO (correcto)'}`);

// Alteración de un carácter: GCM detecta la manipulación.
const datosBin = Buffer.from(datos, 'base64');
datosBin[0] ^= 0xff;
const alterado = `${version}:${iv}:${tag}:${datosBin.toString('base64')}`;
let alteracionDetectada = false;
try {
  decrypt(alterado);
} catch (error) {
  alteracionDetectada = true;
  console.log(`\nAl cambiar un solo carácter del dato cifrado, el descifrado falla:`);
  console.log(`  ${error.message}`);
}
if (!alteracionDetectada) {
  console.log('\nADVERTENCIA: el dato alterado se descifró; la integridad no se está verificando.');
}

// ---------------------------------------------------------------------------
// 2. FIRMA ASIMÉTRICA RSA (JWT RS256)
// ---------------------------------------------------------------------------

const usuario = {
  id: fila.id,
  email: fila.email,
  id_rol: fila.id_rol,
  nombre_rol: rolLector.nombre_rol
};

const accessToken = generateAccessToken(usuario);
const [headerB64, payloadB64, firmaB64] = accessToken.split('.');
const header = JSON.parse(Buffer.from(headerB64, 'base64url').toString());
const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());

const publicKey = fs.readFileSync(path.resolve(process.env.JWT_PUBLIC_KEY_PATH), 'utf8');

titulo('MECANISMO 2 — FIRMA ASIMÉTRICA RSA (JWT RS256)');
console.log('Encabezado del token emitido por el servidor:');
console.log('  ' + JSON.stringify(header));
console.log('\nPayload (datos públicos del token):');
console.log('  ' + JSON.stringify(payload));
console.log('\nToken completo:');
console.log('  ' + accessToken);

let verificacion;
try {
  verificacion = jwt.verify(accessToken, publicKey, { algorithms: ['RS256'] });
  console.log(`\nVerificación con la LLAVE PÚBLICA: VÁLIDA`);
  console.log(`  Usuario autenticado: ${verificacion.email} (${verificacion.nombre_rol})`);
} catch (error) {
  console.log(`\nVerificación con la llave pública: FALLÓ (${error.message})`);
}

// Alteramos el payload (por ejemplo, para intentar ser Administrador) sin poder
// volver a firmar: el servidor rechaza el token.
const payloadAlterado = { ...payload, id_rol: 1, nombre_rol: 'Administrador' };
const payloadAlteradoB64 = Buffer.from(JSON.stringify(payloadAlterado)).toString('base64url');
const tokenAlterado = `${headerB64}.${payloadAlteradoB64}.${firmaB64}`;

console.log('\nToken con el payload alterado (intento de escalar a Administrador):');
console.log('  ' + tokenAlterado);
try {
  jwt.verify(tokenAlterado, publicKey, { algorithms: ['RS256'] });
  console.log('\nADVERTENCIA: el token alterado fue aceptado.');
} catch (error) {
  console.log(`\nVerificación del token alterado: RECHAZADO (${error.message})`);
}

// Un token HS256 tampoco se acepta: el servidor exige RS256.
const tokenHS256 = jwt.sign(
  { id: fila.id, email: fila.email, id_rol: fila.id_rol, nombre_rol: fila.nombre_rol },
  crypto.randomBytes(32).toString('hex'),
  { algorithm: 'HS256' }
);
let hsRechazado = false;
try {
  jwt.verify(tokenHS256, publicKey, { algorithms: ['RS256'] });
} catch {
  hsRechazado = true;
}
console.log(`Token firmado con HS256: ${hsRechazado ? 'RECHAZADO (correcto)' : 'ACEPTADO (incorrecto)'}`);

console.log(`\n${SUB}`);
console.log('Resumen: el dato está cifrado en la BD y solo se descifra al leerlo;');
console.log('los tokens se firman con la llave privada y se verifican con la pública.');
console.log(SUB + '\n');
