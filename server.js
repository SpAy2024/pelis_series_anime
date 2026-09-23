const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const tmdb = require('./tmdb');
const fb = require('./firebase');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;
const OUT_DIR = path.join(__dirname, 'enlaces');
const OUT_SERIES = path.join(__dirname, 'series');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR);
if (!fs.existsSync(OUT_SERIES)) fs.mkdirSync(OUT_SERIES);

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// === Helper para lanzar el navegador con proxy ===
async function launchBrowser() {
  const launchArgs = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-blink-features=AutomationControlled',
    '--disable-dev-shm-usage'
  ];

  if (process.env.PROXY_HOST && process.env.PROXY_PORT) {
    launchArgs.push(`--proxy-server=http://${process.env.PROXY_HOST}:${process.env.PROXY_PORT}`);
    console.log(`[PROXY] Usando proxy: ${process.env.PROXY_HOST}:${process.env.PROXY_PORT}`);
  }

  const browser = await puppeteer.launch({
    headless: 'new',
    args: launchArgs
  });

  const page = await browser.newPage();

  // Autenticar el proxy si hay password
  if (process.env.PROXY_PASSWORD) {
    try {
      await page.authenticate({
        username: '',
        password: process.env.PROXY_PASSWORD
      });
      console.log('[PROXY] Proxy autenticado');
    } catch (e) {
      console.warn('[PROXY] No se pudo autenticar:', e.message);
    }
  }

  await page.setViewport({ width: 1920, height: 1080 });
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  );

  return { browser, page };
}

// === Utilidades ===
function slugFromUrl(url) {
  const m = url.match(/\/(?:pelicula|serie|anime|dorama)\/([^\/\?]+)/);
  return m ? m[1] : null;
}

function detectType(url) {
  if (url.includes('/pelicula/')) return 'pelicula';
  if (url.includes('/anime/')) return 'anime';
  if (url.includes('/serie/')) return 'serie';
  return 'desconocido';
}

function broadcast(msg) {
  const data = JSON.stringify(msg);
  wss.clients.forEach(c => {
    if (c.readyState === WebSocket.OPEN) c.send(data);
  });
}

// === Detector de Cloudflare / Access Denied ===
function detectBlock(html, title) {
  const checks = [
    html.includes('Error 1005'),
    html.includes('Access denied'),
    html.includes('autonomous system number'),
    html.includes('used Cloudflare to restrict access'),
    html.includes('Cloudflare Ray ID'),
    title.includes('Access denied'),
    title.includes('Just a moment'),
    title.includes('Attention Required')
  ];
  return checks.some(c => c === true);
}

////////////////////
// === Fusionar serie nueva con datos existentes ===
function mergeSeries(existing, incoming) {
  if (!existing) return incoming;

  // Crear copia del incoming
  const merged = JSON.parse(JSON.stringify(incoming));

  // Preservar metadata del existente si el nuevo no la tiene
  if (!merged.tmdb_id && existing.tmdb_id) merged.tmdb_id = existing.tmdb_id;
  if (!merged.titulo_original && existing.titulo_original) merged.titulo_original = existing.titulo_original;
  if (!merged.overview && existing.overview) merged.overview = existing.overview;
  if (!merged.poster_url && existing.poster_url) merged.poster_url = existing.poster_url;
  if (!merged.backdrop_url && existing.backdrop_url) merged.backdrop_url = existing.backdrop_url;
  if (!merged.vote_average && existing.vote_average) merged.vote_average = existing.vote_average;
  if (!merged.year && existing.year) merged.year = existing.year;
  if ((!merged.generos || merged.generos.length === 0) && existing.generos) merged.generos = existing.generos;

  // Fusionar episodios: si el nuevo no tiene servidores pero el existente sí, preservarlos
  if (merged.seasons && existing.seasons) {
    for (const newSeason of merged.seasons) {
      const oldSeason = existing.seasons.find(s => s.number === newSeason.number);
      if (!oldSeason) continue;

      for (const newEp of newSeason.episodes) {
        const oldEp = oldSeason.episodes.find(e => e.number === newEp.number);
        if (!oldEp) continue;

        // Si el nuevo episodio NO tiene servidores pero el viejo SÍ, preservar los viejos
        if ((!newEp.servers || newEp.servers.length === 0) && oldEp.servers && oldEp.servers.length > 0) {
          newEp.servers = oldEp.servers;
          newEp.downloadLinks = oldEp.downloadLinks || [];
          newEp.scrapedAt = oldEp.scrapedAt;
          newEp.error = oldEp.error || null;
          newEp.blocked = false;
        }

        // Preservar título si el nuevo está vacío
        if (!newEp.title && oldEp.title) newEp.title = oldEp.title;
      }
    }
  }

  return merged;
}

