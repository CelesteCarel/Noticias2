/**
 * Pruebas del respaldo diario (scripts/backup.js).
 *
 * Usa una base SQLite temporal, una carpeta de imágenes temporal y una unidad
 * de destino simulada. No toca database.sqlite ni storage/uploads del proyecto.
 *
 *   npm run test:backup
 */
const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-backup-test-'));
const DB_PATH = path.join(TMP, 'origen.sqlite');
const UPLOAD_DIR = path.join(TMP, 'uploads');
const BACKUP_DIR = path.join(TMP, 'unidad-externa');
const LOG_DIR = path.join(TMP, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'backup.log');

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✔ ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  ✖ ${name}`);
    console.log(`      ${error.message}`);
  }
}

function prepararOrigen() {
  const db = new DatabaseSync(DB_PATH);
  db.exec(fs.readFileSync(path.join(ROOT, 'src', 'database', 'schema.sql'), 'utf8'));
  db.prepare('INSERT INTO roles (nombre_rol, descripcion) VALUES (?, ?)')
    .run('Temporal', 'Rol de prueba');
  db.close();

  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  fs.writeFileSync(path.join(UPLOAD_DIR, 'imagen.txt'), 'contenido de prueba', 'utf8');
}

function ejecutarBackup(extra = {}) {
  return spawnSync(process.execPath, ['--no-warnings', 'scripts/backup.js'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...process.env,
      DB_PATH,
      UPLOAD_DIR,
      BACKUP_DIR,
      BACKUP_LOG_DIR: LOG_DIR,
      BACKUP_RETENTION: '7',
      ...extra
    }
  });
}

function respaldos() {
  return fs.readdirSync(BACKUP_DIR).filter((n) => /^backup-.*\.sqlite$/.test(n)).sort();
}

/**
 * Ruta que simula una unidad desconectada. En Windows debe apuntar a una letra
 * que no exista, porque una carpeta faltante dentro de C: ahora se crea sola.
 */
function rutaDesconectada() {
  if (process.platform === 'win32') {
    for (const letra of 'ZYXWVUTSRQPONMLKJIHGFED') {
      const raiz = `${letra}:\\`;
      if (!fs.existsSync(raiz)) return path.join(raiz, 'unidad-desconectada');
    }
  }
  return path.join(TMP, 'unidad-desconectada');
}

function limpiar() {
  fs.rmSync(TMP, { recursive: true, force: true });
}

function main() {
  console.log('\nPortal de Noticias UNACH — Pruebas de respaldo');

  prepararOrigen();
  fs.mkdirSync(BACKUP_DIR, { recursive: true });

  test('El respaldo genera una copia consistente y copia las imágenes', () => {
    const r = ejecutarBackup();
    assert.strictEqual(r.status, 0, `El script falló:\n${r.stdout}\n${r.stderr}`);

    const archivos = respaldos();
    assert.strictEqual(archivos.length, 1, 'Debe existir un archivo backup-*.sqlite');
    assert.match(archivos[0], /^backup-\d{4}-\d{2}-\d{2}_\d{4}(-\d+)?\.sqlite$/,
      'El nombre debe incluir fecha y hora');

    const copia = new DatabaseSync(path.join(BACKUP_DIR, archivos[0]));
    const roles = copia.prepare('SELECT COUNT(*) AS c FROM roles').get().c;
    copia.close();
    assert.strictEqual(roles, 1, 'La copia debe contener los datos de la base original');

    const carpeta = path.join(BACKUP_DIR, archivos[0].replace(/\.sqlite$/, '_uploads'));
    assert.ok(fs.existsSync(path.join(carpeta, 'imagen.txt')), 'Las imágenes deben copiarse junto al respaldo');
    assert.strictEqual(fs.readFileSync(path.join(carpeta, 'imagen.txt'), 'utf8'), 'contenido de prueba');
  });

  test('Cada respaldo queda registrado en la auditoría y en el log', () => {
    const db = new DatabaseSync(DB_PATH);
    const eventos = db.prepare("SELECT accion, detalles FROM auditoria WHERE accion = 'Respaldo de Base de Datos'").all();
    db.close();

    assert.ok(eventos.length >= 1, 'Debe insertarse un evento de auditoría por respaldo');
    assert.match(eventos[0].detalles, /backup-\d{4}-\d{2}-\d{2}_\d{4}/,
      'El detalle debe indicar el archivo generado');
    assert.ok(fs.existsSync(LOG_FILE), 'Debe existir logs/backup.log');
    assert.match(fs.readFileSync(LOG_FILE, 'utf8'), /INFO Respaldo generado/);
  });

  test('La retención conserva solo los últimos respaldos configurados', () => {
    ejecutarBackup({ BACKUP_RETENTION: '2' });
    ejecutarBackup({ BACKUP_RETENTION: '2' });

    const archivos = respaldos();
    assert.ok(archivos.length <= 2,
      `Se esperaban como máximo 2 respaldos y hay ${archivos.length}: ${archivos.join(', ')}`);
    assert.ok(archivos.length >= 1, 'Debe conservarse al menos el respaldo más reciente');
  });

  test('La retención respeta el orden cuando varios respaldos caen en el mismo minuto', () => {
    const dir = path.join(TMP, 'retencion-mismo-minuto');
    fs.mkdirSync(dir, { recursive: true });

    const r1 = ejecutarBackup({ BACKUP_DIR: dir, BACKUP_RETENTION: '2' });
    assert.strictEqual(r1.status, 0, `El primer respaldo falló:\n${r1.stdout}\n${r1.stderr}`);
    const primero = fs.readdirSync(dir).find((n) => /^backup-.*\.sqlite$/.test(n));
    assert.ok(primero, 'El primer respaldo debe existir');

    ejecutarBackup({ BACKUP_DIR: dir, BACKUP_RETENTION: '2' });
    ejecutarBackup({ BACKUP_DIR: dir, BACKUP_RETENTION: '2' });

    const archivos = fs.readdirSync(dir).filter((n) => /^backup-.*\.sqlite$/.test(n));
    assert.strictEqual(archivos.length, 2, `Se esperaban 2 respaldos y hay ${archivos.length}`);
    assert.ok(!archivos.includes(primero), 'El respaldo más antiguo debe eliminarse, no el intermedio');
  });

  if (process.platform === 'win32') {
    test('Si la unidad está conectada y falta la carpeta, la crea automáticamente', () => {
      const nueva = path.join(TMP, 'unidad-externa', 'respaldos');
      assert.ok(!fs.existsSync(nueva), 'La carpeta no debe existir antes de la prueba');

      const r = ejecutarBackup({ BACKUP_DIR: nueva });
      assert.strictEqual(r.status, 0, `El script debió crear la carpeta:\n${r.stdout}\n${r.stderr}`);
      assert.ok(fs.existsSync(nueva), 'La carpeta de destino debe crearse');
      assert.ok(fs.readdirSync(nueva).some((n) => /^backup-.*\.sqlite$/.test(n)),
        'El respaldo debe quedar dentro de la carpeta creada');
    });
  }

  test('Si la unidad externa no está conectada falla con un mensaje claro y sin tumbar nada', () => {
    const inexistente = rutaDesconectada();
    const r = ejecutarBackup({ BACKUP_DIR: inexistente });

    assert.strictEqual(r.status, 1, 'El script debe terminar con código 1 cuando falla');
    assert.match(`${r.stdout}\n${r.stderr}`, /unidad externa no está conectada/i,
      'El mensaje debe explicar que la unidad no está conectada');
    assert.match(fs.readFileSync(LOG_FILE, 'utf8'), /ERROR Fallo del respaldo/,
      'El fallo debe quedar registrado en el log');

    const db = new DatabaseSync(DB_PATH);
    const fallos = db.prepare("SELECT COUNT(*) AS c FROM auditoria WHERE accion = 'Fallo de Respaldo'").get().c;
    db.close();
    assert.ok(fallos >= 1, 'El fallo también debe registrarse en la auditoría');
  });

  test('Sin BACKUP_DIR el script se niega a escribir en una ruta improvisada', () => {
    const r = ejecutarBackup({ BACKUP_DIR: '' });
    assert.strictEqual(r.status, 1);
    assert.match(`${r.stdout}\n${r.stderr}`, /BACKUP_DIR no está definida/i);
  });

  limpiar();

  console.log('\n' + '='.repeat(64));
  console.log(`Resultado: ${passed} correctas, ${failures.length} fallidas`);
  if (failures.length > 0) {
    for (const f of failures) console.log(`  - ${f.name}: ${f.error.message}`);
  }
  console.log('='.repeat(64));

  process.exit(failures.length === 0 ? 0 : 1);
}

main();
