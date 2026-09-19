const fs = require('fs');
let content = fs.readFileSync('tmdb.js', 'utf8');
content = content.replace("  url.searchParams.set('api_key', process.env.TMDB_API_KEY);\n", '');
content = content.replace('const res = await fetch(url.toString());', "const res = await fetch(url.toString(), { headers: { Authorization: 'Bearer ' + process.env.TMDB_API_KEY, accept: 'application/json' } });");
fs.writeFileSync('tmdb.js', content);
console.log('patched successfully');
