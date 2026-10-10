require('dotenv').config();
const fs = require('fs');
const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');

async function testGemini38() {
  const cred = JSON.parse(fs.readFileSync('firebase-key.json', 'utf8'));
  if (!getApps().length) initializeApp({ credential: cert(cred), databaseURL: process.env.FIREBASE_DB_URL });
  const snap = await getDatabase().ref('api_keys/gemini').once('value');
  const val = snap.val();
  const k = Array.isArray(val) ? val[0] : Object.values(val)[0];

  console.log('Testing gemini-3.8-flash with 35s timeout...');
  const t0 = Date.now();
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${k}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: 'Say Hello in Khmer' }] }] }),
      signal: AbortSignal.timeout(35000)
    });
    const d = await res.json();
    console.log('Status:', res.status, (Date.now() - t0) + 'ms');
    console.log('Body:', JSON.stringify(d).slice(0, 150));
  } catch (e) {
    console.log('Err:', e.message, (Date.now() - t0) + 'ms');
  }
}

testGemini38();
