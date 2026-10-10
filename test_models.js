require('dotenv').config();
const fs = require('fs');
const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');

async function testMaxTokens() {
  const cred = JSON.parse(fs.readFileSync('firebase-key.json', 'utf8'));
  if (!getApps().length) initializeApp({ credential: cert(cred), databaseURL: process.env.FIREBASE_DB_URL });
  const snap = await getDatabase().ref('api_keys/groq').once('value');
  const val = snap.val();
  const k = Array.isArray(val) ? val[0] : Object.values(val)[0];

  const t0 = Date.now();
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${k}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'qwen/qwen3.8-27b',
      messages: [{ role: 'user', content: 'Say OK' }],
      max_tokens: 200
    })
  });
  const d = await res.json();
  console.log('qwen with max_tokens 200:', res.status, (Date.now() - t0) + 'ms', d.choices?.[0]?.message?.content?.trim() || d.error?.message);

  const t1 = Date.now();
  const res120 = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${k}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'openai/gpt-oss-120b',
      messages: [{ role: 'user', content: 'Translate to Khmer: "Hello my friend"' }],
      max_tokens: 500
    })
  });
  const d120 = await res120.json();
  console.log('openai/gpt-oss-120b:', res120.status, (Date.now() - t1) + 'ms', d120.choices?.[0]?.message?.content?.trim() || d120.error?.message);
}

testMaxTokens();
