const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const fs = require('fs');
const path = require('path');

const BASE = 'https://serieskao.top';
const START_URL = `${BASE}/peliculas`;

// === Argumentos: --from N --to M ===
const args = process.argv.slice(2);
function getArg(name, def) {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? parseInt(args[i + 1]) : def;
}

const FROM = getArg('--from', 1);
const TO = getArg('--to', 5);
const DELAY = getArg('--delay', 2000); // ms entre páginas

const OUT_DIR = 'urls';
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR);

// === MAIN ===
(async () => {
  console.log(`📄 Scrapeando páginas ${FROM} a ${TO}`);
  console.log(`⏱️  Delay entre páginas: ${DELAY}ms`);
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

  let totalUrls = 0;
  const allUrls = new Set();

  for (let pageNum = FROM; pageNum <= TO; pageNum++) {
    const url = pageNum === 1 ? START_URL : `${START_URL}?page=${pageNum}`;
    const outFile = path.join(OUT_DIR, `page-${String(pageNum).padStart(4, '0')}.txt`);

    // Si ya existe, saltar
    if (fs.existsSync(outFile)) {
      const existing = fs.readFileSync(outFile, 'utf8').split('\n').filter(Boolean);
      console.log(`⏭️  Página ${pageNum}: ya existe (${existing.length} URLs), saltando`);
      existing.forEach(u => allUrls.add(u));
      totalUrls += existing.length;
      continue;
    }

    process.stdout.write(`📄 Página ${pageNum} ... `);

    try {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

      // Esperar cards con timeout corto
      try {
        await page.waitForSelector('article.card a.card__link', { timeout: 8000 });
      } catch {
        console.log(`⚠️  Sin cards (¿página vacía o inexistente?)`);
        // Guardar archivo vacío para no reintentar
        fs.writeFileSync(outFile, '', 'utf8');
        continue;
      }

      // Extraer URLs
      const urls = await page.$$eval('article.card a.card__link', (links) =>
        links
          .map(a => a.getAttribute('href'))
          .filter(h => h && h.includes('/pelicula/'))
          .map(h => h.startsWith('http') ? h : 'https://serieskao.top' + h)
      );

      // Deduplicar dentro de la página
      const unique = Array.from(new Set(urls));

      // Guardar archivo de la página
      fs.writeFileSync(outFile, unique.join('\n'), 'utf8');

      unique.forEach(u => allUrls.add(u));
      totalUrls += unique.length;

      // Detectar total de páginas
      const totalPages = await page.evaluate(() => {
        const m = document.body.innerText.match(/Página\s+\d+\s+de\s+(\d+)/i);
        return m ? parseInt(m[1]) : null;
      }).catch(() => null);

      console.log(`✅ ${unique.length} URLs${totalPages ? ` (de ${totalPages} páginas)` : ''}`);

      // Si llegamos a la última página real, parar
      if (totalPages && pageNum >= totalPages) {
        console.log(`\n🏁 Alcanzada última página real (${totalPages}). Parando.`);
        break;
      }

    } catch (e) {
      console.log(`❌ Error: ${e.message}`);
      // No guardar archivo, así se puede reintentar
    }

    if (pageNum < TO) await new Promise(r => setTimeout(r, DELAY));
  }

  await browser.close();

  // === Resumen final ===
  console.log(`\n${'='.repeat(60)}`);
  console.log(`🎉 COMPLETADO`);
  console.log(`   Páginas procesadas: ${FROM} a ${TO}`);
  console.log(`   URLs totales (únicas): ${allUrls.size}`);
  console.log(`   Archivos guardados en: F:\\KAO\\${OUT_DIR}\\`);
  console.log(`${'='.repeat(60)}`);

  // Guardar resumen
  fs.writeFileSync(
    path.join(OUT_DIR, `_summary-${FROM}-${TO}.json`),
    JSON.stringify({
      from: FROM,
      to: TO,
      totalUrls: allUrls.size,
      files: fs.readdirSync(OUT_DIR).filter(f => f.startsWith('page-'))
    }, null, 2)
  );
})();