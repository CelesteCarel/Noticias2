#!/usr/bin/env node
/**
 * Respaldo diario del Portal de Noticias.
 *
 * Genera una copia consistente de la base SQLite con `VACUUM INTO`, que crea un
 * archivo nuevo sin detener el servidor ni bloquear las peticiones en curso, y
 * copia el directorio de imágenes subidas (storage/uploads).
 *
 * El destino debe ser una unidad externa (USB o disco extraíble) y se configura
 * con BACKUP_DIR en .env. Si la unidad no está conectada el script falla con un
 * mensaje claro, deja el error en logs/backup.log y registra el fallo en la
 * bitácora de auditoría, pero nunca tumba la aplicación.
 *
 * Uso:
 *   npm run backup
 *
 * Variables de entorno:
 *   BACKUP_DIR          Ruta de la unidad externa (obligatoria).
 *   BACKUP_RETENTION    Número de respaldos a conservar (por defecto 7).
 *   BACKUP_LOG_DIR      Directorio del log (por defecto ./logs).
 *   DB_PATH             Base de datos a respaldar (por defecto ./database.sqlite).
 *   UPLOAD_DIR          Imágenes a copiar (por defecto ./storage/uploads).
 */
require('dotenv').config();

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.join(__dirname, '..');

function rutaDesdeProyecto(valor, porDefecto) {
  const elegida = (valor || '').trim() || porDefecto;
  return path.isAbsolute(elegida) ? elegida : path.resolve(ROOT, elegida);
}

const DB_PATH = rutaDesdeProyecto(process.env.DB_PATH, 'database.sqlite');
const UPLOAD_DIR = rutaDesdeProyecto(process.env.UPLOAD_DIR, path.join('storage', 'uploads'));
const BACKUP_DIR = (process.env.BACKUP_DIR || '').trim();
const BACKUP_LOG_DIR = rutaDesdeProyecto(process.env.BACKUP_LOG_DIR, 'logs');
const LOG_FILE = path.join(BACKUP_LOG_DIR, 'backup.log');
const RETENTION = Math.max(1, Number.parseInt(process.env.BACKUP_RETENTION || '7', 10) || 7);

/**
 * Marca de tiempo local en el formato del nombre del respaldo:
 * backup-2026-11-15_0300.sqlite
 */
function marcaDeTiempo(fecha = new Date()) {
  const dos = (n) => String(n).padStart(2, '0');
  return `${fecha.getFullYear()}-${dos(fecha.getMonth() + 1)}-${dos(fecha.getDate())}_${dos(fecha.getHours())}${dos(fecha.getMinutes())}`;
}

function registrarLog(nivel, mensaje) {
  const linea = `[${new Date().toISOString()}] ${nivel} ${mensaje}`;
  try {
    fs.mkdirSync(BACKUP_LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, linea + '\n', 'utf8');
  } catch (error) {
    console.error(`No se pudo escribir en ${LOG_FILE}: ${error.message}`);
  }
  if (nivel === 'ERROR') {
    console.error(linea);
  } else {
    console.log(linea);
  }
}

/**
 * Inserta el resultado en la bitácora de auditoría. La tabla es append-only y
 * no depende de que el servidor esté levantado: el script abre su propia
 * conexión. Si la base no se puede abrir (por ejemplo, no existe), se limita a
 * dejar constancia en el log.
 */
function registrarAuditoria(accion, detalles) {
  let db;
  try {
    db = new DatabaseSync(DB_PATH);
    db.exec('PRAGMA busy_timeout = 5000;');
    db.prepare(`
      INSERT INTO auditoria (id_usuario, accion, detalles, ip, fecha_hora)
      VALUES (?, ?, ?, ?, ?)
    `).run(null, accion, detalles, 'script-backup', new Date().toISOString());
    db.close();
  } catch (error) {
    if (db) {
      try { db.close(); } catch { /* ya estaba cerrada */ }
    }
    registrarLog('ERROR', `No se pudo registrar el evento en auditoría: ${error.message}`);
  }
}

