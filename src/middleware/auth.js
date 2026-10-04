const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const db = require('../database/db');

const IS_PRODUCTION = process.env.NODE_ENV === 'production';

/**
 * Valores de ejemplo publicados en .env.example. Aceptarlos equivaldría a usar
 * una clave que cualquiera que clone el repositorio conoce, por lo que se
 * rechazan tanto en desarrollo como en producción.
 */
const PLACEHOLDER_SECRETS = new Set([
  'tu_clave_secreta_jwt_para_tokens_de_acceso',
  'tu_clave_secreta_para_refresh_tokens',
  'cambia-esta-clave',
  'secret',
  'changeme'
]);

const MIN_SECRET_LENGTH = 32;

function resolveSecret(name, envValue) {
  const provided = (envValue || '').trim();

  if (provided) {
    if (PLACEHOLDER_SECRETS.has(provided.toLowerCase())) {
      throw new Error(
        `${name} contiene un valor de ejemplo. Genera un secreto real con: node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`
      );
    }
    if (provided.length < MIN_SECRET_LENGTH) {
      throw new Error(`${name} debe tener al menos ${MIN_SECRET_LENGTH} caracteres (se requieren ${provided.length})`);
    }
    const lowEntropy = new Set(provided.toLowerCase()).size <= 4;
    if (lowEntropy) {
      throw new Error(`${name} es demasiado predecible; genera un valor criptográficamente aleatorio`);
    }
    return provided;
  }

  if (IS_PRODUCTION) {
    throw new Error(`${name} es obligatoria en producción. Defínela en la variable de entorno (nunca en el código fuente).`);
  }

  // Solo en desarrollo: secreto efímero para que la app arranque sin configuración,
  // pero se invalida al reiniciar el servidor (no es persistente ni predecible).
  return crypto.randomBytes(48).toString('hex');
}

const JWT_SECRET = resolveSecret('JWT_SECRET', process.env.JWT_SECRET);
const JWT_REFRESH_SECRET = resolveSecret('JWT_REFRESH_SECRET', process.env.JWT_REFRESH_SECRET);

if (JWT_SECRET === JWT_REFRESH_SECRET) {
  throw new Error('JWT_SECRET y JWT_REFRESH_SECRET deben ser distintos entre sí');
}

const ACCESS_TOKEN_EXPIRY = '15m'; // 15 minutos (Requerimiento de seguridad computacional)
const REFRESH_TOKEN_EXPIRY_DAYS = 7;

/**
 * Genera un Access Token de corta duración
 */
function generateAccessToken(user) {
  return jwt.sign(
    {
      id: user.id,
      email: user.email,
      id_rol: user.id_rol,
      nombre_rol: user.nombre_rol
    },
    JWT_SECRET,
    { expiresIn: ACCESS_TOKEN_EXPIRY, algorithm: 'HS256' }
  );
}

/**
 * Genera y almacena un Refresh Token en base de datos
 */
