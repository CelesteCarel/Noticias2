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

# 3. Crear el archivo de configuración
cp .env.example .env      # Linux/macOS
copy .env.example .env    # Windows
```

En `.env` debes sustituir **como mínimo** los secretos, porque la aplicación se
niega a arrancar con los valores de ejemplo del archivo:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Genera dos valores distintos para `JWT_SECRET` y `JWT_REFRESH_SECRET`, y define
las contraseñas de los tres usuarios iniciales (`DEFAULT_*_PASSWORD`).

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
npm test            # las dos suites
npm run test:api    # API REST, RBAC y seguridad (59 pruebas)
npm run test:config # arranque, esquema, secretos y TLS (19 pruebas)
```

Ambas suites levantan el servidor en un proceso hijo con una base de datos
temporal y secretos propios: no tocan tu `.env` ni tu base de datos.

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
src/routes/        Rutas de la API REST
src/middleware/    Autenticación JWT, permisos, sanitización, rate limiting, auditoría, carga de imágenes
src/database/      Esquema y seed de SQLite
src/services/      Envío de correo
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
- **Tokens**: JWT HS256 de 15 minutos, con refresh tokens rotatorios y detección
  de reutilización. La firma, la expiración, el rol y los permisos se validan en
  el servidor en cada petición.
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
- **Secretos**: fuera del código fuente, en variables de entorno, y el servidor
  rechaza valores de ejemplo o de baja entropía.