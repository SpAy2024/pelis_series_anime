let allResults = [];
let allSeries = [];
let currentSeries = null;

const $ = (id) => document.getElementById(id);

// Elementos
const urlsInput = $('urls-input');
const btnScrape = $('btn-scrape');
const btnClear = $('btn-clear');
const btnLoadJson = $('btn-load-json');
const statusEl = $('status');
const progressFill = $('progress-fill');
const progressText = $('progress-text');
const progressStats = $('progress-stats');
const logEl = $('log');
const resultsEl = $('results');
const libraryEl = $('library');
const searchLib = $('search-lib');
const filterType = $('filter-type');
const modal = $('player-modal');
const modalClose = $('modal-close');
const modalTitle = $('modal-title');
const modalIframe = $('modal-iframe');
const modalServers = $('modal-servers');
const scrapeAllEpisodesCheckbox = $('scrape-all-episodes');

// === WebSocket ===
function connectWS() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(protocol + '//' + location.host);
  ws.onopen = () => { statusEl.textContent = 'Conectado'; statusEl.classList.add('connected'); };
  ws.onclose = () => {
    statusEl.textContent = 'Desconectado'; statusEl.classList.remove('connected');
    setTimeout(connectWS, 3000);
  };
  ws.onmessage = (evt) => handleWSMessage(JSON.parse(evt.data));
}

function handleWSMessage(msg) {
  if (msg.type === 'start') {
    progressFill.style.width = '0%';
    progressText.textContent = 'Scrapeando 0/' + msg.total + '...';
    logEl.innerHTML = '';
    addLog('Iniciando ' + msg.total + ' URLs', '');
    btnScrape.disabled = true;
  } else if (msg.type === 'progress') {
    progressFill.style.width = ((msg.index - 1) / msg.total * 100) + '%';
    progressText.textContent = 'Scrapeando ' + msg.index + '/' + msg.total + '...';
    addLog('[' + msg.index + '/' + msg.total + '] ' + msg.slug + ' (' + msg.kind + ')', '');
  } else if (msg.type === 'result') {
    progressFill.style.width = (msg.index / msg.total * 100) + '%';
    if (msg.ok) {
      if (msg.result.servers) {
        addLog('[OK] ' + (msg.result.title || msg.result.slug) + ' - ' + msg.result.servers.length + ' servidores', 'ok');
        allResults = allResults.filter(r => r.slug !== msg.result.slug);
        allResults.push(msg.result);
      } else if (msg.result.seasons) {
        addLog('[OK] ' + (msg.result.title || msg.result.slug) + ' - ' + msg.result.seasons.length + ' temporadas', 'ok');
        allSeries = allSeries.filter(s => s.slug !== msg.result.slug);
        allSeries.push(msg.result);
      }
      renderResults();
    } else {
      addLog('[ERR] ' + (msg.result.slug || msg.result.url) + ' - ' + msg.result.error, 'err');
    }
  } else if (msg.type === 'done') {
    progressFill.style.width = '100%';
    progressText.textContent = 'Completado: ' + msg.ok + ' OK, ' + msg.fail + ' errores';
    addLog('Completado', '');
    btnScrape.disabled = false;
  } else if (msg.type === 'episode-result') {
    addLog('[EP] S' + msg.season + 'E' + msg.episode + ' - ' + msg.servers.length + ' servidores', 'ok');
    if (currentSeries && currentSeries.slug === msg.slug) {
      renderEpisodeServers(msg.season, msg.episode, msg.servers);
    }
  } else if (msg.type === 'episodes-start') {
    addLog('[EPISODIOS] Scrapeando ' + msg.total + ' episodios de ' + msg.slug + '...', '');
  } else if (msg.type === 'episode-progress') {
    const pct = (msg.done / msg.total) * 100;
    progressFill.style.width = pct + '%';
    progressText.textContent = 'Episodios: ' + msg.done + '/' + msg.total + ' (T' + msg.season + 'E' + msg.episode + ')';
    if (msg.done % 5 === 0 || msg.done === msg.total) {
      addLog('  [EP] ' + msg.done + '/' + msg.total + ' T' + msg.season + 'E' + msg.episode, '');
    }
  } else if (msg.type === 'episodes-done') {
    addLog('[EPISODIOS] Completados para ' + msg.slug, 'ok');
  } else if (msg.type === 'firebase') {
    addLog('  [FIREBASE] ' + (msg.ok ? 'guardado' : 'error') + ' ' + msg.tipo + (msg.tmdb_id ? ' (' + msg.tmdb_id + ')' : ''), msg.ok ? 'ok' : 'err');
  }
}

function addLog(text, cls) {
  const li = document.createElement('li');
  li.textContent = text;
  if (cls) li.className = cls;
  logEl.appendChild(li);
  logEl.scrollTop = logEl.scrollHeight;
}

