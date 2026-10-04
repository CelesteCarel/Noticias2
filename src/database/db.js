const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');

// La ruta de la base de datos puede fijarse con DB_PATH (lo usa la suite de
// pruebas para no tocar la base de datos de la aplicación).
const dbPath = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(__dirname, '../../database.sqlite');
const db = new DatabaseSync(dbPath);

// Habilitar restricciones de claves foráneas
db.exec('PRAGMA foreign_keys = ON;');

function initDb() {
  const schemaPath = path.join(__dirname, 'schema.sql');
  const schemaSql = fs.readFileSync(schemaPath, 'utf8');

  // Ejecutar esquema base
  db.exec(schemaSql);

  // Migraciones automáticas de columnas en caso de bases de datos preexistentes
  migrateColumns();

  // Cargar datos iniciales
  seedDatabase();
}

function migrateColumns() {
  const columns = db.prepare('PRAGMA table_info(usuarios)').all().map(c => c.name);

  if (!columns.includes('intentos_fallidos')) {
    db.exec('ALTER TABLE usuarios ADD COLUMN intentos_fallidos INTEGER DEFAULT 0;');
  }
  if (!columns.includes('bloqueado_hasta')) {
    db.exec('ALTER TABLE usuarios ADD COLUMN bloqueado_hasta DATETIME;');
  }
  if (!columns.includes('codigo_recuperacion')) {
    db.exec('ALTER TABLE usuarios ADD COLUMN codigo_recuperacion TEXT;');
  }
  if (!columns.includes('codigo_expira')) {
    db.exec('ALTER TABLE usuarios ADD COLUMN codigo_expira DATETIME;');
  }

  // Normaliza los correos a minúsculas para que el registro y el inicio de sesión
  // sean insensibles a mayúsculas (evita cuentas duplicadas por capitalización).
  try {
    db.exec('UPDATE usuarios SET email = lower(trim(email)) WHERE email <> lower(trim(email));');
  } catch (error) {
    console.warn('No se pudieron normalizar los correos existentes:', error.message);
  }
}

