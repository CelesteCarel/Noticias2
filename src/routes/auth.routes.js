const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { randomInt } = require('crypto');
const db = require('../database/db');
const {
  authenticateToken,
  generateAccessToken,
  generateRefreshToken,
  validateRefreshToken,
  revokeRefreshToken,
  revokeAllUserTokens,
  getCookie
} = require('../middleware/auth');
const { getUserPermissions } = require('../middleware/permissions');
const { logAudit, getClientIp } = require('../middleware/audit');
const { authLimiter } = require('../middleware/rateLimiter');
const {
  sanitizeInput,
  isValidEmail,
  isValidPassword,
  isValidText,
  normalizeEmail,
  MAX_NOMBRE
} = require('../middleware/sanitizer');
const emailService = require('../services/email.service');

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;
const BCRYPT_SALT_ROUNDS = 12;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

// Aplicar sanitización a todas las rutas de autenticación
router.use(sanitizeInput);

/**
 * Emite los tokens de sesión como cookies HttpOnly + Secure + SameSite.
 * El access token también viaja en el cuerpo JSON de la respuesta para poder
 * consume la API con el encabezado `Authorization: Bearer <token>`.
 */
function setAuthCookies(res, accessToken, refreshToken) {
  const isProd = process.env.NODE_ENV === 'production';
  const secure = isProd || process.env.HTTPS_ENABLED === 'true';

  const cookieOptions = [
    `portal_access_token=${accessToken}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    'Max-Age=900' // 15 minutos
  ];
  if (secure) cookieOptions.push('Secure');

  const refreshCookieOptions = [
    `portal_refresh_token=${refreshToken}`,
    'Path=/api/auth',
    'HttpOnly',
    'SameSite=Strict',
    'Max-Age=604800'
  ];
  if (secure) refreshCookieOptions.push('Secure');

  res.setHeader('Set-Cookie', [cookieOptions.join('; '), refreshCookieOptions.join('; ')]);
}

function clearAuthCookies(res) {
  const secure = process.env.NODE_ENV === 'production' || process.env.HTTPS_ENABLED === 'true';
  const secureAttr = secure ? '; Secure' : '';
  res.setHeader('Set-Cookie', [
    `portal_access_token=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secureAttr}`,
    `portal_refresh_token=; Path=/api/auth; HttpOnly; SameSite=Strict; Max-Age=0${secureAttr}`
  ]);
}

function buildSession(user, res, extra = {}) {
  const accessToken = generateAccessToken(user);
  const refreshToken = generateRefreshToken(user.id);
  const permissions = getUserPermissions(user.id_rol);

  setAuthCookies(res, accessToken, refreshToken);

  return {
    accessToken,
    tokenType: 'Bearer',
    expiresIn: 900,
    user: {
      id: user.id,
      nombre: user.nombre,
      email: user.email,
      id_rol: user.id_rol,
      nombre_rol: user.nombre_rol
    },
    permissions,
    ...extra
  };
}

/**
 * 1. Registro de Usuario
 */
router.post('/register', authLimiter, (req, res) => {
  const { nombre, email, password } = req.body;
  const ip = getClientIp(req);

  if (!nombre || !email || !password) {
    return res.status(400).json({ error: 'Todos los campos son obligatorios' });
  }

  if (!isValidText(nombre, { min: 3, max: MAX_NOMBRE })) {
    return res.status(400).json({ error: `El nombre debe tener entre 3 y ${MAX_NOMBRE} caracteres` });
  }

  if (!isValidEmail(email)) {
    return res.status(400).json({ error: 'Formato de correo electrónico inválido' });
  }

  if (!isValidPassword(password)) {
    return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres' });
  }

  const correo = normalizeEmail(email);

  try {
    const existing = db.prepare('SELECT id FROM usuarios WHERE email = ?').get(correo);
    if (existing) {
      return res.status(400).json({ error: 'El correo electrónico ya se encuentra registrado' });
    }

    // Rol por defecto: Usuario Regular (Lector). El rol nunca se toma del cuerpo
    // de la petición para evitar escalada de privilegios (mass assignment).
    const regularRole = db.prepare('SELECT id FROM roles WHERE nombre_rol = ?').get('Usuario Regular');
    const roleId = regularRole ? regularRole.id : 3;

    const hashedPassword = bcrypt.hashSync(password, bcrypt.genSaltSync(BCRYPT_SALT_ROUNDS));

    const insert = db.prepare('INSERT INTO usuarios (nombre, email, password, id_rol) VALUES (?, ?, ?, ?)');
    const result = insert.run(nombre, correo, hashedPassword, roleId);
    const userId = Number(result.lastInsertRowid);

    logAudit(userId, 'Registro de Usuario', `Nuevo usuario registrado: ${nombre} (${correo})`, ip);

    const session = buildSession({ id: userId, nombre, email: correo, id_rol: roleId, nombre_rol: 'Usuario Regular' }, res, {
      message: 'Usuario registrado exitosamente'
    });

    res.status(201).json(session);
  } catch (error) {
    console.error('Error en registro:', error.message);
    res.status(500).json({ error: 'Error interno al registrar el usuario' });
  }
});

/**
 * 2. Inicio de Sesión (Con protección contra fuerza bruta)
 */
router.post('/login', authLimiter, (req, res) => {
  const { email, password } = req.body;
  const ip = getClientIp(req);

  if (!email || !password) {
    return res.status(400).json({ error: 'Email y contraseña requeridos' });
  }

  const correo = normalizeEmail(email);

  try {
    const user = db.prepare(`
      SELECT u.id, u.nombre, u.email, u.password, u.id_rol, u.intentos_fallidos,
             u.bloqueado_hasta, r.nombre_rol
      FROM usuarios u
      JOIN roles r ON u.id_rol = r.id
      WHERE u.email = ?
    `).get(correo);

    if (!user) {
      logAudit(null, 'Intento de Inicio de Sesión Fallido', `Usuario inexistente: ${correo}`, ip);
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    const now = new Date();

    // Validar si la cuenta está actualmente bloqueada
    if (user.bloqueado_hasta) {
      if (new Date(user.bloqueado_hasta) > now) {
        const remainingMinutes = Math.ceil((new Date(user.bloqueado_hasta) - now) / 60000);
        logAudit(user.id, 'Intento de Acceso a Cuenta Bloqueada', `Cuenta temporalmente bloqueada para ${correo}`, ip);
        return res.status(423).json({
          error: `Cuenta bloqueada temporalmente por seguridad debido a múltiples intentos fallidos. Intenta nuevamente en ${remainingMinutes} minuto(s).`
        });
      }

      // El bloqueo ya venció: el contador vuelve a cero. Sin esto, el contador se
      // quedaba en 5 para siempre y un solo error de escritura bloqueaba la
      // cuenta otros 15 minutos de inmediato, sin dar margen a intentarlo otra vez.
      db.prepare('UPDATE usuarios SET intentos_fallidos = 0, bloqueado_hasta = NULL WHERE id = ?').run(user.id);
      user.intentos_fallidos = 0;
      user.bloqueado_hasta = null;
    }

    const isValid = bcrypt.compareSync(password, user.password);

    if (!isValid) {
      const intentos = (user.intentos_fallidos || 0) + 1;

      if (intentos >= MAX_FAILED_ATTEMPTS) {
        const lockoutTime = new Date(now.getTime() + LOCKOUT_MINUTES * 60000).toISOString();
        db.prepare('UPDATE usuarios SET intentos_fallidos = ?, bloqueado_hasta = ? WHERE id = ?')
          .run(intentos, lockoutTime, user.id);

        logAudit(
          user.id,
          'Bloqueo Temporal de Cuenta',
          `Cuenta bloqueada por ${LOCKOUT_MINUTES} minutos tras ${MAX_FAILED_ATTEMPTS} intentos fallidos`,
          ip
        );

        return res.status(423).json({
          error: `Has superado el límite de intentos permitidos (${MAX_FAILED_ATTEMPTS}). Tu cuenta ha sido bloqueada temporalmente por ${LOCKOUT_MINUTES} minutos por seguridad.`
        });
      }

      db.prepare('UPDATE usuarios SET intentos_fallidos = ? WHERE id = ?').run(intentos, user.id);
      const restantes = MAX_FAILED_ATTEMPTS - intentos;

      logAudit(user.id, 'Intento de Inicio de Sesión Fallido', `Contraseña incorrecta para ${correo} (Intento ${intentos}/${MAX_FAILED_ATTEMPTS})`, ip);

      return res.status(401).json({
        error: `Credenciales inválidas. Te quedan ${restantes} intento(s) antes del bloqueo temporal.`
      });
    }

    // Login exitoso: restablecer contadores de fallos
    db.prepare('UPDATE usuarios SET intentos_fallidos = 0, bloqueado_hasta = NULL WHERE id = ?').run(user.id);

    const session = buildSession(user, res, { message: 'Inicio de sesión exitoso' });

    logAudit(user.id, 'Inicio de Sesión', `Usuario ${user.nombre} (${user.nombre_rol}) inició sesión`, ip);

    res.json(session);
  } catch (error) {
    console.error('Error en login:', error.message);
    res.status(500).json({ error: 'Error interno en el servidor' });
  }
});

/**
 * 3. Renovación de Access Token (Refresh Token rotatorio)
 */
router.post('/refresh', (req, res) => {
  const refreshToken = getCookie(req, 'portal_refresh_token') || req.body.refreshToken;

  if (!refreshToken) {
    return res.status(400).json({ error: 'Refresh token requerido' });
  }

  const user = validateRefreshToken(refreshToken);

  if (!user) {
    clearAuthCookies(res);
    return res.status(401).json({ error: 'Refresh token inválido o expirado. Inicia sesión nuevamente.' });
  }

  // Rotación: el refresh token usado se revoca y se emite uno nuevo.
  revokeRefreshToken(refreshToken);

  const session = buildSession(user, res);

  res.json(session);
});

/**
 * 4. Obtener perfil de usuario actual
 */
router.get('/me', authenticateToken, (req, res) => {
  res.json({
    user: req.user,
    permissions: getUserPermissions(req.user.id_rol)
  });
});

/**
 * 5. Cambio de Contraseña (Usuario Autenticado)
 */
router.post('/change-password', authenticateToken, (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const ip = getClientIp(req);

  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Debes proporcionar la contraseña actual y la nueva contraseña' });
  }

  if (!isValidPassword(newPassword)) {
    return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 8 caracteres' });
  }

  if (newPassword === currentPassword) {
    return res.status(400).json({ error: 'La nueva contraseña debe ser distinta de la actual' });
  }

  try {
    const user = db.prepare('SELECT password FROM usuarios WHERE id = ?').get(req.user.id);
    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    const isValid = bcrypt.compareSync(currentPassword, user.password);
    if (!isValid) {
      logAudit(req.user.id, 'Fallo en Cambio de Contraseña', 'Contraseña actual incorrecta', ip);
      return res.status(400).json({ error: 'La contraseña actual ingresada es incorrecta' });
    }

    const hashedPassword = bcrypt.hashSync(newPassword, bcrypt.genSaltSync(BCRYPT_SALT_ROUNDS));

    db.prepare('UPDATE usuarios SET password = ? WHERE id = ?').run(hashedPassword, req.user.id);

    // Por seguridad se invalidan todas las sesiones activas del usuario.
    revokeAllUserTokens(req.user.id);
    clearAuthCookies(res);

    logAudit(req.user.id, 'Cambio de Contraseña', 'Contraseña modificada exitosamente; se revocaron todas las sesiones', ip);

    res.json({
      message: 'Tu contraseña ha sido actualizada correctamente. Por seguridad, vuelve a iniciar sesión.',
      reauthRequired: true
    });
  } catch (error) {
    console.error('Error al cambiar contraseña:', error.message);
    res.status(500).json({ error: 'Error interno al actualizar la contraseña' });
  }
});

/**
 * 6. Solicitud de Recuperación de Contraseña (Envío Real de Correo)
 */
router.post('/forgot-password', authLimiter, async (req, res) => {
  const { email } = req.body;
  const ip = getClientIp(req);

  if (!email || !isValidEmail(email)) {
    return res.status(400).json({ error: 'Ingresa un correo electrónico válido' });
  }

  const correo = normalizeEmail(email);

  try {
    const user = db.prepare('SELECT id, nombre, email FROM usuarios WHERE email = ?').get(correo);
    if (!user) {
      return res.status(404).json({ error: 'No existe ninguna cuenta registrada con este correo electrónico' });
    }

    // Código numérico de 6 dígitos generado con fuente criptográfica
    const resetCode = randomInt(100000, 1000000).toString();
    const expireTime = new Date(Date.now() + 15 * 60000).toISOString();

    db.prepare('UPDATE usuarios SET codigo_recuperacion = ?, codigo_expira = ? WHERE id = ?')
      .run(resetCode, expireTime, user.id);

    let envio;
    try {
      envio = await emailService.sendPasswordResetEmail(user.email, user.nombre, resetCode);
    } catch (emailError) {
      console.error('Error al enviar el correo electrónico:', emailError.message);
      logAudit(user.id, 'Fallo Envío Correo Recuperación', 'Error del transporte de correo', ip);
      return res.status(500).json({
        error: 'No se pudo enviar el correo de verificación. Inténtalo más tarde.'
      });
    }

    logAudit(user.id, 'Solicitud de Recuperación de Contraseña', `Código de verificación enviado al correo ${correo}`, ip);

    /*
     * Sin SMTP configurado el correo no llega a ninguna bandeja real: nodemailer
     * lo entrega a una cuenta de prueba de Ethereal. Decir "revisa tu bandeja"
     * en ese caso sería mentir, porque el usuario se queda esperando un correo
     * que jamás llegará. Se responde distinguiendo los dos escenarios.
     *
     * El enlace de vista previa solo se devuelve fuera de producción: en un
     * despliegue real filtraría el código de recuperación de cualquier usuario.
     */
    if (envio.modoPrueba) {
      return res.json({
        message: 'El servidor está en modo de prueba: el código se entregó a una bandeja de prueba de Ethereal, '
          + 'no a tu correo. Define SMTP_USER y SMTP_PASS en .env para que llegue a tu bandeja real. '
          + 'Si ejecutas el servidor en tu equipo, el enlace del correo aparece en la consola.',
        email: user.email,
        modoPrueba: true,
        vistaPrevia: IS_PRODUCTION ? undefined : envio.previewUrl
      });
    }

    res.json({
      message: 'Se ha enviado un código de verificación de 6 dígitos a tu correo electrónico. Revisa tu bandeja de entrada o carpeta de spam.',
      email: user.email,
      modoPrueba: false
    });
  } catch (error) {
    console.error('Error en forgot-password:', error.message);
    res.status(500).json({ error: 'Error interno al procesar la solicitud' });
  }
});

/**
 * 7. Restablecimiento de Contraseña con Código de Verificación
 */
router.post('/reset-password', authLimiter, (req, res) => {
  const { email, resetCode, newPassword } = req.body;
  const ip = getClientIp(req);

  if (!email || !resetCode || !newPassword) {
    return res.status(400).json({ error: 'Todos los campos son obligatorios' });
  }

  if (!isValidPassword(newPassword)) {
    return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 8 caracteres' });
  }

  const correo = normalizeEmail(email);

  try {
    const user = db.prepare(`
      SELECT id, nombre, email, codigo_recuperacion, codigo_expira
      FROM usuarios
      WHERE email = ?
    `).get(correo);

    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    const now = new Date();

    if (!user.codigo_recuperacion || user.codigo_recuperacion !== String(resetCode).trim()) {
      logAudit(user.id, 'Fallo Restablecimiento Contraseña', `Código incorrecto ingresado para ${correo}`, ip);
      return res.status(400).json({ error: 'El código de verificación es incorrecto' });
    }

    if (!user.codigo_expira || new Date(user.codigo_expira) < now) {
      logAudit(user.id, 'Código de Recuperación Expirado', `Intento con código vencido para ${correo}`, ip);
      return res.status(400).json({ error: 'El código de verificación ha expirado. Solicita uno nuevo.' });
    }

    const hashedPassword = bcrypt.hashSync(newPassword, bcrypt.genSaltSync(BCRYPT_SALT_ROUNDS));

    // Actualizar contraseña y limpiar código temporal + desbloquear cuenta
    db.prepare(`
      UPDATE usuarios
      SET password = ?,
          codigo_recuperacion = NULL,
          codigo_expira = NULL,
          intentos_fallidos = 0,
          bloqueado_hasta = NULL
      WHERE id = ?
    `).run(hashedPassword, user.id);

    // Revocar tokens activos
    revokeAllUserTokens(user.id);
    clearAuthCookies(res);

    logAudit(user.id, 'Restablecimiento de Contraseña', `Contraseña restablecida exitosamente para ${correo}`, ip);

    res.json({ message: 'Tu contraseña ha sido restablecida exitosamente. Ahora puedes iniciar sesión con tu nueva clave.' });
  } catch (error) {
    console.error('Error en reset-password:', error.message);
    res.status(500).json({ error: 'Error interno al restablecer la contraseña' });
  }
});

/**
 * 8. Cerrar Sesión (Revocar Refresh Token)
 */
router.post('/logout', authenticateToken, (req, res) => {
  const refreshToken = getCookie(req, 'portal_refresh_token') || req.body.refreshToken;

  if (refreshToken) {
    revokeRefreshToken(refreshToken);
  }
  revokeAllUserTokens(req.user.id);
  clearAuthCookies(res);

  logAudit(req.user.id, 'Cierre de Sesión', `El usuario ${req.user.email} cerró su sesión`, getClientIp(req));

  res.json({ message: 'Sesión cerrada correctamente' });
});

module.exports = router;