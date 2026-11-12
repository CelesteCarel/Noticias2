/**
 * Verificaciones de arranque y configuración segura.
 *
 * Complementa la suite de API (test/api.test.js): en lugar de probar el
 * comportamiento HTTP, comprueba las garantías que deben cumplirse al iniciar el
 * servidor y que son difíciles de ver en la interfaz.
 *
 *   npm run test:config
 *
 * Levanta el servidor real en procesos hijo con bases de datos temporales y
 * secretos propios, por lo que no toca la base de datos ni el .env del
 * proyecto.
 */
const assert = require('assert');
const { spawnSync } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const CERTS_DIR = path.join(ROOT, 'certs');

let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    const detail = await fn();
    passed += 1;
    console.log(`  ✔ ${name}`);
    if (detail) console.log(`      ${detail}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  ✖ ${name}`);
    console.log(`      ${error.message}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

// Secretos aleatorios propios: la aplicación rechaza los de ejemplo y también los
// de baja entropía, así que no sirven para esta suite.
const SEC1 = crypto.randomBytes(40).toString('hex');
const SEC2 = crypto.randomBytes(40).toString('hex');

const BASE_ENV = `
  process.env.JWT_SECRET = ${JSON.stringify(SEC1)};
  process.env.JWT_REFRESH_SECRET = ${JSON.stringify(SEC2)};
  process.env.DEFAULT_ADMIN_PASSWORD = 'ClaveSeguraAdmin1';
  process.env.DEFAULT_EDITOR_PASSWORD = 'ClaveSeguraEditor1';
  process.env.DEFAULT_REGULAR_PASSWORD = 'ClaveSeguraLector1';
  process.env.SMTP_USER = '';
  process.env.SMTP_PASS = '';
`;

/**
 * Solo las variables que no son secretos. Se usa cuando la prueba necesita fijar
 * JWT_SECRET o JWT_REFRESH_SECRET por su cuenta y no debe verse sobrescrito.
 */
const NON_SECRET_ENV = `
  process.env.DEFAULT_ADMIN_PASSWORD = 'ClaveSeguraAdmin1';
  process.env.DEFAULT_EDITOR_PASSWORD = 'ClaveSeguraEditor1';
  process.env.DEFAULT_REGULAR_PASSWORD = 'ClaveSeguraLector1';
  process.env.SMTP_USER = '';
  process.env.SMTP_PASS = '';
`;

let tmpCounter = 0;

function tempDbPath(tag) {
  tmpCounter += 1;
  return path.join(os.tmpdir(), `portal-${tag}-${process.pid}-${tmpCounter}.sqlite`);
}

function removeDb(dbPath) {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    try {
      fs.rmSync(dbPath + suffix, { force: true });
    } catch {
      // Si el sistema mantiene el archivo abierto se ignora: vive en la carpeta
      // temporal y no afecta a la base de datos de la aplicación.
    }
  }
}

/**
 * Ejecuta código en un proceso de Node con el entorno indicado y devuelve
 * stdout/stderr/código de salida.
 */
function runNode(code, { env = '', timeout = 30000 } = {}) {
  return spawnSync(process.execPath, ['-e', `${env}\n${code}`], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout
  });
}

function requireServer(pathRelative) {
  return `require(${JSON.stringify(path.join(ROOT, pathRelative))});`;
}

// --------------------------------------------------------------------------
async function run() {
  console.log('Portal de Noticias UNACH — Verificaciones de arranque y configuración');

  section('1. Esquema de base de datos');

  await test('usuarios.email es único sin distinguir mayúsculas y minúsculas', () => {
    const schema = fs.readFileSync(path.join(ROOT, 'src/database/schema.sql'), 'utf8');
    assert.match(schema, /email TEXT NOT NULL COLLATE NOCASE UNIQUE/i,
      'La columna email debe declarar COLLATE NOCASE para que UNIQUE sea insensible a la caja');

    const dbPath = tempDbPath('nocase');
    const r = runNode(`
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(${JSON.stringify(dbPath)});
      db.exec(require('fs').readFileSync(${JSON.stringify(path.join(ROOT, 'src/database/schema.sql'))}, 'utf8'));
      db.prepare('INSERT INTO roles (nombre_rol) VALUES (?)').run('Temporal');
      db.prepare('INSERT INTO usuarios (nombre,email,password,id_rol) VALUES (?,?,?,?)').run('A','User@T.com','x',1);
      let colision = false;
      try {
        db.prepare('INSERT INTO usuarios (nombre,email,password,id_rol) VALUES (?,?,?,?)').run('B','user@t.com','x',1);
      } catch { colision = true; }
      db.close();
      process.exit(colision ? 0 : 1);
    `);
    removeDb(dbPath);

    assert.strictEqual(r.status, 0,
      `El índice aceptó USER@t.com y user@t.com como cuentas distintas:\n${r.stderr}`);
    return 'una sola cuenta por correo, sin importar la capitalización';
  });

  await test('La bitácora de auditoría es inmutable a nivel de motor', () => {
    const dbPath = tempDbPath('triggers');
    const r = runNode(`
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(${JSON.stringify(dbPath)});
      db.exec(require('fs').readFileSync(${JSON.stringify(path.join(ROOT, 'src/database/schema.sql'))}, 'utf8'));
      db.prepare('INSERT INTO auditoria (id_usuario, accion, detalles, ip) VALUES (NULL,?,?,?)').run('A','D','127.0.0.1');
      let upd = false, del = false;
      try { db.prepare('UPDATE auditoria SET accion = ? WHERE id = 1').run('Manipulado'); } catch { upd = true; }
      try { db.prepare('DELETE FROM auditoria WHERE id = 1').run(); } catch { del = true; }
      db.close();
      process.exit(upd && del ? 0 : 1);
    `);
    removeDb(dbPath);

    assert.strictEqual(r.status, 0, 'Los triggers deben bloquear UPDATE y DELETE en auditoria');
    return 'UPDATE y DELETE rechazados por triggers de SQLite';
  });

  await test('Un usuario con historial de auditoría no puede eliminarse', () => {
    const dbPath = tempDbPath('fk');
    const r = runNode(`
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(${JSON.stringify(dbPath)});
      db.exec(require('fs').readFileSync(${JSON.stringify(path.join(ROOT, 'src/database/schema.sql'))}, 'utf8'));
      db.prepare('INSERT INTO roles (nombre_rol) VALUES (?)').run('Temporal');
      db.prepare('INSERT INTO usuarios (nombre,email,password,id_rol) VALUES (?,?,?,?)').run('A','a@t.com','x',1);
      db.prepare('INSERT INTO auditoria (id_usuario, accion, detalles, ip) VALUES (1,?,?,?)').run('D','D','127.0.0.1');
      let borrado = false;
      try { db.prepare('DELETE FROM usuarios WHERE id = 1').run(); } catch { borrado = true; }
      const eventos = db.prepare('SELECT COUNT(*) AS c FROM auditoria').get().c;
      db.close();
      process.exit(borrado && eventos === 1 ? 0 : 1);
    `);
    removeDb(dbPath);

    assert.strictEqual(r.status, 0,
      'La trazabilidad debe prevailecer: no se puede borrar un usuario cuya bitácora quedaría alterada');
    return 'el historial sobrevive intacto al intento de borrado';
  });

  section('2. Arranque en frío');

  await test('La base de datos se reconstruye desde cero si no existe', () => {
    const dbPath = tempDbPath('cold');
    removeDb(dbPath);

    const r = runNode(`
      const http = require('http');
      process.env.PORT = '3321';
      process.env.DB_PATH = ${JSON.stringify(dbPath)};
      ${BASE_ENV}
      ${requireServer('server.js')}
      setTimeout(async () => {
        try {
          const body = await new Promise(res => http.get('http://127.0.0.1:3321/api/health', r => {
            let d = ''; r.on('data', c => d += c); r.on('end', () => res(d));
          }));
          console.log('SEED_OK', body.includes('OK'));
        } catch (e) { console.log('SEED_ERR', e.message); }
        process.exit(0);
      }, 3000);
    `);
    removeDb(dbPath);

    assert.match(r.stdout, /SEED_OK true/, `El servidor no arrancó limpio:\n${r.stdout}\n${r.stderr}`);
    return 'esquema, seed de roles, permisos, usuarios y noticias creados automáticamente';
  });

  section('3. Secretos fuera del código fuente');

  await test('Se rechazan los secretos de ejemplo publicados en .env.example', () => {
    const dbPath = tempDbPath('phsecret');
    const r = runNode(`
      process.env.DB_PATH = ${JSON.stringify(dbPath)};
      process.env.JWT_SECRET = 'tu_clave_secreta_jwt_para_tokens_de_acceso';
      process.env.JWT_REFRESH_SECRET = 'tu_clave_secreta_para_refresh_tokens';
      ${NON_SECRET_ENV}
      ${requireServer('src/middleware/auth.js')}
    `);
    removeDb(dbPath);

    assert.notStrictEqual(r.status, 0, 'Aceptó una clave que cualquiera que clone el repositorio conoce');
    assert.match(r.stderr, /valor de ejemplo/, `Debe explicar que es un valor de ejemplo: ${r.stderr.slice(0, 160)}`);
    return 'la aplicación se niega a arrancar con las claves de ejemplo';
  });

  await test('Se rechazan los secretos de baja entropía', () => {
    const dbPath = tempDbPath('lowent');
    const r = runNode(`
      process.env.DB_PATH = ${JSON.stringify(dbPath)};
      process.env.JWT_SECRET = 'a'.repeat(60);
      process.env.JWT_REFRESH_SECRET = ${JSON.stringify(SEC2)};
      ${NON_SECRET_ENV}
      ${requireServer('src/middleware/auth.js')}
    `);
    removeDb(dbPath);

    assert.notStrictEqual(r.status, 0, 'Aceptó un secreto completamente predecible');
    assert.match(r.stderr, /predecible/, `Debe explicar el motivo: ${r.stderr.slice(0, 160)}`);
    return 'rechaza claves como "aaaa..." que son triviales de adivinar';
  });

  await test('Se rechazan las contraseñas iniciales de ejemplo del seed', () => {
    const dbPath = tempDbPath('phpwd');
    const r = runNode(`
      process.env.DB_PATH = ${JSON.stringify(dbPath)};
      process.env.JWT_SECRET = ${JSON.stringify(SEC1)};
      process.env.JWT_REFRESH_SECRET = ${JSON.stringify(SEC2)};
      process.env.DEFAULT_ADMIN_PASSWORD = 'cambia-esta-clave-inicial-admin';
      process.env.DEFAULT_EDITOR_PASSWORD = 'EditorSeguro2026';
      process.env.DEFAULT_REGULAR_PASSWORD = 'LectorSeguro2026';
      ${requireServer('src/database/db.js')}
    `);
    removeDb(dbPath);

    assert.notStrictEqual(r.status, 0, 'Aceptó la contraseña de ejemplo del .env.example');
    assert.match(r.stderr, /inseguras/, `Debe explicar el motivo: ${r.stderr.slice(0, 160)}`);
    return 'no se crean usuarios iniciales con claves de ejemplo';
  });

  section('4. HTTPS / TLS');

  const certsReady = ensureDevCerts();

  if (!certsReady.ok) {
    console.log(`  – Se omiten las pruebas de TLS: ${certsReady.motivo}`);
  } else {
    await test('El servidor sirve por HTTPS cuando hay certificado', () => {
      const dbPath = tempDbPath('tls');
      const r = runNode(`
        const https = require('https');
        process.env.PORT = '3322';
        process.env.HTTPS_ENABLED = 'true';
        process.env.TLS_KEY_PATH = ${JSON.stringify(path.join(CERTS_DIR, 'dev-key.pem'))};
        process.env.TLS_CERT_PATH = ${JSON.stringify(path.join(CERTS_DIR, 'dev-cert.pem'))};
        process.env.DB_PATH = ${JSON.stringify(dbPath)};
        ${BASE_ENV}
        ${requireServer('server.js')}
        setTimeout(async () => {
          try {
            const body = await new Promise((ok, bad) => {
              https.get('https://127.0.0.1:3322/api/health', { rejectUnauthorized: false }, r => {
                let d = ''; r.on('data', c => d += c); r.on('end', () => ok(d));
              }).on('error', bad);
            });
            console.log('TLS_OK', body.includes('OK'));
          } catch (e) { console.log('TLS_ERR', e.message); }
          process.exit(0);
        }, 3000);
      `);
      removeDb(dbPath);

      assert.match(r.stdout, /TLS_OK true/, `No respondió por TLS:\n${r.stdout}\n${r.stderr}`);
      return 'las peticiones viajan cifradas, incluidas las credenciales y el JWT';
    });

    await test('Sobre HTTPS la cookie de sesión lleva Secure, HttpOnly y SameSite', () => {
      const dbPath = tempDbPath('tlscookie');
      const r = runNode(`
        const https = require('https');
        process.env.PORT = '3323';
        process.env.HTTPS_ENABLED = 'true';
        process.env.TLS_KEY_PATH = ${JSON.stringify(path.join(CERTS_DIR, 'dev-key.pem'))};
        process.env.TLS_CERT_PATH = ${JSON.stringify(path.join(CERTS_DIR, 'dev-cert.pem'))};
        process.env.DB_PATH = ${JSON.stringify(dbPath)};
        ${BASE_ENV}
        ${requireServer('server.js')}
        setTimeout(async () => {
          try {
            const cookies = await new Promise((ok, bad) => {
              const req = https.request({
                hostname: '127.0.0.1', port: 3323, path: '/api/auth/login', method: 'POST',
                rejectUnauthorized: false, headers: { 'Content-Type': 'application/json' }
              }, r => { r.resume(); r.on('end', () => ok(r.headers['set-cookie'] || [])); });
              req.on('error', bad);
              req.end(JSON.stringify({ email: 'admin@portalnoticias.com', password: 'ClaveSeguraAdmin1' }));
            });
            const acc = String(cookies.find(c => String(c).startsWith('portal_access_token=')) || '');
            console.log('COOKIE', /;\\s*Secure/i.test(acc), /HttpOnly/i.test(acc), /SameSite=Strict/i.test(acc));
          } catch (e) { console.log('COOKIE_ERR', e.message); }
          process.exit(0);
        }, 3000);
      `);
      removeDb(dbPath);

      const m = /COOKIE (true|false) (true|false) (true|false)/.exec(r.stdout);
      assert.ok(m, `El login por HTTPS falló:\n${r.stdout}\n${r.stderr}`);
      assert.strictEqual(m[1], 'true', 'La cookie debe marcarse Secure cuando el transporte es HTTPS');
      assert.strictEqual(m[2], 'true', 'La cookie debe ser HttpOnly');
      assert.strictEqual(m[3], 'true', 'La cookie debe ser SameSite=Strict');
      return 'los tres atributos se activan al cifrar el transporte';
    });

    await test('HTTPS sin certificado falla con un mensaje accionable, no con un error interno', () => {
      const dbPath = tempDbPath('tlsbad');
      const r = runNode(`
        process.env.HTTPS_ENABLED = 'true';
        process.env.TLS_KEY_PATH = '';
        process.env.TLS_CERT_PATH = '';
        process.env.DB_PATH = ${JSON.stringify(dbPath)};
        ${BASE_ENV}
        ${requireServer('server.js')}
      `);
      removeDb(dbPath);

      assert.notStrictEqual(r.status, 0, 'Arrancó sin certificado');
      assert.doesNotMatch(r.stderr, /argument must be of type string|must be of type/i,
        `Sigue escapando un error interno de Node: ${r.stderr.slice(0, 200)}`);
      assert.match(r.stderr, /faltan las variables/, `Debe indicar qué variables faltan: ${r.stderr.slice(0, 200)}`);
      return 'el mensaje dice qué variables definir y cómo resolverlo';
    });

    await test('HTTPS con rutas de certificado inexistentes falla con un mensaje accionable', () => {
      const dbPath = tempDbPath('tlsbad2');
      const r = runNode(`
        process.env.HTTPS_ENABLED = 'true';
        process.env.TLS_KEY_PATH = ${JSON.stringify(path.join(os.tmpdir(), 'no-existe-key.pem'))};
        process.env.TLS_CERT_PATH = ${JSON.stringify(path.join(os.tmpdir(), 'no-existe-cert.pem'))};
        process.env.DB_PATH = ${JSON.stringify(dbPath)};
        ${BASE_ENV}
        ${requireServer('server.js')}
      `);
      removeDb(dbPath);

      assert.notStrictEqual(r.status, 0, 'Arrancó con certificados inexistentes');
      assert.doesNotMatch(r.stderr, /ENOENT|argument must be of type string/i,
        `Escapa un error interno: ${r.stderr.slice(0, 200)}`);
      assert.match(r.stderr, /no se encuentra el certificado/,
        `Debe indicar el archivo que falta: ${r.stderr.slice(0, 200)}`);
      return 'el mensaje indica qué archivo falta y cómo generarlo';
    });
  }

  section('5. Endurecimiento del frontend servido');

  await test('Ninguna página contiene manejadores on* en línea', () => {
    const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
    const handlers = html.match(/\son[a-z]+\s*=\s*["']/gi) || [];
    assert.strictEqual(handlers.length, 0,
      `Se encontraron manejadores en línea que contradicen la política CSP script-src 'self': ${handlers.join(', ')}`);
    return 'los eventos se delegan desde los archivos .js, por eso la CSP no necesita unsafe-inline';
  });

  await test('La CSP permite los orígenes externos que index.html carga', () => {
    const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

    const csp = (server.match(/const CSP = \[([\s\S]*?)\]\.join/) || [, ''])[1];
    const directivas = Object.fromEntries(
      csp.split(',')
        .map(s => s.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean)
        .map(d => {
          const [nombre, ...valores] = d.split(/\s+/);
          return [nombre, valores];
        })
    );

    // Los atributos no siempre están en el mismo orden, así que se lee el
    // <link> completo y se buscan sus atributos por separado. La CSP compara
    // orígenes completos (con esquema), así que se conserva el esquema.
    const origenDe = (tag, atributo) => {
      const m = tag.match(new RegExp(`${atributo}=["'](https://[^/"']+)`));
      return m ? m[1] : null;
    };
    const links = [...html.matchAll(/<link\b[^>]*>/g)].map(m => m[0]);

    const hojas = [...new Set(links
      .filter(t => /rel=["'][^"']*stylesheet/i.test(t))
      .map(t => origenDe(t, 'href'))
      .filter(Boolean))];
    assert.ok(hojas.length > 0, 'El HTML debería cargar hojas de estilo externas (fuentes, iconos)');

    for (const origen of hojas) {
      assert.ok((directivas['style-src'] || []).includes(origen),
        `La CSP no permite ${origen} en style-src; su hoja de estilos se bloqueará y quedará invisible`);
    }

    // fonts.googleapis.com solo sirve el CSS de las tipografías del sistema; el
    // resto de CDN referencian sus .woff2 por ruta relativa, así que además
    // deben estar en font-src o los glifos (iconos) se quedan sin pintar.
    const soloCss = 'https://fonts.googleapis.com';
    for (const origen of hojas.filter(o => o !== soloCss)) {
      assert.ok((directivas['font-src'] || []).includes(origen),
        `${origen} sirve las tipografías de sus iconos: debe estar también en font-src`);
    }

    // Los preconnect solo calientan la conexión, pero si el origen que annonces no
// está permitido en ninguna directiva, estás anunciando un recurso que la CSP
// va a bloquear. Basta con que esté permitido en la directiva que corresponda.
    const preconnect = [...new Set(links
      .filter(t => /rel=["'][^"']*preconnect/i.test(t))
      .map(t => origenDe(t, 'href'))
      .filter(Boolean))];
    for (const origen of preconnect) {
      const permitido = [...(directivas['style-src'] || []), ...(directivas['font-src'] || [])]
        .includes(origen);
      assert.ok(permitido,
        `La CSP no permite ${origen} ni en style-src ni en font-src, pero el HTML lo declara como origen de recursos`);
    }

    return `permitidos ${[...new Set([...hojas, ...preconnect])].join(', ')}`;
  });

  await test('El bundle no guarda la sesión en almacenamiento web', () => {
    const jsDir = path.join(ROOT, 'public', 'js');
    const sospechoso = /token|jwt|session|sesion|cookie|auth|password|clave|secret|credential|permiso/i;

    for (const archivo of fs.readdirSync(jsDir).filter(f => f.endsWith('.js'))) {
      const codigo = fs.readFileSync(path.join(jsDir, archivo), 'utf8');

      for (const [, clave] of codigo.matchAll(/localStorage\s*\.\s*setItem\s*\(\s*['"`]([^'"`]+)['"`]/g)) {
        assert.ok(!sospechoso.test(clave), `${archivo} persiste "${clave}" en localStorage`);
      }
      for (const [, clave] of codigo.matchAll(/sessionStorage\s*\.\s*setItem\s*\(\s*['"`]([^'"`]+)['"`]/g)) {
        assert.ok(!sospechoso.test(clave), `${archivo} persiste "${clave}" en sessionStorage`);
      }
      assert.ok(!/document\.cookie\s*=/.test(codigo),
        `${archivo} escribe cookies desde JavaScript; deben ser HttpOnly y emitir solo el servidor`);
    }

    return 'solo se persisten preferencias de interfaz (el tema); el token vive en memoria y en cookie HttpOnly';
  });

  await test('El cliente envía el token en el encabezado Authorization', () => {
    const api = fs.readFileSync(path.join(ROOT, 'public', 'js', 'api.js'), 'utf8');
    assert.match(api, /Authorization\s*=\s*`Bearer \$\{token\}`/,
      'El cliente debe enviar el JWT como Authorization: Bearer <token>');
    assert.match(api, /credentials:\s*'include'/,
      'El cliente debe enviar las cookies para renovar la sesión');
    return 'Authorization: Bearer <token> en cada petición, como exige el enunciado';
  });

  await test('El frontend consume la API exclusivamente por fetch', () => {
    const jsDir = path.join(ROOT, 'public', 'js');
    for (const archivo of fs.readdirSync(jsDir).filter(f => f.endsWith('.js'))) {
      const codigo = fs.readFileSync(path.join(jsDir, archivo), 'utf8');
      assert.ok(!/require\(|import\s+.*from\s+['"]/.test(codigo),
        `${archivo} parece acceder a módulos del servidor o a la base de datos desde el cliente`);
    }

    const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
    assert.ok(!/database\.sqlite|node:sqlite|sqlite/i.test(html),
      'El HTML no debe referenciar la base de datos');
    return 'todo el dato del cliente proviene de /api/... mediante fetch';
  });

  section('6. Carga de imágenes de las noticias');

  await test('Las imágenes se guardan fuera de public y fuera del control de versiones', () => {
    assert.ok(!fs.existsSync(path.join(ROOT, 'public', 'uploads')),
      'public/uploads no debe existir: el directorio estático se despliega tal cual');

    const gitignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
    assert.ok(/^storage\/$/m.test(gitignore), 'El directorio de imágenes debe estar en .gitignore');

    const upload = fs.readFileSync(path.join(ROOT, 'src', 'middleware', 'upload.js'), 'utf8');
    assert.ok(/storage['"]\s*,?\s*['"]uploads|storage.*uploads/.test(upload),
      'Las imágenes deben escribirse en storage/uploads y no en public');
    return 'las subidas viven en storage/uploads, que no se versiona';
  });

  await test('El nombre y la extensión del archivo los decide el servidor', () => {
    const upload = fs.readFileSync(path.join(ROOT, 'src', 'middleware', 'upload.js'), 'utf8');
    assert.ok(/randomBytes/.test(upload), 'El nombre del archivo debe generarse con bytes aleatorios');
    assert.ok(/file\.originalname/.test(upload) === false,
      'No se debe reutilizar el nombre que envía el cliente');

    // La extensión sale de una tabla de tipos permitidos, nunca del archivo subido.
    assert.ok(/TIPOS_PERMITIDOS\.get\(file\.mimetype\)/.test(upload),
      'La extensión debe derivarse del tipo MIME permitido');

    // Comprobación de la firma real del archivo, no solo del tipo declarado.
    assert.ok(/detectarTipoReal/.test(upload),
      'Debe compararse el contenido real del archivo con las firmas de cada formato');
    assert.ok(!/image\/svg\+xml/.test(upload),
      'SVG no debe admitirse: puede ejecutar script al servirse');
  });

  await test('La carga exige el mismo permiso que publicar y está limitada en tamaño', () => {
    const rutas = fs.readFileSync(path.join(ROOT, 'src', 'routes', 'news.routes.js'), 'utf8');

    for (const verbo of ['post', 'put']) {
      const bloque = new RegExp(`router\\.${verbo}\\('/[^']*'[\\s\\S]*?\\n\\}\\);`);
      const match = bloque.exec(rutas);
      assert.ok(match, `No se encontró la ruta ${verbo.toUpperCase()} de noticias`);

      const cadena = match[0];
      assert.ok(/noticias\.crear|noticias\.editar/.test(cadena),
        `La ruta ${verbo.toUpperCase()} debe comprobar el permiso de publicación`);
      assert.ok(/authenticateToken/.test(cadena),
        `La ruta ${verbo.toUpperCase()} debe exigir autenticación`);
      assert.ok(/subirImagen/.test(cadena),
        `La ruta ${verbo.toUpperCase()} debe pasar por el middleware de carga`);
      assert.ok(cadena.indexOf('authenticateToken') < cadena.indexOf('subirImagen'),
        `En ${verbo.toUpperCase()} la autenticación debe comprobarse antes de aceptar el archivo`);
    }

    const upload = fs.readFileSync(path.join(ROOT, 'src', 'middleware', 'upload.js'), 'utf8');
    assert.ok(/MAX_IMAGE_BYTES = 5 \* 1024 \* 1024/.test(upload), 'Debe existir el límite de 5 MB');
    assert.ok(/fileSize: MAX_IMAGE_BYTES/.test(upload), 'El límite debe aplicarse a multer');
    return 'autenticación y permiso se comprueban antes de recibir el archivo';
  });

  await test('El formulario ofrece las dos vías de imagen', () => {
    const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
    assert.ok(/id="articleImgUrl"/.test(html), 'El campo de URL debe seguir disponible');
    assert.ok(/type="file"[\s\S]*?id="articleImgFile"/.test(html), 'Debe existir el selector de archivo');
    assert.ok(/id="articleImgPreview"/.test(html), 'Debe existir la vista previa de la imagen');
    assert.ok(!/onchange=/i.test(html), 'La carga se listens con addEventListener, no con manejadores en línea');

    const news = fs.readFileSync(path.join(ROOT, 'public', 'js', 'news.js'), 'utf8');
    assert.ok(/new FormData\(\)/.test(news), 'news.js debe construir un FormData para enviar el archivo');
    assert.ok(/postForm|putForm/.test(news), 'news.js debe usar el envío multipart de api.js');

    const api = fs.readFileSync(path.join(ROOT, 'public', 'js', 'api.js'), 'utf8');
    assert.ok(/if \(!options\.multipart\)/.test(api),
      'api.js no debe fijar Content-Type en las peticiones multipart, porque el boundary lo pone el navegador');
    return 'URL y archivo local conviven en el mismo formulario';
  });
}

/**
 * Genera el certificado de desarrollo si aún no existe. Devuelve si está listo
 * para probar TLS, o el motivo por el que las pruebas de TLS se omitirán.
 */
function ensureDevCerts() {
  const key = path.join(CERTS_DIR, 'dev-key.pem');
  const cert = path.join(CERTS_DIR, 'dev-cert.pem');
  if (fs.existsSync(key) && fs.existsSync(cert)) return { ok: true };

  const r = spawnSync(process.execPath, ['scripts/generate-certs.js'], { cwd: ROOT, encoding: 'utf8' });
  if (fs.existsSync(key) && fs.existsSync(cert)) return { ok: true };

  return {
    ok: false,
    motivo: `no se pudo generar un certificado con OpenSSL (${r.stderr.trim().split('\n')[0] || 'sin OpenSSL'})`
  };
}

// --------------------------------------------------------------------------
async function main() {
  try {
    await run();
  } catch (error) {
    failures.push({ name: 'Ejecución de las verificaciones', error });
    console.error('\nError inesperado:', error);
  }

  console.log('\n' + '='.repeat(64));
  console.log(`Resultado: ${passed} correctas, ${failures.length} fallidas`);
  if (failures.length > 0) {
    console.log('\nFallos:');
    for (const f of failures) console.log(`  - ${f.name}: ${f.error.message}`);
  }
  console.log('='.repeat(64));

  process.exit(failures.length === 0 ? 0 : 1);
}

main();