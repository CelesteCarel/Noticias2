const express = require('express');
const router = express.Router();
const db = require('../database/db');
const { authenticateToken } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { logAudit, getClientIp } = require('../middleware/audit');
const {
  sanitizeInput,
  isValidText,
  MAX_ROL_NOMBRE,
  MAX_DESCRIPCION
} = require('../middleware/sanitizer');

// Middleware global para rutas de administración: toda la ruta requiere sesión
// y, además, un permiso explícito por endpoint (mínimo privilegio).
router.use(authenticateToken);
router.use(sanitizeInput);

/**
 * Permisos que no pueden quedar huérfanos en el sistema. Si ningún rol los
 * tuviera asignados, nadie podría volver a administrar roles ni usuarios y el
 * sistema quedaría bloqueado sin posibilidad de recuperación desde la aplicación.
 */
const CRITICAL_PERMISSIONS = ['roles.gestionar', 'usuarios.gestionar'];

/**
 * Verifica que, tras aplicar `permisos_ids`, cada permiso crítico siga
 * pertenecer a al menos un rol.
 */
function wouldOrphanCriticalPermission(rolId, permisosIds) {
  const permitidos = new Set(permisosIds);

  for (const critico of CRITICAL_PERMISSIONS) {
    const permiso = db.prepare('SELECT id FROM permisos WHERE nombre_permiso = ?').get(critico);
    if (!permiso) continue;

    const otrosRoles = db.prepare(`
      SELECT rp.id_rol
      FROM rol_permisos rp
      WHERE rp.id_permiso = ? AND rp.id_rol <> ?
    `).all(permiso.id, rolId);

    const alguienLoMantiene = otrosRoles.length > 0 || permitidos.has(permiso.id);
    if (!alguienLoMantiene) return critico;
  }
  return null;
}

/**
 * Normaliza y valida el arreglo de IDs de permisos recibido del cliente.
 */
function resolvePermissionIds(permisos_ids) {
  if (!Array.isArray(permisos_ids)) return { error: 'permisos_ids debe ser un arreglo de IDs de permisos' };

  const ids = [...new Set(permisos_ids.map(v => Number(v)))];
  if (ids.some(v => !Number.isInteger(v) || v <= 0)) {
    return { error: 'permisos_ids contiene identificadores no válidos' };
  }
  if (ids.length > 0) {
    const placeholders = ids.map(() => '?').join(',');
    const existentes = db.prepare(`SELECT id FROM permisos WHERE id IN (${placeholders})`).all(...ids);
    if (existentes.length !== ids.length) {
      return { error: 'Uno o más permisos solicitados no existen' };
    }
  }
  return { ids };
}

/**
 * Gestión de Usuarios
 */

// Listar usuarios registrados
router.get('/usuarios', requirePermission('usuarios.gestionar'), (req, res) => {
  try {
    const users = db.prepare(`
      SELECT u.id, u.nombre, u.email, u.id_rol, u.fecha_registro, u.bloqueado_hasta,
             u.intentos_fallidos,
             r.nombre_rol,
             (SELECT COUNT(*) FROM noticias n WHERE n.id_autor = u.id) AS total_noticias
      FROM usuarios u
      JOIN roles r ON u.id_rol = r.id
      ORDER BY u.id ASC
    `).all();

    res.json(users);
  } catch (error) {
    console.error('Error al listar usuarios:', error.message);
    res.status(500).json({ error: 'Error al consultar la lista de usuarios' });
  }
});

