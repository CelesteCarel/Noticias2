/**
 * Rutas de consulta y verificación criptográfica de noticias.
 *
 * El cifrado y la firma se realizan con los módulos centrales:
 *  - src/utils/crypto.js        → AES-256-GCM (DATA_ENCRYPTION_KEY)
 *  - src/utils/crypto.service.js → RSA-SHA256 con el par de llaves de los JWT
 *
 * No se expone ningún endpoint que cifre texto libre ni que genere llaves: la
 * demostración en vivo se hace con el perfil del usuario (PUT /auth/perfil) y
 * con scripts/demo-cripto.js.
 */

const express = require('express');
const router = express.Router();
const db = require('../database/db');
const {
  verifyNewsSignature,
  getPublicKey,
  getPublicKeyFingerprint,
  buildCanonicalPayload
} = require('../utils/crypto.service');

/**
 * GET /api/crypto/info
 * Especificaciones técnicas y metadatos del sistema criptográfico.
 */
router.get('/info', (req, res) => {
  try {
    res.json({
      sistema: 'Mecanismos Criptográficos - Portal de Noticias UNACH',
      mecanismo_1_simetrico: {
        nombre: 'Cifrado Simétrico en Reposo',
        algoritmo: 'AES-256-GCM (Galois/Counter Mode)',
        tamano_clave_bits: 256,
        tamano_iv_bytes: 12,
        tamano_auth_tag_bytes: 16,
        libreria: 'node:crypto (OpenSSL 3 nativo de Node.js)',
        almacenamiento_llave: 'Variable de entorno DATA_ENCRYPTION_KEY (no hardcodeada)',
        formato_almacenado: 'v1:<iv_base64>:<tag_base64>:<datos_base64>',
        campos_protegidos: [
          'usuarios.telefono',
          'usuarios.rfc',
          'usuarios.direccion',
          'noticias.nota_confidencial'
        ]
      },
      mecanismo_2_asimetrico: {
        nombre: 'Firma Digital Asimétrica y Verificación de Integridad',
        algoritmo: 'RS256 (RSA-SHA256)',
        tamano_clave_bits: 3072,
        formato_llaves: 'PEM (PKCS#8 para llave privada, SPKI para llave pública)',
        libreria: 'node:crypto + jsonwebtoken',
        almacenamiento_llaves: {
          privada: 'Archivo keys/jwt-private.pem (modo 0600, ruta en JWT_PRIVATE_KEY_PATH)',
          publica: 'Archivo keys/jwt-public.pem (ruta en JWT_PUBLIC_KEY_PATH)'
        },
        huella_digital_clave_publica_sha256: getPublicKeyFingerprint(),
        caso_de_uso: 'Firma de los tokens de acceso y de las noticias publicadas.'
      }
    });
  } catch (error) {
    console.error('Error al obtener info criptográfica:', error.message);
    res.status(500).json({ error: 'Error al consultar especificaciones criptográficas' });
  }
});

/**
 * GET /api/crypto/public-key
 * Llave pública RSA del portal, para verificar firmas.
 */
router.get('/public-key', (req, res) => {
  try {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(getPublicKey());
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener la llave pública' });
  }
});

/**
 * POST /api/crypto/verify-news
 * Verifica en tiempo real la firma digital de una noticia.
 */
router.post('/verify-news', (req, res) => {
  const { id_noticia, titulo, contenido, categoria, id_autor, firma_digital } = req.body;

  try {
    let newsObj = { titulo, contenido, categoria, id_autor };

    if (id_noticia && (!titulo || !contenido)) {
      const row = db.prepare(
        'SELECT id, titulo, contenido, categoria, id_autor, firma_digital, firma_fecha FROM noticias WHERE id = ?'
      ).get(id_noticia);
      if (!row) {
        return res.status(404).json({ error: 'Noticia no encontrada' });
      }
      newsObj = row;
    }

    const signatureToVerify = firma_digital || newsObj.firma_digital;
    const verification = verifyNewsSignature(newsObj, signatureToVerify);

    res.json({
      valida: verification.valid,
      algoritmo: 'RSA-SHA256 (3072 bits)',
      payload_canonico: buildCanonicalPayload(newsObj),
      huella_clave_publica: getPublicKeyFingerprint(),
      mensaje: verification.valid
        ? 'FIRMA DIGITAL VÁLIDA: el documento es auténtico y su integridad está garantizada.'
        : 'FIRMA INVÁLIDA: el contenido fue alterado o no coincide con la firma registrada.'
    });
  } catch (error) {
    res.status(500).json({ error: 'Error al verificar firma: ' + error.message });
  }
});

/**
 * POST /api/crypto/test-tampering
 * Simula una alteración del contenido para demostrar que RSA la detecta.
 */
router.post('/test-tampering', (req, res) => {
  const { id_noticia, texto_modificado } = req.body;

  try {
    const row = db.prepare(
      'SELECT id, titulo, contenido, categoria, id_autor, firma_digital FROM noticias WHERE id = ?'
    ).get(id_noticia);
    if (!row) {
      return res.status(404).json({ error: 'Noticia no encontrada' });
    }

    const verifOriginal = verifyNewsSignature(row, row.firma_digital);
    const contenidoAlterado = texto_modificado || (row.contenido + ' [TEXTO ADULTERADO / INYECCIÓN MALICIOSA]');
    const verifAlterada = verifyNewsSignature({ ...row, contenido: contenidoAlterado }, row.firma_digital);

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
        estado: verifAlterada.valid ? 'ERROR' : 'ALTERACIÓN DETECTADA: la firma RSA no coincide con el nuevo contenido.'
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Error en prueba de alteración: ' + error.message });
  }
});

module.exports = router;
