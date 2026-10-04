/**
 * Módulo de Noticias: portal de lectura, filtros y operaciones CRUD
 */
const News = {
  currentCategory: 'Todas',
  searchQuery: '',
  articlesList: [],

  // Límites de la carga de imágenes: deben coincidir con los del servidor
  // (src/middleware/upload.js). Aquí solo se anticipa al usuario; la validación
  // que decide siempre es la del servidor.
  MAX_IMAGE_BYTES: 5 * 1024 * 1024,
  IMAGE_TYPES: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],

  init() {
    this.bindEvents();
    this.loadNews();
  },

  bindEvents() {
    // Filtros por Categoría
    const catButtons = document.querySelectorAll('.category-pill');
    catButtons.forEach(btn => {
      btn.addEventListener('click', (e) => {
        catButtons.forEach(b => b.classList.remove('active'));
        const targetBtn = e.currentTarget;
        targetBtn.classList.add('active');
        this.currentCategory = targetBtn.getAttribute('data-cat') || 'Todas';
        this.loadNews();
      });
    });

    // Búsqueda en Vivo
    const searchInput = document.getElementById('searchInput');
    const searchClearBtn = document.getElementById('searchClearBtn');

    if (searchInput) {
      let debounceTimer;
      searchInput.addEventListener('input', (e) => {
        clearTimeout(debounceTimer);
        const val = e.target.value.trim();
        if (searchClearBtn) searchClearBtn.style.display = val ? 'flex' : 'none';

        debounceTimer = setTimeout(() => {
          this.searchQuery = val;
          this.loadNews();
        }, 300);
      });
    }

    if (searchClearBtn && searchInput) {
      searchClearBtn.addEventListener('click', () => {
        searchInput.value = '';
        searchClearBtn.style.display = 'none';
        this.searchQuery = '';
        this.loadNews();
      });
    }

    // Botón Restablecer Filtros
    const btnResetFilters = document.getElementById('btnResetFilters');
    if (btnResetFilters) {
      btnResetFilters.addEventListener('click', () => {
        this.currentCategory = 'Todas';
        this.searchQuery = '';
        if (searchInput) searchInput.value = '';
        if (searchClearBtn) searchClearBtn.style.display = 'none';
        document.querySelectorAll('.category-pill').forEach(b => {
          b.classList.toggle('active', b.getAttribute('data-cat') === 'Todas');
        });
        this.loadNews();
      });
    }

    // Selector de imágenes de muestra
    const presetSelect = document.getElementById('articlePresetImg');
    const imgUrlInput = document.getElementById('articleImgUrl');
    if (presetSelect && imgUrlInput) {
      presetSelect.addEventListener('change', () => {
        if (presetSelect.value) {
          imgUrlInput.value = presetSelect.value;
          // Una imagen de muestra solo tiene sentido si no hay un archivo propio.
          this.resetImageFile();
        }
      });
    }

    // Carga de la imagen principal desde el equipo
    const imgFileInput = document.getElementById('articleImgFile');
    if (imgFileInput) {
      imgFileInput.addEventListener('change', (e) => this.handleImageSelected(e.target.files[0]));
    }

    const clearImgBtn = document.getElementById('btnClearArticleImg');
    if (clearImgBtn) {
      clearImgBtn.addEventListener('click', () => this.resetImageFile());
    }

    // Formulario de Noticia (Crear / Actualizar)
    const articleForm = document.getElementById('articleForm');
    if (articleForm) {
      articleForm.addEventListener('submit', (e) => this.handleSaveArticle(e));
    }

    /*
     * Delegación de eventos para las tarjetas de noticias.
     * Se usa data-action + data-id en lugar de atributos onclick en línea, de
     * modo que la CSP pueda mantenerse en script-src 'self' sin 'unsafe-inline'.
     */
    const newsGrid = document.getElementById('newsGrid');
    if (newsGrid) {
      newsGrid.addEventListener('click', (e) => {
        const target = e.target.closest('[data-action]');
        if (!target) return;
        const id = Number(target.getAttribute('data-id'));
        switch (target.getAttribute('data-action')) {
          case 'open-reader': this.openReader(id); break;
          case 'edit': this.openEditor(id); break;
          case 'delete': this.confirmDelete(id); break;
        }
      });
    }

    const heroReadBtn = document.getElementById('heroReadBtn');
    if (heroReadBtn) {
      heroReadBtn.addEventListener('click', () => {
        if (this.articlesList.length > 0) this.openReader(this.articlesList[0].id);
      });
    }
  },

  async loadNews() {
    // El contenido es un recurso protegido: sin sesión no se intenta siquiera.
    if (!Auth.currentUser) {
      this.renderGuestState();
      return;
    }

    // Si el rol perdió el permiso de lectura, la API lo rechaza con 403.
    if (!Auth.hasPermission('noticias.leer')) {
      this.renderNoPermission();
      return;
    }

    try {
      let endpoint = '/noticias?';
      if (this.currentCategory && this.currentCategory !== 'Todas') {
        endpoint += `categoria=${encodeURIComponent(this.currentCategory)}&`;
      }
      if (this.searchQuery) {
        endpoint += `search=${encodeURIComponent(this.searchQuery)}&`;
      }

      const articles = await API.get(endpoint);
      this.articlesList = articles;
      this.renderNews(articles);
    } catch (error) {
      if (error.status === 401) {
        await Auth.logout(false);
      } else if (error.status === 403) {
        this.renderNoPermission();
      } else {
        console.error('Error al cargar noticias:', error.message);
        showToast('No se pudieron cargar las noticias', 'error');
      }
    }
  },

  /**
   * Estado para visitantes sin sesión: el contenido no se descarga de la API.
   */
  renderGuestState() {
    const featuredHero = document.getElementById('featuredHero');
    const newsGrid = document.getElementById('newsGrid');
    const emptyState = document.getElementById('emptyState');
    const newsCountBadge = document.getElementById('newsCountBadge');
    const categoriesBar = document.getElementById('categoriesBar');

    this.articlesList = [];
    if (featuredHero) featuredHero.style.display = 'none';
    if (categoriesBar) categoriesBar.style.display = 'none';
    if (newsCountBadge) newsCountBadge.textContent = 'Contenido restringido';
    if (newsGrid) newsGrid.innerHTML = '';

    if (emptyState) {
      emptyState.style.display = 'block';
      emptyState.innerHTML = `
        <div class="empty-icon"><i class="fa-solid fa-lock"></i></div>
        <h3>Contenido exclusivo para usuarios registrados</h3>
        <p>Las noticias de la Gaceta Universitaria requieren una sesión activa. Inicia sesión o crea una cuenta de lector para consultar el contenido.</p>
        <button class="btn btn-primary" data-action="guest-login">Iniciar Sesión</button>
        <button class="btn btn-outline" data-action="guest-register">Crear Cuenta de Lector</button>
      `;
      emptyState.onclick = (e) => {
        const action = e.target.getAttribute('data-action');
        if (action === 'guest-login') App.openModal('modalLogin');
        if (action === 'guest-register') App.openModal('modalRegister');
      };
    }
  },

  /**
   * El usuario está autenticado pero su rol no incluye noticias.leer.
   */
  renderNoPermission() {
    const featuredHero = document.getElementById('featuredHero');
    const newsGrid = document.getElementById('newsGrid');
    const emptyState = document.getElementById('emptyState');
    const newsCountBadge = document.getElementById('newsCountBadge');

    this.articlesList = [];
    if (featuredHero) featuredHero.style.display = 'none';
    if (newsGrid) newsGrid.innerHTML = '';
    if (newsCountBadge) newsCountBadge.textContent = 'Sin permiso de lectura';

    if (emptyState) {
      emptyState.style.display = 'block';
      emptyState.innerHTML = `
        <div class="empty-icon"><i class="fa-solid fa-ban"></i></div>
        <h3>Tu rol no tiene permiso de lectura</h3>
        <p>El permiso <code>noticias.leer</code> fue revocado de tu rol por el administrador. La misma regla se aplica en el servidor.</p>
      `;
    }
  },

  renderNews(articles) {
    const featuredHero = document.getElementById('featuredHero');
    const newsGrid = document.getElementById('newsGrid');
    const emptyState = document.getElementById('emptyState');
    const newsCountBadge = document.getElementById('newsCountBadge');

    if (newsCountBadge) {
      newsCountBadge.textContent = `${articles.length} ${articles.length === 1 ? 'artículo' : 'artículos'}`;
    }

    if (!articles || articles.length === 0) {
      if (featuredHero) featuredHero.style.display = 'none';
      if (newsGrid) newsGrid.innerHTML = '';
      if (emptyState) {
        emptyState.style.display = 'block';
        emptyState.innerHTML = `
          <div class="empty-icon"><i class="fa-regular fa-newspaper"></i></div>
          <h3>No se encontraron publicaciones</h3>
          <p>No hay artículos disponibles para el criterio o categoría seleccionada.</p>
        `;
        const btn = document.createElement('button');
        btn.className = 'btn btn-outline';
        btn.id = 'btnResetFilters';
        btn.textContent = 'Ver Todas las Noticias';
        btn.addEventListener('click', () => {
          this.currentCategory = 'Todas';
          this.searchQuery = '';
          const searchInput = document.getElementById('searchInput');
          if (searchInput) searchInput.value = '';
          document.querySelectorAll('.category-pill').forEach(b => {
            b.classList.toggle('active', b.getAttribute('data-cat') === 'Todas');
          });
          this.loadNews();
        });
        emptyState.appendChild(btn);
      }
      return;
    }

    if (emptyState) {
      emptyState.style.display = 'none';
      emptyState.innerHTML = '';
    }

    // 1. Noticia Principal (Destacada)
    if (!this.searchQuery && this.currentCategory === 'Todas' && articles.length > 0) {
      const heroArticle = articles[0];
      if (featuredHero) {
        featuredHero.style.display = 'grid';
        const heroImg = document.getElementById('heroImage');
        const heroCat = document.getElementById('heroCategory');
        const heroTitle = document.getElementById('heroTitle');
        const heroExcerpt = document.getElementById('heroExcerpt');
        const heroAuthor = document.getElementById('heroAuthor');

        if (heroImg) heroImg.style.backgroundImage = `url("${encodeURI(heroArticle.imagen_url || '')}")`;
        if (heroCat) heroCat.textContent = heroArticle.categoria;
        if (heroTitle) heroTitle.textContent = heroArticle.titulo;
        if (heroExcerpt) heroExcerpt.textContent = heroArticle.contenido;
        if (heroAuthor) {
          heroAuthor.replaceChildren();
          const icon = document.createElement('i');
          icon.className = 'fa-solid fa-user-pen';
          heroAuthor.append(icon, document.createTextNode(` ${heroArticle.autor_nombre || ''}`));
        }
      }
    } else if (featuredHero) {
      featuredHero.style.display = 'none';
    }

    // 2. Renderizar Cuadrícula de Noticias
    if (newsGrid) {
      const canEdit = Auth.hasPermission('noticias.editar');
      const canDelete = Auth.hasPermission('noticias.eliminar');

      // Si hay hero visible, omitir el primer elemento de la cuadrícula
      const itemsToRender = (!this.searchQuery && this.currentCategory === 'Todas' && articles.length > 1)
        ? articles.slice(1)
        : articles;

      newsGrid.replaceChildren();
      itemsToRender.forEach(item => {
        newsGrid.appendChild(this.buildCard(item, canEdit, canDelete));
      });
    }
  },

  /**
   * Construye una tarjeta de noticia con nodos del DOM y textContent.
   * No se inyecta HTML con datos del servidor, de modo que un contenido
   * malicioso almacenado en la base de datos no puede ejecutarse en el cliente.
   */
  buildCard(item, canEdit, canDelete) {
    const isAuthorOrAdmin = Auth.currentUser && (Auth.currentUser.nombre_rol === 'Administrador' || Auth.currentUser.id === item.id_autor);
    const showEditBtn = canEdit && isAuthorOrAdmin;
    const showDeleteBtn = canDelete && isAuthorOrAdmin;

    const card = document.createElement('article');
    card.className = 'article-card';
    card.setAttribute('data-id', item.id);

    // --- Medio con imagen y acciones ---
    const media = document.createElement('div');
    media.className = 'article-card-media';

    const img = document.createElement('img');
    img.className = 'article-card-img';
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    img.src = item.imagen_url || '';
    img.alt = item.titulo || '';
    media.appendChild(img);

    const badge = document.createElement('span');
    badge.className = 'badge badge-category-overlay';
    badge.textContent = item.categoria;
    media.appendChild(badge);

    if (showEditBtn || showDeleteBtn) {
      const actions = document.createElement('div');
      actions.className = 'card-admin-actions';

      if (showEditBtn) {
        const editBtn = document.createElement('button');
        editBtn.className = 'btn-card-icon edit';
        editBtn.type = 'button';
        editBtn.title = 'Editar Noticia';
        editBtn.setAttribute('data-action', 'edit');
        editBtn.setAttribute('data-id', item.id);
        editBtn.innerHTML = '<i class="fa-solid fa-pen-to-square"></i>';
        actions.appendChild(editBtn);
      }

      if (showDeleteBtn) {
        const delBtn = document.createElement('button');
        delBtn.className = 'btn-card-icon delete';
        delBtn.type = 'button';
        delBtn.title = 'Eliminar Noticia';
        delBtn.setAttribute('data-action', 'delete');
        delBtn.setAttribute('data-id', item.id);
        delBtn.innerHTML = '<i class="fa-solid fa-trash-can"></i>';
        actions.appendChild(delBtn);
      }

      media.appendChild(actions);
    }

    // --- Cuerpo ---
    const body = document.createElement('div');
    body.className = 'article-card-body';

    const date = document.createElement('div');
    date.className = 'article-card-date';
    date.appendChild(Object.assign(document.createElement('i'), { className: 'fa-regular fa-calendar' }));
    date.appendChild(document.createTextNode(` ${this.formatDate(item.fecha_creacion)}`));

    const title = document.createElement('h4');
    title.className = 'article-card-title article-card-title-link';
    title.textContent = item.titulo;
    title.setAttribute('data-action', 'open-reader');
    title.setAttribute('data-id', item.id);

    const excerpt = document.createElement('p');
    excerpt.className = 'article-card-text';
    excerpt.textContent = item.contenido;

    const footer = document.createElement('div');
    footer.className = 'article-card-footer';

    const author = document.createElement('div');
    author.className = 'article-card-author';
    author.appendChild(Object.assign(document.createElement('i'), { className: 'fa-solid fa-user-pen' }));
    const authorName = document.createElement('span');
    authorName.textContent = item.autor_nombre || '';
    author.appendChild(authorName);

    const readMore = document.createElement('button');
    readMore.className = 'btn-read-more';
    readMore.type = 'button';
    readMore.setAttribute('data-action', 'open-reader');
    readMore.setAttribute('data-id', item.id);
    readMore.textContent = 'Leer ';
    readMore.appendChild(Object.assign(document.createElement('i'), { className: 'fa-solid fa-arrow-right' }));

    footer.append(author, readMore);
    body.append(date, title, excerpt, footer);
    card.append(media, body);

    return card;
  },

  async openReader(id) {
    try {
      const article = await API.get(`/noticias/${id}`);
      const modal = document.getElementById('modalArticleReader');
      if (!modal) return;

      const img = document.getElementById('readerImg');
      img.src = article.imagen_url || '';
      img.referrerPolicy = 'no-referrer';

      document.getElementById('readerCategory').textContent = article.categoria;
      document.getElementById('readerTitle').textContent = article.titulo;

      const readerDate = document.getElementById('readerDate');
      readerDate.replaceChildren();
      readerDate.appendChild(Object.assign(document.createElement('i'), { className: 'fa-regular fa-calendar' }));
      readerDate.appendChild(document.createTextNode(` ${this.formatDate(article.fecha_creacion)}`));

      const readerAuthor = document.getElementById('readerAuthor');
      readerAuthor.replaceChildren();
      readerAuthor.appendChild(Object.assign(document.createElement('i'), { className: 'fa-solid fa-user-pen' }));
      readerAuthor.appendChild(document.createTextNode(
        ` ${article.autor_nombre || ''} (${article.autor_rol === 'Usuario Regular' ? 'Lector' : article.autor_rol || ''})`
      ));

      // textContent: el cuerpo del artículo nunca se interpreta como HTML.
      document.getElementById('readerContent').textContent = article.contenido;

      App.openModal('modalArticleReader');
    } catch (error) {
      if (error.status === 403) {
        showToast('Tu rol no tiene permiso para leer noticias', 'error');
      } else {
        showToast('Error al abrir el artículo', 'error');
      }
    }
  },

  openEditor(id = null) {
    const canCreate = Auth.hasPermission('noticias.crear');
    const canEdit = Auth.hasPermission('noticias.editar');

    if (id ? !canEdit : !canCreate) {
      showToast('No tienes permiso para publicar ni editar noticias', 'error');
      return;
    }

    const modal = document.getElementById('modalArticleEditor');
    const form = document.getElementById('articleForm');
    const titleHeader = document.getElementById('editorModalTitle');
    const editIdInput = document.getElementById('editArticleId');
    if (!modal || !form) return;

    form.reset();
    this.resetImageFile();

    if (id) {
      const item = this.articlesList.find(a => a.id === id);
      if (!item) return;

      titleHeader.innerHTML = '<i class="fa-solid fa-pen-nib"></i> Editar Noticia';
      editIdInput.value = item.id;
      document.getElementById('articleTitle').value = item.titulo;
      document.getElementById('articleCategory').value = item.categoria;
      document.getElementById('articleImgUrl').value = item.imagen_url;
      document.getElementById('articleContent').value = item.contenido;
    } else {
      titleHeader.innerHTML = '<i class="fa-solid fa-pen-nib"></i> Redactar Noticia';
      editIdInput.value = '';
    }

    App.openModal('modalArticleEditor');
  },

  /**
   * Muestra la vista previa del archivo elegido y avisa de inmediato si el
   * formato o el tamaño no son aceptados, sin esperar al servidor.
   */
  handleImageSelected(file) {
    const area = document.getElementById('articleUploadArea');
    const preview = document.getElementById('articleImgPreview');
    const hint = document.getElementById('articleUploadHint');
    if (!area || !preview) return;

    if (!file) {
      this.resetImageFile();
      return;
    }

    const esFormatoValido = this.IMAGE_TYPES.includes(file.type);
    const maxMb = this.MAX_IMAGE_BYTES / (1024 * 1024);

    if (!esFormatoValido) {
      area.classList.add('has-error');
      hint.textContent = 'Ese archivo no es una imagen. Usa JPG, PNG, WEBP o GIF.';
      hint.classList.add('error');
      this.clearImageInput();
      return;
    }

    if (file.size > this.MAX_IMAGE_BYTES) {
      area.classList.add('has-error');
      hint.textContent = `La imagen pesa ${(file.size / (1024 * 1024)).toFixed(1)} MB y el máximo es ${maxMb} MB.`;
      hint.classList.add('error');
      this.clearImageInput();
      return;
    }

    area.classList.remove('has-error');
    hint.classList.remove('error');
    hint.textContent = 'JPG, PNG, WEBP o GIF. Máximo 5 MB.';
    area.classList.add('has-file');

    document.getElementById('articleImgPreviewName').textContent = file.name;
    document.getElementById('articleImgPreviewSize').textContent =
      `${(file.size / 1024).toFixed(0)} KB`;

    // La vista previa se lee como data URL porque la CSP permite img-src data:
    // así no hace falta permitir blob: ni subir nada para poder revisarla.
    const imgPreview = document.getElementById('articleImgPreviewImg');
    const reader = new FileReader();
    reader.onload = () => {
      imgPreview.src = reader.result;
      preview.hidden = false;
    };
    reader.onerror = () => {
      showToast('No se pudo leer la imagen seleccionada', 'error');
      this.resetImageFile();
    };
    reader.readAsDataURL(file);
  },

  clearImageInput() {
    const input = document.getElementById('articleImgFile');
    if (input) input.value = '';
  },

  /** Vuelve al estado inicial del selector: sin archivo y sin vista previa. */
  resetImageFile() {
    const area = document.getElementById('articleUploadArea');
    const preview = document.getElementById('articleImgPreview');
    const hint = document.getElementById('articleUploadHint');

    this.clearImageInput();

    if (preview) {
      preview.hidden = true;
      const img = document.getElementById('articleImgPreviewImg');
      if (img) img.removeAttribute('src');
    }
    if (area) area.classList.remove('has-file', 'has-error');
    if (hint) {
      hint.classList.remove('error');
      hint.textContent = 'JPG, PNG, WEBP o GIF. Máximo 5 MB.';
    }
  },

  async handleSaveArticle(e) {
    e.preventDefault();
    const editId = document.getElementById('editArticleId').value;
    const titulo = document.getElementById('articleTitle').value.trim();
    const categoria = document.getElementById('articleCategory').value;
    const imagen_url = document.getElementById('articleImgUrl').value.trim();
    const contenido = document.getElementById('articleContent').value.trim();
    const archivo = document.getElementById('articleImgFile').files[0];

    if (!titulo || !contenido) {
      showToast('Por favor completa todos los campos requeridos', 'warning');
      return;
    }

    const submitBtn = document.getElementById('btnSaveArticle');
    submitBtn.disabled = true;
    submitBtn.innerHTML = archivo
      ? '<i class="fa-solid fa-spinner fa-spin"></i> Subiendo imagen...'
      : '<i class="fa-solid fa-spinner fa-spin"></i> Guardando...';

    try {
      if (archivo) {
        // Con archivo hay que enviar multipart/form-data; el texto viaja en el
        // mismo FormData y el servidor decide que la imagen prevalece.
        const datos = new FormData();
        datos.append('titulo', titulo);
        datos.append('categoria', categoria);
        datos.append('contenido', contenido);
        if (imagen_url) datos.append('imagen_url', imagen_url);
        datos.append('imagen', archivo, archivo.name);

        if (editId) {
          await API.putForm(`/noticias/${editId}`, datos);
          showToast('Noticia actualizada exitosamente', 'success');
        } else {
          await API.postForm('/noticias', datos);
          showToast('Noticia publicada con éxito', 'success');
        }
      } else if (editId) {
        await API.put(`/noticias/${editId}`, { titulo, categoria, imagen_url, contenido });
        showToast('Noticia actualizada exitosamente', 'success');
      } else {
        await API.post('/noticias', { titulo, categoria, imagen_url, contenido });
        showToast('Noticia publicada con éxito', 'success');
      }

      App.closeModal('modalArticleEditor');
      await this.loadNews();
    } catch (error) {
      if (error.status === 403) {
        showToast('El servidor denegó la operación: tu rol no tiene el permiso requerido', 'error');
      } else {
        showToast(error.message || 'Error al guardar la noticia', 'error');
      }
    } finally {
      submitBtn.disabled = false;
      submitBtn.innerHTML = editId ? 'Guardar Cambios' : 'Publicar Noticia';
    }
  },

  async confirmDelete(id) {
    if (!confirm('¿Deseas eliminar este artículo? Esta acción quedará asentada en la bitácora de auditoría.')) {
      return;
    }

    try {
      await API.delete(`/noticias/${id}`);
      showToast('Noticia eliminada correctamente', 'info');
      await this.loadNews();
    } catch (error) {
      if (error.status === 403) {
        showToast('El servidor denegó la eliminación: tu rol no tiene el permiso requerido', 'error');
      } else {
        showToast(error.message || 'Error al eliminar noticia', 'error');
      }
    }
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
  }
};