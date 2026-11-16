#!/usr/bin/env node
/**
 * Demostración del cifrado de datos sensibles (AES-256-GCM).
 *
 * Crea una base SQLite temporal —no toca database.sqlite— e inserta un usuario
 * inventado con teléfono, RFC y dirección en texto plano. Después guarda los
 * mismos datos cifrados y muestra, leyendo directamente de SQLite:
 *
 *   ANTES:   lo que vería cualquiera con acceso al archivo .sqlite
 *   DESPUÉS: el valor cifrado v1:<iv>:<tag>:<datos>
 *   APP:     el valor descifrado que devuelve la aplicación al dueño del perfil
 *
 * Uso:
 *   npm run demo:cifrado
 */
require('dotenv').config();

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { encrypt, decrypt } = require('../src/utils/crypto');

const ROOT = path.join(__dirname, '..');

const DATOS = {
  nombre: 'Ana Fernanda López Ruiz',
  email: 'ana.demo@example.edu.mx',
  telefono: '9611234567',
  rfc: 'LORA900101ABC',
  direccion: 'Av. Central 123, Col. Centro, Tuxtla Gutiérrez, Chiapas'
};

function linea(titulo = '') {
  const ancho = 72;
  if (!titulo) return console.log('─'.repeat(ancho));
  const relleno = Math.max(0, ancho - titulo.length - 3);
  console.log(`── ${titulo} ${'─'.repeat(relleno)}`);
}

function leerFila(db) {
  return db.prepare('SELECT telefono, rfc, direccion FROM usuarios WHERE email = ?').get(DATOS.email);
}

function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-demo-cifrado-'));
  const dbPath = path.join(dir, 'demo.sqlite');
  const db = new DatabaseSync(dbPath);

  try {
    db.exec(fs.readFileSync(path.join(ROOT, 'src', 'database', 'schema.sql'), 'utf8'));
    db.prepare('INSERT INTO roles (nombre_rol) VALUES (?)').run('Usuario Regular');
    db.prepare(`
      INSERT INTO usuarios (nombre, email, password, id_rol, telefono, rfc, direccion)
      VALUES (?, ?, ?, 1, ?, ?, ?)
    `).run(DATOS.nombre, DATOS.email, 'hash-de-demostracion', DATOS.telefono, DATOS.rfc, DATOS.direccion);

    console.log('\nDemostración de cifrado AES-256-GCM — Portal de Noticias UNACH');
    console.log(`Base temporal: ${dbPath}\n`);

    linea('1. ANTES: texto plano en SQLite');
    const antes = leerFila(db);
    console.log(`  teléfono : ${antes.telefono}`);
    console.log(`  RFC      : ${antes.rfc}`);
    console.log(`  dirección: ${antes.direccion}`);

    // Se cifra cada campo con un IV nuevo. El texto plano nunca se guarda.
    db.prepare('UPDATE usuarios SET telefono = ?, rfc = ?, direccion = ? WHERE email = ?').run(
      encrypt(DATOS.telefono),
      encrypt(DATOS.rfc),
      encrypt(DATOS.direccion),
      DATOS.email
    );

    linea('2. DESPUÉS: lo que queda escrito en el archivo .sqlite');
    const despues = leerFila(db);
    console.log(`  teléfono : ${despues.telefono}`);
    console.log(`  RFC      : ${despues.rfc}`);
    console.log(`  dirección: ${despues.direccion}`);
    console.log('\n  Formato: v1:<iv_base64>:<tag_base64>:<datos_base64>');
    console.log('  Cada registro usa un IV aleatorio distinto y el tag autentica el dato.');

    linea('3. APP: descifrado solo al mostrarlo al usuario autorizado');
    console.log(`  teléfono : ${decrypt(despues.telefono)}`);
    console.log(`  RFC      : ${decrypt(despues.rfc)}`);
    console.log(`  dirección: ${decrypt(despues.direccion)}`);

    linea('4. Integridad: alterar un byte invalida la autenticación GCM');
    const partes = despues.telefono.split(':');
    const datos = partes[3];
    const primerCaracter = datos.charAt(0) === 'A' ? 'B' : 'A';
    const alterado = `${partes[0]}:${partes[1]}:${partes[2]}:${primerCaracter}${datos.slice(1)}`;
    try {
      decrypt(alterado);
      console.log('  ERROR: el dato alterado se descifró (no debería ocurrir)');
    } catch (error) {
      console.log(`  ✔ Rechazado: ${error.message}`);
    }

    linea();
    console.log('Los datos de esta demostración son inventados y la base se elimina al terminar.\n');
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main();
