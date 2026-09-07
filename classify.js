#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const C = require('./lib/config.js');
const { readTaxonomy, buildSchema } = require('./lib/taxonomy.js');
const { splitNote, parseFm, addKeys } = require('./lib/frontmatter.js');

const log = (...a) => console.log(...a);
const warn = (...a) => console.warn('  !', ...a);

// ---------------------------------------------------------------- selection

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile() && e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

// An evicted file appears as `.<name>.icloud`. Ask iCloud for it and move on;
// it will be a normal file by the next run.
function requestDownload(file) {
  const stub = path.join(path.dirname(file), '.' + path.basename(file) + '.icloud');
  if (!fs.existsSync(stub)) return false;
  spawnSync(C.BRCTL_BIN, ['download', file], { stdio: 'ignore' });
  return true;
}

function select(files, now) {
  const pending = [];
  for (const f of files) {
    if (requestDownload(f)) { warn('evicted, requested download:', rel(f)); continue; }
    const st = fs.statSync(f);
    const text = fs.readFileSync(f, 'utf8');
    const { fmText } = splitNote(text);
    const { data, error } = parseFm(fmText);
    if (error) { warn('unparseable frontmatter, skipping:', rel(f), '—', error); continue; }
    if ('status' in data) continue;                       // idempotency marker
    if (now - st.mtimeMs < C.SETTLE_MS) {
      log('  ~ settling, skipping:', rel(f),
          `(${Math.round((now - st.mtimeMs) / 1000)}s old, need ${C.SETTLE_MS / 1000}s)`);
      continue;
    }
    pending.push({ file: f, text, mtimeMs: st.mtimeMs, data });
  }
  return pending;
}

const rel = (f) => path.relative(C.VAULT, f);

// Basenames plus any aliases, for the `related` allow-list.
function collectTitles(files) {
  const titles = new Map(); // title -> source file
  for (const f of files) {
    titles.set(path.basename(f, '.md'), f);
    try {
      const { data } = parseFm(splitNote(fs.readFileSync(f, 'utf8')).fmText);
      const a = data.aliases;
      for (const v of Array.isArray(a) ? a : a ? [a] : []) {
        if (typeof v === 'string' && v.trim()) titles.set(v.trim(), f);
      }
    } catch { /* unreadable note contributes only its basename */ }
  }
  return titles;
}

// ------------------------------------------------------------------- model

function callClaude(schema, stdin) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-classify-'));
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;   // must not outrank the claude.ai login
  try {
    const r = spawnSync(C.CLAUDE_BIN, [
      '-p', '--tools', '', '--strict-mcp-config',
      '--system-prompt-file', C.SYSTEM_PROMPT,
      '--json-schema', JSON.stringify(schema),
      '--output-format', 'json', '--model', C.MODEL,
      '--max-turns', '3', '--no-session-persistence',
    ], { input: stdin, cwd: scratch, env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });

    if (r.error) return { ok: false, why: r.error.message };
    if (r.status !== 0) return { ok: false, why: `exit ${r.status}: ${(r.stderr || '').trim()}` };
    let env2;
    try { env2 = JSON.parse(r.stdout); }
    catch { return { ok: false, why: 'stdout was not JSON' }; }
    // subtype is "success" even on failure — never gate on it. See docs/probe.md.
    if (env2.is_error) return { ok: false, why: `api_error_status=${env2.api_error_status}` };
    if (!env2.structured_output) return { ok: false, why: 'no structured_output in envelope' };
    return { ok: true, out: env2.structured_output, cost: env2.total_cost_usd || 0 };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function buildStdin(tags, titles, body) {
  return [
    '## Allowed tags', '', ...tags, '',
    '## Existing note titles', '',
    ...(titles.length ? titles : ['(none yet)']), '',
    '## Note', '', body.trim(), '',
  ].join('\n');
}

// --------------------------------------------------------------- validation

const TAG_RE = /^[a-z0-9][a-z0-9-]*(\/[a-z0-9][a-z0-9-]*)*$/;

// The schema already constrains the model; this re-checks independently so a
// schema change, a model slip, or a taxonomy edit mid-run cannot write junk.
function validate(out, tagSet, titleSet) {
  const problems = [];
  const uniq = (a) => [...new Set(a)];
  const arr = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);

  const tags = uniq(arr(out.proposed_tags).map((t) => t.trim()).filter((t) => {
    if (tagSet.has(t)) return true;
    problems.push(`dropped tag not in taxonomy: ${t}`); return false;
  })).slice(0, C.MAX_TAGS);

  const related = uniq(arr(out.related).map((t) => t.trim()).filter((t) => {
    if (titleSet.has(t)) return true;
    problems.push(`dropped related, no such note: ${t}`); return false;
  })).slice(0, C.MAX_RELATED);

  const newTags = uniq(arr(out.new_tag_proposals).map((t) => t.trim().replace(/^#/, '')).filter((t) => {
    if (!TAG_RE.test(t)) { problems.push(`dropped malformed new tag: ${t}`); return false; }
    if (tagSet.has(t)) { problems.push(`dropped new tag already in taxonomy: ${t}`); return false; }
    return true;
  })).slice(0, C.MAX_NEW_TAGS);

  let note = typeof out.classifier_note === 'string' ? out.classifier_note.trim() : '';
  if (note.length > 400) note = note.slice(0, 397) + '...';

  if (tags.length === 0) return { ok: false, problems: [...problems, 'no valid tags survived'] };
  return { ok: true, problems, fields: {
    // approve first: it is the one thing the human touches, and the property
    // editor puts it at the top of the list on the phone.
    approve: false,
    status: 'proposed',
    proposed_tags: tags,
    related: related.map((t) => `[[${t}]]`),
    new_tag_proposals: newTags,
    classifier_note: note,
    classified_at: new Date().toISOString(),
  } };
}

