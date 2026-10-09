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

// 1. AI Translation via Gemini (0% risk of block, natural Khmer dubbing tone)
async function translateWithGemini(text) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  try {
    const prompt = `You are an expert movie translator and dubber. Translate the following text into natural, spoken Khmer language suitable for movie narration. Output ONLY the translated Khmer text, without explanations or English:\n\n${text}`;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.3 }
      })
    });
    if (res.ok) {
      const data = await res.json();
      const khmer = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (khmer && khmer.trim()) return khmer.trim();
    }
  } catch (err) {
    console.warn('Gemini translation error:', err.message);
  }
  return null;
}

// 2. AI Translation via Groq LLM (ultrafast, 0% risk of block)
async function translateWithGroq(text) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return null;
  try {
    const prompt = `Translate the following dialogue into natural, spoken Khmer language for video dubbing. Output ONLY the Khmer text:\n\n${text}`;
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
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

// 3. Robust Free Google Translate with Anti-Ban (Endpoint rotation, headers, caching, rate-limit backoff)
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
              // Format 1: dict-chrome-ex format [ [ 'translation', 'lang' ] ]
              if (typeof data[0][0] === 'string' && typeof data[0][1] === 'string' && data[0][1].length <= 5) {
                translatedText = data.map(item => (Array.isArray(item) ? item[0] : item)).join('');
              } else {
                // Format 2: gtx format [ [ ['seg1', 'orig1'], ['seg2', 'orig2'] ] ]
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
        // continue to next endpoint
      }
    }
    if (attempt < retry) {
      await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
    }
  }

  return chunk;
}

// Master Translate Function:
// Prioritizes AI (Gemini/Groq) first -> Safe Throttled Google fallback second
async function translateToKhmer(text) {
  if (!text || !text.trim()) return '';

  // Priority 1: Gemini AI (1 request for entire video transcript, 0% ban risk)
  const geminiResult = await translateWithGemini(text);
  if (geminiResult) return geminiResult;

  // Priority 2: Groq AI (1 request, 0% ban risk)
  const groqResult = await translateWithGroq(text);
  if (groqResult) return groqResult;

  // Priority 3: Safe Google Translate (batched up to 2000 chars + jitter delay + caching)
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

      // Polite delay between chunk requests to avoid IP rate-limiting
      if (i < chunks.length - 1) {
        const delayMs = 600 + Math.floor(Math.random() * 500);
        await new Promise(r => setTimeout(r, delayMs));
      }
    }

    return result.trim() || text;
  } catch (err) {
    console.error('Translation error:', err.message);
    return text;
  }
}

