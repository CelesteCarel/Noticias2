/**
 * Rutas de la API para Demostración y Auditoría Criptográfica
 * Portal de Noticias UNACH
 */

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const db = require('../database/db');
const { authenticateToken } = require('../middleware/auth');
const {
  encryptSymmetric,
  decryptSymmetric,
  signNews,
  verifyNewsSignature,
  getPublicKey,
  getPublicKeyFingerprint,
  buildCanonicalPayload,
  getSymmetricKey
} = require('../utils/crypto.service');

/**
 * GET /api/crypto/info
 * Especificaciones técnicas y metadatos del sistema criptográfico
 */
router.get('/info', (req, res) => {
  try {
    const pubKey = getPublicKey();
    const fingerprint = getPublicKeyFingerprint();

    res.json({
      sistema: 'Mecanismos Criptográficos - Portal de Noticias UNACH',
      mecanismo_1_simetrico: {
        nombre: 'Cifrado Simétrico en Reposo',
        algoritmo: 'AES-256-GCM (Galois/Counter Mode)',
        tamano_clave_bits: 256,
        tamano_iv_bytes: 12,
        tamano_auth_tag_bytes: 16,
        libreria: "node:crypto (OpenSSL 3 nativo de Node.js)",
        almacenamiento_llave: 'Variable de entorno CRYPTO_AES_KEY en archivo .env (no hardcodeada en el código fuente)',
        campos_protegidos: ['noticias.nota_confidencial (Fuentes reservadas e información sensible de investigación periodística)'],
        justificacion_tecnica: 'AES-256-GCM es el estándar moderno recomendado por el NIST y OWASP para cifrado autenticado (AEAD). Proporciona confidencialidad y previene ataques de manipulación o alteración de datos gracias a la etiqueta de autenticación (Auth Tag).'
      },
      mecanismo_2_asimetrico: {
        nombre: 'Firma Digital Asimétrica y Verificación de Integridad',
        algoritmo: 'RSA-SHA256 (PKCS#1 v1.5)',
        tamano_clave_bits: 2048,
        formato_llaves: 'PEM (PKCS#8 para Llave Privada, SPKI para Llave Pública)',
        libreria: "node:crypto (OpenSSL 3 nativo de Node.js)",
        almacenamiento_llaves: {
          privada: 'Archivo protegido certs/portal-private.pem con permisos de solo lectura para el servidor (ruta en PORTAL_PRIVATE_KEY_PATH)',
          publica: 'Archivo certs/portal-public.pem expuesto para verificación ciudadana y auditoría (ruta en PORTAL_PUBLIC_KEY_PATH)'
        },
        huella_digital_clave_publica_sha256: fingerprint,
        caso_de_uso: 'Firma digital de todas las noticias y comunicados oficiales. Garantiza autenticidad de la fuente, integridad del texto (detección inmediata de tampering) y no repudio.',
        justificacion_tecnica: 'La criptografía asimétrica permite que únicamente el servidor del portal posea la llave privada para estampar firmas, mientras que cualquier usuario, lector o auditor externo puede verificar matemáticamente la firma con la llave pública sin poner en riesgo la clave secreta.'
      }
    });
  } catch (error) {
    console.error('Error al obtener info criptográfica:', error);
    res.status(500).json({ error: 'Error al consultar especificaciones criptográficas' });
  }
});

/**
 * GET /api/crypto/public-key
 * Descarga o visualización de la llave pública RSA del portal
 */
router.get('/public-key', (req, res) => {
  try {
    const pubKey = getPublicKey();
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(pubKey);
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener clave pública' });
  }
});

/**
 * POST /api/crypto/demo-symmetric
 * Demostración interactiva en vivo del cifrado y descifrado simétrico AES-256-GCM
 */
