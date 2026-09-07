#!/usr/bin/env node
'use strict';

// No model calls, no real vault. Everything here is pure logic: frontmatter
// surgery, taxonomy parsing, and the two validation gates that decide what is
// allowed to reach a note.
//
//   npm test

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

// Must be set before anything requires lib/config.js.
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'cappy-test-'));
process.env.CAPPY_VAULT = SCRATCH;

const { parseTaxonomy, topLevelNodes, buildSchema } = require('./lib/taxonomy.js');
const { splitNote, parseFm, editFm, addKeys, scalar } = require('./lib/frontmatter.js');
const { validate } = require('./classify.js');
const { plan } = require('./accept.js');
const yaml = require('js-yaml');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log(`  ok    ${name}`); }
  catch (e) { fail++; console.log(`  FAIL  ${name}\n        ${e.message}`); }
};
const group = (n) => console.log(`\n${n}`);

const FIELDS = {
  approve: false,
  status: 'proposed',
  proposed_tags: ['ai/llm/rag'],
  related: ['[[Some Note]]'],
  new_tag_proposals: [],
  classifier_note: "It's about RAG: retrieval, \"quoted\" and colon-y.",
  classified_at: '2026-09-07T20:05:46.967Z',
};

group('frontmatter: bodies are never modified');
const BODIES = {
  'no frontmatter': 'Body one.\n\nBody two.\n',
  'existing frontmatter': '---\naliases:\n  - RAG\n---\nBody.\n',
  'body contains ---': 'Intro.\n\n---\n\nAfter a rule.\n',
  'CRLF line endings': 'Line A.\r\nLine B.\r\n',
  'no trailing newline': 'one line, no newline',
  'frontmatter with comment': '---\n# meta\naliases: [R]\n---\nBody.\n',
  'empty body': '---\naliases: [X]\n---\n',
};
for (const [name, orig] of Object.entries(BODIES)) {
  t(`body survives addKeys: ${name}`, () => {
    assert.strictEqual(splitNote(addKeys(orig, FIELDS)).body, splitNote(orig).body);
  });
}
t('body survives editFm set+remove', () => {
  const note = addKeys('Body text.\n', FIELDS);
  const out = editFm(note, { set: { status: 'filed' }, remove: ['proposed_tags', 'approve'] });
  assert.strictEqual(splitNote(out).body, 'Body text.\n');
});

group('frontmatter: quoting preserves types');
t('tags and status stay bare', () => {
  assert.strictEqual(scalar('ai/llm/rag'), 'ai/llm/rag');
  assert.strictEqual(scalar('proposed'), 'proposed');
});
t('booleans stay bare so Obsidian types them as Checkbox', () => {
  assert.strictEqual(scalar(false), 'false');
  assert.strictEqual(scalar(true), 'true');
});
t('timestamps stay quoted (bare would parse as a Date)', () => {
  const d = yaml.load(splitNote(addKeys('B\n', FIELDS)).fmText);
  assert.strictEqual(typeof d.classified_at, 'string');
});
t('wikilinks stay quoted (bare would be a flow sequence)', () => {
  const d = yaml.load(splitNote(addKeys('B\n', FIELDS)).fmText);
  assert.strictEqual(d.related[0], '[[Some Note]]');
});
t('YAML-reserved words stay quoted', () => {
  for (const w of ['no', 'yes', 'true', 'null', 'off']) {
    assert.strictEqual(yaml.load(`k: ${scalar(w)}`).k, w, w);
  }
});
t('prose with colons and apostrophes round-trips', () => {
  const d = yaml.load(splitNote(addKeys('B\n', FIELDS)).fmText);
  assert.strictEqual(d.classifier_note, FIELDS.classifier_note);
});

group('frontmatter: the human keeps their own keys');
t('user keys, order and comments survive an accept', () => {
  const src = '---\n# personal metadata\naliases:\n  - K8s\ncreated: 2026-09-01\n---\nBody.\n';
  const out = editFm(addKeys(src, FIELDS), {
    set: { status: 'filed', tags: ['cs/databases'] },
    remove: ['proposed_tags', 'new_tag_proposals', 'approve'],
  });
  assert.ok(out.includes('# personal metadata'), 'comment lost');
  assert.ok(/aliases:\n\s+- K8s/.test(out), 'aliases lost');
  assert.ok(out.includes('created: 2026-09-01'), 'created lost');
  const d = yaml.load(splitNote(out).fmText);
  assert.strictEqual(d.status, 'filed');
  assert.ok(!('proposed_tags' in d) && !('approve' in d), 'proposal fields not removed');
});
t('malformed frontmatter is reported, not thrown', () => {
  const { error } = parseFm('this: [is: not: valid');
  assert.ok(error, 'expected an error string');
});
t('setting an existing key replaces rather than duplicates it', () => {
  const out = editFm('---\nstatus: proposed\n---\nB\n', { set: { status: 'filed' } });
  assert.strictEqual((out.match(/^status:/gm) || []).length, 1);
});