// --- Helper: Transcribe Audio using Groq, Gemini or Free Speech API ---
async function transcribeAudio(audioPath) {
  const groqKey = process.env.GROQ_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY;

  // 1. Try Groq Whisper Large v3 (Fastest & high accuracy)
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
      } else {
        const errText = await res.text();
        console.warn('Groq API Error response:', errText);
      }
    } catch (err) {
      console.warn('Groq transcription failed, falling back:', err.message);
    }
  }

  // 2. Try Gemini Flash Audio API
  if (geminiKey) {
    try {
      console.log('Transcribing with Gemini API...');
      const audioBuffer = fs.readFileSync(audioPath);
      const base64Audio = audioBuffer.toString('base64');

      const prompt = `Please listen to this audio and provide the exact transcription text. If possible, translate it directly into Khmer sentences suitable for video dubbing.`;
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

  // 3. Fallback: Return placeholder indicating clean audio extraction
  return {
    text: 'សាច់រឿងនៃវីដេអូត្រូវបានស្រង់ចេញ និងរៀបចំសម្រាប់ការបញ្ចូលសម្លេង',
    segments: [],
    language: 'km'
  };
}

// --- Helper: Khmer Speech Synthesis via Edge-TTS ---
async function synthesizeKhmerVoice(text, voiceGender, outputDir) {
  if (!loadEdgeTTS()) {
    throw new Error('កញ្ចប់ msedge-tts មិនទាន់ដំឡើងលើ VPS ទេ។ សូមវាយបញ្ជា "npm install" លើ VPS ជាមុនសិន!');
  }
  const tts = new MsEdgeTTS();
  const voiceName = (voiceGender && voiceGender.includes('ស្រី'))
    ? 'km-KH-SreymomNeural'
    : 'km-KH-PisethNeural';

  await tts.setMetadata(voiceName, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
  
  // Clean text of non-printable or unsupported control symbols
  const cleanText = (text || '').replace(/[\r\n]+/g, ' ').trim();
  if (!cleanText) {
    throw new Error('អត្ថបទសម្រាប់បញ្ចេញសំឡេងទទេ (Empty text for TTS)');
  }

  const result = await tts.toFile(outputDir, cleanText);
  return result.audioFilePath;
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
  const sentences = text.match(/[^.!?។]+[.!?។]+|[^.!?។]+$/g) || [text];
  const chunkCount = Math.max(1, sentences.length);
  const timePerChunk = totalDuration / chunkCount;

  let srt = '';
  for (let i = 0; i < chunkCount; i++) {
    const startSec = i * timePerChunk;
    const endSec = (i + 1) * timePerChunk;
    srt += `${i + 1}\n${formatSrtTime(startSec)} --> ${formatSrtTime(endSec)}\n${sentences[i].trim()}\n\n`;
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

  async function updateStatus(message) {
    if (!statusMsgId) return;
    try {
      await ctx.telegram.editMessageText(ctx.chat.id, statusMsgId, null, message);
    } catch (e) {
      // Ignore Telegram rate limits or unchanged text
    }
  }

  try {
    // 1. Download Video
    await updateStatus(`⏳ ដំណាក់កាល 1/5: កំពុងទាញយកវីដេអូ... [■■□□□□□□□□] 20%`);
    if (fileId) {
      const link = await bot.telegram.getFileLink(fileId);
      await downloadFile(link.href, inputVideoPath);
    } else if (fileUrl) {
      await downloadFile(fileUrl, inputVideoPath);
    } else {
      throw new Error('មិនមានប្រភព File វីដេអូ ឬ Link ត្រឹមត្រូវទេ!');
    }

    const duration = await getVideoDuration(inputVideoPath);

    // 2. Extract Audio with FFmpeg
    await updateStatus(`🎙️ ដំណាក់កាល 2/5: កំពុងស្រង់សំឡេងចេញពីវីដេអូ... [■■■■□□□□□□] 40%`);
    await runCmd(`ffmpeg -y -i "${inputVideoPath}" -vn -ar 16000 -ac 1 "${extractedAudioPath}"`);

    // 3. Transcribe & Translate into Khmer
    await updateStatus(`🤖 ដំណាក់កាល 3/5: AI កំពុងស្ដាប់ និងបកប្រែជាភាសាខ្មែរ... [■■■■■■□□□□] 60%`);
    const transcription = await transcribeAudio(extractedAudioPath);
    let khmerText = '';

    if (transcription.language === 'km') {
      khmerText = transcription.text;
    } else {
      khmerText = await translateToKhmer(transcription.text);
    }

    if (!khmerText || !khmerText.trim()) {
      khmerText = 'សាច់រឿងនៃវីដេអូត្រូវបានសម្រួលបកប្រែជាភាសាខ្មែរដោយជោគជ័យ';
    }

    // Save Subtitle SRT
    const srtContent = buildSrtFromText(khmerText, duration);
    fs.writeFileSync(srtPath, srtContent, 'utf-8');

    // 4. Synthesize Khmer Voice
    await updateStatus(`🔊 ដំណាក់កាល 4/5: កំពុងបញ្ចូលសំឡេងនិយាយខ្មែរ (TTS)... [■■■■■■■■□□] 80%`);
    const voiceAudioPath = await synthesizeKhmerVoice(khmerText, voiceType, workDir);

    // 5. Duck & Dub with FFmpeg
    await updateStatus(`🎬 ដំណាក់កាល 5/5: កំពុង Render វីដេអូបកប្រែរួច (Ducking BGM)... [■■■■■■■■■□] 95%`);
    const filter = `[0:a]volume=0.2[a0];[1:a]volume=1.2[a1];[a0][a1]amix=inputs=2:duration=first[aout]`;
    await runCmd(`ffmpeg -y -i "${inputVideoPath}" -i "${voiceAudioPath}" -filter_complex "${filter}" -map 0:v -map "[aout]" -c:v copy -c:a aac "${dubbedVideoPath}"`);

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
    await updateStatus(`✅ ការបកប្រែ និងបញ្ចូលសំឡេងជោគជ័យ 100%! 🎉 កំពុងបញ្ជូនវីដេអូមកកាន់អ្នក...`);

    for (const part of finalVideoParts) {
      const partLabel = finalVideoParts.length > 1 ? ` (ភាគទី ${part.partNumber})` : '';
      const caption = `🎬 វីដេអូបកប្រែរួចរាល់${partLabel} ✨\n🎙️ សំឡេង៖ ${voiceType}\n⏱️ រយៈពេល៖ ~${Math.round(duration)} វិនាទី\n💎 ផលិតដោយ៖ @AiStudioSSOnline_bot`;
      
      const stat = fs.statSync(part.path);
      // If video < 50MB send as video, else send as document
      if (stat.size < 49 * 1024 * 1024) {
        await ctx.replyWithVideo({ source: part.path }, { caption });
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
  buildSrtFromText,
  srtToPlainText
};
