const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, exec } = require('child_process');
let MsEdgeTTS = null;
let OUTPUT_FORMAT = null;

function loadEdgeTTS() {
  if (!MsEdgeTTS) {
    try {
      const edgeModule = require('msedge-tts');
      MsEdgeTTS = edgeModule.MsEdgeTTS;
      OUTPUT_FORMAT = edgeModule.OUTPUT_FORMAT;
    } catch (e) {
      console.warn('⚠️ msedge-tts is not installed yet. Run "npm install" on VPS.');
    }
  }
  return MsEdgeTTS;
}
loadEdgeTTS();

// --- Helper: Run Shell Command with Promise ---
function runCmd(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { maxBuffer: 1024 * 1024 * 50 }, (error, stdout, stderr) => {
      if (error) {
        return reject(new Error(`Command failed: ${cmd}\n${stderr || error.message}`));
      }
      resolve({ stdout, stderr });
    });
  });
}

// --- Helper: Download file via stream ---
async function downloadFile(url, destPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed with status ${res.status}: ${res.statusText}`);
  const fileStream = fs.createWriteStream(destPath);
  const reader = res.body.getReader();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    fileStream.write(Buffer.from(value));
  }
  await new Promise((resolve, reject) => {
    fileStream.on('finish', resolve);
    fileStream.on('error', reject);
    fileStream.end();
  });
}

// --- In-Memory Translation Cache (Saves Google API requests) ---
const translationCache = new Map();

// --- Desktop User-Agents for rotation (prevents scraper detection) ---
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36'
];

function getRandomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// --- Multi-Key Gemini Helper (Eliminates 429 Quota Exceeded) ---
let currentGeminiKeyIndex = 0;
function getAllGeminiKeys() {
  const raw = process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '';
  return raw.split(',').map(k => k.trim()).filter(Boolean);
}

function getGeminiKey() {
  const keys = getAllGeminiKeys();
  if (!keys.length) return null;
  return keys[currentGeminiKeyIndex % keys.length];
}

function rotateGeminiKey() {
  const keys = getAllGeminiKeys();
  if (keys.length > 1) {
    currentGeminiKeyIndex = (currentGeminiKeyIndex + 1) % keys.length;
    console.log(`🔄 Switched to Gemini Key #${currentGeminiKeyIndex + 1}/${keys.length}`);
  }
}

function parseNumberedOutput(text, count) {
  const result = new Array(count).fill('');
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  for (const line of lines) {
    const match = line.match(/^\[?(\d+)\]?[\.\:\s\)\-]+\s*(.+)$/);
    if (match) {
      const idx = parseInt(match[1]) - 1;
      if (idx >= 0 && idx < count) {
        result[idx] = match[2].trim();
      }
    }
  }
  for (let i = 0; i < count; i++) {
    if (!result[i] && lines[i]) {
      result[i] = lines[i].replace(/^\[?\d+\]?[\.\:\s\)\-]+\s*/, '').trim();
    }
  }
  return result;
}

// Helper: Polish translated Khmer for natural movie dubbing & breathing pauses
function polishKhmerDubbing(text, gender) {
  let cleaned = (text || '').trim();
  cleaned = cleaned.replace(/^\s*\((ប្រុស|ស្រី)\)\s*/i, '').trim();

  // Fix common machine-translation artifacts from Chinese dramas
  cleaned = cleaned.replace(/សង្គ្រាមបរទេស/g, 'បំណុលគេ');
  cleaned = cleaned.replace(/ចំណុចទាញ/g, 'បញ្ហា');
  cleaned = cleaned.replace(/រួមភេទ/g, 'ធ្វើរឿងមិនគប្បី');
  cleaned = cleaned.replace(/លោក Hu Xiuchun/g, 'ហ៊ូស៊ូឈុន');
  cleaned = cleaned.replace(/លោក Xiuchun/g, 'ស៊ូឈុន');

  // Natural breath cadence for TTS
  if (!/[.!?។,៕\.\.\.]$/.test(cleaned)) {
    cleaned += '...';
  }
  return cleaned;
}

// 1. AI Batch Translation via Gemini (96% less API quota, instant results)
async function batchTranslateWithGemini(lines) {
  const keys = getAllGeminiKeys();
  if (!keys.length) return null;

  for (let attempt = 0; attempt < keys.length; attempt++) {
    const apiKey = getGeminiKey();
    try {
      const numberedText = lines.map((l, idx) => `[${idx + 1}] ${l}`).join('\n');
      const prompt = `You are a legendary Khmer movie voice director and dubbing artist (អ្នកបញ្ចូលសំឡេងភាពយន្តអាជីព).
Translate each numbered line of dialogue below into natural, emotive, and expressive spoken Khmer (ការសន្ទនាភាពយន្ត មានមនោសញ្ចេតនា និងអារម្មណ៍រស់រវើក).

CRITICAL DUBBING & ROLE RULES:
1. SPEAKER TAG: You MUST tag EVERY single line with either "(ប្រុស)" if male speaks, or "(ស្រី)" if female speaks based on conversation context, tone, and pronouns!
Example format:
[1] (ប្រុស) ស៊ូឈុនមានរឿងអីមែនទេ?
[2] (ស្រី) ចាស... ម្ដាយខ្ញុំឈឺត្រូវការលុយ...
2. EMOTION & DRAMA: Express the characters' true feelings (កម្សត់, រំភើប, ខឹង, ភ្ញាក់ផ្អើល, សប្បាយ, ស្នេហា). Match the drama of the scene!
3. SPOKEN KHMER PARTICLES: Use lively spoken Khmer phrasing and expressive particles (ដូចជា៖ ណា, ហ្នឹង, អ្ហា, ឯង, អើយ, ទេតើ, ហ្អី, ណាស់, ពិតមែនហើយ).
4. BREATHING & CADENCE: Add natural punctuation (..., ?, !, ។) to give the voice actor natural pauses, rhythm, and breath.
5. STRICT NUMBERING: Keep the exact same [number] prefix for each line.
6. NO EXTRA TEXT: Output ONLY the numbered translated lines.

${numberedText}`;

      const model = process.env.GEMINI_MODEL || 'gemini-1.5-flash';
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.3 }
        })
      });

      if (res.status === 429) {
        console.warn(`[Gemini 429 Quota Exceeded] Rotating API key...`);
        rotateGeminiKey();
        continue;
      }

      if (res.ok) {
        const data = await res.json();
        const khmer = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (khmer) {
          const parsed = parseNumberedOutput(khmer, lines.length);
          if (parsed && parsed.some(Boolean)) return parsed;
        }
      }
    } catch (err) {
      console.warn('Gemini batch error:', err.message);
      rotateGeminiKey();
    }
  }
  return null;
}

