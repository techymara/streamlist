const POSTER_BASE = 'https://image.tmdb.org/t/p/w300';
let config = {};
let myServices = [];
let likedMovies = [];
let currentFilter = 'all';

// ---------- helpers ----------
function toast(msg, ms = 3000) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (el.hidden = true), ms);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed: ${res.status}`);
  }
  return res.json();
}

// ---------- tabs ----------
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
  });
});

// ---------- config / status ----------
async function loadConfig() {
  config = await api('/api/config');
  const statusEl = document.getElementById('config-status');
  const lines = [
    `TMDb API key: ${config.tmdbConfigured ? '✅ configured' : '❌ missing — add TMDB_API_KEY to .env'}`,
    `Supabase: ${config.supabaseConfigured ? '✅ configured' : '❌ missing — add SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY to .env'}`,
    `Email (Resend): ${config.emailConfigured ? `✅ configured — sends to ${config.digestTo}` : '❌ missing — add RESEND_API_KEY / DIGEST_TO_EMAIL to .env'}`,
    `Region: ${config.region}`,
  ];
  statusEl.innerHTML = lines.join('<br>');
}

// ---------- search ----------
document.getElementById('search-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = document.getElementById('search-input').value.trim();
  if (!q) return;
  const grid = document.getElementById('search-grid');
  grid.innerHTML = '<p class="hint">Searching...</p>';
  try {
    const results = await api('/api/search?q=' + encodeURIComponent(q));
    if (!results.length) {
      grid.innerHTML = '<p class="hint">No results.</p>';
      return;
    }
    grid.innerHTML = '';
    for (const m of results) grid.appendChild(renderSearchCard(m));
  } catch (err) {
    grid.innerHTML = `<p class="hint">${err.message}</p>`;
  }
});

function renderSearchCard(m) {
  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = `
    <div class="poster" style="${m.poster_path ? `background-image:url(${POSTER_BASE}${m.poster_path})` : ''}">
      ${m.poster_path ? '' : m.title}
    </div>
    <div class="info">
      <div class="title">${m.title}</div>
      <div class="year">${m.year || ''}</div>
      <div class="card-actions">
        <button data-action="like">+ Add to list</button>
      </div>
    </div>
  `;
  card.querySelector('[data-action="like"]').addEventListener('click', async (e) => {
    await api('/api/liked', {
      method: 'POST',
      body: JSON.stringify({
        tmdb_id: m.tmdb_id,
        title: m.title,
        year: m.year,
        poster_path: m.poster_path,
      }),
    });
    e.target.textContent = '✓ Added';
    e.target.disabled = true;
    toast(`Added "${m.title}" to your list`);
    loadLiked();
  });
  return card;
}

// ---------- my list ----------
async function loadLiked() {
  likedMovies = await api('/api/liked');
  renderMyList();
}

document.querySelectorAll('.filter-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.filter-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    currentFilter = btn.dataset.filter;
    renderMyList();
  });
});

function renderMyList() {
  const grid = document.getElementById('mylist-grid');
  const empty = document.getElementById('mylist-empty');
  grid.innerHTML = '';

  const selectedIds = new Set(myServices.filter((s) => s.selected).map((s) => s.provider_id));

  let visible = likedMovies;
  if (currentFilter === 'available') {
    visible = likedMovies.filter((m) =>
      m.last_known_provider_ids.some((id) => selectedIds.has(id))
    );
  } else if (currentFilter === 'unavailable') {
    visible = likedMovies.filter(
      (m) => !m.last_known_provider_ids.some((id) => selectedIds.has(id))
    );
  }

  empty.hidden = likedMovies.length > 0;
  for (const m of visible) grid.appendChild(renderLikedCard(m, selectedIds));
}

function renderLikedCard(m, selectedIds) {
  const onMine = m.last_known_provider_ids.some((id) => selectedIds.has(id));
  const hasAny = m.last_known_provider_ids.length > 0;

  let badge = '<span class="badge unavailable">Not streaming yet</span>';
  if (onMine) badge = '<span class="badge available">✓ On your services</span>';
  else if (hasAny) badge = '<span class="badge on-other">Streaming elsewhere</span>';

  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = `
    <div class="poster" style="${m.poster_path ? `background-image:url(${POSTER_BASE}${m.poster_path})` : ''}">
      ${m.poster_path ? '' : m.title}
    </div>
    <div class="info">
      <div class="title">${m.title}</div>
      <div class="year">${m.year || ''}${m.letterboxd_rating ? ` · ★ ${m.letterboxd_rating}` : ''}</div>
      ${badge}
      <div class="card-actions">
        <button data-action="watched">${m.status === 'watched' ? '↺ Unwatch' : '✓ Watched'}</button>
        <button data-action="remove" class="danger">Remove</button>
      </div>
    </div>
  `;
  card.querySelector('[data-action="watched"]').addEventListener('click', async () => {
    await api(`/api/liked/${m.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: m.status === 'watched' ? 'liked' : 'watched' }),
    });
    loadLiked();
  });
  card.querySelector('[data-action="remove"]').addEventListener('click', async () => {
    await api(`/api/liked/${m.id}`, { method: 'DELETE' });
    loadLiked();
  });
  return card;
}

