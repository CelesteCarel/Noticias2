const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const { encryptSymmetric, signNews } = require('../utils/crypto.service');
const { hashSha256, esHashSha256 } = require('../utils/hash');

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

  // Los secretos de un solo uso pasan de texto plano a hash SHA-256
  migrateHashes();

  // Cargar datos iniciales
  seedDatabase();

  // Asegurar noticias especiales tras el seed
  ensureSpecialNews();
}

function ensureSpecialNews() {
  try {
    const scandal = db.prepare("SELECT id FROM noticias WHERE categoria = 'Escándalo Universitario' OR titulo LIKE '%sustancias%'").get();
    if (!scandal) {
      const admin = db.prepare("SELECT id FROM usuarios WHERE email = 'admin@portalnoticias.com'").get();
      if (admin) {
        const titulo = 'EXCLUSIVA: Alumno del Campus I es descubierto bajo efectos de sustancias durante el examen final — seguridad lo retiró del aula ante el asombro de compañeros y maestros';
        const contenido = 'Lo que prometía ser un examen final rutinario de Bases de Datos en el Departamento de Tecnologías Digitales se convirtió esta mañana en uno de los episodios más insólitos en la historia reciente del campus. Alrededor de las 9:40 de la mañana, el alumno Cristian Alejandro Vargas Torres, de séptimo semestre, comenzó a mostrar un comportamiento errático dentro del aula: hablaba solo, se reía sin motivo aparente y en un momento intentó responder el examen con un plumón rojo que sacó de su mochila. La maestra titular, Dra. Patricia Leal, optó por detener la evaluación y llamar al personal de seguridad del plantel.\n\nSegún testigos presenciales, Vargas Torres habría llegado al examen ya en un estado alterado desde el momento en que cruzó la puerta. "Se veía raro desde que entró, pero nadie dijo nada porque pensamos que era de los nervios", declaró una compañera de clase que pidió guardar el anonimato. Las cámaras del pasillo exterior captaron al estudiante consumiendo una sustancia no identificada en el baño del segundo piso aproximadamente 20 minutos antes del inicio del examen.\n\nEl personal de seguridad llegó al aula en menos de cinco minutos y, tras una breve conversación, Vargas Torres fue retirado del salón entre risas propias y el silencio atónito del resto del grupo. La Dra. Leal optó por suspender la evaluación para todos los presentes y reprogramarla para la siguiente semana. Mientras tanto, el alumno fue trasladado a la enfermería del plantel, donde se confirmó que presentaba signos evidentes de intoxicación.\n\nFuentes internas del Departamento de Orientación Educativa señalaron que el caso ya fue turnado al Comité Disciplinario y que podría derivar en una suspensión temporal o, dependiendo de los resultados de los análisis clínicos solicitados, en una baja definitiva. El coordinador de la carrera emitió un breve comunicado interno pidiendo "discreción y respeto hacia el alumno involucrado", aunque para ese momento el video grabado por un compañero desde la última fila ya circulaba en todos los grupos de WhatsApp del campus.';
        const categoria = 'Escándalo Universitario';
        const imagenUrl = '/img/escandalo-drogas.jpg';
        const fecha = new Date().toISOString();
        
        // Cifrado simétrico de nota confidencial (AES-256-GCM)
        const notaClaro = 'TESTIGO CLAVE: Identidad de la alumna reservada bajo expediente #UNACH-DISC-2026-084. Informe toxicológico preliminar emitido por Enfermería Central.';
        const notaCifrada = encryptSymmetric(notaClaro);
        
        // Firma asimétrica (RSA-SHA256)
        const firma = signNews({ titulo, contenido, categoria, id_autor: admin.id });

        db.prepare(`
          INSERT INTO noticias (titulo, contenido, categoria, imagen_url, id_autor, es_portada, porcentaje_censura, nota_confidencial, firma_digital, firma_fecha, fecha_creacion)
          VALUES (?, ?, ?, ?, ?, 1, 30, ?, ?, ?, ?)
        `).run(
          titulo,
          contenido,
          categoria,
          imagenUrl,
          admin.id,
          notaCifrada,
          firma,
          fecha,
          fecha
        );
      }
    }
  } catch (e) {
    console.warn('Advertencia al insertar noticia de escándalo:', e.message);
  }
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
  if (!columns.includes('telefono')) {
    db.exec('ALTER TABLE usuarios ADD COLUMN telefono TEXT;');
  }
  if (!columns.includes('rfc')) {
    db.exec('ALTER TABLE usuarios ADD COLUMN rfc TEXT;');
  }
  if (!columns.includes('direccion')) {
    db.exec('ALTER TABLE usuarios ADD COLUMN direccion TEXT;');
  }

  // Asegurar columnas en la tabla de noticias
  const notColumns = db.prepare('PRAGMA table_info(noticias)').all().map(c => c.name);
  if (!notColumns.includes('es_portada')) {
    db.exec('ALTER TABLE noticias ADD COLUMN es_portada INTEGER DEFAULT 0;');
  }
  if (!notColumns.includes('porcentaje_censura')) {
    db.exec('ALTER TABLE noticias ADD COLUMN porcentaje_censura INTEGER DEFAULT 30;');
  }
  if (!notColumns.includes('nota_confidencial')) {
    db.exec('ALTER TABLE noticias ADD COLUMN nota_confidencial TEXT;');
  }
  if (!notColumns.includes('firma_digital')) {
    db.exec('ALTER TABLE noticias ADD COLUMN firma_digital TEXT;');
  }
  if (!notColumns.includes('firma_fecha')) {
    db.exec('ALTER TABLE noticias ADD COLUMN firma_fecha DATETIME;');
  }

  // Asegurar tabla de configuración general del portal
  db.exec(`
    CREATE TABLE IF NOT EXISTS configuracion_portal (
      clave TEXT PRIMARY KEY,
      valor TEXT NOT NULL,
      fecha_actualizacion DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Migrar noticias existentes sin firma digital o sin nota confidencial
  try {
    const noticiasSinFirma = db.prepare('SELECT id, titulo, contenido, categoria, id_autor, nota_confidencial, firma_digital FROM noticias WHERE firma_digital IS NULL OR nota_confidencial IS NULL').all();
    for (const n of noticiasSinFirma) {
      const updates = [];
      const params = [];

      if (!n.firma_digital) {
        const signature = signNews(n);
        updates.push('firma_digital = ?', 'firma_fecha = ?');
        params.push(signature, new Date().toISOString());
      }

      if (!n.nota_confidencial) {
        const notaClaro = `Nota confidencial de redacción para el artículo #${n.id}: Fuentes contrastadas y verificadas por la Coordinación Editorial de la UNACH.`;
        const notaCifrada = encryptSymmetric(notaClaro);
        updates.push('nota_confidencial = ?');
        params.push(notaCifrada);
      }

      if (updates.length > 0) {
        params.push(n.id);
        db.prepare(`UPDATE noticias SET ${updates.join(', ')} WHERE id = ?`).run(...params);
      }
    }
  } catch (err) {
    console.warn('[Criptografía] Advertencia al migrar firmas en noticias existentes:', err.message);
  }
}