// Asignar o cambiar rol de un usuario
router.put('/usuarios/:id/rol', requirePermission('usuarios.gestionar'), (req, res) => {
  const id = Number(req.params.id);
  const idRol = Number(req.body.id_rol);
  const ip = getClientIp(req);

  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Identificador de usuario inválido' });
  }
  if (!Number.isInteger(idRol) || idRol <= 0) {
    return res.status(400).json({ error: 'id_rol es obligatorio y debe ser un identificador válido' });
  }

  try {
    const targetUser = db.prepare(`
      SELECT u.id, u.nombre, u.email, u.id_rol, r.nombre_rol
      FROM usuarios u
      JOIN roles r ON u.id_rol = r.id
      WHERE u.id = ?
    `).get(id);

    if (!targetUser) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    const newRole = db.prepare('SELECT id, nombre_rol FROM roles WHERE id = ?').get(idRol);
    if (!newRole) {
      return res.status(404).json({ error: 'El rol especificado no existe' });
    }

    db.prepare('UPDATE usuarios SET id_rol = ? WHERE id = ?').run(idRol, id);

    // Si el administrador cambia su propio rol, su sesión deja de tener permisos
    // en la siguiente petición porque el rol se relee de la base de datos.
    logAudit(
      req.user.id,
      'Cambio de Rol de Usuario',
      `Cambió el rol de "${targetUser.nombre}" (${targetUser.email}) de "${targetUser.nombre_rol}" a "${newRole.nombre_rol}"`,
      ip
    );

    res.json({
      message: `Rol actualizado a ${newRole.nombre_rol}`,
      usuario: {
        id: targetUser.id,
        nombre: targetUser.nombre,
        email: targetUser.email,
        id_rol: newRole.id,
        nombre_rol: newRole.nombre_rol
      }
    });
  } catch (error) {
    console.error('Error al cambiar rol:', error.message);
    res.status(500).json({ error: 'Error interno al actualizar el rol' });
  }
});

/**
 * Gestión Dinámica de Roles y Permisos
 */

// Listar roles con sus permisos asignados
router.get('/roles', requirePermission('roles.gestionar'), (req, res) => {
  try {
    const roles = db.prepare('SELECT * FROM roles ORDER BY id ASC').all();
    const allRolePerms = db.prepare(`
      SELECT rp.id_rol, p.id AS id_permiso, p.nombre_permiso, p.descripcion
      FROM rol_permisos rp
      JOIN permisos p ON rp.id_permiso = p.id
    `).all();

    const rolesWithPerms = roles.map(role => {
      const perms = allRolePerms.filter(rp => rp.id_rol === role.id);
      return {
        ...role,
        permisos: perms
      };
    });

    res.json(rolesWithPerms);
  } catch (error) {
    console.error('Error al listar roles:', error.message);
    res.status(500).json({ error: 'Error al consultar roles' });
  }
});

// Listar permisos disponibles
router.get('/permisos', requirePermission('roles.gestionar'), (req, res) => {
  try {
    const permissions = db.prepare('SELECT * FROM permisos ORDER BY id ASC').all();
    res.json(permissions);
  } catch (error) {
    console.error('Error al listar permisos:', error.message);
    res.status(500).json({ error: 'Error al consultar los permisos' });
  }
});

// Crear nuevo rol
router.post('/roles', requirePermission('roles.gestionar'), (req, res) => {
  const { nombre_rol, descripcion } = req.body;
  const ip = getClientIp(req);

  if (!isValidText(nombre_rol, { min: 3, max: MAX_ROL_NOMBRE })) {
    return res.status(400).json({ error: `El nombre del rol debe tener entre 3 y ${MAX_ROL_NOMBRE} caracteres` });
  }
  if (descripcion && !isValidText(descripcion, { min: 1, max: MAX_DESCRIPCION })) {
    return res.status(400).json({ error: `La descripción no puede exceder ${MAX_DESCRIPCION} caracteres` });
  }

  const permisosResult = resolvePermissionIds(req.body.permisos_ids || []);
  if (permisosResult.error) {
    return res.status(400).json({ error: permisosResult.error });
  }

  try {
    const nombre = nombre_rol.trim();
    const existing = db.prepare('SELECT id FROM roles WHERE nombre_rol = ?').get(nombre);
    if (existing) {
      return res.status(400).json({ error: 'Ya existe un rol con ese nombre' });
    }

    const insertRole = db.prepare('INSERT INTO roles (nombre_rol, descripcion) VALUES (?, ?)');
    const result = insertRole.run(nombre, (descripcion || '').trim());
    const newRoleId = Number(result.lastInsertRowid);

    const ids = permisosResult.ids;
    if (ids.length > 0) {
      const insertRP = db.prepare('INSERT INTO rol_permisos (id_rol, id_permiso) VALUES (?, ?)');
      for (const pId of ids) {
        insertRP.run(newRoleId, pId);
      }
    }

    logAudit(
      req.user.id,
      'Creación de Nuevo Rol',
      `Creado el rol "${nombre}" con ${ids.length} permisos asignados`,
      ip
    );

    res.status(201).json({
      message: 'Rol creado exitosamente',
      rol: { id: newRoleId, nombre_rol: nombre, descripcion: (descripcion || '').trim() }
    });
  } catch (error) {
    console.error('Error al crear rol:', error.message);
    res.status(500).json({ error: 'Error interno al crear el rol' });
  }
});

