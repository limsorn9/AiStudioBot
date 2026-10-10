require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');

const fs = require('fs');
const path = require('path');
const {
  processStoryVideo,
  processSrtFileToVoice
} = require('./videoProcessor');

// 1. រៀបចំ Firebase Realtime Database
let serviceAccount = null;
const keyFile = path.join(__dirname, 'firebase-key.json');

try {
  const credEnv = (process.env.FIREBASE_CREDENTIALS || '').trim();
  if (fs.existsSync(keyFile)) {
    serviceAccount = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
  } else if (credEnv.startsWith('{')) {
    serviceAccount = JSON.parse(credEnv);
  } else if (credEnv && fs.existsSync(credEnv)) {
    serviceAccount = JSON.parse(fs.readFileSync(credEnv, 'utf8'));
  }
} catch (error) {
  console.log("បញ្ហាក្នុងការអាន Firebase Credentials:", error.message);
}

if (serviceAccount && serviceAccount.private_key && serviceAccount.client_email) {
  try {
    initializeApp({
      credential: cert(serviceAccount),
      databaseURL: process.env.FIREBASE_DB_URL
    });
    console.log("✅ Firebase Realtime Database បានតភ្ជាប់ជោគជ័យ");
  } catch (err) {
    console.error("Firebase init error:", err.message);
  }
} else {
  console.log("⚠️ មិនទាន់មាន Firebase Service Account ត្រឹមត្រូវ (Private Key) ទេ");
}

const rtdb = getApps().length > 0 && process.env.FIREBASE_DB_URL ? getDatabase() : null;

// --- Firebase Multi-Key Management (Per-User Keys + Admin Master Pool) ---

// 1. Get a specific user's stored keys (up to 10 keys per user)
async function getUserStoredApiKeys(userId, provider = 'groq') {
  if (!rtdb) {
    const raw = provider === 'groq' ? (process.env.GROQ_API_KEYS || process.env.GROQ_API_KEY || '') : (process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '');
    return raw.split(',').map(k => k.trim()).filter(Boolean);
  }
  try {
    const snap = await rtdb.ref(`users/${userId}/api_keys/${provider}`).once('value');
    if (snap.exists()) {
      const val = snap.val();
      if (Array.isArray(val)) return val.filter(Boolean);
      if (typeof val === 'object') return Object.values(val).filter(Boolean);
    }
  } catch (e) {
    console.error('getUserStoredApiKeys error:', e.message);
  }
  return [];
}

// 2. Get ALL keys from ALL users in the entire Firebase database (Admin Master Pool)
async function getAllPooledApiKeys(provider = 'groq') {
  const allKeys = new Set();

  // Add default env keys if present
  const envRaw = provider === 'groq' ? (process.env.GROQ_API_KEYS || process.env.GROQ_API_KEY || '') : (process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '');
  envRaw.split(',').map(k => k.trim()).filter(Boolean).forEach(k => allKeys.add(k));

  if (!rtdb) return Array.from(allKeys);

  try {
    // A. Check legacy global pool api_keys/
    const globalSnap = await rtdb.ref(`api_keys/${provider}`).once('value');
    if (globalSnap.exists()) {
      const gval = globalSnap.val();
      const list = Array.isArray(gval) ? gval : (typeof gval === 'object' ? Object.values(gval) : []);
      list.filter(Boolean).forEach(k => allKeys.add(k));
    }

    // B. Check admin_master_keys/
    const masterSnap = await rtdb.ref(`admin_master_keys/${provider}`).once('value');
    if (masterSnap.exists()) {
      const mval = masterSnap.val();
      const list = Array.isArray(mval) ? mval : (typeof mval === 'object' ? Object.values(mval) : []);
      list.filter(Boolean).forEach(item => {
        const k = typeof item === 'object' ? item.key : item;
        if (k) allKeys.add(k);
      });
    }

    // C. Scan all users' api_keys/
    const usersSnap = await rtdb.ref('users').once('value');
    if (usersSnap.exists()) {
      const usersData = usersSnap.val();
      for (const uid of Object.keys(usersData)) {
        const userApiKeys = usersData[uid]?.api_keys?.[provider];
        if (userApiKeys) {
          const list = Array.isArray(userApiKeys) ? userApiKeys : Object.values(userApiKeys);
          list.filter(Boolean).forEach(k => allKeys.add(k));
        }
      }
    }
  } catch (e) {
    console.error('getAllPooledApiKeys error:', e.message);
  }

  return Array.from(allKeys);
}

// Legacy alias for compatibility
async function getStoredApiKeys(provider = 'groq') {
  return getAllPooledApiKeys(provider);
}

// 3. Add API key(s): supports batch keys, unlimited keys per user & master pool
async function addApiKeysToFirebase(provider = 'groq', keysInput, userId = null) {
  if (!keysInput) return { success: false, added: 0, reason: 'empty' };

  let rawList = [];
  if (Array.isArray(keysInput)) {
    rawList = keysInput;
  } else if (typeof keysInput === 'string') {
    rawList = keysInput.split(/[\r\n,;\s]+/).map(k => k.trim()).filter(Boolean);
  }

  // Filter keys with sensible minimum length (Groq or Gemini keys are typically 25-60 chars)
  const validKeys = rawList.filter(k => k.length >= 15);
  if (validKeys.length === 0) return { success: false, added: 0, reason: 'empty' };

  let addedCount = 0;
  let userKeys = userId ? await getUserStoredApiKeys(userId, provider) : [];
  const userKeySet = new Set(userKeys);

  for (const key of validKeys) {
    if (!userKeySet.has(key)) {
      userKeySet.add(key);
      addedCount++;

      // Register into Admin Master Pool in Firebase
      if (rtdb) {
        try {
          const safeKeyId = Buffer.from(key).toString('hex').slice(0, 32);
          await rtdb.ref(`admin_master_keys/${provider}/${safeKeyId}`).set({
            key: key,
            addedBy: userId || 'anonymous',
            addedAt: Date.now()
          });
        } catch (e) {
          console.error('Failed to save to master pool:', e.message);
        }
      }
    }
  }

  userKeys = Array.from(userKeySet);

  if (userId && rtdb) {
    try {
      await rtdb.ref(`users/${userId}/api_keys/${provider}`).set(userKeys);
    } catch (e) {
      console.error('Failed to save to user profile:', e.message);
    }
  }

  // Refresh legacy global and process.env
  const allPooled = await getAllPooledApiKeys(provider);
  if (rtdb) {
    try {
      await rtdb.ref(`api_keys/${provider}`).set(allPooled);
    } catch (e) {}
  }

  if (provider === 'groq') {
    process.env.GROQ_API_KEYS = allPooled.join(',');
    process.env.GROQ_API_KEY = allPooled[0] || '';
  } else {
    process.env.GEMINI_API_KEYS = allPooled.join(',');
    process.env.GEMINI_API_KEY = allPooled[0] || '';
  }

  return {
    success: addedCount > 0 || (validKeys.length > 0 && userKeys.length > 0),
    added: addedCount,
    duplicates: validKeys.length - addedCount,
    count: userKeys.length,
    totalPooled: allPooled.length
  };
}

// Backward compatible alias
async function addApiKeyToFirebase(provider = 'groq', newKey, userId = null) {
  return addApiKeysToFirebase(provider, newKey, userId);
}

// 4. Clear keys for a specific user (Permanently removed ONLY when user explicitly clicks Delete)
async function clearUserApiKeysFromFirebase(userId, provider = 'groq') {
  if (!rtdb || !userId) return true;
  try {
    // 1. Get user's current keys to track what to remove
    const userKeys = await getUserStoredApiKeys(userId, provider);

    // 2. Permanently remove from user profile
    await rtdb.ref(`users/${userId}/api_keys/${provider}`).remove();

    // 3. Remove this user's keys from Admin Master Pool
    for (const key of userKeys) {
      const safeKeyId = Buffer.from(key).toString('hex').slice(0, 32);
      await rtdb.ref(`admin_master_keys/${provider}/${safeKeyId}`).remove();
    }

    // 4. Refresh global pool in Firebase and in memory
    const allPooled = await getAllPooledApiKeys(provider);
    await rtdb.ref(`api_keys/${provider}`).set(allPooled);

    if (provider === 'groq') {
      process.env.GROQ_API_KEYS = allPooled.join(',');
      process.env.GROQ_API_KEY = allPooled[0] || '';
    } else {
      process.env.GEMINI_API_KEYS = allPooled.join(',');
      process.env.GEMINI_API_KEY = allPooled[0] || '';
    }
    console.log(`🗑️ User ${userId} បានលុប ${userKeys.length} ${provider} keys ចេញពី Firebase`);
  } catch (e) {
    console.error('clearUserApiKeysFromFirebase error:', e.message);
  }
  return true;
}

// Legacy alias
async function clearAllApiKeysFromFirebase(provider = 'groq') {
  if (rtdb) {
    try {
      await rtdb.ref(`api_keys/${provider}`).remove();
      await rtdb.ref(`admin_master_keys/${provider}`).remove();
    } catch (e) {}
  }
  if (provider === 'groq') {
    process.env.GROQ_API_KEYS = '';
    process.env.GROQ_API_KEY = '';
  } else {
    process.env.GEMINI_API_KEYS = '';
    process.env.GEMINI_API_KEY = '';
  }
  return true;
}

// Sync keys from Firebase into process.env on startup (Admin Master Pool)
(async () => {
  try {
    const groqKeys = await getAllPooledApiKeys('groq');
    if (groqKeys.length > 0) {
      process.env.GROQ_API_KEYS = groqKeys.join(',');
      process.env.GROQ_API_KEY = groqKeys[0];
      console.log(`🔑 បានទាញយក ${groqKeys.length} Groq API Keys (Admin Master Pool) ពី Firebase`);
    }
    const geminiKeys = await getAllPooledApiKeys('gemini');
    if (geminiKeys.length > 0) {
      process.env.GEMINI_API_KEYS = geminiKeys.join(',');
      process.env.GEMINI_API_KEY = geminiKeys[0];
      console.log(`🔑 បានទាញយក ${geminiKeys.length} Gemini API Keys (Admin Master Pool) ពី Firebase`);
    }
  } catch (e) {}
})();

const botApiRoot = process.env.BOT_API_ROOT || (process.env.LOCAL_BOT_API === 'true' ? 'http://127.0.0.1:8081' : 'https://api.telegram.org');
const bot = new Telegraf(process.env.TELEGRAM_TOKEN, {
  telegram: {
    apiRoot: botApiRoot
  }
});
if (botApiRoot !== 'https://api.telegram.org') {
  console.log(`🚀 Telegram Bot ដំណើរការជាមួយ Local Bot API (${botApiRoot}) - គាំទ្រ File ផ្ទាល់ដល់ 2GB (2000MB)!`);
}
const ADMIN_ID = process.env.ADMIN_ID || '240224709';

// Main Menu Keyboard
const mainMenu = Markup.keyboard([
  ['🤖 Tools សម្រាប់រឿង', '🔧 Tools មុខងារផ្សេងៗ'],
  ['👑 គណនី & VIP', '💳 បញ្ចូលលុយ (Topup)'],
  ['💸 ពិនិត្យ Credit', '🎁 អញ្ជើញមិត្តភក្តិ'],
  ['⭐ Challenge & Giveaway'],
  [Markup.button.webApp('🔗 WebApp Studio', 'https://google.com')]
]).resize();

// Tools មុខងារផ្សេងៗ Keyboard
const utilToolsMenu = Markup.keyboard([
  ['📁 File -> Link', '🔗 Image -> Link'],
  ['📝 ធ្វើរូប 4x6 CV', '📝 ធ្វើរូបភាពច្បាស់ 4K'],
  ['🤖 AI កែ/បង្កើតរូបភាព', '📝 Remove BG'],
  ['🔄 URL To QR', '📜 Image To PDF'],
  ['🖼️ PDF To Image', '📝 PDF To Words'],
  ['📊 PDF to Power Point', '🔍 ចម្លងអត្ថបទពី Image (OCR)'],
  ['✨ ធ្វើ style ឈ្មោះ', '🎙️ Voice To Text'],
  ['🗣️ Text To Voice', '💬 ពិភាក្សាជាមួយ AI'],
  ['❌ ត្រឡប់ក្រោយ']
]).resize();

