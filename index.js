require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

// 1. រៀបចំ Firebase
let serviceAccount;
try {
  if (process.env.FIREBASE_CREDENTIALS) {
    serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS);
  }
} catch (error) {
  console.log("បញ្ហាក្នុងការអាន FIREBASE_CREDENTIALS JSON:", error.message);
}

if (serviceAccount) {
  initializeApp({
    credential: cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DB_URL
  });
  console.log("Firebase បានតភ្ជាប់ជោគជ័យ");
} else {
  console.log("មិនទាន់មាន FIREBASE_CREDENTIALS ត្រឹមត្រូវនៅក្នុង .env ទេ");
}

const db = getApps().length > 0 ? getFirestore() : null;
const bot = new Telegraf(process.env.TELEGRAM_TOKEN);

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
  ['❌ ត្រឡប់ក្រោយ']
]).resize();

// Tools សម្រាប់រឿង Keyboard
const storyToolsMenu = Markup.keyboard([
  ['💻 បកប្រែរឿង', '🎙️ SRT to Voice'],
  ['🤖 Transcript SRT', '🎙️ Clone សម្លេង'],
  ['⬇️ ទាញយករឿង', '❌ ត្រឡប់ក្រោយ']
]).resize();

async function saveUser(ctx) {
  if (!db) return;
  try {
    const user = ctx.from;
    const userRef = db.collection('users').doc(user.id.toString());
    const doc = await userRef.get();
    
    let isNewUser = false;
    
    if (!doc.exists) {
      isNewUser = true;
      await userRef.set({
        id: user.id,
        first_name: user.first_name,
        username: user.username || '',
        credits: 1000,
        invites: 0,
        referredBy: null,
        joinedAt: FieldValue.serverTimestamp()
      });
    }
    return isNewUser;
  } catch (error) {
    console.error("Error saving user:", error);
    return false;
  }
}

async function handleReferral(ctx, isNewUser, startPayload) {
  if (!db || !isNewUser || !startPayload) return;
  if (startPayload.startsWith('ref_')) {
    const referrerId = startPayload.split('ref_')[1];
    if (referrerId && referrerId !== ctx.from.id.toString()) {
      try {
        const referrerRef = db.collection('users').doc(referrerId);
        await db.runTransaction(async (t) => {
          const referrerDoc = await t.get(referrerRef);
          if (referrerDoc.exists) {
            const currentCredits = referrerDoc.data().credits || 0;
            const currentInvites = referrerDoc.data().invites || 0;
            t.update(referrerRef, { 
              credits: currentCredits + 200,
              invites: currentInvites + 1 
            });
            // ផ្ញើសារប្រាប់អ្នកដែលបានអញ្ជើញ
            bot.telegram.sendMessage(referrerId, `🎉 អបអរសាទរ! មិត្តភក្តិរបស់អ្នកបានចុះឈ្មោះប្រើប្រាស់ Bot។ អ្នកទទួលបាន +200 Credits 🎁`);
          }
        });
        
        // Update referredBy for new user
        await db.collection('users').doc(ctx.from.id.toString()).update({
          referredBy: referrerId
        });
      } catch (e) {
        console.error("Referral Error:", e);
      }
    }
  }
}

async function getUserInfo(userId) {
  if (!db) return { credits: 0, invites: 0, totalEarned: 0 };
  try {
    const doc = await db.collection('users').doc(userId.toString()).get();
    if (doc.exists) return doc.data();
  } catch (e) {
    console.error(e);
  }
  return { credits: 0, invites: 0, totalEarned: 0 };
}

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
  ctx.reply('ត្រឡប់ទៅកាន់ទំព័រដើមវិញ...', mainMenu);
});

