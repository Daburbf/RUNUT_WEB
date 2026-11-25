// Repeatable non-confidential Indonesian & English Model Evaluation Benchmark
// Compares configured free models (Token Harbor DeepSeek V4.1 Flash, BeatAPI DeepSeek V4.1 Flash,
// ERNIE 5.5 Flash, Ling 3.2 Flash, Particle-1) on short synthetic samples without ever
// sending confidential user documents or inventing scores.
//
// Usage:
//   RUNUT_RUN_LIVE_BENCHMARK=true node scripts/benchmark-free-models.mjs

import { reviseDocumentBlocksWithAi } from '../server/src/services/aiProvider.js';
import { createThirdPartyConsentRecord } from '../server/src/services/aiModelRegistry.js';

const SAMPLES = [
  {
    id: 'id-academic-sample',
    language: 'id',
    blocks: [{
      block_id: 'paragraph_0001',
      type: 'paragraph',
      editable: true,
      original_text: 'Dalam era perkembangan teknologi yang sangat pesat saat ini, penelitian ini bertujuan untuk melakukan evaluasi terhadap efektivitas sistem informasi akademik berdasarkan data tahun 2024 (Santoso, 2024) dengan tingkat akurasi sebesar 92,5%.',
    }],
  },
  {
    id: 'en-report-sample',
    language: 'en',
    blocks: [{
      block_id: 'paragraph_0001',
      type: 'paragraph',
      editable: true,
      original_text: 'In today\'s rapidly evolving digital landscape, it is worth noting that the quarterly infrastructure audit recorded a 14.2% reduction in response latency during Q3 2026 (Patel, 2026).',
    }],
  },
];

const CANDIDATES = [
  { name: 'Token Harbor DeepSeek V4.1 Flash', provider: 'tokenharbor', keyEnv: 'TOKEN_HARBOR_API_KEY', model: 'deepseek-v4.1-flash:free' },
  { name: 'BeatAPI DeepSeek V4.1 Flash', provider: 'beatapi', keyEnv: 'BEATAPI_API_KEY', model: 'deepseek-v4.1-flash-free' },
  { name: 'OpenRouter ERNIE 5.5 Flash Preview', provider: 'openrouter', keyEnv: 'OPENROUTER_API_KEY', model: 'baidu/ernie-5.5-flash-preview:free' },
  { name: 'OpenRouter Ling 3.2 Flash', provider: 'openrouter', keyEnv: 'OPENROUTER_API_KEY', model: 'inclusionai/ling-3.2-flash:free' },
  { name: 'OpenRouter Particle-1', provider: 'openrouter', keyEnv: 'OPENROUTER_API_KEY', model: 'particle-ai/particle-1:free' },
];

async function main() {
  if (process.env.RUNUT_RUN_LIVE_BENCHMARK !== 'true') {
    console.log('Dry-run mode (set RUNUT_RUN_LIVE_BENCHMARK=true to execute live API calls on synthetic samples).');
    console.log('Configured candidates:', CANDIDATES.map((c) => `${c.name} (${c.keyEnv}: ${process.env[c.keyEnv] ? 'SET' : 'NOT SET'})`));
    return;
  }

  const results = [];
  for (const cand of CANDIDATES) {
    if (!process.env[cand.keyEnv]) {
      results.push({ candidate: cand.name, skipped: true, reason: `${cand.keyEnv} not set` });
      continue;
    }
    for (const sample of SAMPLES) {
      const env = {
        ...process.env,
        STRICT_FREE_AI_ONLY: 'true',
        AI_FAILOVER_ENABLED: 'false',
        AI_PROVIDER: cand.provider,
        OPENROUTER_PRIMARY_MODEL: cand.provider === 'openrouter' ? cand.model : undefined,
        ENABLE_TOKEN_HARBOR_FREE: cand.provider === 'tokenharbor' ? 'true' : 'false',
        ENABLE_BEATAPI_FREE: cand.provider === 'beatapi' ? 'true' : 'false',
        ALLOW_THIRD_PARTY_FREE_AI_PROCESSING: 'true',
      };
      try {
        const out = await reviseDocumentBlocksWithAi({
          documentId: sample.id,
          language: sample.language,
          blocks: sample.blocks,
          confidential: false,
          thirdPartyFreeConsent: createThirdPartyConsentRecord({ provider: cand.provider }),
        }, env);
        const rep = out.replacements?.[0]?.revised_text || '';
        const citationPreserved = sample.language === 'id' ? rep.includes('(Santoso, 2024)') : rep.includes('(Patel, 2026)');
        const figurePreserved = sample.language === 'id' ? rep.includes('92,5%') : rep.includes('14.2%');
        results.push({
          candidate: cand.name,
          sample: sample.id,
          ok: true,
          latency_ms: out.latencyMs,
          json_valid: Array.isArray(out.replacements) && out.replacements.length === 1,
          citation_preserved: citationPreserved,
          figure_preserved: figurePreserved,
          usage: out.usage || null,
        });
      } catch (err) {
        results.push({
          candidate: cand.name,
          sample: sample.id,
          ok: false,
          error_code: err?.code || 'ERROR',
          error: err?.message || String(err),
        });
      }
    }
  }
  console.log(JSON.stringify(results, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
