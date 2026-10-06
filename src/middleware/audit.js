const db = require('../database/db');
const net = require('net');

/**
 * Registra una acción en la tabla de auditoría.
 * La escritura es append-only: los triggers de SQLite impiden UPDATE y DELETE.
 * @param {number|null} id_usuario - ID del usuario responsable (o null si es anónimo)
 * @param {string} accion - Título o descripción breve de la acción
 * @param {string} detalles - Información contextual o técnica adicional
 * @param {string} ip - Dirección IP del cliente
 */
function logAudit(id_usuario, accion, detalles = '', ip = 'desconocida') {
  try {
    const stmt = db.prepare(`
      INSERT INTO auditoria (id_usuario, accion, detalles, ip, fecha_hora)
      VALUES (?, ?, ?, ?, ?)
    `);
    const now = new Date().toISOString();
    stmt.run(id_usuario || null, accion, detalles, ip, now);
  } catch (error) {
    console.error('Error al registrar auditoría:', error.message);
  }
}

/**
 * Extrae la dirección IP real del cliente para la trazabilidad.
 *
 * Solo se toma en cuenta X-Forwarded-For si el servidor opera detrás de un proxy
 * de confianza (TRUST_PROXY=true); de lo contrario el cliente podría falsificar
 * la IP registrada en la bitácora. En cualquier caso se devuelve únicamente una
 * dirección IPv4/IPv6 sintácticamente válida.
 */
function getClientIp(req) {
  if (process.env.TRUST_PROXY === 'true') {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
      const first = String(forwarded).split(',')[0].trim();
      if (net.isIP(first)) return first;
    }
  }
  const remote = req.socket && req.socket.remoteAddress;
  return net.isIP(remote) ? remote : 'desconocida';
}

module.exports = {
  logAudit,
  getClientIp
};