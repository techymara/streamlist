require('dotenv').config();
const fetch = require('node-fetch');
async function run() {
  const res = await fetch('https://api.themoviedb.org/3/authentication', {
    headers: {
      Authorization: `Bearer ${process.env.TMDB_API_KEY}`,
      accept: 'application/json',
    },
  });
  console.log('status code:', res.status);
  const body = await res.text();
  console.log('response:', body);
}
run();