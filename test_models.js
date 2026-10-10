require('dotenv').config();
const fs = require('fs');
const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');

async function testGroqModels() {
  const cred = JSON.parse(fs.readFileSync('firebase-key.json', 'utf8'));
  if (!getApps().length) initializeApp({ credential: cert(cred), databaseURL: process.env.FIREBASE_DB_URL });
  const snap = await getDatabase().ref('api_keys/groq').once('value');
  const val = snap.val();
  const k = Array.isArray(val) ? val[0] : Object.values(val)[0];

  console.log('Testing Groq key:', k?.slice(0, 10));

  const list = ['openai/gpt-oss-120b', 'qwen/qwen3.8-27b', 'openai/gpt-oss-20b', 'allam-2-7b'];
  for (const m of list) {
    const t0 = Date.now();
    try {
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${k}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: m,
          messages: [{ role: 'user', content: 'Say OK' }]
        }),
        signal: AbortSignal.timeout(10000)
      });
      const d = await res.json();
      console.log(`${m}: ${res.status === 200 ? '✅ 200 OK' : '❌ ' + res.status} (${Date.now() - t0}ms) ->`, d.choices?.[0]?.message?.content?.trim() || d.error?.message);
    } catch (e) {
      console.log(`${m}: ❌ Exception: ${e.message}`);
    }
  }
}

testGroqModels();