// === Scraper de servidores de un episodio (o pelicula) ===
async function scrapeEpisodeServers(page, url) {
  const result = { servers: [], downloadLinks: [], error: null, blocked: false };

  try {
    console.log(`[SCRAPE] ================== INICIO ==================`);
    console.log(`[SCRAPE] Navegando a: ${url}`);

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });

    const pageUrl = page.url();
    const title = await page.title().catch(() => '?');
    console.log(`[SCRAPE] PAGINA CARGADA`);
    console.log(`[SCRAPE] URL final: ${pageUrl}`);
    console.log(`[SCRAPE] Titulo: ${title}`);

    const htmlContent = await page.content();
    console.log(`[SCRAPE] HTML length: ${htmlContent.length}`);

    // Detectar Cloudflare
    if (detectBlock(htmlContent, title)) {
      console.log(`[SCRAPE] BLOQUEADO por Cloudflare`);
      result.error = 'cloudflare_blocked';
      result.blocked = true;
      return result;
    }

    // Verificar selector
    const hasSelector = htmlContent.includes('player-box__servers');
    console.log(`[SCRAPE] Tiene player-box__servers: ${hasSelector}`);

    if (!hasSelector) {
      const bodyText = await page.evaluate(() => document.body ? document.body.innerText.slice(0, 300) : '').catch(() => '');
      console.log(`[SCRAPE] Preview body: ${bodyText.replace(/\s+/g, ' ').slice(0, 200)}`);
      console.log(`[SCRAPE] ERROR: Selector no existe`);
      result.error = 'selector_not_found';
      return result;
    }

    console.log(`[SCRAPE] Esperando selector .player-box__servers .server-btn (15s)...`);
    await page.waitForSelector('.player-box__servers .server-btn', { timeout: 15000 });
    console.log(`[SCRAPE] SELECTOR ENCONTRADO`);

    // Simular actividad humana
    await page.mouse.move(500, 400);
    await new Promise(r => setTimeout(r, 800));
    await page.mouse.move(800, 600);
    await page.evaluate(() => window.scrollBy(0, 300));
    await new Promise(r => setTimeout(r, 1000));

    console.log(`[SCRAPE] Click en Embed69...`);
    await page.click('.player-box__servers .server-btn');
    await new Promise(r => setTimeout(r, 6000));

    // Buscar iframe
    let iframeFrame = null;
    for (const frame of page.frames()) {
      if (frame.url().includes('/vidurl/')) { iframeFrame = frame; break; }
    }

    if (!iframeFrame) {
      console.log(`[SCRAPE] ERROR: No se encontro iframe /vidurl/`);
      result.error = 'no_iframe';
      return result;
    }
    console.log(`[SCRAPE] iframe encontrado: ${iframeFrame.url()}`);

    // Esperar POW + descifrado
    let decrypted = null;
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 1000));
      try {
        const state = await iframeFrame.evaluate(() => {
          if (typeof dataLink !== 'undefined' && Array.isArray(dataLink) && dataLink[0]?.sortedEmbeds?.[0]?.link) {
            const link = dataLink[0].sortedEmbeds[0].link;
            if (link.startsWith('http') || link.startsWith('//')) {
              return { decrypted: true, dataLink: JSON.parse(JSON.stringify(dataLink)) };
            }
          }
          return { decrypted: false };
        });
        if (state.decrypted) {
          decrypted = state;
          console.log(`[SCRAPE] Descifrado en ${i + 1}s`);
          break;
        }
        if (i % 5 === 0 && i > 0) console.log(`[SCRAPE] Esperando POW... ${i + 1}s`);
      } catch (e) {}
    }

    if (!decrypted) {
      console.log(`[SCRAPE] ERROR: Timeout descifrado (30s)`);
      result.error = 'timeout_decrypt';
      return result;
    }

    // Extraer servidores
    for (const file of decrypted.dataLink) {
      if (file.sortedEmbeds) {
        for (const e of file.sortedEmbeds) {
          result.servers.push({ server: e.servername, language: file.video_language, url: e.link });
        }
      }
      if (file.downloadEmbeds) {
        for (const e of file.downloadEmbeds) {
          result.downloadLinks.push({ server: e.servername, language: file.video_language, url: e.link });
        }
      }
    }

    console.log(`[SCRAPE] EXITO: ${result.servers.length} servidores`);
    console.log(`[SCRAPE] ================== FIN ==================`);
    return result;

  } catch (e) {
    console.error(`[SCRAPE] ERROR: ${e.message}`);
    console.error(`[SCRAPE] Stack: ${e.stack ? e.stack.slice(0, 500) : 'n/a'}`);
    result.error = e.message;
    return result;
  }
}

