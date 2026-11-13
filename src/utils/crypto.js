/**
 * Cifrado simétrico de datos de la aplicación con AES-256-GCM.
 *
 * La llave nunca vive en el código: se toma de la variable de entorno
 * DATA_ENCRYPTION_KEY, que debe contener 32 bytes expresados en hexadecimal
 * (64 caracteres). Cada operación usa un IV aleatorio nuevo de 12 bytes, de modo
 * que dos cifrados del mismo texto producen resultados distintos.
 *
 * Formato almacenado: v1:<iv_base64>:<tag_base64>:<datos_base64>
 * La etiqueta (tag) de GCM autentica el dato: si alguien lo altera, descifrar
 * falla en lugar de devolver basura silenciosamente.
 */
const crypto = require('node:crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const PREFIX = 'v1';

const GENERATE_KEY_COMMAND = 'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"';

function loadKey() {
  const raw = (process.env.DATA_ENCRYPTION_KEY || '').trim();

  if (!raw) {
    throw new Error(
      'Falta DATA_ENCRYPTION_KEY. Genera una llave de 32 bytes en hexadecimal con: '
      + GENERATE_KEY_COMMAND
      + ' y guárdala en tu archivo .env (nunca en el código fuente).'
    );
  }

  if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
    throw new Error(
      'DATA_ENCRYPTION_KEY no es válida: deben ser 32 bytes en hexadecimal (64 caracteres 0-9 y a-f). '
      + 'Genera una nueva con: '
      + GENERATE_KEY_COMMAND
    );
  }

  return Buffer.from(raw, 'hex');
}

const KEY = loadKey();

/**
 * Cifra un texto con AES-256-GCM.
 * Devuelve null o cadena vacía tal cual cuando no hay dato que proteger.
 */
function encrypt(texto) {
  if (texto === null || texto === undefined || texto === '') {
    return texto;
  }

  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, KEY, iv, { authTagLength: TAG_BYTES });

  const datos = Buffer.concat([
    cipher.update(String(texto), 'utf8'),
    cipher.final()
  ]);
  const tag = cipher.getAuthTag();

  return `${PREFIX}:${iv.toString('base64')}:${tag.toString('base64')}:${datos.toString('base64')}`;
}

/**
 * Descifra un valor con el formato v1:<iv>:<tag>:<datos>.
 * Lanza un error si el prefijo no es v1, si el formato es inválido o si la
 * autenticación GCM falla (dato alterado o llave incorrecta).
 */
function decrypt(valor) {
  if (valor === null || valor === undefined || valor === '') {
    return valor;
  }

  if (typeof valor !== 'string' || !valor.startsWith(`${PREFIX}:`)) {
    throw new Error('Formato de dato cifrado no reconocido: se esperaba el prefijo "v1:"');
  }

  const parts = valor.split(':');
  if (parts.length !== 4) {
    throw new Error('Formato de dato cifrado inválido: se esperaban 4 segmentos separados por ":"');
  }

  const [, ivB64, tagB64, datosB64] = parts;

  let iv;
  let tag;
  let datos;
  try {
    iv = Buffer.from(ivB64, 'base64');
    tag = Buffer.from(tagB64, 'base64');
    datos = Buffer.from(datosB64, 'base64');
  } catch {
    throw new Error('Formato de dato cifrado inválido: los segmentos no son Base64 válido');
  }

  if (iv.length !== IV_BYTES) {
    throw new Error(`Formato de dato cifrado inválido: el IV debe tener ${IV_BYTES} bytes`);
  }
  if (tag.length !== TAG_BYTES) {
    throw new Error(`Formato de dato cifrado inválido: el tag debe tener ${TAG_BYTES} bytes`);
  }

  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, KEY, iv, { authTagLength: TAG_BYTES });
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(datos), decipher.final()]).toString('utf8');
  } catch (error) {
    throw new Error(
      'No se pudo descifrar el dato: la autenticación GCM falló (dato alterado o llave incorrecta)',
      { cause: error }
    );
  }
}

/**
 * Comprueba de forma no criptográfica si una cadena declara el formato v1.
 * Útil para distinguir datos migrados de datos nuevos sin intentar descifrar.
 */
function isEncrypted(valor) {
  return typeof valor === 'string' && valor.startsWith(`${PREFIX}:`) && valor.split(':').length === 4;
}

module.exports = {
  encrypt,
  decrypt,
  isEncrypted,
  ALGORITHM,
  IV_BYTES,
  TAG_BYTES
};
