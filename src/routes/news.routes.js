const express = require('express');
const router = express.Router();
const db = require('../database/db');
const { authenticateToken } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { logAudit, getClientIp } = require('../middleware/audit');
const {
  sanitizeInput,
  isValidText,
  MAX_TITULO,
  MAX_CONTENIDO,
  MAX_CATEGORIA,
  MAX_URL
} = require('../middleware/sanitizer');
const { subirImagen, eliminarImagenSinUso } = require('../middleware/upload');

router.use(sanitizeInput);

/**
 * Lectura de noticias.
 *
 * El acceso al contenido es un recurso protegido: se exige autenticación y el
 * permiso `noticias.leer` del rol. Ocultar el contenido en la interfaz no es la
 * medida de seguridad, por eso la validación se repite aquí en el servidor.
 */
router.get('/', authenticateToken, requirePermission('noticias.leer'), (req, res) => {
  const { categoria, search } = req.query;
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);

  try {
    let query = `
      SELECT n.id, n.titulo, n.contenido, n.categoria, n.imagen_url, n.id_autor,
             n.fecha_creacion, n.fecha_actualizacion,
             u.nombre AS autor_nombre, u.email AS autor_email, r.nombre_rol AS autor_rol
      FROM noticias n
      JOIN usuarios u ON n.id_autor = u.id
      JOIN roles r ON u.id_rol = r.id
      WHERE 1=1
    `;
    const params = [];

    if (categoria && categoria !== 'Todas') {
      query += ' AND n.categoria = ?';
      params.push(String(categoria).slice(0, MAX_CATEGORIA));
    }

    if (search) {
      query += ' AND (n.titulo LIKE ? OR n.contenido LIKE ?)';
      const term = `%${String(search).slice(0, MAX_TITULO)}%`;
      params.push(term, term);
    }

    query += ' ORDER BY n.fecha_creacion DESC, n.id DESC LIMIT ?';
    params.push(limit);

    const rows = db.prepare(query).all(...params);
    res.json(rows);
  } catch (error) {
    console.error('Error al listar noticias:', error.message);
    res.status(500).json({ error: 'Error al consultar las noticias' });
  }
});

// Listar categorías con contador
router.get('/categorias', authenticateToken, requirePermission('noticias.leer'), (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT categoria, COUNT(*) as total
      FROM noticias
      GROUP BY categoria
      ORDER BY total DESC
    `).all();
    res.json(rows);
  } catch (error) {
    console.error('Error al obtener categorías:', error.message);
    res.status(500).json({ error: 'Error al consultar categorías' });
  }
});

// Obtener detalle de una noticia
router.get('/:id', authenticateToken, requirePermission('noticias.leer'), (req, res) => {
  const id = Number(req.params.id);

  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Identificador de noticia inválido' });
  }

  try {
    const item = db.prepare(`
      SELECT n.id, n.titulo, n.contenido, n.categoria, n.imagen_url, n.id_autor,
             n.fecha_creacion, n.fecha_actualizacion,
             u.nombre AS autor_nombre, u.email AS autor_email, r.nombre_rol AS autor_rol
      FROM noticias n
      JOIN usuarios u ON n.id_autor = u.id
      JOIN roles r ON u.id_rol = r.id
      WHERE n.id = ?
    `).get(id);

    if (!item) {
      return res.status(404).json({ error: 'Noticia no encontrada' });
    }

    res.json(item);
  } catch (error) {
    console.error('Error al obtener noticia:', error.message);
    res.status(500).json({ error: 'Error al consultar el detalle de la noticia' });
  }
});

/**
 * Valida el cuerpo común de creación y edición de una noticia.
 *
 * La imagen admite dos procedencias: un archivo subido en el propio formulario o
 * una URL. Ambas llegan en `imagen_url`; la que ganó es la que se guarda.
 */
function validateNewsPayload(body) {
  const { titulo, contenido, categoria, imagen_url } = body;

  if (!isValidText(titulo, { min: 3, max: MAX_TITULO })) {
    return `El título debe tener entre 3 y ${MAX_TITULO} caracteres`;
  }
  if (!isValidText(contenido, { min: 10, max: MAX_CONTENIDO })) {
    return `El contenido debe tener entre 10 y ${MAX_CONTENIDO} caracteres`;
  }
  if (!isValidText(categoria, { min: 2, max: MAX_CATEGORIA })) {
    return `La categoría debe tener entre 2 y ${MAX_CATEGORIA} caracteres`;
  }
  if (imagen_url && !isValidText(imagen_url, { min: 1, max: MAX_URL })) {
    return 'La URL de la imagen no es válida';
  }
  return null;
}

/**
 * Comprueba el identificador de la ruta antes de aceptar la carga de un archivo.
 * Sin esto, una petición con un id inválido dejaría imágenes huérfanas en disco.
 */
function validarIdNoticia(req, res, next) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Identificador de noticia inválido' });
  }
  next();
}

// Crear nueva noticia
router.post('/',
  authenticateToken,
  requirePermission('noticias.crear'),
  subirImagen,
  // La sanitización global se aplica antes de leer el archivo; con multipart los
  // campos de texto llegan después, por eso se repite aquí sobre req.body.
  sanitizeInput,
  (req, res) => {
  const { titulo, contenido, categoria, imagen_url } = req.body;
  const ip = getClientIp(req);

  const invalid = validateNewsPayload(req.body);
  if (invalid) {
    // La imagen ya está en disco: si la noticia no se crea, no debe quedarse ahí.
    if (req.imagenSubida) eliminarImagenSinUso(req.imagenSubida);
    return res.status(400).json({ error: invalid });
  }

  try {
    const defaultImage = req.imagenSubida
      || (imagen_url && imagen_url.trim() !== ''
        ? imagen_url
        : 'https://images.unsplash.com/photo-1585829365295-ab7cd400c167?auto=format&fit=crop&w=1200&q=80');

    const insert = db.prepare(`
      INSERT INTO noticias (titulo, contenido, categoria, imagen_url, id_autor, fecha_creacion)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const now = new Date().toISOString();
    const result = insert.run(titulo, contenido, categoria, defaultImage, req.user.id, now);
    const newId = Number(result.lastInsertRowid);

    logAudit(req.user.id, `Publicación de Noticia #${newId}`, `Título: "${titulo}" | Categoría: ${categoria}`, ip);

    const created = db.prepare(`
      SELECT n.*, u.nombre AS autor_nombre, r.nombre_rol AS autor_rol
      FROM noticias n
      JOIN usuarios u ON n.id_autor = u.id
      JOIN roles r ON u.id_rol = r.id
      WHERE n.id = ?
    `).get(newId);

    res.status(201).json({
      message: 'Noticia publicada con éxito',
      noticia: created
    });
  } catch (error) {
    console.error('Error al crear noticia:', error.message);
    if (req.imagenSubida) eliminarImagenSinUso(req.imagenSubida);
    res.status(500).json({ error: 'Error interno al publicar la noticia' });
  }
});

