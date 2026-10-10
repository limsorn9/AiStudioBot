require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');

async function getKeysFromFirebase() {
  let groqKeys = [];
  let geminiKeys = [];

  try {
    const credPath = path.resolve(__dirname, process.env.GOOGLE_APPLICATION_CREDENTIALS || 'serviceAccountKey.json');
    if (fs.existsSync(credPath)) {
      const cred = JSON.parse(fs.readFileSync(credPath, 'utf8'));
      if (getApps().length === 0) {
        initializeApp({
          credential: cert(cred),
          databaseURL: process.env.FIREBASE_DB_URL
        });
      }
      const db = getDatabase();
      const usersSnap = await db.ref('users').once('value');
      if (usersSnap.exists()) {
        const users = usersSnap.val();
        for (const uid of Object.keys(users)) {
          const uGroq = users[uid]?.api_keys?.groq;
          const uGem = users[uid]?.api_keys?.gemini;
          if (uGroq) {
            const list = Array.isArray(uGroq) ? uGroq : Object.values(uGroq);
            list.filter(Boolean).forEach(k => groqKeys.push(k));
          }
          if (uGem) {
            const list = Array.isArray(uGem) ? uGem : Object.values(uGem);
            list.filter(Boolean).forEach(k => geminiKeys.push(k));
          }
        }
      }
    }
  } catch (e) {
    // ignore
  }

  return {
    groq: [...new Set(groqKeys)],
    gemini: [...new Set(geminiKeys)]
  };
}

async function runTest() {
  console.log('🔍 កំពុងតេស្ត និងទាញយកបញ្ជី AI Models ពី Google Gemini & Groq...\n');

  const fbKeys = await getKeysFromFirebase();
  const groqKey = fbKeys.groq[0] || (process.env.GROQ_API_KEYS || process.env.GROQ_API_KEY || '').split(',')[0]?.trim();
  const geminiKey = fbKeys.gemini[0] || (process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '').split(',')[0]?.trim();

  // Test Groq
  if (groqKey) {
    try {
      const res = await fetch('https://api.groq.com/openai/v1/models', {
        headers: { 'Authorization': `Bearer ${groqKey}` }
      });
      const data = await res.json();
      const models = (data.data || []).map(m => m.id);
      console.log(`⚡ [GROQ API] (រកឃើញ ${fbKeys.groq.length} Keys) ម៉ូឌែលដែលកំពុងបើក៖`);
      models.forEach(m => console.log('  • ' + m));
    } catch (e) {
      console.error('Groq test error:', e.message);
    }
  } else {
    console.log('⚡ [GROQ] គ្មាន Key ក្នុងប្រព័ន្ធ');
  }

  console.log('\n--------------------------------------------------\n');

  // Test Gemini
  if (geminiKey) {
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${geminiKey}`);
      const data = await res.json();
      const models = (data.models || []).map(m => m.name.replace('models/', ''));
      console.log(`🤖 [GEMINI API] (រកឃើញ ${fbKeys.gemini.length} Keys) ម៉ូឌែលដែលកំពុងបើក៖`);
      models.filter(m => m.includes('flash') || m.includes('pro')).forEach(m => console.log('  • ' + m));
    } catch (e) {
      console.error('Gemini test error:', e.message);
    }
  } else {
    console.log('🤖 [GEMINI] គ្មាន Key ក្នុងប្រព័ន្ធ');
  }
}

runTest();
