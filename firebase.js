const axios = require('axios');
require('dotenv').config();

const FIREBASE_URL = process.env.FIREBASE_URL || 'https://peliculasspay-default-rtdb.firebaseio.com';

// ===== PELICULAS =====
// Guarda la pelicula completa CON servidores en /peliculas/<tmdb_id>
async function guardarPelicula(tmdbId, data) {
  try {
    // Limpiar cualquier residuo de series
    delete data.seasons;
    delete data.episodios;

    await axios.put(`${FIREBASE_URL}/peliculas/${tmdbId}.json`, data);
    return true;
  } catch (e) {
    console.error('Firebase error (pelicula):', e.message);
    return false;
  }
}

// ===== SERIES =====
// Guarda SOLO la metadata en /series/<tmdb_id>
// NO guarda seasons ni episodios
async function guardarSerie(tmdbId, data) {
  try {
    const serieMeta = {
      tmdb_id: String(tmdbId),
      titulo: data.title || data.titulo,
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
      scrapedAt: data.scrapedAt || new Date().toISOString()
    };

    await axios.put(`${FIREBASE_URL}/series/${tmdbId}.json`, serieMeta);
    return true;
  } catch (e) {
    console.error('Firebase error (serie):', e.message);
    return false;
  }
}

// ===== EPISODIOS =====
// Guarda UN episodio CON sus servidores en:
// /episodios/<tmdb_id>/<temporada>/<episodio>
async function guardarEpisodio(tmdbId, temporada, episodio, data) {
  try {
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
      `${FIREBASE_URL}/episodios/${tmdbId}/${temporada}/${episodio}.json`,
      episodeData
    );
    return true;
  } catch (e) {
    console.error(`Firebase error (episodio T${temporada}E${episodio}):`, e.message);
    return false;
  }
}

// ===== LECTURA =====
async function leerPelicula(tmdbId) {
  try {
    const { data } = await axios.get(`${FIREBASE_URL}/peliculas/${tmdbId}.json`);
    return data;
  } catch (e) { return null; }
}

async function leerSerie(tmdbId) {
  try {
    const { data } = await axios.get(`${FIREBASE_URL}/series/${tmdbId}.json`);
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
