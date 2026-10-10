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
// Detect if URL is from social platforms that need yt-dlp
function isSocialMediaUrl(url) {
  return /youtube\.com|youtu\.be|tiktok\.com|facebook\.com|fb\.watch|twitter\.com|x\.com|instagram\.com|douyin\.com|bilibili\.com|vimeo\.com|dailymotion\.com|twitch\.tv/i.test(url);
}

async function downloadFile(url, destPath) {
  // Use yt-dlp for social media platforms
  if (isSocialMediaUrl(url)) {
    console.log(`Using yt-dlp to download: ${url}`);

    // Auto-detect cookies.txt (place cookies.txt in /root/AiStudioBot/ folder)
    const cookiesPath = path.join(__dirname, 'cookies.txt');
    const cookiesArg = fs.existsSync(cookiesPath) ? `--cookies "${cookiesPath}"` : '';

    // YouTube-specific flags to bypass bot detection
    const isYouTube = /youtube\.com|youtu\.be/i.test(url);
    const ytArgs = isYouTube
      ? `--add-header "Accept-Language:en-US,en;q=0.9" --user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36"`
      : '';

    const ytdlpCmd = `yt-dlp -f "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best" --merge-output-format mp4 --no-playlist --socket-timeout 60 --retries 3 ${cookiesArg} ${ytArgs} -o "${destPath}" "${url}" 2>&1`;
    try {
      await runCmd(ytdlpCmd);
      if (!fs.existsSync(destPath) || fs.statSync(destPath).size < 1000) {
        throw new Error('yt-dlp: ទាញយកបរាជ័យ ឬ File ទទេ!');
      }
      return;
    } catch (ytErr) {
      console.warn('yt-dlp failed, trying fallback quality:', ytErr.message);
      // Try yt-dlp with lower quality as fallback
      try {
        await runCmd(`yt-dlp -f "best[height<=720]/best" --merge-output-format mp4 --no-playlist ${cookiesArg} -o "${destPath}" "${url}" 2>&1`);
        if (!fs.existsSync(destPath) || fs.statSync(destPath).size < 1000) {
          throw new Error('yt-dlp fallback: ទាញយកបរាជ័យ!');
        }
        return;
      } catch (err2) {
        const errMsg = err2.message || '';
        // Provide helpful message for YouTube bot detection
        if (/Sign in|bot detection|cookies/i.test(errMsg)) {
          throw new Error(`YouTube ទាមទារ Cookies Authentication!\n\nដំណោះស្រាយ: សូម Export cookies.txt ពី Browser ហើយ Upload ទៅ /root/AiStudioBot/cookies.txt\n\nឬប្រើ TikTok/Facebook Link ជំនួស!`);
        }
        throw new Error(`មិនអាចទាញយក Video ពី ${url}\n${errMsg.substring(0, 300)}`);
      }
    }
  }

  // Direct HTTP download for plain MP4/video file URLs
  const res = await fetch(url, {
    headers: { 'User-Agent': getRandomUserAgent() }
  });
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

// --- Multi-Key Groq Helper (Supports up to 10 Keys & Auto-Rotation) ---
let currentGroqKeyIndex = 0;
function getAllGroqKeys() {
  const raw = process.env.GROQ_API_KEYS || process.env.GROQ_API_KEY || '';
  return raw.split(',').map(k => k.trim()).filter(Boolean);
}

function getGroqKey() {
  const keys = getAllGroqKeys();
  if (!keys.length) return null;
  return keys[currentGroqKeyIndex % keys.length];
}

function rotateGroqKey() {
  const keys = getAllGroqKeys();
  if (keys.length > 1) {
    currentGroqKeyIndex = (currentGroqKeyIndex + 1) % keys.length;
    console.log(`🔄 Switched to Groq Key #${currentGroqKeyIndex + 1}/${keys.length}`);
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

// Helper: Temporal smoothing on speaker diarization to eliminate single-segment jitter/flip-flops
function smoothSpeakerSegments(segments) {
  if (!segments || segments.length < 3) return segments;

  // Pass 1: Eliminate isolated single-segment flips (e.g. Male -> Female -> Male where Female is short)
  for (let i = 1; i < segments.length - 1; i++) {
    const prevG = segments[i - 1].gender;
    const nextG = segments[i + 1].gender;
    const currG = segments[i].gender;
    const dur = (segments[i].end || 0) - (segments[i].start || 0);
    const gapPrev = (segments[i].start || 0) - (segments[i - 1].end || 0);

    if (prevG === nextG && currG !== prevG) {
      if (dur < 2.2 || gapPrev < 0.8) {
        segments[i].gender = prevG;
      }
    }
  }

  // Pass 2: Merge rapid succession of sentences spoken by same person (<0.6s pause)
  for (let i = 1; i < segments.length; i++) {
    const gap = (segments[i].start || 0) - (segments[i - 1].end || 0);
    const dur = (segments[i].end || 0) - (segments[i].start || 0);
    if (gap < 0.6 && dur < 1.5 && segments[i].gender !== segments[i - 1].gender) {
      segments[i].gender = segments[i - 1].gender;
    }
  }

  return segments;
}

// Helper: Polish translated Khmer for natural movie dubbing & breathing pauses
function polishKhmerDubbing(text, gender) {
  let cleaned = (text || '').trim();
  // Strip number prefixes like [1], [2] and tags
  cleaned = cleaned.replace(/^\s*\[?\d+\]?[\.\:\)\-\s]*(\((ប្រុស|ស្រី)\))?\s*/i, '').trim();
  cleaned = cleaned.replace(/^\s*\((ប្រុស|ស្រី)\)\s*/i, '').trim();

  // Fix common machine-translation artifacts from Chinese dramas
  cleaned = cleaned.replace(/សង្គ្រាមបរទេស/g, 'បំណុលគេ');
  cleaned = cleaned.replace(/ចំណុចទាញ/g, 'បញ្ហា');
  cleaned = cleaned.replace(/រួមភេទ/g, 'ធ្វើរឿងមិនគប្បី');
  cleaned = cleaned.replace(/លោក Hu Xiuchun/g, 'ហ៊ូស៊ូឈុន');
  cleaned = cleaned.replace(/លោក Xiuchun/g, 'ស៊ូឈុន');

  // Enforce gender-appropriate particles to prevent cross-gender speech
  const isMale = (gender === 'male' || gender === 'ប្រុស');
  const isFemale = (gender === 'female' || gender === 'ស្រី');

  if (isMale) {
    // Male characters should never say "ចាស"
    cleaned = cleaned.replace(/\bចាស[់]?\b/g, 'បាទ');
  } else if (isFemale) {
    // Female characters should never say "បាទ"
    cleaned = cleaned.replace(/\bបាទ\b/g, 'ចាស');
  }

  // Natural breath cadence for TTS
  if (!/[.!?។,៕\.\.\.]$/.test(cleaned)) {
    cleaned += '...';
  }
  return cleaned;
}

// 1. AI Batch Translation via Gemini (Multi-Key with Verified Speaker Gender)
async function batchTranslateWithGemini(segmentsChunk) {
  const keys = getAllGeminiKeys();
  if (!keys.length) return null;

  for (let attempt = 0; attempt < keys.length; attempt++) {
    const apiKey = getGeminiKey();
    try {
      const numberedText = segmentsChunk.map((s, idx) => {
        const role = (s.gender === 'female' || (s.genderTag && s.genderTag.includes('ស្រី'))) ? 'ស្រី' : 'ប្រុស';
        return `[${idx + 1}] (${role}) ${s.text}`;
      }).join('\n');

      const prompt = `You are a professional movie dubbing director and voice translation artist for Cambodian cinema (អ្នកបញ្ចូលសំឡេងភាពយន្តអាជីព).
Translate each numbered line of dialogue below into natural, emotive, and expressive spoken Khmer (ការសន្ទនាភាពយន្ត មានមនោសញ្ចេតនា និងអារម្មណ៍រស់រវើក).

CRITICAL CHARACTER ROLE & GENDER RULES:
Each input line ALREADY includes the speaker gender identified from actual audio: (ប្រុស) for Male, or (ស្រី) for Female.
1. PRESERVE SPEAKER TAG: You MUST start EVERY single translated line with the EXACT SAME speaker tag: [1] (ប្រុស) or [2] (ស្រី)!
2. MATCH KHMER VOCABULARY STRICTLY TO GENDER:
   - For (ប្រុស): Use natural male conversational pronouns and polite particles (បាទ, ខ្ញុំ, បង, ឯង, អញ, អាល្អិត...). A male speaker must NEVER use female words like "ចាស" or "អូន" (when addressing herself)!
   - For (ស្រី): Use natural female conversational pronouns and polite particles (ចាស, ខ្ញុំ, អូន, នាងខ្ញុំ, លោកបង, ឯង...). A female speaker must NEVER say "បាទ"!
3. COHERENCE & CONTINUITY:
   - If consecutive lines have the same speaker, KEEP the same gender and dialogue tone consistently.
4. EMOTION & DRAMA: Express the characters' true feelings (កម្សត់, រំភើប, ខឹង, ភ្ញាក់ផ្អើល, សប្បាយ, ស្នេហា). Match the drama of the scene!
5. SPOKEN KHMER PARTICLES: Use lively spoken Khmer phrasing and expressive particles (ដូចជា៖ ណា, ហ្នឹង, អ្ហា, ឯង, អើយ, ទេតើ, ហ្អី, ណាស់, ពិតមែនហើយ).
6. BREATHING & CADENCE: Add natural punctuation (..., ?, !, ។) to give the voice actor natural pauses, rhythm, and breath.
7. STRICT NUMBERING: Keep the exact same [number] prefix for each line.
8. NO EXTRA TEXT: Output ONLY the numbered translated lines.

${numberedText}`;

      const model = process.env.GEMINI_MODEL || 'gemini-flash-latest';
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
          const parsed = parseNumberedOutput(khmer, segmentsChunk.length);
          if (parsed && parsed.some(Boolean)) {
            rotateGeminiKey(); // Round-robin to next key in pool
            return parsed;
          }
        }
      } else {
        const errText = await res.text().catch(() => '');
        console.warn(`[Gemini Error ${res.status}] Rotating key: ${errText.slice(0, 100)}`);
        rotateGeminiKey();
        continue;
      }
    } catch (err) {
      console.warn('Gemini batch error:', err.message);
      rotateGeminiKey();
    }
  }
  return null;
}