// 2. AI Batch Translation via Groq LLM (free, zero quota lock)
async function batchTranslateWithGroq(lines) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return null;
  try {
    const numberedText = lines.map((l, idx) => `[${idx + 1}] ${l}`).join('\n');
    const prompt = `You are a professional Khmer movie dubbing artist. Translate each numbered line into expressive spoken Khmer with dramatic feeling. Tag EVERY line with either (ប្រុស) or (ស្រី) for male/female speakers (e.g. [1] (ប្រុស) ... or [2] (ស្រី) ...). Add natural particles (ណា, ហ្នឹង, អ្ហា, ឯង...) and punctuation (..., ?, !). Keep [number] prefixes. Output ONLY translated lines:\n\n${numberedText}`;
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3
      })
    });
    if (res.ok) {
      const data = await res.json();
      const khmer = data.choices?.[0]?.message?.content;
      if (khmer) {
        const parsed = parseNumberedOutput(khmer, lines.length);
        if (parsed && parsed.some(Boolean)) return parsed;
      }
    }
  } catch (err) {
    console.warn('Groq batch error:', err.message);
  }
  return null;
}

// 3. Batch Translate Entire Segments Array (Saves 95%+ Quota)
async function batchTranslateSegments(segments, sourceLang) {
  if (!segments || !segments.length) return [];
  if (sourceLang === 'km') {
    return segments.map(s => s.text);
  }

  const batchSize = 25; // Group 25 lines at a time into 1 request
  const allResults = [];

  for (let b = 0; b < segments.length; b += batchSize) {
    const chunk = segments.slice(b, b + batchSize);
    const chunkTexts = chunk.map(s => s.text);

    // 1. Try Gemini Batch (Consumes only 1 request per 25 lines!)
    let translated = await batchTranslateWithGemini(chunkTexts);

    // 2. Try Groq Batch (Free backup)
    if (!translated) {
      translated = await batchTranslateWithGroq(chunkTexts);
    }

    // 3. Fallback: Translate individually with Google if both AI batches fail
    if (!translated) {
      translated = [];
      for (const t of chunkTexts) {
        const res = await translateToKhmer(t);
        translated.push(res);
        await new Promise(r => setTimeout(r, 300));
      }
    }

    // Fill missing items with original
    for (let i = 0; i < chunkTexts.length; i++) {
      allResults.push((translated[i] && translated[i].trim()) || chunkTexts[i]);
    }

    // Polite delay between batches
    if (b + batchSize < segments.length) {
      await new Promise(r => setTimeout(r, 800));
    }
  }

  return allResults;
}

// 4. Single-Text Gemini Fallback
async function translateWithGemini(text) {
  const keys = getAllGeminiKeys();
  if (!keys.length) return null;
  for (let attempt = 0; attempt < keys.length; attempt++) {
    const apiKey = getGeminiKey();
    try {
      const prompt = `You are a professional Khmer movie voice actor. Translate the following dialogue into expressive, emotive spoken Khmer with natural emotion, feeling, and conversational particles (ណា, ហ្នឹង, អ្ហា, ឯង...). Output ONLY the translated Khmer text:\n\n${text}`;
      const model = process.env.GEMINI_MODEL || 'gemini-1.5-flash';
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.3 }
        })
      });
      if (res.status === 429) {
        rotateGeminiKey();
        continue;
      }
      if (res.ok) {
        const data = await res.json();
        const khmer = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (khmer && khmer.trim()) return khmer.trim();
      }
    } catch (err) {
      rotateGeminiKey();
    }
  }
  return null;
}

// 5. Single-Text Groq Fallback
async function translateWithGroq(text) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return null;
  try {
    const prompt = `Translate the following dialogue into expressive, emotive spoken Khmer with dramatic feeling for movie dubbing (ប្រើពាក្យសន្ទនា ណា, ហ្នឹង, អ្ហា...). Output ONLY the Khmer text:\n\n${text}`;
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3
      })
    });
    if (res.ok) {
      const data = await res.json();
      const khmer = data.choices?.[0]?.message?.content;
      if (khmer && khmer.trim()) return khmer.trim();
    }
  } catch (err) {
    console.warn('Groq translation error:', err.message);
  }
  return null;
}