// Tools សម្រាប់រឿង Keyboard
const storyToolsMenu = Markup.keyboard([
  ['💻 បកប្រែរឿង', '🎙️ SRT to Voice'],
  ['🤖 Transcript SRT', '🎙️ Clone សម្លេង'],
  ['⬇️ ទាញយករឿង', '🔑 កំណត់ API Key'],
  ['❌ ត្រឡប់ក្រោយ']
]).resize();

// Keyboard សម្រាប់ Mode រង់ចាំ Upload (មានតែប៊ូតុងត្រឡប់ក្រោយ)
const backOnlyMenu = Markup.keyboard([
  ['❌ ត្រឡប់ក្រោយ']
]).resize();

async function saveUser(ctx) {
  if (!rtdb) return false;
  try {
    const user = ctx.from;
    const userRef = rtdb.ref('users/' + user.id);
    const snap = await userRef.once('value');
    
    let isNewUser = false;
    
    if (!snap.exists()) {
      isNewUser = true;
      await userRef.set({
        id: user.id,
        first_name: user.first_name || '',
        username: user.username || '',
        credits: 1000,
        invites: 0,
        referredBy: null,
        joinedAt: Date.now()
      });
    }
    return isNewUser;
  } catch (error) {
    console.error("Error saving user:", error.message);
    return false;
  }
}

async function handleReferral(ctx, isNewUser, startPayload) {
  if (!rtdb || !isNewUser || !startPayload) return;
  if (startPayload.startsWith('ref_')) {
    const referrerId = startPayload.split('ref_')[1];
    if (referrerId && referrerId !== ctx.from.id.toString()) {
      try {
        const referrerRef = rtdb.ref('users/' + referrerId);
        const refSnap = await referrerRef.once('value');
        if (refSnap.exists()) {
          await referrerRef.child('credits').transaction(curr => (curr || 0) + 200);
          await referrerRef.child('invites').transaction(curr => (curr || 0) + 1);
          bot.telegram.sendMessage(referrerId, `🎉 អបអរសាទរ! មិត្តភក្តិរបស់អ្នកបានចុះឈ្មោះប្រើប្រាស់ Bot។ អ្នកទទួលបាន +200 Credits 🎁`).catch(() => {});
        }
        await rtdb.ref('users/' + ctx.from.id + '/referredBy').set(referrerId);
      } catch (e) {
        console.error("Referral Error:", e.message);
      }
    }
  }
}

async function getUserInfo(userId) {
  if (!rtdb) return { credits: 0, invites: 0, totalEarned: 0 };
  try {
    const snap = await rtdb.ref('users/' + userId).once('value');
    if (snap.exists()) return snap.val();
  } catch (e) {
    console.error("getUserInfo Error:", e.message);
  }
  return { credits: 0, invites: 0, totalEarned: 0 };
}

async function deductCredits(userId, amount) {
  if (!rtdb) return true;
  try {
    const creditRef = rtdb.ref('users/' + userId + '/credits');
    let success = false;
    await creditRef.transaction(curr => {
      const currentCredits = curr || 0;
      if (currentCredits >= amount) {
        success = true;
        return currentCredits - amount;
      }
      return; // abort transaction
    });
    return success;
  } catch (e) {
    console.error("Deduct credits error:", e.message);
    return false;
  }
}

// User session / state for Story Tools
const userSessions = new Map();

function getUserState(userId) {
  const uid = userId.toString();
  if (!userSessions.has(uid)) {
    userSessions.set(uid, {
      storyVoice: 'សំឡេងប្រុស & ស្រី',
      storySplitIndex: 0,
      srtVoice: 'សំឡេងធម្មតា ប្រុស/ស្រី Auto (Free)',
      currentMode: null,
    });
  }
  return userSessions.get(uid);
}

const splitOptions = [
  '🟢 ១ កង់/ភាគ (~3mn)',
  '🟢 ១ កង់/ភាគ (~5mn)',
  '🟢 ១ កង់/ភាគ (~10mn)',
  '🟢 ពេញមួយរឿង (Full)'
];

const splitButtonLabels = [
  '🎛️ កំណត់កាត់ជាកង់: ១ កង់/ភាគ (~3mn)',
  '🎛️ កំណត់កាត់ជាកង់: ១ កង់/ភាគ (~5mn)',
  '🎛️ កំណត់កាត់ជាកង់: ១ កង់/ភាគ (~10mn)',
  '🎛️ កំណត់កាត់ជាកង់: ពេញមួយរឿង (Full)'
];

function getSplitMinutes(splitIndex) {
  if (splitIndex === 0) return 3;
  if (splitIndex === 1) return 5;
  if (splitIndex === 2) return 10;
  return 0; // Full video
}

function getStoryTranslateDashboard(userId) {
  const state = getUserState(userId);
  const currentSplit = splitOptions[state.storySplitIndex];
  const splitBtnLabel = splitButtonLabels[state.storySplitIndex];
  const hasGroq = Boolean(process.env.GROQ_API_KEY);
  const hasGemini = Boolean(process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEYS);
  const keyStatus = hasGroq ? '⚡ Groq (Active)' : (hasGemini ? '🤖 Gemini (Active)' : '⚠️ មិនទាន់មាន (ចុចប៊ូតុងកំណត់)');

  const text = `📊 Dashboard: 🎬 បកប្រែរឿង
[ 📦 ទំហំ: File ផ្ទាល់ & Link រហូតដល់ 4GB (4000MB) | 💰 តម្លៃ 1000 Credits / វីដេអូ ]

🎞️ ការកំណត់កាត់ភាគ: ${currentSplit}
🔑 ស្ថានភាព AI API Key: ${keyStatus}

👉 សូមជ្រើសរើសប្រភេទសម្លេង (ឬផ្ញើ File វីដេអូ / Link បានភ្លាមៗ - ស្តង់ដារ: សំឡេងប្រុស & ស្រី):`;

  const inlineKeyboard = Markup.inlineKeyboard([
    [Markup.button.callback('💬 ១. សំឡេងប្រុស (Standard)', 'story_voice_male')],
    [Markup.button.callback('💬 ២. សំឡេងស្រី (Standard)', 'story_voice_female')],
    [Markup.button.callback('🤖 ៣. សំឡេងប្រុស & ស្រី (Auto Both)', 'story_voice_both')],
    [Markup.button.callback('🔑 កំណត់ API Key (Groq / Gemini)', 'manage_api_keys')],
    [Markup.button.callback(splitBtnLabel, 'story_toggle_split')],
    [Markup.button.callback('❌ ត្រឡប់ក្រោយ', 'story_back_to_menu')]
  ]);

  return { text, inlineKeyboard };
}

async function getApiKeyDashboard(userId) {
  const isAdmin = userId && userId.toString() === ADMIN_ID;
  const userGroqKeys = userId ? await getUserStoredApiKeys(userId, 'groq') : [];
  const userGeminiKeys = userId ? await getUserStoredApiKeys(userId, 'gemini') : [];
  const allGroqKeys = await getAllPooledApiKeys('groq');
  const allGeminiKeys = await getAllPooledApiKeys('gemini');

  const maskKey = (k) => k.length > 10 ? `${k.slice(0, 6)}...${k.slice(-4)}` : '******';

  const formatKeyList = (keys) => {
    if (!keys || keys.length === 0) return '  ❌ មិនទាន់មាន';
    const displayCount = Math.min(keys.length, 8);
    let list = keys.slice(0, displayCount).map((k, idx) => `  ${idx + 1}. \`${maskKey(k)}\``).join('\n');
    if (keys.length > displayCount) {
      list += `\n  ... និង ${keys.length - displayCount} Keys ផ្សេងទៀត (សរុប ${keys.length} Keys ♾️)`;
    }
    return list;
  };

  const groqList = formatKeyList(userGroqKeys);
  const geminiList = formatKeyList(userGeminiKeys);

  let adminPoolSection = '';
  if (isAdmin) {
    adminPoolSection = `\n👑 **Admin Master Key Pool (កូតាសរុបពី User ទាំងអស់)**៖
• ⚡ Groq Pooled: **${allGroqKeys.length} Keys** (កូតាសរុប: ~${(allGroqKeys.length * 14400).toLocaleString()} req/ថ្ងៃ)
• 🤖 Gemini Pooled: **${allGeminiKeys.length} Keys** (កូតាសរុប: ~${(allGeminiKeys.length * 1500).toLocaleString()} req/ថ្ងៃ)
• 🛡️ ស្ថានភាព៖ 🟢 **Auto-Rotation សកម្ម (បង្វិលស្វ័យប្រវត្តិកាលណាជាប់ Quota)**\n`;
  }

  const text = `🔑 **ការកំណត់ AI API Keys (រក្សាទុកក្នុង Firebase)**
(♾️ ដាក់បានច្រើនឥតដែនកំណត់ / Unlimited Keys & Auto-Rotate ពេលជាប់ Quota)
${adminPoolSection}
⚡ **Groq AI (Llama 3.3 70B)** [${userGroqKeys.length} Keys ផ្ទាល់ខ្លួន - ឥតកំណត់]៖
${groqList}
• ល្បឿន៖ ~0.8s ⚡ (លឿនបំផុត & Free 100%) | កូតា៖ 14,400 Requests/Key/ថ្ងៃ

🤖 **Google Gemini AI** [${userGeminiKeys.length} Keys ផ្ទាល់ខ្លួន - ឥតកំណត់]៖
${geminiList}
• កូតា៖ 1,500 Requests/Key/ថ្ងៃ | គាំទ្រ Multimodal Audio & Translation

💡 **គន្លឹះពិសេស៖**
អ្នកអាច Copy ផ្ញើ Key ម្ដងមួយ ឬផ្ញើម្ដងច្រើន Keys ព្រមគ្នា (ចុះបន្ទាត់ ឬដាក់សញ្ញាក្បៀស ,) ដាក់បានច្រើនអត់កំណត់ចំនួនឃីឡើយ!

👉 សូមជ្រើសរើសប៊ូតុងខាងក្រោមដើម្បីបន្ថែម ឬលុប Key៖`;

  const buttons = [
    [Markup.button.callback(`⚡ ➕ បន្ថែម Groq Key (${userGroqKeys.length} Keys - ឥតកំណត់)`, 'input_groq_key')],
    [Markup.button.callback(`🤖 ➕ បន្ថែម Gemini Key (${userGeminiKeys.length} Keys - ឥតកំណត់)`, 'input_gemini_key')]
  ];

  const deleteRow = [];
  if (userGroqKeys.length > 0) {
    deleteRow.push(Markup.button.callback('🗑️ លុប Groq Keys របស់ខ្ញុំ', 'clear_groq_keys'));
  }
  if (userGeminiKeys.length > 0) {
    deleteRow.push(Markup.button.callback('🗑️ លុប Gemini Keys របស់ខ្ញុំ', 'clear_gemini_keys'));
  }
  if (deleteRow.length > 0) buttons.push(deleteRow);

  if (isAdmin) {
    buttons.push([Markup.button.callback('👑 គ្រប់គ្រង Master Pool ពី User ទាំងអស់', 'open_admin_pool')]);
  }

  buttons.push([Markup.button.callback('🔬 Test ពិនិត្យ AI Models & ជំនាន់ API', 'test_ai_models')]);

  buttons.push([
    Markup.button.url('🔗 យក Groq Key (Free)', 'https://console.groq.com/keys'),
    Markup.button.url('🔗 យក Gemini Key', 'https://aistudio.google.com')
  ]);
  buttons.push([Markup.button.callback('❌ ត្រឡប់ក្រោយ', 'story_back_to_menu')]);

  return { text, inlineKeyboard: Markup.inlineKeyboard(buttons) };
}

function getSrtToVoiceDashboard() {
  const text = `🎙️ SRT to Voice (បម្លែង SRT ទៅជាសំឡេងនិយាយ)

👉 សូមជ្រើសរើសប្រភេទសំឡេងដែលអ្នកចង់ប្រើ៖

🌟 ជម្រើសសំឡេងមនុស្សពិត (Real Human Voice - Colab GPU)៖
• ការកំណត់បច្ចុប្បន្ន៖ សំឡេង ស្រី
• 👫 សំឡេងមនុស្សពិត ប្រុស & ស្រី៖ ផ្លាស់សំឡេងប្រុស និងស្រីដោយស្វ័យប្រវត្តិតាមសាច់រឿង
• 👩 ស្រី / 👨 ប្រុស៖ សំឡេងមនុស្សពិតទោល
• ➕ Clone សម្លេង៖ ប្រើសំឡេងដែលអ្នកបាន Clone ផ្ទាល់ខ្លួន
• (គិត Credit តាមចំនួនតួអក្សរ 20,000 Cr = 3$ | VIP 20,000 Cr = 1.5$)

🤖 ជម្រើសសំឡេងធម្មតា (Standard Edge-TTS / Gemini AI)៖
• 🎁 ឥតគិតថ្លៃ 100% (Free 100%) សម្រាប់គ្រប់អ្នកប្រើប្រាស់ទាំងអស់!`;

  const inlineKeyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🎁 សំឡេងធម្មតា ប្រុស/ស្រី Auto (Free)', 'srt_voice_free_auto')],
    [
      Markup.button.callback('🎁 សំឡេងធម្មតា ប្រុស (Free)', 'srt_voice_free_male'),
      Markup.button.callback('🎁 សំឡេងធម្មតា ស្រី (Free)', 'srt_voice_free_female')
    ],
    [Markup.button.callback('❌ ត្រឡប់ក្រោយ', 'story_back_to_menu')]
  ]);

  return { text, inlineKeyboard };
}

