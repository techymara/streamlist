// checker.js — the checks the weekly digest (and the local "send test digest"
// button) run. Talks to Supabase directly; no local file state.
const { supabase, must } = require('./db');
const tmdb = require('./tmdb');

const MIN_VOTES_FOR_CONFIDENCE = 50; // "m" in the Bayesian formula below

async function getMySelectedServiceIds() {
  const rows = must(
    await supabase.from('my_services').select('provider_id').eq('selected', true),
    'load selected services'
  );
  return rows.map((r) => r.provider_id);
}

// ---------- 1. Horror genre-wide discovery ("new this week") ----------
async function checkHorrorDiscovery({ verbose = false } = {}) {
  const mySelectedIds = await getMySelectedServiceIds();
  if (mySelectedIds.length === 0) {
    if (verbose) console.warn('[checker] No services selected — skipping horror discovery.');
    return [];
  }

  const currentHorror = await tmdb.discoverHorrorOnProviders(mySelectedIds);

  const alreadySeen = must(await supabase.from('horror_seen').select('tmdb_id'), 'load horror_seen');
  const seenIds = new Set(alreadySeen.map((r) => r.tmdb_id));
  const brandNew = currentHorror.filter((m) => !seenIds.has(m.tmdb_id));

  // Mark everything currently on-screen as seen (including titles that were
  // already known) so nothing gets re-reported next week.
  if (currentHorror.length) {
    await supabase.from('horror_seen').upsert(
      currentHorror.map((m) => ({ tmdb_id: m.tmdb_id, title: m.title, year: m.year, poster_path: m.poster_path })),
      { onConflict: 'tmdb_id', ignoreDuplicates: true }
    );
  }

  const withProviders = [];
  for (const m of brandNew) {
    try {
      const providers = await tmdb.getWatchProviders(m.tmdb_id);
      const mySet = new Set(mySelectedIds);
      const onMine = providers.providers.filter((p) => mySet.has(p.provider_id));
      withProviders.push({ ...m, providerNames: onMine.map((p) => p.provider_name) });
    } catch (err) {
      withProviders.push({ ...m, providerNames: [] });
    }
  }

  if (verbose) console.log(`[checker] ${withProviders.length} new horror titles this week`);
  return withProviders;
}

// ---------- 2. Top 10 recommendations (quality-score ranked) ----------
// Uses the same "weighted rating" formula IMDb's Top 250 is built on:
//   WR = (v / (v+m)) * R  +  (m / (v+m)) * C
// where R = a title's own vote_average, v = its vote_count, C = the mean
// vote_average across the candidate pool, and m = a minimum-votes threshold.
// This keeps a 9.0-from-40-votes title from beating a 7.8-from-20,000-votes
// title — low-signal ratings get pulled toward the pool average instead of
// trusted outright.
function rankByQuality(movies) {
  const withVotes = movies.filter((m) => typeof m.vote_average === 'number' && m.vote_count > 0);
  if (!withVotes.length) return [];
  const C = withVotes.reduce((sum, m) => sum + m.vote_average, 0) / withVotes.length;
  const m = MIN_VOTES_FOR_CONFIDENCE;

  return withVotes
    .map((movie) => {
      const v = movie.vote_count;
      const R = movie.vote_average;
      const score = (v / (v + m)) * R + (m / (v + m)) * C;
      return { ...movie, score: Math.round(score * 100) / 100 };
    })
    .sort((a, b) => b.score - a.score);
}

async function getTopHorrorRecommendations({ verbose = false, limit = 10 } = {}) {
  const mySelectedIds = await getMySelectedServiceIds();
  if (mySelectedIds.length === 0) {
    if (verbose) console.warn('[checker] No services selected — skipping recommendations.');
    return [];
  }

  const pool = await tmdb.discoverHorrorOnProviders(mySelectedIds, { maxPages: 10 });
  const ranked = rankByQuality(pool).slice(0, limit);

  // Mark which of these you've already watched, per your Letterboxd import
  // (status = 'watched' in liked_movies — see the Settings import UI).
  const ids = ranked.map((m) => m.tmdb_id);
  let watchedIds = new Set();
  if (ids.length) {
    const watched = must(
      await supabase.from('liked_movies').select('tmdb_id').eq('status', 'watched').in('tmdb_id', ids),
      'load watched status'
    );
    watchedIds = new Set(watched.map((r) => r.tmdb_id));
  }

  const withProviders = [];
  for (const movie of ranked) {
    let providerNames = [];
    try {
      const providers = await tmdb.getWatchProviders(movie.tmdb_id);
      const mySet = new Set(mySelectedIds);
      providerNames = providers.providers.filter((p) => mySet.has(p.provider_id)).map((p) => p.provider_name);
    } catch (err) {
      // leave providerNames empty rather than failing the whole digest
    }
    withProviders.push({ ...movie, providerNames, seen: watchedIds.has(movie.tmdb_id) });
  }

  if (verbose) console.log(`[checker] Top ${withProviders.length} horror recommendations ranked.`);
  return withProviders;
}

// ---------- 3. Keep the My List page's availability badges fresh ----------
// No longer used for the email (replaced by the recommendations above), but
// the "My List" tab in the app still shows a "streaming on X" badge per
// liked movie, driven by this cached data — so it's worth refreshing on the
// same weekly run rather than only when you happen to have the app open.
async function refreshLikedAvailability({ verbose = false } = {}) {
  const mySelectedIds = await getMySelectedServiceIds();
  const likedMovies = must(
    await supabase.from('liked_movies').select('id, tmdb_id, title').neq('status', 'watched'),
    'load liked movies'
  );

  let updated = 0;
  for (const movie of likedMovies) {
    try {
      const providers = await tmdb.getWatchProviders(movie.tmdb_id);
      const currentIds = providers.providers.map((p) => p.provider_id);
      await supabase.from('liked_movies').update({ last_known_provider_ids: currentIds }).eq('id', movie.id);
      updated++;
    } catch (err) {
      if (verbose) console.error(`[checker] ${movie.title}: ${err.message}`);
    }
  }
  if (verbose) console.log(`[checker] Refreshed availability for ${updated} liked movies.`);
  return updated;
}

module.exports = { checkHorrorDiscovery, getTopHorrorRecommendations, refreshLikedAvailability };
