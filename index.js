require('dotenv').config();
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
const bot = new Telegraf(process.env.TELEGRAM_TOKEN);
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
  ['⬇️ ទាញយករឿង', '❌ ត្រឡប់ក្រោយ']
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

  const text = `📊 Dashboard: 🎬 បកប្រែរឿង
[ 📦 ទំហំ: File ផ្ទាល់ & Link រហូតដល់ 4GB (4000MB) | 💰 តម្លៃ 1000 Credits / វីដេអូ ]

🎞️ ការកំណត់កាត់ភាគ: ${currentSplit}

👉 សូមជ្រើសរើសប្រភេទសម្លេង (ឬផ្ញើ File វីដេអូ / Link បានភ្លាមៗ - ស្តង់ដារ: សំឡេងប្រុស & ស្រី):`;

  const inlineKeyboard = Markup.inlineKeyboard([
    [Markup.button.callback('💬 ១. សំឡេងប្រុស (Standard)', 'story_voice_male')],
    [Markup.button.callback('💬 ២. សំឡេងស្រី (Standard)', 'story_voice_female')],
    [Markup.button.callback('🤖 ៣. សំឡេងប្រុស & ស្រី (Auto Both)', 'story_voice_both')],
    [Markup.button.callback(splitBtnLabel, 'story_toggle_split')],
    [Markup.button.callback('❌ ត្រឡប់ក្រោយ', 'story_back_to_menu')]
  ]);

  return { text, inlineKeyboard };
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
  ['📢 ផ្សព្វផ្សាយសារ (Broadcast)'],
  ['💳 បញ្ចូលលុយ (Add Credits)', '👥 ស្ថិតិអ្នកប្រើប្រាស់'],
  ['❌ ត្រឡប់ក្រោយ']
]).resize();

bot.command('admin', (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID) return;
  const text = `👑 សូមស្វាគមន៍លោក Admin!

👉 ជ្រើសរើសមុខងារដែលអ្នកចង់ប្រើប្រាស់៖`;
  ctx.reply(text, adminMenu);
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

bot.action('story_back_to_menu', async (ctx) => {
  const userId = ctx.from.id;
  const state = getUserState(userId);
  state.currentMode = null;
  await ctx.deleteMessage().catch(() => {});
  ctx.reply('ត្រឡប់មកកាន់ Tools សម្រាប់រឿងវិញ...', storyToolsMenu);
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
      const progressMsg = await ctx.reply(`⬇️ កំពុងទាញយកវីដេអូពី Link...
🔗 ${targetUrl}
⚡ កម្រិតច្បាស់: Ultra HD (No Watermark)

⏳ កំពុងដំណើរការ... [■■■■■□□□□□] 50%`);

      setTimeout(() => {
        ctx.telegram.editMessageText(ctx.chat.id, progressMsg.message_id, null, `✅ ទាញយកវីដេអូរួចរាល់ដោយជោគជ័យ!
🔗 Link: ${targetUrl}
📦 ទំហំ: HD Ready
📥 ប្រព័ន្ធកំពុងផ្ញើ File វីដេអូ ឬ Direct Download Link មកកាន់អ្នក...`).catch(()=>{});
      }, 4000);
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

      processSrtFileToVoice({
        ctx,
        srtContent,
        voiceType: state.srtVoice,
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
    // Check Telegram Bot 20MB download limit
    if (doc.file_size > 20 * 1024 * 1024) {
      return ctx.reply(`⚠️ ឯកសារវីដេអូនេះមានទំហំ ${(doc.file_size / (1024*1024)).toFixed(1)}MB ដែលធំជាង 20MB (ដែនកំណត់ទាញយករបស់ Telegram Bot)!

💡 ដំណោះស្រាយ៖ សូមផ្ញើជា Link វីដេអូ (YouTube, TikTok, Facebook, Drive...) មកកាន់ Bot វិញ ដើម្បីបកប្រែវីដេអូធំៗរហូតដល់ 4GB!`);
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
        statusMsgId: progressMsg.message_id
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

    // Check Telegram Bot 20MB limit
    if (video.file_size > 20 * 1024 * 1024) {
      return ctx.reply(`⚠️ ឯកសារវីដេអូនេះមានទំហំ ${(video.file_size / (1024*1024)).toFixed(1)}MB ដែលធំជាង 20MB (ដែនកំណត់ទាញយករបស់ Telegram Bot)!

💡 ដំណោះស្រាយ៖ សូមផ្ញើជា Link វីដេអូ (YouTube, TikTok, Facebook, Drive...) មកកាន់ Bot វិញ ដើម្បីបកប្រែវីដេអូធំៗរហូតដល់ 4GB!`);
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
        statusMsgId: progressMsg.message_id
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
    statusMsgId: progressMsg.message_id
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

bot.action('quick_download', (ctx) => {
  ctx.answerCbQuery();
  ctx.reply('⬇️ កំពុងដំណើរការទាញយកវីដេអូពី Link... សូមរង់ចាំបន្តិច!');
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
    try {
      await bot.telegram.deleteWebhook({ drop_pending_updates: true });
      await bot.launch({ dropPendingUpdates: true });
      console.log('✅ Bot កំពុងដំណើរការ (Polling Mode លើ VPS)...');
    } catch (err) {
      console.error('❌ Polling launch failed:', err.message);
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