// 6. Robust Free Google Translate with Anti-Ban (Endpoint rotation, headers, caching, rate-limit backoff)
async function translateChunkWithGoogle(chunk, retry = 2) {
  const cacheKey = chunk.trim();
  if (translationCache.has(cacheKey)) {
    return translationCache.get(cacheKey);
  }

  // Dual endpoints to rotate if one rate-limits
  const endpoints = [
    (q) => `https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=auto&tl=km&q=${encodeURIComponent(q)}`,
    (q) => `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=km&dt=t&q=${encodeURIComponent(q)}`
  ];

  for (let attempt = 0; attempt <= retry; attempt++) {
    for (const ep of endpoints) {
      try {
        const url = ep(chunk);
        const res = await fetch(url, {
          headers: {
            'User-Agent': getRandomUserAgent(),
            'Accept': '*/*',
            'Accept-Language': 'en-US,en;q=0.9'
          }
        });

        if (res.status === 429) {
          console.warn(`[Google Rate Limit 429] Backing off before retry ${attempt + 1}...`);
          await new Promise(r => setTimeout(r, (attempt + 1) * 2000 + Math.random() * 1000));
          continue;
        }

        if (res.ok) {
          const data = await res.json();
          let translatedText = '';
          if (Array.isArray(data)) {
            if (Array.isArray(data[0])) {
              if (typeof data[0][0] === 'string' && typeof data[0][1] === 'string' && data[0][1].length <= 5) {
                translatedText = data.map(item => (Array.isArray(item) ? item[0] : item)).join('');
              } else {
                translatedText = data[0].map(item => (Array.isArray(item) ? item[0] : item)).join('');
              }
            } else if (typeof data[0] === 'string') {
              translatedText = data[0];
            }
          } else if (typeof data === 'string') {
            translatedText = data;
          } else if (data && data.sentences) {
            translatedText = data.sentences.map(s => s.trans).join('');
          }

          if (translatedText && translatedText.trim()) {
            translationCache.set(cacheKey, translatedText.trim());
            if (translationCache.size > 2000) {
              const firstKey = translationCache.keys().next().value;
              translationCache.delete(firstKey);
            }
            return translatedText.trim();
          }
        }
      } catch (e) {
        // continue
      }
    }
    if (attempt < retry) {
      await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
    }
  }

  return chunk;
}

// Master Translate Function (Single String)
async function translateToKhmer(text) {
  if (!text || !text.trim()) return '';

  // Priority 1: Gemini AI
  const geminiResult = await translateWithGemini(text);
  if (geminiResult) return geminiResult;

  // Priority 2: Groq AI
  const groqResult = await translateWithGroq(text);
  if (groqResult) return groqResult;

  // Priority 3: Safe Google Translate (batched with delay)
  try {
    const maxLen = 2000;
    const chunks = [];
    const sentences = text.match(/[^.!?\n]+[.!?\n]+|[^.!?\n]+$/g) || [text];

    let currentChunk = '';
    for (const sent of sentences) {
      if ((currentChunk + ' ' + sent).length > maxLen) {
        if (currentChunk) chunks.push(currentChunk.trim());
        currentChunk = sent;
      } else {
        currentChunk += (currentChunk ? ' ' : '') + sent;
      }
    }
    if (currentChunk) chunks.push(currentChunk.trim());

    let result = '';
    for (let i = 0; i < chunks.length; i++) {
      const translatedChunk = await translateChunkWithGoogle(chunks[i]);
      result += (result ? ' ' : '') + translatedChunk;
      if (i < chunks.length - 1) {
        const delayMs = 500 + Math.floor(Math.random() * 400);
        await new Promise(r => setTimeout(r, delayMs));
      }
    }

    return result.trim() || text;
  } catch (err) {
    console.error('Translation error:', err.message);
    return text;
  }
}

// --- Helper: Transcribe Audio using Whisper AI, Groq or Gemini ---
async function transcribeAudio(audioPath) {
  let whisperError = null;

  // 1. Priority: Local Whisper AI (Free, 100+ languages, sentence timestamps)
  const pythonBins = process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python'];
  const scriptPath = path.join(__dirname, 'transcribe_whisper.py');

  for (const bin of pythonBins) {
    try {
      console.log(`Transcribing with Whisper AI (${bin})...`);
      const { stdout } = await runCmd(`${bin} "${scriptPath}" "${audioPath}" tiny`);
      const jsonMatch = stdout.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const data = JSON.parse(jsonMatch[0]);
        if (data.error) {
          throw new Error(data.error);
        }
        if (data && (data.text || (data.segments && data.segments.length > 0))) {
          console.log(`Whisper transcribed ${data.segments?.length || 0} segments in language '${data.language}'`);
          return {
            text: (data.text || '').trim(),
            segments: data.segments || [],
            language: data.language || 'auto'
          };
        }
      }
    } catch (err) {
      whisperError = err.message;
      console.warn(`Whisper with ${bin} failed:`, err.message);
    }
  }

  // 2. Groq Whisper API (if API key set)
  const groqKey = process.env.GROQ_API_KEY;
  if (groqKey) {
    try {
      console.log('Transcribing with Groq Whisper API...');
      const audioBuffer = fs.readFileSync(audioPath);
      const formData = new FormData();
      formData.append('file', new Blob([audioBuffer], { type: 'audio/wav' }), 'audio.wav');
      formData.append('model', 'whisper-large-v3');
      formData.append('response_format', 'verbose_json');

      const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${groqKey}` },
        body: formData
      });

      if (res.ok) {
        const data = await res.json();
        return {
          text: data.text || '',
          segments: data.segments || [],
          language: data.language || 'auto'
        };
      }
    } catch (err) {
      console.warn('Groq transcription failed:', err.message);
    }
  }

  // 3. Gemini API (if API key set)
  const geminiKey = process.env.GEMINI_API_KEY;
  if (geminiKey) {
    try {
      console.log('Transcribing with Gemini API...');
      const audioBuffer = fs.readFileSync(audioPath);
      const base64Audio = audioBuffer.toString('base64');

      const prompt = `Please transcribe this audio accurately. Output the full text.`;
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${geminiKey}`;

      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: prompt },
              { inline_data: { mime_type: 'audio/wav', data: base64Audio } }
            ]
          }]
        })
      });

      if (res.ok) {
        const data = await res.json();
        const geminiText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
        return {
          text: geminiText,
          segments: [],
          language: 'auto'
        };
      }
    } catch (err) {
      console.warn('Gemini transcription failed:', err.message);
    }
  }

  return {
    text: '',
    segments: [],
    language: 'unknown',
    error: whisperError
      ? `Whisper Error: ${whisperError} (សូមប្រាកដថាបានដំឡើង openai-whisper លើ VPS: pip3 install openai-whisper --break-system-packages)`
      : 'មិនអាចស្រង់សំឡេងបានទេ'
  };
}