// === Scraper de serie/anime (metadata + lista de episodios) ===
async function scrapeSeries(page, url) {
  const slug = slugFromUrl(url);
  const type = detectType(url);
  const result = {
    url, slug, type,
    title: null,
    description: null,
    seasons: [],
    error: null,
    blocked: false,
    scrapedAt: new Date().toISOString()
  };

  try {
    console.log(`[SERIES] Navegando a: ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });

    const title = await page.title().catch(() => '?');
    const htmlContent = await page.content();
    console.log(`[SERIES] Titulo: ${title} | HTML: ${htmlContent.length}`);

    if (detectBlock(htmlContent, title)) {
      console.log(`[SERIES] BLOQUEADO por Cloudflare`);
      result.error = 'cloudflare_blocked';
      result.blocked = true;
      return result;
    }

    result.title = await page.$eval('.detail-hero__title', el => el.textContent.trim()).catch(() => null);
    result.description = await page.$eval('.detail-hero__desc', el => el.textContent.trim()).catch(() => null);
    console.log(`[SERIES] Titulo extraido: ${result.title}`);

    const seasons = await page.evaluate(() => {
      const set = new Set();
      document.querySelectorAll('a[href*="/temporada/"]').forEach(a => {
        const m = a.getAttribute('href').match(/\/temporada\/(\d+)/);
        if (m) set.add(parseInt(m[1]));
      });
      return Array.from(set).sort((a, b) => a - b);
    });

    if (seasons.length === 0) seasons.push(1);
    console.log(`[SERIES] Temporadas: ${seasons.join(', ')}`);

    for (const seasonNum of seasons) {
      const seasonUrl = url.replace(/\/$/, '') + '/temporada/' + seasonNum + '/capitulo/1';
      console.log(`[SERIES] Navegando a temporada ${seasonNum}`);
      await page.goto(seasonUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
      await new Promise(r => setTimeout(r, 2000));

      const episodes = await page.evaluate((baseUrl, seasonNum) => {
        const eps = [];
        const seen = new Set();

        document.querySelectorAll('a[href*="/capitulo/"]').forEach(a => {
          const href = a.getAttribute('href');
          const m = href.match(/\/temporada\/(\d+)\/capitulo\/(\d+)/);
          if (m && parseInt(m[1]) === seasonNum) {
            const num = parseInt(m[2]);
            if (!seen.has(num)) {
              seen.add(num);
              const rawTitle = (a.textContent || '').trim().replace(/\s+/g, ' ');
              eps.push({
                number: num,
                title: rawTitle || ('Episodio ' + num),
                url: href.startsWith('http') ? href : 'https://serieskao.top' + href
              });
            }
          }
        });

        return eps.sort((a, b) => a.number - b.number);
      }, url, seasonNum);

      console.log(`[SERIES] T${seasonNum}: ${episodes.length} episodios`);
      result.seasons.push({ number: seasonNum, episodes });
    }

    return result;
  } catch (e) {
    console.error(`[SERIES] ERROR: ${e.message}`);
    result.error = e.message;
    return result;
  }
}

// === Scrapear TODOS los episodios de una serie ===
async function scrapeAllEpisodesFn(page, seriesData, onProgress) {
  const total = seriesData.seasons.reduce((sum, s) => sum + s.episodes.length, 0);
  let done = 0;
  let bloqueosConsecutivos = 0;

  for (const season of seriesData.seasons) {
    for (const ep of season.episodes) {
      if (seriesData.aborted) break;

      done++;
      if (onProgress) onProgress(done, total, season.number, ep.number);

      try {
        const r = await scrapeEpisodeServers(page, ep.url);
        ep.servers = r.servers;
        ep.downloadLinks = r.downloadLinks;
        ep.error = r.error;
        ep.blocked = r.blocked || false;
        ep.scrapedAt = new Date().toISOString();

        if (r.blocked) {
          console.log(`[EPISODIOS] T${season.number}E${ep.number} BLOQUEADO`);
          bloqueosConsecutivos++;
          if (bloqueosConsecutivos >= 3) {
            console.log(`[EPISODIOS] 3 bloqueos consecutivos. Abortando.`);
            seriesData.aborted = true;
            break;
          }
        } else {
          bloqueosConsecutivos = 0;
        }
      } catch (e) {
        ep.servers = [];
        ep.error = e.message;
      }

      await new Promise(r => setTimeout(r, 1500));
    }
    if (seriesData.aborted) break;
  }

  return seriesData;
}

// === API: peliculas guardadas ===
app.get('/api/enlaces', (req, res) => {
  if (!fs.existsSync(OUT_DIR)) return res.json([]);
  const files = fs.readdirSync(OUT_DIR).filter(f => f.endsWith('.json'));
  const list = files.map(f => {
    try { return JSON.parse(fs.readFileSync(path.join(OUT_DIR, f), 'utf8')); }
    catch { return null; }
  }).filter(Boolean);
  res.json(list);
});

// === API: series guardadas ===
app.get('/api/series', (req, res) => {
  if (!fs.existsSync(OUT_SERIES)) return res.json([]);
  const files = fs.readdirSync(OUT_SERIES).filter(f => f.endsWith('.json'));
  const list = files.map(f => {
    try { return JSON.parse(fs.readFileSync(path.join(OUT_SERIES, f), 'utf8')); }
    catch { return null; }
  }).filter(Boolean);
  res.json(list);
});

// === API: scrape ===
app.post('/api/scrape', async (req, res) => {
  const { urls, guardarFirebase = true, scrapeAllEpisodes = false } = req.body;
  if (!Array.isArray(urls) || urls.length === 0) {
    return res.status(400).json({ error: 'urls debe ser un array no vacio' });
  }

  res.json({ ok: true, total: urls.length, guardarFirebase, scrapeAllEpisodes });

  (async () => {
    broadcast({ type: 'start', total: urls.length });

    const { browser, page } = await launchBrowser();

    let ok = 0, fail = 0, blocked = 0;

    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      const slug = slugFromUrl(url);
      const type = detectType(url);

      broadcast({ type: 'progress', index: i + 1, total: urls.length, slug, url, kind: type });

      try {
        if (type === 'pelicula') {
          console.log(`[MAIN] Procesando pelicula: ${slug}`);

          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
          const htmlContent = await page.content();
          const title = await page.title().catch(() => '');

          if (detectBlock(htmlContent, title)) {
            console.log(`[MAIN] Pelicula bloqueada por Cloudflare`);
            blocked++;
            const result = { url, slug, error: 'cloudflare_blocked', blocked: true };
            broadcast({ type: 'result', index: i + 1, total: urls.length, result, ok: false, blocked: true });
            await new Promise(r => setTimeout(r, 2000));
            continue;
          }

          const titulo = await page.$eval('.detail-hero__title', el => el.textContent.trim()).catch(() => null);
          const year = await page.$eval('.detail-hero__year', el => el.textContent.trim()).catch(() => null);

          const r = await scrapeEpisodeServers(page, url);

          let tmdbData = null;
          if (titulo) {
            tmdbData = await tmdb.buscarPelicula(titulo, year);
            if (tmdbData) {
              tmdbData = { ...tmdbData, ...await tmdb.detallePelicula(tmdbData.tmdb_id) };
            }
          }

          const result = {
            url, slug, tipo: 'pelicula',
            titulo: tmdbData?.titulo || titulo,
            titulo_original: tmdbData?.titulo_original || null,
            year: tmdbData?.year || year,
            overview: tmdbData?.overview || null,
            poster_url: tmdbData?.poster_url || null,
            backdrop_url: tmdbData?.backdrop_url || null,
            generos: tmdbData?.generos || [],
            vote_average: tmdbData?.vote_average || null,
            tmdb_id: tmdbData?.tmdb_id || null,
            servidores: r.servers,
            downloadLinks: r.downloadLinks,
            scrapedAt: new Date().toISOString(),
            error: r.error,
            blocked: r.blocked || false
          };

          // Fusionar con la versión existente para no perder servidores de episodios
const seriesFile = path.join(OUT_SERIES, seriesData.slug + '.json');
let finalSeriesData = seriesData;

if (fs.existsSync(seriesFile)) {
  try {
    const existing = JSON.parse(fs.readFileSync(seriesFile, 'utf8'));
    finalSeriesData = mergeSeries(existing, seriesData);
    console.log(`[MERGE] Serie fusionada con existente. Episodios con servidores preservados.`);
  } catch (e) {
    console.warn(`[MERGE] No se pudo fusionar: ${e.message}`);
  }
}

fs.writeFileSync(seriesFile, JSON.stringify(finalSeriesData, null, 2));

          if (guardarFirebase && result.tmdb_id && !r.blocked) {
            const saved = await fb.guardarPelicula(result.tmdb_id, result);
            broadcast({ type: 'firebase', ok: saved, tipo: 'pelicula', tmdb_id: result.tmdb_id });
          }

          if (r.error) {
            if (r.blocked) blocked++;
            fail++;
            broadcast({ type: 'result', index: i + 1, total: urls.length, result, ok: false, blocked: r.blocked || false });
          } else {
            ok++;
            broadcast({ type: 'result', index: i + 1, total: urls.length, result, ok: true });
          }

        } else {
          console.log(`[MAIN] Procesando serie/anime: ${slug}`);
          const seriesData = await scrapeSeries(page, url);

          if (seriesData.error || seriesData.blocked) {
            if (seriesData.blocked) blocked++;
            fail++;
            broadcast({ type: 'result', index: i + 1, total: urls.length, result: seriesData, ok: false, blocked: seriesData.blocked || false });
          } else {
            let tmdbData = null;
            if (seriesData.title) {
              tmdbData = await tmdb.buscarSerie(seriesData.title);
              if (tmdbData) {
                tmdbData = { ...tmdbData, ...await tmdb.detalleSerie(tmdbData.tmdb_id) };
              }
            }

            seriesData.tmdb_id = tmdbData?.tmdb_id || null;
            seriesData.titulo_original = tmdbData?.titulo_original || null;
            seriesData.overview = tmdbData?.overview || seriesData.description;
            seriesData.poster_url = tmdbData?.poster_url || null;
            seriesData.backdrop_url = tmdbData?.backdrop_url || null;
            seriesData.generos = tmdbData?.generos || [];
            seriesData.vote_average = tmdbData?.vote_average || null;
            seriesData.year = tmdbData?.year || null;

            if (scrapeAllEpisodes) {
              const totalEps = seriesData.seasons.reduce((s, x) => s + x.episodes.length, 0);
              broadcast({ type: 'episodes-start', slug: seriesData.slug, total: totalEps });

              await scrapeAllEpisodesFn(page, seriesData, (done, total, s, e) => {
                broadcast({
                  type: 'episode-progress',
                  slug: seriesData.slug,
                  done, total,
                  season: s,
                  episode: e
                });
              });

              broadcast({ type: 'episodes-done', slug: seriesData.slug, aborted: seriesData.aborted || false });
            }

            fs.writeFileSync(path.join(OUT_SERIES, seriesData.slug + '.json'), JSON.stringify(seriesData, null, 2));

            if (guardarFirebase && finalSeriesData.tmdb_id) {
  const saved = await fb.guardarSerie(finalSeriesData.tmdb_id, finalSeriesData);
  broadcast({ type: 'firebase', ok: saved, tipo: 'serie', tmdb_id: finalSeriesData.tmdb_id });

  let epGuardados = 0;
  for (const season of finalSeriesData.seasons) {
    for (const ep of season.episodes) {
      if (ep.servers && ep.servers.length > 0) {
        const okEp = await fb.guardarEpisodio(finalSeriesData.tmdb_id, season.number, ep.number, {
          titulo: ep.title,
          servidores: ep.servers,
          downloadLinks: ep.downloadLinks || [],
          url: ep.url,
          scrapedAt: ep.scrapedAt || new Date().toISOString()
        });
        if (okEp) epGuardados++;
      }
    }
  }
  broadcast({ type: 'firebase', ok: true, tipo: 'episodios', tmdb_id: finalSeriesData.tmdb_id, total: epGuardados });
}

broadcast({ type: 'series', index: i + 1, total: urls.length, series: finalSeriesData });
ok++;
broadcast({ type: 'result', index: i + 1, total: urls.length, result: finalSeriesData, ok: true });
          }
        }

      } catch (e) {
        console.error(`[MAIN] ERROR: ${e.message}`);
        fail++;
        broadcast({ type: 'result', index: i + 1, total: urls.length, result: { url, slug, error: e.message }, ok: false });
      }

      if (i < urls.length - 1) await new Promise(r => setTimeout(r, 3000));
    }

    await browser.close();
    broadcast({ type: 'done', ok, fail, blocked, total: urls.length });
  })();
});

// === API: scrapear un episodio especifico ===
app.post('/api/scrape-episode', async (req, res) => {
  const { url, slug, season, episode, tmdb_id, guardarFirebase = true } = req.body;
  if (!url) return res.status(400).json({ error: 'url requerida' });

  res.json({ ok: true });

  (async () => {
    broadcast({ type: 'episode-start', slug, season, episode, url });

    const { browser, page } = await launchBrowser();

    let epTitle = null;
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      epTitle = await page.$eval('.detail-hero__title', el => el.textContent.trim()).catch(() => null);
    } catch {}

    const r = await scrapeEpisodeServers(page, url);
    await browser.close();

    const seriesFile = path.join(OUT_SERIES, slug + '.json');
    if (fs.existsSync(seriesFile)) {
      const series = JSON.parse(fs.readFileSync(seriesFile, 'utf8'));
      const seasonIdx = series.seasons.findIndex(s => s.number === season);
      const epIdx = seasonIdx >= 0 ? series.seasons[seasonIdx].episodes.findIndex(e => e.number === episode) : -1;

      if (seasonIdx >= 0 && epIdx >= 0) {
        const epObj = series.seasons[seasonIdx].episodes[epIdx];
        epObj.servers = r.servers;
        epObj.downloadLinks = r.downloadLinks;
        epObj.error = r.error;
        epObj.blocked = r.blocked || false;
        epObj.scrapedAt = new Date().toISOString();

        fs.writeFileSync(seriesFile, JSON.stringify(series, null, 2));

        if (guardarFirebase && tmdb_id && !r.blocked) {
          const episodeData = {
            titulo: epTitle || ('Episodio ' + episode),
            servidores: r.servers,
            downloadLinks: r.downloadLinks,
            url,
            scrapedAt: new Date().toISOString()
          };
          const saved = await fb.guardarEpisodio(tmdb_id, season, episode, episodeData);
          broadcast({ type: 'firebase', ok: saved, tipo: 'episodio', tmdb_id, season, episode });
        }
      }
    }

    broadcast({
      type: 'episode-result',
      slug, season, episode,
      servers: r.servers,
      downloadLinks: r.downloadLinks,
      error: r.error,
      blocked: r.blocked || false
    });
  })();
});

// === API: listar desde Firebase ===
app.get('/api/firebase/peliculas', async (req, res) => {
  try {
    const axios = require('axios');
    const { data } = await axios.get(process.env.FIREBASE_URL + '/peliculas.json');
    res.json(data || {});
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/firebase/series', async (req, res) => {
  try {
    const axios = require('axios');
    const { data } = await axios.get(process.env.FIREBASE_URL + '/series.json');
    res.json(data || {});
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'connected' }));
});

server.listen(PORT, () => {
  console.log('');
  console.log(' Servidor listo en: http://localhost:' + PORT);
  console.log(' Firebase:', process.env.FIREBASE_URL || 'no configurado');
  console.log(' TMDB API Key:', process.env.TMDB_API_KEY ? 'si' : 'NO');
  console.log(' Proxy:', process.env.PROXY_HOST ? 'si (' + process.env.PROXY_HOST + ':' + process.env.PROXY_PORT + ')' : 'NO');
  console.log('');
});