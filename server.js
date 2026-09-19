require('dotenv').config();
const express = require('express');
const path = require('path');
const multer = require('multer');
const { parse } = require('csv-parse/sync');

const { supabase, must } = require('./db');
const tmdb = require('./tmdb');
const email = require('./email');
const { checkHorrorDiscovery, getTopHorrorRecommendations, refreshLikedAvailability } = require('./checker');

const app = express();
const PORT = process.env.PORT || 3000;
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- config ----------
app.get('/api/config', (req, res) => {
  res.json({
    tmdbConfigured: tmdb.apiKeyPresent(),
    supabaseConfigured: !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY),
    emailConfigured: email.configured(),
    digestTo: process.env.DIGEST_TO_EMAIL || null,
    region: tmdb.REGION,
  });
});

// ---------- search / like ----------
app.get('/api/search', async (req, res) => {
  try {
    const { q, year } = req.query;
    if (!q) return res.status(400).json({ error: 'Missing ?q=' });
    const results = await tmdb.searchMovies(q, year);
    res.json(results);
  } catch (err) {
    res.status(err.code === 'NO_API_KEY' ? 400 : 500).json({ error: err.message });
  }
});

app.post('/api/liked', async (req, res) => {
  const { tmdb_id, title, year, poster_path } = req.body;
  if (!tmdb_id || !title) return res.status(400).json({ error: 'tmdb_id and title required' });
  try {
    const { error } = await supabase
      .from('liked_movies')
      .upsert({ tmdb_id, title, year, poster_path, source: 'manual' }, { onConflict: 'tmdb_id', ignoreDuplicates: true });
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/liked', async (req, res) => {
  try {
    const rows = must(
      await supabase.from('liked_movies').select('*').order('liked_at', { ascending: false }),
      'list liked movies'
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/liked/:id', async (req, res) => {
  const { status } = req.body; // 'liked' | 'watched'
  await supabase.from('liked_movies').update({ status }).eq('id', req.params.id);
  res.json({ ok: true });
});

app.delete('/api/liked/:id', async (req, res) => {
  await supabase.from('liked_movies').delete().eq('id', req.params.id);
  res.json({ ok: true });
});

// ---------- services (what you actually subscribe to) ----------
app.get('/api/services', async (req, res) => {
  try {
    const rows = must(
      await supabase.from('my_services').select('*').order('provider_name'),
      'list services'
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/services/expand', async (req, res) => {
  // Pull the full TMDb provider list and merge in any not already seeded.
  try {
    const all = await tmdb.getAllMovieProviders();
    const { error } = await supabase.from('my_services').upsert(
      all.map((p) => ({ provider_id: p.provider_id, provider_name: p.provider_name, logo_path: p.logo_path })),
      { onConflict: 'provider_id', ignoreDuplicates: true }
    );
    if (error) throw error;
    const rows = must(await supabase.from('my_services').select('*').order('provider_name'), 'list services');
    res.json(rows);
  } catch (err) {
    res.status(err.code === 'NO_API_KEY' ? 400 : 500).json({ error: err.message });
  }
});

app.post('/api/services/:providerId', async (req, res) => {
  const { selected } = req.body;
  await supabase.from('my_services').update({ selected: !!selected }).eq('provider_id', req.params.providerId);
  res.json({ ok: true });
});

// ---------- Letterboxd CSV import ----------
// Accepts ratings.csv, watched.csv, diary.csv, or watchlist.csv straight from
// a Letterboxd export zip. `importAs` says how to treat every row:
//   'watched'   — you've seen these (ratings.csv / watched.csv / diary.csv).
//                 Rating, if present, is stored but never used to filter —
//                 a movie you rated 1 star is still a movie you've seen.
//   'watchlist' — movies you want to watch (watchlist.csv). Stored as status
//                 'liked' so they show up in My List same as manually-added ones.
app.post('/api/import/letterboxd', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const importAs = req.body.importAs === 'watchlist' ? 'watchlist' : 'watched';
  const status = importAs === 'watchlist' ? 'liked' : 'watched';

  let records;
  try {
    records = parse(req.file.buffer.toString('utf-8'), { columns: true, skip_empty_lines: true });
  } catch (err) {
    return res.status(400).json({ error: 'Could not parse CSV: ' + err.message });
  }

  const imported = [];
  const skipped = [];
  for (const row of records) {
    const name = row.Name || row.name;
    const year = row.Year || row.year;
    const rating = row.Rating ? parseFloat(row.Rating) : null;
    if (!name) continue;

    try {
      const matches = await tmdb.searchMovies(name, year);
      if (!matches.length) {
        skipped.push({ name, year, reason: 'no TMDb match' });
        continue;
      }
      const best = matches[0]; // TMDb already sorts by relevance/popularity
      const { error } = await supabase.from('liked_movies').upsert(
        {
          tmdb_id: best.tmdb_id,
          title: best.title,
          year: best.year,
          poster_path: best.poster_path,
          source: 'letterboxd',
          letterboxd_rating: rating,
          status,
        },
        { onConflict: 'tmdb_id' }
      );
      if (error) throw error;
      imported.push({ name: best.title, year: best.year });
    } catch (err) {
      skipped.push({ name, year, reason: err.message });
    }
  }

  res.json({ importedCount: imported.length, skippedCount: skipped.length, imported, skipped });
});

// ---------- digest (email) ----------
// Manual trigger so you can confirm email delivery without waiting for the
// weekly GitHub Actions run. Exercises the exact same code path.
app.post('/api/send-test-digest', async (req, res) => {
  try {
    const horrorNew = await checkHorrorDiscovery({ verbose: true });
    const topRecommendations = await getTopHorrorRecommendations({ verbose: true, limit: 10 });
    await refreshLikedAvailability({ verbose: true });
    const result = await email.sendDigest({ horrorNew, topRecommendations });
    res.json({ ...result, horrorCount: horrorNew.length, recCount: topRecommendations.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`🎬 Streamlist running at http://localhost:${PORT}`);
  console.log('   (The weekly email is sent by GitHub Actions, not this server — see README.)');
});
