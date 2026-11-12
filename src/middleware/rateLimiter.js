/**
 * Middleware de Rate Limiting en memoria para protección contra ataques de fuerza bruta y DoS
 *
 * Los umbrales son configurables por variable de entorno para poder ajustarlos al
 * despliegue real sin tocar el código. Los valores por omisión son los pensados
 * para producción: que una suite de pruebas agote el límite no significa que el
 * límite haya dejado de funcionar.
 */

const ipRequestMap = new Map();

/**
 * Lee un entero positivo desde el entorno y, si no es válido, devuelve el
 * valor por omisión. Evita que un valor mal escrito deje el limiter inactivo.
 */
function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0) {
    console.warn(`[RateLimiter] ${name}="${raw}" no es un entero positivo; se usa ${fallback}.`);
    return fallback;
  }
  return value;
}

// Limpieza periódica de entradas viejas en memoria cada 10 minutos
setInterval(() => {
  const now = Date.now();
  for (const [key, data] of ipRequestMap.entries()) {
    if (now > data.resetTime) {
      ipRequestMap.delete(key);
    }
  }
}, 10 * 60 * 1000);

/**
 * Genera un middleware de limitación de tasa configurable
 * @param {number} maxRequests - Número máximo de peticiones permitidas en la ventana
 * @param {number} windowMs - Duración de la ventana de tiempo en milisegundos
 * @param {string} message - Mensaje de error al exceder el límite
 */
function createRateLimiter(maxRequests = 60, windowMs = 60 * 1000, message = 'Demasiadas solicitudes. Por favor, intenta más tarde.') {
  return (req, res, next) => {
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1';
    const key = `${req.baseUrl || ''}_${clientIp}`;
    const now = Date.now();

    let record = ipRequestMap.get(key);

    if (!record || now > record.resetTime) {
      record = {
        count: 1,
        resetTime: now + windowMs
      };
      ipRequestMap.set(key, record);
    } else {
      record.count += 1;
    }

    const remaining = Math.max(0, maxRequests - record.count);
    const retryAfterSeconds = Math.ceil((record.resetTime - now) / 1000);

    res.setHeader('X-RateLimit-Limit', maxRequests);
    res.setHeader('X-RateLimit-Remaining', remaining);
    res.setHeader('X-RateLimit-Reset', Math.ceil(record.resetTime / 1000));

    if (record.count > maxRequests) {
      res.setHeader('Retry-After', retryAfterSeconds);
      return res.status(429).json({
        error: message,
        retryAfter: `${retryAfterSeconds} segundos`
      });
    }

    next();
  };
}

// Limiter para rutas de autenticación (Login, Registro, Recuperación).
// Por omisión: 200 intentos en 10 minutos.
const authLimiter = createRateLimiter(
  envInt('RATE_LIMIT_AUTH_MAX', 200),
  envInt('RATE_LIMIT_AUTH_WINDOW_MS', 10 * 60 * 1000),
  'Has superado el límite de intentos de autenticación. Espera unos minutos antes de reintentar.'
);

// Limiter general para la API. Por omisión: 200 peticiones por minuto.
const generalLimiter = createRateLimiter(
  envInt('RATE_LIMIT_API_MAX', 200),
  envInt('RATE_LIMIT_API_WINDOW_MS', 60 * 1000),
  'Límite de solicitudes por minuto excedido.'
);

module.exports = {
  createRateLimiter,
  authLimiter,
  generalLimiter
};
