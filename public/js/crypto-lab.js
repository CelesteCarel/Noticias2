/**
 * Laboratorio y Módulo de Demostración Criptográfica UNACH
 * 
 * Gestiona la interactividad de:
 * 1. Cifrado Simétrico AES-256-GCM (Simulador y comparador de base de datos)
 * 2. Firma Asimétrica RSA-SHA256 (Verificación en vivo y prueba de tampering)
 */

const CryptoLab = {
  currentArticles: [],
  selectedNewsId: null,

  init() {
    this.bindEvents();
  },

  bindEvents() {
    // Abrir Modal del Laboratorio Criptográfico
    const btnNav = document.getElementById('btnNavCryptoDemo');
    if (btnNav) {
      btnNav.addEventListener('click', () => {
        this.openModal();
      });
    }

    // Cerrar Modal
    const btnCloseHeader = document.getElementById('closeCryptoDemoModal');
    const btnCloseFooter = document.getElementById('btnCloseCryptoDemoFooter');
    if (btnCloseHeader) btnCloseHeader.addEventListener('click', () => App.closeModal('modalCryptoDemo'));
    if (btnCloseFooter) btnCloseFooter.addEventListener('click', () => App.closeModal('modalCryptoDemo'));

    // Pestañas del Laboratorio
    const tabs = document.querySelectorAll('.crypto-tabs .admin-tab');
    tabs.forEach(tab => {
      tab.addEventListener('click', (e) => {
        tabs.forEach(t => t.classList.remove('active'));
        const target = e.currentTarget;
        target.classList.add('active');

        const paneId = target.getAttribute('data-cryptotab');
        document.querySelectorAll('.crypto-tab-pane').forEach(p => p.style.display = 'none');
        const activePane = document.getElementById(paneId);
        if (activePane) activePane.style.display = 'block';
      });
    });

    // Simulador de Cifrado Simétrico
    const btnSim = document.getElementById('btnRunCryptoSim');
    if (btnSim) {
      btnSim.addEventListener('click', () => this.runSymmetricSimulation());
    }

    // Botón Actualizar Tabla SQLite
    const btnRefreshTable = document.getElementById('btnRefreshCryptoTable');
    if (btnRefreshTable) {
      btnRefreshTable.addEventListener('click', () => this.loadDbComparisonTable());
    }

    // Botones de Verificación y Tampering en Tab 2
    const btnVerifySelected = document.getElementById('btnVerifySelectedNews');
    if (btnVerifySelected) {
      btnVerifySelected.addEventListener('click', () => this.verifySelectedNews());
    }

    const btnTamperSelected = document.getElementById('btnTamperSelectedNews');
    if (btnTamperSelected) {
      btnTamperSelected.addEventListener('click', () => this.tamperSelectedNews());
    }

    // Botones dentro del Modal de Lectura de Noticias
    const btnVerifyReader = document.getElementById('btnVerifySignatureLive');
    if (btnVerifyReader) {
      btnVerifyReader.addEventListener('click', () => this.verifyCurrentReaderArticle());
    }

    const btnTamperReader = document.getElementById('btnTestTamperingLive');
    if (btnTamperReader) {
      btnTamperReader.addEventListener('click', () => this.tamperCurrentReaderArticle());
    }

    const btnToggleRawDb = document.getElementById('btnToggleRawDbView');
    if (btnToggleRawDb) {
      btnToggleRawDb.addEventListener('click', () => {
        const box = document.getElementById('readerRawDbBox');
        if (box) {
          box.style.display = box.style.display === 'none' ? 'block' : 'none';
        }
      });
    }
  },

  async openModal() {
    App.openModal('modalCryptoDemo');
    await this.loadCryptoInfo();
    await this.loadDbComparisonTable();
    this.populateTamperSelect();
  },

  async loadCryptoInfo() {
    try {
      const info = await API.get('/crypto/info');
      const fpEl = document.getElementById('cryptoPublicKeyFingerprint');
      if (fpEl) {
        fpEl.textContent = info.mecanismo_2_asimetrico.huella_digital_clave_publica_sha256 || 'No disponible';
      }

      const pem = await (await fetch('/api/crypto/public-key')).text();
      const pemEl = document.getElementById('cryptoPublicKeyPem');
      if (pemEl) {
        pemEl.textContent = pem;
      }
    } catch (error) {
      console.warn('Error al cargar información criptográfica:', error);
    }
  },

  async runSymmetricSimulation() {
    const input = document.getElementById('cryptoSimInput');
    const output = document.getElementById('cryptoSimOutput');
    if (!input || !output) return;

    const texto = input.value.trim();
    if (!texto) {
      showToast('Por favor escribe un texto para cifrar', 'warning');
      return;
    }

    try {
      const res = await API.post('/crypto/demo-symmetric', { texto });
      output.style.display = 'block';
      output.innerHTML = `
        <div class="raw-db-comparison" style="margin-top: 0;">
          <div style="margin-bottom: 0.5rem; color: #60a5fa; font-weight: bold;">
            <i class="fa-solid fa-gears"></i> Proceso de Cifrado Autenticado (AES-256-GCM):
          </div>
          <div style="margin-bottom: 0.4rem;">
            <span style="color: #9ca3af;">1. Vector de Inicialización (IV 12 bytes):</span>
            <code style="color: #60a5fa; background: #1f2937; padding: 2px 6px; border-radius: 4px;">${res.detalles_cifrado.vector_inicializacion_iv_hex}</code>
          </div>
          <div style="margin-bottom: 0.4rem;">
            <span style="color: #9ca3af;">2. Etiqueta de Autenticación (Auth Tag 16 bytes):</span>
            <code style="color: #c084fc; background: #1f2937; padding: 2px 6px; border-radius: 4px;">${res.detalles_cifrado.etiqueta_autenticacion_tag_hex}</code>
          </div>
          <div style="margin-bottom: 0.4rem;">
            <span style="color: #9ca3af;">3. Texto Cifrado (Ciphertext):</span>
            <code style="color: #34d399; background: #1f2937; padding: 2px 6px; border-radius: 4px;">${res.detalles_cifrado.texto_cifrado_hex}</code>
          </div>
          <div style="margin-top: 0.75rem; border-top: 1px solid #374151; padding-top: 0.5rem;">
            <strong style="color: #e5e7eb;">Cadena final guardada en SQLite (iv:tag:ciphertext):</strong>
            <pre class="raw-cipher-code">${res.detalles_cifrado.empaquetado_en_base_de_datos}</pre>
          </div>
          <div style="margin-top: 0.5rem; background: rgba(16, 185, 129, 0.15); border: 1px solid #10b981; padding: 0.5rem 0.75rem; border-radius: 4px; color: #34d399;">
            <i class="fa-solid fa-circle-check"></i> <strong>Resultado del Descifrado:</strong> "${res.descifrado_posterior.resultado_descifrado}" (Coincide: ${res.descifrado_posterior.coincide_con_original ? 'SÍ' : 'NO'})
          </div>
        </div>
      `;
    } catch (error) {
      showToast('Error en la simulación: ' + error.message, 'error');
    }
  },

  async loadDbComparisonTable() {
    const tbody = document.getElementById('cryptoDbTableBody');
    if (!tbody) return;

    tbody.innerHTML = '<tr><td colspan="4" class="text-center"><i class="fa-solid fa-spinner fa-spin"></i> Cargando registros desde SQLite...</td></tr>';

    try {
      // Necesitamos estar autenticados para leer noticias completas
      let articles = [];
      try {
        articles = await API.get('/noticias');
      } catch (e) {
        articles = News.articlesList || [];
      }

      this.currentArticles = articles;
      this.populateTamperSelect();

      if (!articles || articles.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" class="text-center text-muted">Inicia sesión como Editor o Administrador para visualizar los datos confidenciales descifrados.</td></tr>';
        return;
      }

      tbody.innerHTML = '';
      articles.forEach(art => {
        const tr = document.createElement('tr');
        const raw = art.nota_confidencial_raw || 'Sin dato confidencial';
        const clear = art.nota_confidencial || '<span class="text-muted">(Sin nota)</span>';

        tr.innerHTML = `
          <td><strong>#${art.id}</strong></td>
          <td>
            <div style="font-weight: 600; line-height: 1.3;">${art.titulo}</div>
            <small class="badge-crypto-card" style="margin-top: 4px;">
              <i class="fa-solid fa-certificate"></i> RSA Firmado
            </small>
          </td>
          <td>
            <div class="crypto-raw-cell" title="${raw}">${raw}</div>
          </td>
          <td>
            <div style="color: #065f46; font-weight: 500;">${clear}</div>
          </td>
        `;
        tbody.appendChild(tr);
      });
    } catch (error) {
      tbody.innerHTML = `<tr><td colspan="4" class="text-center text-danger">Error al consultar SQLite: ${error.message}</td></tr>`;
    }
  },

  populateTamperSelect() {
    const select = document.getElementById('tamperNewsSelect');
    if (!select) return;

    select.innerHTML = '';
    const list = this.currentArticles.length > 0 ? this.currentArticles : (News.articlesList || []);
    list.forEach(item => {
      const opt = document.createElement('option');
      opt.value = item.id;
      opt.textContent = `#${item.id} - ${item.titulo.substring(0, 70)}...`;
      select.appendChild(opt);
    });
  },

  async verifySelectedNews() {
    const select = document.getElementById('tamperNewsSelect');
    const stage = document.getElementById('tamperResultStage');
    if (!select || !stage) return;

    const id = select.value;
    if (!id) return;

    stage.style.display = 'block';
    stage.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Verificando firma digital con Llave Pública RSA...';

    try {
      const res = await API.post('/crypto/verify-news', { id_noticia: Number(id) });
      stage.innerHTML = `
        <div class="crypto-verification-result ${res.valida ? 'success' : 'danger'}">
          <div style="font-weight: bold; margin-bottom: 0.25rem;">
            ${res.mensaje}
          </div>
          <small><strong>Algoritmo:</strong> ${res.algoritmo} | <strong>Huella de Llave Pública:</strong> <code>${res.huella_clave_publica}</code></small>
          <div style="margin-top: 0.4rem; font-size: 0.75rem; color: #4b5563;">
            <strong>Secuencia canónica verificada:</strong><br>
            <code>${res.payload_canonico}</code>
          </div>
        </div>
      `;
    } catch (error) {
      stage.innerHTML = `<div class="crypto-verification-result danger">Error al verificar: ${error.message}</div>`;
    }
  },

  async tamperSelectedNews() {
    const select = document.getElementById('tamperNewsSelect');
    const stage = document.getElementById('tamperResultStage');
    if (!select || !stage) return;

    const id = select.value;
    if (!id) return;

    stage.style.display = 'block';
    stage.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Simulando inyección maliciosa en el contenido...';

    try {
      const res = await API.post('/crypto/test-tampering', { id_noticia: Number(id) });
      stage.innerHTML = `
        <div class="crypto-verification-result danger" style="border: 2px dashed #ef4444;">
          <h5 style="margin: 0 0 0.5rem; color: #991b1b;">
            <i class="fa-solid fa-triangle-exclamation"></i> Demostración de Detección de Tampering Exitosa
          </h5>
          <p style="margin: 0 0 0.5rem;">
            Se simuló la modificación de una sola palabra en la base de datos sin contar con la llave privada del servidor.
          </p>
          <div style="background: white; padding: 0.5rem; border-radius: 4px; font-family: monospace; font-size: 0.75rem; margin-bottom: 0.5rem;">
            <strong>Contenido adulterado probado:</strong><br>
            "${res.resultado_con_tampering.contenido_alterado_preview}"
          </div>
          <div style="font-weight: bold; color: #b91c1c;">
            ${res.resultado_con_tampering.estado}
          </div>
          <small style="color: #6b7280; display: block; margin-top: 0.4rem;">
            La función matemática de verificación RSA-SHA256 garantiza que ningún contenido manipulado pueda hacerse pasar por un documento auténtico de la UNACH.
          </small>
        </div>
      `;
    } catch (error) {
      stage.innerHTML = `<div class="crypto-verification-result danger">Error en la prueba: ${error.message}</div>`;
    }
  },

  async verifyCurrentReaderArticle() {
    const article = News.currentReaderArticle;
    const box = document.getElementById('readerVerificationResult');
    if (!article || !box) return;

    box.style.display = 'block';
    box.className = 'crypto-verification-result';
    box.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Verificando firma digital con la Llave Pública RSA...';

    try {
      const res = await API.post('/crypto/verify-news', { id_noticia: article.id });
      box.className = `crypto-verification-result ${res.valida ? 'success' : 'danger'}`;
      box.innerHTML = `
        <div><strong>${res.mensaje}</strong></div>
        <small style="display: block; margin-top: 4px;">
          <strong>Algoritmo:</strong> ${res.algoritmo} | <strong>Huella de Llave Pública:</strong> <code>${res.huella_clave_publica}</code>
        </small>
      `;
    } catch (e) {
      box.className = 'crypto-verification-result danger';
      box.textContent = 'Error al verificar la firma: ' + e.message;
    }
  },

  async tamperCurrentReaderArticle() {
    const article = News.currentReaderArticle;
    const box = document.getElementById('readerVerificationResult');
    if (!article || !box) return;

    box.style.display = 'block';
    box.className = 'crypto-verification-result danger';
    box.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Simulando alteración de contenido...';

    try {
      const res = await API.post('/crypto/test-tampering', { id_noticia: article.id });
      box.innerHTML = `
        <div style="font-weight: bold; margin-bottom: 4px;">
          <i class="fa-solid fa-shield-virus"></i> ${res.resultado_con_tampering.estado}
        </div>
        <small>Se alteró el contenido en memoria y la clave pública RSA rechazó la firma inmediatamente. El documento original no ha sido corrompido.</small>
      `;
    } catch (e) {
      box.textContent = 'Error en prueba de alteración: ' + e.message;
    }
  }
};

document.addEventListener('DOMContentLoaded', () => {
  CryptoLab.init();
});
