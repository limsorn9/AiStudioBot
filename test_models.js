require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');

async function getAllKeys(provider = 'groq') {
  const allKeys = new Set();
  const envRaw = provider === 'groq' ? (process.env.GROQ_API_KEYS || process.env.GROQ_API_KEY || '') : (process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '');
  envRaw.split(',').map(k => k.trim()).filter(Boolean).forEach(k => allKeys.add(k));

  try {
    let serviceAccount = null;
    const keyFile = path.join(__dirname, 'firebase-key.json');
    const credEnv = (process.env.FIREBASE_CREDENTIALS || '').trim();

    if (fs.existsSync(keyFile)) {
      serviceAccount = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
    } else if (credEnv.startsWith('{')) {
      serviceAccount = JSON.parse(credEnv);
    } else if (credEnv && fs.existsSync(credEnv)) {
      serviceAccount = JSON.parse(fs.readFileSync(credEnv, 'utf8'));
    }

    if (serviceAccount && getApps().length === 0) {
      initializeApp({
        credential: cert(serviceAccount),
        databaseURL: process.env.FIREBASE_DB_URL
      });
    }

    const db = getDatabase();

    // A. Legacy global pool
    const gSnap = await db.ref(`api_keys/${provider}`).once('value');
    if (gSnap.exists()) {
      const val = gSnap.val();
      const list = Array.isArray(val) ? val : (typeof val === 'object' ? Object.values(val) : []);
      list.filter(Boolean).forEach(k => allKeys.add(k));
    }

    // B. Admin master keys
    const mSnap = await db.ref(`admin_master_keys/${provider}`).once('value');
    if (mSnap.exists()) {
      const val = mSnap.val();
      const list = Array.isArray(val) ? val : (typeof val === 'object' ? Object.values(val) : []);
      list.filter(Boolean).forEach(item => {
        const k = typeof item === 'object' ? item.key : item;
        if (k) allKeys.add(k);
      });
    }

    // C. Users pool
    const uSnap = await db.ref('users').once('value');
    if (uSnap.exists()) {
      const users = uSnap.val();
      for (const uid of Object.keys(users)) {
        const uKeys = users[uid]?.api_keys?.[provider];
        if (uKeys) {
          const list = Array.isArray(uKeys) ? uKeys : Object.values(uKeys);
          list.filter(Boolean).forEach(k => allKeys.add(k));
        }
      }
    }
  } catch (e) {
    console.error('Firebase read error:', e.message);
  }

  return Array.from(allKeys);
}

async function runBenchmark() {
  console.log('🚀 BENCHMARKING LATEST AI GENERATIONS ON VPS:\n');

  const groqKeys = await getAllKeys('groq');
  const geminiKeys = await getAllKeys('gemini');

  // Benchmark Groq Models
  console.log('⚡ [GROQ LLM Translation Benchmarks]');
  const groqCandidates = ['qwen/qwen3.8-27b', 'openai/gpt-oss-120b'];
  for (const model of groqCandidates) {
    const t0 = Date.now();
    try {
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${groqKeys[0]}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'Translate to natural spoken Khmer: "Wait for me, I will never give up!"' }]
        }),
        signal: AbortSignal.timeout(10000)
      });
      const data = await res.json();
      const text = data.choices?.[0]?.message?.content?.trim();
      console.log(`  • ${model}: ${res.status === 200 ? '✅ 200 OK' : '❌ ' + res.status} (${Date.now() - t0}ms) -> "${text?.slice(0, 50)}"`);
    } catch (e) {
      console.log(`  • ${model}: ❌ Error: ${e.message}`);
    }
  }

  console.log('\n🤖 [GEMINI Audio & Vision LLM Benchmarks]');
  const geminiCandidates = ['gemini-2.5-flash', 'gemini-3.5-flash', 'gemini-3.5-transcribe', 'gemini-flash-latest'];
  for (const model of geminiCandidates) {
    const t0 = Date.now();
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKeys[0]}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: 'Translate to natural spoken Khmer: "Wait for me, I will never give up!"' }] }]
        }),
        signal: AbortSignal.timeout(15000)
      });
      const data = await res.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
      const err = data.error ? data.error.message?.slice(0, 70) : null;
      console.log(`  • ${model}: ${res.status === 200 ? '✅ 200 OK' : '❌ ' + res.status} (${Date.now() - t0}ms) -> ${text ? '"' + text.slice(0, 50) + '"' : 'ERR: ' + err}`);
    } catch (e) {
      console.log(`  • ${model}: ❌ Error: ${e.message}`);
    }
  }
}

runBenchmark();
