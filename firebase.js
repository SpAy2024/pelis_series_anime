const axios = require('axios');
require('dotenv').config();

const FIREBASE_URL = process.env.FIREBASE_URL || 'https://peliculasspay-default-rtdb.firebaseio.com';

function getKey(data, tmdbId) {
  if (tmdbId && String(tmdbId).trim() !== '' && String(tmdbId) !== 'null') {
    return String(tmdbId);
  }
  return data.slug || 'sin-id';
}

async function guardarPelicula(tmdbId, data) {
  try {
    const key = getKey(data, tmdbId);
    const payload = { ...data };
    delete payload.seasons;
    delete payload.episodios;
    payload.firebase_key = key;

    await axios.put(`${FIREBASE_URL}/peliculas/${key}.json`, payload);
    console.log(`[FB] Pelicula guardada en /peliculas/${key}`);
    return true;
  } catch (e) {
    console.error('Firebase error (pelicula):', e.message);
    return false;
  }
}

async function guardarSerie(tmdbId, data) {
  try {
    const key = getKey(data, tmdbId);

    const serieMeta = {
      tmdb_id: (tmdbId && String(tmdbId) !== 'null') ? String(tmdbId) : null,
      firebase_key: key,
      titulo: data.title || data.titulo || null,
      titulo_original: data.titulo_original || null,
      overview: data.overview || data.description || null,
      poster_url: data.poster_url || null,
      backdrop_url: data.backdrop_url || null,
      generos: data.generos || [],
      vote_average: data.vote_average || null,
      vote_count: data.vote_count || null,
      year: data.year || null,
      first_air_date: data.first_air_date || null,
      temporadas: data.temporadas || (data.seasons ? data.seasons.length : null),
      url: data.url || null,
      type: data.type || 'serie',
      slug: data.slug || null,
      scrapedAt: data.scrapedAt || new Date().toISOString()
    };

    await axios.put(`${FIREBASE_URL}/series/${key}.json`, serieMeta);
    console.log(`[FB] Serie guardada en /series/${key}`);
    return true;
  } catch (e) {
    console.error('Firebase error (serie):', e.message);
    return false;
  }
}

async function guardarEpisodio(tmdbIdOrSlug, temporada, episodio, data) {
  try {
    const key = (tmdbIdOrSlug && String(tmdbIdOrSlug) !== 'null')
      ? String(tmdbIdOrSlug)
      : (data.slug || 'sin-id');

    const episodeData = {
      numero: episodio,
      temporada: temporada,
      titulo: data.titulo || ('Episodio ' + episodio),
      servidores: data.servidores || [],
      downloadLinks: data.downloadLinks || [],
      url: data.url || null,
      scrapedAt: data.scrapedAt || new Date().toISOString()
    };

    if (data.error) episodeData.error = data.error;

    await axios.put(
      `${FIREBASE_URL}/episodios/${key}/${temporada}/${episodio}.json`,
      episodeData
    );
    return true;
  } catch (e) {
    console.error(`Firebase error (episodio T${temporada}E${episodio}):`, e.message);
    return false;
  }
}

async function leerPelicula(key) {
  try {
    const { data } = await axios.get(`${FIREBASE_URL}/peliculas/${key}.json`);
    return data;
  } catch (e) { return null; }
}

async function leerSerie(key) {
  try {
    const { data } = await axios.get(`${FIREBASE_URL}/series/${key}.json`);
    return data;
  } catch (e) { return null; }
}

module.exports = {
  guardarPelicula,
  guardarSerie,
  guardarEpisodio,
  leerPelicula,
  leerSerie
};