function seedDatabase() {
  // 1. Roles Base
  const countRoles = db.prepare('SELECT COUNT(*) as count FROM roles').get().count;
  if (countRoles === 0) {
    const insertRole = db.prepare('INSERT INTO roles (nombre_rol, descripcion) VALUES (?, ?)');
    insertRole.run('Administrador', 'Acceso global y gestión de usuarios, roles y auditoría');
    insertRole.run('Editor', 'Redacción, modificación y gestión de noticias');
    insertRole.run('Usuario Regular', 'Lectura de noticias y consulta pública');
  }

  // 2. Permisos del Sistema
  const countPerms = db.prepare('SELECT COUNT(*) as count FROM permisos').get().count;
  if (countPerms === 0) {
    const insertPerm = db.prepare('INSERT INTO permisos (nombre_permiso, descripcion) VALUES (?, ?)');
    insertPerm.run('noticias.leer', 'Visualización de noticias publicadas');
    insertPerm.run('noticias.crear', 'Creación y publicación de nuevos artículos');
    insertPerm.run('noticias.editar', 'Edición de artículos existentes');
    insertPerm.run('noticias.eliminar', 'Eliminación de artículos');
    insertPerm.run('usuarios.gestionar', 'Administración de usuarios y asignación de roles');
    insertPerm.run('roles.gestionar', 'Creación de roles y actualización dinámica de permisos');
    insertPerm.run('auditoria.ver', 'Consulta de la bitácora de eventos y auditoría');
  }

  // 3. Asignación Inicial de Permisos a Roles
  const countRolPerms = db.prepare('SELECT COUNT(*) as count FROM rol_permisos').get().count;
  if (countRolPerms === 0) {
    const roles = db.prepare('SELECT * FROM roles').all();
    const perms = db.prepare('SELECT * FROM permisos').all();

    const roleMap = Object.fromEntries(roles.map(r => [r.nombre_rol, r.id]));
    const permMap = Object.fromEntries(perms.map(p => [p.nombre_permiso, p.id]));

    const insertRP = db.prepare('INSERT OR IGNORE INTO rol_permisos (id_rol, id_permiso) VALUES (?, ?)');

    // Administrador: Todos los permisos
    for (const p of perms) {
      insertRP.run(roleMap['Administrador'], p.id);
    }

    // Editor: Gestión de contenido
    ['noticias.leer', 'noticias.crear', 'noticias.editar', 'noticias.eliminar'].forEach(pName => {
      if (permMap[pName]) insertRP.run(roleMap['Editor'], permMap[pName]);
    });

    // Usuario Regular: Solo lectura
    if (permMap['noticias.leer']) {
      insertRP.run(roleMap['Usuario Regular'], permMap['noticias.leer']);
    }
  }

  // 4. Usuarios Iniciales
  const countUsers = db.prepare('SELECT COUNT(*) as count FROM usuarios').get().count;
  if (countUsers === 0) {
    const initialAdminPassword = process.env.DEFAULT_ADMIN_PASSWORD;
    const initialEditorPassword = process.env.DEFAULT_EDITOR_PASSWORD;
    const initialRegularPassword = process.env.DEFAULT_REGULAR_PASSWORD;

    if (!initialAdminPassword || !initialEditorPassword || !initialRegularPassword) {
      throw new Error('DEFAULT_ADMIN_PASSWORD, DEFAULT_EDITOR_PASSWORD y DEFAULT_REGULAR_PASSWORD son obligatorias para inicializar usuarios');
    }

    const PLACEHOLDER_PASSWORDS = /^(cambia[-_ ]?esta|tu_|change[-_ ]?me|placeholder)/i;

    const insecure = [
      ['DEFAULT_ADMIN_PASSWORD', initialAdminPassword],
      ['DEFAULT_EDITOR_PASSWORD', initialEditorPassword],
      ['DEFAULT_REGULAR_PASSWORD', initialRegularPassword]
    ].filter(([, value]) => value.length < 8 || PLACEHOLDER_PASSWORDS.test(value));

    if (insecure.length > 0) {
      throw new Error(
        `Contraseñas iniciales inseguras o sin modificar (${insecure.map(([k]) => k).join(', ')}). `
        + 'Asigna en tu archivo .env una contraseña real de al menos 8 caracteres para cada usuario inicial.'
      );
    }

    const roles = db.prepare('SELECT * FROM roles').all();
    const roleMap = Object.fromEntries(roles.map(r => [r.nombre_rol, r.id]));
    const insertUser = db.prepare('INSERT INTO usuarios (nombre, email, password, id_rol) VALUES (?, ?, ?, ?)');

    const hash = value => bcrypt.hashSync(value, bcrypt.genSaltSync(12));

    insertUser.run('Coordinación de Informática', 'admin@portalnoticias.com', hash(initialAdminPassword), roleMap['Administrador']);
    insertUser.run('Redacción Universitaria', 'editor@portalnoticias.com', hash(initialEditorPassword), roleMap['Editor']);
    insertUser.run('Comunidad Estudiantil', 'lector@portalnoticias.com', hash(initialRegularPassword), roleMap['Usuario Regular']);
  }

  // 5. Noticias Iniciales (Contenido periodístico auténtico)
  const countNews = db.prepare('SELECT COUNT(*) as count FROM noticias').get().count;
  if (countNews === 0) {
    const editor = db.prepare('SELECT id FROM usuarios WHERE email = ?').get('editor@portalnoticias.com');
    const admin = db.prepare('SELECT id FROM usuarios WHERE email = ?').get('admin@portalnoticias.com');

    const insertNews = db.prepare(`
      INSERT INTO noticias (titulo, contenido, categoria, imagen_url, id_autor, fecha_creacion)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    insertNews.run(
      'Inauguran nuevas instalaciones de laboratorios de cómputo de alto rendimiento',
      'Con el objetivo de fortalecer la formación práctica de los estudiantes en áreas de ciberseguridad, desarrollo web y ciencia de datos, se llevó a cabo la apertura de nuevos espacios equipados con tecnología de última generación y conectividad dedicada.',
      'Tecnología',
      'https://images.unsplash.com/photo-1562774053-701939374585?auto=format&fit=crop&w=1200&q=80',
      admin ? admin.id : 1,
      new Date(Date.now() - 3600000 * 3).toISOString()
    );

    insertNews.run(
      'Investigadores desarrollan proyecto para monitoreo satelital de reservas naturales',
      'El equipo multidisciplinario de la facultad de ciencias presentó los primeros resultados del sistema de teledetección enfocado en la conservación ambiental de la selva y zonas protegidas de la región sureste.',
      'Ciencia',
      'https://images.unsplash.com/photo-1451187580459-43490279c0fa?auto=format&fit=crop&w=1200&q=80',
      editor ? editor.id : 1,
      new Date(Date.now() - 3600000 * 8).toISOString()
    );

    insertNews.run(
      'Foro Internacional de Ciberseguridad y Protección de Datos Personales',
      'Especialistas nacionales e internacionales compartieron conferencias magistrales sobre buenas prácticas en autenticación robusta, prevención de ataques en aplicaciones web y normativas de confidencialidad en el tratamiento digital de la información.',
      'Tecnología',
      'https://images.unsplash.com/photo-1550751827-4bd374c3f58b?auto=format&fit=crop&w=1200&q=80',
      editor ? editor.id : 1,
      new Date(Date.now() - 3600000 * 16).toISOString()
    );

    insertNews.run(
      'Convocatoria abierta para el Torneo Universitario de Robótica y Programación',
      'Se invita a todos los alumnos inscritos a conformar equipos para participar en el certamen anual de desarrollo de software y prototipos mecatrónicos. El periodo de registro concluirá a finales del presente mes.',
      'Cultura',
      'https://images.unsplash.com/photo-1517245386807-bb43f82c33c4?auto=format&fit=crop&w=1200&q=80',
      editor ? editor.id : 1,
      new Date(Date.now() - 3600000 * 24).toISOString()
    );

    insertNews.run(
      'Estudiantes de ingeniería obtienen reconocimiento en competencia nacional de innovación',
      'La delegación estudiantil destacó por el desarrollo de una plataforma orientada a la gestión inteligente de recursos hídricos en comunidades rurales, obteniendo el primer lugar en su categoría.',
      'Ciencia',
      'https://images.unsplash.com/photo-1523240795612-9a054b0db644?auto=format&fit=crop&w=1200&q=80',
      admin ? admin.id : 1,
      new Date(Date.now() - 3600000 * 48).toISOString()
    );
  }

  // 6. Auditoría Inicial
  const countAudit = db.prepare('SELECT COUNT(*) as count FROM auditoria').get().count;
  if (countAudit === 0) {
    const admin = db.prepare('SELECT id FROM usuarios WHERE email = ?').get('admin@portalnoticias.com');
    const insertAudit = db.prepare('INSERT INTO auditoria (id_usuario, accion, detalles, ip, fecha_hora) VALUES (?, ?, ?, ?, ?)');

    insertAudit.run(
      admin ? admin.id : 1,
      'Inicialización del Sistema',
      'Creación del esquema de base de datos relacional y configuración de políticas RBAC',
      '127.0.0.1',
      new Date(Date.now() - 3600000 * 72).toISOString()
    );

    insertAudit.run(
      admin ? admin.id : 1,
      'Asignación de Permisos Iniciales',
      'Configuración de privilegios de acceso para Administrador, Editor y Usuario Regular',
      '127.0.0.1',
      new Date(Date.now() - 3600000 * 70).toISOString()
    );
  }
}

initDb();

module.exports = db;
