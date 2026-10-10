require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');

async function getAllKeys(provider = 'groq') {
  const allKeys = new Set();
  const envRaw = provider === 'groq' ? (process.env.GROQ_API_KEYS || process.env.GROQ_API_KEY || '') : (process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '');
  envRaw.split(',').map(k => k.trim()).filter(Boolean).forEach(k => allKeys.add(k));

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

      // A. Legacy global pool
      const gSnap = await db.ref(`api_keys/${provider}`).once('value');
      if (gSnap.exists()) {
        const val = gSnap.val();
        const list = Array.isArray(val) ? val : (typeof val === 'object' ? Object.values(val) : []);
        list.filter(Boolean).forEach(k => allKeys.add(k));
      }

      // B. Admin master keys
      const mSnap = await db.ref(`admin_master_keys/${provider}`).once('value');
      if (mSnap.exists()) {
        const val = mSnap.val();
        const list = Array.isArray(val) ? val : (typeof val === 'object' ? Object.values(val) : []);
        list.filter(Boolean).forEach(item => {
          const k = typeof item === 'object' ? item.key : item;
          if (k) allKeys.add(k);
        });
      }

      // C. Users pool
      const uSnap = await db.ref('users').once('value');
      if (uSnap.exists()) {
        const users = uSnap.val();
        for (const uid of Object.keys(users)) {
          const uKeys = users[uid]?.api_keys?.[provider];
          if (uKeys) {
            const list = Array.isArray(uKeys) ? uKeys : Object.values(uKeys);
            list.filter(Boolean).forEach(k => allKeys.add(k));
          }
        }
      }
    }
  } catch (e) {
    console.error('Firebase read error:', e.message);
  }

  return Array.from(allKeys);
}

async function runTest() {
  console.log('🔍 កំពុងតេស្ត និងទាញយកបញ្ជី AI Models ពី Google Gemini & Groq...\n');

  const groqKeys = await getAllKeys('groq');
  const geminiKeys = await getAllKeys('gemini');

  // Test Groq
  if (groqKeys.length > 0) {
    try {
      const res = await fetch('https://api.groq.com/openai/v1/models', {
        headers: { 'Authorization': `Bearer ${groqKeys[0]}` }
      });
      const data = await res.json();
      const models = (data.data || []).map(m => m.id);
      console.log(`⚡ [GROQ API] (រកឃើញ ${groqKeys.length} Keys) ម៉ូឌែលដែលកំពុងបើក៖`);
      models.forEach(m => console.log('  • ' + m));
    } catch (e) {
      console.error('Groq test error:', e.message);
    }
  } else {
    console.log('⚡ [GROQ] គ្មាន Key ក្នុងប្រព័ន្ធ');
  }

  console.log('\n--------------------------------------------------\n');

  // Test Gemini
  if (geminiKeys.length > 0) {
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${geminiKeys[0]}`);
      const data = await res.json();
      const models = (data.models || []).map(m => m.name.replace('models/', ''));
      console.log(`🤖 [GEMINI API] (រកឃើញ ${geminiKeys.length} Keys) ម៉ូឌែលដែលកំពុងបើក៖`);
      models.forEach(m => console.log('  • ' + m));
    } catch (e) {
      console.error('Gemini test error:', e.message);
    }
  } else {
    console.log('🤖 [GEMINI] គ្មាន Key ក្នុងប្រព័ន្ធ');
  }
}

runTest();
