// tmdb.js — thin wrapper around The Movie Database (TMDb) API.
// Get a free API key at https://www.themoviedb.org/settings/api and put it
// in .env as TMDB_API_KEY. Docs: https://developer.themoviedb.org/docs
const fetch = require('node-fetch');

const BASE = 'https://api.themoviedb.org/3';
const REGION = process.env.STREAMING_REGION || 'US';

function apiKeyPresent() {
  return !!process.env.TMDB_API_KEY;
}

async function tmdbGet(pathname, params = {}) {
  if (!apiKeyPresent()) {
    const err = new Error('TMDB_API_KEY is not set. Add it to your .env file.');
    err.code = 'NO_API_KEY';
    throw err;
  }
  const url = new URL(BASE + pathname);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const key = String(process.env.TMDB_API_KEY).trim();
  const headers = { accept: 'application/json' };
  if (key.length > 40) headers.Authorization = 'Bearer ' + key; else url.searchParams.set('api_key', key);
  const res = await fetch(url.toString(), { headers });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`TMDb ${res.status} on ${pathname}: ${body}`);
  }
  return res.json();
}

// Search movies by title (optionally narrowed by year).
async function searchMovies(query, year) {
  const params = { query, include_adult: 'false' };
  if (year) params.year = year;
  const data = await tmdbGet('/search/movie', params);
  return (data.results || []).map((m) => ({
    tmdb_id: m.id,
    title: m.title,
    year: (m.release_date || '').slice(0, 4),
    poster_path: m.poster_path,
    overview: m.overview,
    popularity: m.popularity,
  }));
}

// Get where a movie is currently streaming, for our region, restricted to
// "included with subscription" style access (flatrate + free + ads) — not
// rent/buy, since those are basically always "available" for a fee and
// aren't what a streaming-availability alert is for.
async function getWatchProviders(tmdbId) {
  const data = await tmdbGet(`/movie/${tmdbId}/watch/providers`);
  const regionData = (data.results || {})[REGION];
  if (!regionData) return { link: null, providers: [] };

  const buckets = ['flatrate', 'free', 'ads'];
  const seen = new Map();
  for (const bucket of buckets) {
    for (const p of regionData[bucket] || []) {
      seen.set(p.provider_id, {
        provider_id: p.provider_id,
        provider_name: p.provider_name,
        logo_path: p.logo_path,
        access: bucket,
      });
    }
  }
  return { link: regionData.link || null, providers: Array.from(seen.values()) };
}

// Full list of streaming providers TMDb knows about for movies in our region —
// used to populate/expand the Settings page beyond the starter seed list.
async function getAllMovieProviders() {
  const data = await tmdbGet('/watch/providers/movie', { watch_region: REGION });
  return (data.results || [])
    .map((p) => ({
      provider_id: p.provider_id,
      provider_name: p.provider_name,
      logo_path: p.logo_path,
      display_priority: p.display_priorities ? p.display_priorities[REGION] : p.display_priority,
    }))
    .sort((a, b) => (a.display_priority ?? 999) - (b.display_priority ?? 999));
}

const HORROR_GENRE_ID = 27; // TMDb's fixed genre id for Horror — same for every account/region

// All horror movies currently streamable (flatrate/free/ads) on the given
// TMDb provider_ids, for our region. Used to diff week-over-week and find
// what's newly available. Paginates up to `maxPages` (20 results/page) —
// plenty of headroom for even a broad set of services.
async function discoverHorrorOnProviders(providerIds, { maxPages = 8 } = {}) {
  if (!providerIds.length) return [];
  const all = [];
  let page = 1;
  let totalPages = 1;
  do {
    const data = await tmdbGet('/discover/movie', {
      with_genres: HORROR_GENRE_ID,
      with_watch_providers: providerIds.join('|'),
      watch_region: REGION,
      // TMDb's discover-by-provider filter only matches flatrate/free/ads
      // offers by default (not rent/buy), which is exactly what we want.
      sort_by: 'popularity.desc',
      include_adult: 'false',
      page,
    });
    totalPages = Math.min(data.total_pages || 1, maxPages);
    for (const m of data.results || []) {
      all.push({
        tmdb_id: m.id,
        title: m.title,
        year: (m.release_date || '').slice(0, 4),
        poster_path: m.poster_path,
        popularity: m.popularity,
        vote_average: m.vote_average,
        vote_count: m.vote_count,
      });
    }
    page++;
  } while (page <= totalPages);
  return all;
}

// Basic details for one movie. Used to refresh stored titles/posters, because TMDb's terms don't allow caching its data for more than 6 months.
async function getMovieDetails(tmdbId) {
  const d = await tmdbGet('/movie/' + tmdbId);
  return { title: d.title, year: (d.release_date || '').slice(0, 4), poster_path: d.poster_path };
}
module.exports = {
  apiKeyPresent,
  searchMovies,
  getWatchProviders,
  getMovieDetails,
  getAllMovieProviders,
  discoverHorrorOnProviders,
  HORROR_GENRE_ID,
  REGION,
};
