# Guía de demostración para la evaluación

Todo se ejecuta desde la carpeta del proyecto:

```powershell
cd C:\Users\herna\Desktop\Noticias2-main\Noticias2-main
```

## 0. Antes de entrar al aula (5 minutos)

```powershell
npm install
dir keys                 # deben aparecer jwt-private.pem y jwt-public.pem
npm test                 # debe terminar con 12, 21 y 62 pruebas correctas
```

- Si **no** existen las llaves: `npm run keys`.
- Si existen, **no** ejecutes `npm run keys` (se niega a sobrescribirlas; usa
  `npm run keys -- --force` solo si quieres invalidar los tokens anteriores).
- Comprueba que `.env` tiene una `DATA_ENCRYPTION_KEY` de 64 caracteres
  hexadecimales y las dos rutas de las llaves. El archivo `.env`, `keys/` y
  `database.sqlite` no se suben a git: si evalúas desde un clon nuevo hay que
  crearlos.

## 1. Demostración en la interfaz: cifrado simétrico (3 min)

```powershell
npm start
```

Abre http://localhost:3000 e inicia sesión con el usuario lector:

```
lector@portalnoticias.com
Usuario12345!
```

> Estas contraseñas son las del `.env` local. Si el profesor clona el
> repositorio, el seed usará las que él configure en su `.env`.

1. Haz clic en el icono de la tarjeta (🪪, “Mi perfil”) junto al nombre de usuario.
2. Llena los campos:
   - Teléfono: `9611234567`
   - RFC: `HERM900101ABC`
   - Dirección: `Av. Central 123, Tuxtla Gutiérrez, Chiapas`
3. Guarda. Aparece el mensaje de que los datos quedaron cifrados.
4. Vuelve a abrir “Mi perfil”: el usuario sigue viendo sus datos en claro
   (el servidor descifra solo para el dueño de la sesión).
5. En otra terminal muestra lo que realmente hay en SQLite:

```powershell
node --no-warnings -e "const {DatabaseSync}=require('node:sqlite'); const db=new DatabaseSync('database.sqlite'); console.log(db.prepare('SELECT telefono, rfc, direccion FROM usuarios WHERE email = ?').get('lector@portalnoticias.com')); db.close();"
```

Salida esperada (los tres valores empiezan con `v1:` y no contienen el texto
original):

```
{
  telefono: 'v1:...:...:...',
  rfc: 'v1:...:...:...',
  direccion: 'v1:...:...:...'
}
```

Frase para explicar: *“El dato entra en claro, el servidor lo valida, lo cifra
con AES-256-GCM y lo guarda como `v1:iv:tag:datos`. El IV es aleatorio en cada
guardado, así que dos cifrados del mismo RFC son distintos, y el tag GCM impide
que un dato alterado se descifre.”*

### Prueba de alteración (opcional, 1 min)

```powershell
node --no-warnings -e "const {DatabaseSync}=require('node:sqlite'); const db=new DatabaseSync('database.sqlite'); const r=db.prepare('SELECT rfc FROM usuarios WHERE email = ?').get('lector@portalnoticias.com'); const p=r.rfc.split(':'); const b=Buffer.from(p[3],'base64'); b[0]^=0xff; p[3]=b.toString('base64'); db.prepare('UPDATE usuarios SET rfc = ? WHERE email = ?').run(p.join(':'),'lector@portalnoticias.com'); db.close(); console.log('RFC alterado en la base de datos');"
```

Recarga la página y abre “Mi perfil”: el RFC aparece vacío y la consola del
servidor registra `la autenticación GCM falló`. Vuelve a guardar el RFC para
restaurarlo. Esto demuestra que GCM detecta manipulación, no solo
confidencialidad.

## 2. Demostración del mecanismo asimétrico (4 min)

### Opción A — en la app, con una noticia real (recomendada)

1. Inicia sesión con cualquier rol y haz clic en una noticia para abrir el lector.
2. Baja al panel **“Garantías Criptográficas de la Publicación”**.
3. Clic en **“Verificar Firma con Llave Pública”**: aparece *FIRMA DIGITAL VÁLIDA*,
   el algoritmo (`RSA-SHA256`, 3072 bits) y la huella SHA-256 de la llave pública.
4. Clic en **“Probar Detección de Alteración”**: aparece *ALTERACIÓN DETECTADA*.
   Aclara que la noticia original **no** se modificó: la alteración fue en memoria.
5. Si la noticia trae nota confidencial, el bloque inferior muestra el texto en
   claro y el botón “Ver cómo está guardado en BD” enseña el valor cifrado.

Frase: *“El servidor firmó esta noticia con la llave privada al publicarla.
Al cambiar una sola letra, el texto firmado deja de coincidir y la llave pública
rechaza la firma: la alteración se detecta aunque el atacante tenga la base de
datos completa.”*

### Opción B — scripts dedicados

Ejemplo mínimo, sin base de datos (el más parecido a la demo del perfil):
crea una noticia en memoria, la firma, muestra la firma como se guardaría en la
BD, la verifica, cambia una letra y comprueba que la firma deja de ser válida.

```powershell
npm run demo:firma
```

Con una noticia **real** de SQLite:

```powershell
npm run demo:asimetrico
```

Recorre cinco bloques: las dos llaves y la huella de la pública; el payload
canónico y la firma real guardada en `noticias.firma_digital`; la verificación
válida; la misma verificación tras alterar el título (inválida); y que otra
llave pública distinta no valida la firma. Termina con el token JWT.

### Opción C — el token de tu sesión real (PowerShell)

Con el servidor corriendo:

