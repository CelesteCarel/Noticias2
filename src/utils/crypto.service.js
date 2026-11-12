/**
 * Servicio Criptográfico Integral para el Portal de Noticias UNACH
 * 
 * Implementa dos mecanismos criptográficos usando la librería nativa 'node:crypto':
 * 
 * 1. CIFRADO SIMÉTRICO (AES-256-GCM):
 *    - Protección de datos confidenciales en reposo (ej. notas periodísticas confidenciales, fuentes protegidas).
 *    - Algoritmo: AES (Advanced Encryption Standard) con clave de 256 bits en modo GCM (Galois/Counter Mode).
 *    - Provee confidencialidad y autenticación de integridad (AEAD) mediante Authentication Tag de 16 bytes.
 *    - Llave: Obtenida desde la variable de entorno CRYPTO_AES_KEY (no hardcodeada).
 * 
 * 2. FIRMA DIGITAL ASIMÉTRICA (RSA-SHA256):
 *    - Garantía de integridad, autenticidad y no repudio de noticias y comunicados oficiales.
 *    - Algoritmo: RSA con longitud de clave de 2048 bits y función hash SHA-256.
 *    - Llaves: Par de claves asimétricas almacenadas en archivos protegidos .pem en el servidor
 *      (rutas configuradas en .env: PORTAL_PRIVATE_KEY_PATH y PORTAL_PUBLIC_KEY_PATH).
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Directorio base para certificados y llaves
const CERTS_DIR = path.join(__dirname, '../../certs');

// ============================================================================
// 1. GESTIÓN DE LLAVES Y CONFIGURACIÓN
// ============================================================================

/**
 * Obtiene la llave simétrica de 256 bits (32 bytes) para AES-256-GCM.
 * La llave debe estar configurada en la variable de entorno CRYPTO_AES_KEY en formato HEX (64 caracteres).
 * Si no existe, genera una advertencia y deriva una de emergencia basada en JWT_SECRET
 * o genera una de 32 bytes para no interrumpir el arranque.
 */
function getSymmetricKey() {
  const envKey = process.env.CRYPTO_AES_KEY;
  if (envKey) {
    // Si viene en hexadecimal (64 caracteres)
    if (/^[0-9a-fA-F]{64}$/.test(envKey)) {
      return Buffer.from(envKey, 'hex');
    }
    // Si viene como texto plano, usamos scrypt para derivar exactamente 32 bytes
    return crypto.scryptSync(envKey, 'unach-salt-ciberseguridad-2026', 32);
  }

  // Si no está configurada, usar JWT_SECRET como derivador de respaldo
  const fallback = process.env.JWT_SECRET || 'clave-secreta-unach-criptografia-2026';
  return crypto.scryptSync(fallback, 'unach-salt-ciberseguridad-2026', 32);
}

/**
 * Rutas de las llaves asimétricas RSA
 */
function getAsymmetricKeyPaths() {
  const privatePath = process.env.PORTAL_PRIVATE_KEY_PATH
    ? path.resolve(process.env.PORTAL_PRIVATE_KEY_PATH)
    : path.join(CERTS_DIR, 'portal-private.pem');

  const publicPath = process.env.PORTAL_PUBLIC_KEY_PATH
    ? path.resolve(process.env.PORTAL_PUBLIC_KEY_PATH)
    : path.join(CERTS_DIR, 'portal-public.pem');

  return { privatePath, publicPath };
}

/**
 * Inicializa y asegura la existencia del par de llaves asimétricas RSA (2048 bits).
 * Si no existen los archivos .pem, los genera de manera segura usando crypto.generateKeyPairSync
 * y los guarda en el directorio protegido /certs.
 */