// Actualizar permisos de un rol dinámicamente
router.put('/roles/:id/permisos', requirePermission('roles.gestionar'), (req, res) => {
  const id = Number(req.params.id);
  const ip = getClientIp(req);

  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Identificador de rol inválido' });
  }

  const permisosResult = resolvePermissionIds(req.body.permisos_ids);
  if (permisosResult.error) {
    return res.status(400).json({ error: permisosResult.error });
  }
  const ids = permisosResult.ids;

  try {
    const role = db.prepare('SELECT * FROM roles WHERE id = ?').get(id);
    if (!role) {
      return res.status(404).json({ error: 'Rol no encontrado' });
    }

    // Impedir que la última asignación de un permiso crítico deje el sistema
    // sin ninguna forma de administrar roles o usuarios.
    const huerfano = wouldOrphanCriticalPermission(id, ids);
    if (huerfano) {
      return res.status(409).json({
        error: `No se puede revocar "${huerfano}": ningún otro rol lo tiene y sin él el sistema quedaría sin administración.`
      });
    }

    db.prepare('DELETE FROM rol_permisos WHERE id_rol = ?').run(id);

    const insertRP = db.prepare('INSERT INTO rol_permisos (id_rol, id_permiso) VALUES (?, ?)');
    for (const pId of ids) {
      insertRP.run(id, pId);
    }

    const updatedPerms = db.prepare(`
      SELECT p.nombre_permiso FROM permisos p
      JOIN rol_permisos rp ON p.id = rp.id_permiso
      WHERE rp.id_rol = ?
    `).all(id);

    const permNames = updatedPerms.map(p => p.nombre_permiso).join(', ');

    logAudit(
      req.user.id,
      'Actualización Dinámica de Permisos',
      `Rol "${role.nombre_rol}" actualizado con permisos: [${permNames || 'ninguno'}]`,
      ip
    );

    res.json({
      message: `Permisos del rol "${role.nombre_rol}" actualizados exitosamente`,
      id_rol: id,
      permisos: updatedPerms
    });
  } catch (error) {
    console.error('Error al actualizar permisos de rol:', error.message);
    res.status(500).json({ error: 'Error interno al actualizar permisos' });
  }
});

/**
 * Bitácora de Auditoría
 *
 * Solo existe el endpoint de lectura: la aplicación no expone ninguna forma de
 * crear, modificar ni borrar eventos (y la base de datos bloquea UPDATE/DELETE
 * mediante triggers), por lo que el registro es trazable e inmutable.
 */