/**
 * Comprueba que la unidad externa esté conectada y sea escribible. Un mensaje
 * explícito importa más que el código de error del sistema operativo, que en
 * Windows cambia según la letra de unidad y no dice qué hacer.
 */
function verificarDestino() {
  if (!BACKUP_DIR) {
    throw new Error(
      'BACKUP_DIR no está definida. Conecta la unidad externa (USB o disco extraíble) '
      + 'y define en .env, por ejemplo: BACKUP_DIR=E:\\Respaldos\\PortalNoticias '
      + '(Windows) o BACKUP_DIR=/media/usb/portal-noticias (Linux).'
    );
  }

  const destino = path.resolve(BACKUP_DIR);

  let stats;
  try {
    stats = fs.statSync(destino);
  } catch {
    // En Windows la unidad puede estar conectada y aun así faltar la carpeta
    // (por ejemplo E:\respaldos la primera vez). Se crea solo si la raíz de la
    // unidad existe. En Linux no se crea, para no escribir en el disco local
    // cuando el punto de montaje de la USB no está montado.
    const raiz = path.parse(destino).root;
    const unidadConectada = process.platform === 'win32'
      && raiz
      && raiz !== destino
      && fs.existsSync(raiz);

    if (!unidadConectada) {
      throw new Error(
        `La unidad externa no está conectada o la carpeta de destino no existe: ${destino}. `
        + 'Conecta la USB o el disco extraíble y vuelve a ejecutar el respaldo.'
      );
    }

    try {
      fs.mkdirSync(destino, { recursive: true });
      registrarLog('INFO', `Se creó la carpeta de destino ${destino}`);
    } catch {
      throw new Error(
        `La unidad externa está conectada, pero no se pudo crear la carpeta ${destino}. `
        + 'Revisa los permisos de la unidad.'
      );
    }
    stats = fs.statSync(destino);
  }

  if (!stats.isDirectory()) {
    throw new Error(`BACKUP_DIR no es un directorio: ${destino}`);
  }

  try {
    fs.accessSync(destino, fs.constants.W_OK);
  } catch {
    throw new Error(`La unidad externa no tiene permisos de escritura: ${destino}`);
  }

  return destino;
}

/**
 * Nombre único: si dos respaldos caen en el mismo minuto se añade un sufijo en
 * vez de sobrescribir el anterior.
 */
function nombreDisponible(destino, marca) {
  let base = `backup-${marca}`;
  let sufijo = 1;
  while (
    fs.existsSync(path.join(destino, `${base}.sqlite`))
    || fs.existsSync(path.join(destino, `${base}_uploads`))
  ) {
    sufijo += 1;
    base = `backup-${marca}-${sufijo}`;
  }
  return base;
}

/**
 * Copia consistente de SQLite. `VACUUM INTO` escribe un archivo nuevo con el
 * esquema y los datos confirmados, sin detener el servidor ni dejar un archivo
 * a medio escribir si el proceso se interrumpe.
 */