/**
 * Migra a hash SHA-256 los secretos que versiones anteriores guardaban en texto
 * plano. Es idempotente: un valor que ya tiene 64 caracteres hexadecimales se
 * deja intacto.
 */
function migrateHashes() {
  try {
    const tokens = db.prepare('SELECT id, token FROM refresh_tokens').all();
    const actualizarToken = db.prepare('UPDATE refresh_tokens SET token = ? WHERE id = ?');
    for (const fila of tokens) {
      if (fila.token && !esHashSha256(fila.token)) {
        actualizarToken.run(hashSha256(fila.token), fila.id);
      }
    }
  } catch (error) {
    console.warn('[Seguridad] No se pudieron migrar los refresh tokens a hash:', error.message);
  }

  try {
    const usuarios = db.prepare('SELECT id, codigo_recuperacion FROM usuarios WHERE codigo_recuperacion IS NOT NULL').all();
    const actualizarCodigo = db.prepare('UPDATE usuarios SET codigo_recuperacion = ? WHERE id = ?');
    for (const fila of usuarios) {
      if (fila.codigo_recuperacion && !esHashSha256(fila.codigo_recuperacion)) {
        actualizarCodigo.run(hashSha256(fila.codigo_recuperacion), fila.id);
      }
    }
  } catch (error) {
    console.warn('[Seguridad] No se pudieron migrar los códigos de recuperación a hash:', error.message);
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
      INSERT INTO noticias (titulo, contenido, categoria, imagen_url, id_autor, nota_confidencial, firma_digital, firma_fecha, fecha_creacion)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const seedArticles = [
      {
        titulo: 'Inauguran nuevas instalaciones de laboratorios de cómputo de alto rendimiento',
        contenido: 'Con el objetivo de fortalecer la formación práctica de los estudiantes en áreas de ciberseguridad, desarrollo web y ciencia de datos, se llevó a cabo la apertura de nuevos espacios equipados con tecnología de última generación y conectividad dedicada.',
        categoria: 'Tecnología',
        imagen: 'https://images.unsplash.com/photo-1562774053-701939374585?auto=format&fit=crop&w=1200&q=80',
        autorId: admin ? admin.id : 1,
        nota: 'Fuente primaria: Oficio #UNACH-TIC-2026-44 expedido por la Dirección General de Cómputo.',
        horasAtras: 3
      },
      {
        titulo: 'Investigadores desarrollan proyecto para monitoreo satelital de reservas naturales',
        contenido: 'El equipo multidisciplinario de la facultad de ciencias presentó los primeros resultados del sistema de teledetección enfocado en la conservación ambiental de la selva y zonas protegidas de la región sureste.',
        categoria: 'Ciencia',
        imagen: 'https://images.unsplash.com/photo-1451187580459-43490279c0fa?auto=format&fit=crop&w=1200&q=80',
        autorId: editor ? editor.id : 1,
        nota: 'Coordenadas GPS de sensores de campo reservadas para prevenir sustracción de equipo.',
        horasAtras: 8
      },
      {
        titulo: 'Foro Internacional de Ciberseguridad y Protección de Datos Personales',
        contenido: 'Especialistas nacionales e internacionales compartieron conferencias magistrales sobre buenas prácticas en autenticación robusta, prevención de ataques en aplicaciones web y normativas de confidencialidad en el tratamiento digital de la información.',
        categoria: 'Tecnología',
        imagen: 'https://images.unsplash.com/photo-1550751827-4bd374c3f58b?auto=format&fit=crop&w=1200&q=80',
        autorId: editor ? editor.id : 1,
        nota: 'Ponentes invitados bajo convenio de no divulgación de vulnerabilidades de día cero.',
        horasAtras: 16
      },
      {
        titulo: 'Convocatoria abierta para el Torneo Universitario de Robótica y Programación',
        contenido: 'Se invita a todos los alumnos inscritos a conformar equipos para participar en el certamen anual de desarrollo de software y prototipos mecatrónicos. El periodo de registro concluirá a finales del presente mes.',
        categoria: 'Cultura',
        imagen: 'https://images.unsplash.com/photo-1517245386807-bb43f82c33c4?auto=format&fit=crop&w=1200&q=80',
        autorId: editor ? editor.id : 1,
        nota: 'Bolsa de premios patrocinada por la iniciativa privada mediante fideicomiso educativo.',
        horasAtras: 24
      },
      {
        titulo: 'Estudiantes de ingeniería obtienen reconocimiento en competencia nacional de innovación',
        contenido: 'La delegación estudiantil destacó por el desarrollo de una plataforma orientada a la gestión inteligente de recursos hídricos en comunidades rurales, obteniendo el primer lugar en su categoría.',
        categoria: 'Ciencia',
        imagen: 'https://images.unsplash.com/photo-1523240795612-9a054b0db644?auto=format&fit=crop&w=1200&q=80',
        autorId: admin ? admin.id : 1,
        nota: 'Patente del modelo de distribución hídrica en trámite ante el IMPI registro #MX-2026-9912.',
        horasAtras: 48
      }
    ];

    for (const art of seedArticles) {
      const fecha = new Date(Date.now() - 3600000 * art.horasAtras).toISOString();
      const notaCifrada = encryptSymmetric(art.nota);
      const firma = signNews({
        titulo: art.titulo,
        contenido: art.contenido,
        categoria: art.categoria,
        id_autor: art.autorId
      });

      insertNews.run(
        art.titulo,
        art.contenido,
        art.categoria,
        art.imagen,
        art.autorId,
        notaCifrada,
        firma,
        fecha,
        fecha
      );
    }
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
