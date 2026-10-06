-- Esquema Relacional de Base de Datos para el Portal de Noticias
-- Sistema de 7 tablas relacionales con RBAC dinámico, refresh tokens y bitácora inmutable

PRAGMA foreign_keys = ON;

-- 1. Tabla de Roles
CREATE TABLE IF NOT EXISTS roles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre_rol TEXT UNIQUE NOT NULL,
    descripcion TEXT
);

-- 2. Tabla de Permisos
CREATE TABLE IF NOT EXISTS permisos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre_permiso TEXT UNIQUE NOT NULL,
    descripcion TEXT
);

-- 3. Tabla Intermedia Rol - Permisos (RBAC Dinámico)
CREATE TABLE IF NOT EXISTS rol_permisos (
    id_rol INTEGER NOT NULL,
    id_permiso INTEGER NOT NULL,
    PRIMARY KEY (id_rol, id_permiso),
    FOREIGN KEY (id_rol) REFERENCES roles(id) ON DELETE CASCADE,
    FOREIGN KEY (id_permiso) REFERENCES permisos(id) ON DELETE CASCADE
);

-- 4. Tabla de Usuarios
-- COLLATE NOCASE hace que la restricción UNIQUE del correo sea insensible a
-- mayúsculas: USER@t.com y user@t.com son la misma cuenta incluso si el dato
-- llegara a la base de datos sin normalizar.
CREATE TABLE IF NOT EXISTS usuarios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL,
    email TEXT NOT NULL COLLATE NOCASE UNIQUE,
    password TEXT NOT NULL,
    id_rol INTEGER NOT NULL,
    fecha_registro DATETIME DEFAULT CURRENT_TIMESTAMP,
    intentos_fallidos INTEGER DEFAULT 0,
    bloqueado_hasta DATETIME,
    codigo_recuperacion TEXT,
    codigo_expira DATETIME,
    FOREIGN KEY (id_rol) REFERENCES roles(id)
);

-- 5. Tabla de Refresh Tokens (Gestión Segura de Sesiones JWT)
CREATE TABLE IF NOT EXISTS refresh_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    id_usuario INTEGER NOT NULL,
    token TEXT UNIQUE NOT NULL,
    expira_en DATETIME NOT NULL,
    creado_en DATETIME DEFAULT CURRENT_TIMESTAMP,
    revocado INTEGER DEFAULT 0,
    FOREIGN KEY (id_usuario) REFERENCES usuarios(id) ON DELETE CASCADE
);

-- 6. Tabla de Noticias
CREATE TABLE IF NOT EXISTS noticias (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    titulo TEXT NOT NULL,
    contenido TEXT NOT NULL,
    categoria TEXT NOT NULL,
    imagen_url TEXT,
    id_autor INTEGER NOT NULL,
    es_portada INTEGER DEFAULT 0,
    porcentaje_censura INTEGER DEFAULT 30,
    fecha_creacion DATETIME DEFAULT CURRENT_TIMESTAMP,
    fecha_actualizacion DATETIME,
    FOREIGN KEY (id_autor) REFERENCES usuarios(id) ON DELETE CASCADE
);

-- 7. Tabla de Auditoría
-- Nota sobre la clave foránea: declara ON DELETE SET NULL, pero los triggers de
-- inmutabilidad de más abajo rechazan cualquier UPDATE, así que en la práctica un
-- usuario con historial no puede eliminarse. Es intencional: la trazabilidad se
-- conserva aunque el usuario desaparezca del directorio.
CREATE TABLE IF NOT EXISTS auditoria (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    id_usuario INTEGER,
    accion TEXT NOT NULL,
    detalles TEXT,
    ip TEXT,
    fecha_hora DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (id_usuario) REFERENCES usuarios(id) ON DELETE SET NULL
);

-- Índices de Rendimiento
CREATE INDEX IF NOT EXISTS idx_usuarios_email ON usuarios(email);
CREATE INDEX IF NOT EXISTS idx_noticias_categoria ON noticias(categoria);
CREATE INDEX IF NOT EXISTS idx_noticias_autor ON noticias(id_autor);
CREATE INDEX IF NOT EXISTS idx_auditoria_fecha ON auditoria(fecha_hora DESC);
CREATE INDEX IF NOT EXISTS idx_auditoria_usuario ON auditoria(id_usuario);
CREATE INDEX IF NOT EXISTS idx_refresh_token ON refresh_tokens(token);

-- Triggers de Inmutabilidad de Auditoría (Previene manipulación y borrado de eventos)
CREATE TRIGGER IF NOT EXISTS trg_auditoria_no_update
BEFORE UPDATE ON auditoria
BEGIN
    SELECT RAISE(ABORT, 'Operación denegada: Los registros de auditoría son inmutables por política de seguridad');
END;

-- 8. Tabla de Configuración General del Portal (Teaser de portada, ajustes)
CREATE TABLE IF NOT EXISTS configuracion_portal (
    clave TEXT PRIMARY KEY,
    valor TEXT NOT NULL,
    fecha_actualizacion DATETIME DEFAULT CURRENT_TIMESTAMP
);
