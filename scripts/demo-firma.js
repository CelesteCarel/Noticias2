/**
 * Ejemplo manual del mecanismo ASIMÉTRICO, en el mismo espíritu que la demo
 * del perfil (dato en claro -> valor guardado -> comprobación).
 *
 *   npm run demo:firma
 *
 * No usa la base de datos ni el servidor: crea una noticia en memoria y muestra
 * el ciclo completo de la firma digital RSA-SHA256 con las llaves del proyecto.
 *
 *   1. El texto original de la noticia.
 *   2. El "payload canónico" que realmente se firma.
 *   3. La firma generada con la llave PRIVADA (lo que se guardaría en la BD).
 *   4. La verificación con la llave PÚBLICA: VÁLIDA.
 *   5. La misma firma tras cambiar una sola letra: INVÁLIDA.
 *   6. La firma del portal con otra llave pública: INVÁLIDA.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const LINE = '='.repeat(76);

function titulo(texto) {
  console.log(`\n${LINE}\n${texto}\n${LINE}`);
}

function paso(texto) {
  console.log(`\n${texto}`);
}

const privateKey = fs.readFileSync(path.resolve(process.env.JWT_PRIVATE_KEY_PATH), 'utf8');
const publicKey = fs.readFileSync(path.resolve(process.env.JWT_PUBLIC_KEY_PATH), 'utf8');

// La noticia que el redactor escribe en el formulario (texto en claro).
const noticia = {
  titulo: 'Inauguran el nuevo laboratorio de ciberseguridad del Campus I',
  contenido: 'El laboratorio cuenta con 40 equipos y será utilizado por estudiantes de ingeniería.',
  categoria: 'Tecnología',
  id_autor: 1
};

// ============================================================================
// 1. LO QUE SE FIRMA
// ============================================================================
titulo('1. LA NOTICIA Y EL PAYLOAD QUE SE FIRMA');

console.log(`  Título:    ${noticia.titulo}`);
console.log(`  Categoría: ${noticia.categoria}`);
console.log(`  Autor:     ${noticia.id_autor}`);
console.log('');
console.log('  El contenido completo no se firma tal cual: se firma su hash SHA-256,');
console.log('  porque RSA trabaja sobre bloques pequeños y el hash resume cualquier texto.');

const hashContenido = crypto.createHash('sha256').update(noticia.contenido, 'utf8').digest('hex');
const payload = `NOTICIA_UNACH|TITULO:${noticia.titulo}|CATEGORIA:${noticia.categoria}|AUTOR:${noticia.id_autor}|CONTENIDO_HASH:${hashContenido}`;

paso('  Payload canónico (misma secuencia de bytes para firmar y verificar):');
console.log(`    ${payload}`);

// ============================================================================
// 2. FIRMA CON LA LLAVE PRIVADA
// ============================================================================
titulo('2. FIRMA CON LA LLAVE PRIVADA (LO QUE SE GUARDA EN LA BD)');

const firmador = crypto.createSign('SHA256');
firmador.update(payload, 'utf8');
firmador.end();
const firma = firmador.sign(privateKey, 'base64');

console.log('  El servidor firma el payload con la llave privada RSA de 3072 bits:');
console.log(`    noticias.firma_digital = ${firma.slice(0, 72)}...`);
console.log(`    Longitud: ${firma.length} caracteres Base64`);
console.log('');
console.log('  En SQLite se vería así (la firma no oculta el texto, solo lo sella):');
console.log(`    UPDATE noticias SET firma_digital = '${firma.slice(0, 24)}...' WHERE id = 1;`);
console.log('');
console.log('  La noticia sigue siendo legible. La firma no es un cifrado: es una prueba.');
console.log('  Si alguien cambia el texto, la firma deja de corresponder.');
console.log('');
console.log('  Nota: con RSA PKCS#1 v1.5, firmar dos veces el mismo payload produce');
console.log('  exactamente la misma firma (no usa IV como AES). Eso permite comparar.');

// ============================================================================
// 3. VERIFICACIÓN CON LA LLAVE PÚBLICA
// ============================================================================
titulo('3. VERIFICACIÓN CON LA LLAVE PÚBLICA');

function verificar(payloadAComprobar, firmaAComprobar, llavePublica = publicKey) {
  const verificador = crypto.createVerify('SHA256');
  verificador.update(payloadAComprobar, 'utf8');
  verificador.end();
  return verificador.verify(llavePublica, firmaAComprobar, 'base64');
}

console.log(`  ¿Firma válida? ${verificar(payload, firma) ? 'SÍ ✔' : 'NO ✘'}`);
console.log('  La llave pública solo puede comprobar; no sirve para firmar.');
console.log('  Por eso se puede repartir sin riesgo (de hecho, la app la expone en');
console.log('  /api/crypto/public-key para que cualquiera audite las noticias).');

// ============================================================================
// 4. ALTERACIÓN DEL TEXTO
// ============================================================================
titulo('4. SI ALGUIEN CAMBIA UNA SOLA LETRA...');

const noticiaAlterada = { ...noticia, titulo: noticia.titulo.replace('Inauguran', 'Cancelan') };
const hashAlterado = crypto.createHash('sha256').update(noticiaAlterada.contenido, 'utf8').digest('hex');
const payloadAlterado = `NOTICIA_UNACH|TITULO:${noticiaAlterada.titulo}|CATEGORIA:${noticiaAlterada.categoria}|AUTOR:${noticiaAlterada.id_autor}|CONTENIDO_HASH:${hashAlterado}`;

console.log(`  Título original: ${noticia.titulo}`);
console.log(`  Título alterado: ${noticiaAlterada.titulo}`);
console.log('');
console.log(`  Payload alterado: ${payloadAlterado}`);
console.log('');
console.log(`  ¿La firma original sigue siendo válida? ${verificar(payloadAlterado, firma) ? 'SÍ (ERROR)' : 'NO ✘ -> alteración detectada'}`);
console.log('  La firma está atada al payload exacto: cambia un carácter y ya no coincide.');

// ============================================================================
// 5. OTRA LLAVE NO PUEDE SUPLANTAR AL PORTAL
// ============================================================================
titulo('5. OTRA LLAVE PÚBLICA TAMPOCO VALIDA LA FIRMA');

const parAjeno = crypto.generateKeyPairSync('rsa', {
  modulusLength: 3072,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
});

console.log('  Se generó un par RSA nuevo (el de un atacante).');
console.log(`  ¿La firma del portal valida con esa llave pública ajena? ${verificar(payload, firma, parAjeno.publicKey) ? 'SÍ (ERROR)' : 'NO ✔'}`);
console.log('  Cada firma pertenece a una sola llave privada. Sin la privada del portal,');
console.log('  no se puede fabricar una firma que la pública del portal acepte.');

// ============================================================================
// RESUMEN
// ============================================================================
titulo('RESUMEN');
console.log('  PRIVADA  -> firma (solo el servidor la tiene).');
console.log('  PÚBLICA  -> verifica (se puede repartir).');
console.log('  FIRMA    -> valor Base64 que se guarda junto a la noticia.');
console.log('  ALTERAR  -> la verificación falla: el documento ya no es confiable.');
console.log('');
console.log('  En la app: abre una noticia y usa los botones del panel');
console.log('  "Garantías Criptográficas de la Publicación".');
console.log('');
