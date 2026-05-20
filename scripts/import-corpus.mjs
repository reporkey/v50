import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const DEFAULT_DATABASE = 'v50-db';
const DEFAULT_CORPUS_PATH = 'samples/v50_corpus.json';

const options = parseArgs(process.argv.slice(2));
const corpusPath = options.corpus || DEFAULT_CORPUS_PATH;
const database = options.database || process.env.D1_DATABASE || DEFAULT_DATABASE;
const modeFlag = options.remote ? '--remote' : '--local';

const corpus = JSON.parse(await readFile(corpusPath, 'utf8'));
const items = Array.isArray(corpus) ? corpus : corpus.items;
if (!Array.isArray(items)) {
  throw new Error(`No corpus items array found in ${corpusPath}`);
}

const seen = new Set();
for (const item of items) {
  if (!item || typeof item.id !== 'string' || !item.id.trim()) {
    throw new Error('Every corpus item must have a non-empty string id');
  }
  if (typeof item.text !== 'string' || !item.text.trim()) {
    throw new Error(`Corpus item ${item.id} must have non-empty text`);
  }
  if (seen.has(item.id)) {
    throw new Error(`Duplicate corpus id: ${item.id}`);
  }
  seen.add(item.id);
}

const sql = items
  .map(
    (item) =>
      `INSERT INTO corpus_items (id, text, source, source_url)
VALUES (${sqlValue(item.id)}, ${sqlValue(item.text)}, ${sqlValue(item.source)}, ${sqlValue(item.source_url)})
ON CONFLICT(id) DO UPDATE SET
  text = excluded.text,
  source = excluded.source,
  source_url = excluded.source_url;`
  )
  .join('\n\n');

const tempDir = await mkdtemp(join(tmpdir(), 'v50-import-'));
const sqlPath = join(tempDir, 'corpus-import.sql');
await writeFile(sqlPath, sql);

try {
  const result = spawnSync('npx', ['wrangler', 'd1', 'execute', database, modeFlag, '--file', sqlPath], {
    stdio: 'inherit'
  });

  if (result.status !== 0) {
    throw new Error(`wrangler d1 execute failed with status ${result.status}`);
  }

  console.log(`Imported ${items.length} corpus items into ${database} (${modeFlag}).`);
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

function sqlValue(value) {
  if (value === null || value === undefined) return 'NULL';
  return `'${String(value).replaceAll("'", "''")}'`;
}

function parseArgs(args) {
  const parsed = {
    remote: false,
    corpus: '',
    database: ''
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--remote') {
      parsed.remote = true;
    } else if (arg === '--local') {
      parsed.remote = false;
    } else if (arg === '--corpus') {
      parsed.corpus = args[i + 1] || '';
      i += 1;
    } else if (arg === '--database') {
      parsed.database = args[i + 1] || '';
      i += 1;
    }
  }

  return parsed;
}