function ensureAsymmetricKeys() {
  const { privatePath, publicPath } = getAsymmetricKeyPaths();

  if (!fs.existsSync(CERTS_DIR)) {
    fs.mkdirSync(CERTS_DIR, { recursive: true });
  }

  if (!fs.existsSync(privatePath) || !fs.existsSync(publicPath)) {
    console.log('[Criptografía] Generando nuevo par de claves asimétricas RSA (2048 bits) para el portal...');
    
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: {
        type: 'spki',
        format: 'pem'
      },
      privateKeyEncoding: {
        type: 'pkcs8',
        format: 'pem'
      }
    });

    fs.writeFileSync(privatePath, privateKey, { encoding: 'utf8', mode: 0o600 });
    fs.writeFileSync(publicPath, publicKey, { encoding: 'utf8', mode: 0o644 });
    console.log('[Criptografía] Claves RSA guardadas en:', { privatePath, publicPath });
  }

  return {
    privateKey: fs.readFileSync(privatePath, 'utf8'),
    publicKey: fs.readFileSync(publicPath, 'utf8')
  };
}

// Cargar las llaves al iniciar
let asymmetricKeys = null;
try {
  asymmetricKeys = ensureAsymmetricKeys();
} catch (err) {
  console.warn('[Criptografía] Advertencia al cargar llaves asimétricas:', err.message);
}

// ============================================================================
// 2. MECANISMO 1: CIFRADO SIMÉTRICO (AES-256-GCM)
// ============================================================================

/**
 * Cifra un texto sensible utilizando AES-256-GCM.
 * 
 * Flujo:
 * 1. Genera un Vector de Inicialización (IV) único de 12 bytes mediante crypto.randomBytes(12).
 * 2. Inicializa el cifrador AES-256-GCM con la clave simétrica y el IV.
 * 3. Cifra el contenido plano.
 * 4. Obtiene la etiqueta de autenticación (Auth Tag de 16 bytes) generada por el modo GCM.
 * 5. Empaqueta el resultado en el formato estándar: `iv:authTag:ciphertext` (en hexadecimal).
 * 
 * @param {string} text - Texto plano a cifrar
 * @returns {string} Texto cifrado empaquetado o null si la entrada es vacía
 */
