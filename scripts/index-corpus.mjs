import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveCorpusId } from './corpus-id.mjs';

const DEFAULT_CORPUS_PATH = 'references/v50_corpus.json';
const DEFAULT_INDEX = 'v50-corpus';
const EMBEDDING_MODEL = '@cf/baai/bge-m3';
const EMBEDDING_BATCH_SIZE = 50;

await loadEnvFiles(['.env.local', 'env.local', '.env']);

const options = parseArgs(process.argv.slice(2));
const corpusPath = options.corpus || DEFAULT_CORPUS_PATH;
const indexName = options.index || process.env.VECTORIZE_INDEX || DEFAULT_INDEX;
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const apiToken = process.env.CLOUDFLARE_API_TOKEN || process.env.CF_API_TOKEN;

if (!accountId || accountId === '...') {
  throw new Error('CLOUDFLARE_ACCOUNT_ID must be set to your real Cloudflare account id, not "..."');
}
if (!apiToken || apiToken === '...') {
  throw new Error('CLOUDFLARE_API_TOKEN or CF_API_TOKEN must be set to a real Cloudflare API token, not "..."');
}

const corpus = JSON.parse(await readFile(corpusPath, 'utf8'));
const items = Array.isArray(corpus) ? corpus : corpus.items;
if (!Array.isArray(items)) {
  throw new Error(`No corpus items array found in ${corpusPath}`);
}

const tempDir = await mkdtemp(join(tmpdir(), 'v50-index-'));
const ndjsonPath = join(tempDir, 'vectors.ndjson');
const lines = [];

try {
  for (let offset = 0; offset < items.length; offset += EMBEDDING_BATCH_SIZE) {
    const batch = items.slice(offset, offset + EMBEDDING_BATCH_SIZE);
    validateBatch(batch);
    const embeddings = await embedBatch(accountId, apiToken, batch.map((item) => item.text));

    if (embeddings.length !== batch.length) {
      throw new Error(`Embedding count mismatch at offset ${offset}: expected ${batch.length}, got ${embeddings.length}`);
    }

    for (let i = 0; i < batch.length; i += 1) {
      const item = batch[i];
      lines.push(
        JSON.stringify({
          id: resolveCorpusId(item),
          values: embeddings[i],
          metadata: item.author ? { author: item.author } : {}
        })
      );
    }

    console.log(`Embedded ${Math.min(offset + batch.length, items.length)} / ${items.length}`);
  }

  await writeFile(ndjsonPath, `${lines.join('\n')}\n`);

  const result = spawnSync(
    'npx',
    ['wrangler', 'vectorize', 'upsert', indexName, '--file', ndjsonPath, '--batch-size', '500', '--json'],
    {
      stdio: 'inherit'
    }
  );

  if (result.status !== 0) {
    throw new Error(`wrangler vectorize upsert failed with status ${result.status}`);
  }

  console.log(`Indexed ${items.length} corpus vectors into ${indexName}.`);
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

async function embedBatch(accountId, apiToken, texts) {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${EMBEDDING_MODEL}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ text: texts })
    }
  );

  const raw = await response.text();
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new Error(
      `Workers AI embedding request returned non-JSON (${response.status} ${response.statusText}): ${raw.slice(0, 240)}`
    );
  }
  if (!response.ok || payload?.success === false) {
    throw new Error(`Workers AI embedding request failed: ${JSON.stringify(payload)}`);
  }

  return extractEmbeddings(payload, texts.length);
}

function extractEmbeddings(payload, expectedCount) {
  const result = payload?.result || payload;
  const data = result?.data || result?.embeddings || payload?.data;

  if (Array.isArray(data) && Array.isArray(data[0])) {
    return data;
  }

  if (Array.isArray(data) && Array.isArray(result?.shape) && result.shape.length === 2) {
    const [rows, dimensions] = result.shape;
    const embeddings = [];
    for (let row = 0; row < rows; row += 1) {
      embeddings.push(data.slice(row * dimensions, (row + 1) * dimensions));
    }
    return embeddings;
  }

  if (expectedCount === 1 && Array.isArray(data) && data.every((value) => typeof value === 'number')) {
    return [data];
  }

  return [];
}

function validateBatch(batch) {
  for (const item of batch) {
    if (typeof item?.text !== 'string' || !item.text.trim()) {
      throw new Error('Every corpus item must have non-empty text');
    }
  }
}

function parseArgs(args) {
  const parsed = {
    corpus: '',
    index: ''
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--corpus') {
      parsed.corpus = args[i + 1] || '';
      i += 1;
    } else if (arg === '--index') {
      parsed.index = args[i + 1] || '';
      i += 1;
    }
  }

  return parsed;
}

async function loadEnvFiles(paths) {
  for (const path of paths) {
    let text = '';
    try {
      text = await readFile(path, 'utf8');
    } catch {
      continue;
    }

    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;

      const equalsIndex = line.indexOf('=');
      if (equalsIndex === -1) continue;

      const key = line.slice(0, equalsIndex).trim();
      const value = stripEnvQuotes(line.slice(equalsIndex + 1).trim());
      if (key && process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  }
}

function stripEnvQuotes(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}