group('taxonomy parsing');
const SEED = fs.readFileSync(path.join(__dirname, 'taxonomy.seed.md'), 'utf8');
t('seed parses to 23 tags with nothing rejected', () => {
  const { tags, rejected } = parseTaxonomy(SEED);
  assert.strictEqual(tags.length, 23);
  assert.deepStrictEqual(rejected, []);
});
t('block comments do not leak into the tag list', () => {
  assert.deepStrictEqual(parseTaxonomy('<!-- a\nb\nc -->\ncs/databases\n').tags, ['cs/databases']);
});
t('unterminated comment swallows the rest (fails safe)', () => {
  assert.deepStrictEqual(parseTaxonomy('misc\n<!-- oops\ncs/databases\n').tags, ['misc']);
});
t('bullets, leading # and duplicates collapse', () => {
  assert.deepStrictEqual(parseTaxonomy('cs/algorithms\n- #cs/algorithms\n').tags, ['cs/algorithms']);
});
t('junk is rejected and reported', () => {
  assert.deepStrictEqual(parseTaxonomy('misc\nNot A Tag!\n').rejected, ['Not A Tag!']);
});
t('markdown headings are skipped, bare words are not', () => {
  assert.deepStrictEqual(parseTaxonomy('# Heading here\nmisc\n').tags, ['misc']);
});
t('top-level nodes keep first-seen order', () => {
  assert.deepStrictEqual(topLevelNodes(parseTaxonomy(SEED).tags),
    ['cs', 'aws', 'infra', 'ai', 'math', 'science', 'misc']);
});
t('schema enum is exactly the taxonomy', () => {
  const { tags } = parseTaxonomy(SEED);
  const s = buildSchema(tags);
  assert.deepStrictEqual(s.properties.proposed_tags.items.enum, tags);
  assert.strictEqual(s.properties.proposed_tags.maxItems, 4);
  assert.strictEqual(s.additionalProperties, false);
});

group('classify: model output is re-validated independently of the schema');
const TAGS = new Set(['aws/lambda', 'ai/llm', 'misc']);
const TITLES = new Set(['Real Note']);
t('good output passes through', () => {
  const r = validate({ proposed_tags: ['aws/lambda'], related: ['Real Note'],
    new_tag_proposals: [], classifier_note: 'x' }, TAGS, TITLES);
  assert.ok(r.ok);
  assert.deepStrictEqual(r.fields.proposed_tags, ['aws/lambda']);
  assert.deepStrictEqual(r.fields.related, ['[[Real Note]]']);
  assert.strictEqual(r.fields.status, 'proposed');
  assert.strictEqual(r.fields.approve, false);
});
t('a tag outside the taxonomy is dropped and reported', () => {
  const r = validate({ proposed_tags: ['aws/lambda', 'made/up'], related: [],
    new_tag_proposals: [], classifier_note: '' }, TAGS, TITLES);
  assert.deepStrictEqual(r.fields.proposed_tags, ['aws/lambda']);
  assert.ok(r.problems.some((p) => p.includes('made/up')));
});
t('an invented related title is dropped', () => {
  const r = validate({ proposed_tags: ['misc'], related: ['Nonexistent'],
    new_tag_proposals: [], classifier_note: '' }, TAGS, TITLES);
  assert.deepStrictEqual(r.fields.related, []);
});
t('no surviving tags means the note is left alone', () => {
  const r = validate({ proposed_tags: ['made/up'], related: [],
    new_tag_proposals: [], classifier_note: '' }, TAGS, TITLES);
  assert.strictEqual(r.ok, false);
});
t('a new tag proposal already in the taxonomy is dropped', () => {
  const r = validate({ proposed_tags: ['misc'], related: [],
    new_tag_proposals: ['ai/llm'], classifier_note: '' }, TAGS, TITLES);
  assert.deepStrictEqual(r.fields.new_tag_proposals, []);
});
t('a malformed new tag proposal is dropped', () => {
  const r = validate({ proposed_tags: ['misc'], related: [],
    new_tag_proposals: ['Not A Tag!'], classifier_note: '' }, TAGS, TITLES);
  assert.deepStrictEqual(r.fields.new_tag_proposals, []);
});
t('tags are capped and de-duplicated', () => {
  const many = new Set(['a', 'b', 'c', 'd', 'e']);
  const r = validate({ proposed_tags: ['a', 'a', 'b', 'c', 'd', 'e'], related: [],
    new_tag_proposals: [], classifier_note: '' }, many, TITLES);
  assert.strictEqual(r.fields.proposed_tags.length, 4);
});

group('accept: the human edits proposed_tags by hand, so guard it');
const TAXSET = new Set(['aws/lambda', 'misc']);
const entry = (data) => ({ file: '/x/n.md', data });
t('plain approval yields exactly those tags', () => {
  const r = plan(entry({ proposed_tags: ['aws/lambda'] }), TAXSET);
  assert.ok(r.ok);
  assert.deepStrictEqual(r.tags, ['aws/lambda']);
  assert.deepStrictEqual(r.additions, []);
});
t('an approved new tag joins both the note and the taxonomy', () => {
  const r = plan(entry({ proposed_tags: ['misc'], new_tag_proposals: ['infra/cloud'] }), TAXSET);
  assert.deepStrictEqual(r.tags, ['misc', 'infra/cloud']);
  assert.deepStrictEqual(r.additions, ['infra/cloud']);
});
t('an unaccountable tag skips the note instead of dropping it', () => {
  const r = plan(entry({ proposed_tags: ['aws/lambdaa'] }), TAXSET);
  assert.strictEqual(r.ok, false);
  assert.ok(r.why.includes('aws/lambdaa'));
});
t('no proposed_tags is a skip, not a crash', () => {
  assert.strictEqual(plan(entry({}), TAXSET).ok, false);
});
t('a malformed new_tag_proposal skips the note', () => {
  const r = plan(entry({ proposed_tags: ['misc'], new_tag_proposals: ['Nope!'] }), TAXSET);
  assert.strictEqual(r.ok, false);
});
t('a new tag already in the taxonomy is not appended twice', () => {
  const r = plan(entry({ proposed_tags: ['misc'], new_tag_proposals: ['misc'] }), TAXSET);
  assert.deepStrictEqual(r.additions, []);
  assert.deepStrictEqual(r.tags, ['misc']);
});

fs.rmSync(SCRATCH, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
