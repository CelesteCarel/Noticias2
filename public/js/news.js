/**
 * Módulo de Noticias: portal de lectura, filtros y operaciones CRUD
 */
const News = {
  currentCategory: 'Todas',
  searchQuery: '',
  articlesList: [],
  modalPreviewMode: 'guest',
  currentEditingArticle: null,
  teaserConfig: null,

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
          this.resetImageFile();
          this.updateModalLivePreview();
        }
      });
    }

    // Carga de la imagen principal desde el equipo (click o arrastrar y soltar)
    const imgFileInput = document.getElementById('articleImgFile');
    const uploadArea = document.getElementById('articleUploadArea');
    if (imgFileInput) {
      imgFileInput.addEventListener('change', (e) => {
        if (e.target.files && e.target.files[0]) {
          this.handleImageSelected(e.target.files[0]);
        }
      });
    }

    if (uploadArea) {
      ['dragenter', 'dragover'].forEach(eventName => {
        uploadArea.addEventListener(eventName, (e) => {
          e.preventDefault();
          e.stopPropagation();
          uploadArea.classList.add('drag-over');
        });
      });

      ['dragleave', 'drop'].forEach(eventName => {
        uploadArea.addEventListener(eventName, (e) => {
          e.preventDefault();
          e.stopPropagation();
          uploadArea.classList.remove('drag-over');
        });
      });

      uploadArea.addEventListener('drop', (e) => {
        if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
          const file = e.dataTransfer.files[0];
          if (imgFileInput) {
            // Asignar el DataTransfer al input file para que viaje en FormData
            try {
              const dt = new DataTransfer();
              dt.items.add(file);
              imgFileInput.files = dt.files;
            } catch (err) {
              console.warn('DataTransfer no soportado para asignar input files:', err);
            }
          }
          this.handleImageSelected(file);
        }
      });
    }

    const clearImgBtn = document.getElementById('btnClearArticleImg');
    if (clearImgBtn) {
      clearImgBtn.addEventListener('click', () => {
        this.resetImageFile();
        this.updateModalLivePreview();
      });
    }

    // Controles en vivo del modal de edición
    const modalLiveInputs = ['articleTitle', 'articleCategory', 'articleImgUrl', 'articleContent', 'articleIsPortada'];
    modalLiveInputs.forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        el.addEventListener('input', () => this.updateModalLivePreview());
        el.addEventListener('change', () => this.updateModalLivePreview());
      }
    });

    const blurSlider = document.getElementById('articleBlurSlider');
    const blurBadge = document.getElementById('articleBlurPercentBadge');
    if (blurSlider) {
      blurSlider.addEventListener('input', (e) => {
        if (blurBadge) blurBadge.textContent = `${e.target.value}% Visible`;
        this.updateModalLivePreview();
      });
    }

    const btnModalGuest = document.getElementById('btnModalPreviewGuest');
    const btnModalAuth = document.getElementById('btnModalPreviewAuth');
    if (btnModalGuest && btnModalAuth) {
      btnModalGuest.addEventListener('click', () => {
        this.modalPreviewMode = 'guest';
        btnModalGuest.classList.add('active');
        btnModalAuth.classList.remove('active');
        this.updateModalLivePreview();
      });
      btnModalAuth.addEventListener('click', () => {
        this.modalPreviewMode = 'auth';
        btnModalAuth.classList.add('active');
        btnModalGuest.classList.remove('active');
        this.updateModalLivePreview();
      });
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
      if (!this.teaserConfig) {
        await this.loadTeaserConfig();
      }
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
   * Configuración de la noticia de portada (Teaser para invitados / fija).
   */
  teaserConfig: null,

  DEFAULT_GOSSIP_ARTICLE: {
    image: '/img/escandalo-drogas.jpg',
    badge: 'Escándalo Universitario',
    categoria: 'Escándalo Universitario',
    date: 'Hace 3 horas',
    author: 'Redacción Gaceta',
    title: 'EXCLUSIVA: Alumno del Campus I es descubierto bajo efectos de sustancias durante el examen final — seguridad lo retiró del aula ante el asombro de compañeros y maestros',
    visibleText: 'Lo que prometía ser un examen final rutinario de Bases de Datos en el Departamento de Tecnologías Digitales se convirtió esta mañana en uno de los episodios más insólitos en la historia reciente del campus. Alrededor de las 9:40 de la mañana, el alumno Cristian Alejandro Vargas Torres, de séptimo semestre, comenzó a mostrar un comportamiento errático dentro del aula: hablaba solo, se reía sin motivo aparente y en un momento intentó responder el examen con un plumón rojo que sacó de su mochila. La maestra titular, Dra. Patricia Leal, optó por detener la evaluación y llamar al personal de seguridad del plantel.',
    blurredText: [
      'Según testigos presenciales, Vargas Torres habría llegado al examen ya en un estado alterado desde el momento en que cruzó la puerta. "Se veía raro desde que entró, pero nadie dijo nada porque pensamos que era de los nervios", declaró una compañera de clase que pidió guardar el anonimato. Las cámaras del pasillo exterior captaron al estudiante consumiendo una sustancia no identificada en el baño del segundo piso aproximadamente 20 minutos antes del inicio del examen.',
      'El personal de seguridad llegó al aula en menos de cinco minutos y, tras una breve conversación, Vargas Torres fue retirado del salón entre risas propias y el silencio atónito del resto del grupo. La Dra. Leal optó por suspender la evaluación para todos los presentes y reprogramarla para la siguiente semana. Mientras tanto, el alumno fue trasladado a la enfermería del plantel, donde se confirmó que presentaba signos evidentes de intoxicación.',
      'Fuentes internas del Departamento de Orientación Educativa señalaron que el caso ya fue turnado al Comité Disciplinario y que podría derivar en una suspensión temporal o, dependiendo de los resultados de los análisis clínicos solicitados, en una baja definitiva. El coordinador de la carrera emitió un breve comunicado interno pidiendo "discreción y respeto hacia el alumno involucrado", aunque para ese momento el video grabado por un compañero desde la última fila ya circulaba en todos los grupos de WhatsApp del campus.'
    ]
  },

  /**
   * Carga la configuración del teaser desde el servidor.
   */
  async loadTeaserConfig() {
    try {
      const data = await API.get('/noticias/portada-teaser');
      if (data && data.title) {
        this.teaserConfig = data;
      } else {
        this.teaserConfig = this.DEFAULT_GOSSIP_ARTICLE;
      }
    } catch (e) {
      this.teaserConfig = this.DEFAULT_GOSSIP_ARTICLE;
    }
    return this.teaserConfig;
  },

  /**
   * Construye el bloque de la noticia de chisme / portada.
   * @param {boolean} blurred - true = visitante sin sesión (con blur y CTA), false = autenticado (completo)
   */
  buildGossipCard(blurred) {
    const g = this.teaserConfig || this.DEFAULT_GOSSIP_ARTICLE;
    const wrapper = document.createElement('div');
    wrapper.className = 'guest-teaser-wrapper';

    const blurredList = Array.isArray(g.blurredText) 
      ? g.blurredText 
      : (typeof g.blurredText === 'string' ? g.blurredText.split('\n\n') : []);

    const blurredParas = blurredList.map(t => `<p>${t}</p>`).join('');
    const overlayHtml = blurred ? `
      <div class="guest-teaser-overlay">
        <div class="guest-teaser-lock">
          <div class="lock-icon-wrap"><i class="fa-solid fa-lock"></i></div>
          <h3>¿Quieres saber el desenlace?</h3>
          <p>Regístrate gratis o inicia sesión para leer la nota completa y acceder a todas las noticias de la Gaceta Universitaria.</p>
          <div class="guest-cta-buttons">
            <button class="btn btn-primary btn-cta-guest" data-action="guest-login">
              <i class="fa-solid fa-arrow-right-to-bracket"></i> Iniciar Sesión
            </button>
            <button class="btn btn-outline btn-cta-guest" data-action="guest-register">
              <i class="fa-solid fa-user-plus"></i> Crear Cuenta Gratis
            </button>
          </div>
        </div>
      </div>` : '';

    const badgeText = g.badge || g.categoria || 'Escándalo Universitario';
    const imgSrc = g.image || '/img/escandalo-drogas.jpg';

    // Regla de ÚLTIMA HORA: Solo si fue creada hace <= 1 hora
    const isUltimaHora = g.is_ultima_hora !== undefined
      ? g.is_ultima_hora
      : (g.date ? ((Date.now() - new Date(g.date).getTime()) <= 3600000 && (Date.now() - new Date(g.date).getTime()) >= 0) : false);

    const breakingHtml = isUltimaHora ? `
      <div class="guest-teaser-breaking">
        <span class="breaking-dot"></span>
        ÚLTIMA HORA
      </div>` : '';

    const canEditGossip = !blurred && Auth.currentUser && (
      Auth.currentUser.nombre_rol === 'Administrador' || 
      Auth.currentUser.nombre_rol === 'Editor' || 
      Auth.hasPermission('noticias.editar')
    );

    const adminBarHtml = canEditGossip ? `
      <div class="guest-teaser-admin-bar">
        <button class="btn btn-outline btn-sm btn-teaser-edit-direct" data-action="edit-teaser" type="button">
          <i class="fa-solid fa-pen-to-square"></i> Editar Noticia / Censura
        </button>
      </div>` : '';

    const displayDate = isUltimaHora 
      ? 'Hace menos de 1 hora' 
      : (g.date ? (typeof g.date === 'string' && g.date.includes('T') ? this.formatDate(g.date) : g.date) : 'Reciente');

    wrapper.innerHTML = `
      <div class="guest-teaser-hero">
        <div class="guest-teaser-image">
          <img src="${imgSrc}" alt="${g.title || 'Noticia'}" class="guest-teaser-real-img" onerror="this.src='/img/escandalo-drogas.jpg'" />
          <span class="badge badge-category guest-teaser-badge">${badgeText}</span>
          ${breakingHtml}
        </div>
        <div class="guest-teaser-content">
          <div class="guest-teaser-meta">
            <span><i class="fa-regular fa-clock"></i> ${displayDate}</span>
            <span><i class="fa-solid fa-user-pen"></i> ${g.author || 'Redacción Gaceta'}</span>
          </div>
          <h2 class="guest-teaser-title">${g.title}</h2>
          <div class="guest-teaser-text-wrap">
            <p class="guest-teaser-visible">${g.visibleText}</p>
            <div class="guest-teaser-blurred${blurred ? '' : ' unblurred'}">
              ${blurredParas}
            </div>
            ${overlayHtml}
          </div>
          ${adminBarHtml}
        </div>
      </div>
    `;

    wrapper.addEventListener('click', (e) => {
      const action = e.target.closest('[data-action]');
      if (!action) return;
      const act = action.getAttribute('data-action');
      if (act === 'guest-login') App.openModal('modalLogin');
      if (act === 'guest-register') App.openModal('modalRegister');
      if (act === 'edit-teaser') {
        if (g.id) {
          News.openEditor(g.id);
        } else if (News.articlesList.length > 0) {
          const scandal = News.articlesList.find(a => a.categoria === 'Escándalo Universitario' || a.es_portada === 1);
          News.openEditor(scandal ? scandal.id : News.articlesList[0].id);
        } else {
          News.openEditor();
        }
      }
    });

    return wrapper;
  },

  /**
   * Estado para visitantes sin sesión: muestra la noticia de chisme con blur.
   */
  async renderGuestState() {
    const featuredHero = document.getElementById('featuredHero');
    const newsGrid = document.getElementById('newsGrid');
    const emptyState = document.getElementById('emptyState');
    const newsCountBadge = document.getElementById('newsCountBadge');
    const categoriesBar = document.getElementById('categoriesBar');

    this.articlesList = [];
    if (categoriesBar) categoriesBar.style.display = 'none';
    if (newsCountBadge) newsCountBadge.textContent = 'Inicia sesión para ver todas las noticias';
    if (featuredHero) featuredHero.style.display = 'none';
    if (emptyState) emptyState.style.display = 'none';

    if (!this.teaserConfig) {
      await this.loadTeaserConfig();
    }

    if (newsGrid) {
      newsGrid.innerHTML = '';
      newsGrid.appendChild(this.buildGossipCard(true));
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

    // La noticia principal destacada es la de Escándalo / Portada. Ocultamos el hero anterior para que el escándalo lidere siempre.
    if (featuredHero) {
      featuredHero.style.display = 'none';
    }

    // 2. Renderizar Cuadrícula de Noticias
    if (newsGrid) {
      const canEdit = Auth.hasPermission('noticias.editar');
      const canDelete = Auth.hasPermission('noticias.eliminar');

      newsGrid.replaceChildren();

      // Separar la noticia fijada del resto
      const featuredItem = articles.find(a => a.es_portada === 1 || a.es_portada === '1');
      const restItems = articles.filter(a => a !== featuredItem);

      // La noticia fijada va primero en grande (ocupa todo el ancho)
      if (featuredItem) {
        newsGrid.appendChild(this.buildFeaturedHeroCard(featuredItem, canEdit, canDelete));
      }

      // El resto se muestra en la cuadrícula normal
      restItems.forEach(item => {
        newsGrid.appendChild(this.buildCard(item, canEdit, canDelete));
      });
    }
  },

  /**
   * Construye la tarjeta principal de la noticia fijada (full-width, estilo héroe).
   */
  buildFeaturedHeroCard(item, canEdit, canDelete) {
    const isAuthorOrAdmin = Auth.currentUser && (
      Auth.currentUser.nombre_rol === 'Administrador' ||
      Auth.currentUser.nombre_rol === 'Editor' ||
      Auth.currentUser.id === item.id_autor ||
      Auth.hasPermission('noticias.editar')
    );
    const showEditBtn = canEdit && isAuthorOrAdmin;
    const showDeleteBtn = canDelete && (Auth.currentUser && (Auth.currentUser.nombre_rol === 'Administrador' || Auth.currentUser.id === item.id_autor));

    const isScandal = item.categoria && item.categoria.toLowerCase().includes('esc');

    const card = document.createElement('article');
    card.className = 'article-card article-card-featured' + (isScandal ? ' article-card-scandal' : '');
    card.setAttribute('data-id', item.id);

    // Pin badge
    const pinnedBadge = document.createElement('div');
    pinnedBadge.className = 'featured-pin-badge';
    pinnedBadge.innerHTML = '<i class="fa-solid fa-thumbtack"></i> Noticia Principal';
    card.appendChild(pinnedBadge);

    // Imagen
    const media = document.createElement('div');
    media.className = 'article-card-media article-card-featured-media';

    const img = document.createElement('img');
    img.className = 'article-card-img';
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    img.src = item.imagen_url || '';
    img.alt = item.titulo || '';
    media.appendChild(img);

    const badge = document.createElement('span');
    badge.className = 'badge badge-category-overlay' + (isScandal ? ' badge-scandal' : '');
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

    // Cuerpo
    const body = document.createElement('div');
    body.className = 'article-card-body article-card-featured-body';

    const date = document.createElement('div');
    date.className = 'article-card-date';
    date.appendChild(Object.assign(document.createElement('i'), { className: 'fa-regular fa-calendar' }));
    date.appendChild(document.createTextNode(` ${this.formatDate(item.fecha_creacion)}`));

    const titleEl = document.createElement('h2');
    titleEl.className = 'article-card-title article-card-title-link article-card-featured-title';
    titleEl.textContent = item.titulo;
    titleEl.setAttribute('data-action', 'open-reader');
    titleEl.setAttribute('data-id', item.id);

    const excerpt = document.createElement('p');
    excerpt.className = 'article-card-text article-card-featured-text';
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
    readMore.innerHTML = 'Leer artículo completo <i class="fa-solid fa-arrow-right"></i>';

    footer.append(author, readMore);
    body.append(date, titleEl, excerpt, footer);
    card.append(media, body);

    return card;
  },

  /**
   * Construye una tarjeta de noticia con nodos del DOM y textContent.
   * No se inyecta HTML con datos del servidor, de modo que un contenido
   * malicioso almacenado en la base de datos no puede ejecutarse en el cliente.
   */
  buildCard(item, canEdit, canDelete) {
    const isAuthorOrAdmin = Auth.currentUser && (
      Auth.currentUser.nombre_rol === 'Administrador' || 
      Auth.currentUser.nombre_rol === 'Editor' || 
      Auth.currentUser.id === item.id_autor || 
      Auth.hasPermission('noticias.editar')
    );
    const showEditBtn = canEdit && isAuthorOrAdmin;
    const showDeleteBtn = canDelete && (Auth.currentUser && (Auth.currentUser.nombre_rol === 'Administrador' || Auth.currentUser.id === item.id_autor));

    const card = document.createElement('article');
    card.className = 'article-card';
    card.setAttribute('data-id', item.id);

    const isScandal = item.categoria && item.categoria.toLowerCase().includes('esc');
    if (isScandal) {
      card.classList.add('article-card-scandal');
    }

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
    if (isScandal) {
      badge.classList.add('badge-scandal');
    }
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

  async openEditor(id = null) {
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

    const slider = document.getElementById('articleBlurSlider');
    const badge = document.getElementById('articleBlurPercentBadge');
    const isPortadaCheck = document.getElementById('articleIsPortada');

    if (id) {
      let item = this.articlesList.find(a => a.id === id);
      if (!item) {
        try {
          item = await API.get(`/noticias/${id}`);
        } catch (e) {
          showToast('No se pudo cargar la información de la noticia', 'error');
          return;
        }
      }
      this.currentEditingArticle = item;

      titleHeader.innerHTML = '<i class="fa-solid fa-pen-nib"></i> Editar Noticia';
      editIdInput.value = item.id;
      document.getElementById('articleTitle').value = item.titulo || '';
      document.getElementById('articleCategory').value = item.categoria || 'Escándalo Universitario';
      document.getElementById('articleImgUrl').value = item.imagen_url || '';
      document.getElementById('articleContent').value = item.contenido || '';

      const percent = item.porcentaje_censura || 30;
      if (slider) slider.value = percent;
      if (badge) badge.textContent = `${percent}% Visible`;
      if (isPortadaCheck) isPortadaCheck.checked = item.es_portada == 1;
    } else {
      this.currentEditingArticle = null;
      titleHeader.innerHTML = '<i class="fa-solid fa-pen-nib"></i> Redactar Noticia';
      editIdInput.value = '';
      document.getElementById('articleCategory').value = 'Escándalo Universitario';
      if (slider) slider.value = 30;
      if (badge) badge.textContent = '30% Visible';
      if (isPortadaCheck) isPortadaCheck.checked = false;
    }

    this.updateModalLivePreview();
    App.openModal('modalArticleEditor');
  },

  /**
   * Actualiza la vista previa en vivo dentro del modal de redacción / edición.
   * Divide dinámicamente el texto según el porcentaje del slider y aplica la regla de última hora.
   */
  updateModalLivePreview() {
    const previewStage = document.getElementById('articleModalLivePreview');
    if (!previewStage) return;

    const title = document.getElementById('articleTitle')?.value.trim() || 'Título de la Noticia';
    const categoria = document.getElementById('articleCategory')?.value || 'Escándalo Universitario';
    // Prioridad de imagen: archivo local seleccionado > campo URL > imagen previa del artículo > imagen por defecto
    const image = this.selectedImageBase64 
      || document.getElementById('articleImgUrl')?.value.trim() 
      || this.currentEditingArticle?.imagen_url 
      || '/img/escandalo-drogas.jpg';

    const content = document.getElementById('articleContent')?.value || 'Escribe aquí el contenido completo del artículo para previsualizar el recorte y censura en tiempo real.';
    const percent = Number(document.getElementById('articleBlurSlider')?.value) || 30;
    const isBlurredMode = this.modalPreviewMode === 'guest';

    // División exacta del texto según el slider de porcentaje (10% a 90%)
    const p = Math.min(Math.max(percent, 10), 90);
    const cutIndex = Math.floor((content.length * p) / 100);

    let naturalCut = content.indexOf(' ', cutIndex);
    if (naturalCut === -1 || naturalCut > cutIndex + 60) naturalCut = cutIndex;

    const visiblePart = content.substring(0, naturalCut).trim() + (content.length > naturalCut ? '...' : '');
    const remainingPart = content.substring(naturalCut).trim();
    const blurredParas = remainingPart.split('\n\n').map(t => t.trim()).filter(Boolean);

    // Regla de ÚLTIMA HORA: <= 1 hora
    const createdDate = this.currentEditingArticle?.fecha_creacion 
      ? new Date(this.currentEditingArticle.fecha_creacion)
      : new Date(); // Nuevo = ahora mismo (< 1 hora)

    const diffMs = Date.now() - createdDate.getTime();
    const isUltimaHora = diffMs >= 0 && diffMs <= 3600000;

    const badgeText = categoria;
    const author = this.currentEditingArticle?.autor_nombre || Auth.currentUser?.nombre || 'Redacción Gaceta';
    const displayDate = isUltimaHora ? 'Hace menos de 1 hora' : this.formatDate(createdDate.toISOString());

    const overlayHtml = isBlurredMode ? `
      <div class="guest-teaser-overlay">
        <div class="guest-teaser-lock">
          <div class="lock-icon-wrap"><i class="fa-solid fa-lock"></i></div>
          <h3>¿Quieres saber el desenlace?</h3>
          <p>Regístrate gratis o inicia sesión para leer la nota completa.</p>
          <div class="guest-cta-buttons">
            <button class="btn btn-primary btn-cta-guest" type="button">
              <i class="fa-solid fa-arrow-right-to-bracket"></i> Iniciar Sesión
            </button>
            <button class="btn btn-outline btn-cta-guest" type="button">
              <i class="fa-solid fa-user-plus"></i> Crear Cuenta Gratis
            </button>
          </div>
        </div>
      </div>` : '';

    previewStage.innerHTML = `
      <div class="guest-teaser-wrapper" style="margin-bottom: 0;">
        <div class="guest-teaser-hero" style="grid-template-columns: 1fr;">
          <div class="guest-teaser-image" style="min-height: 200px;">
            <img src="${image}" alt="${title}" class="guest-teaser-real-img" onerror="this.src='/img/escandalo-drogas.jpg'" />
            <span class="badge badge-category guest-teaser-badge">${badgeText}</span>
            ${isUltimaHora ? `
              <div class="guest-teaser-breaking">
                <span class="breaking-dot"></span>
                ÚLTIMA HORA
              </div>` : ''}
          </div>
          <div class="guest-teaser-content">
            <div class="guest-teaser-meta">
              <span><i class="fa-regular fa-clock"></i> ${displayDate}</span>
              <span><i class="fa-solid fa-user-pen"></i> ${author}</span>
            </div>
            <h2 class="guest-teaser-title">${title}</h2>
            <div class="guest-teaser-text-wrap">
              <p class="guest-teaser-visible">${visiblePart}</p>
              <div class="guest-teaser-blurred${isBlurredMode ? '' : ' unblurred'}">
                ${blurredParas.length > 0 ? blurredParas.map(p => `<p>${p}</p>`).join('') : '<p><em>(El resto del contenido aparecerá con desenfoque para los invitados)</em></p>'}
              </div>
              ${overlayHtml}
            </div>
          </div>
        </div>
      </div>
    `;
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
      if (hint) {
        hint.textContent = 'Ese archivo no es una imagen. Usa JPG, PNG, WEBP o GIF.';
        hint.classList.add('error');
      }
      this.clearImageInput();
      return;
    }

    if (file.size > this.MAX_IMAGE_BYTES) {
      area.classList.add('has-error');
      if (hint) {
        hint.textContent = `La imagen pesa ${(file.size / (1024 * 1024)).toFixed(1)} MB y el máximo es ${maxMb} MB.`;
        hint.classList.add('error');
      }
      this.clearImageInput();
      return;
    }

    area.classList.remove('has-error');
    if (hint) {
      hint.classList.remove('error');
      hint.textContent = 'JPG, PNG, WEBP o GIF. Máximo 5 MB.';
    }
    area.classList.add('has-file');

    const nameEl = document.getElementById('articleImgPreviewName');
    const sizeEl = document.getElementById('articleImgPreviewSize');
    if (nameEl) nameEl.textContent = file.name;
    if (sizeEl) sizeEl.textContent = `${(file.size / 1024).toFixed(0)} KB`;

    // La vista previa se lee como data URL
    const imgPreview = document.getElementById('articleImgPreviewImg');
    const reader = new FileReader();
    reader.onload = () => {
      if (imgPreview) imgPreview.src = reader.result;
      preview.hidden = false;
      this.selectedImageBase64 = reader.result;
      this.updateModalLivePreview();
    };
    reader.onerror = () => {
      showToast('No se pudo leer la imagen seleccionada', 'error');
      this.resetImageFile();
      this.updateModalLivePreview();
    };
    reader.readAsDataURL(file);
  },

  clearImageInput() {
    const input = document.getElementById('articleImgFile');
    if (input) input.value = '';
  },

  /** Vuelve al estado inicial del selector: sin archivo y sin vista previa. */
  resetImageFile() {
    this.selectedImageBase64 = null;
    const area = document.getElementById('articleUploadArea');
    const preview = document.getElementById('articleImgPreview');
    const hint = document.getElementById('articleUploadHint');

    this.clearImageInput();

    if (preview) {
      preview.hidden = true;
      const img = document.getElementById('articleImgPreviewImg');
      if (img) img.removeAttribute('src');
    }
    if (area) area.classList.remove('has-file', 'has-error', 'drag-over');
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
    const es_portada = document.getElementById('articleIsPortada')?.checked ? 1 : 0;
    const porcentaje_censura = Number(document.getElementById('articleBlurSlider')?.value) || 30;

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
        datos.append('es_portada', es_portada);
        datos.append('porcentaje_censura', porcentaje_censura);
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
        await API.put(`/noticias/${editId}`, { titulo, categoria, imagen_url, contenido, es_portada, porcentaje_censura });
        showToast('Noticia actualizada exitosamente', 'success');
      } else {
        await API.post('/noticias', { titulo, categoria, imagen_url, contenido, es_portada, porcentaje_censura });
        showToast('Noticia publicada con éxito', 'success');
      }

      this.teaserConfig = null;
      await this.loadTeaserConfig();
      App.closeModal('modalArticleEditor');
      await this.loadNews();
    } catch (error) {
      console.error('Error al guardar noticia:', error.message);
      if (error.status === 403) {
        showToast('El servidor denegó la operación: tu rol no tiene el permiso requerido', 'error');
      } else {
        showToast(error.message || 'Error al guardar la noticia', 'error');
      }
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = editId ? 'Guardar Cambios' : 'Publicar Noticia';
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