function generateRefreshToken(userId) {
  const token = crypto.randomBytes(40).toString('hex');
  const expiraEn = new Date(Date.now() + REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString();

  db.prepare(`
    INSERT INTO refresh_tokens (id_usuario, token, expira_en, revocado)
    VALUES (?, ?, ?, 0)
  `).run(userId, token, expiraEn);

  return token;
}

/**
 * Valida un Refresh Token en base de datos
 */
function validateRefreshToken(token) {
  if (!token) return null;

  const record = db.prepare(`
    SELECT rt.id, rt.id_usuario, rt.expira_en, rt.revocado,
           u.id as user_id, u.nombre, u.email, u.id_rol, u.bloqueado_hasta,
           r.nombre_rol
    FROM refresh_tokens rt
    JOIN usuarios u ON rt.id_usuario = u.id
    JOIN roles r ON u.id_rol = r.id
    WHERE rt.token = ? AND rt.revocado = 0
  `).get(token);

  if (!record) return null;

  const now = new Date();
  const expireDate = new Date(record.expira_en);

  if (now > expireDate) {
    // Expirado, marcar como revocado
    db.prepare('UPDATE refresh_tokens SET revocado = 1 WHERE id = ?').run(record.id);
    return null;
  }

  // Verificar que el usuario no esté bloqueado
  if (record.bloqueado_hasta && new Date(record.bloqueado_hasta) > now) {
    return null;
  }

  return {
    id: record.user_id,
    nombre: record.nombre,
    email: record.email,
    id_rol: record.id_rol,
    nombre_rol: record.nombre_rol,
    tokenId: record.id
  };
}

/**
 * Revoca un Refresh Token específico o todos de un usuario
 */
function revokeRefreshToken(token) {
  if (!token) return;
  db.prepare('UPDATE refresh_tokens SET revocado = 1 WHERE token = ?').run(token);
}

function revokeAllUserTokens(userId) {
  if (!userId) return;
  db.prepare('UPDATE refresh_tokens SET revocado = 1 WHERE id_usuario = ?').run(userId);
}

function getCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;

  const cookie = header.split(';').find(part => part.trim().startsWith(`${name}=`));
  return cookie ? decodeURIComponent(cookie.trim().slice(name.length + 1)) : null;
}

/**
 * Extrae el token JWT del encabezado Authorization (Authorization: Bearer <token>)
 * y, como respaldo, de la cookie HttpOnly emitida por el servidor.
 */
function extractToken(req) {
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    if (token) return token;
  }
  return getCookie(req, 'portal_access_token');
}

/**
 * Middleware de autenticación con Access Token.
 * Valida firma, expiración y existencia del usuario antes de continuar.
 */
function authenticateToken(req, res, next) {
  const token = extractToken(req);

  if (!token) {
    return res.status(401).json({ error: 'Acceso no autorizado: Token no proporcionado' });
  }

  jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] }, (err, decoded) => {
    if (err) {
      if (err.name === 'TokenExpiredError') {
        return res.status(401).json({
          error: 'El token de acceso ha expirado',
          code: 'TOKEN_EXPIRED'
        });
      }
      return res.status(403).json({ error: 'Token inválido' });
    }

    const user = db.prepare(`
      SELECT u.id, u.nombre, u.email, u.id_rol, u.bloqueado_hasta, r.nombre_rol
      FROM usuarios u
      JOIN roles r ON u.id_rol = r.id
      WHERE u.id = ?
    `).get(decoded.id);

    // Mismo mensaje para usuario inexistente que para token manipulado, para no
    // revelar qué identificadores existen en la base de datos.
    if (!user) {
      return res.status(401).json({ error: 'Sesión no válida. Inicia sesión nuevamente.' });
    }

    if (user.bloqueado_hasta && new Date(user.bloqueado_hasta) > new Date()) {
      return res.status(403).json({ error: 'La cuenta se encuentra temporalmente bloqueada por seguridad' });
    }

    req.user = user;
    next();
  });
}

/**
 * Middleware opcional de autenticación
 */
function optionalAuthenticateToken(req, res, next) {
  const token = extractToken(req);

  if (!token) {
    req.user = null;
    return next();
  }

  jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] }, (err, decoded) => {
    if (!err && decoded) {
      const user = db.prepare(`
        SELECT u.id, u.nombre, u.email, u.id_rol, r.nombre_rol
        FROM usuarios u
        JOIN roles r ON u.id_rol = r.id
        WHERE u.id = ?
      `).get(decoded.id);
      req.user = user || null;
    } else {
      req.user = null;
    }
    next();
  });
}

module.exports = {
  authenticateToken,
  optionalAuthenticateToken,
  generateAccessToken,
  generateRefreshToken,
  validateRefreshToken,
  revokeRefreshToken,
  revokeAllUserTokens,
  getCookie,
  extractToken,
  ACCESS_TOKEN_EXPIRY,
  REFRESH_TOKEN_EXPIRY_DAYS,
  JWT_SECRET,
  JWT_REFRESH_SECRET
};