// ---------- services ----------
async function loadServices() {
  myServices = await api('/api/services');
  renderServices();
}

function renderServices() {
  const el = document.getElementById('services-list');
  el.innerHTML = '';
  for (const s of myServices) {
    const chip = document.createElement('label');
    chip.className = 'service-chip' + (s.selected ? ' selected' : '');
    chip.innerHTML = `<input type="checkbox" ${s.selected ? 'checked' : ''}/> ${s.provider_name}`;
    chip.addEventListener('click', async (e) => {
      e.preventDefault();
      const newVal = !s.selected;
      await api(`/api/services/${s.provider_id}`, {
        method: 'POST',
        body: JSON.stringify({ selected: newVal }),
      });
      s.selected = newVal;
      renderServices();
      renderMyList();
    });
    el.appendChild(chip);
  }
}

document.getElementById('expand-services-btn').addEventListener('click', async () => {
  try {
    myServices = await api('/api/services/expand');
    renderServices();
    toast('Loaded the full TMDb service list');
  } catch (err) {
    toast(err.message, 5000);
  }
});

// ---------- Letterboxd import ----------
document.getElementById('import-btn').addEventListener('click', async () => {
  const fileInput = document.getElementById('letterboxd-file');
  const status = document.getElementById('import-status');
  if (!fileInput.files.length) {
    status.textContent = 'Choose a CSV file first.';
    return;
  }
  const importAs = document.getElementById('import-type').value;
  const formData = new FormData();
  formData.append('file', fileInput.files[0]);
  formData.append('importAs', importAs);

  status.textContent = 'Importing... this can take a bit since each title is matched against TMDb.';
  try {
    const res = await fetch('/api/import/letterboxd', { method: 'POST', body: formData });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Import failed');
    status.textContent = `Imported ${data.importedCount}, skipped ${data.skippedCount} (no confident match).`;
    loadLiked();
  } catch (err) {
    status.textContent = 'Error: ' + err.message;
  }
});

// ---------- test digest ----------
document.getElementById('test-digest-btn').addEventListener('click', async () => {
  const status = document.getElementById('digest-status');
  status.textContent = 'Checking availability and sending (this can take a little while)...';
  try {
    const result = await api('/api/send-test-digest', { method: 'POST' });
    if (result.sent) {
      status.textContent = `Sent! ${result.horrorCount} new horror title(s), top ${result.recCount} recommendations ranked.`;
      toast('Digest email sent — check your inbox');
    } else {
      status.textContent = `Not sent: ${result.reason || 'email not configured yet — see Status below'}.`;
    }
  } catch (err) {
    status.textContent = 'Error: ' + err.message;
  }
});

// ---------- init ----------
async function init() {
  await loadConfig();
  await loadServices();
  await loadLiked();
}
init();
