const express = require('express');
const cors = require('cors');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
require('dotenv').config();

// Inicializar base de datos y migraciones
require('./src/database/db');

const authRoutes = require('./src/routes/auth.routes');
const newsRoutes = require('./src/routes/news.routes');
const adminRoutes = require('./src/routes/admin.routes');
const { generalLimiter } = require('./src/middleware/rateLimiter');
const { asegurarDirectorio, UPLOAD_DIR } = require('./src/middleware/upload');

const app = express();
const PORT = process.env.PORT || 3000;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const useHttps = process.env.HTTPS_ENABLED === 'true' || IS_PRODUCTION;

// Ocultar la firma de Express para prevenir divulgación de información
app.disable('x-powered-by');

// Configuración de Content-Security-Policy (CSP)
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com",
  "font-src 'self' https://fonts.gstatic.com https://cdnjs.cloudflare.com data:",
  "img-src 'self' data: https:",
  "connect-src 'self'",
  "form-action 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'"
].join('; ');

// Cabeceras de seguridad HTTP
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

// Configuración de CORS: solo los orígenes del frontend autorizados
const allowedOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map(o => o.trim()).filter(Boolean)
  : ['http://localhost:3000', 'http://127.0.0.1:3000'];

if (allowedOrigins.includes('*')) {
  throw new Error('CORS_ORIGIN no puede usar * cuando las credenciales están habilitadas');
}

app.use(cors({
  origin: (origin, callback) => {
    // Permitir solicitudes sin origin (clientes no navegador como curl o pruebas
    // de integración) o bien desde un origen expresamente autorizado.
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(null, false);
  },
  credentials: true
}));

app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: true, limit: '100kb' }));

// Servir frontend estático
app.use(express.static(path.join(__dirname, 'public')));

// Imágenes subidas por los usuarios al publicar noticias.
// Viven en storage/uploads, fuera de public, y se exponen solo por esta ruta.
app.use('/uploads', express.static(UPLOAD_DIR, {
  index: false,
  dotfiles: 'deny',
  maxAge: '7d'
}));

// Una imagen que no existe responde 404 aquí y no llega a la regla del SPA, que
// de lo contrario devolvería el HTML de la página donde el navegador espera bytes.
app.use('/uploads', (req, res) => {
  res.status(404).type('text/plain').send('Imagen no encontrada');
});

// Rate Limiter general para API
app.use('/api', generalLimiter);

// Rutas de API REST
app.use('/api/auth', authRoutes);
app.use('/api/noticias', newsRoutes);
app.use('/api/admin', adminRoutes);

// Endpoint de verificación de estado
app.get('/api/health', (req, res) => {
  res.json({
    status: 'OK',
    servicio: 'Portal de Noticias API',
    timestamp: new Date().toISOString()
  });
});

// Cualquier otra ruta de la API responde JSON 404 (no el HTML del SPA)
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Endpoint no encontrado' });
});

// Enrutamiento para SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Manejador global de errores
app.use((err, req, res, next) => {
  if (err) {
    if (err.type === 'entity.parse.failed' || err.status === 400 || err.status === 413) {
      return res.status(400).json({ error: 'Solicitud malformada o demasiado grande' });
    }
    console.error('[Error de Servidor]:', err.message);
  }
  res.status(500).json({ error: 'Ocurrió un error inesperado al procesar la solicitud' });
});

// Carga y validación de certificados TLS
function loadTlsOptions() {
  const keyPath = process.env.TLS_KEY_PATH;
  const certPath = process.env.TLS_CERT_PATH;

  const missing = [];
  if (!keyPath) missing.push('TLS_KEY_PATH');
  if (!certPath) missing.push('TLS_CERT_PATH');
  if (missing.length > 0) {
    throw new Error(
      `HTTPS está habilitado pero faltan las variables: ${missing.join(', ')}. `
      + 'Genera un certificado autofirmado de desarrollo con el script npm run certs o ajusta HTTPS_ENABLED=false.'
    );
  }

  if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
    const noExiste = [!fs.existsSync(keyPath) ? keyPath : null, !fs.existsSync(certPath) ? certPath : null]
      .filter(Boolean).join(' / ');
    throw new Error(
      `HTTPS está habilitado pero no se encuentra el certificado: ${noExiste}. `
      + 'Genera uno con el script npm run certs o ajusta HTTPS_ENABLED=false.'
    );
  }

  // Comprobación adicional con OpenSSL cuando está disponible (Windows lo
  // distribuye Git for Windows). Si no lo está, se avisa pero no se impide
  // arrancar: la existencia de los archivos ya es una garantía mínima.
  const { execFileSync } = require('child_process');
  const { resolveOpenSsl, opensslEnv } = require('./src/utils/openssl');
  try {
    execFileSync(resolveOpenSsl(), ['x509', '-in', certPath, '-noout'], { stdio: 'ignore', env: opensslEnv() });
  } catch {
    console.warn('[TLS] No fue posible validar el certificado con OpenSSL; se continúa con la verificación de existencia del archivo.');
  }

  return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
}

let server;
if (useHttps) {
  server = https.createServer(loadTlsOptions(), app);
} else {
  server = http.createServer(app);
}

// El directorio de imágenes debe existir antes de recibir la primera carga.
asegurarDirectorio();

server.listen(PORT, () => {
  const protocol = useHttps ? 'https' : 'http';
  console.log(`Servidor iniciado en ${protocol}://localhost:${PORT}`);
});