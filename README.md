# Portal de Noticias UNACH

Aplicación web con autenticación y autorización por roles y permisos (RBAC
dinámico), separada en frontend y backend con API REST protegida con JWT.

## Requisitos

- [Node.js](https://nodejs.org/) v22 o superior (usa `node:sqlite`)
- npm (viene incluido con Node.js)
- OpenSSL, solo si quieres levantar el servidor sobre HTTPS

## Instalación

```bash
# 1. Clonar el repositorio
git clone https://github.com/martinoli4k/Portal-de-Noticias-UNACH.git
cd Portal-de-Noticias-UNACH

# 2. Instalar dependencias
npm install

# 3. Generar el par de llaves RSA para firmar los JWT (RS256)
npm run keys

# 4. Crear el archivo de configuración
cp .env.example .env      # Linux/macOS
copy .env.example .env    # Windows
```

Las llaves se escriben en `keys/jwt-private.pem` (modo `0600`) y
`keys/jwt-public.pem`. Esa carpeta está en `.gitignore`: **las llaves nunca se
suben al repositorio**. Para volver a generarlas (invalida todos los tokens ya
emitidos) usa `npm run keys -- --force`. Si las regeneras, las firmas de las
noticias ya guardadas dejan de validar: en desarrollo borra `database.sqlite`
para que el seed se cree y se firme con las llaves nuevas.

En `.env`, genera una llave simétrica propia para los datos cifrados y define las
contraseñas de los tres usuarios iniciales (`DEFAULT_*_PASSWORD`):

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Copia el resultado en `DATA_ENCRYPTION_KEY` (32 bytes en hexadecimal, 64
caracteres). Deja las rutas `JWT_PRIVATE_KEY_PATH=./keys/jwt-private.pem` y
`JWT_PUBLIC_KEY_PATH=./keys/jwt-public.pem`. La aplicación no arranca si falta
alguna de esas variables o si los archivos de llaves no existen.

## Ejecutar

```bash
npm run dev     # con recarga automática
npm start       # normal
```

Abre el navegador en http://localhost:3000

La base de datos SQLite se crea y se puebla sola en el primer arranque
(roles, permisos, usuarios y noticias de ejemplo).

## Pruebas

```bash
npm test            # todas las suites
npm run test:api    # API REST, RBAC y seguridad (62 pruebas)
npm run test:config # arranque, esquema, llaves y TLS (21 pruebas)
npm run test:crypto # AES-256-GCM y RSA-SHA256 (12 pruebas)
```

Las tres suites levantan el servidor en un proceso hijo con una base de datos
temporal y llaves RSA propias: no tocan tu `.env`, tus llaves ni tu base de datos.

## Demostración de criptografía

Con las llaves y `DATA_ENCRYPTION_KEY` configuradas:

```bash
npm run demo
```

El script muestra el RFC de un usuario de prueba en claro, el valor cifrado real
leído de la base de datos SQLite, el descifrado, y un token de acceso RS256 con
su encabezado, verificación con la llave pública y rechazo de una versión
alterada. Solo usa datos inventados.

Para el mecanismo asimétrico con una noticia **real** de la base de datos:

```bash
npm run demo:asimetrico
```

Muestra las dos llaves, el payload canónico, la firma guardada en
`noticias.firma_digital`, la verificación válida, la misma verificación tras
alterar el título y el rechazo de un token JWT manipulado. También puedes abrir
cualquier noticia en la interfaz y usar los botones “Verificar Firma con Llave
Pública” y “Probar Detección de Alteración”.

Si prefieres un ejemplo mínimo, sin base de datos y en el mismo formato que la
demo del perfil (texto en claro → firma guardada → verificación), usa:

```bash
npm run demo:firma
```

## HTTPS

```bash
npm run certs    # genera un certificado autofirmado en ./certs
```

Después, en `.env`:

```
HTTPS_ENABLED=true
TLS_KEY_PATH=./certs/dev-key.pem
TLS_CERT_PATH=./certs/dev-cert.pem
```

El certificado es autofirmado, así que el navegador mostrará un aviso; en un
despliegue real usa un certificado emitido por una autoridad certificadora.

## Recuperación de contraseña

Si no configuras `SMTP_USER` y `SMTP_PASS` en `.env`, la aplicación arranca en
**modo de prueba**: el correo se entrega de verdad a una cuenta de Ethereal y el
enlace de vista previa aparece en la consola del servidor. No hay que hacer nada
más.

## Arquitectura

```
public/            Frontend (HTML/CSS/JS). Todo el dato viene por fetch('/api/...')
scripts/           Utilidades: certificados TLS, llaves JWT y demo criptográfica
src/routes/        Rutas de la API REST
src/middleware/    Autenticación JWT, permisos, sanitización, rate limiting, auditoría, carga de imágenes
src/database/      Esquema y seed de SQLite
src/services/      Envío de correo
src/utils/         Cifrado AES-256-GCM y firma RSA-SHA256 de las noticias
keys/              Llaves RSA de los JWT. Se genera con npm run keys. No se versiona
storage/uploads/   Imágenes que sube el usuario al publicar. No se versiona
test/              Suites de pruebas
```

## Imagen de las noticias

Al redactar o editar una noticia, la imagen principal se puede tomar de dos
sitios: una URL (campo de texto) o un archivo del equipo (JPG, PNG, WEBP o GIF
de hasta 5 MB). Si llegan las dos, gana el archivo.

Los archivos se guardan en `storage/uploads`, fuera de `public`, y se sirven en
`/uploads`. El nombre y la extensión los decide el servidor, y los primeros
bytes del archivo se comparan con las firmas de cada formato: un `.png` que en
realidad es un script se rechaza y se borra del disco. Cuando una imagen se
reemplaza o la noticia se elimina, el archivo anterior también se borra.

## Seguridad implementada

- **Contraseñas**: bcrypt con salt (coste 12). El sanitizador nunca transforma un
  campo de credencial, de modo que la contraseña elegida es exactamente la que se
  guarda.
- **Tokens**: JWT firmados con **RS256** (RSA de 3072 bits, llave privada en
  `keys/`). El servidor verifica con la llave pública y `algorithms: ['RS256']`;
  un token con `alg: HS256` o con el payload alterado se rechaza con 401. Los
  refresh tokens son valores aleatorios rotatorios guardados en la base de datos
  y con detección de reutilización.
- **Cifrado de datos sensibles**: teléfono, RFC y dirección del perfil, y las
  notas confidenciales de las noticias, se guardan con **AES-256-GCM**
  (`src/utils/crypto.js`). El dato entra en claro, se cifra en el servidor y se
  almacena como `v1:<iv>:<tag>:<datos>`; solo se descifra al leerlo para el
  usuario autorizado. Cada operación usa un IV aleatorio nuevo y el tag GCM
  detecta cualquier alteración.
- **Almacenamiento del token**: cookies `HttpOnly` + `SameSite=Strict` (+ `Secure`
  sobre HTTPS). El token nunca se escribe en `localStorage`; en el cliente solo
  vive en memoria y se envía como `Authorization: Bearer <token>`.
- **RBAC real**: la autorización se resuelve contra la base de datos en cada
  petición, sin atajos por nombre de rol. Revocar un permiso a un rol surte efecto
  inmediato, y el sistema impide quedarse sin ningún permiso de administración.
- **Fuerza bruta**: bloqueo temporal de la cuenta tras 5 intentos fallidos (423) y
  rate limiting en los endpoints de autenticación (429).
- **Auditoría**: usuario, fecha y hora, IP y acción. Los triggers de SQLite
  bloquean `UPDATE` y `DELETE` sobre la bitácora, así que es inmutable incluso
  desde la propia base de datos.
- **Validación**: consultas parametrizadas, límites de longitud y saneado de
  XSS en servidor y cliente.
- **Carga de archivos**: solo después de autenticar y comprobar el permiso de
  publicación; con límite de tamaño, lista blanca de formatos, nombre generado
  por el servidor y verificación de los bytes reales del archivo. Lo que se
  rechaza no llega a escribirse en disco.
- **Transporte**: HTTPS configurable con validación del certificado antes de
  arrancar, CORS restringido a los orígenes autorizados y cabeceras de seguridad
  (CSP, HSTS, `X-Content-Type-Options`, `X-Frame-Options`).
- **Errores**: las respuestas al cliente nunca incluyen trazas, SQL ni versiones.
- **Secretos**: fuera del código fuente. La llave simétrica y las contraseñas
  iniciales viven en `.env` (no versionado); las llaves RSA viven en `keys/`
  (ignorada por git) y se generan con `npm run keys`. El servidor se niega a
  arrancar si falta `DATA_ENCRYPTION_KEY` o alguna de las llaves JWT.