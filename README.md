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
git clone https://github.com/CelesteCarel/Noticias2.git
cd Noticias2

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
npm run test:api    # API REST, RBAC y seguridad (65 pruebas)
npm run test:config # arranque, esquema, llaves, TLS y redirección (23 pruebas)
npm run test:crypto # AES-256-GCM, hash SHA-256 y RSA-SHA256 (15 pruebas)
npm run test:backup # respaldo, retención, orden, carpeta faltante y fallo de unidad (7 pruebas)
```

Las cuatro suites levantan el servidor o usan una base temporal: no tocan tu
`.env`, tus llaves ni tu base de datos.

## Respaldos (cada 24 horas a unidad externa)

El respaldo no detiene el servidor: `scripts/backup.js` usa `VACUUM INTO` para
crear una copia consistente de SQLite y después copia `storage/uploads`.

```bash
npm run backup
```

En `.env`:

```ini
BACKUP_DIR=E:\Respaldos\PortalNoticias        # Windows (USB o disco extraíble)
# BACKUP_DIR=/media/usb/portal-noticias       # Linux
BACKUP_RETENTION=7                            # conserva los últimos 7
# BACKUP_LOG_DIR=./logs                       # opcional
```

El archivo se llama `backup-2026-11-15_0300.sqlite` y las imágenes quedan en
`backup-2026-11-15_0300_uploads/`. Si dos ejecuciones caen en el mismo minuto se
añade un sufijo (`-2`, `-3`...) para no sobrescribir nada.

Si la unidad no está conectada, el script termina con código 1, escribe el
motivo en `logs/backup.log` y registra `Fallo de Respaldo` en la auditoría. La
aplicación sigue funcionando: el respaldo es un proceso independiente.

En Windows, si la unidad está conectada pero la carpeta de `BACKUP_DIR` todavía
no existe, el script la crea automáticamente. En Linux el punto de montaje debe
existir antes de ejecutar el respaldo, para no escribir sin avisar en el disco
local cuando la USB no está montada.

Cada ejecución correcta registra `Respaldo de Base de Datos` en la bitácora.

### Programar en Windows (Programador de tareas / schtasks)

Abre PowerShell **como administrador** y ajusta la ruta del proyecto:

```bat
schtasks /Create /TN "PortalNoticias-Backup" /SC DAILY /ST 03:00 ^
  /TR "cmd /c cd /d C:\ruta\Noticias2 && npm run backup" ^
  /RU "USUARIO" /RP * /RL HIGHEST /F
```

- `/RU "USUARIO" /RP *` pide la contraseña de esa cuenta. Debe ser una cuenta
  con acceso a la letra de unidad de la USB (una tarea como `SYSTEM` no ve las
  unidades asignadas al usuario).
- Comprueba la tarea: `schtasks /Query /TN "PortalNoticias-Backup" /V /FO LIST`
- Ejecútala ahora: `schtasks /Run /TN "PortalNoticias-Backup"`
- Elimínala: `schtasks /Delete /TN "PortalNoticias-Backup" /F`

También puedes hacerlo desde la interfaz: *Programador de tareas → Crear tarea
básica → Diariamente → 03:00 → Iniciar un programa → `cmd.exe`* con los
argumentos `/c cd /d C:\ruta\Noticias2 && npm run backup`.

### Programar en Linux (cron)

```bash
crontab -e
```

```cron
# Todos los días a las 03:00
0 3 * * * cd /opt/noticias2 && /usr/bin/npm run backup >> /var/log/portal-noticias-backup.log 2>&1
```

Si la unidad se monta en `/media/usb/portal-noticias`, añádela a `/etc/fstab`
con `nofail` para que el arranque no se bloquee cuando no esté conectada. El
script falla con un mensaje claro si el punto de montaje no existe.

### Restaurar un respaldo

1. Detén el servicio (`pm2 stop portal-noticias`, `systemctl stop portal-noticias`
   o el servicio de NSSM).
2. Conserva la base actual por si acaso:
   `copy database.sqlite database.sqlite.antes` (Windows) o
   `cp database.sqlite database.sqlite.antes` (Linux).
3. Copia el respaldo elegido sobre `database.sqlite`.
4. Copia el contenido de `backup-..._uploads/` dentro de `storage/uploads/`.
5. Verifica permisos: el usuario del servicio debe poder leer y escribir la base
   y el directorio de imágenes.
6. Arranca el servicio y comprueba `GET /api/health`, el login y que las imágenes
   se sirven en `/uploads/...`.

Los respaldos incluyen la tabla de auditoría tal como estaba en ese momento. Los
triggers de inmutabilidad impiden alterarla después de restaurar.

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

Para ver el cifrado de los datos de perfil directamente contra SQLite (registro
"antes" en texto plano, "después" cifrado y descifrado en la app):

```bash
npm run demo:cifrado
```

## HTTPS

```bash
npm run certs    # genera un certificado autofirmado en ./certs
```

El certificado incluye por defecto `localhost`, `127.0.0.1` y
`192.168.188.10` como Subject Alternative Name. Para la IP real de la VM:

```bash
npm run certs -- --ip 192.168.188.10 --force
# varios nombres o IPs:
npm run certs -- --ip 192.168.188.10 --host portal.unach.local --force
```

Después, en `.env`:

```
HTTPS_ENABLED=true
TLS_KEY_PATH=./certs/dev-key.pem
TLS_CERT_PATH=./certs/dev-cert.pem
HTTP_REDIRECT_PORT=3080
```

Con `HTTP_REDIRECT_PORT` definido, `http://IP:3080/...` responde `308` hacia
`https://IP:3000/...` conservando el método y el cuerpo. Es opcional; si no se
define, solo se abre el puerto HTTPS.