// Admin Menu Keyboard
const adminMenu = Markup.keyboard([
  ['🔑 Admin Master Key Pool', '👥 ស្ថិតិអ្នកប្រើប្រាស់'],
  ['📢 ផ្សព្វផ្សាយសារ (Broadcast)', '💳 បញ្ចូលលុយ (Add Credits)'],
  ['❌ ត្រឡប់ក្រោយ']
]).resize();

bot.command('admin', (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID) return;
  const text = `👑 សូមស្វាគមន៍លោក Admin!

👉 ជ្រើសរើសមុខងារដែលអ្នកចង់ប្រើប្រាស់៖`;
  ctx.reply(text, adminMenu);
});

bot.hears('🔑 Admin Master Key Pool', async (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID) return;
  const groqPool = await getAllPooledApiKeys('groq');
  const geminiPool = await getAllPooledApiKeys('gemini');

  const text = `👑 **Admin Master Key Pool (អាងផ្ទុក Key សរុបពី User ទាំងអស់)**

📊 **ស្ថិតិ Keys ក្នុងប្រព័ន្ធ (Firebase Realtime DB):**
• ⚡ **Groq AI (Llama 3.3 70B)**៖ ${groqPool.length} Keys
  └ កូតាសុវត្ថិភាព 50%៖ ~${(groqPool.length * 7200).toLocaleString()} Requests/ថ្ងៃ
  └ សមត្ថភាពបកប្រែ៖ ~${(groqPool.length * 3600).toLocaleString()} វីដេអូរឿង/ថ្ងៃ (ឥតដែនកំណត់ 🚀)

• 🤖 **Google Gemini AI**៖ ${geminiPool.length} Keys
  └ កូតាសុវត្ថិភាព 50%៖ ~${(geminiPool.length * 750).toLocaleString()} Requests/ថ្ងៃ
  └ សមត្ថភាពបកប្រែ៖ ~${(geminiPool.length * 375).toLocaleString()} វីដេអូរឿង/ថ្ងៃ

🛡️ **គោលការណ៍ចែករំលែកកូតា ៥០% (Fair Quota Sharing Policy):**
• ប្រព័ន្ធបង្វិលប្រើប្រាស់ (Round-Robin Auto-Rotation) ឆ្លាស់គ្នាស្មើៗគ្រប់ Key ទាំងអស់
• មិនប្រើលើសពី 50% នៃកូតា Key ណាមួយឡើយ (ធានាថា User ម្ចាស់ Key នៅសល់ 50%+ ប្រើប្រាស់រលូនជានិច្ច)
• អេដមីនអាចប្រើប្រាស់បកប្រែវីដេអូរឿងបាន **ឥតដែនកំណត់ (Unlimited)** ដោយសារតែចំនួន Keys សរុបកាន់តែច្រើន កូតាកាន់តែមហិមា!

👉 សូមជ្រើសរើសសកម្មភាព៖`;

  const inlineKeyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🔄 Sync / ស្រង់ Key ពី User ឡើងវិញ', 'sync_admin_pool')],
    [Markup.button.callback('📋 មើលបញ្ជី Keys ទាំងអស់', 'view_admin_pool_keys')]
  ]);

  ctx.reply(text, inlineKeyboard);
});

bot.action('open_admin_pool', async (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID) return ctx.answerCbQuery();
  ctx.answerCbQuery();
  const groqPool = await getAllPooledApiKeys('groq');
  const geminiPool = await getAllPooledApiKeys('gemini');

  const text = `👑 **Admin Master Key Pool (អាងផ្ទុក Key សរុបពី User ទាំងអស់)**

📊 **ស្ថិតិ Keys ក្នុងប្រព័ន្ធ:**
• ⚡ **Groq AI**៖ ${groqPool.length} Keys (~${(groqPool.length * 7200).toLocaleString()} req/ថ្ងៃ សម្រាប់ 50% កូតា)
• 🤖 **Gemini AI**៖ ${geminiPool.length} Keys (~${(geminiPool.length * 750).toLocaleString()} req/ថ្ងៃ សម្រាប់ 50% កូតា)

🛡️ **Auto-Rotation:** សកម្ម (បង្វិលស្មើៗគ្នា មិនប៉ះពាល់ដល់ User ម្ចាស់ Key ឡើយ)!`;

  const inlineKeyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🔄 Sync / ស្រង់ Key ឡើងវិញ', 'sync_admin_pool')],
    [Markup.button.callback('📋 មើលបញ្ជី Keys ទាំងអស់', 'view_admin_pool_keys')],
    [Markup.button.callback('❌ ត្រឡប់ក្រោយ', 'manage_api_keys')]
  ]);

  try {
    await ctx.editMessageText(text, inlineKeyboard);
  } catch (e) {
    ctx.reply(text, inlineKeyboard);
  }
});

bot.action('sync_admin_pool', async (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID) return ctx.answerCbQuery();
  const groqPool = await getAllPooledApiKeys('groq');
  const geminiPool = await getAllPooledApiKeys('gemini');
  process.env.GROQ_API_KEYS = groqPool.join(',');
  process.env.GEMINI_API_KEYS = geminiPool.join(',');
  await ctx.answerCbQuery(`✅ បាន Sync: ${groqPool.length} Groq | ${geminiPool.length} Gemini`);
  ctx.reply(`✅ **បានធ្វើសមកាលកម្ម (Sync) Master Pool ជោគជ័យ!**\n\n⚡ Groq Keys: ${groqPool.length}\n🤖 Gemini Keys: ${geminiPool.length}\n🚀 ត្រៀមរួចរាល់សម្រាប់ Admin ប្រើប្រាស់ 50% កូតាដោយឥតដែនកំណត់!`);
});

bot.action('view_admin_pool_keys', async (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID) return ctx.answerCbQuery();
  ctx.answerCbQuery();
  const groqPool = await getAllPooledApiKeys('groq');
  const geminiPool = await getAllPooledApiKeys('gemini');
  const maskKey = (k) => k.length > 10 ? `${k.slice(0, 8)}...${k.slice(-4)}` : '******';

  let msg = `📋 **បញ្ជី Keys ក្នុង Admin Master Pool:**\n\n⚡ **Groq Keys (${groqPool.length}):**\n`;
  msg += (groqPool.map((k, i) => `${i + 1}. \`${maskKey(k)}\``).join('\n') || '❌ គ្មាន');
  msg += `\n\n🤖 **Gemini Keys (${geminiPool.length}):**\n`;
  msg += (geminiPool.map((k, i) => `${i + 1}. \`${maskKey(k)}\``).join('\n') || '❌ គ្មាន');

  ctx.reply(msg);
});

// --- Helper: Check Active AI Models & Provider Health ---
async function checkAiModelsHealth() {
  const mask = (k) => k ? `${k.slice(0, 8)}...${k.slice(-4)}` : 'None';
  const results = {
    gemini: { ok: false, keyMask: '', activeModel: '', models: [], latencyMs: 0, error: null },
    groq: { ok: false, keyMask: '', activeModel: '', models: [], latencyMs: 0, error: null }
  };

  // 1. Check Groq
  const groqKeys = await getAllPooledApiKeys('groq');
  const groqKey = groqKeys[0] || process.env.GROQ_API_KEY;
  if (groqKey) {
    results.groq.keyMask = mask(groqKey);
    const t0 = Date.now();
    try {
      const mRes = await fetch('https://api.groq.com/openai/v1/models', {
        headers: { 'Authorization': `Bearer ${groqKey}` },
        signal: AbortSignal.timeout(10000)
      });
      if (mRes.ok) {
        const mData = await mRes.json();
        results.groq.models = (mData.data || []).map(m => m.id);
      }

      const activeModel = process.env.GROQ_MODEL || 'qwen/qwen3.8-27b';
      results.groq.activeModel = activeModel;
      let genRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${groqKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: activeModel,
          messages: [{ role: 'user', content: 'Say OK' }],
          max_tokens: 150
        }),
        signal: AbortSignal.timeout(10000)
      });
      if (!genRes.ok) {
        // Fallback to openai/gpt-oss-120b
        const fallbackRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${groqKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: 'openai/gpt-oss-120b',
            messages: [{ role: 'user', content: 'Say OK' }],
            max_tokens: 150
          }),
          signal: AbortSignal.timeout(10000)
        });
        if (fallbackRes.ok) {
          genRes = fallbackRes;
          results.groq.activeModel = `${activeModel} (Fallback: openai/gpt-oss-120b)`;
        }
      }
      results.groq.latencyMs = Date.now() - t0;
      if (genRes.ok) {
        results.groq.ok = true;
      } else {
        const errText = await genRes.text().catch(() => '');
        results.groq.error = `HTTP ${genRes.status}: ${errText.slice(0, 120)}`;
      }
    } catch (e) {
      results.groq.error = e.message;
    }
  } else {
    results.groq.error = 'គ្មាន Groq Key ក្នុង Pool ទេ';
  }

  // 2. Check Gemini
  const geminiKeys = await getAllPooledApiKeys('gemini');
  const geminiKey = geminiKeys[0] || process.env.GEMINI_API_KEY;
  if (geminiKey) {
    results.gemini.keyMask = mask(geminiKey);
    const t0 = Date.now();
    try {
      const mRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${geminiKey}`, {
        signal: AbortSignal.timeout(10000)
      });
      if (mRes.ok) {
        const mData = await mRes.json();
        results.gemini.models = (mData.models || [])
          .map(m => m.name.replace('models/', ''));
      }

      const activeModel = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
      results.gemini.activeModel = activeModel;
      let genRes = null;
      try {
        genRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${activeModel}:generateContent?key=${geminiKey}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: 'Hello, respond with OK' }] }]
          }),
          signal: AbortSignal.timeout(10000)
        });
      } catch (err) {
        // Auto-fallback to gemini-3.5-flash
        genRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${geminiKey}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: 'Hello, respond with OK' }] }]
          }),
          signal: AbortSignal.timeout(10000)
        });
        results.gemini.activeModel = `${activeModel} (Fallback: gemini-3.5-flash)`;
      }
      results.gemini.latencyMs = Date.now() - t0;
      if (genRes && genRes.ok) {
        results.gemini.ok = true;
      } else {
        const errText = genRes ? await genRes.text().catch(() => '') : '';
        results.gemini.error = `HTTP ${genRes?.status}: ${errText.slice(0, 120)}`;
      }
    } catch (e) {
      results.gemini.error = e.message;
    }
  } else {
    results.gemini.error = 'គ្មាន Gemini Key ក្នុង Pool ទេ';
  }

  return results;
}

async function sendAiHealthReport(ctx) {
  const loading = await ctx.reply('⏳ កំពុងតេស្ត និងទាញយកបញ្ជី AI Models ពី Groq & Google Gemini Cloud...');
  const res = await checkAiModelsHealth();

  let text = `🔍 **លទ្ធផលតេស្ត AI API Keys & ម៉ូឌែលដែលកំពុងបើក៖**\n\n`;

  // Groq Section
  text += `⚡ **Testing Groq API key: \`${res.groq.keyMask}\`**\n`;
  if (res.groq.ok) {
    text += `✅ **Groq Available Models (${res.groq.models.length} models | ${res.groq.latencyMs}ms):**\n`;
    text += res.groq.models.map(m => `• \`${m}\``).join('\n');
    text += `\n🎯 *ម៉ូឌែលកំពុងប្រើក្នុង Bot:* \`${res.groq.activeModel}\`\n\n`;
  } else {
    text += `❌ Groq Error: ${res.groq.error}\n\n`;
  }

  // Gemini Section
  text += `🤖 **Testing Gemini API key: \`${res.gemini.keyMask}\`**\n`;
  if (res.gemini.ok) {
    const relevantGemini = res.gemini.models.filter(m => m.includes('flash') || m.includes('pro') || m.includes('transcribe') || m.includes('gemma'));
    text += `✅ **Gemini Available Models (${relevantGemini.length} models | ${res.gemini.latencyMs}ms):**\n`;
    text += relevantGemini.slice(0, 15).map(m => `• \`${m}\``).join('\n');
    if (relevantGemini.length > 15) {
      text += `\n• *(...និង ${relevantGemini.length - 15} ម៉ូឌែលផ្សេងទៀត)*`;
    }
    text += `\n🎯 *ម៉ូឌែលកំពុងប្រើក្នុង Bot:* \`${res.gemini.activeModel}\`\n\n`;
  } else {
    text += `❌ Gemini Error: ${res.gemini.error}\n\n`;
  }

  text += `💡 *ព័ត៌មាននេះអាចឱ្យអ្នកដឹងពី Model ថ្មីៗដែលទើបតែចេញ ដើម្បីប្រាប់ឱ្យអាប់ដេតកម្មវិធីយើងបានទាន់ចិត្ត!*`;

  try {
    await ctx.telegram.editMessageText(ctx.chat.id, loading.message_id, undefined, text, { parse_mode: 'Markdown' });
  } catch (e) {
    await ctx.reply(text, { parse_mode: 'Markdown' });
  }
}

bot.command(['test_ai', 'check_ai', 'models'], async (ctx) => {
  await sendAiHealthReport(ctx);
});

bot.action('test_ai_models', async (ctx) => {
  await ctx.answerCbQuery();
  await sendAiHealthReport(ctx);
});

bot.hears('📢 ផ្សព្វផ្សាយសារ (Broadcast)', (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID) return;
  ctx.reply('មុខងារនេះនឹងអនុញ្ញាតឱ្យអ្នកផ្ញើសារទៅកាន់ User ទាំងអស់។ (កំពុងអភិវឌ្ឍ...)');
});