router.get('/auditoria', requirePermission('auditoria.ver'), (req, res) => {
  const { search, accion } = req.query;
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);

  try {
    let query = `
      SELECT a.id, a.id_usuario, a.accion, a.detalles, a.ip, a.fecha_hora,
             u.nombre AS usuario_nombre, u.email AS usuario_email, r.nombre_rol AS usuario_rol
      FROM auditoria a
      LEFT JOIN usuarios u ON a.id_usuario = u.id
      LEFT JOIN roles r ON u.id_rol = r.id
      WHERE 1=1
    `;
    const params = [];

    if (search) {
      query += ' AND (a.accion LIKE ? OR a.detalles LIKE ? OR u.nombre LIKE ? OR u.email LIKE ?)';
      const term = `%${String(search).slice(0, 120)}%`;
      params.push(term, term, term, term);
    }

    if (accion && accion !== 'Todas') {
      query += ' AND a.accion LIKE ?';
      params.push(`%${String(accion).slice(0, 120)}%`);
    }

    query += ' ORDER BY a.fecha_hora DESC, a.id DESC LIMIT ?';
    params.push(limit);

    const logs = db.prepare(query).all(...params);
    res.json(logs);
  } catch (error) {
    console.error('Error al consultar auditoría:', error.message);
    res.status(500).json({ error: 'Error al consultar la bitácora de auditoría' });
  }
});

/**
 * Gestión de Noticia Teaser de Portada para Invitados
 */
router.get('/portada-teaser', requirePermission('noticias.editar'), (req, res) => {
  try {
    const row = db.prepare('SELECT valor FROM configuracion_portal WHERE clave = ?').get('guest_teaser');
    const articles = db.prepare(`
      SELECT n.id, n.titulo, n.categoria, n.fecha_creacion, n.imagen_url, n.contenido,
             u.nombre AS autor_nombre
      FROM noticias n
      JOIN usuarios u ON n.id_autor = u.id
      ORDER BY n.fecha_creacion DESC, n.id DESC
    `).all();

    const config = row ? JSON.parse(row.valor) : null;
    res.json({
      config,
      articles
    });
  } catch (error) {
    console.error('Error al obtener configuración de teaser:', error.message);
    res.status(500).json({ error: 'Error al consultar la configuración de portada' });
  }
});

router.put('/portada-teaser', requirePermission('noticias.editar'), (req, res) => {
  const ip = getClientIp(req);
  try {
    const {
      modo = 'personalizado',
      id_noticia = null,
      badge = 'Escándalo Universitario',
      categoria = 'Escándalo Universitario',
      date = 'Reciente',
      author = 'Redacción Gaceta',
      title = '',
      image = '',
      visibleText = '',
      blurredText = [],
      porcentaje_visible = 30,
      custom_override_text = false
    } = req.body;

    if (!title || title.trim().length === 0) {
      return res.status(400).json({ error: 'El título de la noticia es obligatorio' });
    }

    const cleanBlurred = Array.isArray(blurredText) 
      ? blurredText.map(t => String(t).trim()).filter(Boolean)
      : (typeof blurredText === 'string' ? blurredText.split('\n\n').filter(Boolean) : []);

    const configToSave = {
      modo,
      id_noticia: id_noticia ? Number(id_noticia) : null,
      badge: String(badge).slice(0, 100),
      categoria: String(categoria).slice(0, 100),
      date: String(date).slice(0, 80),
      author: String(author).slice(0, 120),
      title: String(title).slice(0, 300),
      image: String(image || '/img/escandalo-drogas.jpg').slice(0, 2048),
      visibleText: String(visibleText || '').slice(0, 5000),
      blurredText: cleanBlurred,
      porcentaje_visible: Math.min(Math.max(Number(porcentaje_visible) || 30, 10), 90),
      custom_override_text: Boolean(custom_override_text)
    };

    db.prepare(`
      INSERT INTO configuracion_portal (clave, valor, fecha_actualizacion)
      VALUES ('guest_teaser', ?, CURRENT_TIMESTAMP)
      ON CONFLICT(clave) DO UPDATE SET
        valor = excluded.valor,
        fecha_actualizacion = CURRENT_TIMESTAMP
    `).run(JSON.stringify(configToSave));

    logAudit(
      req.user.id,
      'Configuración de Portada',
      `Modificación de la noticia teaser de portada: "${configToSave.title.substring(0, 50)}..."`,
      ip
    );

    res.json({ success: true, message: 'Configuración de portada actualizada', teaser: configToSave });
  } catch (error) {
    console.error('Error al guardar teaser de portada:', error.message);
    res.status(500).json({ error: 'Error al actualizar la configuración de portada' });
  }
});

module.exports = router;