/**
 * Controlador Principal del Portal de Noticias
 */
const App = {
  currentView: 'portal',

  async init() {
    this.initTheme();
    this.initDateDisplay();
    this.bindGlobalEvents();
    this.bindAuthEvents();
    this.bindModalEvents();

    await Auth.init();
    News.init();
    Admin.init();
  },

  initTheme() {
    const savedTheme = localStorage.getItem('portal_theme') || 'light';
    document.documentElement.setAttribute('data-theme', savedTheme);
    this.updateThemeIcon(savedTheme);

    const toggleBtn = document.getElementById('themeToggleBtn');
    if (toggleBtn) {
      toggleBtn.addEventListener('click', () => {
        const currentTheme = document.documentElement.getAttribute('data-theme');
        const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', newTheme);
        localStorage.setItem('portal_theme', newTheme);
        this.updateThemeIcon(newTheme);
      });
    }
  },

  updateThemeIcon(theme) {
    const icon = document.getElementById('themeIcon');
    if (!icon) return;
    icon.className = theme === 'dark' ? 'fa-solid fa-sun' : 'fa-solid fa-moon';
  },

  initDateDisplay() {
    const el = document.getElementById('currentDateDisplay');
    if (!el) return;
    const now = new Date();
    const options = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
    const dateStr = now.toLocaleDateString('es-ES', options);
    el.innerHTML = `<i class="fa-regular fa-calendar"></i> ${dateStr.charAt(0).toUpperCase() + dateStr.slice(1)}`;
  },

  switchView(viewName) {
    this.currentView = viewName;
    const viewPortal = document.getElementById('viewPortal');
    const viewAdmin = document.getElementById('viewAdmin');
    const btnNavPortal = document.getElementById('btnNavPortal');
    const btnNavAdmin = document.getElementById('btnNavAdmin');

    if (viewName === 'admin') {
      if (!Auth.canAccessAdmin()) {
        showToast('Tu rol no tiene permisos para acceder al panel de administración', 'error');
        this.switchView('portal');
        return;
      }
      if (viewPortal) viewPortal.style.display = 'none';
      if (viewAdmin) viewAdmin.style.display = 'block';
      if (btnNavPortal) btnNavPortal.style.display = 'inline-flex';
      if (btnNavAdmin) btnNavAdmin.style.display = 'none';
      Admin.loadDashboard();
    } else {
      if (viewPortal) viewPortal.style.display = 'block';
      if (viewAdmin) viewAdmin.style.display = 'none';
      if (btnNavPortal) btnNavPortal.style.display = 'none';
      if (btnNavAdmin) btnNavAdmin.style.display = Auth.canAccessAdmin() ? 'inline-flex' : 'none';
      News.loadNews();
    }

    window.scrollTo({ top: 0, behavior: 'smooth' });
  },

  bindGlobalEvents() {
    const brandLogo = document.getElementById('brandLogo');
    if (brandLogo) {
      brandLogo.addEventListener('click', (e) => {
        e.preventDefault();
        this.switchView('portal');
      });
    }

    const btnNavPortal = document.getElementById('btnNavPortal');
    if (btnNavPortal) {
      btnNavPortal.addEventListener('click', () => this.switchView('portal'));
    }

    const btnNavAdmin = document.getElementById('btnNavAdmin');
    if (btnNavAdmin) {
      btnNavAdmin.addEventListener('click', () => this.switchView('admin'));
    }

    const btnNavNewArticle = document.getElementById('btnNavNewArticle');
    if (btnNavNewArticle) {
      btnNavNewArticle.addEventListener('click', () => News.openEditor());
    }

    const btnLogout = document.getElementById('btnLogout');
    if (btnLogout) {
      btnLogout.addEventListener('click', () => Auth.logout());
    }

    const btnOpenChangePass = document.getElementById('btnOpenChangePass');
    if (btnOpenChangePass) {
      btnOpenChangePass.addEventListener('click', () => this.openModal('modalChangePass'));
    }
  },

  bindAuthEvents() {
    const btnLoginOpen = document.getElementById('btnLoginOpen');
    if (btnLoginOpen) {
      btnLoginOpen.addEventListener('click', () => this.openModal('modalLogin'));
    }

    const btnRegisterOpen = document.getElementById('btnRegisterOpen');
    if (btnRegisterOpen) {
      btnRegisterOpen.addEventListener('click', () => this.openModal('modalRegister'));
    }

    const linkGoToRegister = document.getElementById('linkGoToRegister');
    if (linkGoToRegister) {
      linkGoToRegister.addEventListener('click', (e) => {
        e.preventDefault();
        this.closeModal('modalLogin');
        this.openModal('modalRegister');
      });
    }

    const linkGoToLogin = document.getElementById('linkGoToLogin');
    if (linkGoToLogin) {
      linkGoToLogin.addEventListener('click', (e) => {
        e.preventDefault();
        this.closeModal('modalRegister');
        this.openModal('modalLogin');
      });
    }

    const btnForgotPassOpen = document.getElementById('btnForgotPassOpen');
    if (btnForgotPassOpen) {
      btnForgotPassOpen.addEventListener('click', (e) => {
        e.preventDefault();
        this.closeModal('modalLogin');
        this.openModal('modalForgotPass');
      });
    }

    // Formulario de Inicio de Sesión
    const loginForm = document.getElementById('loginForm');
    if (loginForm) {
      loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const email = document.getElementById('loginEmail').value.trim();
        const pass = document.getElementById('loginPassword').value;
        const submitBtn = document.getElementById('btnLoginSubmit');

        submitBtn.disabled = true;
        submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Verificando...';

        try {
          const success = await Auth.login(email, pass);
          if (success) {
            this.closeModal('modalLogin');
            loginForm.reset();
          }
        } finally {
          submitBtn.disabled = false;
          submitBtn.innerHTML = 'Ingresar al Sistema';
        }
      });
    }

    // Formulario de Registro
    const registerForm = document.getElementById('registerForm');
    if (registerForm) {
      registerForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const nombre = document.getElementById('regName').value.trim();
        const email = document.getElementById('regEmail').value.trim();
        const pass = document.getElementById('regPassword').value;
        const submitBtn = document.getElementById('btnRegisterSubmit');

        submitBtn.disabled = true;
        submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Creando cuenta...';

        try {
          const success = await Auth.register(nombre, email, pass);
          if (success) {
            this.closeModal('modalRegister');
            registerForm.reset();
          }
        } finally {
          submitBtn.disabled = false;
          submitBtn.innerHTML = 'Crear Cuenta';
        }
      });
    }

    // Formulario de Cambio de Contraseña (Autenticado)
    const changePassForm = document.getElementById('changePassForm');
    if (changePassForm) {
      changePassForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const currentPass = document.getElementById('currentPassword').value;
        const newPass = document.getElementById('newPassword').value;
        const confirmPass = document.getElementById('confirmNewPassword').value;

        if (newPass !== confirmPass) {
          showToast('La nueva contraseña y su confirmación no coinciden', 'warning');
          return;
        }

        const submitBtn = document.getElementById('btnChangePassSubmit');
        submitBtn.disabled = true;
        submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Actualizando...';

        try {
          const success = await Auth.changePassword(currentPass, newPass);
          if (success) {
            this.closeModal('modalChangePass');
            changePassForm.reset();
          }
        } finally {
          submitBtn.disabled = false;
          submitBtn.innerHTML = 'Actualizar Contraseña';
        }
      });
    }

    // Formulario de Recuperación de Contraseña (Flujo Real de 2 Pasos)
    const forgotPassForm = document.getElementById('forgotPassForm');
    if (forgotPassForm) {
      forgotPassForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const email = document.getElementById('forgotEmail').value.trim();
        const resetCode = document.getElementById('resetCode').value.trim();
        const newPass = document.getElementById('resetNewPass').value;
        const confirmPass = document.getElementById('resetConfirmPass').value;
        const resetGroup = document.getElementById('resetFieldsGroup');
        const submitBtn = document.getElementById('btnForgotSubmit');
        const subtitle = document.getElementById('forgotSubtitle');

        if (!resetGroup || resetGroup.style.display === 'none') {
          // Paso 1: Enviar Código a Correo Real
          submitBtn.disabled = true;
          submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Enviando correo...';

          try {
            const ok = await Auth.forgotPassword(email);
            if (ok) {
              resetGroup.style.display = 'block';
              document.getElementById('forgotEmail').readOnly = true;
              if (subtitle) subtitle.textContent = 'Ingresa el código que te enviamos y tu nueva contraseña.';
              submitBtn.textContent = 'Restablecer Contraseña';
            }
          } finally {
            submitBtn.disabled = false;
            if (resetGroup.style.display === 'none') {
              submitBtn.textContent = 'Enviar Código por Correo';
            }
          }
        } else {
          // Paso 2: Validar Código y Actualizar Contraseña
          if (!resetCode || !newPass) {
            showToast('Ingresa el código de verificación y tu nueva contraseña', 'warning');
            return;
          }

          // Se pide repetir la contraseña porque el fallo más común aquí no es del
          // servidor: es teclear la clave con un error y luego no poder
          // reproducirla al iniciar sesión, lo que acaba en cuenta bloqueada.
          if (newPass !== confirmPass) {
            showToast('Las dos contraseñas no coinciden. Escríbelas iguales.', 'warning');
            return;
          }

          submitBtn.disabled = true;
          submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Guardando...';

          try {
            const ok = await Auth.resetPassword(email, resetCode, newPass);
            if (ok) {
              this.closeModal('modalForgotPass');
              forgotPassForm.reset();
              resetGroup.style.display = 'none';
              document.getElementById('forgotEmail').readOnly = false;
              submitBtn.textContent = 'Enviar Código por Correo';
              if (subtitle) subtitle.textContent = 'Ingresa tu correo para recibir un código de verificación.';
              this.openModal('modalLogin');
            }
          } finally {
            submitBtn.disabled = false;
          }
        }
      });
    }
  },

  bindModalEvents() {
    const closeButtons = [
      { btn: 'closeReaderModal', modal: 'modalArticleReader' },
      { btn: 'closeReaderModalFooter', modal: 'modalArticleReader' },
      { btn: 'closeEditorModal', modal: 'modalArticleEditor' },
      { btn: 'btnCancelArticle', modal: 'modalArticleEditor' },
      { btn: 'closeLoginModal', modal: 'modalLogin' },
      { btn: 'closeRegisterModal', modal: 'modalRegister' },
      { btn: 'closeForgotModal', modal: 'modalForgotPass' },
      { btn: 'closeChangePassModal', modal: 'modalChangePass' },
      { btn: 'closeRoleModal', modal: 'modalCreateRole' },
      { btn: 'btnCancelRole', modal: 'modalCreateRole' }
    ];

    closeButtons.forEach(item => {
      const el = document.getElementById(item.btn);
      if (el) {
        el.addEventListener('click', () => this.closeModal(item.modal));
      }
    });

    document.querySelectorAll('.modal-backdrop').forEach(modal => {
      modal.addEventListener('click', (e) => {
        if (e.target === modal) {
          this.closeModal(modal.id);
        }
      });
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        document.querySelectorAll('.modal-backdrop.show').forEach(modal => {
          this.closeModal(modal.id);
        });
      }
    });
  },

  openModal(modalId) {
    const modal = document.getElementById(modalId);
    if (!modal) return;
    modal.classList.add('show');
    document.body.style.overflow = 'hidden';
  },

  closeModal(modalId) {
    const modal = document.getElementById(modalId);
    if (!modal) return;
    modal.classList.remove('show');
    document.body.style.overflow = '';
  }
};

document.addEventListener('DOMContentLoaded', () => {
  App.init();
});
