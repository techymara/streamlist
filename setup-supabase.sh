#!/bin/bash
echo "Paste your Supabase Project URL, then press Enter:"
read SUPA_URL
echo "Paste your Supabase service_role key, then press Enter:"
read SUPA_KEY
export SUPA_URL
export SUPA_KEY
node -e "
const fs = require('fs');
let content = fs.readFileSync('.env', 'utf8');
content = content.replace(/SUPABASE_URL=.*/, 'SUPABASE_URL=' + process.env.SUPA_URL);
content = content.replace(/SUPABASE_SERVICE_ROLE_KEY=.*/, 'SUPABASE_SERVICE_ROLE_KEY=' + process.env.SUPA_KEY);
fs.writeFileSync('.env', content);
console.log('patched successfully');
"
