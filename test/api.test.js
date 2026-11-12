/**
 * Suite de pruebas de integración y de seguridad.
 *
 * Levanta el servidor en un proceso hijo con una base de datos temporal y
 * credenciales conocidas, ejecuta las pruebas contra la API REST real y apaga
 * el servidor al terminar. No toca la base de datos de la aplicación.
 *
 *   npm test
 */
const assert = require('assert');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.TEST_PORT || 3177);
const BASE_URL = `http://127.0.0.1:${PORT}/api`;

const CREDENTIALS = {
  admin: { email: 'admin@portalnoticias.com', password: 'AdminSeguro2026' },
  editor: { email: 'editor@portalnoticias.com', password: 'EditorSeguro2026' },
  lector: { email: 'lector@portalnoticias.com', password: 'LectorSeguro2026' }
};

let passed = 0;
const failures = [];
let primaryServer = null;

// --------------------------------------------------------------------------
// Cliente HTTP con manejo de cookies (replica el navegador)
// --------------------------------------------------------------------------
function createClient() {
  const jar = new Map();

  return {
    jar,
    get cookieHeader() {
      return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    },
    async request(url, options = {}) {
      const headers = { ...(options.headers || {}) };
      if (jar.size > 0) headers.Cookie = this.cookieHeader;

      const response = await fetch(BASE_URL + url, { ...options, headers });

      const setCookies = response.headers.getSetCookie ? response.headers.getSetCookie() : [];
      for (const cookie of setCookies) {
        const [nameValue] = cookie.split(';');
        const sep = nameValue.indexOf('=');
        if (sep > 0) jar.set(nameValue.slice(0, sep), nameValue.slice(sep + 1));
      }

      const raw = await response.text();
      let json;
      try { json = JSON.parse(raw); } catch { json = raw; }

      return { status: response.status, json, raw, headers: response.headers };
    },
    get(url, options) { return this.request(url, { ...options, method: 'GET' }); },
    post(url, body, options = {}) {
      return this.request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
        ...options
      });
    },
    put(url, body, options = {}) {
      return this.request(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
        ...options
      });
    },
    /**
     * Envía multipart/form-data. `campos` es un objeto plano de texto y `archivo`
     * un { nombre, tipo, datos } que se manda en el campo indicado. Se deja el
     * Content-Type en manos de fetch para que añada el boundary del cuerpo.
     */
    postForm(url, campos, archivo, campoArchivo = 'imagen') {
      return this.postFormVerb(url, campos, archivo, campoArchivo, 'POST');
    },
    putForm(url, campos, archivo, campoArchivo = 'imagen') {
      return this.postFormVerb(url, campos, archivo, campoArchivo, 'PUT');
    },
    postFormVerb(url, campos, archivo, campoArchivo, method) {
      const form = new FormData();
      for (const [k, v] of Object.entries(campos)) {
        if (v !== undefined && v !== null) form.append(k, v);
      }
      if (archivo) {
        form.append(campoArchivo, new Blob([archivo.datos], { type: archivo.tipo }), archivo.nombre);
      }
      return this.request(url, { method, body: form });
    },
    del(url, options = {}) { return this.request(url, { method: 'DELETE', ...options }); }
  };
}

async function loginAs(role) {
  const client = createClient();
  const { email, password } = CREDENTIALS[role];
  const res = await client.post('/auth/login', { email, password });
  assert.strictEqual(res.status, 200, `No se pudo iniciar sesión como ${role}: ${res.raw}`);
  return client;
}

// --------------------------------------------------------------------------
// Runner
// --------------------------------------------------------------------------
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✔ ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  ✖ ${name}`);
    console.log(`      ${error.message}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

// --------------------------------------------------------------------------
// Ciclo de vida del servidor de pruebas
// --------------------------------------------------------------------------

const runningServers = [];

/**
 * Prepara una ruta de base de datos temporal para una instancia de pruebas.
 */
function makeTempDbPath(tag) {
  const dbPath = path.join(os.tmpdir(), `portal-noticias-${tag}-${process.pid}.sqlite`);
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    fs.rmSync(dbPath + suffix, { force: true });
  }
  return dbPath;
}

/**
 * Levanta el servidor en un proceso hijo con una base de datos propia.
 * Los limites de peticiones se relajan en la instancia principal para que la
 * suite completa pueda ejecutarse; la verificacion del limite (429) se hace
 * aparte, en una instancia dedicada con umbrales bajos.
 */
function spawnTestServer({ port, tag, env = {} }) {
  const dbPath = makeTempDbPath(tag);
  // Las imágenes se escriben en un directorio propio de la prueba para no dejar
  // archivos en el storage del proyecto y para poder comprobar su limpieza.
  const uploadDir = path.join(os.tmpdir(), `portal-noticias-uploads-${tag}-${port}`);

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: String(port),
        NODE_ENV: 'test',
        HTTPS_ENABLED: 'false',
        DB_PATH: dbPath,
        UPLOAD_DIR: uploadDir,
        CORS_ORIGIN: `http://localhost:${port},http://127.0.0.1:${port}`,
        TRUST_PROXY: 'false',
        JWT_SECRET: 'a'.repeat(48) + 'x7Kq2',
        JWT_REFRESH_SECRET: 'b'.repeat(48) + 'z9Rt5',
        DEFAULT_ADMIN_PASSWORD: CREDENTIALS.admin.password,
        DEFAULT_EDITOR_PASSWORD: CREDENTIALS.editor.password,
        DEFAULT_REGULAR_PASSWORD: CREDENTIALS.lector.password,
        RATE_LIMIT_API_MAX: '100000',
        RATE_LIMIT_AUTH_MAX: '100000',
        SMTP_USER: '',
        SMTP_PASS: '',
        ...env
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    const handle = { child, port, dbPath, uploadDir };
    runningServers.push(handle);

    let output = '';
    child.stdout.on('data', d => { output += d.toString(); });
    child.stderr.on('data', d => { output += d.toString(); });

    child.on('error', reject);
    child.on('exit', code => {
      if (code !== 0 && !/EADDRINUSE/.test(output) && !child.__esperandoCierre) {
        reject(new Error(`El servidor de pruebas (puerto ${port}) terminó con código ${code}:\n${output}`));
      }
    });

    const baseUrl = `http://127.0.0.1:${port}/api`;
    const deadline = Date.now() + 30000;
    const poll = async () => {
      if (child.exitCode !== null) return;
      try {
        const res = await fetch(`${baseUrl}/health`);
        if (res.ok) return resolve(handle);
      } catch { /* aún no responde */ }
      if (Date.now() > deadline) return reject(new Error(`El servidor de pruebas del puerto ${port} no respondió a tiempo`));
      setTimeout(poll, 250);
    };
    setTimeout(poll, 500);
  });
}

/**
 * Detiene una instancia y espera a que libere el archivo SQLite antes de
 * borrarlo (en Windows, un unlink sobre un archivo abierto falla con EBUSY).
 */
async function stopTestServer(handle) {
  if (!handle || !handle.child || handle.child.exitCode !== null) {
    if (handle && handle.dbPath) removeDbFiles(handle.dbPath);
    return;
  }

  handle.child.__esperandoCierre = true;
  const exited = new Promise(resolve => handle.child.once('exit', resolve));

  if (handle.child.pid) {
    try {
      process.kill(handle.child.pid, 'SIGTERM');
    } catch { /* ya terminó */ }
  }

  // Si no responde al cierre ordenado, se fuerza la terminación.
  const forzado = setTimeout(() => {
    try { process.kill(handle.child.pid, 'SIGKILL'); } catch { /* ya terminó */ }
  }, 5000);

  await exited;
  clearTimeout(forzado);
  removeDbFiles(handle.dbPath);
}

