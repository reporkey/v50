import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { resolveCorpusId } from './corpus-id.mjs';

const DEFAULT_DATABASE = 'v50-db';
const DEFAULT_CORPUS_PATH = 'references/v50_corpus.json';

export function validateCorpus(corpus, source = 'corpus') {
  const items = Array.isArray(corpus) ? corpus : corpus?.items;
  if (!Array.isArray(items)) {
    throw new Error(`No corpus items array found in ${source}`);
  }

  if (!Array.isArray(corpus) && typeof corpus?.item_count === 'number' && corpus.item_count !== items.length) {
    throw new Error(
      `item_count mismatch in ${source}: declared ${corpus.item_count}, found ${items.length}`
    );
  }

  const seen = new Set();
  for (const item of items) {
    if (typeof item?.text !== 'string' || !item.text.trim()) {
      throw new Error('Every corpus item must have non-empty text');
    }
    const id = resolveCorpusId(item);
    if (seen.has(id)) {
      throw new Error(`Duplicate corpus id: ${id}`);
    }
    seen.add(id);
  }

  return items;
}

// indexed_at must be stamped here: generate.js fetchCorpusRows only returns
// rows with `status='approved' AND indexed_at IS NOT NULL`, so an import
// that leaves it NULL produces rows RAG silently ignores forever. COALESCE
// keeps the original timestamp on re-imports.
export function buildImportSql(items) {
  return items
    .map(
      (item) =>
        `INSERT INTO corpus_items (id, text, author, source_url, indexed_at)
VALUES (${sqlValue(resolveCorpusId(item))}, ${sqlValue(item.text)}, ${sqlValue(item.author)}, ${sqlValue(item.source_url)}, CURRENT_TIMESTAMP)
ON CONFLICT(id) DO UPDATE SET
  text = excluded.text,
  author = excluded.author,
  source_url = excluded.source_url,
  indexed_at = COALESCE(corpus_items.indexed_at, excluded.indexed_at);`
    )
    .join('\n\n');
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

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const corpusPath = options.corpus || DEFAULT_CORPUS_PATH;
  const database = options.database || process.env.D1_DATABASE || DEFAULT_DATABASE;
  const modeFlag = options.remote ? '--remote' : '--local';

  const corpus = JSON.parse(await readFile(corpusPath, 'utf8'));
  const items = validateCorpus(corpus, corpusPath);
  const sql = buildImportSql(items);

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
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
