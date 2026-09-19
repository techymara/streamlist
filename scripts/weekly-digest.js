// The script GitHub Actions runs on a schedule (see .github/workflows/weekly-digest.yml).
// Also runnable by hand: npm run digest
require('dotenv').config();
const { supabase } = require('../db');
const { checkHorrorDiscovery, getTopHorrorRecommendations, refreshLikedAvailability } = require('../checker');
const { sendDigest } = require('../email');

(async () => {
  console.log('[digest] Checking new horror on your services...');
  const horrorNew = await checkHorrorDiscovery({ verbose: true });

  console.log('[digest] Ranking top 10 horror recommendations...');
  const topRecommendations = await getTopHorrorRecommendations({ verbose: true, limit: 10 });

  console.log('[digest] Refreshing availability for your liked list (for the app\'s My List badges)...');
  await refreshLikedAvailability({ verbose: true });

  const result = await sendDigest({ horrorNew, topRecommendations });

  await supabase.from('digest_log').insert({
    horror_count: horrorNew.length,
    rec_count: topRecommendations.length,
    recipient: process.env.DIGEST_TO_EMAIL || null,
  });

  if (result.sent) {
    console.log(`[digest] Sent: ${horrorNew.length} new horror, top ${topRecommendations.length} recommendations.`);
  } else {
    console.log(`[digest] Not sent (${result.reason || 'not configured'}).`);
  }
  process.exit(0);
})().catch((err) => {
  console.error('[digest] Failed:', err);
  process.exit(1);
});
