const db = require('../database/db');

/**
 * Obtiene la lista de nombres de permisos asignados a un rol desde la BD.
 * Única fuente de verdad para la autorización: no hay atajos por nombre de rol,
 * de modo que revocar un permiso a un rol surte efecto de inmediato.
 */
function getUserPermissions(id_rol) {
  const rows = db.prepare(`
    SELECT p.nombre_permiso
    FROM permisos p
    JOIN rol_permisos rp ON p.id = rp.id_permiso
    WHERE rp.id_rol = ?
  `).all(id_rol);

  return rows.map(r => r.nombre_permiso);
}

/**
 * Middleware que valida si el rol del usuario cuenta con un permiso específico
 * de forma dinámica consultando la tabla rol_permisos.
 *
 * La decisión se toma siempre contra la base de datos (nunca contra lo que el
 * cliente envíe), por lo que ocultar un control en la interfaz no es la medida
 * de seguridad: el servidor la exige de nuevo en cada endpoint protegido.
 */
function requirePermission(permissionName) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Acceso no autorizado: Debes iniciar sesión' });
    }

    // El rol del usuario se relee de la BD en cada petición, por lo que un cambio
    // de rol o de permisos surte efecto sin necesidad de esperar a que expire el token.
    const hasPerm = db.prepare(`
      SELECT 1
      FROM rol_permisos rp
      JOIN permisos p ON p.id = rp.id_permiso
      WHERE rp.id_rol = ? AND p.nombre_permiso = ?
    `).get(req.user.id_rol, permissionName);

    if (!hasPerm) {
      return res.status(403).json({
        error: 'Acceso denegado: tu rol no incluye el permiso requerido',
        permiso_requerido: permissionName
      });
    }

    next();
  };
}

module.exports = {
  requirePermission,
  getUserPermissions
};