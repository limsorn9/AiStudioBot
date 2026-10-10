require('dotenv').config();
const fs = require('fs');
const { execSync } = require('child_process');

async function testAudioModels() {
  const geminiKey = (process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '').split(',')[0];
  if (!geminiKey) {
    console.log('No key');
    return;
  }

  // Create a 2s dummy mp3
  execSync('ffmpeg -y -f lavfi -i "sine=frequency=1000:duration=2" -ar 16000 -ac 1 -b:a 32k dummy.mp3');
  const base64Audio = fs.readFileSync('dummy.mp3').toString('base64');

  const models = ['gemini-3.5-flash', 'gemini-3.6-flash', 'gemini-3.1-flash-lite', 'gemini-3.5-transcribe'];
  for (const m of models) {
    const t0 = Date.now();
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${geminiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: 'Transcribe audio if any or say empty.' },
              { inlineData: { mimeType: 'audio/mp3', data: base64Audio } }
            ]
          }]
        }),
        signal: AbortSignal.timeout(10000)
      });
      const data = await res.json();
      console.log(`${m}: ${res.status === 200 ? '✅ 200 OK' : '❌ ' + res.status} (${Date.now() - t0}ms) ->`, data.candidates?.[0]?.content?.parts?.[0]?.text?.trim()?.slice(0, 40) || data.error?.message?.slice(0, 60));
    } catch (e) {
      console.log(`${m}: ❌ Exception: ${e.message}`);
    }
  }
  try { fs.unlinkSync('dummy.mp3'); } catch (e) {}
}

testAudioModels();