function respaldarBaseDeDatos(destino, nombreBase) {
  if (!fs.existsSync(DB_PATH)) {
    throw new Error(`No se encontró la base de datos a respaldar: ${DB_PATH}`);
  }

  const archivo = path.join(destino, `${nombreBase}.sqlite`);
  let db;
  try {
    db = new DatabaseSync(DB_PATH);
    db.exec('PRAGMA busy_timeout = 10000;');
    db.prepare('VACUUM INTO ?').run(archivo);
    db.close();
  } catch (error) {
    if (db) {
      try { db.close(); } catch { /* ya estaba cerrada */ }
    }
    // La sentencia no admite parámetros en algunas compilaciones antiguas de
    // SQLite: se reintenta con la ruta escapada como literal.
    if (/parameter|bind|syntax/i.test(error.message)) {
      const literal = archivo.replace(/'/g, "''");
      const db2 = new DatabaseSync(DB_PATH);
      try {
        db2.exec('PRAGMA busy_timeout = 10000;');
        db2.exec(`VACUUM INTO '${literal}';`);
      } finally {
        db2.close();
      }
    } else {
      throw error;
    }
  }

  return archivo;
}

/**
 * Copia las imágenes subidas junto al respaldo. Si aún no existe el directorio
 * (instalación nueva sin imágenes) no se considera un fallo.
 */
function respaldarImagenes(destino, nombreBase) {
  if (!fs.existsSync(UPLOAD_DIR)) {
    return null;
  }

  const carpeta = path.join(destino, `${nombreBase}_uploads`);
  fs.cpSync(UPLOAD_DIR, carpeta, { recursive: true });
  return carpeta;
}

/**
 * Conserva solo los últimos BACKUP_RETENTION respaldos. El nombre incluye fecha
 * y hora, y un sufijo numérico si dos ejecuciones caen en el mismo minuto. Se
 * ordena por marca de tiempo y luego por sufijo, de más nuevo a más viejo.
 * Se elimina también la carpeta de imágenes asociada.
 */
function claveDeRespaldo(nombre) {
  const partes = /^backup-(\d{4}-\d{2}-\d{2}_\d{4})(?:-(\d+))?\.sqlite$/.exec(nombre);
  if (!partes) return { marca: nombre, sufijo: 0 };
  return { marca: partes[1], sufijo: partes[2] ? Number(partes[2]) : 1 };
}

function aplicarRetencion(destino) {
  const respaldos = fs.readdirSync(destino)
    .filter((nombre) => /^backup-.*\.sqlite$/.test(nombre))
    .sort((a, b) => {
      const claveA = claveDeRespaldo(a);
      const claveB = claveDeRespaldo(b);
      if (claveA.marca !== claveB.marca) return claveA.marca < claveB.marca ? -1 : 1;
      return claveA.sufijo - claveB.sufijo;
    })
    .reverse();

  const eliminados = [];
  for (const nombre of respaldos.slice(RETENTION)) {
    const archivo = path.join(destino, nombre);
    const carpeta = path.join(destino, nombre.replace(/\.sqlite$/, '_uploads'));
    try {
      fs.rmSync(archivo, { force: true });
      fs.rmSync(carpeta, { recursive: true, force: true });
      eliminados.push(nombre);
    } catch (error) {
      registrarLog('ERROR', `No se pudo eliminar el respaldo antiguo ${nombre}: ${error.message}`);
    }
  }
  return eliminados;
}

function ejecutar() {
  const inicio = Date.now();
  const marca = marcaDeTiempo();
  let destino;
  let archivo = null;

  try {
    destino = verificarDestino();
    const nombreBase = nombreDisponible(destino, marca);

    archivo = respaldarBaseDeDatos(destino, nombreBase);
    const carpetaImagenes = respaldarImagenes(destino, nombreBase);
    const eliminados = aplicarRetencion(destino);

    const tamano = fs.statSync(archivo).size;
    const detalles = `Respaldo generado en ${archivo} (${tamano} bytes)`
      + (carpetaImagenes ? `; imágenes en ${carpetaImagenes}` : '; sin imágenes para copiar')
      + (eliminados.length ? `; retención: se eliminaron ${eliminados.join(', ')}` : '');

    registrarLog('INFO', detalles);
    registrarAuditoria('Respaldo de Base de Datos', detalles);
    registrarLog('INFO', `Respaldo completado en ${Date.now() - inicio} ms`);
    return 0;
  } catch (error) {
    const mensaje = `Fallo del respaldo: ${error.message}`;
    registrarLog('ERROR', mensaje);
    registrarAuditoria('Fallo de Respaldo', mensaje);
    if (archivo && fs.existsSync(archivo)) {
      try { fs.rmSync(archivo, { force: true }); } catch { /* copia incompleta */ }
    }
    return 1;
  }
}

if (require.main === module) {
  process.exitCode = ejecutar();
}

module.exports = {
  ejecutar,
  marcaDeTiempo,
  verificarDestino,
  aplicarRetencion,
  BACKUP_DIR,
  DB_PATH,
  UPLOAD_DIR
};
