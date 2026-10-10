require('dotenv').config();

async function runTest() {
  console.log('🔍 Testing AI Models Health & Latest Generations...\n');

  // Test Groq
  const groqKey = (process.env.GROQ_API_KEYS || process.env.GROQ_API_KEY || '').split(',')[0]?.trim();
  if (groqKey) {
    try {
      const res = await fetch('https://api.groq.com/openai/v1/models', {
        headers: { 'Authorization': `Bearer ${groqKey}` }
      });
      const data = await res.json();
      const models = (data.data || []).map(m => m.id);
      console.log('⚡ [GROQ API] Active Models:');
      models.forEach(m => console.log('  - ' + m));
    } catch (e) {
      console.error('Groq test error:', e.message);
    }
  } else {
    console.log('⚡ [GROQ] No API Key provided in .env');
  }

  console.log('\n----------------------------------------\n');

  // Test Gemini
  const geminiKey = (process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '').split(',')[0]?.trim();
  if (geminiKey) {
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${geminiKey}`);
      const data = await res.json();
      const models = (data.models || []).map(m => m.name.replace('models/', ''));
      console.log('🤖 [GEMINI API] Active Models:');
      models.filter(m => m.includes('flash') || m.includes('pro')).forEach(m => console.log('  - ' + m));
    } catch (e) {
      console.error('Gemini test error:', e.message);
    }
  } else {
    console.log('🤖 [GEMINI] No API Key provided in .env');
  }
}

runTest();