```powershell
$body = @{ email = 'lector@portalnoticias.com'; password = 'Usuario12345!' } | ConvertTo-Json
$login = Invoke-RestMethod -Uri http://localhost:3000/api/auth/login -Method Post -ContentType 'application/json' -Body $body

# Encabezado del JWT (debe decir RS256)
$h = $login.accessToken.Split('.')[0].Replace('-','+').Replace('_','/')
[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($h + ('=' * ((4 - $h.Length % 4) % 4))))

# Verificación con la llave PÚBLICA
node -e "const jwt=require('jsonwebtoken'),fs=require('fs');console.log(jwt.verify(process.argv[1],fs.readFileSync('keys/jwt-public.pem','utf8'),{algorithms:['RS256']}))" $login.accessToken
```

Después demuestra el rechazo. En el navegador, con DevTools abierto, copia el
token desde la cookie `portal_access_token` (Application → Cookies) y pega en
la pestaña Console:

```js
// Intenta cambiar el rol del payload a Administrador sin poder volver a firmar
(async () => {
  const t = '<pega aquí el token>';
  const [h, p, f] = t.split('.');
  const payload = JSON.parse(atob(p.replace(/-/g, '+').replace(/_/g, '/')));
  payload.id_rol = 1;
  payload.nombre_rol = 'Administrador';
  const p2 = btoa(JSON.stringify(payload))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const r = await fetch('/api/auth/me', {
    headers: { Authorization: `Bearer ${h}.${p2}.${f}` }
  });
  console.log(r.status, await r.json());   // 401 Token inválido
})();
```

Frase para explicar: *“El servidor firma con la llave privada RSA de 3072 bits y
verifica con la pública, exigiendo `algorithms: ['RS256']`. Si alguien cambia el
payload o intenta firmar con HS256, la verificación falla y responde 401: no
puede escalar de Lector a Administrador.”*

## 3. Demostración automática completa (2 min)

```powershell
npm run demo
```

Orden recomendado para narrar la salida:

1. RFC inventado en claro y el valor **real** que quedó en SQLite.
2. Partes del formato: versión, IV, tag y datos cifrados.
3. Descifrado del RFC, teléfono y dirección.
4. Dos cifrados del mismo RFC con IV distinto.
5. Un solo carácter alterado → GCM falla.
6. Encabezado del token: `{"alg":"RS256","typ":"JWT"}`.
7. Verificación con la llave pública: válida.
8. Payload alterado → rechazado (`invalid signature`).
9. Token firmado con HS256 → rechazado.

> El script usa una base de datos temporal: no toca la del proyecto. El usuario
> y el RFC son inventados.

## 4. Pruebas automatizadas (2 min)

```powershell
npm test
```

Muestra las tres suites:

| Suite | Qué demuestra |
|---|---|
| `test/crypto.test.js` (12) | formato `v1:`, roundtrip, IV único, alteración detectada, firma RSA de noticias |
| `test/config.test.js` (21) | sin llave simétrica o sin llaves RSA la app no arranca y explica cómo generarlas |
| `test/api.test.js` (62) | login, perfil cifrado en SQLite y en claro por API, `alg: RS256`, payload alterado y HS256 → 401, RBAC, XSS, auditoría |

Cada suite levanta un servidor en un proceso hijo con base de datos y llaves
temporales: no modifican `.env`, `keys/` ni `database.sqlite`.

## 5. Preguntas probables y respuestas cortas

- **¿Por qué AES-256-GCM y no AES-CBC?** GCM cifra y autentica en una sola
  operación; el tag detecta cualquier alteración del dato.
- **¿Por qué un IV aleatorio?** Reutilizar IV con la misma llave rompe GCM.
  Aquí se genera uno nuevo de 12 bytes en cada `encrypt`.
- **¿Dónde está la llave simétrica?** En `DATA_ENCRYPTION_KEY` del `.env`, nunca
  en el código; el servidor no arranca sin ella.
- **¿Por qué RSA y no HS256?** Con HS256 la misma clave firma y verifica. Con
  RS256 solo el servidor tiene la privada y cualquiera puede verificar con la
  pública; además se restringe `algorithms: ['RS256']` para evitar confusión de
  algoritmo.
- **¿Qué pasa si roban el archivo SQLite?** Solo obtienen cadenas `v1:...`;
  sin la llave del `.env` no pueden descifrar y cualquier cambio rompe el tag.
- **¿Se cifra el correo o el nombre?** No: solo teléfono, RFC y dirección, que
  son los datos sensibles del perfil. El correo se usa para login y ya tiene
  índice único.
- **¿Y las llaves?** `keys/` está en `.gitignore`, la privada se crea con modo
  `0600` y se regenera con `npm run keys -- --force` (lo que invalida los tokens
  emitidos).

## 6. Plan B si algo falla

| Síntoma | Solución |
|---|---|
| `Falta DATA_ENCRYPTION_KEY` | `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` y pégalo en `.env` |
| `No se encontró la llave RSA` | `npm run keys` y revisa `JWT_*_KEY_PATH` en `.env` |
| `No se pudo descifrar... GCM falló` en datos viejos | Se cambió la llave o el par RSA: borra `database.sqlite` para que se regenere el seed |
| El puerto 3000 está ocupado | `$env:PORT='3100'; npm start` |
| El navegador muestra el perfil vacío | Vuelve a guardar los datos en “Mi perfil” |
| “Verificar firma” muestra inválida en noticias de ejemplo | Se cambiaron las llaves después de crear la BD: borra `database.sqlite` y arranca de nuevo para regenerar el seed firmado con las llaves actuales |

## 7. Qué no mostrar

- No abras `.env` ni `keys/jwt-private.pem` en pantalla: son secretos y están
  fuera del repositorio. Basta con decir dónde viven y cómo se generan.
- No borres `database.sqlite` durante la evaluación salvo que sea el plan B:
  se pierden usuarios y noticias creados en la demo.
