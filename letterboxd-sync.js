// letterboxd-sync.js — keeps your "watched" list current without a manual CSV
// import. Reads your public Letterboxd activity feed (letterboxd.com/<you>/rss/)
// and marks every film in it as watched. The feed only holds your most recent
// entries, so this keeps the list fresh; your original CSV import still
// provides the full history.
const { supabase } = require('./db');

const LETTERBOXD_USERNAME = process.env.LETTERBOXD_USERNAME || 'horrorbee';

function tag(block, name) {
  const m = block.match(new RegExp('<' + name + '>([\\s\\S]*?)</' + name + '>'));
  return m ? m[1].trim() : null;
}

function decode(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

// Pure function: feed XML in, list of films out. Lists and anything without a
// TMDb id are skipped.
function parseFeed(xml) {
  const films = [];
  for (const block of xml.split('<item>').slice(1)) {
    const tmdbId = parseInt(tag(block, 'tmdb:movieId'), 10);
    if (!tmdbId) continue;
    const rating = parseFloat(tag(block, 'letterboxd:memberRating'));
    films.push({
      tmdb_id: tmdbId,
      title: decode(tag(block, 'letterboxd:filmTitle') || ''),
      year: tag(block, 'letterboxd:filmYear'),
      letterboxd_rating: Number.isNaN(rating) ? null : rating,
    });
  }
  return films;
}

async function syncLetterboxdRss({ verbose = false } = {}) {
  const url = `https://letterboxd.com/${encodeURIComponent(LETTERBOXD_USERNAME)}/rss/`;
  const res = await fetch(url, { headers: { 'User-Agent': 'streamlist-personal-tool' } });
  if (!res.ok) throw new Error(`Letterboxd feed returned ${res.status}`);
  const films = parseFeed(await res.text()).filter((f) => f.title);

  // One row per film (a film can appear more than once if you rewatched it).
  const byId = new Map();
  for (const f of films) byId.set(f.tmdb_id, f);
  const rows = Array.from(byId.values()).map((f) => {
    const row = {
      tmdb_id: f.tmdb_id,
      title: f.title,
      year: f.year,
      status: 'watched',
      source: 'letterboxd',
      tmdb_refreshed_at: new Date().toISOString(),
    };
    if (f.letterboxd_rating !== null) row.letterboxd_rating = f.letterboxd_rating;
    return row;
  });
  if (!rows.length) return 0;

  const { error } = await supabase.from('liked_movies').upsert(rows, { onConflict: 'tmdb_id' });
  if (error) throw new Error('save watched films: ' + error.message);
  if (verbose) console.log(`[letterboxd] Marked ${rows.length} films from your feed as watched.`);
  return rows.length;
}

module.exports = { syncLetterboxdRss, parseFeed };