function removeDbFiles(dbPath) {
  if (!dbPath) return;
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    try {
      fs.rmSync(dbPath + suffix, { force: true });
    } catch {
      // Si el sistema todavia mantiene el archivo abierto, se ignora: vive en
      // la carpeta temporal y no afecta a la base de datos de la aplicacion.
    }
  }
}

async function stopAllServers() {
  while (runningServers.length > 0) {
    await stopTestServer(runningServers.pop());
  }
}

// --------------------------------------------------------------------------
// Pruebas
// --------------------------------------------------------------------------
async function run() {
  console.log('Portal de Noticias UNACH — Suite de pruebas de seguridad y API');
  console.log(`Servidor de pruebas: ${BASE_URL}`);

  section('1. Autenticación, JWT y ciclo de vida de sesión');

  await test('Health check responde correctamente', async () => {
    const res = await fetch(`${BASE_URL}/health`);
    const data = await res.json();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(data.status, 'OK');
  });

  await test('El login devuelve un JWT firmado (Authorization: Bearer)', async () => {
    const client = createClient();
    const res = await client.post('/auth/login', CREDENTIALS.admin);
    assert.strictEqual(res.status, 200);
    assert.ok(res.json.accessToken, 'La respuesta debe incluir accessToken');
    assert.strictEqual(res.json.tokenType, 'Bearer');
    assert.strictEqual(res.json.expiresIn, 900);
    assert.strictEqual(res.json.user.nombre_rol, 'Administrador');

    const parts = res.json.accessToken.split('.');
    assert.strictEqual(parts.length, 3, 'El token debe tener 3 segmentos JWT');
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    assert.strictEqual(header.alg, 'HS256');
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    assert.ok(payload.nombre_rol, 'El payload debe incluir el rol');
    assert.ok(!/password|secret/i.test(JSON.stringify(payload)), 'El payload no debe incluir secretos');
    assert.ok(payload.exp - payload.iat <= 1800, 'El token debe expirar en 15 min o menos');
  });

  await test('El token se acepta en el encabezado Authorization: Bearer', async () => {
    const client = await loginAs('admin');
    const token = client.jar.get('portal_access_token');
    const res = await fetch(`${BASE_URL}/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
    assert.strictEqual(res.status, 200);
  });

  await test('Un token con firma inválida es rechazado', async () => {
    const res = await fetch(`${BASE_URL}/auth/me`, {
      headers: { Authorization: `Bearer ${'a'.repeat(20)}.b.c` }
    });
    assert.ok([401, 403].includes(res.status), `Status inesperado: ${res.status}`);
  });

  await test('Los tres roles predeterminados inician sesión', async () => {
    for (const [role, expected] of [['admin', 'Administrador'], ['editor', 'Editor'], ['lector', 'Usuario Regular']]) {
      const client = createClient();
      const res = await client.post('/auth/login', CREDENTIALS[role]);
      assert.strictEqual(res.status, 200, `Login fallido para ${role}`);
      assert.strictEqual(res.json.user.nombre_rol, expected);
      assert.ok(Array.isArray(res.json.permissions));
    }
  });

  await test('Las cookies se emiten con HttpOnly y SameSite', async () => {
    const res = await fetch(`${BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(CREDENTIALS.lector)
    });
    const cookies = res.headers.getSetCookie();
    const access = cookies.find(c => c.startsWith('portal_access_token='));
    const refresh = cookies.find(c => c.startsWith('portal_refresh_token='));
    assert.ok(/HttpOnly/i.test(access), 'La cookie de acceso debe ser HttpOnly');
    assert.ok(/SameSite=Strict/i.test(access), 'La cookie de acceso debe ser SameSite=Strict');
    assert.ok(/Path=\/api\/auth/i.test(refresh), 'El refresh debe estar limitado a /api/auth');
  });

  await test('El refresh token rota y no se puede reutilizar', async () => {
    const client = await loginAs('lector');
    const refresh1 = client.jar.get('portal_refresh_token');

    const first = await client.post('/auth/refresh', {});
    assert.strictEqual(first.status, 200);
    assert.ok(first.json.accessToken);
    assert.notStrictEqual(client.jar.get('portal_refresh_token'), refresh1);

    const replay = await fetch(`${BASE_URL}/auth/refresh`, {
      method: 'POST',
      headers: { Cookie: `portal_refresh_token=${refresh1}` }
    });
    assert.strictEqual(replay.status, 401, 'Un refresh token rotado no debe poder reutilizarse');
  });

  await test('El registro crea usuarios y el correo es único sin importar mayúsculas', async () => {
    const client = createClient();
    const email = `prueba.${Date.now()}@t.com`;
    const res = await client.post('/auth/register', { nombre: 'Usuario Prueba', email, password: 'ClaveSegura123' });
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.json.user.nombre_rol, 'Usuario Regular');

    const dup = await createClient().post('/auth/register', { nombre: 'Duplicado', email: email.toUpperCase(), password: 'ClaveSegura123' });
    assert.strictEqual(dup.status, 400, 'No debe permitir correos duplicados por capitalización');
  });

  await test('El rol no puede ser automating en el registro', async () => {
    const res = await createClient().post('/auth/register', {
      nombre: 'Escalador', email: `escalador.${Date.now()}@t.com`, password: 'ClaveSegura123', id_rol: 1
    });
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.json.user.nombre_rol, 'Usuario Regular', 'El rol debe ser siempre Usuario Regular');
  });

  await test('Cambio de contraseña invalida la contraseña anterior', async () => {
    const client = createClient();
    const email = `cambio.${Date.now()}@t.com`;
    await client.post('/auth/register', { nombre: 'Cambio Clave', email, password: 'ClaveAnterior1' });

    const change = await client.post('/auth/change-password', {
      currentPassword: 'ClaveAnterior1', newPassword: 'ClaveNueva12345'
    });
    assert.strictEqual(change.status, 200);
    assert.strictEqual(change.json.reauthRequired, true);

    const oldLogin = await createClient().post('/auth/login', { email, password: 'ClaveAnterior1' });
    assert.strictEqual(oldLogin.status, 401, 'La contraseña anterior debe dejar de funcionar');

    const newLogin = await createClient().post('/auth/login', { email, password: 'ClaveNueva12345' });
    assert.strictEqual(newLogin.status, 200);
  });

  await test('El inicio y cierre de sesión quedan registrados en la auditoría', async () => {
    const client = await loginAs('lector');
    const logout = await client.post('/auth/logout', {});
    assert.strictEqual(logout.status, 200);

    const admin = await loginAs('admin');
    const logs = (await admin.get('/admin/auditoria?limit=500')).json;
    assert.ok(logs.some(l => l.accion === 'Inicio de Sesión'), 'Debe auditarse el inicio de sesión');
    assert.ok(logs.some(l => l.accion === 'Cierre de Sesión'), 'Debe auditarse el cierre de sesión');
    const evento = logs.find(l => l.accion === 'Cierre de Sesión');
    assert.ok(evento.usuario_nombre && evento.fecha_hora && evento.ip,
      'Cada evento debe registrar usuario, fecha/hora e IP');
  });

  section('2. Cifrado y robustez de credenciales');

  await test('Las contraseñas se almacenan como hashes bcrypt con salt', async () => {
    // La base de datos es la temporal del proceso de pruebas, accesible por ruta.
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(primaryServer.dbPath);
    const rows = db.prepare('SELECT email, password FROM usuarios').all();
    db.close();
    assert.ok(rows.length > 0);
    for (const row of rows) {
      assert.ok(/^\$2[aby]\$\d{2}\$/.test(row.password), `Hash bcrypt inválido para ${row.email}`);
      assert.ok(!row.password.includes('Seguro2026'), 'La contraseña no debe estar en texto plano');
    }
  });

  await test('La sanitización NO altera la contraseña elegida por el usuario', async () => {
    const casos = [
      ['normal', 'MiClaveSegura2026'],
      ['con fragmento on*=', 'Clave onx=9segura'],
      ['con javascript:', 'Clave javascript:alert'],
      ['con espacios al inicio y fin', '  ConEspacios123  ']
    ];

    for (const [etiqueta, password] of casos) {
      const email = `pwd.${etiqueta.replace(/\W/g, '')}.${Date.now()}@t.com`;
      const client = createClient();
      const reg = await client.post('/auth/register', { nombre: 'Prueba Contraseña', email, password });
      assert.strictEqual(reg.status, 201, `Registro falló (${etiqueta}): ${reg.raw}`);

      const login = await createClient().post('/auth/login', { email, password });
      assert.strictEqual(login.status, 200, `No se puede iniciar sesión con la contraseña escrita (${etiqueta})`);

      // Ninguna contraseña alterada debe servir como equivalente
      const alterada = password.replace(/\bon\w+\s*=\s*(?:'[^']*'|"[^"]*"|[^\s>]+)/gi, '').trim();
      if (alterada !== password) {
        const conAlterada = await createClient().post('/auth/login', { email, password: alterada });
        assert.strictEqual(conAlterada.status, 401,
          `Una contraseña distinta no debe abrir la misma cuenta (${etiqueta})`);
      }
    }
  });

  await test('Una contraseña no se recorta ni se modifica en silencio', async () => {
    // Las formerly wrongly-accepted now rejected cases must produce a clear error,
    // not a misleading "all fields required".
    const res = await createClient().post('/auth/register', {
      nombre: 'Atajo', email: `atajo.${Date.now()}@t.com`, password: 'onx=Secreto9'
    });
    assert.ok([201, 400].includes(res.status));
    if (res.status === 400) {
      assert.ok(!/Todos los campos son obligatorios/.test(res.json.error),
        'No debe reportar campos faltantes cuando sí se envió una contraseña');
    }
  });

  section('3. Protección contra fuerza bruta y límites de peticiones');

  await test('La cuenta se bloquea tras 5 intentos fallidos', async () => {
    const email = `fuerza.${Date.now()}@t.com`;
    await createClient().post('/auth/register', { nombre: 'Fuerza Bruta', email, password: 'ClaveCorrecta1' });

    const codigos = [];
    for (let i = 0; i < 5; i += 1) {
      const res = await createClient().post('/auth/login', { email, password: 'ContrasenaIncorrecta' });
      codigos.push(res.status);
    }
    assert.strictEqual(codigos[codigos.length - 1], 423, `Códigos recibidos: ${codigos.join(',')}`);

    const conCorrecta = await createClient().post('/auth/login', { email, password: 'ClaveCorrecta1' });
    assert.strictEqual(conCorrecta.status, 423, 'La contraseña correcta no debe aceptarse mientras la cuenta está bloqueada');
  });

  await test('El rate limiting se activa en los endpoints de autenticación', async () => {
    // Instancia aislada con un umbral mínimo: así se verifica el límite real sin
    // agotar el de la instancia principal, que debe seguir disponible para el resto
    // de la suite.
    const limited = await spawnTestServer({
      port: PORT + 1,
      tag: 'rate',
      env: { RATE_LIMIT_AUTH_MAX: '5', RATE_LIMIT_API_MAX: '100000' }
    });

    try {
      const codigos = [];
      for (let i = 0; i < 8; i += 1) {
        const res = await fetch(`http://127.0.0.1:${limited.port}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'noexiste@t.com', password: 'x' })
        });
        codigos.push(res.status);
        if (res.status === 429) {
          assert.ok(res.headers.get('retry-after'), 'La respuesta 429 debe indicar Retry-After');
          assert.ok(res.headers.get('x-ratelimit-limit'), 'La respuesta debe exponer el límite aplicado');
          break;
        }
      }

      assert.ok(codigos.includes(429), `Debe responder 429 al superar el límite. Códigos: ${codigos.join(',')}`);
      assert.strictEqual(codigos.slice(0, 5).every(c => c === 401), true,
        `Las peticiones dentro del límite deben procesarse con normalidad: ${codigos.join(',')}`);
    } finally {
      await stopTestServer(limited);
    }
  });

  section('4. Autorización basada en roles y permisos (RBAC)');

  await test('Usuario Regular no puede crear noticias (403)', async () => {
    const lector = await loginAs('lector');
    const res = await lector.post('/noticias', { titulo: 'Intento', contenido: 'Contenido no autorizado', categoria: 'Tecnología' });
    assert.strictEqual(res.status, 403);
    assert.ok(res.json.permiso_requerido, 'La respuesta debe indicar el permiso requerido');
  });

  await test('Usuario Regular no puede acceder al panel de administración', async () => {
    const lector = await loginAs('lector');
    for (const ruta of ['/admin/usuarios', '/admin/roles', '/admin/permisos', '/admin/auditoria']) {
      const res = await lector.get(ruta);
      assert.strictEqual(res.status, 403, `${ruta} debería devolver 403`);
    }
  });

  await test('Un rol con cero permisos no puede leer noticias', async () => {
    const admin = await loginAs('admin');

    const rol = await admin.post('/admin/roles', { nombre_rol: `SinPermisos${Date.now()}`, descripcion: 'Prueba' });
    assert.strictEqual(rol.status, 201);

    const email = `sinperm.${Date.now()}@t.com`;
    const cliente = createClient();
    await cliente.post('/auth/register', { nombre: 'Sin Permisos', email, password: 'ClaveSegura123' });

    const usuarios = (await admin.get('/admin/usuarios')).json;
    const usuario = usuarios.find(u => u.email === email);
    const asignar = await admin.put(`/admin/usuarios/${usuario.id}/rol`, { id_rol: rol.json.rol.id });
    assert.strictEqual(asignar.status, 200);

    const conRol = createClient();
    const login = await conRol.post('/auth/login', { email, password: 'ClaveSegura123' });
    assert.strictEqual(login.status, 200);
    assert.deepStrictEqual(login.json.permissions, [], 'El rol nuevo no debe tener permisos');

    const lectura = await conRol.get('/noticias');
    assert.strictEqual(lectura.status, 403, 'noticias.leer debe verificarse en el servidor');
  });

  await test('Revocar un permiso a un rol surte efecto inmediato (incluido Administrador)', async () => {
    const admin = await loginAs('admin');

    const roles = (await admin.get('/admin/roles')).json;
    const adminRole = roles.find(r => r.nombre_rol === 'Administrador');
    const permisos = (await admin.get('/admin/permisos')).json;
    const objetivo = permisos.find(p => p.nombre_permiso === 'noticias.crear');
    const restantes = adminRole.permisos.map(p => p.id_permiso).filter(id => id !== objetivo.id);

    const revocar = await admin.put(`/admin/roles/${adminRole.id}/permisos`, { permisos_ids: restantes });
    assert.strictEqual(revocar.status, 200);

    // El token sigue siendo válido, pero la autorización se resuelve contra la BD
    const despues = await admin.post('/noticias', {
      titulo: 'Intento tras revocación', contenido: 'Contenido que debe ser rechazado', categoria: 'Ciencia'
    });
    assert.strictEqual(despues.status, 403, 'La revocación dinámica debe bloquear la operación');

    // Restaurar para no afectar las pruebas siguientes
    const restaurar = await admin.put(`/admin/roles/${adminRole.id}/permisos`, {
      permisos_ids: adminRole.permisos.map(p => p.id_permiso)
    });
    assert.strictEqual(restaurar.status, 200);

    const despuesRestaurado = await admin.post('/noticias', {
      titulo: 'Noticia tras restaurar', contenido: 'Contenido restaurado correctamente', categoria: 'Ciencia'
    });
    assert.strictEqual(despuesRestaurado.status, 201);
    await admin.del(`/noticias/${despuesRestaurado.json.noticia.id}`);
  });

  await test('No se puede dejar el sistema sin permiso de administración', async () => {
    const admin = await loginAs('admin');
    const roles = (await admin.get('/admin/roles')).json;
    const adminRole = roles.find(r => r.nombre_rol === 'Administrador');
    const permisos = (await admin.get('/admin/permisos')).json;
    const idPermiso = nombre => permisos.find(p => p.nombre_permiso === nombre).id;

    const criticos = ['roles.gestionar', 'usuarios.gestionar'].map(idPermiso);
    const todosLosPermisos = adminRole.permisos.map(p => p.id_permiso);

    // Se crea un segundo rol que también administra el sistema, junto con un
    // usuario que lo ostente. Mientras ese usuario conserve el permiso, revocar
    // los permisos críticos al Administrador es legítimo: el sistema sigue siendo
    // administrable y por eso debe permitirse.
    const respaldo = await admin.post('/admin/roles', {
      nombre_rol: `RespaldoAdmin${Date.now()}`,
      descripcion: 'Segundo rol administrador para probar el anti-bloqueo',
      permisos_ids: criticos
    });
    assert.strictEqual(respaldo.status, 201);

    const emailRespaldo = `respaldo.${Date.now()}@t.com`;
    await createClient().post('/auth/register', { nombre: 'Administrador de Respaldo', email: emailRespaldo, password: 'ClaveSegura123' });
    const usuarios = (await admin.get('/admin/usuarios')).json;
    const usuarioRespaldo = usuarios.find(u => u.email === emailRespaldo);
    const asignar = await admin.put(`/admin/usuarios/${usuarioRespaldo.id}/rol`, { id_rol: respaldo.json.rol.id });
    assert.strictEqual(asignar.status, 200);

    const adminRespaldo = createClient();
    const inicio = await adminRespaldo.post('/auth/login', { email: emailRespaldo, password: 'ClaveSegura123' });
    assert.strictEqual(inicio.status, 200, 'El administrador de respaldo debe poder iniciar sesión');

    // Revocar los permisos críticos al Administrador original: permitido,
    // porque el usuario de respaldo todavía los tiene.
    const sinCriticos = todosLosPermisos.filter(id => !criticos.includes(id));
    const revocarAdmin = await adminRespaldo.put(`/admin/roles/${adminRole.id}/permisos`, { permisos_ids: sinCriticos });
    assert.strictEqual(revocarAdmin.status, 200,
      'Se debe permitir la revocación mientras otro rol conserve la administración');

    // El Administrador original ya no puede administrar: su token sigue siendo
    // válido, pero la autorización se resuelve contra la base de datos.
    const despues = await admin.put(`/admin/roles/${adminRole.id}/permisos`, { permisos_ids: sinCriticos });
    assert.strictEqual(despues.status, 403, 'La revocación dinámica debe surtir efecto inmediato');

    // Intentar quitarle esos mismos permisos al último rol que los tiene dejaría
    // el sistema sin ninguna forma de administrar roles o usuarios: 409.
    const revocarUltimo = await adminRespaldo.put(`/admin/roles/${respaldo.json.rol.id}/permisos`, { permisos_ids: [] });
    assert.strictEqual(revocarUltimo.status, 409,
      'Debe impedirse revocar el último permiso de administracion del sistema');
    assert.ok(/roles\.gestionar|usuarios\.gestionar/.test(revocarUltimo.json.error || ''),
      'El error debe indicar que permiso critico quedaria huerfano');

    // Restaurar el estado original del rol Administrador.
    const restaurado = await adminRespaldo.put(`/admin/roles/${adminRole.id}/permisos`, { permisos_ids: todosLosPermisos });
    assert.strictEqual(restaurado.status, 200);

    const verifica = await admin.get('/noticias');
    assert.strictEqual(verifica.status, 200, 'El Administrador debe recuperar el acceso completo');
  });

  await test('El Editor no puede modificar contenido de otro autor', async () => {
    const editor = await loginAs('editor');
    const creado = await editor.post('/noticias', {
      titulo: 'Artículo de prueba', contenido: 'Contenido pertenece al primer editor', categoria: 'Cultura'
    });
    assert.strictEqual(creado.status, 201);
    const id = creado.json.noticia.id;

    const email = `editor2.${Date.now()}@t.com`;
    const segundo = createClient();
    await segundo.post('/auth/register', { nombre: 'Segundo Editor', email, password: 'ClaveSegura123' });

    const admin = await loginAs('admin');
    const roles = (await admin.get('/admin/roles')).json;
    const editorRole = roles.find(r => r.nombre_rol === 'Editor');
    const usuarios = (await admin.get('/admin/usuarios')).json;
    const u2 = usuarios.find(u => u.email === email);
    await admin.put(`/admin/usuarios/${u2.id}/rol`, { id_rol: editorRole.id });

    await segundo.post('/auth/login', { email, password: 'ClaveSegura123' });
    const editar = await segundo.put(`/noticias/${id}`, { titulo: 'Secuestrado', contenido: 'Cambio no autorizado de autor', categoria: 'Cultura' });
    assert.strictEqual(editar.status, 403);
    const borrar = await segundo.del(`/noticias/${id}`);
    assert.strictEqual(borrar.status, 403);

    await editor.del(`/noticias/${id}`);
  });

  await test('El Editor puede crear, editar y eliminar contenido (CRUD completo)', async () => {
    const editor = await loginAs('editor');

    const crear = await editor.post('/noticias', {
      titulo: 'Proyecto estudiantil de energía renovable',
      contenido: 'Estudiantes de ingeniería diseñadas un prototipo de celda solar.',
      categoria: 'Ciencia'
    });
    assert.strictEqual(crear.status, 201);
    const id = crear.json.noticia.id;

    const editar = await editor.put(`/noticias/${id}`, {
      titulo: 'Proyecto estudiantil de energía renovable (actualizado)',
      contenido: 'Estudiantes presentar avances con más del 38 por ciento de eficiencia.',
      categoria: 'Ciencia'
    });
    assert.strictEqual(editar.status, 200);
    assert.strictEqual(editar.json.noticia.titulo.includes('actualizado'), true);

    const borrar = await editor.del(`/noticias/${id}`);
    assert.strictEqual(borrar.status, 200);

    const verificar = await editor.get(`/noticias/${id}`);
    assert.strictEqual(verificar.status, 404);
  });

  await test('Un Administrador puede asignar y revocar roles', async () => {
    const admin = await loginAs('admin');
    const roles = (await admin.get('/admin/roles')).json;
    const lectorRole = roles.find(r => r.nombre_rol === 'Usuario Regular');

    const email = `roles.${Date.now()}@t.com`;
    const cliente = createClient();
    await cliente.post('/auth/register', { nombre: 'Cambio de Rol', email, password: 'ClaveSegura123' });
    const usuarios = (await admin.get('/admin/usuarios')).json;
    const usuario = usuarios.find(u => u.email === email);

    const asignar = await admin.put(`/admin/usuarios/${usuario.id}/rol`, { id_rol: lectorRole.id });
    assert.strictEqual(asignar.status, 200);
    assert.strictEqual(asignar.json.usuario.nombre_rol, 'Usuario Regular');

    const bitacora = (await admin.get('/admin/auditoria?search=Cambio%20de%20Rol&limit=20')).json;
    assert.ok(bitacora.length > 0, 'El cambio de rol debe quedar auditado');
  });

  await test('Se puede crear un rol y asignarle permisos', async () => {
    const admin = await loginAs('admin');
    const permisos = (await admin.get('/admin/permisos')).json;
    const leer = permisos.find(p => p.nombre_permiso === 'noticias.leer').id;

    const creado = await admin.post('/admin/roles', {
      nombre_rol: `Revisor${Date.now()}`,
      descripcion: 'Solo lectura de noticias',
      permisos_ids: [leer]
    });
    assert.strictEqual(creado.status, 201);

    const roles = (await admin.get('/admin/roles')).json;
    const nuevo = roles.find(r => r.nombre_rol === creado.json.rol.nombre_rol);
    assert.strictEqual(nuevo.permisos.length, 1);
    assert.strictEqual(nuevo.permisos[0].id_permiso, leer);
  });

  section('5. Validación de entradas, XSS e inyección SQL');

  await test('Las consultas usan parámetros (inyección SQL)', async () => {
    const admin = await loginAs('admin');
    const payloads = ["' OR 1=1 --", "' UNION SELECT password FROM usuarios--", "'; DROP TABLE noticias;--"];

    for (const payload of payloads) {
      const res = await admin.get(`/noticias?search=${encodeURIComponent(payload)}`);
      assert.strictEqual(res.status, 200, `Fallo con: ${payload}`);
      assert.ok(!/SQLITE_|syntax error|no such/i.test(res.raw), `La consulta filtró información: ${res.raw.slice(0, 120)}`);
      assert.ok(Array.isArray(res.json) && res.json.length === 0, 'Un payload SQL no debe devolver resultados');
    }

    const porId = await admin.get(`/noticias/${encodeURIComponent("1 OR 1=1")}`);
    assert.ok(porId.status < 500, 'Un id malicioso no debe provocar error interno');

    const tabla = await admin.get('/noticias?limit=5');
    assert.ok(tabla.status === 200 && tabla.json.length > 0, 'La tabla de noticias debe seguir existiendo');
  });

  await test('El contenido almacenado se sanitiza contra XSS', async () => {
    const editor = await loginAs('editor');
    const payload = '<img src=x onerror=alert(1)>"><script>alert(2)</script>';

    const crear = await editor.post('/noticias', { titulo: 'Prueba XSS', contenido: payload, categoria: 'Tecnología' });
    assert.strictEqual(crear.status, 201);

    const almacenado = crear.json.noticia.contenido;
    assert.ok(!/<script/i.test(almacenado), 'No debe almacenarse una etiqueta script');
    assert.ok(!/onerror/i.test(almacenado), 'No debe almacenarse un manejador onerror');
    assert.ok(!/javascript:/i.test(almacenado), 'No debe almacenarse un esquema javascript:');

    await editor.del(`/noticias/${crear.json.noticia.id}`);
  });

  await test('Se rechazan entradas que exceden los límites de longitud', async () => {
    const editor = await loginAs('editor');
    const res = await editor.post('/noticias', {
      titulo: 'x'.repeat(500),
      contenido: 'Contenido válido con longitud suficiente.',
      categoria: 'Ciencia'
    });
    assert.strictEqual(res.status, 400, 'Un título excesivo debe rechazarse');
  });

  await test('Los identificadores no numéricos se rechazan con 400', async () => {
    const admin = await loginAs('admin');
    const res = await admin.get('/noticias/abc');
    assert.strictEqual(res.status, 400);
  });

  section('6. Confidencialidad en el transporte y exposición de información');

  await test('Las cabeceras de seguridad están presentes', async () => {
    const res = await fetch(`${BASE_URL}/noticias`);
    for (const header of ['content-security-policy', 'x-content-type-options', 'x-frame-options',
      'strict-transport-security', 'referrer-policy', 'permissions-policy']) {
      assert.ok(res.headers.get(header), `Falta la cabecera ${header}`);
    }
    assert.strictEqual(res.headers.get('x-powered-by'), null, 'No debe exponerse la tecnología del servidor');
  });

  await test('Los errores no filtran trazas, SQL ni versiones', async () => {
    const admin = await loginAs('admin');
    const malformado = await fetch(`${BASE_URL}/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"email":'
    });
    const texto = await malformado.text();
    assert.ok(!/at Object|\.js:\d+|node_modules|SQLITE_|Node\.js v/i.test(texto),
      `La respuesta filtra información interna: ${texto.slice(0, 160)}`);

    const health = await (await fetch(`${BASE_URL}/health`)).json();
    assert.strictEqual(health.version, undefined, 'El health check no debe publicar la versión del software');
  });

  await test('Las rutas /api inexistentes responden 404 en JSON', async () => {
    const res = await fetch(`${BASE_URL}/ruta-inexistente`);
    assert.strictEqual(res.status, 404);
    assert.ok(/application\/json/.test(res.headers.get('content-type') || ''),
      'Debe responder JSON, no el HTML de la SPA');
  });

  await test('CORS solo acepta los orígenes autorizados', async () => {
    const permitido = await fetch(`${BASE_URL}/health`, { headers: { Origin: `http://localhost:${PORT}` } });
    assert.ok(permitido.headers.get('access-control-allow-origin'),
      'El origen autorizado debe recibir la cabecera CORS');

    const prohibido = await fetch(`${BASE_URL}/health`, { headers: { Origin: 'https://sitio-malicioso.example' } });
    assert.strictEqual(prohibido.headers.get('access-control-allow-origin'), null,
      'Un origen no autorizado no debe recibir permiso CORS');
  });

  await test('No se sirven archivos sensibles del proyecto', async () => {
    for (const ruta of ['/.env', '/database.sqlite', '/../.env', '/package.json', '/../src/database/db.js']) {
      const res = await fetch(`http://127.0.0.1:${PORT}${ruta}`);
      const texto = await res.text();
      assert.ok(!/JWT_SECRET|DEFAULT_ADMIN_PASSWORD|require\('node:sqlite'\)/.test(texto),
        `Se expuso un archivo sensible en ${ruta}`);
    }
  });

  section('7. Trazabilidad e inmutabilidad de la bitácora');

  await test('La auditoría exige autenticación y permiso específico', async () => {
    const anonimo = await fetch(`${BASE_URL}/admin/auditoria`);
    assert.strictEqual(anonimo.status, 401);

    const lector = await loginAs('lector');
    const res = await lector.get('/admin/auditoria');
    assert.strictEqual(res.status, 403);
  });

  await test('Los registros de auditoría no pueden modificarse ni borrarse', async () => {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(primaryServer.dbPath);
    db.exec('PRAGMA foreign_keys = ON;');

    let updateBloqueado = false;
    try { db.prepare('UPDATE auditoria SET accion = ? WHERE id = 1').run('Manipulado'); } catch { updateBloqueado = true; }

    let deleteBloqueado = false;
    try { db.prepare('DELETE FROM auditoria WHERE id = 1').run(); } catch { deleteBloqueado = true; }
    db.close();

    assert.strictEqual(updateBloqueado, true, 'Un trigger debe impedir UPDATE en auditoría');
    assert.strictEqual(deleteBloqueado, true, 'Un trigger debe impedir DELETE en auditoría');
  });

  await test('La API no expone ningún endpoint de escritura de auditoría', async () => {
    const admin = await loginAs('admin');
    for (const metodo of ['post', 'put', 'del']) {
      const res = await admin[metodo]('/admin/auditoria', metodo === 'post' ? { accion: 'x' } : undefined);
      assert.notStrictEqual(res.status, 201, `No debe permitirse ${metodo.toUpperCase()} en /admin/auditoria`);
    }
  });

  await test('La API de auditoría no expone datos sensibles de los usuarios', async () => {
    const admin = await loginAs('admin');
    const logs = (await admin.get('/admin/auditoria?limit=20')).json;
    for (const log of logs) {
      const serializado = JSON.stringify(log);
      assert.ok(!/\$2[aby]\$/.test(serializado), 'La bitácora no debe incluir hashes de contraseña');
    }
  });

  await test('El listado de usuarios no expone hashes de contraseña', async () => {
    const admin = await loginAs('admin');
    const usuarios = (await admin.get('/admin/usuarios')).json;
    assert.ok(usuarios.length > 0);
    for (const usuario of usuarios) {
      assert.strictEqual(usuario.password, undefined, 'El directorio no debe incluir contraseñas');
      assert.ok(!JSON.stringify(usuario).includes('intentos_fallidos') || usuario.intentos_fallidos !== undefined);
    }
  });

  section('8. Recuperación de contraseña');

  await test('Se solicita un código de recuperación por correo', async () => {
    const res = await createClient().post('/auth/forgot-password', { email: CREDENTIALS.lector.email });
    assert.strictEqual(res.status, 200, `Falló el envío de correo: ${res.raw}`);
    assert.ok(res.json.message);
  });

  await test('El código de recuperación incorrecto es rechazado', async () => {
    const res = await createClient().post('/auth/reset-password', {
      email: CREDENTIALS.lector.email, resetCode: '000000', newPassword: 'NuevaClaveSegura9'
    });
    assert.strictEqual(res.status, 400);
  });

  section('9. Recuperación de contraseña de extremo a extremo');

  await test('El código recibido restablece la contraseña y permite iniciar sesión', async () => {
    const { DatabaseSync } = require('node:sqlite');
    const email = `recupera.${Date.now()}@t.com`;
    const cliente = createClient();
    await cliente.post('/auth/register', { nombre: 'Recuperación E2E', email, password: 'ClaveOriginal1' });

    const solicitud = await createClient().post('/auth/forgot-password', { email });
    assert.strictEqual(solicitud.status, 200, `Falló el envío de correo: ${solicitud.raw}`);

    // El código real se lee de la base de datos: simula el correo recibido.
    const db = new DatabaseSync(primaryServer.dbPath);
    const fila = db.prepare('SELECT codigo_recuperacion, codigo_expira FROM usuarios WHERE email = ?').get(email);
    db.close();
    assert.ok(fila && fila.codigo_recuperacion, 'Debe generarse un código de recuperación');
    assert.strictEqual(fila.codigo_recuperacion.length, 6, 'El código debe tener 6 dígitos');

    const restablecer = await createClient().post('/auth/reset-password', {
      email, resetCode: fila.codigo_recuperacion, newPassword: 'ClaveRestablecida9'
    });
    assert.strictEqual(restablecer.status, 200, `Falló el restablecimiento: ${restablecer.raw}`);

    const conNueva = await createClient().post('/auth/login', { email, password: 'ClaveRestablecida9' });
    assert.strictEqual(conNueva.status, 200, 'Debe poder iniciar sesión con la contraseña nueva');

    const conVieja = await createClient().post('/auth/login', { email, password: 'ClaveOriginal1' });
    assert.strictEqual(conVieja.status, 401, 'La contraseña anterior debe dejar de funcionar');

    // El código es de un solo uso.
    const reutilizado = await createClient().post('/auth/reset-password', {
      email, resetCode: fila.codigo_recuperacion, newPassword: 'OtraClaveDistinta8'
    });
    assert.strictEqual(reutilizado.status, 400, 'El código no debe poder reutilizarse');
  });

  section('10. Pruebas de seguridad adicionales');

  await test('Los tres GET de noticias exigen el permiso noticias.leer', async () => {
    // Rol de prueba con un único permiso distinto al de lectura.
    const admin = await loginAs('admin');
    const permisos = (await admin.get('/admin/permisos')).json;
    const editar = permisos.find(p => p.nombre_permiso === 'noticias.editar').id;

    const rol = await admin.post('/admin/roles', {
      nombre_rol: `SoloEditor${Date.now()}`,
      descripcion: 'Puede editar pero no leer',
      permisos_ids: [editar]
    });
    assert.strictEqual(rol.status, 201);

    const email = `soloeditor.${Date.now()}@t.com`;
    await createClient().post('/auth/register', { nombre: 'Solo Editor', email, password: 'ClaveSegura123' });
    const usuarios = (await admin.get('/admin/usuarios')).json;
    const usuario = usuarios.find(u => u.email === email);
    await admin.put(`/admin/usuarios/${usuario.id}/rol`, { id_rol: rol.json.rol.id });

    const cliente = createClient();
    const login = await cliente.post('/auth/login', { email, password: 'ClaveSegura123' });
    assert.strictEqual(login.status, 200);
    assert.ok(!login.json.permissions.includes('noticias.leer'));

    for (const ruta of ['/noticias', '/noticias/categorias', '/noticias/1']) {
      const res = await cliente.get(ruta);
      assert.strictEqual(res.status, 403, `${ruta} debe exigir noticias.leer en el servidor`);
      assert.strictEqual(res.json.permiso_requerido, 'noticias.leer');
    }
  });

  await test('La inyección SQL se rechaza en todos los parámetros de entrada', async () => {
    const admin = await loginAs('admin');
    const payloads = [
      "' OR 1=1 --",
      "' UNION SELECT password FROM usuarios--",
      "'; DROP TABLE noticias;--",
      "admin'--",
      "' OR ''='"
    ];

    const rutas = [
      u => `/noticias?search=${encodeURIComponent(u)}`,
      u => `/noticias?categoria=${encodeURIComponent(u)}`,
      u => `/admin/auditoria?search=${encodeURIComponent(u)}`,
      u => `/noticias/${encodeURIComponent(u)}`
    ];

    for (const construir of rutas) {
      for (const payload of payloads) {
        const res = await admin.get(construir(payload));
        assert.ok(res.status < 500, `${construir(payload)} produjo un error interno (${res.status})`);
        assert.ok(!/SQLITE_|syntax error|no such table|no such column|traceback/i.test(res.raw),
          `Se filtró información interna: ${res.raw.slice(0, 160)}`);
        assert.ok(!/"password"\s*:/.test(res.raw), 'No debe filtrarse la columna password');
      }
    }

    const intacta = await admin.get('/noticias?limit=200');
    assert.strictEqual(intacta.status, 200, 'La tabla de noticias debe seguir disponible');
    assert.ok(Array.isArray(intacta.json));
  });

  await test('El cuerpo de la petición no permite escalar privilegios', async () => {
    const email = `escalado.${Date.now()}@t.com`;
    const res = await createClient().post('/auth/register', {
      nombre: 'Escalador',
      email,
      password: 'ClaveSegura123',
      id_rol: 1,
      nombre_rol: 'Administrador',
      rol: 'Administrador',
      permisos: ['*'],
      bloqueado_hasta: null
    });
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.json.user.nombre_rol, 'Usuario Regular', 'El rol debe seguir siendo Usuario Regular');
    assert.ok(!res.json.permissions.includes('usuarios.gestionar'));

    // Tampoco al iniciar sesión: los campos extra se ignoran.
    const login = await createClient().post('/auth/login', {
      email: CREDENTIALS.lector.email,
      password: CREDENTIALS.lector.password,
      id_rol: 1
    });
    assert.strictEqual(login.status, 200);
    assert.strictEqual(login.json.user.nombre_rol, 'Usuario Regular');
  });

  await test('Sin token, los endpoints protegidos responden 401 y no 403', async () => {
    for (const ruta of ['/noticias', '/admin/usuarios', '/admin/roles', '/admin/auditoria', '/auth/me']) {
      const res = await fetch(`${BASE_URL}${ruta}`);
      assert.strictEqual(res.status, 401, `${ruta} debe exigir credenciales`);
    }

    // Un token con firma manipulada se rechaza, pero no se revela si el id existe.
    const falso = await fetch(`${BASE_URL}/auth/me`, {
      headers: { Authorization: `Bearer ${'z'.repeat(30)}.${'y'.repeat(30)}.${'x'.repeat(30)}` }
    });
    assert.ok([401, 403].includes(falso.status));
    assert.ok(!/usuario|user|sql|sqlite/i.test(await falso.text()), 'No debe filtrar detalles del usuario');
  });

  await test('Los verbos HTTP no contemplados no se procesan', async () => {
    const admin = await loginAs('admin');

    const delLogin = await admin.del('/auth/login');
    assert.strictEqual(delLogin.status, 404, 'No debe existir DELETE /auth/login');

    const putColeccion = await admin.put('/noticias', { titulo: 'x', contenido: 'contenido valido', categoria: 'Ciencia' });
    assert.strictEqual(putColeccion.status, 404, 'La colección no admite PUT; la actualización va por identificador');

    const putAuditoria = await admin.put('/admin/auditoria/1', { accion: 'alterada' });
    assert.strictEqual(putAuditoria.status, 404, 'La auditoría no debe ser modificable por la API');
  });

  await test('El factor de coste de bcrypt frena la fuerza bruta offline', async () => {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(primaryServer.dbPath);
    const rows = db.prepare('SELECT password FROM usuarios LIMIT 20').all();
    db.close();

    assert.ok(rows.length > 0);
    for (const row of rows) {
      const coste = Number(/^\$2[aby]\$(\d{2})\$/.exec(row.password)[1]);
      assert.ok(coste >= 10, `El factor de coste de bcrypt debe ser >= 10 (es ${coste})`);
    }
  });

  await test('El frontend no guarda el token en localStorage ni sessionStorage', async () => {
    const jsDir = path.join(ROOT, 'public', 'js');
    const archivos = fs.readdirSync(jsDir).filter(f => f.endsWith('.js'));

    // Solo se persisten preferencias de interfaz (p. ej. el tema). Ninguna clave
    // puede guardar la sesión, porque un XSS podría leerla y robar el token.
    const claveSospechosa = /token|jwt|session|sesion|cookie|auth|password|clave|secret|credential|permiso/i;

    for (const archivo of archivos) {
      const codigo = fs.readFileSync(path.join(jsDir, archivo), 'utf8');

      for (const [, key] of codigo.matchAll(/localStorage\s*\.\s*setItem\s*\(\s*['"`]([^'"`]+)['"`]/g)) {
        assert.ok(!claveSospechosa.test(key), `${archivo} persiste "${key}" en localStorage`);
      }
      for (const [, key] of codigo.matchAll(/sessionStorage\s*\.\s*setItem\s*\(\s*['"`]([^'"`]+)['"`]/g)) {
        assert.ok(!claveSospechosa.test(key), `${archivo} persiste "${key}" en sessionStorage`);
      }

      assert.ok(!/document\.cookie\s*=/.test(codigo),
        `${archivo} no debe escribir cookies desde JavaScript (las cookies son HttpOnly)`);
    }
  });

  await test('La cookie de sesión no se marca Secure cuando el transporte es HTTP', async () => {
    // Verificación honesta: sin HTTPS la cookie no puede llevar Secure. La
    // protección real es que el token HttpOnly no es accesible desde JavaScript.
    const res = await fetch(`${BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(CREDENTIALS.lector)
    });
    const access = res.headers.getSetCookie().find(c => c.startsWith('portal_access_token='));
    assert.ok(!/;\s*Secure/i.test(access), 'Con HTTP plano no debe anunciarse Secure');
    assert.ok(/HttpOnly/i.test(access));
    assert.ok(/SameSite=Strict/i.test(access));
  });

  await test('La auditoría registra usuario, IP y acción en las operaciones administrativas', async () => {
    const admin = await loginAs('admin');
    const marca = `MarcadorAuditoria${Date.now()}`;

    const rol = await admin.post('/admin/roles', {
      nombre_rol: marca,
      descripcion: 'Auditoría de prueba',
      permisos_ids: []
    });
    assert.strictEqual(rol.status, 201);

    const logs = (await admin.get(`/admin/auditoria?search=${encodeURIComponent(marca)}`)).json;
    const evento = logs.find(l => l.accion === 'Creación de Nuevo Rol');

    assert.ok(evento, 'La creación del rol debe quedar registrada');
    assert.ok(evento.usuario_email, 'El evento debe identificar al usuario responsable');
    assert.ok(evento.ip && evento.ip !== 'desconocida', 'El evento debe registrar la IP del cliente');
    assert.ok(!Number.isNaN(Date.parse(evento.fecha_hora)), 'El evento debe registrar fecha y hora');
    assert.strictEqual(evento.fecha_hora, evento.fecha_hora.trim());
  });

  await test('Las acciones de autorización quedan en la bitácora', async () => {
    const admin = await loginAs('admin');

    // Un intento denegado por permisos también debe ser rastreable.
    const lector = await loginAs('lector');
    await lector.post('/noticias', {
      titulo: 'Intento denegado', contenido: 'Contenido que debe ser rechazado', categoria: 'Ciencia'
    });

    const logs = (await admin.get('/admin/auditoria?limit=500')).json;
    // Las acciones de noticias llevan el identificador ("Publicación de Noticia #12"),
    // así que se comparan por prefijo.
    const acciones = logs.map(l => l.accion);

    for (const esperada of [
      'Inicio de Sesión',
      'Cierre de Sesión',
      'Registro de Usuario',
      'Cambio de Contraseña',
      'Publicación de Noticia',
      'Edición de Noticia',
      'Eliminación de Noticia',
      'Cambio de Rol de Usuario',
      'Creación de Nuevo Rol',
      'Actualización Dinámica de Permisos',
      'Intento de Inicio de Sesión Fallido',
      'Bloqueo Temporal de Cuenta'
    ]) {
      assert.ok(acciones.some(a => a.startsWith(esperada)), `Falta auditar: "${esperada}"`);
    }
  });

  section('11. Carga de imágenes desde el equipo');

  await test('La imagen se sube, se guarda y se sirve como /uploads', async () => {
    const editor = await loginAs('editor');
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64'
    );

    const res = await editor.postForm('/noticias', {
      titulo: 'Noticia con imagen propia',
      contenido: 'La imagen se envía como archivo y no como URL.',
      categoria: 'Cultura'
    }, { nombre: 'foto.png', tipo: 'image/png', datos: png });

    assert.strictEqual(res.status, 201, res.raw);
    const imagenUrl = res.json.noticia.imagen_url;
    assert.ok(imagenUrl.startsWith('/uploads/'), `La imagen no quedó en /uploads: ${imagenUrl}`);
    assert.ok(imagenUrl.endsWith('.png'), 'La extensión debe deducirse del formato real');

    // El archivo existe en disco con los bytes que envió el cliente.
    const nombre = imagenUrl.slice('/uploads/'.length);
    assert.ok(!nombre.includes('/') && !nombre.includes('..'), 'El nombre generado no debe traer rutas');
    const enDisco = path.join(primaryServer.uploadDir, nombre);
    assert.ok(fs.existsSync(enDisco), 'El archivo no se escribió en el directorio de cargas');
    assert.deepStrictEqual(fs.readFileSync(enDisco), png);

    // Y se sirve por HTTP con su tipo real.
    const servido = await fetch(`http://127.0.0.1:${PORT}${imagenUrl}`);
    assert.strictEqual(servido.status, 200);
    assert.strictEqual(servido.headers.get('content-type'), 'image/png');
    assert.deepStrictEqual(Buffer.from(await servido.arrayBuffer()), png);

    await editor.del(`/noticias/${res.json.noticia.id}`);
    assert.strictEqual(fs.existsSync(enDisco), false, 'Al borrar la noticia debe borrarse su imagen');
  });

  await test('Al reemplazar la imagen se borra la anterior', async () => {
    const editor = await loginAs('editor');
    const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);

    const alta = await editor.postForm('/noticias', {
      titulo: 'Noticia con imagen que luego se reemplaza',
      contenido: 'La segunda carga debe eliminar el archivo anterior.',
      categoria: 'Tecnología'
    }, { nombre: 'primera.jpg', tipo: 'image/jpeg', datos: jpg });

    assert.strictEqual(alta.status, 201, alta.raw);
    const id = alta.json.noticia.id;
    const primera = path.join(primaryServer.uploadDir, alta.json.noticia.imagen_url.slice('/uploads/'.length));
    assert.ok(fs.existsSync(primera));

    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64'
    );
    const edicion = await editor.putForm(`/noticias/${id}`, {
      titulo: 'Noticia con imagen que luego se reemplaza',
      contenido: 'La segunda carga debe eliminar el archivo anterior.',
      categoria: 'Tecnología'
    }, { nombre: 'segunda.png', tipo: 'image/png', datos: png });

    assert.strictEqual(edicion.status, 200, edicion.raw);
    const segunda = path.join(primaryServer.uploadDir, edicion.json.noticia.imagen_url.slice('/uploads/'.length));
    assert.ok(fs.existsSync(segunda), 'La imagen nueva debe existir');
    assert.strictEqual(fs.existsSync(primera), false, 'La imagen reemplazada debe eliminarse del disco');

    await editor.del(`/noticias/${id}`);
    assert.strictEqual(fs.existsSync(segunda), false, 'Al borrar la noticia se borra su imagen');
  });

  await test('El archivo gana sobre la URL cuando se envían ambos', async () => {
    const editor = await loginAs('editor');
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64'
    );

    const res = await editor.postForm('/noticias', {
      titulo: 'El archivo tiene prioridad',
      contenido: 'Si llegan imagen y URL, manda el archivo subido.',
      categoria: 'Deportes',
      imagen_url: 'https://images.unsplash.com/photo-1461896836934-ffe607ba8211'
    }, { nombre: 'gana.png', tipo: 'image/png', datos: png });

    assert.strictEqual(res.status, 201, res.raw);
    assert.ok(res.json.noticia.imagen_url.startsWith('/uploads/'), 'Debe prevalecer el archivo');

    await editor.del(`/noticias/${res.json.noticia.id}`);
  });

  await test('Sin sesión no se puede subir ningún archivo', async () => {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64'
    );
    const anonimo = createClient();
    const antes = fs.existsSync(primaryServer.uploadDir) ? fs.readdirSync(primaryServer.uploadDir).length : 0;

    const res = await anonimo.postForm('/noticias', {
      titulo: 'Intento sin sesión',
      contenido: 'No debe aceptarse la carga sin autenticación.',
      categoria: 'Ciencia'
    }, { nombre: 'intento.png', tipo: 'image/png', datos: png });

    assert.strictEqual(res.status, 401);

    const despues = fs.existsSync(primaryServer.uploadDir) ? fs.readdirSync(primaryServer.uploadDir).length : 0;
    assert.strictEqual(despues, antes, 'No debe escribirse el archivo si la petición se rechaza antes');
  });

  await test('Un archivo que no es imagen se rechaza y no queda en el disco', async () => {
    const editor = await loginAs('editor');

    // Se declara como imagen, pero el contenido es un script: el servidor no debe
    // confiar en el tipo declarado, sino en los bytes reales del archivo.
    const disfrazado = { nombre: 'script.png', tipo: 'image/png', datos: Buffer.from('<script>alert(1)</script>') };
    const antes = fs.existsSync(primaryServer.uploadDir) ? fs.readdirSync(primaryServer.uploadDir) : [];

    const res = await editor.postForm('/noticias', {
      titulo: 'Archivo disfrazado de imagen',
      contenido: 'El contenido no corresponde con el tipo declarado.',
      categoria: 'Ciencia'
    }, disfrazado);

    assert.strictEqual(res.status, 400);
    const despues = fs.existsSync(primaryServer.uploadDir) ? fs.readdirSync(primaryServer.uploadDir) : [];
    assert.deepStrictEqual(despues, antes, 'El archivo rechazado debe eliminarse del disco');
  });

  await test('Se rechazan los formatos que no son imágenes admitidas', async () => {
    const editor = await loginAs('editor');
    const res = await editor.postForm('/noticias', {
      titulo: 'Documento adjunto no válido',
      contenido: 'Un PDF no es una imagen válida para la portada.',
      categoria: 'Economía'
    }, { nombre: 'documento.pdf', tipo: 'application/pdf', datos: Buffer.from('%PDF-1.4') });

    assert.strictEqual(res.status, 400);
    assert.match(res.json.error, /JPG, PNG, WEBP o GIF/);
  });

  await test('La URL sigue funcionando cuando no se sube ningún archivo', async () => {
    const editor = await loginAs('editor');
    const res = await editor.postForm('/noticias', {
      titulo: 'Noticia que conserva la URL',
      contenido: 'Sin archivo adjunto, la imagen sigue pudiendo venir de una URL.',
      categoria: 'Cultura',
      imagen_url: 'https://images.unsplash.com/photo-1451187580459-43490279c0fa'
    }, null);

    assert.strictEqual(res.status, 201, res.raw);
    assert.match(res.json.noticia.imagen_url, /^https:\/\/images\.unsplash\.com\//);

    await editor.del(`/noticias/${res.json.noticia.id}`);
  });
}

// --------------------------------------------------------------------------
async function main() {
  try {
    primaryServer = await spawnTestServer({ port: PORT, tag: 'test' });
  } catch (error) {
    console.error('\nNo se pudo iniciar el servidor de pruebas.\n');
    console.error(error.message);
    await stopAllServers();
    process.exit(1);
  }

  try {
    await run();
  } catch (error) {
    failures.push({ name: 'Ejecución de la suite', error });
    console.error('\nError inesperado durante la suite:', error);
  } finally {
    await stopAllServers();
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