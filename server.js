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

// === Scraper de servidores de un episodio (o pelicula) ===
async function scrapeEpisodeServers(page, url) {
  const result = { servers: [], downloadLinks: [], error: null };

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForSelector('.player-box__servers .server-btn', { timeout: 45000 });

    await page.mouse.move(500, 400);
    await new Promise(r => setTimeout(r, 800));
    await page.mouse.move(800, 600);
    await page.evaluate(() => window.scrollBy(0, 300));
    await new Promise(r => setTimeout(r, 1000));

    await page.click('.player-box__servers .server-btn');
    await new Promise(r => setTimeout(r, 6000));

    let iframeFrame = null;
    for (const frame of page.frames()) {
      if (frame.url().includes('/vidurl/')) { iframeFrame = frame; break; }
    }
    if (!iframeFrame) { result.error = 'no iframe'; return result; }

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
        if (state.decrypted) { decrypted = state; break; }
      } catch {}
    }

    if (!decrypted) { result.error = 'timeout descifrado'; return result; }

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

    return result;
  } catch (e) {
    result.error = e.message;
    return result;
  }
}

// === Scraper de serie/anime ===
async function scrapeSeries(page, url) {
  const slug = slugFromUrl(url);
  const type = detectType(url);
  const result = {
    url,
    slug,
    type,
    title: null,
    description: null,
    seasons: [],
    error: null,
    scrapedAt: new Date().toISOString()
  };

  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

    result.title = await page.$eval('.detail-hero__title', el => el.textContent.trim()).catch(() => null);
    result.description = await page.$eval('.detail-hero__desc', el => el.textContent.trim()).catch(() => null);

    const seasons = await page.evaluate(() => {
      const set = new Set();
      document.querySelectorAll('a[href*="/temporada/"]').forEach(a => {
        const m = a.getAttribute('href').match(/\/temporada\/(\d+)/);
        if (m) set.add(parseInt(m[1]));
      });
      return Array.from(set).sort((a, b) => a - b);
    });

    if (seasons.length === 0) seasons.push(1);

    for (const seasonNum of seasons) {
      const seasonUrl = url.replace(/\/$/, '') + '/temporada/' + seasonNum + '/capitulo/1';
      await page.goto(seasonUrl, { waitUntil: 'networkidle2', timeout: 60000 });
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

      result.seasons.push({ number: seasonNum, episodes });
    }

    return result;
  } catch (e) {
    result.error = e.message;
    return result;
  }
}

// === Scrapear TODOS los episodios de una serie ===
async function scrapeAllEpisodesFn(page, seriesData, onProgress) {
  const total = seriesData.seasons.reduce((sum, s) => sum + s.episodes.length, 0);
  let done = 0;

  for (const season of seriesData.seasons) {
    for (const ep of season.episodes) {
      done++;
      if (onProgress) onProgress(done, total, season.number, ep.number);

      try {
        const r = await scrapeEpisodeServers(page, ep.url);
        ep.servers = r.servers;
        ep.downloadLinks = r.downloadLinks;
        ep.error = r.error;
        ep.scrapedAt = new Date().toISOString();
      } catch (e) {
        ep.servers = [];
        ep.error = e.message;
      }

      await new Promise(r => setTimeout(r, 1500));
    }
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

    const browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled']
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    let ok = 0, fail = 0;

    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      const slug = slugFromUrl(url);
      const type = detectType(url);

      broadcast({ type: 'progress', index: i + 1, total: urls.length, slug, url, kind: type });

      try {
        if (type === 'pelicula') {
          // === PELICULA ===
          await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
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
            error: r.error
          };

          fs.writeFileSync(path.join(OUT_DIR, slug + '.json'), JSON.stringify(result, null, 2));

          if (guardarFirebase && result.tmdb_id) {
            const saved = await fb.guardarPelicula(result.tmdb_id, result);
            broadcast({ type: 'firebase', ok: saved, tipo: 'pelicula', tmdb_id: result.tmdb_id });
          }

          if (r.error) { fail++; broadcast({ type: 'result', index: i + 1, total: urls.length, result, ok: false }); }
          else { ok++; broadcast({ type: 'result', index: i + 1, total: urls.length, result, ok: true }); }

        } else {
          // === SERIE / ANIME / DORAMA ===
          const seriesData = await scrapeSeries(page, url);

          if (seriesData.error) {
            fail++;
            broadcast({ type: 'result', index: i + 1, total: urls.length, result: seriesData, ok: false });
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

            // Scrapear todos los episodios si se pidio
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

              broadcast({ type: 'episodes-done', slug: seriesData.slug });
            }

            fs.writeFileSync(path.join(OUT_SERIES, seriesData.slug + '.json'), JSON.stringify(seriesData, null, 2));

            if (guardarFirebase && seriesData.tmdb_id) {
  // 1. Guardar SOLO metadata de la serie
  const saved = await fb.guardarSerie(seriesData.tmdb_id, seriesData);
  broadcast({ type: 'firebase', ok: saved, tipo: 'serie', tmdb_id: seriesData.tmdb_id });

  // 2. Guardar cada episodio APARTE en /episodios/<tmdb_id>/<temp>/<ep>
  let epGuardados = 0;
  for (const season of seriesData.seasons) {
    for (const ep of season.episodes) {
      if (ep.servers && ep.servers.length > 0) {
        const okEp = await fb.guardarEpisodio(seriesData.tmdb_id, season.number, ep.number, {
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
  broadcast({
    type: 'firebase',
    ok: true,
    tipo: 'episodios',
    tmdb_id: seriesData.tmdb_id,
    total: epGuardados
  });
}

            broadcast({ type: 'series', index: i + 1, total: urls.length, series: seriesData });
            ok++;
            broadcast({ type: 'result', index: i + 1, total: urls.length, result: seriesData, ok: true });
          }
        }

      } catch (e) {
        fail++;
        broadcast({ type: 'result', index: i + 1, total: urls.length, result: { url, slug, error: e.message }, ok: false });
      }

      if (i < urls.length - 1) await new Promise(r => setTimeout(r, 3000));
    }

    await browser.close();
    broadcast({ type: 'done', ok, fail, total: urls.length });
  })();
});

// === API: scrapear un episodio especifico ===
app.post('/api/scrape-episode', async (req, res) => {
  const { url, slug, season, episode, tmdb_id, guardarFirebase = true } = req.body;
  if (!url) return res.status(400).json({ error: 'url requerida' });

  res.json({ ok: true });

  (async () => {
    broadcast({ type: 'episode-start', slug, season, episode, url });

    const browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled']
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    let epTitle = null;
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      epTitle = await page.$eval('.detail-hero__title', el => el.textContent.trim()).catch(() => null);
    } catch {}

    const r = await scrapeEpisodeServers(page, url);
    await browser.close();

    // Actualizar archivo local + Firebase
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
        epObj.scrapedAt = new Date().toISOString();

        fs.writeFileSync(seriesFile, JSON.stringify(series, null, 2));

       if (guardarFirebase && tmdb_id) {
  const episodeData = {
    titulo: epTitle || ('Episodio ' + episode),
    servidores: r.servers,
    downloadLinks: r.downloadLinks,
    url,
    scrapedAt: new Date().toISOString(),
    error: r.error
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
      error: r.error
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
  console.log('');
});
