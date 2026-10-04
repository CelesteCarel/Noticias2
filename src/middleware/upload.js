/**
 * Middleware de carga de imágenes de las noticias.
 *
 * Motivo de las decisiones:
 *
 *  - El archivo se guarda FUERA de `public/`. Todo lo que esté en `public` se
 *    sirve tal cual por express.static, y una imagen subida por un usuario no
 *    debe mezclarse con el código que se despliega. Así el único contenido
 *    servible desde el disco es el que escribe el propio proyecto.
 *
 *  - El nombre del archivo lo genera el servidor con bytes aleatorios. Nunca se
 *    reutiliza el nombre que envió el cliente: un nombre como `../../app.js` o
 *    `shell.php` dejaría de ser una imagen y pasaría a ser un archivo ajeno
 *    ejecutado o descargado desde el propio dominio.
 *
 *  - La extensión se decide a partir del tipo MIME permitido, no del nombre
 *    original, para que un `.php` renombrado a `.jpg` no conserve su extensión.
 *
 *  - El tipo MIME que declara el cliente no es una prueba: cualquier programa
 *    puede enviar `Content-Type: image/png` con un ejecutable dentro. Por eso
 *    después de escribir el archivo se comparan sus primeros bytes con las
 *    firmas conocidas de cada formato. Un archivo que no corresponda se borra y
 *    la carga se rechaza.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

const UPLOAD_DIR = path.resolve(
  process.env.UPLOAD_DIR || path.join(__dirname, '..', '..', 'storage', 'uploads')
);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const PREFIJO_PUBLICO = '/uploads/';

/** Tipos aceptados y extensión con la que se guardan en disco. */
const TIPOS_PERMITIDOS = new Map([
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
  ['image/gif', '.gif']
]);

/** Firmas de los primeros bytes de cada formato admitido. */
const FIRMAS = [
  { tipo: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  { tipo: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { tipo: 'image/gif', bytes: [0x47, 0x49, 0x46, 0x38] }
];

function asegurarDirectorio() {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

/**
 * Devuelve el tipo real de la imagen según sus primeros bytes, o null si el
 * contenido no es ninguno de los formatos permitidos.
 */
function detectarTipoReal(rutaArchivo) {
  const cabecera = Buffer.alloc(12);
  const descriptor = fs.openSync(rutaArchivo, 'r');
  let leidos;
  try {
    leidos = fs.readSync(descriptor, cabecera, 0, cabecera.length, 0);
  } finally {
    fs.closeSync(descriptor);
  }

  for (const firma of FIRMAS) {
    if (cabecera.subarray(0, firma.bytes.length).equals(Buffer.from(firma.bytes))) {
      return firma.tipo;
    }
  }

  // WebP es un contenedor RIFF: "RIFF" al inicio y "WEBP" en los bytes 8 a 11.
  if (leidos >= 12
    && cabecera.subarray(0, 4).toString('ascii') === 'RIFF'
    && cabecera.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }

  return null;
}

const almacenamiento = multer.diskStorage({
  destination(req, file, done) {
    asegurarDirectorio();
    done(null, UPLOAD_DIR);
  },
  filename(req, file, done) {
    const extension = TIPOS_PERMITIDOS.get(file.mimetype) || '.bin';
    done(null, `${Date.now()}-${crypto.randomBytes(16).toString('hex')}${extension}`);
  }
});

/**
 * Filtro de formato. El tipo declarado por el cliente solo sirve para descartar
 * rápido lo que desde el principio no es una imagen; la comprobación que decide
 * es la de los bytes reales, más abajo.
 */
function soloImagenes(req, file, done) {
  if (!TIPOS_PERMITIDOS.has(file.mimetype)) {
    const error = new Error('Solo se admiten imágenes JPG, PNG, WEBP o GIF');
    error.status = 400;
    error.esValidacionDeCarga = true;
    return done(error);
  }
  done(null, true);
}

/**
 * Traduce un fallo de multer a un mensaje comprensible para quien publica, en
 * lugar de exponer el nombre interno del error.
 */
function manejarErrorCarga(error, req, res, next) {
  // Rechazos previstos (formato no admitido): el mensaje es para quien publica.
  if (error && error.esValidacionDeCarga) {
    return res.status(400).json({ error: error.message });
  }

  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: `La imagen supera el máximo de ${MAX_IMAGE_BYTES / (1024 * 1024)} MB` });
    }
    if (error.code === 'LIMIT_UNEXPECTED_FILE' || error.code === 'LIMIT_FILE_COUNT') {
      return res.status(400).json({ error: 'Solo se permite una imagen por publicación' });
    }
    return res.status(400).json({ error: 'No se pudo procesar la imagen enviada' });
  }
  return next(error);
}

/**
 * Middleware listo para usar en las rutas de noticias: acepta el campo `imagen`,
 * comprueba la firma real del archivo y expone en `req.imagenSubida` la ruta
 * pública con la que se debe guardar la noticia.
 */
function subirImagen(req, res, next) {
  multer({ storage: almacenamiento, fileFilter: soloImagenes, limits: { fileSize: MAX_IMAGE_BYTES, files: 1 } })
    .single('imagen')(req, res, (error) => {
      if (error) return manejarErrorCarga(error, req, res, next);

      if (!req.file) {
        req.imagenSubida = null;
        return next();
      }

      const tipoReal = detectarTipoReal(req.file.path);
      if (!tipoReal) {
        fs.unlink(req.file.path, () => {});
        return res.status(400).json({ error: 'El archivo enviado no es una imagen válida' });
      }

      req.imagenSubida = `${PREFIJO_PUBLICO}${req.file.filename}`;
      req.imagenSubidaFisica = req.file.path;
      next();
    });
}

/** Traduce una ruta pública `/uploads/x.jpg` a su ruta en disco. */
function rutaFisicaDe(imagenUrl) {
  if (typeof imagenUrl !== 'string' || !imagenUrl.startsWith(PREFIJO_PUBLICO)) return null;
  const nombre = imagenUrl.slice(PREFIJO_PUBLICO.length);
  // Un nombre con separadores de ruta no pudo generarlo este módulo, así que se
  // descarta en lugar de usarlo para intentar borrar un archivo de otro sitio.
  if (!nombre || nombre.includes('/') || nombre.includes('\\') || nombre.includes('..')) return null;
  return path.join(UPLOAD_DIR, nombre);
}

/**
 * Borra una imagen que quedó sin referencia. Es una operación de limpieza: si el
 * archivo ya no está, no es un error que interrumpa la publicación.
 */
function eliminarImagenSinUso(imagenUrl) {
  const ruta = rutaFisicaDe(imagenUrl);
  if (!ruta) return;
  fs.unlink(ruta, () => {});
}

module.exports = {
  subirImagen,
  manejarErrorCarga,
  eliminarImagenSinUso,
  rutaFisicaDe,
  asegurarDirectorio,
  UPLOAD_DIR,
  MAX_IMAGE_BYTES,
  PREFIJO_PUBLICO
};