// --- Helper: Khmer Speech Synthesis via Edge-TTS ---
async function synthesizeKhmerVoice(text, voiceGender, outputDir) {
  if (!loadEdgeTTS()) {
    throw new Error('កញ្ចប់ msedge-tts មិនទាន់ដំឡើងលើ VPS ទេ។ សូមវាយបញ្ជា "npm install" លើ VPS ជាមុនសិន!');
  }
  const voiceName = (voiceGender && voiceGender.includes('ស្រី'))
    ? 'km-KH-SreymomNeural'
    : 'km-KH-PisethNeural';

  // Clean text of non-printable or unsupported control symbols
  const cleanText = (text || '').replace(/[\r\n]+/g, ' ').trim();
  if (!cleanText) {
    throw new Error('អត្ថបទសម្រាប់បញ្ចេញសំឡេងទទេ (Empty text for TTS)');
  }

  // If text is short/medium (<= 3500 chars), synthesize directly in 1 file
  if (cleanText.length <= 3500) {
    const tts = new MsEdgeTTS();
    await tts.setMetadata(voiceName, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    const result = await tts.toFile(outputDir, cleanText);
    return result.audioFilePath;
  }

  // If text is long, chunk to prevent payload timeouts and concatenate with ffmpeg
  console.log(`TTS script is long (${cleanText.length} chars). Synthesizing in chunks...`);
  const sentences = cleanText.match(/[^.!?។\n]+[.!?។\n]+|[^.!?។\n]+$/g) || [cleanText];
  const textChunks = [];
  let curChunk = '';
  for (const s of sentences) {
    if ((curChunk + ' ' + s).length > 2500) {
      if (curChunk) textChunks.push(curChunk.trim());
      curChunk = s;
    } else {
      curChunk += (curChunk ? ' ' : '') + s;
    }
  }
  if (curChunk) textChunks.push(curChunk.trim());

  const audioPartPaths = [];
  for (let i = 0; i < textChunks.length; i++) {
    const tts = new MsEdgeTTS();
    await tts.setMetadata(voiceName, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    const partDir = path.join(outputDir, `tts_part_${i}`);
    fs.mkdirSync(partDir, { recursive: true });
    const res = await tts.toFile(partDir, textChunks[i]);
    audioPartPaths.push(res.audioFilePath);
  }

  // Concat all mp3 parts with ffmpeg
  const listFile = path.join(outputDir, 'tts_concat_list.txt');
  const listContent = audioPartPaths.map(p => `file '${p.replace(/'/g, "'\\''")}'`).join('\n');
  fs.writeFileSync(listFile, listContent);
  const finalAudioPath = path.join(outputDir, 'voice_full.mp3');
  await runCmd(`ffmpeg -y -f concat -safe 0 -i "${listFile}" -c:a libmp3lame -b:a 48k "${finalAudioPath}"`);
  return finalAudioPath;
}

// --- Helper: Build Synchronized Khmer Voice Track Matching Character Lip-Movement & Breath Gaps ---
async function synthesizeSynchronizedVoiceTrack({
  segments,
  translatedTexts,
  voiceGender,
  totalDuration,
  workDir
}) {
  if (!loadEdgeTTS()) {
    throw new Error('កញ្ចប់ msedge-tts មិនទាន់ដំឡើងលើ VPS ទេ។ សូមវាយបញ្ជា "npm install" លើ VPS ជាមុនសិន!');
  }

  const isDualMode = !voiceGender || voiceGender.includes('ប្រុស & ស្រី') || voiceGender.includes('Auto') || voiceGender.includes('Both');

  const ttsDir = path.join(workDir, 'synced_tts');
  fs.mkdirSync(ttsDir, { recursive: true });

  console.log(`🎙️ Synthesizing ${segments.length} dialogue segments (Dual Voice: ${isDualMode ? 'Enabled' : voiceGender})...`);

  // 1. Synthesize all segments in parallel batches (concurrency: 3)
  const segmentAudios = new Array(segments.length);
  const concurrency = 3;

  for (let i = 0; i < segments.length; i += concurrency) {
    const batch = [];
    for (let j = i; j < Math.min(i + concurrency, segments.length); j++) {
      const segIndex = j;
      const seg = segments[segIndex];
      const rawText = (translatedTexts[segIndex] || seg.text || '').trim();

      if (!rawText) continue;

      // Select male or female voice per segment
      let segVoice = 'km-KH-PisethNeural';
      if (isDualMode) {
        if (rawText.includes('(ស្រី)') || seg.gender === 'female') {
          segVoice = 'km-KH-SreymomNeural';
        } else if (rawText.includes('(ប្រុស)') || seg.gender === 'male') {
          segVoice = 'km-KH-PisethNeural';
        } else {
          segVoice = 'km-KH-PisethNeural';
        }
      } else if (voiceGender && voiceGender.includes('ស្រី')) {
        segVoice = 'km-KH-SreymomNeural';
      } else {
        segVoice = 'km-KH-PisethNeural';
      }

      // Strip speaker tag (ប្រុស)/(ស្រី) from TTS text so it doesn't speak "ប្រុស" / "ស្រី"
      const cleanTtsText = rawText.replace(/^\s*\((ប្រុស|ស្រី)\)\s*/i, '').trim() || rawText;

      batch.push((async () => {
        try {
          const segDir = path.join(ttsDir, `seg_${segIndex}`);
          fs.mkdirSync(segDir, { recursive: true });
          const tts = new MsEdgeTTS();
          await tts.setMetadata(segVoice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
          const res = await tts.toFile(segDir, cleanTtsText);
          const audioFile = res.audioFilePath;

          // Get actual duration
          let dur = await getAudioDuration(audioFile);
          const targetDur = Math.max(0.6, seg.end - seg.start);

          // Lip-Sync speed adjustment: if speech is longer than speaker's window, gently adjust tempo
          let finalAudioFile = audioFile;
          if (dur > targetDur * 1.15 && dur > 1.2) {
            const speed = Math.min(1.30, dur / targetDur);
            const tunedFile = path.join(segDir, 'tuned.mp3');
            try {
              await runCmd(`ffmpeg -y -i "${audioFile}" -filter:a "atempo=${speed.toFixed(2)}" -c:a libmp3lame -b:a 48k "${tunedFile}"`);
              dur = dur / speed;
              finalAudioFile = tunedFile;
            } catch (e) {
              // fallback to normal audio if atempo fails
            }
          }

          segmentAudios[segIndex] = {
            start: Math.max(0, seg.start),
            end: Math.max(seg.start + 0.5, seg.end),
            duration: dur,
            audioPath: finalAudioFile
          };
        } catch (err) {
          console.warn(`Failed to synthesize segment #${segIndex}:`, err.message);
        }
      })());
    }
    await Promise.all(batch);
  }

  // 2. Assemble Timeline Clips with Exact Silence Padding for Breathing & Lip-Sync
  let cursorTime = 0.0;
  const timelineClips = [];
  let silenceIdx = 0;

  for (let i = 0; i < segments.length; i++) {
    const item = segmentAudios[i];
    if (!item || !fs.existsSync(item.audioPath)) continue;

    // A. Pre-speech gap: silence for natural background music and human breathing
    const leadingGap = item.start - cursorTime;
    if (leadingGap > 0.08) {
      const silencePath = path.join(ttsDir, `silence_${silenceIdx++}.mp3`);
      await runCmd(`ffmpeg -y -f lavfi -i anullsrc=r=24000:cl=mono -t ${leadingGap.toFixed(3)} -c:a libmp3lame -b:a 48k "${silencePath}"`);
      timelineClips.push(silencePath);
      cursorTime += leadingGap;
    }

    // B. Character speech clip
    timelineClips.push(item.audioPath);
    cursorTime += item.duration;
  }

  // C. Trailing gap to video end
  const trailingGap = totalDuration - cursorTime;
  if (trailingGap > 0.08) {
    const endSilencePath = path.join(ttsDir, `silence_end.mp3`);
    await runCmd(`ffmpeg -y -f lavfi -i anullsrc=r=24000:cl=mono -t ${trailingGap.toFixed(3)} -c:a libmp3lame -b:a 48k "${endSilencePath}"`);
    timelineClips.push(endSilencePath);
    cursorTime += trailingGap;
  }

  // 3. Concat all timeline clips into Master Synced Voice Track
  if (timelineClips.length === 0) {
    throw new Error('មិនមានសំឡេងនិយាយណាត្រូវបានបង្កើតទេ!');
  }

  const concatListPath = path.join(ttsDir, 'timeline_concat.txt');
  const concatContent = timelineClips.map(p => `file '${p.replace(/'/g, "'\\''")}'`).join('\n');
  fs.writeFileSync(concatListPath, concatContent, 'utf-8');

  const masterSyncedVoicePath = path.join(workDir, 'master_synced_voice.mp3');
  await runCmd(`ffmpeg -y -f concat -safe 0 -i "${concatListPath}" -c:a libmp3lame -b:a 64k "${masterSyncedVoicePath}"`);

  return masterSyncedVoicePath;
}

// --- Helper: Parse & Convert SRT to Plain Text ---
function srtToPlainText(srtContent) {
  const lines = srtContent.split(/\r?\n/);
  const textLines = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^\d+$/.test(trimmed)) continue; // Sequence number
    if (/^\d{2}:\d{2}:\d{2}/.test(trimmed)) continue; // Timecodes
    textLines.push(trimmed);
  }
  return textLines.join(' ');
}

// --- Helper: Build SRT from Text ---
function buildSrtFromText(text, totalDuration = 60) {
  if (!text || !text.trim()) return '';
  let sentences = text.match(/[^.!?។\n]+[.!?។\n]+|[^.!?។\n]+$/g) || [text];
  sentences = sentences.map(s => s.trim()).filter(Boolean);

  if (sentences.length === 1 && totalDuration > 6) {
    const words = sentences[0].split(/\s+/);
    if (words.length > 8) {
      const chunkSize = Math.max(5, Math.ceil(words.length / Math.ceil(totalDuration / 4)));
      sentences = [];
      for (let i = 0; i < words.length; i += chunkSize) {
        sentences.push(words.slice(i, i + chunkSize).join(' '));
      }
    }
  }

  const chunkCount = Math.max(1, sentences.length);
  const timePerChunk = totalDuration / chunkCount;

  let srt = '';
  for (let i = 0; i < chunkCount; i++) {
    const startSec = i * timePerChunk;
    const endSec = (i + 1) * timePerChunk;
    srt += `${i + 1}\n${formatSrtTime(startSec)} --> ${formatSrtTime(endSec)}\n${sentences[i]}\n\n`;
  }
  return srt;
}

function formatSrtTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds - Math.floor(seconds)) * 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