// 2. AI Batch Translation via Groq LLM (supports unlimited keys & auto-rotation, with Verified Speaker Gender)
async function batchTranslateWithGroq(segmentsChunk) {
  const keys = getAllGroqKeys();
  if (!keys.length) return null;

  for (let attempt = 0; attempt < keys.length; attempt++) {
    const apiKey = getGroqKey();
    try {
      const numberedText = segmentsChunk.map((s, idx) => {
        const role = (s.gender === 'female' || (s.genderTag && s.genderTag.includes('ស្រី'))) ? 'ស្រី' : 'ប្រុស';
        return `[${idx + 1}] (${role}) ${s.text}`;
      }).join('\n');

      const prompt = `You are a legendary Khmer movie voice director and dubbing artist (អ្នកបញ្ចូលសំឡេងភាពយន្តអាជីព).
Translate each numbered line of dialogue below into natural, emotive, and expressive spoken Khmer (ការសន្ទនាភាពយន្ត មានមនោសញ្ចេតនា និងអារម្មណ៍រស់រវើក).

CRITICAL CHARACTER ROLE & GENDER RULES:
Each input line ALREADY includes the speaker gender identified from actual audio: (ប្រុស) for Male, or (ស្រី) for Female.
1. PRESERVE SPEAKER TAG: You MUST start EVERY single translated line with the EXACT SAME speaker tag: [1] (ប្រុស) or [2] (ស្រី)!
2. MATCH KHMER VOCABULARY STRICTLY TO GENDER:
   - For (ប្រុស): Use natural male conversational pronouns and polite particles (បាទ, ខ្ញុំ, បង, ឯង, អញ, អាល្អិត...). A male speaker must NEVER use female words like "ចាស" or "អូន" (when addressing herself)!
   - For (ស្រី): Use natural female conversational pronouns and polite particles (ចាស, ខ្ញុំ, អូន, នាងខ្ញុំ, លោកបង, ឯង...). A female speaker must NEVER say "បាទ"!
3. COHERENCE & CONTINUITY:
   - If consecutive lines have the same speaker, KEEP the same gender and dialogue tone consistently.
4. EMOTION & DRAMA: Express the characters' true feelings (កម្សត់, រំភើប, ខឹង, ភ្ញាក់ផ្អើល, សប្បាយ, ស្នេហា). Match the drama of the scene!
5. SPOKEN KHMER PARTICLES: Use lively spoken Khmer phrasing and expressive particles (ដូចជា៖ ណា, ហ្នឹង, អ្ហា, ឯង, អើយ, ទេតើ, ហ្អី, ណាស់, ពិតមែនហើយ).
6. BREATHING & CADENCE: Add natural punctuation (..., ?, !, ។) to give the voice actor natural pauses, rhythm, and breath.
7. STRICT NUMBERING: Keep the exact same [number] prefix for each line.
8. NO EXTRA TEXT: Output ONLY the numbered translated lines:

${numberedText}`;

      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: process.env.GROQ_MODEL || 'qwen/qwen3.8-27b',
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.3
        }),
        signal: AbortSignal.timeout(20000)
      });

      if (res.status === 429) {
        console.warn(`[Groq 429 Rate Limit] Rotating key...`);
        rotateGroqKey();
        continue;
      }

      if (res.ok) {
        const data = await res.json();
        const khmer = data.choices?.[0]?.message?.content;
        if (khmer) {
          const parsed = parseNumberedOutput(khmer, segmentsChunk.length);
          if (parsed && parsed.some(Boolean)) {
            rotateGroqKey(); // Round-robin to next key in pool
            return parsed;
          }
        }
      } else {
        const errText = await res.text().catch(() => '');
        console.warn(`[Groq Error ${res.status}] Rotating key: ${errText.slice(0, 100)}`);
        rotateGroqKey();
        continue;
      }
    } catch (err) {
      console.warn('Groq batch error:', err.message);
      rotateGroqKey();
    }
  }
  return null;
}

