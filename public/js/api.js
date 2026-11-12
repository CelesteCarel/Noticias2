/**
 * Cliente HTTP de la API REST con gestión de sesión JWT.
 *
 * Estrategia de tokens (requisito de seguridad computacional):
 *  - El access token se mantiene SOLO en memoria (variable de este objeto). Nunca
 *    se escribe en localStorage ni sessionStorage, de modo que un XSS no puede
 *    exfiltrarlo de forma persistente.
 *  - Cada petición se envía con el encabezado `Authorization: Bearer <token>`.
 *  - Además, el servidor emite cookies HttpOnly + SameSite como canal de respaldo,
 *    para que la sesión sobreviva a una recarga de la página.
 *  - Al expirar el access token (15 min) se renueva la sesión con el refresh token
 *    y se reintenta la petición original una sola vez.
 */
const API = {
  baseUrl: '/api',
  accessToken: null,
  isRefreshing: false,
  failedQueue: [],

  getToken() {
    return this.accessToken;
  },

  setToken(token) {
    this.accessToken = token || null;
  },

  clearTokens() {
    this.accessToken = null;
  },

  processQueue(error, token = null) {
    this.failedQueue.forEach(prom => {
      if (error) {
        prom.reject(error);
      } else {
        prom.resolve(token);
      }
    });
    this.failedQueue = [];
  },

  buildHeaders(options = {}) {
    const headers = {
      ...(options.headers || {})
    };
    // En multipart/form-data el encabezado Content-Type lo fija el navegador,
    // porque debe incluir el límite (boundary) que separa las partes. Si lo
    // enviáramos fijo, el servidor no podría reconstruir el archivo.
    if (!options.multipart) {
      headers['Content-Type'] = 'application/json';
    }
    const token = this.getToken();
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    return headers;
  },

  async rawRequest(url, options = {}) {
    const response = await fetch(url, { ...options, headers: this.buildHeaders(options), credentials: 'include' });
    const data = await response.json().catch(() => ({}));
    return { response, data };
  },

  async request(endpoint, options = {}) {
    const url = `${this.baseUrl}${endpoint}`;

    try {
      const { response, data } = await this.rawRequest(url, options);

      // El access token expiró: se renueva la sesión y se reintenta la petición.
      const esRenovable = response.status === 401
        && data.code === 'TOKEN_EXPIRED'
        && !endpoint.startsWith('/auth/refresh')
        && !endpoint.startsWith('/auth/login');

      if (esRenovable) {
        return await this.refreshAndRetry(url, options);
      }

      if (!response.ok) {
        const errorMessage = data.error || `Error ${response.status}: ${response.statusText}`;
        const err = new Error(errorMessage);
        err.status = response.status;
        err.data = data;
        throw err;
      }

      return data;
    } catch (error) {
      if (!error.status) console.error(`[API Error] ${endpoint}:`, error.message);
      throw error;
    }
  },

  /**
   * Renueva el access token usando el refresh token (cookie HttpOnly) y reintenta
   * la petición original con el token nuevo. Las peticiones concurrentes se
   * encolan para issuing una sola renovación.
   */
  async refreshAndRetry(url, options) {
    if (this.isRefreshing) {
      return new Promise((resolve, reject) => {
        this.failedQueue.push({ resolve, reject });
      }).then(async () => {
        const { response, data } = await this.rawRequest(url, options);
        if (!response.ok) throw new Error(data.error || 'No se pudo completar la petición');
        return data;
      });
    }

    this.isRefreshing = true;

    try {
      const refreshRes = await fetch(`${this.baseUrl}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include'
      });
      const refreshData = await refreshRes.json().catch(() => ({}));

      if (!refreshRes.ok) {
        throw new Error(refreshData.error || 'No se pudo renovar la sesión');
      }

      this.setToken(refreshData.accessToken);
      this.processQueue(null, true);

      // Reintento de la petición original con el token renovado
      const { response, data } = await this.rawRequest(url, options);
      if (!response.ok) throw new Error(data.error || 'No se pudo completar la petición');
      return data;
    } catch (refreshErr) {
      this.processQueue(refreshErr, null);
      this.clearTokens();
      if (typeof Auth !== 'undefined') await Auth.logout(false);
      throw new Error('Tu sesión ha expirado. Inicia sesión nuevamente.');
    } finally {
      this.isRefreshing = false;
    }
  },

  get(endpoint) {
    return this.request(endpoint, { method: 'GET' });
  },

  post(endpoint, body) {
    return this.request(endpoint, { method: 'POST', body: JSON.stringify(body) });
  },

  put(endpoint, body) {
    return this.request(endpoint, { method: 'PUT', body: JSON.stringify(body) });
  },

  /**
   * Envía un FormData (multipart/form-data) con los campos de texto y, si la
   * hay, la imagen en el campo `imagen`. El token viaja igual que en el resto de
   * peticiones y la renovación por refresh token también se aplica.
   */
  postForm(endpoint, formData) {
    return this.request(endpoint, { method: 'POST', body: formData, multipart: true });
  },

  putForm(endpoint, formData) {
    return this.request(endpoint, { method: 'PUT', body: formData, multipart: true });
  },

  delete(endpoint) {
    return this.request(endpoint, { method: 'DELETE' });
  }
};

/**
 * Notificaciones Flotantes (Toasts)
 */
function showToast(message, type = 'info', duration = 4000) {
  const container = document.getElementById('toastContainer');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;

  const icons = {
    success: 'fa-solid fa-circle-check',
    error: 'fa-solid fa-triangle-exclamation',
    warning: 'fa-solid fa-circle-exclamation',
    info: 'fa-solid fa-circle-info'
  };

  // El mensaje se inserta como texto, nunca como HTML: evita XSS en el cliente.
  const icon = document.createElement('i');
  icon.className = `${icons[type] || icons.info} toast-icon`;

  const text = document.createElement('span');
  text.className = 'toast-msg';
  text.textContent = message;

  toast.append(icon, text);
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(-10px)';
    toast.style.transition = 'all 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, duration);
}