El certificado es autofirmado, así que el navegador mostrará un aviso la primera
vez. Al incluir la IP en el SAN, el aviso se limita a "certificado no emitido por
una autoridad de confianza"; en un despliegue real usa un certificado emitido por
una CA (por ejemplo, Let's Encrypt con un nombre DNS válido).

## Correo real para recuperación (Gmail u otro SMTP)

Sin `SMTP_USER`/`SMTP_PASS` la aplicación usa Ethereal en modo prueba: el correo
se envía de verdad a una bandeja temporal y el enlace de vista previa aparece en
la consola del servidor. Para Gmail:

1. Activa la verificación en dos pasos en la cuenta de Google.
2. Entra en *Cuenta de Google → Seguridad → Contraseñas de aplicaciones*.
3. Crea una contraseña de aplicación (16 caracteres) para "Correo".
4. En `.env`:

```ini
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=tu_correo@gmail.com
SMTP_PASS=abcd efgh ijkl mnop
EMAIL_FROM="Portal de Noticias UNACH" <no-reply@portalnoticias.edu.mx>
```

No uses la contraseña normal de Gmail ni la guardes en el repositorio. Para otro
proveedor cambia `SMTP_HOST`, `SMTP_PORT` y `SMTP_SECURE` (465 suele requerir
`SMTP_SECURE=true`).

`forgot-password` responde siempre el mismo mensaje exista o no el correo. Un
fallo del transporte también devuelve la respuesta genérica y queda en la
auditoría y en la consola del servidor, para no revelar qué cuentas existen.

## Recuperación de contraseña

Si no configuras `SMTP_USER` y `SMTP_PASS` en `.env`, la aplicación arranca en
**modo de prueba**: el correo se entrega de verdad a una cuenta de Ethereal y el
enlace de vista previa aparece en la consola del servidor. No hay que hacer nada
más.

## Despliegue en servidor (red Intermedia de OPNsense)

La aplicación se publica **solo** en la red Intermedia. No abras el puerto 3000
hacia WAN.

### 1. Instalar Node.js 22 o superior

- **Windows**: instala el MSI de [nodejs.org](https://nodejs.org/) o usa
  `winget install OpenJS.NodeJS.LTS`. Verifica con `node -v` y `npm -v`.
- **Linux (Debian/Ubuntu)**:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs build-essential
node -v
```

### 2. Clonar e instalar

```bash
git clone https://github.com/CelesteCarel/Noticias2.git
cd Noticias2
npm install
npm run keys
cp .env.example .env      # Linux/macOS
copy .env.example .env    # Windows
```

Edita `.env`: `DATA_ENCRYPTION_KEY`, `DEFAULT_*_PASSWORD`, `CORS_ORIGIN` con la
IP real (`https://192.168.188.10:3000`), `BACKUP_DIR`, y los datos SMTP si vas a
enviar correos reales. Genera el certificado con la IP de la VM:

```bash
npm run certs -- --ip 192.168.188.10 --force
```

y activa `HTTPS_ENABLED=true`, `TLS_KEY_PATH`, `TLS_CERT_PATH` y, si quieres
redirección, `HTTP_REDIRECT_PORT=3080`.

### 3. Abrir el puerto en la VM y en OPNsense

- **Windows Defender Firewall** (PowerShell como administrador):

```powershell
New-NetFirewallRule -DisplayName "Portal Noticias HTTPS" -Direction Inbound `
  -Protocol TCP -LocalPort 3000 -Action Allow -Profile Private
New-NetFirewallRule -DisplayName "Portal Noticias HTTP redirect" -Direction Inbound `
  -Protocol TCP -LocalPort 3080 -Action Allow -Profile Private
```

- **Linux con ufw**:

```bash
sudo ufw allow 3000/tcp
sudo ufw allow 3080/tcp   # solo si usas HTTP_REDIRECT_PORT
```

- **OPNsense**: en *Firewall → Rules → Intermedia* crea una regla
  `Pass` con protocolo `TCP`, origen `Intermedia net` (o la subred de clientes),
  destino `192.168.188.10`, puerto `3000` (y `3080` si rediriges). No crees una
  regla equivalente en WAN. Si publicas por nombre, añade el DNS interno.

### 4. Dejar la app como servicio

**Linux con systemd** (`/etc/systemd/system/portal-noticias.service`):

```ini
[Unit]
Description=Portal de Noticias UNACH
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/noticias2
EnvironmentFile=/opt/noticias2/.env
ExecStart=/usr/bin/node --no-warnings server.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now portal-noticias
sudo systemctl status portal-noticias
```

**Linux o Windows con pm2**:

```bash
npm install -g pm2
pm2 start server.js --name portal-noticias
pm2 save
pm2 startup        # sigue la instrucción que imprime para el arranque automático
```

En Windows, `pm2 startup` requiere privilegios de administrador. Como alternativa
nativa usa **NSSM**:

```bat
nssm install PortalNoticias "C:\Program Files\nodejs\node.exe" "C:\ruta\Noticias2\server.js"
nssm set PortalNoticias AppDirectory "C:\ruta\Noticias2"
nssm set PortalNoticias AppEnvironmentExtra NODE_ENV=production
nssm start PortalNoticias
```

### 5. Verificar

Desde un cliente de la red Intermedia:

```bash
curl -k https://192.168.188.10:3000/api/health
```

Debe responder `{"status":"OK",...}`. Abre `https://192.168.188.10:3000` en el
navegador, inicia sesión con el administrador y comprueba el panel y la auditoría.

### Checklist de configuración en el servidor

Lo que se configura en un equipo de desarrollo no se copia a la VM. En el
servidor hay que rehacer estos puntos:

- [ ] `.env` propio del servidor, creado desde `.env.example` y **nunca** subido
      al repositorio.
- [ ] `DATA_ENCRYPTION_KEY` nueva (64 hex) y contraseñas iniciales distintas.
- [ ] `npm run keys` para generar el par RSA de los JWT.
- [ ] `npm run certs -- --ip 192.168.188.10 --force` y comprobar el SAN:
      `openssl x509 -in certs/dev-cert.pem -noout -text | grep -A1 "Subject Alternative Name"`.
- [ ] `HTTPS_ENABLED=true`, `TLS_KEY_PATH=./certs/dev-key.pem` (la **llave**, no el
      certificado) y `TLS_CERT_PATH=./certs/dev-cert.pem`.
- [ ] `CORS_ORIGIN=https://192.168.188.10:3000` (y el nombre DNS si se usa).
- [ ] `SMTP_*` con la contraseña de aplicación de Gmail escrita directamente en
      el `.env` del servidor. No se comparte por chat ni por correo.
- [ ] `BACKUP_DIR` apuntando a la unidad externa de esa máquina (por ejemplo
      `E:\respaldos`) y la tarea `schtasks` programada con esa misma ruta.
- [ ] Reglas de firewall en la VM y en OPNsense para el puerto 3000 (y 3080 si
      hay redirección).

## Arquitectura

```
public/            Frontend (HTML/CSS/JS). Todo el dato viene por fetch('/api/...')
scripts/           Utilidades: respaldo, certificados TLS, llaves JWT y demos criptográficas
src/routes/        Rutas de la API REST
src/middleware/    Autenticación JWT, permisos, sanitización, rate limiting, auditoría, carga de imágenes
src/database/      Esquema y seed de SQLite
src/services/      Envío de correo
src/utils/         Cifrado AES-256-GCM, hash SHA-256 y firma RSA-SHA256
keys/              Llaves RSA de los JWT. Se genera con npm run keys. No se versiona
certs/             Certificado TLS autofirmado. Se genera con npm run certs. No se versiona
storage/uploads/   Imágenes que sube el usuario al publicar. No se versiona
logs/              Bitácora de respaldos (backup.log). No se versiona
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
  refresh tokens son valores aleatorios rotatorios y en la base solo se guarda su
  **hash SHA-256**; el valor en claro vive en la cookie HttpOnly.
- **Códigos de recuperación**: se guardan como **hash SHA-256** y se comparan en
  tiempo constante. `forgot-password` responde lo mismo exista o no la cuenta.
- **Respaldos**: copia consistente con `VACUUM INTO` a una unidad externa, con
  retención configurable y registro de éxito o fallo en la auditoría.
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
- **Doble factor (2FA)**: no forma parte de esta entrega. La sección
  [Mejora opcional: 2FA TOTP](#mejora-opcional-verificación-en-dos-pasos-2fa-totp)
  describe cómo añadirlo sin cambiar el diseño actual.

## Mejora opcional: verificación en dos pasos (2FA TOTP)

Esta versión autentica con correo y contraseña, bloqueo por intentos fallidos,
rate limiting y sesión con JWT en cookie `HttpOnly`. El 2FA TOTP es una mejora
**opcional** que se dejó fuera para no ampliar el alcance de la entrega. Si se
necesita, este es el plan de implementación respetando la arquitectura actual.

### Dependencias

```bash
npm install otplib qrcode
```

- `otplib`: genera y verifica códigos TOTP (RFC 6238, ventana de 30 s).
- `qrcode`: convierte la URI `otpauth://` en una imagen para escanear con
  Google Authenticator, Microsoft Authenticator o Authy.

No se requieren servicios externos ni cambios en el frontend más allá del
formulario de activación y el segundo paso del login.

### Cambios en la base de datos

Añadir a `usuarios` (migración idempotente en `src/database/db.js`, igual que las
migraciones existentes):

| Columna | Tipo | Uso |
| --- | --- | --- |
| `totp_secret` | `TEXT` | Secreto TOTP **cifrado** con AES-256-GCM (`src/utils/crypto.js`). |
| `totp_enabled` | `INTEGER` | `0`/`1`. Solo se activa tras verificar un código válido. |
| `totp_backup_codes` | `TEXT` | JSON con hashes **SHA-256** de los códigos de respaldo. |

Los códigos de respaldo se muestran una sola vez en claro, se guardan hasheados
con `src/utils/hash.js` y se eliminan de la lista al usarse.

### Endpoints propuestos

Todos bajo `/api/auth`, con autenticación y rate limiting:

- `POST /2fa/setup` → genera un secreto nuevo, lo guarda cifrado y devuelve la
  URI `otpauth://` y el QR en Data URL. No activa el 2FA todavía.
- `POST /2fa/enable` → recibe un código de 6 dígitos; si es válido marca
  `totp_enabled = 1`, genera los códigos de respaldo y los devuelve una vez.
- `POST /2fa/disable` → exige contraseña actual y un código válido (TOTP o de
  respaldo) antes de borrar el secreto.
- `POST /login` → si `totp_enabled = 1`, responde `202` con un reto temporal de
  corta duración (cookie `HttpOnly`) en lugar de la sesión completa.
- `POST /login/2fa` → valida el código contra el reto temporal y solo entonces
  emite el JWT de acceso y el refresh token.

### Flujo de activación

1. El usuario entra a **Mi Perfil → Seguridad** y pulsa *Activar 2FA*.
2. La app muestra el QR y el secreto en texto para copiarlo manualmente.
3. El usuario escribe un código de la app autenticadora.
4. El servidor descifra el secreto, verifica el código y activa el 2FA.
5. Se muestran los códigos de respaldo con la advertencia de guardarlos fuera
   del navegador.

### Flujo de inicio de sesión

1. Correo y contraseña correctos → si el 2FA está activo, no se entrega sesión.
2. Se pide el código de 6 dígitos (o un código de respaldo).
3. Si el código es válido, se crea la sesión normal; si no, cuenta como intento
   fallido y aplica el mismo bloqueo que la contraseña.

### Reglas de seguridad

- El secreto TOTP **nunca** se guarda en claro ni se devuelve después de la
  activación.
- La ventana de tolerancia debe ser mínima (un paso de 30 s) para reducir
  reutilización de códigos.
- Un código TOTP no puede reutilizarse: guardar el último `timeStep` aceptado.
- Los códigos de respaldo son de un solo uso y se comparan en tiempo constante.
- El reto temporal del login expira en pocos minutos y no sirve para acceder a
  ninguna otra ruta.
- Activar, desactivar, fallar y usar un código de respaldo deben registrarse en
  la auditoría (`Acción: 2FA Activado`, `2FA Desactivado`, `2FA Fallido`).
- Desactivar el 2FA exige contraseña y un código válido, para que una sesión
  robada no pueda quitarlo.

### Pruebas a añadir

- Activación con código válido e inválido.
- Login sin 2FA sigue funcionando igual que hoy.
- Login con 2FA correcto, incorrecto y con código de respaldo.
- Reutilización de un código TOTP rechazada.
- Código de respaldo usado dos veces rechazado.
- Desactivación sin contraseña rechazada.
- El secreto en la base de datos no contiene el valor en claro.
- La auditoría registra los eventos de 2FA.