// ------------------------------------------------------------------- write

function writeNote(entry, fields) {
  const st = fs.statSync(entry.file);
  if (st.mtimeMs !== entry.mtimeMs) throw new Error('file changed since it was read');
  const next = addKeys(entry.text, fields);
  const tmp = path.join(path.dirname(entry.file), `.${path.basename(entry.file)}.tmp.${process.pid}`);
  fs.writeFileSync(tmp, next, 'utf8');
  try { fs.renameSync(tmp, entry.file); }
  catch (e) { fs.rmSync(tmp, { force: true }); throw e; }
}

// -------------------------------------------------------------------- main

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const target = args.filter((a) => !a.startsWith('--'))[0];

  const { tags, rejected } = readTaxonomy(C.TAXONOMY_FILE);
  for (const r of rejected) warn('ignored taxonomy line:', JSON.stringify(r));
  const tagSet = new Set(tags);
  const schema = buildSchema(tags);

  if (!fs.existsSync(C.NOTES_DIR)) { warn('no notes dir:', C.NOTES_DIR); return; }
  const all = walk(C.NOTES_DIR);
  for (const f of all) if (/ \d+\.md$/.test(path.basename(f))) warn('possible iCloud conflict file:', rel(f));

  const titles = collectTitles(all);
  const now = Date.now();

  let pending;
  if (target) {
    const f = path.resolve(target);
    pending = select([f], now);
    if (!pending.length) { log('nothing to do for', rel(f)); return; }
  } else {
    pending = select(all, now);
  }

  log(`${dryRun ? '[dry-run] ' : ''}${pending.length} note(s) to classify, ${tags.length} tags, ${titles.size} known titles\n`);

  let cost = 0, wrote = 0, failed = 0;
  for (const entry of pending) {
    const name = rel(entry.file);
    const self = path.basename(entry.file, '.md');
    const titleList = [...titles.keys()].filter((t) => t !== self).sort();
    const body = splitNote(entry.text).body;

    const r = callClaude(schema, buildStdin(tags, titleList, body));
    if (!r.ok) { warn(`${name}: model call failed — ${r.why}`); failed++; continue; }
    cost += r.cost;

    const v = validate(r.out, tagSet, new Set(titleList));
    for (const p of v.problems) warn(`${name}: ${p}`);
    if (!v.ok) { warn(`${name}: nothing usable, leaving untouched`); failed++; continue; }

    log(`${name}`);
    for (const [k, val] of Object.entries(v.fields)) {
      log(`   ${k}: ${Array.isArray(val) ? (val.length ? val.join(', ') : '(empty)') : val}`);
    }
    if (dryRun) { log('   -> dry run, not written\n'); continue; }
    try { writeNote(entry, v.fields); wrote++; log('   -> written\n'); }
    catch (e) { warn(`${name}: not written — ${e.message}\n`); failed++; }
  }

  log(`done: ${wrote} written, ${failed} failed, $${cost.toFixed(4)}`);
}

if (require.main === module) main();

module.exports = { validate, buildStdin };
