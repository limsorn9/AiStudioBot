require('dotenv').config();
const fs = require('fs');
const { execSync } = require('child_process');
const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');

async function testAudioModels() {
  let geminiKey = null;
  const keyFile = 'firebase-key.json';
  if (fs.existsSync(keyFile)) {
    const cred = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
    if (getApps().length === 0) {
      initializeApp({ credential: cert(cred), databaseURL: process.env.FIREBASE_DB_URL });
    }
    const db = getDatabase();
    const gSnap = await db.ref('api_keys/gemini').once('value');
    if (gSnap.exists()) {
      const val = gSnap.val();
      geminiKey = Array.isArray(val) ? val[0] : Object.values(val)[0];
    }
  }

  console.log('Testing with Gemini Key:', geminiKey?.slice(0, 10));

  execSync('ffmpeg -y -f lavfi -i "sine=frequency=1000:duration=2" -ar 16000 -ac 1 -b:a 32k dummy.mp3');
  const base64Audio = fs.readFileSync('dummy.mp3').toString('base64');

  const models = ['gemini-3.5-flash', 'gemini-3.6-flash', 'gemini-3.1-flash-lite'];
  for (const m of models) {
    const t0 = Date.now();
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${geminiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: 'Transcribe this audio clip if any speech, or return empty JSON array: []' },
              { inlineData: { mimeType: 'audio/mp3', data: base64Audio } }
            ]
          }]
        }),
        signal: AbortSignal.timeout(10000)
      });
      const data = await res.json();
      console.log(`${m}: ${res.status === 200 ? '✅ 200 OK' : '❌ ' + res.status} (${Date.now() - t0}ms) ->`, data.candidates?.[0]?.content?.parts?.[0]?.text?.trim()?.slice(0, 50) || data.error?.message?.slice(0, 60));
    } catch (e) {
      console.log(`${m}: ❌ Exception: ${e.message}`);
    }
  }
  try { fs.unlinkSync('dummy.mp3'); } catch (e) {}
}

testAudioModels();
