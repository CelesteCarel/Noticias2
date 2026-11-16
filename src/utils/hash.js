/**
 * Huellas SHA-256 para secretos de un solo uso.
 *
 * Los códigos de recuperación y los refresh tokens no se guardan en texto plano:
 * se almacena su hash SHA-256. Un volcado de la base de datos no permite
 * reutilizarlos, y la comparación se hace en tiempo constante para no filtrar
 * información por el tiempo de respuesta.
 */
const crypto = require('node:crypto');

const LONGITUD_HASH = 64; // 32 bytes en hexadecimal

/**
 * Devuelve el hash SHA-256 de un valor en hexadecimal (64 caracteres).
 */
function hashSha256(valor) {
  return crypto.createHash('sha256').update(String(valor), 'utf8').digest('hex');
}

/**
 * Compara un valor en claro con un hash guardado sin cortocircuitar en el
 * primer byte distinto. Devuelve false si el hash almacenado no tiene el
 * formato esperado.
 */
function hashCoincide(valor, hashGuardado) {
  if (typeof valor !== 'string' || typeof hashGuardado !== 'string') return false;
  if (!/^[0-9a-f]{64}$/i.test(hashGuardado)) return false;

  const calculado = Buffer.from(hashSha256(valor), 'hex');
  const guardado = Buffer.from(hashGuardado, 'hex');
  if (calculado.length !== guardado.length) return false;

  return crypto.timingSafeEqual(calculado, guardado);
}

/**
 * Reconoce una cadena que ya es un hash SHA-256 en hexadecimal. Se usa en la
 * migración de bases existentes para no volver a hashear lo que ya lo está.
 */
function esHashSha256(valor) {
  return typeof valor === 'string' && new RegExp(`^[0-9a-f]{${LONGITUD_HASH}}$`, 'i').test(valor);
}

module.exports = {
  hashSha256,
  hashCoincide,
  esHashSha256,
  LONGITUD_HASH
};