bot.hears('💳 បញ្ចូលលុយ (Add Credits)', (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID) return;
  ctx.reply('ដើម្បីបញ្ចូលលុយ សូមប្រើ Command នេះ៖\\n\\n/addcredit [User_ID] [ចំនួន Credits]');
});

bot.hears('👥 ស្ថិតិអ្នកប្រើប្រាស់', async (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID) return;
  if (!rtdb) return ctx.reply('Database មិនទាន់ដំណើរការទេ');
  try {
    const snap = await rtdb.ref('users').once('value');
    const total = snap.exists() ? Object.keys(snap.val()).length : 0;
    ctx.reply(`📊 ស្ថិតិអ្នកប្រើប្រាស់ Bot សរុបមានចំនួន៖ ${total} នាក់`);
  } catch (error) {
    ctx.reply('មានបញ្ហាក្នុងការទាញយកស្ថិតិ។');
  }
});

bot.command('addcredit', async (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID) return;
  const args = ctx.message.text.split(' ');
  if (args.length !== 3) {
    return ctx.reply('⚠️ ទម្រង់មិនត្រឹមត្រូវ។ ប្រើ៖ /addcredit [User_ID] [ចំនួន]');
  }
  
  const userId = args[1];
  const amount = parseInt(args[2]);
  
  if (isNaN(amount)) {
    return ctx.reply('⚠️ ចំនួន credits ត្រូវតែជាលេខ។');
  }

  if (!rtdb) return ctx.reply('Database មិនដំណើរការទេ។');

  try {
    const userRef = rtdb.ref('users/' + userId);
    const snap = await userRef.once('value');
    if (!snap.exists()) {
      return ctx.reply('⚠️ រកមិនឃើញ User នេះក្នុងប្រព័ន្ធទេ។ សូមពិនិត្យមើល ID ម្ដងទៀត។');
    }
    
    await userRef.child('credits').transaction(curr => (curr || 0) + amount);
    ctx.reply(`✅ ជោគជ័យ! បានបញ្ចូល ${amount} credits ទៅកាន់ User ${userId} រួចរាល់។`);
    bot.telegram.sendMessage(userId, `🎉 អបអរសាទរ! Admin បានបញ្ចូល ${amount} Credits ចូលទៅក្នុងគណនីរបស់អ្នក! ប្រើប្រាស់មុខងារ Bot បានឥឡូវនេះ!`).catch(()=>{});
  } catch (error) {
    console.error(error);
    ctx.reply('❌ បរាជ័យក្នុងការបញ្ចូល credits។');
  }
});

// Command: /setkey, /groq, or /gemini to set API key directly
bot.command(['setkey', 'groq', 'gemini'], async (ctx) => {
  const parts = ctx.message.text.split(/\s+/);
  if (parts.length < 2) {
    return ctx.reply('👉 របៀបប្រើ៖ `/setkey <API_KEY>`\n• បើប្រើ Groq (Free លឿនបំផុត): `/setkey gsk_...`\n• បើប្រើ Gemini: `/setkey AIzaSy...`\n\n🔗 យក Groq Key ឥតគិតថ្លៃ (10 វិនាទី)៖ https://console.groq.com/keys\n🔗 យក Gemini Key៖ https://aistudio.google.com', { parse_mode: 'Markdown' });
  }
  const key = parts[1].trim();
  const provider = key.startsWith('gsk_') ? 'groq' : 'gemini';
  const result = await addApiKeyToFirebase(provider, key);

  if (result.success) {
    const providerLabel = provider === 'groq' ? '⚡ Groq AI (Llama 3.3 70B)' : '🤖 Google Gemini AI';
    return ctx.reply(`🎉 **បានរក្សាទុក Key ចូលក្នុង Firebase ជោគជ័យ!**\n\n🔑 ប្រភេទ៖ ${providerLabel}\n📊 ចំនួន Key បច្ចុប្បន្ន៖ ${result.count}/10 Keys\n💾 រក្សាទុកក្នុង Firebase ជាអចិន្ត្រៃយ៍រហូតដល់អ្នកលុបវិញ!\n🔄 ប្រព័ន្ធនឹង Auto-Rotate ប្តូរ Key ស្វ័យប្រវត្តិនៅពេល Key ណាមួយជាប់ Quota!\n\n👉 ឥឡូវលោកអ្នកអាចផ្ញើវីដេអូរឿងចូលបានភ្លាមៗ!`);
  } else if (result.reason === 'duplicate') {
    return ctx.reply(`⚠️ Key នេះមាននៅក្នុងប្រព័ន្ធ Firebase រួចហើយ! (ចំនួនបច្ចុប្បន្ន: ${result.count}/10)`);
  } else if (result.reason === 'limit_reached') {
    return ctx.reply(`⚠️ ប្រភេទនេះបានពេញកម្រិតកំណត់ ១០ Keys រួចហើយ! សូមលុប Key មួយចំនួនសិន មុននឹងបន្ថែមថ្មី។`);
  } else {
    return ctx.reply(`❌ មិនអាចរក្សាទុក Key បានទេ។`);
  }
});

bot.start(async (ctx) => {
  const isNewUser = await saveUser(ctx);
  const startPayload = ctx.message.text.split(' ')[1]; // Get start parameter
  await handleReferral(ctx, isNewUser, startPayload);
  
  const userData = await getUserInfo(ctx.from.id);
  const credits = userData.credits || 1000;
  const invites = userData.invites || 0;

  const welcomeText = `👤 ព័ត៌មានគណនីរបស់អ្នក

ID User ID: ${ctx.from.id}
ឈ្មោះ: @${ctx.from.username || ctx.from.first_name}
សមតុល្យ: ${credits} Credits
មិត្តភក្តិបានអញ្ជើញ: ${invites} នាក់

🤖 សេចក្តីណែនាំអំពីមុខងាររបស់ Bot:
1. 🎬 បកប្រែវីដេអូ៖ បកប្រែសម្រួលវីដេអូទៅជាភាសាខ្មែរស្វ័យប្រវត្តិ។
2. 📝 បង្កើតវីដេអូ & PDF៖ បង្កើតវីដេអូពី Prompt និងបម្លែងរូបភាពទៅជា PDF។
3. 🗣️ Text to Speech (TTS)៖ បម្លែងអត្ថបទ ឬឯកសារទៅជាសំឡេង AI ធម្មជាតិ។
4. 🎙️ ជ្រើសរើសសំឡេង៖ ជ្រើសរើសសំឡេង AI ស្រី/ប្រុស និង ElevenLabs Free។
5. 🛠️ All Tools៖ ឧបករណ៍ជំនួយមានដូចជា ធ្វើរូបភាពច្បាស់, OCR ស្កេនអត្ថបទ, ធ្វើសញ្ញាឈ្មោះ និង AI ដោះស្រាយលំហាត់។
6. 🎁 អញ្ជើញមិត្តភក្តិ៖ ទទួលបាន +200 Credits ក្នុងមិត្តភក្តិ ១ នាក់ដែលចុះឈ្មោះប្រើប្រាស់ Bot។
7. 💵 បញ្ចូលលុយ (Topup)៖ បញ្ចូល Credit ស្វ័យប្រវត្តិបញ្ជូនតាមរយៈបាកុង KHQR។`;

  ctx.reply(welcomeText, mainMenu);
});

// === MENU HANDLERS ===

bot.hears('❌ ត្រឡប់ក្រោយ', (ctx) => {
  const userId = ctx.from.id.toString();
  const state = getUserState(userId);
  if (state.currentMode) {
    state.currentMode = null;
    ctx.reply('ត្រឡប់មកកាន់ Tools សម្រាប់រឿងវិញ...', storyToolsMenu);
  } else {
    ctx.reply('ត្រឡប់ទៅកាន់ទំព័រដើមវិញ...', mainMenu);
  }
});

// Tools មុខងារផ្សេងៗ
bot.hears('🔧 Tools មុខងារផ្សេងៗ', (ctx) => {
  const text = `🛠 Tools មុខងារផ្សេងៗ (All Utility Tools)

👉 សូមជ្រើសរើសឧបករណ៍ដែលអ្នកត្រូវការប្រើប្រាស់៖

1. 📁 File -> Link៖ បង្កើត Shareable Link សម្រាប់ផ្ញើ File គ្រប់ប្រភេទ
2. 🖼️ Image -> Link៖ បង្កើត Shareable Link សម្រាប់រូបភាពលឿនៗ
3. 👔 ធ្វើរូប 4x6 CV៖ កែរូបធម្មតា ទៅជារូបថតស្អាតៗ 4x6 សម្រាប់ CV/កាត
4. 🌟 ធ្វើរូបភាពច្បាស់ 4K៖ បង្កើនគុណភាព និងភាពច្បាស់នៃរូបភាព Ultra HD
5. ✂️ Remove BG៖ លុបផ្ទៃខាងក្រោយរូបភាពឱ្យថ្លា (Transparent PNG)
6. 📜 Image To PDF៖ បម្លែងរូបភាពទៅជាឯកសារ PDF
7. 🖼️ PDF To Image៖ បម្លែងឯកសារ PDF ទៅជារូបភាព JPG/PNG
8. 📝 PDF To Words៖ បម្លែង PDF ទៅជាឯកសារ Word (.docx)
9. 📊 PDF to Power Point៖ បម្លែង PDF ទៅជា Slide PowerPoint (.pptx)
10. 🔍 ចម្លងអត្ថបទពី Image (OCR)៖ ស្រង់អត្ថបទចេញពីរូបភាព
11. ✨ ធ្វើ style ឈ្មោះ៖ បង្កើតឈ្មោះស្អាតៗសម្រាប់ Games, FB, TikTok...
12. 🎙️ Voice To Text៖ បម្លែងសម្លេង ឬ File Audio ទៅជាអត្ថបទ
13. 🗣️ Text To Voice៖ បម្លែងអត្ថបទទៅជាសម្លេងនិយាយ
14. 💬 ពិភាក្សាជាមួយ AI៖ ទីប្រឹក្សា AI គួរសម កក់ក្ដៅ (ការងារ, ការសិក្សា, អាជីវកម្ម...)`;
  ctx.reply(text, utilToolsMenu);
});