// Editar noticia
router.put('/:id',
  authenticateToken,
  requirePermission('noticias.editar'),
  validarIdNoticia,
  subirImagen,
  sanitizeInput,
  (req, res) => {
  const id = Number(req.params.id);
  const ip = getClientIp(req);

  const invalid = validateNewsPayload(req.body);
  if (invalid) {
    if (req.imagenSubida) eliminarImagenSinUso(req.imagenSubida);
    return res.status(400).json({ error: invalid });
  }

  const { titulo, contenido, categoria, imagen_url } = req.body;

  try {
    const existing = db.prepare('SELECT * FROM noticias WHERE id = ?').get(id);
    if (!existing) {
      if (req.imagenSubida) eliminarImagenSinUso(req.imagenSubida);
      return res.status(404).json({ error: 'Noticia no encontrada' });
    }

    // El Administrador no tiene atajo: si puede editar es porque su rol incluye
    // el permiso. El resto de editores solo puede tocar sus propios artículos.
    if (req.user.nombre_rol !== 'Administrador' && existing.id_autor !== req.user.id) {
      if (req.imagenSubida) eliminarImagenSinUso(req.imagenSubida);
      return res.status(403).json({ error: 'No tienes autorización para modificar una noticia redactada por otro usuario' });
    }

    const now = new Date().toISOString();
    // Una imagen subida gana sobre la URL: el archivo es lo que el autor eligió.
    const finalImage = req.imagenSubida || imagen_url || existing.imagen_url;

    db.prepare(`
      UPDATE noticias
      SET titulo = ?, contenido = ?, categoria = ?, imagen_url = ?, fecha_actualizacion = ?
      WHERE id = ?
    `).run(titulo, contenido, categoria, finalImage, now, id);

    // La imagen anterior solo se borra si era una subida nuestra y dejó de usarse:
    // una URL externa no es un archivo nuestro y se conserva intacta.
    if (existing.imagen_url !== finalImage) {
      eliminarImagenSinUso(existing.imagen_url);
    }

    logAudit(req.user.id, `Edición de Noticia #${id}`, `Título: "${titulo}" | Categoría: ${categoria}`, ip);

    const updated = db.prepare(`
      SELECT n.*, u.nombre AS autor_nombre, r.nombre_rol AS autor_rol
      FROM noticias n
      JOIN usuarios u ON n.id_autor = u.id
      JOIN roles r ON u.id_rol = r.id
      WHERE n.id = ?
    `).get(id);

    res.json({
      message: 'Noticia actualizada con éxito',
      noticia: updated
    });
  } catch (error) {
    console.error('Error al editar noticia:', error.message);
    if (req.imagenSubida) eliminarImagenSinUso(req.imagenSubida);
    res.status(500).json({ error: 'Error interno al actualizar la noticia' });
  }
});

// Eliminar noticia
router.delete('/:id', authenticateToken, requirePermission('noticias.eliminar'), (req, res) => {
  const id = Number(req.params.id);
  const ip = getClientIp(req);

  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Identificador de noticia inválido' });
  }

  try {
    const existing = db.prepare('SELECT * FROM noticias WHERE id = ?').get(id);
    if (!existing) {
      return res.status(404).json({ error: 'Noticia no encontrada' });
    }

    if (req.user.nombre_rol !== 'Administrador' && existing.id_autor !== req.user.id) {
      return res.status(403).json({ error: 'No tienes autorización para eliminar una noticia de otro autor' });
    }

    db.prepare('DELETE FROM noticias WHERE id = ?').run(id);

    // Si la imagen era una subida de este portal, se borra junto con la noticia
    // para no dejar archivos huérfanos en el disco.
    eliminarImagenSinUso(existing.imagen_url);

    logAudit(req.user.id, `Eliminación de Noticia #${id}`, `Título eliminado: "${existing.titulo}"`, ip);

    res.json({
      message: 'Noticia eliminada satisfactoriamente',
      id
    });
  } catch (error) {
    console.error('Error al eliminar noticia:', error.message);
    res.status(500).json({ error: 'Error interno al eliminar la noticia' });
  }
});

module.exports = router;