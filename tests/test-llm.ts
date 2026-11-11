process.env.SKIP_SLACK_VALIDATION = 'true';
process.env.SKIP_GITHUB_VALIDATION = 'true';

import OpenAI from 'openai';
import { config } from '../src/config.js';

async function testProvider(name: 'deepseek' | 'gemini') {
  const isPrimary = config.llm.provider === name;
  const cfg = name === 'deepseek' ? config.llm.deepseek : config.llm.gemini;

  console.log('\n' + '─'.repeat(60));
  console.log(`🔍 Testing ${name.toUpperCase()} ${isPrimary ? '(PRIMARY from LLM_PROVIDER)' : '(FALLBACK)'}`);
  console.log(`   Model:   ${cfg.model}`);
  console.log(`   BaseURL: ${cfg.apiUrl}`);
  console.log(`   Key:     ${cfg.apiKey ? `sk-...${cfg.apiKey.slice(-4)} (len=${cfg.apiKey.length})` : '(EMPTY)'}`);

  if (!cfg.apiKey || cfg.apiKey.startsWith('your_') || cfg.apiKey.includes('placeholder')) {
    console.log(`   ⚠️ Skipped: ${name.toUpperCase()} API key is empty or placeholder.`);
    return;
  }

  const client = new OpenAI({
    apiKey: cfg.apiKey,
    baseURL: cfg.apiUrl,
    timeout: 20_000,
  });

  const start = Date.now();
  try {
    const res = await client.chat.completions.create({
      model: cfg.model,
      messages: [{ role: 'user', content: 'Respond with exactly: "DEVOPS_TRACKER_ONLINE"' }],
      temperature: 0.1,
    });
    const elapsed = Date.now() - start;
    const reply = res.choices[0]?.message?.content?.trim();
    console.log(`   ✅ SUCCESS (${elapsed}ms): "${reply}"`);
  } catch (err: any) {
    const elapsed = Date.now() - start;
    console.log(`   ❌ FAILED (${elapsed}ms): HTTP ${err.status || 'unknown'}`);
    console.log(`      Error message: ${err.message}`);
    if (err.status === 401 && name === 'deepseek') {
      console.log('      👉 Tip: DeepSeek rejected this key. Generate a fresh key at https://platform.deepseek.com/api_keys');
    }
    if (err.status === 429 && name === 'gemini') {
      console.log('      👉 Tip: Gemini Free Tier daily quota (20 req/day) exceeded. It resets every 24h.');
    }
  }
}

async function main() {
  console.log('═'.repeat(60));
  console.log('🤖 DevOps Tracker LLM Diagnostics');
  console.log(`   Active LLM_PROVIDER in .env: ${config.llm.provider.toUpperCase()}`);
  console.log('═'.repeat(60));

  if (config.llm.provider === 'deepseek') {
    await testProvider('deepseek');
    await testProvider('gemini');
  } else {
    await testProvider('gemini');
    await testProvider('deepseek');
  }

  console.log('\n' + '═'.repeat(60));
}

main().catch(err => {
  console.error('Diagnostic error:', err);
  process.exit(1);
});