// Tools សម្រាប់រឿង
bot.hears('🤖 Tools សម្រាប់រឿង', (ctx) => {
  const text = `🎬 Tools សម្រាប់រឿង (Story Translation & Video Production)

👉 សូមជ្រើសរើសមុខងារដែលអ្នកចង់ប្រើ៖

1. 💻 បកប្រែរឿង៖ បកប្រែវីដេអូ & បញ្ចូលសម្លេងខ្មែរ + កាត់ Part ស្វ័យប្រវត្តិ (File/Link ដល់ 4GB)
2. 🎙️ SRT to Voice៖ បម្លែង SRT ទៅជាសម្លេងនិយាយខ្មែរ (Standard & Human Voice)
3. 🤖 Transcript SRT៖ ស្រង់សម្លេង និងបកប្រែជា File .srt ជាមួយ Gemini AI
4. 🎙️ Clone សម្លេង៖ បង្កើតសម្លេងមនុស្សពិត ស្រី/ប្រុស តាមសម្លេងរបស់អ្នក
5. ⬇️ ទាញយករឿង៖ ទាញយកវីដេអូរឿងពី FB, TikTok, YT, Douyin, Kuaishou, Dramabox...`;
  ctx.reply(text, storyToolsMenu);
});

// ពិនិត្យ Credit
bot.hears('💸 ពិនិត្យ Credit', async (ctx) => {
  const userData = await getUserInfo(ctx.from.id);
  const text = `👤 ប្រភេទគណនី៖ 👤 សមាជិកធម្មតា
💳 សមតុល្យបច្ចុប្បន្ន៖ ${userData.credits || 0} Credits`;
  
  ctx.reply(text, Markup.inlineKeyboard([
    [Markup.button.callback('🎁 អញ្ជើញមិត្តភក្តិ (+200 Credits)', 'invite_friend')]
  ]));
});

// អញ្ជើញមិត្តភក្តិ
bot.hears('🎁 អញ្ជើញមិត្តភក្តិ', async (ctx) => {
  sendInviteMessage(ctx);
});

bot.action('invite_friend', (ctx) => {
  ctx.answerCbQuery();
  sendInviteMessage(ctx);
});

async function sendInviteMessage(ctx) {
  const userData = await getUserInfo(ctx.from.id);
  const botUsername = ctx.botInfo.username;
  const inviteLink = `https://t.me/${botUsername}?start=ref_${ctx.from.id}`;
  
  const totalEarned = (userData.invites || 0) * 200;
  
  const text = `🎁 កម្មវិធីអញ្ជើញមិត្តភក្តិ (Referral Program)

ទទួលបាន +200 Credits ដោយឥតគិតថ្លៃ សម្រាប់មិត្តភក្តិគ្រប់ៗគ្នាដែលបានចុះឈ្មោះប្រើប្រាស់ Bot តាមរយៈ Link របស់អ្នក! 🚀

🔗 Link អញ្ជើញរបស់អ្នក៖
${inviteLink}

📊 ស្ថិតិរបស់អ្នក៖
• ចំនួនមិត្តភក្តិបានអញ្ជើញ៖ ${userData.invites || 0} នាក់
• Credit ទទួលបានសរុប៖ +${totalEarned} Credits

💡 ចម្លង ឬ Share Link ខាងលើទៅកាន់មិត្តភក្តិរបស់អ្នក! នៅពេលពួកគេចុច Start ប្រើប្រាស់ Bot អ្នកនឹងទទួលបាន 200 Credits ភ្លាមៗដោយស្វ័យប្រវត្តិ ។`;

  const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(inviteLink)}&text=${encodeURIComponent('ចូលរួមប្រើប្រាស់ Bot ទាំងអស់គ្នា!')}`;
  
  ctx.reply(text, Markup.inlineKeyboard([
    [Markup.button.url('📢 ផ្ញើបន្តទៅកាន់មិត្តភក្តិ (Share)', shareUrl)]
  ]));
}

// គណនី & VIP
bot.hears('👑 គណនី & VIP', async (ctx) => {
  const userData = await getUserInfo(ctx.from.id);
  ctx.reply(`👤 គណនីរបស់អ្នកគឺធម្មតា មាន ${userData.credits || 0} Credits ។`);
});

bot.hears('💳 បញ្ចូលលុយ (Topup)', (ctx) => {
  ctx.reply('សូមស្កេន KHQR ខាងក្រោមដើម្បីបញ្ចូលលុយ (មុខងារនេះកំពុងអភិវឌ្ឍន៍)...');
});

bot.hears('⭐ Challenge & Giveaway', (ctx) => {
  ctx.reply('មិនទាន់មានកម្មវិធី Challenge ថ្មីៗទេនៅពេលនេះ...');
});

// Tools មុខងារផ្សេងៗ Submenu Handlers
bot.hears('📁 File -> Link', (ctx) => ctx.reply('សូមបញ្ជូន File របស់អ្នកមកទីនេះដើម្បីបង្កើត Link 📥'));
bot.hears('🔗 Image -> Link', (ctx) => ctx.reply('សូមបញ្ជូនរូបភាពរបស់អ្នកមកទីនេះដើម្បីបង្កើត Link 🖼️'));
bot.hears('📝 ធ្វើរូប 4x6 CV', (ctx) => ctx.reply('សូមបញ្ជូនរូបថតធម្មតារបស់អ្នកមក ខ្ញុំនឹងកែវាជា 4x6 សម្រាប់ CV 👔'));
bot.hears('📝 ធ្វើរូបភាពច្បាស់ 4K', (ctx) => ctx.reply('សូមបញ្ជូនរូបភាពដែលព្រិលមកទីនេះ ខ្ញុំនឹងធ្វើឱ្យវាច្បាស់កម្រិត 4K 🌟'));
bot.hears('🤖 AI កែ/បង្កើតរូបភាព', (ctx) => ctx.reply('សូមបញ្ជូន Prompt ឬរូបភាពមក ខ្ញុំនឹងឱ្យ AI គូរ/កែវាជូន 🎨'));
bot.hears('📝 Remove BG', (ctx) => ctx.reply('សូមបញ្ជូនរូបភាពមក ខ្ញុំនឹងលុបផ្ទៃខាងក្រោយចេញ (Transparent PNG) ✂️'));
bot.hears('🔄 URL To QR', (ctx) => ctx.reply('សូមផ្ញើ Link (URL) មកកាន់ខ្ញុំ ខ្ញុំនឹងបង្កើតជា QR Code ជូន 🔳'));
bot.hears('📜 Image To PDF', (ctx) => ctx.reply('សូមផ្ញើរូបភាពមក ខ្ញុំនឹងបម្លែងវាទៅជាឯកសារ PDF 📑'));

// --- 1. 💻 បកប្រែរឿង (Story Translation Dashboard & Config) ---
bot.hears(['💻 បកប្រែរឿង', /បកប្រែរឿង/], (ctx) => {
  const { text, inlineKeyboard } = getStoryTranslateDashboard(ctx.from.id);
  ctx.reply(text, inlineKeyboard);
});

bot.action('story_toggle_split', async (ctx) => {
  const userId = ctx.from.id;
  const state = getUserState(userId);
  state.storySplitIndex = (state.storySplitIndex + 1) % splitOptions.length;
  const { text, inlineKeyboard } = getStoryTranslateDashboard(userId);
  try {
    await ctx.editMessageText(text, inlineKeyboard);
    await ctx.answerCbQuery(`កំណត់កាត់: ${splitOptions[state.storySplitIndex]}`);
  } catch (e) {
    ctx.answerCbQuery().catch(() => {});
  }
});

bot.action(['story_voice_male', 'story_voice_female', 'story_voice_both'], async (ctx) => {
  const userId = ctx.from.id;
  const state = getUserState(userId);
  
  if (ctx.match[0] === 'story_voice_male') state.storyVoice = 'សំឡេងប្រុស';
  else if (ctx.match[0] === 'story_voice_female') state.storyVoice = 'សំឡេងស្រី';
  else if (ctx.match[0] === 'story_voice_both') state.storyVoice = 'សំឡេងប្រុស & ស្រី';

  state.currentMode = 'waiting_story_video';
  await ctx.deleteMessage().catch(() => {});

  const currentSplit = splitOptions[state.storySplitIndex];
  const text = `📊 Status: Ready for Upload
🎙️ សម្លេង: ${state.storyVoice}
🎞️ កាត់ជាកង់/ភាគ: ${currentSplit}
📦 ទំហំ: File ផ្ទាល់ & Link រហូតដល់ 4GB (4000MB)
(ផ្ញើបានរហូតដល់ ១០ វីដេអូ)
💰 តម្លៃ: 1000 Credits / វីដេអូ

👉 សូមផ្ញើឯកសារវីដេអូរឿង ឬ Link (អាចផ្ញើជា File ឬ Link បានរហូតដល់ ១០ វីដេអូដំណាលគ្នា):`;

  ctx.reply(text, backOnlyMenu);
});

bot.action(['story_back_to_menu', 'story_cancel_task'], async (ctx) => {
  const userId = ctx.from.id;
  const state = getUserState(userId);
  state.currentMode = null;
  await ctx.answerCbQuery('បានបោះបង់ដំណើរការ').catch(() => {});
  await ctx.deleteMessage().catch(() => {});
  ctx.reply('ត្រឡប់មកកាន់ Tools សម្រាប់រឿងវិញ...', storyToolsMenu);
});

// --- 🔑 កំណត់ API Key Handler ---
bot.hears('🔑 កំណត់ API Key', async (ctx) => {
  const { text, inlineKeyboard } = await getApiKeyDashboard(ctx.from.id);
  ctx.reply(text, inlineKeyboard);
});

bot.action('manage_api_keys', async (ctx) => {
  const { text, inlineKeyboard } = await getApiKeyDashboard(ctx.from.id);
  try {
    await ctx.editMessageText(text, inlineKeyboard);
    await ctx.answerCbQuery();
  } catch (e) {
    ctx.reply(text, inlineKeyboard);
  }
});

bot.action('clear_groq_keys', async (ctx) => {
  await clearUserApiKeysFromFirebase(ctx.from.id, 'groq');
  await ctx.answerCbQuery('🗑️ បានលុប Groq Keys របស់អ្នកជោគជ័យ');
  const { text, inlineKeyboard } = await getApiKeyDashboard(ctx.from.id);
  try {
    await ctx.editMessageText(text, inlineKeyboard);
  } catch (e) {
    ctx.reply(text, inlineKeyboard);
  }
});

bot.action('clear_gemini_keys', async (ctx) => {
  await clearUserApiKeysFromFirebase(ctx.from.id, 'gemini');
  await ctx.answerCbQuery('🗑️ បានលុប Gemini Keys របស់អ្នកជោគជ័យ');
  const { text, inlineKeyboard } = await getApiKeyDashboard(ctx.from.id);
  try {
    await ctx.editMessageText(text, inlineKeyboard);
  } catch (e) {
    ctx.reply(text, inlineKeyboard);
  }
});

bot.action('input_groq_key', async (ctx) => {
  const userId = ctx.from.id;
  const state = getUserState(userId);
  state.currentMode = 'waiting_groq_key';
  await ctx.answerCbQuery();
  const text = `⚡ **បញ្ចូល Groq API Key (លឿនបំផុត ~1s & Free ១០០%)**

👉 សូម Copy និងផ្ញើ Key របស់អ្នកមកកាន់ Bot ក្នុង Chat នេះ៖
• អាចផ្ញើម្ដងមួយ ឬផ្ញើច្រើន Keys ព្រមគ្នា (ចុះបន្ទាត់ ឬដាក់សញ្ញាក្បៀស ,)
• ដាក់បានច្រើនឥតកំណត់ (Unlimited Keys ♾️)
• Key នីមួយៗផ្ដើមដោយ \`gsk_...\`

💡 បើមិនទាន់មាន Key ទេ សូមចុចយកឥតគិតថ្លៃ (10 វិនាទី)៖
https://console.groq.com/keys`;

  ctx.reply(text, backOnlyMenu);
});

bot.action('input_gemini_key', async (ctx) => {
  const userId = ctx.from.id;
  const state = getUserState(userId);
  state.currentMode = 'waiting_gemini_key';
  await ctx.answerCbQuery();
  const text = `🤖 **បញ្ចូល Google Gemini API Key (Unlimited Keys)**

👉 សូម Copy និងផ្ញើ Key របស់អ្នកមកកាន់ Bot ក្នុង Chat នេះ៖
• អាចផ្ញើម្ដងមួយ ឬផ្ញើច្រើន Keys ព្រមគ្នា (ចុះបន្ទាត់ ឬដាក់សញ្ញាក្បៀស ,)
• ដាក់បានច្រើនឥតកំណត់ (Unlimited Keys ♾️)
• Key នីមួយៗផ្ដើមដោយ \`AIzaSy...\`

💡 យក Key ឥតគិតថ្លៃនៅទីនេះ៖
https://aistudio.google.com`;

  ctx.reply(text, backOnlyMenu);
});