// Tools មុខងារផ្សេងៗ
bot.hears('🔧 Tools មុខងារផ្សេងៗ', (ctx) => {
  const text = `🛠 Tools មុខងារផ្សេងៗ (All Utility Tools)

👉 សូមជ្រើសរើសឧបករណ៍ដែលអ្នកត្រូវការប្រើប្រាស់៖

1. 📁 File -> Link: បង្កើត Shareable Link សម្រាប់ផ្ញើ File គ្រប់ប្រភេទ
2. 🔗 Image -> Link: បង្កើត Shareable Link សម្រាប់រូបភាពលឿនៗ
3. 📝 ធ្វើរូប 4x6 CV: កែរូបធម្មតា ទៅជារូបថតស្អាតៗ 4x6 សំរាប់ដាក់ CV/កាត
4. 📝 ធ្វើរូបភាពច្បាស់ 4K: បង្កើនគុណភាព និងភាពច្បាស់នៃរូបភាព Ultra HD
5. 📝 Remove BG: លុបផ្ទៃខាងក្រោយរូបភាពឱ្យថ្លា (Transparent PNG)
6. 📜 Image To PDF: បម្លែងរូបភាពទៅជាឯកសារ PDF
7. 🔄 URL To QR: បង្កើត QR Code ពី Link ផ្សេងៗ`;
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

bot.hears('💻 បកប្រែរឿង', (ctx) => {
  const text = \`📊 Dashboard: 🎬 បកប្រែរឿង
[ 📦 ទំហំ៖ File ផ្ទាល់ & Link រហូតដល់ 4GB (4000MB) | 💰 តម្លៃ 1000 Credits / វីដេអូ ]

🎞 ការកំណត់កាត់ភាគ៖ 🟢 ពេញមួយរឿង (Full)

👉 សូមជ្រើសរើសប្រភេទសម្លេង (ឬផ្ញើ File វីដេអូ / Link បានភ្លាមៗ - ស្ដង់ដារ៖ សម្លេងប្រុស & ស្រី)៖\`;

  const inlineKeyboard = Markup.inlineKeyboard([
    [Markup.button.callback('💬 ១. សម្លេងប្រុស (Standard)', 'voice_male')],
    [Markup.button.callback('💬 ២. សម្លេងស្រី (Standard)', 'voice_female')],
    [Markup.button.callback('🤖 ៣. សម្លេងប្រុស & ស្រី (Auto Both)', 'voice_both')],
    [Markup.button.callback('⚙️ កំណត់កាត់ជាកង់៖ ពេញមួយរឿង (Full)', 'setting_full')],
    [Markup.button.callback('❌ ត្រឡប់ក្រោយ', 'back_to_menu')]
  ]);

  ctx.reply(text, inlineKeyboard);
});

bot.action('back_to_menu', (ctx) => {
  ctx.deleteMessage().catch(() => {});
});

const backOnlyMenu = Markup.keyboard([
  ['❌ ត្រឡប់ក្រោយ']
]).resize();

bot.action(['voice_male', 'voice_female', 'voice_both'], (ctx) => {
  ctx.deleteMessage().catch(() => {});
  
  let voiceType = 'សម្លេងប្រុស';
  if (ctx.match[0] === 'voice_female') voiceType = 'សម្លេងស្រី';
  if (ctx.match[0] === 'voice_both') voiceType = 'សម្លេងប្រុស & ស្រី';

  const text = \`📊 Status: Ready for Upload
🎙 សម្លេង៖ \${voiceType}
🎞 កាត់ជាកង់/ភាគ៖ 🟢 ពេញមួយរឿង (Full)
📦 ទំហំ៖ File ផ្ទាល់ & Link រហូតដល់ 4GB (4000MB)
(ផ្ញើបានរហូតដល់ ១០ វីដេអូ)
💰 តម្លៃ៖ 1000 Credits / វីដេអូ

👉 សូមផ្ញើឯកសារវីដេអូរឿង ឬ Link (អាចផ្ញើជា File ឬ Link បានរហូតដល់ ១០ វីដេអូដំណាលគ្នា)៖\`;

  ctx.reply(text, backOnlyMenu);
});
bot.hears('🎙️ SRT to Voice', (ctx) => ctx.reply('សូមបញ្ជូន File .srt មកទីនេះ ខ្ញុំនឹងបម្លែងវាជាសម្លេងខ្មែរ 🗣️'));
bot.hears('🤖 Transcript SRT', (ctx) => ctx.reply('សូមបញ្ជូនវីដេអូ ឬសម្លេងមក ខ្ញុំនឹងស្រង់សម្លេងបកប្រែជា File .srt 📝'));
bot.hears('🎙️ Clone សម្លេង', (ctx) => ctx.reply('មុខងារនេះតម្រូវឱ្យអ្នកផ្ញើសម្លេងគំរូមក ដើម្បីឱ្យ AI ត្រាប់តាម 🎤'));
bot.hears('⬇️ ទាញយករឿង', (ctx) => ctx.reply('សូមផ្ញើ Link វីដេអូពី FB, TikTok, YT... មកទីនេះ ខ្ញុំនឹងទាញយកជូន 📥'));

// Express Server Setup
const app = express();
app.use(express.json());

if (process.env.NODE_ENV === 'production' && process.env.WebHook_URL) {
  const webhookUrl = `${process.env.WebHook_URL}/bot${process.env.TELEGRAM_TOKEN}`;
  bot.telegram.setWebhook(webhookUrl);
  app.use(bot.webhookCallback(`/bot${process.env.TELEGRAM_TOKEN}`));
  console.log(`Webhook ត្រូវបានភ្ជាប់ទៅកាន់ ${webhookUrl}`);
} else {
  bot.launch();
  console.log('Bot កំពុងដំណើរការ...');
}

app.get('/', (req, res) => {
  res.send('AI Studio Telegram Bot is Running! 🚀');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Web Server ដំណើរការលើ Port ${PORT}`);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