// --- Get Video Duration in Seconds ---
async function getVideoDuration(videoPath) {
  try {
    const { stdout } = await runCmd(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${videoPath}"`);
    const dur = parseFloat(stdout.trim());
    return isNaN(dur) ? 60 : dur;
  } catch {
    return 60;
  }
}

// --- Helper: Get Audio Duration in Seconds ---
async function getAudioDuration(audioPath) {
  try {
    const { stdout } = await runCmd(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${audioPath}"`);
    const dur = parseFloat(stdout.trim());
    return isNaN(dur) ? 2 : dur;
  } catch {
    return 2;
  }
}

// --- Main Pipeline: Process Story Video ---
async function processStoryVideo({
  bot,
  ctx,
  fileId,
  fileUrl,
  voiceType = 'សំឡេងប្រុស',
  splitMinutes = 0, // 0 = Full video, 3, 5, 10
  statusMsgId
}) {
  const taskId = `task_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
  const workDir = path.join(os.tmpdir(), taskId);
  fs.mkdirSync(workDir, { recursive: true });

  const inputVideoPath = path.join(workDir, 'input.mp4');
  const extractedAudioPath = path.join(workDir, 'extracted_audio.wav');
  const dubbedVideoPath = path.join(workDir, 'dubbed_output.mp4');
  const srtPath = path.join(workDir, 'subtitle_kh.srt');

  async function updateProgress(stageText, percent = 10) {
    if (!statusMsgId) return;
    const totalBars = 12;
    const filled = Math.min(totalBars, Math.max(0, Math.round((percent / 100) * totalBars)));
    const empty = totalBars - filled;
    const bar = '█'.repeat(filled) + '░'.repeat(empty);

    const message = `📊 Progress Bar\n[${bar}] ${percent}%\n\n📍 🎙️ ${stageText}\n🎙️ សម្លេង៖ ${voiceType}`;

    try {
      await ctx.telegram.editMessageText(ctx.chat.id, statusMsgId, null, message, {
        reply_markup: {
          inline_keyboard: [
            [{ text: '❌ ត្រឡប់ក្រោយ (បោះបង់)', callback_data: 'story_cancel_task' }]
          ]
        }
      });
    } catch (e) {
      // Ignore Telegram rate limits or unchanged text
    }
  }

  try {
    // 1. Download Video
    await updateProgress('កំពុងទាញយកវីដេអូរឿង..', 15);
    if (fileId) {
      try {
        const fileInfo = await bot.telegram.getFile(fileId);
        // If Local Bot API is used (--local), file_path is directly on local disk!
        if (fileInfo.file_path && fs.existsSync(fileInfo.file_path)) {
          console.log(`Using local file directly from disk: ${fileInfo.file_path}`);
          fs.copyFileSync(fileInfo.file_path, inputVideoPath);
        } else {
          const link = await bot.telegram.getFileLink(fileId);
          await downloadFile(link.href, inputVideoPath);
        }
      } catch (err) {
        if (err.message && err.message.toLowerCase().includes('file is too big')) {
          throw new Error('ឯកសារវីដេអូនេះធំជាង 20MB! Telegram Public Server កំណត់ 20MB។ ដើម្បីទទួល File ផ្ទាល់ដល់ 2GB (2000MB) សូមបើកដំណើរការ Local Telegram Bot API Server លើ VPS!');
        }
        throw err;
      }
    } else if (fileUrl) {
      await downloadFile(fileUrl, inputVideoPath);
    } else {
      throw new Error('មិនមានប្រភព File វីដេអូ ឬ Link ត្រឹមត្រូវទេ!');
    }

    const duration = await getVideoDuration(inputVideoPath);

    // 2. Extract Audio with FFmpeg
    await updateProgress('កំពុងស្រង់សំឡេងចេញពីវីដេអូ..', 25);
    await runCmd(`ffmpeg -y -i "${inputVideoPath}" -vn -ar 16000 -ac 1 "${extractedAudioPath}"`);

    // Extract Clean Background Music (Removing original foreign vocals)
    const cleanBgmPath = path.join(workDir, 'clean_bgm.wav');
    let hasCleanBgm = false;
    try {
      console.log('Isolating background music (removing original dialogue)...');
      const pythonBins = process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python'];
      const sepScript = path.join(__dirname, 'separate_bgm.py');
      for (const bin of pythonBins) {
        try {
          await runCmd(`${bin} "${sepScript}" "${extractedAudioPath}" "${cleanBgmPath}"`);
          if (fs.existsSync(cleanBgmPath) && fs.statSync(cleanBgmPath).size > 1000) {
            hasCleanBgm = true;
            console.log('✅ AI BGM isolation successful: pure background music ready!');
            break;
          }
        } catch (e) {
          // continue
        }
      }
    } catch (e) {
      console.warn('BGM isolation skipped:', e.message);
    }

    // 3. Transcribe & Translate into Khmer
    await updateProgress('Gemini AI កំពុងវិភាគ និងបកប្រែសំឡេង..', 55);
    const transcription = await transcribeAudio(extractedAudioPath);

    const hasSegments = transcription.segments && transcription.segments.length > 0;
    const hasText = transcription.text && transcription.text.trim().length > 0;

    if (!hasSegments && !hasText) {
      const errDetail = transcription.error || 'AI មិនអាចស្ដាប់ឮសំឡេងមនុស្សនិយាយនៅក្នុងវីដេអូនេះទេ!';
      throw new Error(`មិនអាចស្រង់សំឡេងសន្ទនាបាន៖ ${errDetail}`);
    }

    let srtContent = '';
    const translatedSegments = [];
    let validSegments = [];
    let translatedTexts = [];

    if (hasSegments) {
      console.log(`Processing ${transcription.segments.length} dialogue segments with Batch AI Translation...`);
      validSegments = transcription.segments.filter(s => s && s.text && s.text.trim());
      translatedTexts = await batchTranslateSegments(validSegments, transcription.language);

      for (let i = 0; i < validSegments.length; i++) {
        const seg = validSegments[i];
        let rawKhmer = (translatedTexts[i] || seg.text).trim();
        rawKhmer = polishKhmerDubbing(rawKhmer, seg.gender);

        const genderTag = seg.gender === 'female' ? '(ស្រី) ' : '(ប្រុស) ';
        const cleanKhmer = genderTag + rawKhmer;

        translatedTexts[i] = cleanKhmer;
        if (cleanKhmer) {
          translatedSegments.push(cleanKhmer);
          const startStr = formatSrtTime(Math.max(0, seg.start));
          const endStr = formatSrtTime(Math.max(seg.start + 0.5, seg.end));
          srtContent += `${translatedSegments.length}\n${startStr} --> ${endStr}\n${cleanKhmer}\n\n`;
        }
      }
    }

    // Fallback if segments loop didn't yield anything but full text exists
    if (translatedSegments.length === 0 && hasText) {
      let fullKhmer = '';
      if (transcription.language === 'km') {
        fullKhmer = transcription.text.trim();
      } else {
        fullKhmer = await translateToKhmer(transcription.text.trim());
      }
      translatedSegments.push(fullKhmer);
      srtContent = buildSrtFromText(fullKhmer, duration);
    }

    const fullKhmerText = translatedSegments.join(' ');
    if (!fullKhmerText || !fullKhmerText.trim()) {
      throw new Error('មិនអាចបកប្រែសាច់រឿងជាភាសាខ្មែរបានទេ!');
    }

    // Save Subtitle SRT
    fs.writeFileSync(srtPath, srtContent, 'utf-8');

    // 4. Synthesize Khmer Voice (Synchronized with lip movements & natural breathing gaps)
    await updateProgress('កំពុងបញ្ចូលសំឡេងនិយាយខ្មែរតាមមាត់តួអង្គ (Lip-Sync)..', 78);
    let voiceAudioPath;
    if (validSegments && validSegments.length > 0) {
      try {
        voiceAudioPath = await synthesizeSynchronizedVoiceTrack({
          segments: validSegments,
          translatedTexts,
          voiceGender: voiceType,
          totalDuration: duration,
          workDir
        });
      } catch (syncErr) {
        console.warn('Synchronized TTS failed, falling back to full text TTS:', syncErr.message);
        voiceAudioPath = await synthesizeKhmerVoice(fullKhmerText, voiceType, workDir);
      }
    } else {
      voiceAudioPath = await synthesizeKhmerVoice(fullKhmerText, voiceType, workDir);
    }

    // 5. Duck & Dub with FFmpeg (Mixing clean BGM with Khmer voice)
    await updateProgress('កំពុង Render វីដេអូបកប្រែរួច (Quality 720p HD)..', 92);
    if (hasCleanBgm) {
      // 100% Pure BGM: The original foreign dialogue is completely eliminated!
      console.log('Rendering with Clean AI Separated BGM...');
      const filter = `[1:a]volume=0.85[bgm];[2:a]volume=1.25[vox];[bgm][vox]amix=inputs=2:duration=first[aout]`;
      await runCmd(`ffmpeg -y -i "${inputVideoPath}" -i "${cleanBgmPath}" -i "${voiceAudioPath}" -filter_complex "${filter}" -map 0:v -map "[aout]" -c:v copy -c:a aac "${dubbedVideoPath}"`);
    } else {
      // 100% Dialogue Elimination: Center vocal cancellation + Active Speech Segment Muting (-40dB)
      console.log('Rendering with Center Vocal Cut & Active Dialogue Gating...');
      let muteExpr = '0';
      if (validSegments && validSegments.length > 0) {
        muteExpr = validSegments.map(s => `between(t,${Math.max(0, s.start - 0.15).toFixed(2)},${(s.end + 0.15).toFixed(2)})`).join('+');
      }
      // 1. stereotools removes the center speech channel
      // 2. volume drops to 0.01 (-40dB) whenever original dialogue is present
      // 3. volume restores to 0.85 during scene pauses, action, and BGM
      // 4. Khmer voice track plays at loud and clear 1.35 volume
      const vocalCutFilter = `[0:a]stereotools=mlev=0.0:slev=1.2,volume=enable='${muteExpr}':volume=0.01:eval=frame,volume=0.85[bgm];[1:a]volume=1.35[vox];[bgm][vox]amix=inputs=2:duration=first[aout]`;
      try {
        await runCmd(`ffmpeg -y -i "${inputVideoPath}" -i "${voiceAudioPath}" -filter_complex "${vocalCutFilter}" -map 0:v -map "[aout]" -c:v copy -c:a aac "${dubbedVideoPath}"`);
      } catch (err) {
        console.warn('Vocal cut filter error, falling back to volume gate:', err.message);
        const fallbackFilter = `[0:a]volume=enable='${muteExpr}':volume=0.01:eval=frame,volume=0.85[bgm];[1:a]volume=1.35[vox];[bgm][vox]amix=inputs=2:duration=first[aout]`;
        await runCmd(`ffmpeg -y -i "${inputVideoPath}" -i "${voiceAudioPath}" -filter_complex "${fallbackFilter}" -map 0:v -map "[aout]" -c:v copy -c:a aac "${dubbedVideoPath}"`);
      }
    }

    // 6. Split if requested
    const finalVideoParts = [];
    if (splitMinutes > 0 && duration > (splitMinutes * 60)) {
      const partDurationSec = splitMinutes * 60;
      let partIdx = 1;
      for (let start = 0; start < duration; start += partDurationSec) {
        const partPath = path.join(workDir, `part_${partIdx}.mp4`);
        await runCmd(`ffmpeg -y -ss ${start} -i "${dubbedVideoPath}" -t ${partDurationSec} -c copy "${partPath}"`);
        finalVideoParts.push({ path: partPath, partNumber: partIdx });
        partIdx++;
      }
    } else {
      finalVideoParts.push({ path: dubbedVideoPath, partNumber: 1 });
    }

    // 7. Send Result to Telegram User
    await updateProgress('បកប្រែ និងបញ្ចូលសំឡេងរួចរាល់ 100%!', 100);

    for (const part of finalVideoParts) {
      const partLabel = finalVideoParts.length > 1 ? ` (ភាគទី ${part.partNumber})` : '';
      const stat = fs.statSync(part.path);
      const sizeMb = (stat.size / (1024 * 1024)).toFixed(1);
      const caption = `🎉 បកប្រែរឿងរួចរាល់${partLabel} (Quality 720p HD)! ✨\n🎙️ សម្លេង៖ ${voiceType} | 📺 កម្រិតរូបភាព៖ 720p HD | 📦 ទំហំ៖ ${sizeMb}MB\n⏱️ រយៈពេល៖ ~${Math.round(duration)} វិនាទី\n💎 ផលិតដោយ៖ @AiStudioSSOnline_bot`;
      
      // If on Local Bot API, we can send up to 2GB video with streaming; otherwise standard Telegram 50MB limit applies
      const isLocalApi = process.env.BOT_API_ROOT || (process.env.LOCAL_BOT_API === 'true');
      const maxVideoSendSize = isLocalApi ? 1999 * 1024 * 1024 : 49 * 1024 * 1024;
      if (stat.size < maxVideoSendSize) {
        await ctx.replyWithVideo({ source: part.path }, { caption, supports_streaming: true });
      } else {
        await ctx.replyWithDocument({ source: part.path, filename: `Story_Part_${part.partNumber}.mp4` }, { caption });
      }
    }

    // Also send the .srt Subtitle file
    if (fs.existsSync(srtPath)) {
      await ctx.replyWithDocument({ source: srtPath, filename: 'Subtitle_Khmer.srt' }, {
        caption: '📄 ឯកសារ Subtitle ភាសាខ្មែរ (.srt) សម្រាប់ប្រើប្រាស់បន្ត។'
      });
    }

  } catch (error) {
    console.error('Video processing error:', error);
    await updateStatus(`❌ បរាជ័យក្នុងដំណើរការបកប្រែវីដេអូ៖ ${error.message}`);
  } finally {
    // Cleanup temporary files
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch (e) {}
  }
}

// --- SRT to Voice Handler ---
async function processSrtFileToVoice({
  ctx,
  srtContent,
  voiceType = 'សំឡេងប្រុស',
  statusMsgId
}) {
  const taskId = `srt_${Date.now()}`;
  const workDir = path.join(os.tmpdir(), taskId);
  fs.mkdirSync(workDir, { recursive: true });

  async function updateStatus(message) {
    if (!statusMsgId) return;
    try {
      await ctx.telegram.editMessageText(ctx.chat.id, statusMsgId, null, message);
    } catch (e) {}
  }

  try {
    await updateStatus(`📄 កំពុងអានឯកសារ Subtitle និងស្រង់អត្ថបទ...`);
    const plainText = srtToPlainText(srtContent);
    if (!plainText.trim()) throw new Error('ឯកសារ SRT គ្មានអត្ថបទ!');

    await updateStatus(`🎙️ កំពុងបម្លែងអត្ថបទទៅជាសំឡេងនិយាយខ្មែរ (TTS)...`);
    const audioPath = await synthesizeKhmerVoice(plainText, voiceType, workDir);

    await updateStatus(`✅ បម្លែងសំឡេងជោគជ័យ 100%! 🎉 កំពុងផ្ញើ File សំឡេង...`);
    await ctx.replyWithAudio({ source: audioPath, filename: 'Khmer_Audio_Track.mp3' }, {
      caption: `🎙️ សំឡេងខ្មែរពី SRT (${voiceType}) ✨\n💎 បង្កើតដោយ៖ @AiStudioSSOnline_bot`
    });
  } catch (error) {
    console.error('SRT to voice error:', error);
    await updateStatus(`❌ បរាជ័យក្នុងការបម្លែង SRT៖ ${error.message}`);
  } finally {
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch (e) {}
  }
}

module.exports = {
  processStoryVideo,
  processSrtFileToVoice,
  translateToKhmer,
  synthesizeKhmerVoice,
  synthesizeSynchronizedVoiceTrack,
  getAudioDuration,
  buildSrtFromText,
  srtToPlainText
};