// === Scrapear ===
btnScrape.onclick = async () => {
  const text = urlsInput.value.trim();
  if (!text) { alert('Pega al menos una URL'); return; }
  const urls = text.split('\n').map(l => l.trim()).filter(l => l.startsWith('http'));
  if (urls.length === 0) { alert('No hay URLs validas'); return; }

  const scrapeAllEpisodes = scrapeAllEpisodesCheckbox ? scrapeAllEpisodesCheckbox.checked : false;

  try {
    await fetch('/api/scrape', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        urls,
        scrapeAllEpisodes,
        guardarFirebase: true
      })
    });
  } catch (e) { alert('Error: ' + e.message); }
};

btnClear.onclick = () => {
  urlsInput.value = '';
  logEl.innerHTML = '';
  progressFill.style.width = '0%';
  progressText.textContent = 'Sin iniciar';
};

btnLoadJson.onclick = async () => {
  try {
    const [movies, series] = await Promise.all([
      fetch('/api/enlaces').then(r => r.json()),
      fetch('/api/series').then(r => r.json())
    ]);
    allResults = movies;
    allSeries = series;
    renderResults();
    renderLibrary();
    progressText.textContent = movies.length + ' peliculas, ' + series.length + ' series';
  } catch (e) { alert('Error: ' + e.message); }
};

// === Render resultados ===
function renderResults() {
  resultsEl.innerHTML = '';

  if (allResults.length > 0) {
    const h = document.createElement('h3');
    h.textContent = 'Peliculas (' + allResults.length + ')';
    h.style.marginBottom = '1rem';
    resultsEl.appendChild(h);

    const grid = document.createElement('div');
    grid.className = 'results-grid';
    for (const movie of allResults) {
      grid.appendChild(renderMovieCard(movie));
    }
    resultsEl.appendChild(grid);
  }

  if (allSeries.length > 0) {
    const h = document.createElement('h3');
    h.textContent = 'Series / Animes (' + allSeries.length + ')';
    h.style.margin = '2rem 0 1rem';
    resultsEl.appendChild(h);

    const grid = document.createElement('div');
    grid.className = 'results-grid';
    for (const s of allSeries) {
      grid.appendChild(renderSeriesCard(s));
    }
    resultsEl.appendChild(grid);
  }

  if (allResults.length === 0 && allSeries.length === 0) {
    resultsEl.innerHTML = '<div class="empty">No hay resultados</div>';
  }
}

function renderMovieCard(movie) {
  const card = document.createElement('div');
  card.className = 'movie-card';
  card.innerHTML = '<h3>' + escapeHtml(movie.titulo || movie.title || movie.slug) + '</h3>' +
                   '<div class="slug">' + escapeHtml(movie.slug) + (movie.tmdb_id ? ' (TMDB: ' + movie.tmdb_id + ')' : '') + '</div>' +
                   '<div class="server-list"></div>';
  const list = card.querySelector('.server-list');
  const servers = movie.servidores || movie.servers || [];
  if (servers.length === 0) {
    list.innerHTML = '<div class="empty" style="padding:0.5rem;font-size:0.75rem">Sin servidores</div>';
  } else {
    for (const s of servers) {
      const btn = document.createElement('button');
      btn.className = 'server-btn';
      btn.innerHTML = '<span class="lang ' + s.language + '">' + s.language + '</span>' +
                      '<span class="server-name">' + escapeHtml(s.server) + '</span><span>PLAY</span>';
      btn.onclick = () => openPlayer(movie, s);
      list.appendChild(btn);
    }
  }
  return card;
}

function renderSeriesCard(series) {
  const card = document.createElement('div');
  card.className = 'movie-card';
  card.innerHTML = '<h3>' + escapeHtml(series.title || series.slug) + '</h3>' +
                   '<div class="slug">' + escapeHtml((series.type || 'serie') + ' - ' + series.slug) + (series.tmdb_id ? ' (TMDB: ' + series.tmdb_id + ')' : '') + '</div>' +
                   '<div class="server-list"></div>';
  const list = card.querySelector('.server-list');

  for (const season of series.seasons) {
    const seasonDiv = document.createElement('div');
    seasonDiv.style.marginBottom = '0.5rem';
    seasonDiv.innerHTML = '<div style="font-size:0.75rem;color:var(--text-dim);margin-bottom:0.25rem">Temporada ' + season.number + ' (' + season.episodes.length + ' eps)</div>';

    const epGrid = document.createElement('div');
    epGrid.style.display = 'grid';
    epGrid.style.gridTemplateColumns = 'repeat(auto-fill, minmax(40px, 1fr))';
    epGrid.style.gap = '0.25rem';

    for (const ep of season.episodes) {
      const btn = document.createElement('button');
      btn.className = 'server-btn';
      btn.style.justifyContent = 'center';
      btn.style.padding = '0.3rem';
      btn.textContent = ep.number;
      btn.title = ep.title;
      if (ep.servers && ep.servers.length > 0) {
        btn.style.borderColor = 'var(--success)';
      }
      btn.onclick = () => openEpisode(series, season.number, ep);
      epGrid.appendChild(btn);
    }

    seasonDiv.appendChild(epGrid);
    list.appendChild(seasonDiv);
  }

  return card;
}

