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

const DEFAULT_TEASER = {
  modo: 'personalizado',
  id_noticia: null,
  badge: 'Escándalo Universitario',
  categoria: 'Escándalo Universitario',
  date: 'Hace 3 horas',
  author: 'Redacción Gaceta',
  title: 'EXCLUSIVA: Alumno del Campus I es descubierto bajo efectos de sustancias durante el examen final — seguridad lo retiró del aula ante el asombro de compañeros y maestros',
  image: '/img/escandalo-drogas.jpg',
  visibleText: 'Lo que prometía ser un examen final rutinario de Bases de Datos en el Departamento de Tecnologías Digitales se convirtió esta mañana en uno de los episodios más insólitos en la historia reciente del campus. Alrededor de las 9:40 de la mañana, el alumno Cristian Alejandro Vargas Torres, de séptimo semestre, comenzó a mostrar un comportamiento errático dentro del aula: hablaba solo, se reía sin motivo aparente y en un momento intentó responder el examen con un plumón rojo que sacó de su mochila. La maestra titular, Dra. Patricia Leal, optó por detener la evaluación y llamar al personal de seguridad del plantel.',
  blurredText: [
    'Según testigos presenciales, Vargas Torres habría llegado al examen ya en un estado alterado desde el momento en que cruzó la puerta. "Se veía raro desde que entró, pero nadie dijo nada porque pensamos que era de los nervios", declaró una compañera de clase que pidió guardar el anonimato. Las cámaras del pasillo exterior captaron al estudiante consumiendo una sustancia no identificada en el baño del segundo piso aproximadamente 20 minutos antes del inicio del examen.',
    'El personal de seguridad llegó al aula en menos de cinco minutos y, tras una breve conversación, Vargas Torres fue retirado del salón entre risas propias y el silencio atónito del resto del grupo. La Dra. Leal optó por suspender la evaluación para todos los presentes y reprogramarla para la siguiente semana. Mientras tanto, el alumno fue trasladado a la enfermería del plantel, donde se confirmó que presentaba signos evidentes de intoxicación.',
    'Fuentes internas del Departamento de Orientación Educativa señalaron que el caso ya fue turnado al Comité Disciplinario y que podría derivar en una suspensión temporal o, dependiendo de los resultados de los análisis clínicos solicitados, en una baja definitiva. El coordinador de la carrera emitió un breve comunicado interno pidiendo "discreción y respeto hacia el alumno involucrado", aunque para ese momento el video grabado por un compañero desde la última fila ya circulaba en todos los grupos de WhatsApp del campus.'
  ],
  porcentaje_visible: 30
};

/**
 * Obtener la configuración actual de la noticia teaser de portada (Pública).
 * Extrae la noticia marcada como portada (o el escándalo más reciente) directamente
 * de la base de datos real con su división de censura y regla de última hora (<= 1 hora).
 */
router.get('/portada-teaser', (req, res) => {
  try {
    // Buscar la noticia designada como portada o la más reciente
    let art = db.prepare(`
      SELECT n.id, n.titulo, n.contenido, n.categoria, n.imagen_url,
             n.fecha_creacion, n.es_portada, n.porcentaje_censura,
             u.nombre AS autor_nombre
      FROM noticias n
      JOIN usuarios u ON n.id_autor = u.id
      ORDER BY n.es_portada DESC, n.fecha_creacion DESC, n.id DESC
      LIMIT 1
    `).get();

    if (!art) {
      return res.json({
        id: null,
        title: 'Sin noticias disponibles',
        image: '/img/escandalo-drogas.jpg',
        categoria: 'Escándalo Universitario',
        author: 'Redacción Gaceta',
        date: 'Reciente',
        visibleText: 'Aún no se han publicado noticias en el portal.',
        blurredText: [],
        porcentaje_censura: 30,
        is_ultima_hora: false
      });
    }

    const percent = Math.min(Math.max(Number(art.porcentaje_censura) || 30, 10), 90);
    const content = art.contenido || '';
    const cutIndex = Math.floor((content.length * percent) / 100);

    let naturalCut = content.indexOf(' ', cutIndex);
    if (naturalCut === -1 || naturalCut > cutIndex + 60) naturalCut = cutIndex;

    const visibleText = content.substring(0, naturalCut).trim() + '...';
    const remaining = content.substring(naturalCut).trim();
    const blurredText = remaining.split('\n\n').filter(p => p.trim().length > 0);
    if (blurredText.length === 0 && remaining.length > 0) {
      blurredText.push(remaining);
    }

    // Regla de ÚLTIMA HORA: Solo si fue publicada hace menos de 1 hora (3,600,000 ms)
    const diffMs = Date.now() - new Date(art.fecha_creacion).getTime();
    const is_ultima_hora = diffMs >= 0 && diffMs <= 3600000;

    res.json({
      id: art.id,
      title: art.titulo,
      image: art.imagen_url || '/img/escandalo-drogas.jpg',
      categoria: art.categoria,
      badge: art.categoria,
      author: art.autor_nombre || 'Redacción Gaceta',
      date: art.fecha_creacion,
      fullContent: art.contenido,
      visibleText,
      blurredText,
      porcentaje_censura: percent,
      is_ultima_hora
    });
  } catch (error) {
    console.error('Error al obtener teaser de portada:', error.message);
    res.status(500).json({ error: 'Error al consultar portada' });
  }
});

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
             n.es_portada, n.porcentaje_censura,
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

    query += ' ORDER BY n.es_portada DESC, n.fecha_creacion DESC, n.id DESC LIMIT ?';
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

    const esPortada = (req.body.es_portada === '1' || req.body.es_portada === 1 || req.body.es_portada === true || req.body.es_portada === 'true') ? 1 : 0;
    const porcentajeCensura = Math.min(Math.max(parseInt(req.body.porcentaje_censura, 10) || 30, 10), 90);

    if (esPortada === 1) {
      db.prepare('UPDATE noticias SET es_portada = 0').run();
    }

    const insert = db.prepare(`
      INSERT INTO noticias (titulo, contenido, categoria, imagen_url, id_autor, es_portada, porcentaje_censura, fecha_creacion)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const now = new Date().toISOString();
    const result = insert.run(titulo, contenido, categoria, defaultImage, req.user.id, esPortada, porcentajeCensura, now);
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

    const esPortada = (req.body.es_portada === '1' || req.body.es_portada === 1 || req.body.es_portada === true || req.body.es_portada === 'true') ? 1 : 0;
    const porcentajeCensura = Math.min(Math.max(parseInt(req.body.porcentaje_censura, 10) || existing.porcentaje_censura || 30, 10), 90);

    if (esPortada === 1) {
      db.prepare('UPDATE noticias SET es_portada = 0 WHERE id <> ?').run(id);
    }

    db.prepare(`
      UPDATE noticias
      SET titulo = ?, contenido = ?, categoria = ?, imagen_url = ?, es_portada = ?, porcentaje_censura = ?, fecha_actualizacion = ?
      WHERE id = ?
    `).run(titulo, contenido, categoria, finalImage, esPortada, porcentajeCensura, now, id);

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