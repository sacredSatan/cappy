#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const C = require('./lib/config.js');
const { readTaxonomy } = require('./lib/taxonomy.js');
const { splitNote, parseFm, editFm } = require('./lib/frontmatter.js');

const log = (...a) => console.log(...a);
const warn = (...a) => console.warn('  !', ...a);
const rel = (f) => path.relative(C.VAULT, f);

const TAG_RE = /^[a-z0-9][a-z0-9-]*(\/[a-z0-9][a-z0-9-]*)*$/;

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile() && e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

function requestDownload(file) {
  const stub = path.join(path.dirname(file), '.' + path.basename(file) + '.icloud');
  if (!fs.existsSync(stub)) return false;
  spawnSync(C.BRCTL_BIN, ['download', file], { stdio: 'ignore' });
  return true;
}

const asList = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string')
                       : typeof v === 'string' && v.trim() ? [v] : []);

// A note is ready when the human has flipped status and iCloud has settled.
function selectApproved(files, now) {
  const out = [];
  for (const f of files) {
    if (requestDownload(f)) { warn('evicted, requested download:', rel(f)); continue; }
    const text = fs.readFileSync(f, 'utf8');
    const { data, error } = parseFm(splitNote(text).fmText);
    if (error) { warn('unparseable frontmatter, skipping:', rel(f), '—', error); continue; }
    // The checkbox is the phone-friendly signal; the status word still works.
    if (data.status === 'filed') continue;
    if (data.approve !== true && data.status !== 'approved') continue;
    const st = fs.statSync(f);
    if (now - st.mtimeMs < C.SETTLE_MS) {
      log('  ~ settling, skipping:', rel(f), `(${Math.round((now - st.mtimeMs) / 1000)}s old)`);
      continue;
    }
    out.push({ file: f, text, data, mtimeMs: st.mtimeMs });
  }
  return out;
}

// The human edits proposed_tags by hand, so this is where their typos surface.
// A tag we cannot account for means we skip the note rather than silently drop
// what they wrote — they get told exactly how to fix it.
function plan(entry, tagSet) {
  const proposed = asList(entry.data.proposed_tags).map((t) => t.trim().replace(/^#/, ''));
  if (proposed.length === 0) return { ok: false, why: 'no proposed_tags to accept' };

  const newProposals = asList(entry.data.new_tag_proposals)
    .map((t) => t.trim().replace(/^#/, '')).filter(Boolean);

  const bad = newProposals.filter((t) => !TAG_RE.test(t));
  if (bad.length) return { ok: false, why: `malformed new_tag_proposals: ${bad.join(', ')}` };

  const additions = newProposals.filter((t) => !tagSet.has(t));
  const known = new Set([...tagSet, ...additions]);

  const unknown = proposed.filter((t) => !known.has(t));
  if (unknown.length) {
    return { ok: false, why: `proposed_tags not in taxonomy: ${unknown.join(', ')} ` +
      '(add it to _system/taxonomy.md, or move it into new_tag_proposals)' };
  }

  const tags = [...new Set([...proposed, ...additions])];
  return { ok: true, tags, additions };
}

function appendTaxonomy(tags) {
  const cur = fs.readFileSync(C.TAXONOMY_FILE, 'utf8');
  const sep = cur.endsWith('\n') ? '' : '\n';
  const next = cur + sep + tags.join('\n') + '\n';
  const tmp = C.TAXONOMY_FILE + `.tmp.${process.pid}`;
  fs.writeFileSync(tmp, next, 'utf8');
  fs.renameSync(tmp, C.TAXONOMY_FILE);
}

function writeNote(entry, tags) {
  const st = fs.statSync(entry.file);
  if (st.mtimeMs !== entry.mtimeMs) throw new Error('file changed since it was read');
  const next = editFm(entry.text, {
    set: { status: 'filed', tags },
    remove: ['proposed_tags', 'new_tag_proposals', 'approve'],
  });
  if (splitNote(next).body !== splitNote(entry.text).body) throw new Error('body would change');
  const tmp = path.join(path.dirname(entry.file), `.${path.basename(entry.file)}.tmp.${process.pid}`);
  fs.writeFileSync(tmp, next, 'utf8');
  try { fs.renameSync(tmp, entry.file); }
  catch (e) { fs.rmSync(tmp, { force: true }); throw e; }
}

function main() {
  const dryRun = process.argv.includes('--dry-run');

  const { tags: taxonomy, rejected } = readTaxonomy(C.TAXONOMY_FILE);
  for (const r of rejected) warn('ignored taxonomy line:', JSON.stringify(r));
  const tagSet = new Set(taxonomy);

  if (!fs.existsSync(C.NOTES_DIR)) { warn('no notes dir:', C.NOTES_DIR); return; }
  const approved = selectApproved(walk(C.NOTES_DIR), Date.now());
  log(`${dryRun ? '[dry-run] ' : ''}${approved.length} approved note(s), ${taxonomy.length} tags\n`);
  if (!approved.length) return;

  const ready = [];
  const additions = [];
  for (const entry of approved) {
    const p = plan(entry, tagSet);
    if (!p.ok) { warn(`${rel(entry.file)}: ${p.why}`); continue; }
    for (const t of p.additions) if (!additions.includes(t)) additions.push(t);
    ready.push({ entry, tags: p.tags, additions: p.additions });
  }

  for (const { entry, tags, additions: add } of ready) {
    log(rel(entry.file));
    log('   tags:', tags.join(', '));
    if (add.length) log('   new taxonomy entries:', add.join(', '));
    log('   status: filed');
  }

  if (dryRun) {
    if (additions.length) log(`\n[dry-run] would append to taxonomy: ${additions.join(', ')}`);
    log('\n[dry-run] nothing written');
    return;
  }

  // Taxonomy first: a note may not claim a tag the vocabulary does not yet list.
  if (additions.length) {
    appendTaxonomy(additions);
    log(`\ntaxonomy += ${additions.join(', ')}`);
  }

  let filed = 0, failed = 0;
  for (const { entry, tags } of ready) {
    try { writeNote(entry, tags); filed++; }
    catch (e) { warn(`${rel(entry.file)}: not written — ${e.message}`); failed++; }
  }

  log(`\ndone: ${filed} filed, ${failed} failed`);
  if (additions.length) log('taxonomy changed — regenerate maps (step 4: maps.js)');
}

if (require.main === module) main();

module.exports = { plan };