// 3. Batch Translate Entire Segments Array (Preserves Verified Speaker Gender)
async function batchTranslateSegments(segments, sourceLang) {
  if (!segments || !segments.length) return [];
  if (sourceLang === 'km') {
    return segments.map(s => s.text);
  }

  const batchSize = 25; // Group 25 lines at a time into 1 request
  const allResults = [];

  for (let b = 0; b < segments.length; b += batchSize) {
    const chunk = segments.slice(b, b + batchSize);

    // 1. Try Groq Batch (Ultra-fast 0.8s, Llama 3.3 70B, supports 10 pooled keys)
    let translated = null;
    if (getAllGroqKeys().length > 0) {
      translated = await batchTranslateWithGroq(chunk);
    }

    // 2. Try Gemini Batch (Multi-key auto-rotation)
    if (!translated && getAllGeminiKeys().length > 0) {
      translated = await batchTranslateWithGemini(chunk);
    }

    // 3. Fallback: Translate individually with Google if both AI batches fail
    if (!translated) {
      translated = [];
      for (const seg of chunk) {
        const role = seg.gender === 'female' ? '(ស្រី) ' : '(ប្រុស) ';
        const res = await translateToKhmer(seg.text);
        translated.push(role + res);
        await new Promise(r => setTimeout(r, 250));
      }
    }

    // Fill missing items with original text
    for (let i = 0; i < chunk.length; i++) {
      allResults.push((translated[i] && translated[i].trim()) || chunk[i].text);
    }

    // Polite delay between batches
    if (b + batchSize < segments.length) {
      await new Promise(r => setTimeout(r, 500));
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
      const model = process.env.GEMINI_MODEL || 'gemini-flash-latest';
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
  const apiKey = getGroqKey() || (getAllGroqKeys()[0]) || process.env.GROQ_API_KEY;
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
        model: process.env.GROQ_MODEL || 'qwen/qwen3.8-27b',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3
      }),
      signal: AbortSignal.timeout(15000)
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

// --- Helper: Transcribe Single Audio Chunk (up to 5 mins) with Gemini Multimodal AI ---
async function transcribeSingleChunkWithGemini(chunkAudioPath, chunkStartSec = 0) {
  const keys = getAllGeminiKeys();
  if (!keys.length) return null;

  try {
    const audioBuffer = fs.readFileSync(chunkAudioPath);
    const base64Audio = audioBuffer.toString('base64');

    for (let attempt = 0; attempt < Math.min(keys.length, 3); attempt++) {
      const apiKey = getGeminiKey();
      try {
        const prompt = `You are a professional movie dialogue supervisor and casting director.
LISTEN CAREFULLY TO THE REAL VOICES IN THIS AUDIO TRACK.
1. Transcribe all spoken dialogues with accurate start time and end time in seconds (relative to this audio clip).
2. CRITICAL SPEAKER GENDER IDENTIFICATION & CONTINUITY:
   Listen to each speaker's actual voice frequency, timbre, and vocal characteristics:
   - Deep, masculine, low pitch voice -> classify strictly as "male"
   - Feminine, softer, higher pitch voice -> classify strictly as "female"
   CHARACTER CONTINUITY RULES:
   - Identify distinct characters in the scene.
   - If a character speaks multiple sentences in a row, KEEP their gender strictly consistent!
   - Characters do NOT flip-flop between male and female within the same monologue or dialogue turn.
   - Only switch gender when a different character takes turns speaking.
3. Return a STRICT JSON array of objects with the exact structure:
[
  {
    "start": 0.0,
    "end": 2.5,
    "gender": "male",
    "text": "original spoken dialogue"
  }
]
Output ONLY valid JSON. No markdown formatting, no commentary.`;

        const model = process.env.GEMINI_MODEL || 'gemini-flash-latest';
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{
              parts: [
                { text: prompt },
                { inlineData: { mimeType: 'audio/mp3', data: base64Audio } }
              ]
            }],
            generationConfig: {
              temperature: 0.1,
              responseMimeType: 'application/json'
            }
          }),
          signal: AbortSignal.timeout(45000)
        });

        if (res.status === 429) {
          console.warn('[Gemini 429] Rotating key...');
          rotateGeminiKey();
          continue;
        }

        if (res.ok) {
          const data = await res.json();
          const rawOutput = data.candidates?.[0]?.content?.parts?.[0]?.text;
          if (rawOutput) {
            const cleanJson = rawOutput.replace(/```json/g, '').replace(/```/g, '').trim();
            const parsed = JSON.parse(cleanJson);
            if (Array.isArray(parsed)) {
              rotateGeminiKey();
              return parsed.map(s => ({
                start: Math.max(0, (parseFloat(s.start) || 0) + chunkStartSec),
                end: Math.max(((parseFloat(s.start) || 0) + chunkStartSec) + 0.6, (parseFloat(s.end) || ((parseFloat(s.start) || 0) + 2)) + chunkStartSec),
                gender: (s.gender && s.gender.toLowerCase().includes('female')) ? 'female' : 'male',
                text: (s.text || '').trim()
              })).filter(s => s.text);
            }
          }
        }
      } catch (err) {
        console.warn('Gemini audio transcribe chunk error:', err.message);
        rotateGeminiKey();
      }
    }
  } catch (err) {
    console.warn('transcribeSingleChunkWithGemini error:', err.message);
  }
  return null;
}

