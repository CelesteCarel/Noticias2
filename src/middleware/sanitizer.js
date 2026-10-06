/**
 * Middleware de Sanitización y Validación de Entradas
 * Previene ataques de XSS, inyecciones de código y manipulación de datos.
 *
 * IMPORTANTE: los campos que contienen credenciales o secretos NUNCA deben
 * transformarse. Alterar una contraseña en silencio cambia la credencial que el
 * usuario cree haber elegido (y hace que dos contraseñas distintas abran la misma
 * cuenta), por lo que se excluyen del proceso de sanitización.
 */

/**
 * Campos exentos de sanitización: se comparan en minúsculas porque el objeto
 * recibido puede provenir de un JSON con cualquier capitalización.
 */
const CREDENTIAL_FIELDS = new Set([
  'password',
  'currentpassword',
  'newpassword',
  'confirmpassword',
  'refreshtoken',
  'resetcode',
  'codigo_recuperacion',
  'token',
  'authorization'
]);

function isCredentialField(key) {
  return CREDENTIAL_FIELDS.has(String(key).toLowerCase());
}

/**
 * Elimina de una cadena los patrones capaces de ejecutar script en el navegador.
 * No altera longitudes de credenciales porque nunca se invoca sobre ellas.
 */
function sanitizeString(value) {
  if (typeof value !== 'string') return value;

  return value
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, '')
    .replace(/<object\b[^<]*(?:(?!<\/object>)<[^<]*)*<\/object>/gi, '')
    .replace(/<embed\b[^<]*(?:(?!<\/embed>)<[^<]*)*<\/embed>/gi, '')
    .replace(/javascript:[^\s"'>]+/gi, '')
    .replace(/\bon\w+\s*=\s*(?:'[^']*'|"[^"]*"|[^\s>]+)/gi, '')
    .trim();
}

/**
 * Recorre un objeto aplicando sanitización a los valores de texto.
 * Las claves de tipo credencial se copian tal cual.
 */
function sanitizeObject(obj) {
  if (!obj || typeof obj !== 'object') return obj;

  if (Array.isArray(obj)) {
    return obj.map(item => sanitizeObject(item));
  }

  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    if (isCredentialField(key)) {
      result[key] = value;
    } else if (typeof value === 'string') {
      result[key] = sanitizeString(value);
    } else if (typeof value === 'object' && value !== null) {
      result[key] = sanitizeObject(value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function sanitizeInput(req, res, next) {
  if (req.body) req.body = sanitizeObject(req.body);
  if (req.query) req.query = sanitizeObject(req.query);
  if (req.params) req.params = sanitizeObject(req.params);
  next();
}

/**
 * Validador de formato de correo electrónico
 */
function isValidEmail(email) {
  if (!email || typeof email !== 'string') return false;
  if (email.length > 254) return false;
  const regex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
  return regex.test(email.trim());
}

/**
 * Normaliza el correo a minúsculas para que el registro y el inicio de sesión
 * sean insensibles a mayúsculas y no existan cuentas duplicadas por capitalización.
 */
function normalizeEmail(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : email;
}

/**
 * Validador de robustez de contraseña. No se aplica ningún tipo de recorte o
 * normalización sobre la contraseña: solo se mide su longitud.
 */
function isValidPassword(password) {
  return typeof password === 'string' && password.length >= 8 && password.length <= 200;
}

/**
 * Valida que un campo de texto obligatorio exista, no sea vacío y no exceda la
 * longitud máxima permitida (protege contra abuso de almacenamiento y DoS).
 */
function isValidText(value, { min = 1, max = 255 } = {}) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return trimmed.length >= min && trimmed.length <= max;
}

module.exports = {
  sanitizeInput,
  sanitizeString,
  sanitizeObject,
  isCredentialField,
  isValidEmail,
  isValidPassword,
  isValidText,
  normalizeEmail,
  MAX_NOMBRE: 120,
  MAX_TITULO: 200,
  MAX_CONTENIDO: 20000,
  MAX_CATEGORIA: 60,
  MAX_ROL_NOMBRE: 60,
  MAX_DESCRIPCION: 255,
  MAX_URL: 2048
};