// === Reproductor ===
function openPlayer(movie, server) {
  modalTitle.textContent = (movie.titulo || movie.title || movie.slug) + ' - ' + server.server + ' (' + server.language + ')';
  modalIframe.src = server.url;
  modal.classList.remove('hidden');
  modalServers.innerHTML = '';
  const servers = movie.servidores || movie.servers || [];
  for (const s of servers) {
    const btn = document.createElement('button');
    btn.className = 'server-btn';
    btn.style.maxWidth = '200px';
    btn.innerHTML = '<span class="lang ' + s.language + '">' + s.language + '</span>' +
                    '<span class="server-name">' + escapeHtml(s.server) + '</span>';
    btn.onclick = () => {
      modalIframe.src = s.url;
      modalTitle.textContent = (movie.titulo || movie.title || movie.slug) + ' - ' + s.server + ' (' + s.language + ')';
    };
    modalServers.appendChild(btn);
  }
}

function openEpisode(series, seasonNum, ep) {
  currentSeries = series;
  modalTitle.textContent = series.title + ' - T' + seasonNum + 'E' + ep.number;
  modalIframe.src = '';
  modal.classList.remove('hidden');
  modalServers.innerHTML = '<div class="empty">Cargando servidores...</div>';

  if (ep.servers && ep.servers.length > 0) {
    renderEpisodeServers(seasonNum, ep.number, ep.servers);
    return;
  }

  fetch('/api/scrape-episode', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: ep.url,
      slug: series.slug,
      season: seasonNum,
      episode: ep.number,
      tmdb_id: series.tmdb_id,
      guardarFirebase: true
    })
  });
}

function renderEpisodeServers(seasonNum, epNum, servers) {
  modalServers.innerHTML = '';
  if (!servers || servers.length === 0) {
    modalServers.innerHTML = '<div class="empty">Sin servidores</div>';
    return;
  }
  for (const s of servers) {
    const btn = document.createElement('button');
    btn.className = 'server-btn';
    btn.style.maxWidth = '200px';
    btn.innerHTML = '<span class="lang ' + s.language + '">' + s.language + '</span>' +
                    '<span class="server-name">' + escapeHtml(s.server) + '</span>';
    btn.onclick = () => {
      modalIframe.src = s.url;
      modalTitle.textContent = currentSeries.title + ' - T' + seasonNum + 'E' + epNum + ' (' + s.language + ')';
    };
    modalServers.appendChild(btn);
  }
  if (servers[0]) modalIframe.src = servers[0].url;
}

modalClose.onclick = () => { modal.classList.add('hidden'); modalIframe.src = ''; currentSeries = null; };
modal.onclick = (e) => { if (e.target === modal) modalClose.click(); };
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !modal.classList.contains('hidden')) modalClose.click();
});

// === Tabs ===
document.querySelectorAll('.tab').forEach(tab => {
  tab.onclick = () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    tab.classList.add('active');
    $('tab-' + tab.dataset.tab).classList.add('active');
    if (tab.dataset.tab === 'biblioteca') renderLibrary();
  };
});

// === Biblioteca ===
function renderLibrary() {
  const q = searchLib.value.toLowerCase().trim();
  const type = filterType.value;

  libraryEl.innerHTML = '';

  const movies = allResults.filter(r => {
    if (q && !(r.titulo || r.title || r.slug).toLowerCase().includes(q)) return false;
    if (type !== 'all' && type !== 'pelicula') return false;
    return true;
  });

  const series = allSeries.filter(s => {
    if (q && !(s.title || s.slug).toLowerCase().includes(q)) return false;
    if (type !== 'all' && type !== s.type) return false;
    return true;
  });

  if (movies.length === 0 && series.length === 0) {
    libraryEl.innerHTML = '<div class="empty">No hay resultados</div>';
    return;
  }

  const grid = document.createElement('div');
  grid.className = 'results-grid';

  for (const m of movies) grid.appendChild(renderMovieCard(m));
  for (const s of series) grid.appendChild(renderSeriesCard(s));

  libraryEl.appendChild(grid);
}

searchLib.oninput = renderLibrary;
filterType.onchange = renderLibrary;

// === Utilidad ===
function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// === Init ===
connectWS();
btnLoadJson.click();
