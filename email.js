// email.js — sends the weekly digest via Resend (https://resend.com).
// Free tier: 100 emails/day, 3,000/month — one weekly email uses ~0.03% of that.
//
// Without a verified custom domain, Resend's shared "onboarding@resend.dev"
// sender can only deliver to the email address on YOUR Resend account — which
// is exactly this app's use case (emailing yourself). Add a verified domain
// later only if you want a nicer "from" address.
const { Resend } = require('resend');

const POSTER_BASE = 'https://image.tmdb.org/t/p/w200';
const FONT = '-apple-system,Segoe UI,Roboto,sans-serif';

function configured() {
  return !!(process.env.RESEND_API_KEY && process.env.DIGEST_TO_EMAIL);
}

function movieRow(m, { extra = '', rank = null, dim = false } = {}) {
  const poster = m.poster_path
    ? `<img src="${POSTER_BASE}${m.poster_path}" width="60" style="border-radius:4px;display:block;${dim ? 'filter:grayscale(100%);opacity:0.45' : ''}" />`
    : `<div style="width:60px;height:90px;background:#232b32;border-radius:4px;${dim ? 'opacity:0.45' : ''}"></div>`;

  const rankBadge =
    rank !== null
      ? `<span style="display:inline-block;width:20px;font-weight:700;color:${dim ? '#aab' : '#00b04a'}">${rank}.</span> `
      : '';

  return `
    <tr>
      <td style="padding:8px 12px 8px 0;vertical-align:top">${poster}</td>
      <td style="padding:8px 0;vertical-align:top;font-family:${FONT}">
        <div style="font-weight:600;font-size:15px;color:${dim ? '#99a' : '#14181c'}">
          ${rankBadge}${m.title}${m.year ? ` (${m.year})` : ''}${dim ? ' <span style="font-weight:500;font-size:12px;">— already seen</span>' : ''}
        </div>
        <div style="font-size:13px;color:#556;margin-top:2px">${extra}</div>
      </td>
    </tr>`;
}

function buildDigestHtml({ horrorNew, topRecommendations, weekLabel }) {
  const horrorRows = horrorNew.length
    ? horrorNew.map((m) => movieRow(m, { extra: m.providerNames.join(', ') })).join('')
    : `<tr><td style="padding:8px 0;color:#556;font-family:${FONT}">No new horror titles on your services this week.</td></tr>`;

  const recRows = topRecommendations.length
    ? topRecommendations
        .map((m, i) =>
          movieRow(m, {
            rank: i + 1,
            dim: m.seen,
            extra: `★ ${m.vote_average?.toFixed(1) ?? '?'} on TMDb · ${m.providerNames.join(', ')}`,
          })
        )
        .join('')
    : `<tr><td style="padding:8px 0;color:#556;font-family:${FONT}">Nothing scored yet — check that you've selected streaming services in Settings.</td></tr>`;

  return `
  <div style="max-width:560px;margin:0 auto;padding:24px 16px;background:#f4f6f7">
    <h1 style="font-family:${FONT};font-size:20px;color:#00e054;margin:0 0 4px">
      🎃 Streamlist — ${weekLabel}
    </h1>
    <p style="font-family:${FONT};font-size:13px;color:#556;margin:0 0 20px">
      New horror on your services, plus your top 10 horror picks currently streaming.
    </p>

    <h2 style="font-family:${FONT};font-size:16px;color:#14181c;margin:0 0 8px">
      🔪 New horror this week
    </h2>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      ${horrorRows}
    </table>

    <h2 style="font-family:${FONT};font-size:16px;color:#14181c;margin:28px 0 4px">
      🏆 Top 10 horror streaming now
    </h2>
    <p style="font-family:${FONT};font-size:12px;color:#889;margin:0 0 8px">
      Ranked by rating quality, not just popularity. Grayed-out titles are ones you've already seen (per your Letterboxd import) — still listed so you know they made the cut.
    </p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      ${recRows}
    </table>

    <p style="font-family:${FONT};font-size:11px;color:#99a;margin-top:32px">
      Sent by your own Streamlist instance. Manage your list and services in the app.
    </p>
  </div>`;
}

async function sendDigest({ horrorNew, topRecommendations }) {
  if (!configured()) {
    console.warn('[email] RESEND_API_KEY / DIGEST_TO_EMAIL not set — skipping send. Would have sent:', {
      horrorCount: horrorNew.length,
      recCount: topRecommendations.length,
    });
    return { sent: false, skipped: true };
  }
  if (horrorNew.length === 0 && topRecommendations.length === 0) {
    console.log('[email] Nothing to show (probably no services selected yet) — skipping send.');
    return { sent: false, skipped: true, reason: 'nothing to show — check Settings for selected services' };
  }

  const resend = new Resend(process.env.RESEND_API_KEY);
  const weekLabel = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

  const { data, error } = await resend.emails.send({
    from: process.env.DIGEST_FROM_EMAIL || 'Streamlist <onboarding@resend.dev>',
    to: process.env.DIGEST_TO_EMAIL,
    subject:
      horrorNew.length > 0
        ? `🎃 ${horrorNew.length} new horror pick${horrorNew.length === 1 ? '' : 's'} this week`
        : `🎃 Your weekly horror top 10`,
    html: buildDigestHtml({ horrorNew, topRecommendations, weekLabel }),
  });

  if (error) {
    console.error('[email] Resend error:', error);
    return { sent: false, skipped: false, error: error.message };
  }
  console.log('[email] Sent digest, id:', data.id);
  return { sent: true, skipped: false, id: data.id };
}

module.exports = { configured, sendDigest, buildDigestHtml };
