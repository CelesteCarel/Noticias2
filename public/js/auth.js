/**
 * Módulo de Autenticación, Control de Sesión y Perfil
 */
const Auth = {
  currentUser: null,
  currentPermissions: [],

  // Verifica si el usuario tiene un permiso específico
  hasPermission(permName) {
    if (!this.currentUser) return false;
    if (this.currentPermissions.includes('*')) return true;
    return this.currentPermissions.includes(permName);
  },

  applySession(data) {
    this.currentUser = data.user;
    this.currentPermissions = data.permissions || [];
    API.setToken(data.accessToken || null);
  },

  async init() {
    try {
      const data = await API.get('/auth/me');
      this.currentUser = data.user;
      this.currentPermissions = data.permissions || [];
      this.updateAuthUI();
    } catch {
      this.currentUser = null;
      this.currentPermissions = [];
      API.clearTokens();
      this.updateAuthUI();
    }
  },

  async login(email, password) {
    try {
      const data = await API.post('/auth/login', { email, password });
      this.applySession(data);
      this.updateAuthUI();
      showToast(`Bienvenido, ${data.user.nombre}`, 'success');

      if (typeof News !== 'undefined') await News.loadNews();
      return true;
    } catch (error) {
      showToast(error.message || 'Error al iniciar sesión', 'error');
      return false;
    }
  },

  async register(nombre, email, password) {
    try {
      const data = await API.post('/auth/register', { nombre, email, password });
      this.applySession(data);
      this.updateAuthUI();
      showToast('Cuenta creada exitosamente', 'success');

      if (typeof News !== 'undefined') await News.loadNews();
      return true;
    } catch (error) {
      showToast(error.message || 'Error al registrarse', 'error');
      return false;
    }
  },

  async changePassword(currentPassword, newPassword) {
    try {
      const data = await API.post('/auth/change-password', { currentPassword, newPassword });
      showToast(data.message || 'Contraseña actualizada correctamente', 'success');

      // El servidor revoca todas las sesiones tras cambiar la contraseña.
      if (data.reauthRequired) {
        API.clearTokens();
        this.currentUser = null;
        this.currentPermissions = [];
        this.updateAuthUI();
        if (typeof App !== 'undefined') App.openModal('modalLogin');
        if (typeof News !== 'undefined') News.renderGuestState();
      }
      return true;
    } catch (error) {
      showToast(error.message || 'Error al cambiar contraseña', 'error');
      return false;
    }
  },

  async forgotPassword(email) {
    try {
      const data = await API.post('/auth/forgot-password', { email });

      // Modo de prueba: el correo fue a una bandeja de Ethereal, no al buzón del
      // usuario. Se dice con claridad y se da el enlace para poder leerlo igual.
      if (data.modoPrueba) {
        showToast(data.message, 'warning', 9000);
        if (data.vistaPrevia) {
          showToast(`Abre el correo de prueba aquí: ${data.vistaPrevia}`, 'info', 12000);
        }
        return true;
      }

      showToast(data.message, 'info', 6000);
      return true;
    } catch (error) {
      showToast(error.message || 'Error al solicitar código', 'error');
      return false;
    }
  },

  async resetPassword(email, resetCode, newPassword) {
    try {
      const data = await API.post('/auth/reset-password', { email, resetCode, newPassword });
      showToast(data.message, 'success', 5000);
      return true;
    } catch (error) {
      showToast(error.message || 'Error al restablecer contraseña', 'error');
      return false;
    }
  },

  async logout(showNotification = true) {
    try {
      await API.post('/auth/logout', {});
    } catch {
      // Si el token ya expiró, las cookies se limpian igualmente en el servidor
      // al caducar el refresh token. El estado local se limpia en cualquier caso.
    }

    API.clearTokens();
    this.currentUser = null;
    this.currentPermissions = [];
    this.updateAuthUI();

    if (typeof App !== 'undefined') {
      App.switchView('portal');
    }

    if (typeof News !== 'undefined') {
      News.renderGuestState();
    }

    if (showNotification) {
      showToast('Has cerrado sesión correctamente', 'info');
    }
  },

  updateAuthUI() {
    const guestButtons = document.getElementById('guestButtons');
    const userProfileBadge = document.getElementById('userProfileBadge');
    const userNameDisplay = document.getElementById('userNameDisplay');
    const userRoleBadge = document.getElementById('userRoleBadge');
    const userAvatar = document.getElementById('userAvatar');
    const btnNavNewArticle = document.getElementById('btnNavNewArticle');
    const btnNavAdmin = document.getElementById('btnNavAdmin');

    if (this.currentUser) {
      if (guestButtons) guestButtons.style.display = 'none';
      if (userProfileBadge) userProfileBadge.style.display = 'flex';
      if (userNameDisplay) userNameDisplay.textContent = this.currentUser.nombre;
      if (userRoleBadge) {
        userRoleBadge.textContent = this.currentUser.nombre_rol === 'Usuario Regular'
          ? 'Lector'
          : this.currentUser.nombre_rol;
        userRoleBadge.className = `user-role-badge ${this.getRoleBadgeClass(this.currentUser.nombre_rol)}`;
      }
      if (userAvatar) userAvatar.textContent = this.currentUser.nombre.charAt(0).toUpperCase();

      // Botón "Publicar Noticia" (permiso noticias.crear)
      if (btnNavNewArticle) {
        btnNavNewArticle.style.display = this.hasPermission('noticias.crear') ? 'inline-flex' : 'none';
      }

      // Botón "Panel de Control" (permisos de gestión)
      if (btnNavAdmin) {
        btnNavAdmin.style.display = this.canAccessAdmin() ? 'inline-flex' : 'none';
      }
    } else {
      if (guestButtons) guestButtons.style.display = 'flex';
      if (userProfileBadge) userProfileBadge.style.display = 'none';
      if (btnNavNewArticle) btnNavNewArticle.style.display = 'none';
      if (btnNavAdmin) btnNavAdmin.style.display = 'none';
    }
  },

  canAccessAdmin() {
    return this.hasPermission('usuarios.gestionar')
      || this.hasPermission('roles.gestionar')
      || this.hasPermission('auditoria.ver');
  },

  getRoleBadgeClass(roleName) {
    switch (roleName) {
      case 'Administrador': return 'badge-admin';
      case 'Editor': return 'badge-editor';
      default: return 'badge-regular';
    }
  }
};