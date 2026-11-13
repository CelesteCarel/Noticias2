const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('../database/db');

/**
 * Llaves asimétricas para firmar y verificar los access tokens (RS256).
 *
 * La llave privada nunca se versiona: se genera con `npm run keys` y su ruta se
 * indica con JWT_PRIVATE_KEY_PATH. La pública (JWT_PUBLIC_KEY_PATH) permite
 * verificar la firma sin poseer la privada.
 */
function loadKeyMaterial() {
  const privatePath = (process.env.JWT_PRIVATE_KEY_PATH || '').trim();
  const publicPath = (process.env.JWT_PUBLIC_KEY_PATH || '').trim();

  if (!privatePath || !publicPath) {
    throw new Error(
      'Faltan JWT_PRIVATE_KEY_PATH y/o JWT_PUBLIC_KEY_PATH. '
      + 'Ejecuta `npm run keys` para generar el par de llaves RSA y define ambas rutas en tu .env '
      + '(por ejemplo: JWT_PRIVATE_KEY_PATH=./keys/jwt-private.pem).'
    );
  }

  const resolvedPrivate = path.resolve(privatePath);
  const resolvedPublic = path.resolve(publicPath);

  const missing = [resolvedPrivate, resolvedPublic].filter((file) => !fs.existsSync(file));
  if (missing.length > 0) {
    throw new Error(
      `No se encontró la llave RSA en: ${missing.join(', ')}. `
      + 'Ejecuta `npm run keys` para generarla y revisa las rutas en tu .env.'
    );
  }

  const privateKey = fs.readFileSync(resolvedPrivate, 'utf8');
  const publicKey = fs.readFileSync(resolvedPublic, 'utf8');

  if (!privateKey.trim() || !publicKey.trim()) {
    throw new Error(
      'Las llaves JWT están vacías. Ejecuta `npm run keys` para volver a generarlas.'
    );
  }

  return { privateKey, publicKey };
}

const { privateKey: JWT_PRIVATE_KEY, publicKey: JWT_PUBLIC_KEY } = loadKeyMaterial();

const ACCESS_TOKEN_EXPIRY = '15m'; // 15 minutos (Requerimiento de seguridad computacional)
const REFRESH_TOKEN_EXPIRY_DAYS = 7;

/**
 * Genera un Access Token de corta duración firmado con RS256.
 */
function generateAccessToken(user) {
  return jwt.sign(
    {
      id: user.id,
      email: user.email,
      id_rol: user.id_rol,
      nombre_rol: user.nombre_rol
    },
    JWT_PRIVATE_KEY,
    { expiresIn: ACCESS_TOKEN_EXPIRY, algorithm: 'RS256' }
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

  jwt.verify(token, JWT_PUBLIC_KEY, { algorithms: ['RS256'] }, (err, decoded) => {
    if (err) {
      if (err.name === 'TokenExpiredError') {
        return res.status(401).json({
          error: 'El token de acceso ha expirado',
          code: 'TOKEN_EXPIRED'
        });
      }
      return res.status(401).json({ error: 'Token inválido' });
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

  jwt.verify(token, JWT_PUBLIC_KEY, { algorithms: ['RS256'] }, (err, decoded) => {
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
  REFRESH_TOKEN_EXPIRY_DAYS
};