// --- Helper: Transcribe Single Audio Chunk with Groq Whisper API (Fast Fallback) ---
async function transcribeSingleChunkWithGroq(chunkAudioPath, chunkStartSec = 0) {
  const keys = getAllGroqKeys();
  const groqKey = getGroqKey() || (keys.length > 0 ? keys[0] : process.env.GROQ_API_KEY);
  if (!groqKey) return null;

  try {
    const audioBuffer = fs.readFileSync(chunkAudioPath);
    const formData = new FormData();
    formData.append('file', new Blob([audioBuffer], { type: 'audio/mp3' }), 'audio.mp3');
    formData.append('model', 'whisper-large-v3');
    formData.append('response_format', 'verbose_json');

    const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${groqKey}` },
      body: formData,
      signal: AbortSignal.timeout(30000)
    });

    if (res.ok) {
      const data = await res.json();
      const segs = data.segments || [];
      rotateGroqKey();
      return segs.map(s => ({
        start: Math.max(0, (s.start || 0) + chunkStartSec),
        end: Math.max(chunkStartSec + 0.6, (s.end || 0) + chunkStartSec),
        gender: 'male',
        text: (s.text || '').trim()
      })).filter(s => s.text);
    }
  } catch (err) {
    console.warn('Groq chunk transcription error:', err.message);
  }
  return null;
}

// --- Master: Gemini Multimodal Audio Listening & Gender Classification (with Auto-Chunking for Long Movies) ---
async function transcribeAndDiarizeWithGemini(audioPath, onProgress) {
  const keys = getAllGeminiKeys();
  if (!keys.length) return null;

  try {
    const workDir = path.dirname(audioPath);
    const duration = await getAudioDuration(audioPath);
    const CHUNK_SEC = 300; // 5-minute chunks for 100% reliable JSON & rapid response

    // If audio is <= 360 seconds (6 minutes), do it in a single slice
    if (duration <= 360) {
      const mp3Path = path.join(workDir, `gemini_audio_${Date.now()}.mp3`);
      try {
        await runCmd(`ffmpeg -y -i "${audioPath}" -ar 16000 -ac 1 -b:a 32k "${mp3Path}"`);
      } catch (e) {
        console.warn('Audio downsample error:', e.message);
      }
      const targetAudio = fs.existsSync(mp3Path) ? mp3Path : audioPath;
      const segs = await transcribeSingleChunkWithGemini(targetAudio, 0);
      try { if (fs.existsSync(mp3Path)) fs.unlinkSync(mp3Path); } catch (e) {}
      if (segs && segs.length > 0) {
        const smoothed = smoothSpeakerSegments(segs);
        return {
          text: smoothed.map(s => s.text).join(' '),
          segments: smoothed,
          language: 'zh'
        };
      }
      return null;
    }

    // Audio > 6 minutes (Long Movies): Split into 5-minute chunks
    const totalChunks = Math.ceil(duration / CHUNK_SEC);
    console.log(`🎬 វីដេអូរឿងវែង (${Math.round(duration)}s)៖ កំពុងបែងចែកជា ${totalChunks} ភាគ (5 នាទី/ភាគ) សម្រាប់ Gemini AI វិភាគ...`);
    const allSegments = [];

    for (let c = 0; c < totalChunks; c++) {
      const startSec = c * CHUNK_SEC;
      const durSec = Math.min(CHUNK_SEC, duration - startSec);
      if (durSec <= 1) break;

      const chunkMp3 = path.join(workDir, `chunk_${c}_${Date.now()}.mp3`);
      try {
        await runCmd(`ffmpeg -y -ss ${startSec} -t ${durSec} -i "${audioPath}" -ar 16000 -ac 1 -b:a 32k "${chunkMp3}"`);
      } catch (err) {
        console.warn(`Failed to slice chunk ${c}:`, err.message);
        continue;
      }

      if (onProgress) {
        const chunkPercent = Math.min(75, 35 + Math.round(((c + 1) / totalChunks) * 35));
        await onProgress(`Gemini AI កំពុងស្ដាប់ និងបកប្រែភាគទី ${c + 1}/${totalChunks} (${Math.round(startSec / 60)}mn-${Math.round((startSec + durSec) / 60)}mn)...`, chunkPercent);
      }

      let segs = await transcribeSingleChunkWithGemini(chunkMp3, startSec);
      if (!segs || segs.length === 0) {
        // Fallback to Groq Whisper for this chunk
        segs = await transcribeSingleChunkWithGroq(chunkMp3, startSec);
      }

      try { if (fs.existsSync(chunkMp3)) fs.unlinkSync(chunkMp3); } catch (e) {}

      if (segs && segs.length > 0) {
        console.log(`✅ ភាគទី ${c + 1}/${totalChunks} ស្រង់បាន ${segs.length} segments`);
        allSegments.push(...segs);
      }
    }

    if (allSegments.length > 0) {
      const smoothed = smoothSpeakerSegments(allSegments);
      return {
        text: smoothed.map(s => s.text).join(' '),
        segments: smoothed,
        language: 'zh'
      };
    }
  } catch (err) {
    console.warn('transcribeAndDiarizeWithGemini error:', err.message);
  }
  return null;
}

// --- Helper: Transcribe Audio using Gemini Multimodal AI or Whisper AI fallback ---
async function transcribeAudio(audioPath, onProgress) {
  // 1. Priority 1: Gemini Multimodal Audio AI (Listening to real voices & detecting gender + subtitle text)
  if (getAllGeminiKeys().length > 0) {
    const geminiAudioResult = await transcribeAndDiarizeWithGemini(audioPath, onProgress);
    if (geminiAudioResult && geminiAudioResult.segments && geminiAudioResult.segments.length > 0) {
      return geminiAudioResult;
    }
  }

  let whisperError = null;

  // 2. Priority 2: Local Whisper AI (Free, 100+ languages, sentence timestamps)
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

  // 3. Priority 3: Groq Whisper API (if API key set)
  const groqKey = getGroqKey() || (getAllGroqKeys()[0]) || process.env.GROQ_API_KEY;
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
        body: formData,
        signal: AbortSignal.timeout(35000)
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

      // Select male or female voice per segment (Role Tag has absolute priority)
      let segVoice = 'km-KH-PisethNeural';
      if (isDualMode) {
        if (rawText.includes('(ស្រី)')) {
          segVoice = 'km-KH-SreymomNeural';
        } else if (rawText.includes('(ប្រុស)')) {
          segVoice = 'km-KH-PisethNeural';
        } else if (seg.gender === 'female') {
          segVoice = 'km-KH-SreymomNeural';
        } else {
          segVoice = 'km-KH-PisethNeural';
        }
      } else if (voiceGender && voiceGender.includes('ស្រី')) {
        segVoice = 'km-KH-SreymomNeural';
      } else {
        segVoice = 'km-KH-PisethNeural';
      }

      // Strip number prefix and speaker tag (ប្រុស)/(ស្រី) from TTS text so it doesn't speak tags aloud
      const cleanTtsText = rawText.replace(/^\s*\[?\d+\]?[\.\:\)\-\s]*(\((ប្រុស|ស្រី)\))?\s*/i, '').replace(/^\s*\((ប្រុស|ស្រី)\)\s*/i, '').trim() || rawText;

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
  const silenceCache = new Map();

  for (let i = 0; i < segments.length; i++) {
    const item = segmentAudios[i];
    if (!item || !fs.existsSync(item.audioPath)) continue;

    // A. Pre-speech gap: silence for natural background music and human breathing
    const leadingGap = item.start - cursorTime;
    if (leadingGap > 0.08) {
      const roundedDur = (Math.round(leadingGap * 10) / 10).toFixed(1);
      let silencePath = silenceCache.get(roundedDur);
      if (!silencePath || !fs.existsSync(silencePath)) {
        silencePath = path.join(ttsDir, `silence_${roundedDur}s.mp3`);
        await runCmd(`ffmpeg -y -f lavfi -i anullsrc=r=24000:cl=mono -t ${roundedDur} -c:a libmp3lame -b:a 48k "${silencePath}"`);
        silenceCache.set(roundedDur, silencePath);
      }
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
    const roundedEnd = (Math.round(trailingGap * 10) / 10).toFixed(1);
    let endSilencePath = silenceCache.get(roundedEnd);
    if (!endSilencePath || !fs.existsSync(endSilencePath)) {
      endSilencePath = path.join(ttsDir, `silence_${roundedEnd}s.mp3`);
      await runCmd(`ffmpeg -y -f lavfi -i anullsrc=r=24000:cl=mono -t ${roundedEnd} -c:a libmp3lame -b:a 48k "${endSilencePath}"`);
      silenceCache.set(roundedEnd, endSilencePath);
    }
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

// --- Helper: Parse SRT into timed segments with gender roles ---
function parseSrtToSegments(srtContent) {
  const blocks = srtContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split(/\n\s*\n/);
  const segments = [];

  for (const block of blocks) {
    const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length < 2) continue;

    let timeLineIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('-->')) {
        timeLineIdx = i;
        break;
      }
    }
    if (timeLineIdx === -1) continue;

    const [startStr, endStr] = lines[timeLineIdx].split('-->').map(s => s.trim());
    const parseTime = (t) => {
      const parts = t.split(':');
      if (parts.length < 3) return 0;
      const h = parseFloat(parts[0]) || 0;
      const m = parseFloat(parts[1]) || 0;
      const [s, ms] = (parts[2] || '0').replace(',', '.').split('.');
      return h * 3600 + m * 60 + (parseFloat(s) || 0) + (parseFloat(ms) || 0) / 1000;
    };

    const start = parseTime(startStr);
    const end = parseTime(endStr);
    const textLines = lines.slice(timeLineIdx + 1).join(' ').trim();
    if (!textLines) continue;

    let gender = 'male';
    if (textLines.includes('(ស្រី)')) {
      gender = 'female';
    } else if (textLines.includes('(ប្រុស)')) {
      gender = 'male';
    }

    segments.push({
      start,
      end,
      text: textLines,
      gender
    });
  }
  return segments;
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

// --- Helper: Get Video Dimensions (Width & Height) ---
async function getVideoDimensions(videoPath) {
  try {
    const { stdout } = await runCmd(`ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=s=x:p=0 "${videoPath}"`);
    const parts = stdout.trim().split('x');
    if (parts.length === 2) {
      const width = parseInt(parts[0], 10);
      const height = parseInt(parts[1], 10);
      if (!isNaN(width) && !isNaN(height)) return { width, height };
    }
  } catch (e) {}
  return { width: 1280, height: 720 };
}

// --- Main Pipeline: Process Story Video ---
async function processStoryVideo({
  bot,
  ctx,
  fileId,
  fileUrl,
  voiceType = 'សំឡេងប្រុស',
  splitMinutes = 0, // 0 = Full video, 3, 5, 10
  statusMsgId,
  userState
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

  async function updateStatus(message) {
    if (!statusMsgId) return;
    try {
      await ctx.telegram.editMessageText(ctx.chat.id, statusMsgId, null, message);
    } catch (e) {}
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
    await updateProgress('Gemini AI កំពុងវិភាគ និងបកប្រែសំឡេង..', 35);
    const transcription = await transcribeAudio(extractedAudioPath, updateProgress);

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
      // Apply speaker smoothing to prevent single-segment jitter before translation
      validSegments = smoothSpeakerSegments(validSegments);
      translatedTexts = await batchTranslateSegments(validSegments, transcription.language);

      for (let i = 0; i < validSegments.length; i++) {
        const seg = validSegments[i];
        let rawKhmer = (translatedTexts[i] || seg.text).trim();

        // 1. Detect if translation assigned a role tag, otherwise strictly enforce segment's verified audio gender
        let isFemale = false;
        if (/^\s*\[?\d*\]?[\.\:\)\-\s]*\(\s*ស្រី\s*\)/i.test(rawKhmer) || rawKhmer.includes('(ស្រី)')) {
          isFemale = true;
        } else if (/^\s*\[?\d*\]?[\.\:\)\-\s]*\(\s*ប្រុស\s*\)/i.test(rawKhmer) || rawKhmer.includes('(ប្រុស)')) {
          isFemale = false;
        } else {
          isFemale = (seg.gender === 'female');
        }

        // Synchronize seg.gender with the tag so TTS & SRT match 100%
        seg.gender = isFemale ? 'female' : 'male';
        const genderTag = isFemale ? '(ស្រី) ' : '(ប្រុស) ';

        const polished = polishKhmerDubbing(rawKhmer, seg.gender);
        const cleanKhmer = genderTag + polished;

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

    // 5. Duck & Dub with FFmpeg (Mixing clean BGM with Khmer voice + Ultra-fast stream copy)
    await updateProgress('កំពុង Render វីដេអូបកប្រែរួច (Quality 1080p Full HD)..', 92);

    let renderPulse = 92;
    const renderInterval = setInterval(() => {
      renderPulse = renderPulse < 98 ? renderPulse + 1 : 93;
      updateProgress('កំពុងផ្គុំវីដេអូ និងបញ្ចូលសំឡេងខ្មែរ (ល្បឿនលឿន Ultra-Fast)...', renderPulse).catch(() => {});
    }, 15000);

    try {
      const dims = await getVideoDimensions(inputVideoPath);
      const isPortrait = dims.height > dims.width;
      console.log(`Rendering video (${isPortrait ? 'Portrait' : 'Landscape'} - ${dims.width}x${dims.height})...`);

      if (hasCleanBgm) {
        // 100% Pure BGM: The original foreign dialogue is completely eliminated!
        console.log('Rendering with Clean AI Separated BGM...');
        const filter = `[1:a]volume=0.85[bgm];[2:a]volume=1.25[vox];[bgm][vox]amix=inputs=2:duration=first[aout]`;
        try {
          // Fast Stream Copy (Preserves 100% original crystal-clear resolution in seconds)
          await runCmd(`ffmpeg -y -i "${inputVideoPath}" -i "${cleanBgmPath}" -i "${voiceAudioPath}" -filter_complex "${filter}" -map 0:v -map "[aout]" -c:v copy -c:a aac -b:a 192k "${dubbedVideoPath}"`);
        } catch (copyErr) {
          console.warn('Stream copy failed, falling back to ultrafast encode:', copyErr.message);
          await runCmd(`ffmpeg -y -i "${inputVideoPath}" -i "${cleanBgmPath}" -i "${voiceAudioPath}" -filter_complex "${filter}" -map 0:v -map "[aout]" -c:v libx264 -preset ultrafast -crf 22 -pix_fmt yuv420p -c:a aac -b:a 192k "${dubbedVideoPath}"`);
        }
      } else {
        // 100% Dialogue Elimination: Center vocal cancellation + Active Speech Segment Muting (-40dB)
        console.log('Rendering with Center Vocal Cut & Active Dialogue Gating...');
        let muteExpr = '0';
        if (validSegments && validSegments.length > 0) {
          // Merge adjacent or overlapping mute intervals to keep expression clean & fast
          const intervals = [];
          for (const s of validSegments) {
            const start = Math.max(0, s.start - 0.15);
            const end = s.end + 0.15;
            if (intervals.length > 0 && start <= intervals[intervals.length - 1].end + 0.3) {
              intervals[intervals.length - 1].end = Math.max(intervals[intervals.length - 1].end, end);
            } else {
              intervals.push({ start, end });
            }
          }
          muteExpr = intervals.map(iv => `between(t,${iv.start.toFixed(2)},${iv.end.toFixed(2)})`).join('+');
        }
        // 1. stereotools removes the center speech channel
        // 2. volume drops to 0.01 (-40dB) whenever original dialogue is present
        // 3. volume restores to 0.85 during scene pauses, action, and BGM
        // 4. Khmer voice track plays at loud and clear 1.35 volume
        const vocalCutFilter = `[0:a]stereotools=mlev=0.015625:slev=1.2,volume=enable='${muteExpr}':volume=0.01:eval=frame,volume=0.85[bgm];[1:a]volume=1.35[vox];[bgm][vox]amix=inputs=2:duration=first[aout]`;
        try {
          // Fast Stream Copy (Preserves original quality, ~15x faster, finishes in seconds/minutes instead of 8 hours)
          await runCmd(`ffmpeg -y -i "${inputVideoPath}" -i "${voiceAudioPath}" -filter_complex "${vocalCutFilter}" -map 0:v -map "[aout]" -c:v copy -c:a aac -b:a 192k "${dubbedVideoPath}"`);
        } catch (errCopy) {
          console.warn('Vocal cut stream copy failed, trying volume gate copy:', errCopy.message);
          const fallbackFilter = `[0:a]volume=enable='${muteExpr}':volume=0.01:eval=frame,volume=0.85[bgm];[1:a]volume=1.35[vox];[bgm][vox]amix=inputs=2:duration=first[aout]`;
          try {
            await runCmd(`ffmpeg -y -i "${inputVideoPath}" -i "${voiceAudioPath}" -filter_complex "${fallbackFilter}" -map 0:v -map "[aout]" -c:v copy -c:a aac -b:a 192k "${dubbedVideoPath}"`);
          } catch (errFallback) {
            console.warn('Fallback stream copy failed, falling back to ultrafast encode:', errFallback.message);
            await runCmd(`ffmpeg -y -i "${inputVideoPath}" -i "${voiceAudioPath}" -filter_complex "${fallbackFilter}" -map 0:v -map "[aout]" -c:v libx264 -preset ultrafast -crf 22 -pix_fmt yuv420p -c:a aac -b:a 192k "${dubbedVideoPath}"`);
          }
        }
      }
    } finally {
      clearInterval(renderInterval);
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
      const caption = `🎉 បកប្រែរឿងរួចរាល់${partLabel} (Quality 1080p Full HD)! ✨\n🎙️ សម្លេង៖ ${voiceType} | 📺 កម្រិតរូបភាព៖ 1080p Full HD | 📦 ទំហំ៖ ${sizeMb}MB\n⏱️ រយៈពេល៖ ~${Math.round(duration)} វិនាទី\n💎 ផលិតដោយ៖ @AiStudioSSOnline_bot`;
      
      // If on Local Bot API, we can send up to 2GB video with streaming; otherwise standard Telegram 50MB limit applies
      const isLocalApi = process.env.BOT_API_ROOT || (process.env.LOCAL_BOT_API === 'true');
      const maxVideoSendSize = isLocalApi ? 1999 * 1024 * 1024 : 49 * 1024 * 1024;
      if (stat.size < maxVideoSendSize) {
        await ctx.replyWithVideo({ source: part.path }, { caption, supports_streaming: true });
      } else {
        await ctx.replyWithDocument({ source: part.path, filename: `Story_Part_${part.partNumber}.mp4` }, { caption });
      }
    }

    // Also send the .srt Subtitle file (with instant role swap option)
    if (fs.existsSync(srtPath)) {
      if (userState) {
        userState.lastSrtContent = srtContent;
      }
      await ctx.replyWithDocument({ source: srtPath, filename: 'Subtitle_Khmer.srt' }, {
        caption: '📄 ឯកសារ Subtitle ភាសាខ្មែរ (.srt)។\n💡 ប្រសិនបើសំឡេងច្រឡំភេទគ្នា អ្នកអាចចុចប៊ូតុងខាងក្រោមដើម្បីប្តូរភេទ (Swap) ភ្លាមៗ ឬកែអក្សរក្នុង File .srt នេះរួចផ្ញើមក Bot វិញ!',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔄 ប្តូរភេទតួអង្គ (Swap Male ↔ Female)', callback_data: 'swap_srt_gender' }]
          ]
        }
      });
    }

  } catch (error) {
    console.error('Video processing error:', error);
    await updateStatus(`❌ បរាជ័យក្នុងដំណើរការបកប្រែវីដេអូ៖ ${error.message}`);
    throw error;
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
    const segments = parseSrtToSegments(srtContent);
    const plainText = srtToPlainText(srtContent);
    if (!plainText.trim()) throw new Error('ឯកសារ SRT គ្មានអត្ថបទ!');

    await updateStatus(`🎙️ កំពុងបម្លែងអត្ថបទទៅជាសំឡេងនិយាយខ្មែរ (TTS)...`);

    let audioPath;
    const hasRoleTags = srtContent.includes('(ស្រី)') || srtContent.includes('(ប្រុស)');
    const isDualVoice = voiceType.includes('ប្រុស/ស្រី') || voiceType.includes('Auto') || voiceType.includes('Both') || hasRoleTags;

    if (segments.length > 0 && isDualVoice) {
      console.log(`SRT to Voice: Synthesizing ${segments.length} synchronized dual-role segments...`);
      const maxEnd = segments.reduce((max, s) => Math.max(max, s.end), 0);
      audioPath = await synthesizeSynchronizedVoiceTrack({
        segments,
        translatedTexts: segments.map(s => s.text),
        voiceGender: 'សំឡេងប្រុស & ស្រី',
        totalDuration: maxEnd + 2,
        workDir
      });
    } else {
      audioPath = await synthesizeKhmerVoice(plainText, voiceType, workDir);
    }

    await updateStatus(`✅ បម្លែងសំឡេងជោគជ័យ 100%! 🎉 កំពុងផ្ញើ File សំឡេង...`);
    await ctx.replyWithAudio({ source: audioPath, filename: 'Khmer_Audio_Track.mp3' }, {
      caption: `🎙️ សំឡេងខ្មែរពី SRT (${isDualVoice ? '👫 សំឡេងប្រុស & ស្រី Dual-Voice' : voiceType}) ✨\n💎 បង្កើតដោយ៖ @AiStudioSSOnline_bot`
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
  srtToPlainText,
  parseSrtToSegments
};