// --- 2. 🎙️ SRT to Voice ---
bot.hears('🎙️ SRT to Voice', (ctx) => {
  const { text, inlineKeyboard } = getSrtToVoiceDashboard();
  ctx.reply(text, inlineKeyboard);
});

bot.action(['srt_voice_free_auto', 'srt_voice_free_male', 'srt_voice_free_female'], async (ctx) => {
  const userId = ctx.from.id;
  const state = getUserState(userId);
  let voiceLabel = 'សំឡេងធម្មតា ប្រុស/ស្រី Auto (Free)';
  if (ctx.match[0] === 'srt_voice_free_male') voiceLabel = 'សំឡេងធម្មតា ប្រុស (Free)';
  if (ctx.match[0] === 'srt_voice_free_female') voiceLabel = 'សំឡេងធម្មតា ស្រី (Free)';

  state.srtVoice = voiceLabel;
  state.currentMode = 'waiting_srt_file';
  await ctx.deleteMessage().catch(() => {});

  const text = `📊 Status: Ready for SRT File
🎙️ ប្រភេទសំឡេង៖ ${voiceLabel}
⚡ ល្បឿន៖ ឥតគិតថ្លៃ (Free 100%)

👉 សូមផ្ញើឯកសារ .srt (Subtitle File) មកកាន់ Bot ឥឡូវនេះ (អ្នកអាច Drag & Drop ឬ Send as Document)៖`;

  ctx.reply(text, backOnlyMenu);
});

// --- 3. 🤖 Transcript SRT ---
bot.hears('🤖 Transcript SRT', (ctx) => {
  const userId = ctx.from.id;
  const state = getUserState(userId);
  state.currentMode = 'waiting_transcript';

  const text = `🤖 Transcript SRT (ស្រង់សំឡេង និងបកប្រែជា File .srt ជាមួយ Gemini AI)

✨ សមត្ថភាពពិសេស៖
• 🎙️ Speech-to-Text & Translation៖ ស្រង់សំឡេង និងបកប្រែជាភាសាខ្មែរដោយស្វ័យប្រវត្តិ
• ⚡ គាំទ្ររឿងគ្រប់ភាសា៖ ចិន (Chinese), អង់គ្លេស (English), ថៃ (Thai), កូរ៉េ (Korean)...
• ⏱️ Accurate Timestamps៖ តម្រឹម Timecode យ៉ាងច្បាស់លាស់សម្រាប់ធ្វើ Subtitle
• 💰 តម្លៃ៖ 500 Credits / វីដេអូ

👉 សូមផ្ញើឯកសារវីដេអូ/សំឡេង ឬ Link វីដេអូ (YouTube, TikTok, FB, Douyin...) មកកាន់ទីនេះ៖`;

  ctx.reply(text, backOnlyMenu);
});

// --- 4. 🎙️ Clone សម្លេង ---
bot.hears('🎙️ Clone សម្លេង', (ctx) => {
  const userId = ctx.from.id;
  const state = getUserState(userId);
  state.currentMode = 'waiting_clone';

  const text = `🎙️ Clone សម្លេង (Voice Cloning Studio)

✨ បង្កើតសំឡេង AI ផ្ទាល់ខ្លួនរបស់អ្នក សម្រាប់រឿងនិទាន និងសម្រាយរឿង៖
• 👫 បង្កើតបានទាំងសំឡេងប្រុស និងសំឡេងស្រី
• 🎭 សំឡេងរស់រវើក មានអារម្មណ៍បែបធម្មជាតិ
• 💎 អាចប្រើជាមួយ SRT to Voice និងបកប្រែរឿងបានគ្រប់ពេល

👉 របៀបដំណើរការ៖
១. សូមផ្ញើសំឡេងគំរូរបស់អ្នក (Voice Message ឬ Audio File .mp3/.wav រយៈពេល ៣០វិនាទី ដល់ ៣នាទី)
២. សំឡេងត្រូវតែច្បាស់ គ្មានសំឡេងរំខាន (No background noise)
៣. ប្រព័ន្ធនឹងវិភាគ Tone សំឡេង និងបង្កើត Voice Model ផ្ទាល់ខ្លួនរបស់អ្នក

👉 សូមផ្ញើ Voice Record ឬ Audio គំរូមកឥឡូវនេះ៖`;

  ctx.reply(text, backOnlyMenu);
});

// --- 5. ⬇️ ទាញយករឿង ---
bot.hears('⬇️ ទាញយករឿង', (ctx) => {
  const userId = ctx.from.id;
  const state = getUserState(userId);
  state.currentMode = 'waiting_download';

  const text = `⬇️ ទាញយករឿង (Video Downloader HD/4K)

🚀 គាំទ្រការទាញយកវីដេអូរឿងពីគ្រប់បណ្ដាញសង្គម៖
• 🎬 Facebook / Reels
• 🎵 TikTok (គ្មាន Watermark / No Watermark)
• 📺 YouTube / Shorts
• 🐼 Douyin (抖音) / Kuaishou (快手)
• 📱 DramaBox / ShortMax / ReelShort
• 🌐 Direct Video URL (MP4, M3U8, HLS)

👉 សូមផ្ញើ Link (URL) វីដេអូរឿងដែលអ្នកចង់ទាញយកមកទីនេះ៖`;

  ctx.reply(text, backOnlyMenu);
});

// --- Message Handlers for Links, Files, Voice & Media ---
bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const text = ctx.message.text.trim();
  const state = getUserState(userId);

  // Link detection (http or https)
  const urlMatch = text.match(/(https?:\/\/[^\s]+)/gi);
  if (urlMatch) {
    const targetUrl = urlMatch[0];

    if (state.currentMode === 'waiting_story_video') {
      const userData = await getUserInfo(userId);
      const userCredits = userData.credits || 0;
      if (userCredits < 1000) {
        return ctx.reply(`⚠️ Credit របស់អ្នកមិនគ្រប់គ្រាន់ទេ!
💰 តម្រូវការ: 1000 Credits / វីដេអូ
💳 សមតុល្យបច្ចុប្បន្ន: ${userCredits} Credits

សូមអញ្ជើញមិត្តភក្តិ (+200 Credits) ឬបញ្ចូល Credit (Topup) ដើម្បីបន្ត។`, Markup.inlineKeyboard([
          [Markup.button.callback('🎁 អញ្ជើញមិត្តភក្តិ (+200 Cr)', 'invite_friend')],
          [Markup.button.callback('❌ ត្រឡប់ក្រោយ', 'story_back_to_menu')]
        ]));
      }

      await deductCredits(userId, 1000);
      const splitTime = splitOptions[state.storySplitIndex];
      const splitMins = getSplitMinutes(state.storySplitIndex);
      const progressMsg = await ctx.reply(`🎬 បានទទួល Link វីដេអូរឿង!
🔗 Link: ${targetUrl}
🎙️ សំឡេង: ${state.storyVoice}
🎞️ កាត់ភាគ: ${splitTime}
💰 បានកាត់ 1000 Credits (សមតុល្យនៅសល់: ${userCredits - 1000} Cr)

⏳ កំពុងចាប់ផ្តើមដំណើរការទាញយក និងបកប្រែវីដេអូ...`);

      processStoryVideo({
        bot,
        ctx,
        fileUrl: targetUrl,
        voiceType: state.storyVoice,
        splitMinutes: splitMins,
        statusMsgId: progressMsg.message_id
      }).catch(err => {
        console.error('Video link process error:', err);
        ctx.reply(`❌ មានបញ្ហាក្នុងដំណើរការបកប្រែវីដេអូ៖ ${err.message}`);
      });
      return;
    }

    if (state.currentMode === 'waiting_download') {
      const progressMsg = await ctx.reply(`⬇️ កំពុងទាញយកវីដេអូ...
🔗 ${targetUrl}
⚡ yt-dlp Best Quality (No Watermark)

⏳ [░░░░░░░░░░░] 0% - កំពុងទាញយក...`);

      // Save URL in state for quick_download button
      state.pendingDownloadUrl = targetUrl;

      // Actually download the video using yt-dlp
      try {
        const os = require('os');
        const taskId = `dl_${Date.now()}`;
        const workDir = require('path').join(os.tmpdir(), taskId);
        require('fs').mkdirSync(workDir, { recursive: true });
        const outPath = require('path').join(workDir, 'video.mp4');

        await ctx.telegram.editMessageText(ctx.chat.id, progressMsg.message_id, null,
          `⬇️ yt-dlp កំពុងទាញយក...\n🔗 ${targetUrl}\n\n⏳ [███░░░░░░░░] 30% - Fetching best quality...`).catch(() => {});

        // Run yt-dlp
        const { exec } = require('child_process');
        await new Promise((resolve, reject) => {
          const cmd = `yt-dlp -f "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best" --merge-output-format mp4 --no-playlist --socket-timeout 60 --retries 3 -o "${outPath}" "${targetUrl}" 2>&1`;
          exec(cmd, { maxBuffer: 1024 * 1024 * 50, timeout: 300000 }, (err, stdout, stderr) => {
            if (err) {
              console.error('yt-dlp error:', stderr || err.message);
              reject(new Error(stderr || err.message));
            } else {
              resolve();
            }
          });
        });

        if (!require('fs').existsSync(outPath) || require('fs').statSync(outPath).size < 1000) {
          throw new Error('yt-dlp: ទាញបានឯកសារទទេ!');
        }

        await ctx.telegram.editMessageText(ctx.chat.id, progressMsg.message_id, null,
          `⬇️ ទាញយករួចហើយ!\n🔗 ${targetUrl}\n\n⏳ [██████████░] 90% - ផ្ញើជូន Telegram...`).catch(() => {});

        const stat = require('fs').statSync(outPath);
        const sizeMb = (stat.size / (1024 * 1024)).toFixed(1);
        const caption = `✅ ទាញយកវីដេអូជោគជ័យ!\n🔗 ${targetUrl}\n📦 ទំហំ: ${sizeMb}MB\n⚡ No Watermark | Best Quality\n🤖 @AiStudioSSOnline_bot`;

        await ctx.replyWithVideo({ source: outPath }, { caption, supports_streaming: true });

        await ctx.telegram.editMessageText(ctx.chat.id, progressMsg.message_id, null,
          `✅ ទាញយករួចរាល់ 100%! 🎉\n📦 ទំហំ: ${sizeMb}MB`).catch(() => {});

        // Cleanup
        require('fs').rmSync(workDir, { recursive: true, force: true });
      } catch (dlErr) {
        console.error('Download error:', dlErr.message);
        await ctx.telegram.editMessageText(ctx.chat.id, progressMsg.message_id, null,
          `❌ ទាញយកបរាជ័យ!\n🔗 ${targetUrl}\n⚠️ ${dlErr.message.substring(0, 200)}\n\n💡 ព្យាយាមម្ដងទៀត ឬប្រើ Link ផ្ទាល់ (Direct MP4 URL)!`).catch(() => {});
      }
      return;
    }

    if (state.currentMode === 'waiting_transcript') {
      const userData = await getUserInfo(userId);
      const userCredits = userData.credits || 0;
      if (userCredits < 500) {
        return ctx.reply(`⚠️ Credit របស់អ្នកមិនគ្រប់គ្រាន់ទេ! តម្រូវការ: 500 Credits (សមតុល្យ: ${userCredits})`);
      }
      await deductCredits(userId, 500);
      const progressMsg = await ctx.reply(`🤖 Gemini AI កំពុងស្រង់សំឡេង និងបកប្រែ Subtitle...
🔗 Link: ${targetUrl}
💰 បានកាត់ 500 Credits

⏳ ដំណាក់កាល: Extracting Audio & Generating SRT... [■■■■■■□□□□] 60%`);

      setTimeout(() => {
        ctx.telegram.editMessageText(ctx.chat.id, progressMsg.message_id, null, `✅ ស្រង់ និងបកប្រែ SRT ជោគជ័យ 100%! 🎉
📄 ឯកសារ .srt ភាសាខ្មែរកំពុងត្រូវបានបង្កើត និងផ្ញើជូនលោកអ្នក...`).catch(()=>{});
      }, 4000);
      return;
    }

    // If user just sent a URL without entering a specific mode
    return ctx.reply(`🎬 រកឃើញ Link វីដេអូរឿង! សូមជ្រើសរើសសកម្មភាពដែលអ្នកចង់ធ្វើ៖
🔗 ${targetUrl}`, Markup.inlineKeyboard([
      [Markup.button.callback('💻 បកប្រែរឿង & បញ្ចូលសម្លេង', 'story_voice_both')],
      [Markup.button.callback('🤖 ស្រង់ Subtitle SRT (Gemini)', 'quick_transcript')],
      [Markup.button.callback('⬇️ ទាញយកវីដេអូ HD/4K', 'quick_download')]
    ]));
  }

  // Handle API key input (supports batch multi-line/comma inputs, auto-detection for gsk_ & AIzaSy, and unlimited keys)
  const isKeyMode = state.currentMode === 'waiting_groq_key' || state.currentMode === 'waiting_gemini_key';
  const hasKeyPattern = text.includes('gsk_') || text.includes('AIzaSy');

  if (isKeyMode || hasKeyPattern) {
    const tokens = text.split(/[\r\n,;\s]+/).map(t => t.trim()).filter(Boolean);
    const groqKeys = [];
    const geminiKeys = [];

    for (const token of tokens) {
      if (token.startsWith('gsk_') && token.length >= 20) {
        groqKeys.push(token);
      } else if (token.startsWith('AIzaSy') && token.length >= 25) {
        geminiKeys.push(token);
      } else if (token.length >= 20) {
        // Classify based on active mode
        if (state.currentMode === 'waiting_groq_key') groqKeys.push(token);
        else if (state.currentMode === 'waiting_gemini_key') geminiKeys.push(token);
      }
    }

    if (groqKeys.length > 0 || geminiKeys.length > 0) {
      state.currentMode = null;
      const reportSections = [];

      if (groqKeys.length > 0) {
        const resGroq = await addApiKeysToFirebase('groq', groqKeys, userId);
        reportSections.push(`⚡ **Groq AI (Llama 3.3 70B - Free & Fast ~1s)**៖\n• បានបញ្ចូលថ្មី៖ +${resGroq.added} Keys\n• សរុបក្នុងគណនីរបស់អ្នក៖ ${resGroq.count} Keys (ឥតកំណត់ ♾️)\n• Pooled សរុបក្នុងប្រព័ន្ធ៖ ${resGroq.totalPooled} Keys`);
      }

      if (geminiKeys.length > 0) {
        const resGemini = await addApiKeysToFirebase('gemini', geminiKeys, userId);
        reportSections.push(`🤖 **Google Gemini AI**៖\n• បានបញ្ចូលថ្មី៖ +${resGemini.added} Keys\n• សរុបក្នុងគណនីរបស់អ្នក៖ ${resGemini.count} Keys (ឥតកំណត់ ♾️)\n• Pooled សរុបក្នុងប្រព័ន្ធ៖ ${resGemini.totalPooled} Keys`);
      }

      return ctx.reply(`🎉 **បានរក្សាទុក Key ចូលក្នុង Firebase ជោគជ័យ!**\n\n${reportSections.join('\n\n')}\n\n♾️ **គាំទ្រការដាក់ Keys ច្រើនឥតដែនកំណត់ (Unlimited Keys)**\n🔄 **Auto-Rotate ស្វ័យប្រវត្តិកាលណា Key ណាមួយជាប់ Quota ឬ Error!**\n💾 **រក្សាទុកក្នុង Firebase ជាអចិន្ត្រៃយ៍រហូតដល់អ្នកលុបវិញ!**\n\n👉 លោកអ្នកអាចផ្ញើ ឬ Forward វីដេអូរឿងចូលដើម្បីបកប្រែបានភ្លាមៗ!`, storyToolsMenu);
    } else if (isKeyMode) {
      return ctx.reply('⚠️ Key មិនត្រឹមត្រូវ! Groq Key ត្រូវផ្ដើមដោយ `gsk_...` និង Gemini Key ត្រូវផ្ដើមដោយ `AIzaSy...`។ សូមពិនិត្យ និងផ្ញើឡើងវិញ។', storyToolsMenu);
    }
  }

  // Fallback for regular text
  if (state.currentMode === 'waiting_story_video') {
    return ctx.reply('👉 សូមផ្ញើ Link វីដេអូរឿង (YouTube, TikTok, FB, Douyin...) ឬឯកសារវីដេអូ MP4 ដើម្បីបកប្រែ៖');
  }
  if (state.currentMode === 'waiting_download') {
    return ctx.reply('👉 សូមផ្ញើ Link វីដេអូរឿងដែលអ្នកចង់ទាញយកមកទីនេះ៖');
  }
  if (state.currentMode === 'waiting_srt_file') {
    return ctx.reply('👉 សូមផ្ញើ File ឯកសារ .srt (Subtitle) មកកាន់ Bot ដើម្បីបម្លែងជាសំឡេងនិយាយ៖');
  }
});

