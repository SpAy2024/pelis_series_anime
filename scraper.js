const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const fs = require('fs');
const path = require('path');

// === Argumentos ===
const args = process.argv.slice(2);

function getArg(name, def) {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : def;
}

const URL_INPUT = getArg('--url', null);
const FROM_FILE = getArg('--file', null);
const FORCE = args.includes('--force');

const OUT_DIR = 'enlaces';
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR);

// === Utilidad ===
function slugFromUrl(url) {
  const m = url.match(/\/pelicula\/([^\/\?]+)/);
  return m ? m[1] : null;
}

// === Scrapear una película ===
async function scrapeMovie(page, url) {
  const slug = slugFromUrl(url);
  if (!slug) return { url, error: 'URL inválida' };

  const outFile = path.join(OUT_DIR, `${slug}.json`);

  // Si ya existe y no se fuerza, saltar
  if (fs.existsSync(outFile) && !FORCE) {
    const existing = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    console.log(`⏭️  ${slug}: ya existe (${existing.servers?.length || 0} servidores), saltando`);
    return existing;
  }

  const result = {
    url,
    slug,
    title: null,
    servers: [],
    downloadLinks: [],
    scrapedAt: new Date().toISOString(),
    error: null
  };

  console.log(`\n🎬 ${slug}`);

  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
    await page.waitForSelector('.player-box__servers .server-btn', { timeout: 15000 });

    result.title = await page.$eval('.detail-hero__title', el => el.textContent.trim()).catch(() => null);
    console.log(`   📌 ${result.title}`);

    // Simular actividad
    await page.mouse.move(500, 400);
    await new Promise(r => setTimeout(r, 800));
    await page.mouse.move(800, 600);
    await page.evaluate(() => window.scrollBy(0, 300));
    await new Promise(r => setTimeout(r, 1000));

    // Click en Embed69
    await page.click('.player-box__servers .server-btn');
    await new Promise(r => setTimeout(r, 6000));

    // Encontrar iframe
    let iframeFrame = null;
    for (const frame of page.frames()) {
      if (frame.url().includes('/vidurl/')) { iframeFrame = frame; break; }
    }
    if (!iframeFrame) {
      result.error = 'no iframe';
      console.log(`   ❌ no iframe`);
      fs.writeFileSync(outFile, JSON.stringify(result, null, 2));
      return result;
    }

    // Esperar descifrado
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

    if (!decrypted) {
      result.error = 'timeout descifrado';
      console.log(`   ❌ timeout descifrado`);
      fs.writeFileSync(outFile, JSON.stringify(result, null, 2));
      return result;
    }

    for (const file of decrypted.dataLink) {
      if (file.sortedEmbeds) {
        for (const e of file.sortedEmbeds) {
          result.servers.push({ language: file.video_language, server: e.servername, type: e.type, url: e.link });
        }
      }
      if (file.downloadEmbeds) {
        for (const e of file.downloadEmbeds) {
          result.downloadLinks.push({ language: file.video_language, server: e.servername, type: e.type, url: e.link });
        }
      }
    }

    fs.writeFileSync(outFile, JSON.stringify(result, null, 2));
    console.log(`   ✅ ${result.servers.length} servidores → ${outFile}`);
    return result;

  } catch (e) {
    result.error = e.message;
    console.log(`   ❌ ${e.message}`);
    fs.writeFileSync(outFile, JSON.stringify(result, null, 2));
    return result;
  }
}

// === MAIN ===
(async () => {
  let urls = [];

  if (URL_INPUT) {
    urls = [URL_INPUT];
  } else if (FROM_FILE) {
    if (!fs.existsSync(FROM_FILE)) {
      console.error(`❌ No existe ${FROM_FILE}`);
      process.exit(1);
    }
    urls = fs.readFileSync(FROM_FILE, 'utf8')
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.startsWith('http'));
  } else {
    console.error('❌ Uso:');
    console.error('   node scraper.js --url "https://serieskao.top/pelicula/xxx"');
    console.error('   node scraper.js --file urls.txt');
    console.error('   Añade --force para re-scrapear aunque ya exista');
    process.exit(1);
  }

  console.log(`📋 ${urls.length} película(s) a procesar`);
  console.log(`💾 Guardando en: F:\\KAO\\${OUT_DIR}\\\n`);

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

  for (const url of urls) {
    const r = await scrapeMovie(page, url);
    if (r.error) fail++; else ok++;

    // Pausa entre películas
    if (urls.indexOf(url) < urls.length - 1) {
      await new Promise(res => setTimeout(res, 3000));
    }
  }

  await browser.close();

  console.log(`\n${'='.repeat(60)}`);
  console.log(`🎉 COMPLETADO`);
  console.log(`   ✅ Exitosas: ${ok}`);
  console.log(`   ❌ Fallidas: ${fail}`);
  console.log(`   💾 Archivos en: F:\\KAO\\${OUT_DIR}\\`);
  console.log(`${'='.repeat(60)}`);
})();