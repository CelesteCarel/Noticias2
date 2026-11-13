/**
 * Criptografía aplicada a las noticias del portal.
 *
 * - Cifrado simétrico: delega en src/utils/crypto.js (AES-256-GCM con
 *   DATA_ENCRYPTION_KEY y formato versionado v1:iv:tag:datos).
 * - Firma asimétrica: RSA-SHA256 con el mismo par de llaves que firma los JWT
 *   (JWT_PRIVATE_KEY_PATH / JWT_PUBLIC_KEY_PATH). Las llaves se generan con
 *   `npm run keys` y nunca se versionan.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { encrypt, decrypt, isEncrypted: hasV1Format } = require('./crypto');

function loadKeyMaterial() {
  const privatePath = process.env.JWT_PRIVATE_KEY_PATH;
  const publicPath = process.env.JWT_PUBLIC_KEY_PATH;

  if (!privatePath || !publicPath) {
    throw new Error(
      'Faltan JWT_PRIVATE_KEY_PATH y/o JWT_PUBLIC_KEY_PATH. '
      + 'Ejecuta `npm run keys` para generar el par RSA y define ambas rutas en tu .env.'
    );
  }

  const priv = path.resolve(privatePath);
  const pub = path.resolve(publicPath);

  if (!fs.existsSync(priv) || !fs.existsSync(pub)) {
    const faltante = !fs.existsSync(priv) ? priv : pub;
    throw new Error(
      `No se encontró la llave RSA: ${faltante}. `
      + 'Ejecuta `npm run keys` para generarla y revisa las rutas en tu .env.'
    );
  }

  return {
    privateKey: fs.readFileSync(priv, 'utf8'),
    publicKey: fs.readFileSync(pub, 'utf8')
  };
}

const keys = loadKeyMaterial();

// ============================================================================
// 1. CIFRADO SIMÉTRICO (AES-256-GCM)
// ============================================================================

/**
 * Cifra una nota confidencial. Devuelve null cuando no hay dato.
 */
function encryptSymmetric(text) {
  if (text === null || text === undefined || text === '') return null;
  return encrypt(String(text));
}

/**
 * Descifra una nota confidencial. Si el registro es anterior al formato v1 o
 * está alterado, devuelve un marcador en lugar de tumbar la lista completa de
 * noticias. El error real queda registrado en el servidor.
 */
function decryptSymmetric(encryptedString) {
  if (!encryptedString || typeof encryptedString !== 'string') return '';

  if (!hasV1Format(encryptedString)) {
    return '[DATO CON FORMATO DE CIFRADO ANTERIOR]';
  }

  try {
    return decrypt(encryptedString);
  } catch (error) {
    console.error('[Criptografía] No se pudo descifrar el dato:', error.message);
    return '[ERROR_DESCIFRADO_INTEGRIDAD_COMPROMETIDA]';
  }
}

function isEncrypted(str) {
  return hasV1Format(str);
}

// ============================================================================
// 2. FIRMA ASIMÉTRICA (RSA-SHA256)
// ============================================================================

/**
 * Representación canónica de una noticia para firmar y verificar exactamente
 * la misma secuencia binaria.
 */
function buildCanonicalPayload(news) {
  const contentHash = crypto.createHash('sha256').update(news.contenido || '', 'utf8').digest('hex');
  const title = (news.titulo || '').trim();
  const category = (news.categoria || '').trim();
  const author = String(news.id_autor || '');

  return `NOTICIA_UNACH|TITULO:${title}|CATEGORIA:${category}|AUTOR:${author}|CONTENIDO_HASH:${contentHash}`;
}

/**
 * Firma una noticia con la llave privada RSA del portal.
 */
function signNews(news) {
  const canonicalPayload = buildCanonicalPayload(news);
  const sign = crypto.createSign('SHA256');
  sign.update(canonicalPayload, 'utf8');
  sign.end();
  return sign.sign(keys.privateKey, 'base64');
}

/**
 * Verifica la firma de una noticia con la llave pública RSA.
 */
function verifyNewsSignature(news, signatureBase64) {
  if (!signatureBase64) {
    return { valid: false, reason: 'La noticia no posee una firma digital registrada' };
  }

  try {
    const canonicalPayload = buildCanonicalPayload(news);
    const verify = crypto.createVerify('SHA256');
    verify.update(canonicalPayload, 'utf8');
    verify.end();

    const isValid = verify.verify(keys.publicKey, signatureBase64, 'base64');
    return {
      valid: isValid,
      canonicalPayload,
      algorithm: 'RSA-SHA256',
      verifiedAt: new Date().toISOString()
    };
  } catch (error) {
    return { valid: false, reason: error.message, algorithm: 'RSA-SHA256' };
  }
}

function getPublicKey() {
  return keys.publicKey;
}

/**
 * Huella digital SHA-256 de la llave pública, útil para auditoría.
 */
function getPublicKeyFingerprint() {
  return crypto.createHash('sha256').update(keys.publicKey).digest('hex').match(/.{1,2}/g).join(':').toUpperCase();
}

module.exports = {
  // Cifrado simétrico
  encryptSymmetric,
  decryptSymmetric,
  isEncrypted,

  // Firma asimétrica
  signNews,
  verifyNewsSignature,
  buildCanonicalPayload,
  getPublicKey,
  getPublicKeyFingerprint
};