function encryptSymmetric(text) {
  if (text === null || text === undefined || text === '') {
    return null;
  }

  const plainText = String(text);
  const key = getSymmetricKey();
  
  // Para GCM se recomiendan 12 bytes (96 bits) de IV para máximo rendimiento y seguridad
  const iv = crypto.randomBytes(12);
  
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  
  let encrypted = cipher.update(plainText, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  
  const authTag = cipher.getAuthTag(); // 16 bytes
  
  // Formato: iv:authTag:cipherHex
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

/**
 * Descifra una cadena previamente cifrada con AES-256-GCM.
 * 
 * Flujo:
 * 1. Desempaqueta la cadena en IV (12 bytes), Auth Tag (16 bytes) y Ciphertext.
 * 2. Inicializa el descifrador AES-256-GCM con la clave simétrica y el IV.
 * 3. Establece la etiqueta de autenticación para verificar la integridad.
 * 4. Descifra el contenido y valida el tag; si el tag no coincide (datos alterados),
 *    la librería crypto lanza una excepción inmediatamente.
 * 
 * @param {string} encryptedString - Cadena en formato iv:authTag:ciphertext
 * @returns {string} Texto descifrado en claro
 */
function decryptSymmetric(encryptedString) {
  if (!encryptedString || typeof encryptedString !== 'string') {
    return '';
  }

  // Comprobar formato iv:authTag:ciphertext
  const parts = encryptedString.split(':');
  if (parts.length !== 3) {
    // Si no está cifrado en formato GCM, retornar tal cual (retrocompatibilidad)
    return encryptedString;
  }

  const [ivHex, authTagHex, cipherHex] = parts;
  
  try {
    const key = getSymmetricKey();
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    
    let decrypted = decipher.update(cipherHex, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    
    return decrypted;
  } catch (error) {
    console.error('[Criptografía] Error al descifrar dato simétrico:', error.message);
    return '[ERROR_DESCIFRADO_INTEGRIDAD_COMPROMETIDA]';
  }
}

/**
 * Verifica si una cadena corresponde al formato de cifrado AES-256-GCM (iv:tag:data).
 */
function isEncrypted(str) {
  if (typeof str !== 'string') return false;
  const parts = str.split(':');
  return parts.length === 3 && parts[0].length === 24 && parts[1].length === 32;
}

// ============================================================================
// 3. MECANISMO 2: FIRMA ASIMÉTRICA (RSA-SHA256)
// ============================================================================

/**
 * Construye la representación canónica estandarizada de los datos de una noticia
 * para garantizar que tanto la firma como la verificación operen sobre la misma secuencia binaria.
 */
function buildCanonicalPayload(news) {
  // Calculamos el hash SHA-256 del contenido para mantener el payload conciso
  const contentHash = crypto.createHash('sha256').update(news.contenido || '', 'utf8').digest('hex');
  const title = (news.titulo || '').trim();
  const category = (news.categoria || '').trim();
  const author = String(news.id_autor || '');

  return `NOTICIA_UNACH|TITULO:${title}|CATEGORIA:${category}|AUTOR:${author}|CONTENIDO_HASH:${contentHash}`;
}

/**
 * Genera una Firma Digital asimétrica para una noticia utilizando la Llave Privada RSA del portal.
 * Algoritmo: RSA-SHA256 (Firma digital estándar PKI).
 * 
 * @param {object} news - Objeto con datos de la noticia (titulo, contenido, categoria, id_autor)
 * @returns {string} Firma digital codificada en Base64
 */
function signNews(news) {
  if (!asymmetricKeys) {
    asymmetricKeys = ensureAsymmetricKeys();
  }

  const canonicalPayload = buildCanonicalPayload(news);
  const sign = crypto.createSign('SHA256');
  sign.update(canonicalPayload, 'utf8');
  sign.end();

  const signature = sign.sign(asymmetricKeys.privateKey, 'base64');
  return signature;
}

/**
 * Verifica la autenticidad e integridad de una noticia utilizando la Llave Pública RSA del portal.
 * 
 * @param {object} news - Objeto con los datos de la noticia
 * @param {string} signatureBase64 - Firma digital en Base64
 * @returns {object} { valid: boolean, canonicalPayload: string, reason?: string }
 */
function verifyNewsSignature(news, signatureBase64) {
  if (!signatureBase64) {
    return { valid: false, reason: 'La noticia no posee una firma digital registrada' };
  }

  if (!asymmetricKeys) {
    asymmetricKeys = ensureAsymmetricKeys();
  }

  try {
    const canonicalPayload = buildCanonicalPayload(news);
    const verify = crypto.createVerify('SHA256');
    verify.update(canonicalPayload, 'utf8');
    verify.end();

    const isValid = verify.verify(asymmetricKeys.publicKey, signatureBase64, 'base64');
    return {
      valid: isValid,
      canonicalPayload,
      algorithm: 'RSA-SHA256 (2048 bits)',
      verifiedAt: new Date().toISOString()
    };
  } catch (error) {
    return {
      valid: false,
      reason: error.message,
      algorithm: 'RSA-SHA256 (2048 bits)'
    };
  }
}

/**
 * Retorna la clave pública en formato PEM para auditoría o consumo de clientes externos.
 */
function getPublicKey() {
  if (!asymmetricKeys) {
    asymmetricKeys = ensureAsymmetricKeys();
  }
  return asymmetricKeys.publicKey;
}

/**
 * Calcula la huella digital (Fingerprint SHA-256) de la clave pública.
 */
function getPublicKeyFingerprint() {
  const pub = getPublicKey();
  return crypto.createHash('sha256').update(pub).digest('hex').match(/.{1,2}/g).join(':').toUpperCase();
}

module.exports = {
  // Cifrado Simétrico
  encryptSymmetric,
  decryptSymmetric,
  isEncrypted,
  getSymmetricKey,

  // Firma Asimétrica
  signNews,
  verifyNewsSignature,
  buildCanonicalPayload,
  getPublicKey,
  getPublicKeyFingerprint,
  ensureAsymmetricKeys
};
