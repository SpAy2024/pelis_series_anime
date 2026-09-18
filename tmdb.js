const axios = require('axios');
require('dotenv').config();

const API_KEY = process.env.TMDB_API_KEY;
const BASE = 'https://api.themoviedb.org/3';

if (!API_KEY) {
  console.warn('TMDB_API_KEY no configurada en .env');
}

async function buscarPelicula(titulo, year = null) {
  if (!API_KEY) return null;
  try {
    const params = { api_key: API_KEY, query: titulo, language: 'es-MX' };
    if (year) params.year = year;

    const { data } = await axios.get(`${BASE}/search/movie`, { params });
    if (!data.results || data.results.length === 0) return null;

    const best = data.results.sort((a, b) => b.popularity - a.popularity)[0];
    return {
      tmdb_id: String(best.id),
      titulo: best.title,
      titulo_original: best.original_title,
      overview: best.overview,
      release_date: best.release_date,
      poster_url: best.poster_path ? `https://image.tmdb.org/t/p/w500${best.poster_path}` : null,
      backdrop_url: best.backdrop_path ? `https://image.tmdb.org/t/p/w1280${best.backdrop_path}` : null,
      vote_average: best.vote_average,
      vote_count: best.vote_count,
      generos: best.genre_ids
    };
  } catch (e) {
    console.error('TMDB error (pelicula):', e.message);
    return null;
  }
}

async function buscarSerie(titulo, year = null) {
  if (!API_KEY) return null;
  try {
    const params = { api_key: API_KEY, query: titulo, language: 'es-MX' };
    if (year) params.first_air_date_year = year;

    const { data } = await axios.get(`${BASE}/search/tv`, { params });
    if (!data.results || data.results.length === 0) return null;

    const best = data.results.sort((a, b) => b.popularity - a.popularity)[0];
    return {
      tmdb_id: String(best.id),
      titulo: best.name,
      titulo_original: best.original_name,
      overview: best.overview,
      first_air_date: best.first_air_date,
      poster_url: best.poster_path ? `https://image.tmdb.org/t/p/w500${best.poster_path}` : null,
      backdrop_url: best.backdrop_path ? `https://image.tmdb.org/t/p/w1280${best.backdrop_path}` : null,
      vote_average: best.vote_average,
      vote_count: best.vote_count,
      generos: best.genre_ids
    };
  } catch (e) {
    console.error('TMDB error (serie):', e.message);
    return null;
  }
}

async function detallePelicula(tmdbId) {
  if (!API_KEY) return null;
  try {
    const { data } = await axios.get(`${BASE}/movie/${tmdbId}`, {
      params: { api_key: API_KEY, language: 'es-MX' }
    });
    return {
      tmdb_id: String(data.id),
      titulo: data.title,
      titulo_original: data.original_title,
      overview: data.overview,
      tagline: data.tagline,
      release_date: data.release_date,
      runtime: data.runtime,
      poster_url: data.poster_path ? `https://image.tmdb.org/t/p/w500${data.poster_path}` : null,
      backdrop_url: data.backdrop_path ? `https://image.tmdb.org/t/p/w1280${data.backdrop_path}` : null,
      vote_average: data.vote_average,
      vote_count: data.vote_count,
      generos: (data.genres || []).map(g => g.name),
      year: (data.release_date || '').slice(0, 4)
    };
  } catch (e) {
    console.error('TMDB error (detalle pelicula):', e.message);
    return null;
  }
}

async function detalleSerie(tmdbId) {
  if (!API_KEY) return null;
  try {
    const { data } = await axios.get(`${BASE}/tv/${tmdbId}`, {
      params: { api_key: API_KEY, language: 'es-MX' }
    });
    return {
      tmdb_id: String(data.id),
      titulo: data.name,
      titulo_original: data.original_name,
      overview: data.overview,
      tagline: data.tagline,
      first_air_date: data.first_air_date,
      temporadas: data.number_of_seasons,
      episodios_total: data.number_of_episodes,
      poster_url: data.poster_path ? `https://image.tmdb.org/t/p/w500${data.poster_path}` : null,
      backdrop_url: data.backdrop_path ? `https://image.tmdb.org/t/p/w1280${data.backdrop_path}` : null,
      vote_average: data.vote_average,
      vote_count: data.vote_count,
      generos: (data.genres || []).map(g => g.name),
      year: (data.first_air_date || '').slice(0, 4)
    };
  } catch (e) {
    console.error('TMDB error (detalle serie):', e.message);
    return null;
  }
}

module.exports = {
  buscarPelicula,
  buscarSerie,
  detallePelicula,
  detalleSerie
};