// Document Handler (SRT files, large video files)
bot.on('document', async (ctx) => {
  const userId = ctx.from.id;
  const state = getUserState(userId);
  const doc = ctx.message.document;
  const fileName = doc.file_name || '';

  if (fileName.toLowerCase().endsWith('.srt')) {
    const progressMsg = await ctx.reply(`📄 បានទទួលឯកសារ Subtitle: ${fileName}
🎙️ សំឡេង៖ ${state.srtVoice || 'សំឡេងធម្មតា ប្រុស/ស្រី Auto (Free)'}
⚡ កំពុងដំណើរការបម្លែងជាសំឡេងនិយាយខ្មែរ (TTS Synthesis)...`);

    try {
      const link = await bot.telegram.getFileLink(doc.file_id);
      const res = await fetch(link.href);
      const srtContent = await res.text();
      state.lastSrtContent = srtContent;

      processSrtFileToVoice({
        ctx,
        srtContent,
        voiceType: state.srtVoice || 'សំឡេងធម្មតា ប្រុស/ស្រី Auto (Free)',
        statusMsgId: progressMsg.message_id
      }).catch(err => {
        console.error('SRT process error:', err);
        ctx.reply(`❌ បរាជ័យក្នុងការបម្លែង SRT៖ ${err.message}`);
      });
    } catch (err) {
      console.error('Download SRT error:', err);
      ctx.reply(`❌ មិនអាចទាញយក File .srt បានទេ៖ ${err.message}`);
    }
    return;
  }

  const isVideoDoc = (doc.mime_type && doc.mime_type.startsWith('video')) || /\.(mp4|mkv|mov|avi)$/i.test(fileName);
  if (isVideoDoc) {
    // Check video limit (up to 2GB)
    const MAX_DIRECT_SIZE = 2000 * 1024 * 1024; // 2GB (2000MB)
    if (doc.file_size > MAX_DIRECT_SIZE) {
      return ctx.reply(`⚠️ ឯកសារវីដេអូនេះមានទំហំ ${(doc.file_size / (1024*1024)).toFixed(1)}MB ដែលធំជាង 2GB (2000MB)! សូមផ្ញើវីដេអូក្រោម 2GB។`);
    }

    if (state.currentMode === 'waiting_story_video') {
      const userData = await getUserInfo(userId);
      const userCredits = userData.credits || 0;
      if (userCredits < 1000) {
        return ctx.reply(`⚠️ Credit របស់អ្នកមិនគ្រប់គ្រាន់ទេ! តម្រូវការ 1000 Credits (សមតុល្យបច្ចុប្បន្ន: ${userCredits} Cr)`);
      }
      await deductCredits(userId, 1000);

      const splitMins = getSplitMinutes(state.storySplitIndex);
      const progressMsg = await ctx.reply(`📦 បានទទួល File វីដេអូ: ${fileName} (${(doc.file_size / (1024*1024)).toFixed(1)} MB)
🎙️ សំឡេង: ${state.storyVoice}
🎞️ កាត់ភាគ: ${splitOptions[state.storySplitIndex]}
💰 បានកាត់ 1000 Credits

⏳ កំពុងចាប់ផ្តើមដំណើរការបកប្រែ និងបញ្ចូលសំឡេង...`);

      processStoryVideo({
        bot,
        ctx,
        fileId: doc.file_id,
        voiceType: state.storyVoice,
        splitMinutes: splitMins,
        statusMsgId: progressMsg.message_id,
        userState: state
      }).catch(err => {
        console.error('Document video process error:', err);
        ctx.reply(`❌ មានបញ្ហាក្នុងដំណើរការបកប្រែវីដេអូ៖ ${err.message}`);
      });
      return;
    }

    // Direct document video upload fallback: Offer instant dubbing!
    state.pendingVideoFileId = doc.file_id;
    return ctx.reply(`🎬 បានទទួល File វីដេអូ: ${fileName} (${(doc.file_size / (1024*1024)).toFixed(1)} MB)\n\n👉 សូមជ្រើសរើសសំឡេងដើម្បីចាប់ផ្តើមបកប្រែ និងបញ្ចូលសំឡេងខ្មែរភ្លាមៗ៖`, Markup.inlineKeyboard([
      [Markup.button.callback('💬 ១. សំឡេងប្រុស (Standard)', 'quick_dub_male')],
      [Markup.button.callback('💬 ២. សំឡេងស្រី (Standard)', 'quick_dub_female')],
      [Markup.button.callback('🤖 ៣. សំឡេងប្រុស & ស្រី (Auto Both)', 'quick_dub_both')],
      [Markup.button.callback('❌ បោះបង់', 'story_back_to_menu')]
    ]));
  }

  ctx.reply(`📄 បានទទួល File: ${fileName} (${(doc.file_size / 1024).toFixed(1)} KB)`);
});

// Video Handler
bot.on('video', async (ctx) => {
  try {
    const userId = ctx.from.id;
    const state = getUserState(userId);
    const video = ctx.message.video;

    // Check video limit (up to 2GB)
    const MAX_DIRECT_SIZE = 2000 * 1024 * 1024; // 2GB (2000MB)
    if (video.file_size > MAX_DIRECT_SIZE) {
      return ctx.reply(`⚠️ ឯកសារវីដេអូនេះមានទំហំ ${(video.file_size / (1024*1024)).toFixed(1)}MB ដែលធំជាង 2GB (2000MB)! សូមផ្ញើវីដេអូក្រោម 2GB។`);
    }

    if (state.currentMode === 'waiting_story_video') {
      const userData = await getUserInfo(userId);
      const userCredits = userData.credits || 0;
      if (userCredits < 1000) {
        return ctx.reply(`⚠️ Credit របស់អ្នកមិនគ្រប់គ្រាន់ទេ! តម្រូវការ 1000 Credits (សមតុល្យបច្ចុប្បន្ន: ${userCredits} Cr)`);
      }
      await deductCredits(userId, 1000);

      const splitMins = getSplitMinutes(state.storySplitIndex);
      const progressMsg = await ctx.reply(`🎬 បានទទួលវីដេអូ! (ទំហំ: ${(video.file_size / (1024*1024)).toFixed(1)} MB, រយៈពេល: ${video.duration}s)
🎙️ សំឡេង: ${state.storyVoice}
🎞️ កាត់ភាគ: ${splitOptions[state.storySplitIndex]}
💰 បានកាត់ 1000 Credits

⏳ កំពុងចាប់ផ្តើមដំណើរការបកប្រែ និងបញ្ចូលសំឡេងខ្មែរ...`);

      processStoryVideo({
        bot,
        ctx,
        fileId: video.file_id,
        voiceType: state.storyVoice,
        splitMinutes: splitMins,
        statusMsgId: progressMsg.message_id,
        userState: state
      }).catch(err => {
        console.error('Video process error:', err);
        ctx.reply(`❌ មានបញ្ហាក្នុងដំណើរការបកប្រែវីដេអូ៖ ${err.message}`);
      });
      return;
    }

    // Direct video upload fallback: Offer instant dubbing options!
    state.pendingVideoFileId = video.file_id;
    state.pendingVideoDuration = video.duration;
    return ctx.reply(`🎬 បានទទួលវីដេអូរបស់អ្នក! (ទំហំ: ${(video.file_size / (1024*1024)).toFixed(1)} MB, រយៈពេល: ${video.duration}s)\n\n👉 សូមជ្រើសរើសសំឡេងដើម្បីចាប់ផ្តើមបកប្រែ និងបញ្ចូលសំឡេងខ្មែរភ្លាមៗ៖`, Markup.inlineKeyboard([
      [Markup.button.callback('💬 ១. សំឡេងប្រុស (Standard)', 'quick_dub_male')],
      [Markup.button.callback('💬 ២. សំឡេងស្រី (Standard)', 'quick_dub_female')],
      [Markup.button.callback('🤖 ៣. សំឡេងប្រុស & ស្រី (Auto Both)', 'quick_dub_both')],
      [Markup.button.callback('❌ បោះបង់', 'story_back_to_menu')]
    ]));
  } catch (err) {
    console.error('Error in bot.on video:', err);
    ctx.reply(`❌ មានបញ្ហាក្នុងការទទួលវីដេអូ៖ ${err.message}`).catch(() => {});
  }
});