router.post('/demo-symmetric', (req, res) => {
  const { texto } = req.body;
  if (!texto || typeof texto !== 'string') {
    return res.status(400).json({ error: 'El campo "texto" es obligatorio' });
  }

  try {
    const key = getSymmetricKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    
    let encrypted = cipher.update(texto, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag();

    const formattedPayload = `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
    const decrypted = decryptSymmetric(formattedPayload);

    res.json({
      entrada_texto_plano: texto,
      algoritmo: 'AES-256-GCM',
      detalles_cifrado: {
        vector_inicializacion_iv_hex: iv.toString('hex'),
        iv_longitud_bytes: iv.length,
        etiqueta_autenticacion_tag_hex: authTag.toString('hex'),
        tag_longitud_bytes: authTag.length,
        texto_cifrado_hex: encrypted,
        empaquetado_en_base_de_datos: formattedPayload
      },
      descifrado_posterior: {
        resultado_descifrado: decrypted,
        coincide_con_original: decrypted === texto
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Error en demo simétrica: ' + error.message });
  }
});

/**
 * POST /api/crypto/verify-news
 * Verifica en tiempo real la firma digital asimétrica de una noticia
 */
router.post('/verify-news', (req, res) => {
  const { id_noticia, titulo, contenido, categoria, id_autor, firma_digital } = req.body;

  try {
    let newsObj = { titulo, contenido, categoria, id_autor };

    // Si viene solo el id, lo buscamos en la base de datos
    if (id_noticia && (!titulo || !contenido)) {
      const row = db.prepare('SELECT id, titulo, contenido, categoria, id_autor, firma_digital, firma_fecha FROM noticias WHERE id = ?').get(id_noticia);
      if (!row) {
        return res.status(404).json({ error: 'Noticia no encontrada' });
      }
      newsObj = row;
    }

    const signatureToVerify = firma_digital || newsObj.firma_digital;
    const verification = verifyNewsSignature(newsObj, signatureToVerify);
    const canonical = buildCanonicalPayload(newsObj);

    res.json({
      valida: verification.valid,
      algoritmo: 'RSA-SHA256 (2048 bits)',
      payload_canonico: canonical,
      huella_clave_publica: getPublicKeyFingerprint(),
      mensaje: verification.valid
        ? '✅ FIRMA DIGITAL VÁLIDA: El documento es auténtico y su integridad está garantizada por la llave pública oficial de la UNACH.'
        : '❌ FIRMA INVÁLIDA: El contenido del documento ha sido adulterado o no coincide con la firma digital registrada.'
    });
  } catch (error) {
    res.status(500).json({ error: 'Error al verificar firma: ' + error.message });
  }
});

/**
 * POST /api/crypto/test-tampering
 * Simula una alteración intencional de datos para demostrar cómo la firma asimétrica la detecta
 */
router.post('/test-tampering', (req, res) => {
  const { id_noticia, texto_modificado } = req.body;

  try {
    const row = db.prepare('SELECT id, titulo, contenido, categoria, id_autor, firma_digital FROM noticias WHERE id = ?').get(id_noticia);
    if (!row) {
      return res.status(404).json({ error: 'Noticia no encontrada' });
    }

    // 1. Verificación original (debe ser válida)
    const verifOriginal = verifyNewsSignature(row, row.firma_digital);

    // 2. Verificación con contenido adulterado
    const contenidoAlterado = texto_modificado || (row.contenido + ' [TEXTO ADULTERADO / INYECCIÓN MALICIOSA]');
    const alteradoObj = { ...row, contenido: contenidoAlterado };
    const verifAlterada = verifyNewsSignature(alteradoObj, row.firma_digital);

    res.json({
      noticia_id: row.id,
      titulo: row.titulo,
      resultado_original: {
        contenido_preview: row.contenido.substring(0, 80) + '...',
        firma_valida: verifOriginal.valid,
        estado: 'DOCUMENTO ÍNTEGRO Y AUTÉNTICO'
      },
      resultado_con_tampering: {
        contenido_alterado_preview: contenidoAlterado.substring(0, 100) + '...',
        firma_valida: verifAlterada.valid,
        estado: verifAlterada.valid ? 'ERROR' : '🚨 ALTERACIÓN DETECTADA: La firma RSA no coincide con el nuevo contenido.'
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Error en prueba de alteración: ' + error.message });
  }
});

module.exports = router;
