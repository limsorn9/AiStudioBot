require('dotenv').config();
const fs = require('fs');
const { execSync } = require('child_process');
const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');

async function testGemini38Flash() {
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

  console.log('Testing gemini-3.8-flash with Key:', geminiKey?.slice(0, 10));

  // 1. Text Prompt
  const t0 = Date.now();
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${geminiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: 'Translate to natural spoken Khmer: "Hello, welcome to AI Studio!"' }] }]
      }),
      signal: AbortSignal.timeout(10000)
    });
    const data = await res.json();
    console.log(`gemini-3.8-flash text test: ${res.status === 200 ? '✅ 200 OK' : '❌ ' + res.status} (${Date.now() - t0}ms)`);
    console.log('Output:', data.candidates?.[0]?.content?.parts?.[0]?.text?.trim());
  } catch (e) {
    console.log('Text test err:', e.message);
  }

  // 2. Audio Multimodal Test
  execSync('ffmpeg -y -f lavfi -i "sine=frequency=1000:duration=2" -ar 16000 -ac 1 -b:a 32k dummy.mp3');
  const base64Audio = fs.readFileSync('dummy.mp3').toString('base64');
  const t1 = Date.now();
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${geminiKey}`, {
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
    console.log(`gemini-3.8-flash audio test: ${res.status === 200 ? '✅ 200 OK' : '❌ ' + res.status} (${Date.now() - t1}ms)`);
    console.log('Audio Output:', data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || data.error?.message);
  } catch (e) {
    console.log('Audio test err:', e.message);
  }
  try { fs.unlinkSync('dummy.mp3'); } catch (e) {}
}

testGemini38Flash();