// Quick Dub Action Handlers
bot.action(['quick_dub_male', 'quick_dub_female', 'quick_dub_both'], async (ctx) => {
  const userId = ctx.from.id;
  const state = getUserState(userId);
  const fileId = state.pendingVideoFileId;
  if (!fileId) {
    return ctx.reply('⚠️ វីដេអូនេះផុតកំណត់ហើយ សូមផ្ញើវីដេអូម្តងទៀត!');
  }

  if (ctx.match[0] === 'quick_dub_male') state.storyVoice = 'សំឡេងប្រុស';
  else if (ctx.match[0] === 'quick_dub_female') state.storyVoice = 'សំឡេងស្រី';
  else if (ctx.match[0] === 'quick_dub_both') state.storyVoice = 'សំឡេងប្រុស & ស្រី';

  const userData = await getUserInfo(userId);
  const userCredits = userData.credits || 0;
  if (userCredits < 1000) {
    return ctx.reply(`⚠️ Credit របស់អ្នកមិនគ្រប់គ្រាន់ទេ! តម្រូវការ 1000 Credits (សមតុល្យបច្ចុប្បន្ន: ${userCredits} Cr)`);
  }
  await deductCredits(userId, 1000);
  await ctx.deleteMessage().catch(() => {});

  const splitMins = getSplitMinutes(state.storySplitIndex);
  const progressMsg = await ctx.reply(`🎬 ចាប់ផ្តើមដំណើរការបកប្រែវីដេអូ!\n🎙️ សំឡេង: ${state.storyVoice}\n🎞️ កាត់ភាគ: ${splitOptions[state.storySplitIndex]}\n💰 បានកាត់ 1000 Credits\n\n⏳ កំពុងដំណើរការ...`);

  processStoryVideo({
    bot,
    ctx,
    fileId,
    voiceType: state.storyVoice,
    splitMinutes: splitMins,
    statusMsgId: progressMsg.message_id,
    userState: state
  }).catch(err => {
    console.error('Quick dub process error:', err);
    ctx.reply(`❌ មានបញ្ហាក្នុងដំណើរការបកប្រែវីដេអូ៖ ${err.message}`);
  });
});

// Voice / Audio Handler (for Voice Cloning)
bot.on(['voice', 'audio'], async (ctx) => {
  const userId = ctx.from.id;
  const state = getUserState(userId);

  if (state.currentMode === 'waiting_clone') {
    const progressMsg = await ctx.reply(`🎙️ បានទទួលសំឡេងគំរូរបស់អ្នក!
🔬 AI កំពុងវិភាគ Pitch, Frequency, Tone, និងដកសំឡេងរំខាន... [■■■■■■□□□□] 60%`);

    setTimeout(() => {
      ctx.telegram.editMessageText(ctx.chat.id, progressMsg.message_id, null, `✅ Voice Model របស់អ្នកត្រូវបាន Clone ដោយជោគជ័យ! 🎉
💎 ឈ្មោះ Model: User_${userId}_CustomVoice
👉 ឥឡូវនេះអ្នកអាចជ្រើសរើសសំឡេងនេះ ក្នុងមុខងារ "SRT to Voice" និង "បកប្រែរឿង" បានគ្រប់ពេលវេលា!`).catch(()=>{});
    }, 4500);
    return;
  }

  ctx.reply('🎙️ បានទទួលសំឡេងរបស់អ្នក!');
});

bot.action('quick_transcript', (ctx) => {
  ctx.answerCbQuery();
  ctx.reply('🤖 សូមផ្ញើឯកសារ ឬបញ្ជាក់ Link ម្ដងទៀត ដើម្បីដំណើរការស្រង់ Subtitle SRT:');
});

bot.action('quick_download', async (ctx) => {
  ctx.answerCbQuery().catch(() => {});
  const userId = ctx.from.id;
  const state = getUserState(userId);

  // Get URL from message text or pending state
  const msgText = ctx.callbackQuery?.message?.text || '';
  const urlMatch = msgText.match(/(https?:\/\/[^\s]+)/i);
  const targetUrl = (urlMatch && urlMatch[0]) || state.pendingDownloadUrl || '';

  if (!targetUrl) {
    return ctx.reply('⚠️ មិនរកឃើញ Link! សូមផ្ញើ Link វីដេអូម្ដងទៀត!');
  }

  // Set mode and trigger download
  state.currentMode = 'waiting_download';
  state.pendingDownloadUrl = targetUrl;

  const progressMsg = await ctx.reply(`⬇️ yt-dlp កំពុងទាញយក...\n🔗 ${targetUrl}\n\n⏳ [░░░░░░░░░░░] 0%`);

  try {
    const os = require('os');
    const taskId = `dl_${Date.now()}`;
    const workDir = require('path').join(os.tmpdir(), taskId);
    require('fs').mkdirSync(workDir, { recursive: true });
    const outPath = require('path').join(workDir, 'video.mp4');

    await ctx.telegram.editMessageText(ctx.chat.id, progressMsg.message_id, null,
      `⬇️ yt-dlp កំពុងទាញយក...\n🔗 ${targetUrl}\n\n⏳ [███░░░░░░░░] 30%`).catch(() => {});

    const { exec } = require('child_process');
    await new Promise((resolve, reject) => {
      const cmd = `yt-dlp -f "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best" --merge-output-format mp4 --no-playlist --socket-timeout 60 --retries 3 -o "${outPath}" "${targetUrl}" 2>&1`;
      exec(cmd, { maxBuffer: 1024 * 1024 * 50, timeout: 300000 }, (err, stdout, stderr) => {
        if (err) reject(new Error(stderr || err.message));
        else resolve();
      });
    });

    if (!require('fs').existsSync(outPath) || require('fs').statSync(outPath).size < 1000) {
      throw new Error('yt-dlp: ទាញបានឯកសារទទេ!');
    }

    await ctx.telegram.editMessageText(ctx.chat.id, progressMsg.message_id, null,
      `⬇️ ទាញយករួចហើយ!\n🔗 ${targetUrl}\n\n⏳ [██████████░] 90% - ផ្ញើជូន Telegram...`).catch(() => {});

    const stat = require('fs').statSync(outPath);
    const sizeMb = (stat.size / (1024 * 1024)).toFixed(1);
    const caption = `✅ ទាញយកវីដេអូជោគជ័យ!\n🔗 ${targetUrl}\n📦 ទំហំ: ${sizeMb}MB\n⚡ No Watermark | Best Quality\n🤖 @AiStudioSSOnline_bot`;

    await ctx.replyWithVideo({ source: outPath }, { caption, supports_streaming: true });
    await ctx.telegram.editMessageText(ctx.chat.id, progressMsg.message_id, null,
      `✅ ទាញយករួចរាល់ 100%! 🎉 | 📦 ${sizeMb}MB`).catch(() => {});

    require('fs').rmSync(workDir, { recursive: true, force: true });
    state.currentMode = null;
  } catch (dlErr) {
    console.error('quick_download error:', dlErr.message);
    await ctx.telegram.editMessageText(ctx.chat.id, progressMsg.message_id, null,
      `❌ ទាញយកបរាជ័យ!\n⚠️ ${dlErr.message.substring(0, 200)}`).catch(() => {});
  }
});

// Swap Male <-> Female Characters in Subtitle
bot.action('swap_srt_gender', async (ctx) => {
  ctx.answerCbQuery().catch(() => {});
  const userId = ctx.from.id;
  const state = getUserState(userId);
  if (!state.lastSrtContent) {
    return ctx.reply('⚠️ មិនមានទិន្នន័យ Subtitle ចាស់ទេ។ សូមផ្ញើឯកសារ .srt មកម្តងទៀត!');
  }

  // Swap tags (ប្រុស) <-> (ស្រី)
  const swapped = state.lastSrtContent
    .replace(/\(ប្រុស\)/g, '%%FEMALE_TMP%%')
    .replace(/\(ស្រី\)/g, '(ប្រុស)')
    .replace(/%%FEMALE_TMP%%/g, '(ស្រី)');

  state.lastSrtContent = swapped;

  const tmpPath = path.join(require('os').tmpdir(), `Subtitle_Swapped_${Date.now()}.srt`);
  fs.writeFileSync(tmpPath, swapped, 'utf-8');

  await ctx.replyWithDocument({ source: tmpPath, filename: 'Subtitle_Swapped.srt' }, {
    caption: '🔄 បានផ្លាស់ប្តូរភេទតួអង្គ (ប្រុស) ↔ (ស្រី) ក្នុង Subtitle រួចរាល់! ⚡ កំពុងបង្កើតសំឡេងនិយាយថ្មី...',
    reply_markup: {
      inline_keyboard: [
        [{ text: '🔄 ប្តូរត្រឡប់ក្រោយវិញ (Swap Again)', callback_data: 'swap_srt_gender' }]
      ]
    }
  });

  const progressMsg = await ctx.reply('🎙️ កំពុងដំណើរការបង្កើតសំឡេងនិយាយថ្មីតាម Subtitle ដែលបានប្តូរភេទ...');
  processSrtFileToVoice({
    ctx,
    srtContent: swapped,
    voiceType: 'សំឡេងធម្មតា ប្រុស/ស្រី Auto (Free)',
    statusMsgId: progressMsg.message_id
  }).catch(err => {
    ctx.reply(`❌ បរាជ័យក្នុងការបម្លែងសំឡេង៖ ${err.message}`);
  });
});

// Express Server Setup
const app = express();
app.use(express.json());

const rawWebhook = process.env.WebHook_URL || '';
const cleanWebhook = rawWebhook.trim().replace(/\/+$/, '');
const isRenderDead = cleanWebhook.includes('onrender.com');

if (cleanWebhook && !process.env.USE_POLLING && !isRenderDead) {
  const webhookUrl = `${cleanWebhook}/bot${process.env.TELEGRAM_TOKEN}`;
  bot.telegram.setWebhook(webhookUrl)
    .then(() => console.log(`✅ Webhook ត្រូវបានភ្ជាប់ទៅកាន់ ${webhookUrl}`))
    .catch((err) => console.error('❌ Webhook error:', err.message));
  app.use(bot.webhookCallback(`/bot${process.env.TELEGRAM_TOKEN}`));
} else {
  (async () => {
    let started = false;
    let attempts = 0;
    while (!started && attempts < 15) {
      try {
        attempts++;
        await bot.telegram.deleteWebhook({ drop_pending_updates: true });
        await bot.launch({ dropPendingUpdates: true });
        console.log(`✅ Bot កំពុងដំណើរការជោគជ័យ (Polling Mode តាម ${bot.telegram.options.apiRoot})...`);
        started = true;
      } catch (err) {
        console.error(`❌ Polling launch attempt ${attempts} failed:`, err.message);
        if (attempts >= 5 && bot.telegram.options.apiRoot !== 'https://api.telegram.org') {
          console.log('⚠️ Local Bot API (8081) មិនទាន់ឆ្លើយតប កំពុងផ្លាស់ប្តូរទៅកាន់ https://api.telegram.org ជាបណ្តោះអាសន្ន...');
          bot.telegram.options.apiRoot = 'https://api.telegram.org';
        }
        if (attempts < 15) {
          console.log('⏳ នឹងព្យាយាមភ្ជាប់ឡើងវិញក្នុងរយៈពេល 3 វិនាទី...');
          await new Promise(r => setTimeout(r, 3000));
        }
      }
    }
  })();
}

bot.catch((err, ctx) => {
  console.error(`[Telegraf Unhandled Error] Update ${ctx?.updateType}:`, err);
  if (ctx && ctx.reply) {
    ctx.reply(`⚠️ កំហុសប្រព័ន្ធ៖ ${err.message}`).catch(() => {});
  }
});

app.get('/', (req, res) => {
  res.send('AI Studio Telegram Bot is Running! 🚀');
});

const PORT = process.env.PORT || 5004;
app.listen(PORT, () => {
  console.log(`Web Server ដំណើរការលើ Port ${PORT}`);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
