/**
 * Módulo de Administración: Usuarios, Roles Dinámicos (RBAC) y Bitácora
 */
const Admin = {
  allRoles: [],
  allPermissions: [],
  allUsers: [],
  auditLogs: [],
  activeTab: 'tabUsers',

  init() {
    this.bindEvents();
  },

  bindEvents() {
    // Pestañas de navegación interna
    const tabs = document.querySelectorAll('.admin-tab');
    tabs.forEach(tab => {
      tab.addEventListener('click', (e) => {
        this.switchTab(e.currentTarget.getAttribute('data-tab'));
      });
    });

    // Búsqueda de usuarios
    const userSearchInput = document.getElementById('userSearchInput');
    if (userSearchInput) {
      userSearchInput.addEventListener('input', (e) => {
        const q = e.target.value.toLowerCase().trim();
        const filtered = this.allUsers.filter(u =>
          u.nombre.toLowerCase().includes(q) ||
          u.email.toLowerCase().includes(q) ||
          u.nombre_rol.toLowerCase().includes(q)
        );
        this.renderUsersTable(filtered);
      });
    }

    // Filtros de Auditoría
    const auditSearch = document.getElementById('auditSearchInput');
    const auditActionFilter = document.getElementById('auditActionFilter');
    const btnRefreshAudit = document.getElementById('btnRefreshAudit');

    if (auditSearch) {
      let debounce;
      auditSearch.addEventListener('input', () => {
        clearTimeout(debounce);
        debounce = setTimeout(() => this.loadAuditLogs(), 300);
      });
    }

    if (auditActionFilter) {
      auditActionFilter.addEventListener('change', () => this.loadAuditLogs());
    }

    if (btnRefreshAudit) {
      btnRefreshAudit.addEventListener('click', () => {
        this.loadAuditLogs();
        showToast('Bitácora de auditoría actualizada', 'info');
      });
    }

    // Modal Crear Rol
    const btnCreateRoleOpen = document.getElementById('btnCreateRoleOpen');
    if (btnCreateRoleOpen) {
      btnCreateRoleOpen.addEventListener('click', () => App.openModal('modalCreateRole'));
    }

    const createRoleForm = document.getElementById('createRoleForm');
    if (createRoleForm) {
      createRoleForm.addEventListener('submit', (e) => this.handleCreateRole(e));
    }

    // Delegación de eventos para controles dinámicos
    const usersTableBody = document.getElementById('usersTableBody');
    if (usersTableBody) {
      usersTableBody.addEventListener('change', (e) => {
        const select = e.target.closest('[data-action="role-change"]');
        if (!select) return;
        this.handleRoleChange(Number(select.getAttribute('data-user-id')), select.value);
      });
    }

    const rolesMatrix = document.getElementById('rolesMatrixContainer');
    if (rolesMatrix) {
      rolesMatrix.addEventListener('change', (e) => {
        const checkbox = e.target.closest('[data-action="perm-toggle"]');
        if (!checkbox) return;
        this.handleTogglePermission(Number(checkbox.getAttribute('data-role-id')));
      });
    }
  },

  switchTab(tabId) {
    this.activeTab = tabId;

    document.querySelectorAll('.admin-tab').forEach(t => {
      t.classList.toggle('active', t.getAttribute('data-tab') === tabId);
    });

    document.querySelectorAll('.admin-tab-pane').forEach(pane => {
      pane.style.display = pane.id === tabId ? 'block' : 'none';
    });

    if (tabId === 'tabUsers') this.loadUsers();
    if (tabId === 'tabRoles') this.loadRolesAndPermissions();
    if (tabId === 'tabAudit') this.loadAuditLogs();
  },

  async loadDashboard() {
    await Promise.all([
      this.loadUsers(),
      this.loadRolesAndPermissions(),
      this.loadAuditLogs()
    ]);
    this.updateStats();
  },

  updateStats() {
    const container = document.getElementById('adminQuickStats');
    if (!container) return;

    container.innerHTML = `
      <div class="stat-item">
        <span class="stat-number">${this.allUsers.length}</span>
        <span class="stat-name">Usuarios</span>
      </div>
      <div class="stat-item">
        <span class="stat-number">${this.allRoles.length}</span>
        <span class="stat-name">Roles</span>
      </div>
      <div class="stat-item">
        <span class="stat-number">${this.auditLogs.length}</span>
        <span class="stat-name">Eventos</span>
      </div>
    `;
  },

  /**
   * 1. Directorio de Usuarios
   */
  async loadUsers() {
    try {
      if (this.allRoles.length === 0) {
        this.allRoles = await API.get('/admin/roles');
      }
      this.allUsers = await API.get('/admin/usuarios');
      this.renderUsersTable(this.allUsers);
      this.updateStats();
    } catch (error) {
      this.handleAdminError(error, 'Error al cargar la lista de usuarios');
    }
  },

  renderUsersTable(users) {
    const tbody = document.getElementById('usersTableBody');
    if (!tbody) return;

    tbody.replaceChildren();

    if (users.length === 0) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 7;
      td.className = 'text-center text-muted';
      td.textContent = 'No se encontraron usuarios registrados.';
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }

    users.forEach(user => {
      const tr = document.createElement('tr');

      // --- Nombre con avatar ---
      const nameCell = document.createElement('td');
      const nameWrap = document.createElement('div');
      nameWrap.className = 'user-row-name';
      const avatar = document.createElement('div');
      avatar.className = 'user-avatar-sm';
      avatar.textContent = (user.nombre || '?').charAt(0).toUpperCase();
      const nameSpan = document.createElement('span');
      nameSpan.textContent = user.nombre;
      nameWrap.append(avatar, nameSpan);
      nameCell.appendChild(nameWrap);

      // --- Rol ---
      const roleCell = document.createElement('td');
      const roleBadge = document.createElement('span');
      roleBadge.className = `badge ${this.getRoleBadgeStyle(user.nombre_rol)}`;
      roleBadge.textContent = this.formatRoleName(user.nombre_rol);
      roleCell.appendChild(roleBadge);

      // --- Selector de rol ---
      const actionCell = document.createElement('td');
      const select = document.createElement('select');
      select.className = 'form-input form-input-sm role-select';
      select.setAttribute('data-action', 'role-change');
      select.setAttribute('data-user-id', user.id);
      this.allRoles.forEach(r => {
        const option = document.createElement('option');
        option.value = r.id;
        option.textContent = this.formatRoleName(r.nombre_rol);
        if (r.id === user.id_rol) option.selected = true;
        select.appendChild(option);
      });
      actionCell.appendChild(select);

      // Siete columnas: ID, Nombre, Correo, Rol, Artículos, Fecha y acción
      tr.replaceChildren(
        this.literalCell(`#${user.id}`),
        nameCell,
        this.literalCell(user.email, 'text-dim'),
        roleCell,
        this.literalCell(String(user.total_noticias), 'badge badge-count'),
        this.literalCell(this.formatDate(user.fecha_registro), 'text-dim text-sm'),
        actionCell
      );

      tbody.appendChild(tr);
    });
  },

  literalCell(text, className = '') {
    const td = document.createElement('td');
    td.textContent = text;
    if (className) td.className = className;
    return td;
  },

  async handleRoleChange(userId, newRoleId) {
    try {
      const res = await API.put(`/admin/usuarios/${userId}/rol`, { id_rol: Number(newRoleId) });
      showToast(res.message || 'Rol actualizado correctamente', 'success');

      // Si el administrador cambió su propio rol, su sesión puede haber perdido
      // permisos: se relee el perfil para reflejarlo de inmediato.
      if (Auth.currentUser && Auth.currentUser.id === userId) {
        await Auth.init();
        if (!Auth.canAccessAdmin()) App.switchView('portal');
      }

      await this.loadUsers();
    } catch (error) {
      showToast(error.message || 'Error al actualizar el rol', 'error');
      await this.loadUsers();
    }
  },

  /**
   * 2. Roles y Permisos Dinámicos
   */
  async loadRolesAndPermissions() {
    try {
      const [roles, permissions] = await Promise.all([
        API.get('/admin/roles'),
        API.get('/admin/permisos')
      ]);

      this.allRoles = roles;
      this.allPermissions = permissions;
      this.renderRolesMatrix(roles, permissions);
      this.updateStats();
    } catch (error) {
      this.handleAdminError(error, 'Error al cargar los roles y permisos');
    }
  },

  // Renderizado de matriz de permisos
  renderRolesMatrix(roles, permissions) {
    const container = document.getElementById('rolesMatrixContainer');
    if (!container) return;

    container.replaceChildren();

    roles.forEach(role => {
      const assignedPermIds = (role.permisos || []).map(p => p.id_permiso || p.id);

      const card = document.createElement('div');
      card.className = 'role-card';
      card.setAttribute('data-role-id', role.id);

      // --- Encabezado ---
      const header = document.createElement('div');
      header.className = 'role-card-header';

      const title = document.createElement('div');
      title.className = 'role-title';
      const icon = document.createElement('i');
      icon.className = role.nombre_rol === 'Administrador'
        ? 'fa-solid fa-crown text-warning'
        : 'fa-solid fa-shield';
      const titleSpan = document.createElement('span');
      titleSpan.textContent = this.formatRoleName(role.nombre_rol);
      title.append(icon, titleSpan);

      const badge = document.createElement('span');
      badge.className = `badge ${this.getRoleBadgeStyle(role.nombre_rol)}`;
      badge.textContent = `${assignedPermIds.length} / ${permissions.length} Permisos`;

      header.append(title, badge);

      const description = document.createElement('p');
      description.className = 'role-description';
      description.textContent = role.descripcion || 'Sin descripción asignada';

      // --- Lista de permisos ---
      const list = document.createElement('div');
      list.className = 'perm-list';

      permissions.forEach(perm => {
        const item = document.createElement('div');
        item.className = 'perm-item';

        const text = document.createElement('div');
        text.className = 'perm-text';
        const code = document.createElement('span');
        code.className = 'perm-code';
        const codeEl = document.createElement('code');
        codeEl.textContent = perm.nombre_permiso;
        code.appendChild(codeEl);
        const label = document.createElement('span');
        label.className = 'perm-label';
        label.textContent = perm.descripcion || '';
        text.append(code, label);

        const toggleLabel = document.createElement('label');
        toggleLabel.className = 'toggle-switch';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.setAttribute('data-perm-id', perm.id);
        checkbox.setAttribute('data-action', 'perm-toggle');
        checkbox.setAttribute('data-role-id', role.id);
        checkbox.checked = assignedPermIds.includes(perm.id);
        const slider = document.createElement('span');
        slider.className = 'slider';
        toggleLabel.append(checkbox, slider);

        item.append(text, toggleLabel);
        list.appendChild(item);
      });

      card.append(header, description, list);
      container.appendChild(card);
    });
  },

  async handleTogglePermission(roleId) {
    const roleCard = document.querySelector(`.role-card[data-role-id="${roleId}"]`);
    if (!roleCard) return;

    const checkedInputs = roleCard.querySelectorAll('input[type="checkbox"]:checked');
    const selectedPermIds = Array.from(checkedInputs).map(cb => Number(cb.getAttribute('data-perm-id')));

    try {
      const res = await API.put(`/admin/roles/${roleId}/permisos`, { permisos_ids: selectedPermIds });
      showToast(res.message || 'Permisos actualizados dinámicamente', 'success');

      // El cambio ya surte efecto en el servidor: se refresca el perfil propio.
      if (Auth.currentUser && Auth.currentUser.id_rol === roleId) {
        await Auth.init();
        if (!Auth.canAccessAdmin()) App.switchView('portal');
      }

      await this.loadRolesAndPermissions();
    } catch (error) {
      showToast(error.message || 'Error al actualizar permisos', 'error');
      await this.loadRolesAndPermissions();
    }
  },

  async handleCreateRole(e) {
    e.preventDefault();
    const roleName = document.getElementById('roleName').value.trim();
    const roleDesc = document.getElementById('roleDesc').value.trim();

    if (!roleName) {
      showToast('El nombre del rol es obligatorio', 'warning');
      return;
    }

    try {
      await API.post('/admin/roles', { nombre_rol: roleName, descripcion: roleDesc });
      showToast(`Rol "${roleName}" creado exitosamente`, 'success');
      App.closeModal('modalCreateRole');
      document.getElementById('createRoleForm').reset();
      await this.loadRolesAndPermissions();
    } catch (error) {
      showToast(error.message || 'Error al crear el rol', 'error');
    }
  },

  /**
   * 3. Bitácora de Auditoría
   */
  async loadAuditLogs() {
    try {
      const search = document.getElementById('auditSearchInput')?.value || '';
      const accion = document.getElementById('auditActionFilter')?.value || 'Todas';

      let endpoint = '/admin/auditoria?';
      if (search) endpoint += `search=${encodeURIComponent(search)}&`;
      if (accion && accion !== 'Todas') endpoint += `accion=${encodeURIComponent(accion)}&`;

      this.auditLogs = await API.get(endpoint);
      this.renderAuditTable(this.auditLogs);
      this.updateStats();
    } catch (error) {
      this.handleAdminError(error, 'Error al consultar la bitácora de auditoría');
    }
  },

  renderAuditTable(logs) {
    const tbody = document.getElementById('auditTableBody');
    if (!tbody) return;

    tbody.replaceChildren();

    if (logs.length === 0) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 7;
      td.className = 'text-center text-muted';
      td.textContent = 'No se encontraron eventos en la bitácora.';
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }

    logs.forEach(log => {
      const tr = document.createElement('tr');

      // ID
      tr.appendChild(this.literalCell(`#${log.id}`, 'text-dim'));

      // Fecha y hora
      const timeCell = document.createElement('td');
      const timeWrap = document.createElement('div');
      timeWrap.className = 'audit-time';
      timeWrap.appendChild(Object.assign(document.createElement('i'), { className: 'fa-regular fa-clock' }));
      timeWrap.appendChild(document.createTextNode(` ${this.formatDateTime(log.fecha_hora)}`));
      timeCell.appendChild(timeWrap);

      // Usuario
      const userCell = document.createElement('td');
      const userWrap = document.createElement('div');
      userWrap.className = 'audit-user';
      const nameSpan = document.createElement('span');
      nameSpan.className = 'audit-user-name';
      nameSpan.textContent = log.usuario_nombre || 'Sistema / Anónimo';
      userWrap.appendChild(nameSpan);
      if (log.usuario_email) {
        const mailSpan = document.createElement('span');
        mailSpan.className = 'audit-user-email';
        mailSpan.textContent = log.usuario_email;
        userWrap.appendChild(mailSpan);
      }
      userCell.appendChild(userWrap);

      // Rol
      const roleCell = document.createElement('td');
      if (log.usuario_rol) {
        const roleBadge = document.createElement('span');
        roleBadge.className = `badge ${this.getRoleBadgeStyle(log.usuario_rol)}`;
        roleBadge.textContent = log.usuario_rol;
        roleCell.appendChild(roleBadge);
      } else {
        roleCell.textContent = '-';
      }

      // Acción, detalles e IP
      const actionCell = document.createElement('td');
      const actionTag = document.createElement('span');
      actionTag.className = 'audit-action-tag';
      actionTag.textContent = log.accion;
      actionCell.appendChild(actionTag);

      const detailCell = this.literalCell(log.detalles || '-', 'audit-detail');

      const ipCell = document.createElement('td');
      const ipCode = document.createElement('code');
      ipCode.className = 'audit-ip';
      ipCode.textContent = log.ip || 'sin registro';
      ipCell.appendChild(ipCode);

      tr.append(timeCell, userCell, roleCell, actionCell, detailCell, ipCell);
      tbody.appendChild(tr);
    });
  },

  /**
   * Errores del panel: si el rol perdió el acceso se regresa al portal.
   */
  handleAdminError(error, message) {
    if (error.status === 401) {
      Auth.logout(false);
      return;
    }
    if (error.status === 403) {
      showToast('Tu rol ya no tiene permiso para administrar el sistema', 'error');
      App.switchView('portal');
      return;
    }
    console.error(message + ':', error.message);
    showToast(message, 'error');
  },

  getRoleBadgeStyle(roleName) {
    switch (roleName) {
      case 'Administrador': return 'badge-admin';
      case 'Editor': return 'badge-editor';
      default: return 'badge-regular';
    }
  },

  formatRoleName(roleName) {
    return roleName === 'Usuario Regular' ? 'Lector' : roleName;
  },

  formatDate(isoString) {
    if (!isoString) return '';
    try {
      return new Date(isoString).toLocaleDateString('es-ES', {
        year: 'numeric',
        month: 'short',
        day: 'numeric'
      });
    } catch {
      return isoString;
    }
  },

  formatDateTime(isoString) {
    if (!isoString) return '';
    try {
      const d = new Date(isoString);
      return `${d.toLocaleDateString('es-ES')} ${d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
    } catch {
      return isoString;
    }
  }
};