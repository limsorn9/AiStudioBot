require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');

async function getAllKeys(provider = 'gemini') {
  const allKeys = new Set();
  const envRaw = (process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '');
  envRaw.split(',').map(k => k.trim()).filter(Boolean).forEach(k => allKeys.add(k));

  try {
    let serviceAccount = null;
    const keyFile = path.join(__dirname, 'firebase-key.json');
    if (fs.existsSync(keyFile)) {
      serviceAccount = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
    }
    if (serviceAccount && getApps().length === 0) {
      initializeApp({
        credential: cert(serviceAccount),
        databaseURL: process.env.FIREBASE_DB_URL
      });
    }
    const db = getDatabase();
    const gSnap = await db.ref(`api_keys/${provider}`).once('value');
    if (gSnap.exists()) {
      const val = gSnap.val();
      const list = Array.isArray(val) ? val : (typeof val === 'object' ? Object.values(val) : []);
      list.filter(Boolean).forEach(k => allKeys.add(k));
    }
  } catch (e) {}
  return Array.from(allKeys);
}

async function testGeminiModels() {
  const geminiKeys = await getAllKeys('gemini');
  console.log('Testing with key:', geminiKeys[0]?.slice(0, 10));

  const list = [
    'gemini-3.5-flash',
    'gemini-3.5-transcribe',
    'gemini-3.1-flash-lite',
    'gemini-3.6-flash',
    'gemini-3.7-flash',
    'gemini-3.8-flash',
    'gemini-2.5-flash-lite'
  ];

  for (const m of list) {
    const t0 = Date.now();
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${geminiKeys[0]}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: 'Hello' }] }]
        }),
        signal: AbortSignal.timeout(10000)
      });
      const data = await res.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
      const err = data.error?.message?.slice(0, 80);
      console.log(`${m}: ${res.status === 200 ? '✅ 200 OK' : '❌ ' + res.status} (${Date.now() - t0}ms) ${text ? '-> ' + text.slice(0, 30) : '-> ' + err}`);
    } catch (e) {
      console.log(`${m}: ❌ Exception: ${e.message}`);
    }
  }
}

testGeminiModels();
