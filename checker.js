// checker.js — the checks the weekly digest (and the local "send test digest"
// button) run. Talks to Supabase directly; no local file state.
const { supabase, must } = require('./db');
const tmdb = require('./tmdb');

const MIN_VOTES_FOR_CONFIDENCE = 50; // "m" in the Bayesian formula below

// TMDb's terms don't allow keeping TMDb data for more than 6 months.
const HORROR_SEEN_MAX_AGE_DAYS = 150; // drop titles not on your services for ~5 months
const TMDB_REFRESH_AFTER_DAYS = 30; // re-fetch stored TMDb details older than this

function daysAgoIso(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

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
  // already known) so nothing gets re-reported next week. This also refreshes
  // the stored title/poster and the last_seen_at date on every run.
  if (currentHorror.length) {
    const nowIso = new Date().toISOString();
    const byId = new Map();
    for (const m of currentHorror) {
      byId.set(m.tmdb_id, {
        tmdb_id: m.tmdb_id,
        title: m.title,
        year: m.year,
        poster_path: m.poster_path,
        last_seen_at: nowIso,
      });
    }
    const { error: upsertError } = await supabase
      .from('horror_seen')
      .upsert(Array.from(byId.values()), { onConflict: 'tmdb_id' });
    if (upsertError) throw new Error('save horror_seen: ' + upsertError.message);
  }

  // TMDb terms: don't keep TMDb data more than 6 months. Remove titles that
  // haven't shown up on your services for a long time.
  const { error: purgeError } = await supabase
    .from('horror_seen')
    .delete()
    .lt('last_seen_at', daysAgoIso(HORROR_SEEN_MAX_AGE_DAYS));
  if (purgeError) throw new Error('purge horror_seen: ' + purgeError.message);

  // Don't report titles you've already watched (per your Letterboxd import) —
  // "new to streaming" isn't useful if you've already seen the movie elsewhere.
  let watchedIds = new Set();
  if (brandNew.length) {
    const watched = must(
      await supabase
        .from('liked_movies')
        .select('tmdb_id')
        .eq('status', 'watched')
        .in('tmdb_id', brandNew.map((m) => m.tmdb_id)),
      'load watched status'
    );
    watchedIds = new Set(watched.map((r) => r.tmdb_id));
  }
  const unseenNew = brandNew.filter((m) => !watchedIds.has(m.tmdb_id));

  const withProviders = [];
  for (const m of unseenNew) {
    try {
      const providers = await tmdb.getWatchProviders(m.tmdb_id);
      const mySet = new Set(mySelectedIds);
      const onMine = providers.providers.filter((p) => mySet.has(p.provider_id));
      withProviders.push({ ...m, providerNames: onMine.map((p) => p.provider_name) });
    } catch (err) {
      withProviders.push({ ...m, providerNames: [] });
    }
  }

  if (verbose) console.log(`[checker] ${withProviders.length} new horror titles this week (already-watched excluded)`);
  return withProviders;
}

// ---------- 2. Top 10 recommendations (quality-score ranked) ----------
// Uses the same "weighted rating" formula IMDb's Top 250 is built on:
//   WR = (v / (v+m)) * R + (m / (v+m)) * C
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

  // TMDb terms: stored TMDb data (titles, posters, service names/logos) must
  // not be kept more than 6 months, so re-fetch anything older than 30 days.
  // A failure here must never break the digest.
  try {
    await refreshStaleTmdbData({ verbose });
  } catch (err) {
    console.error(`[checker] TMDb data refresh failed: ${err.message}`);
  }
  return updated;
}

// ---------- 4. Keep stored TMDb data fresh (6-month rule) ----------
async function refreshStaleTmdbData({ verbose = false } = {}) {
  const cutoff = daysAgoIso(TMDB_REFRESH_AFTER_DAYS);

  // Liked / watched movies: re-fetch title, year and poster from TMDb.
  const staleMovies = must(
    await supabase.from('liked_movies').select('id, tmdb_id, title').lt('tmdb_refreshed_at', cutoff),
    'load stale liked movies'
  );
  let moviesRefreshed = 0;
  for (const movie of staleMovies) {
    try {
      const d = await tmdb.getMovieDetails(movie.tmdb_id);
      const { error } = await supabase
        .from('liked_movies')
        .update({
          title: d.title || movie.title,
          year: d.year,
          poster_path: d.poster_path,
          tmdb_refreshed_at: new Date().toISOString(),
        })
        .eq('id', movie.id);
      if (error) throw new Error(error.message);
      moviesRefreshed++;
    } catch (err) {
      if (verbose) console.error(`[checker] refresh ${movie.title}: ${err.message}`);
    }
  }

  // Streaming services: re-fetch names and logos from TMDb's provider list.
  const staleServices = must(
    await supabase.from('my_services').select('provider_id').lt('tmdb_refreshed_at', cutoff),
    'load stale services'
  );
  let servicesRefreshed = 0;
  if (staleServices.length) {
    const all = await tmdb.getAllMovieProviders();
    const byId = new Map(all.map((p) => [p.provider_id, p]));
    for (const row of staleServices) {
      const p = byId.get(row.provider_id);
      if (!p) continue; // service no longer listed by TMDb; leave as is
      const { error } = await supabase
        .from('my_services')
        .update({
          provider_name: p.provider_name,
          logo_path: p.logo_path,
          tmdb_refreshed_at: new Date().toISOString(),
        })
        .eq('provider_id', row.provider_id);
      if (error) throw new Error(error.message);
      servicesRefreshed++;
    }
  }

  if (verbose) {
    console.log(`[checker] Refreshed TMDb data for ${moviesRefreshed} movies and ${servicesRefreshed} services.`);
  }
  return { moviesRefreshed, servicesRefreshed };
}

module.exports = { checkHorrorDiscovery, getTopHorrorRecommendations, refreshLikedAvailability };
