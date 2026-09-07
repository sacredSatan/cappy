'use strict';

const yaml = require('js-yaml');

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/;
const KEY_RE = /^([A-Za-z_][A-Za-z0-9_.-]*):(\s|$)/;

// YAML 1.1 words that mean something other than themselves when bare.
const RESERVED = new Set(['true', 'false', 'yes', 'no', 'on', 'off', 'null', 'nan', '~']);

// Split a note into its frontmatter block and body. The body is returned as an
// exact substring of the input — it is never reparsed or reflowed.
function splitNote(text) {
  const m = text.match(FM_RE);
  if (!m) return { hasFm: false, fmText: '', body: text };
  return { hasFm: true, fmText: m[1], body: text.slice(m[0].length) };
}

// Read-only view of existing frontmatter. Malformed YAML is reported rather
// than thrown: a note we cannot parse is a note we must not touch.
function parseFm(fmText) {
  if (!fmText.trim()) return { data: {}, error: null };
  try {
    const data = yaml.load(fmText);
    if (data === null || data === undefined) return { data: {}, error: null };
    if (typeof data !== 'object' || Array.isArray(data)) {
      return { data: {}, error: 'frontmatter is not a mapping' };
    }
    return { data, error: null };
  } catch (e) {
    return { data: {}, error: e.message.split('\n')[0] };
  }
}

// Quote only when bare YAML would change the meaning. Tags and status words go
// unquoted so the file reads the way Obsidian writes it; wikilinks, prose and
// anything that would parse as a bool, number or timestamp stay quoted.
function scalar(v) {
  // Real booleans stay bare so Obsidian types the property as a Checkbox.
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  const s = String(v);
  const bare = /^[A-Za-z][A-Za-z0-9_-]*(\/[A-Za-z0-9][A-Za-z0-9_-]*)*$/.test(s) &&
               !RESERVED.has(s.toLowerCase());
  return bare ? s : "'" + s.replace(/'/g, "''") + "'";
}

function emit(key, value) {
  if (Array.isArray(value)) {
    if (value.length === 0) return `${key}: []`;
    return [`${key}:`, ...value.map((v) => `  - ${scalar(v)}`)].join('\n');
  }
  return `${key}: ${scalar(value)}`;
}

// Group frontmatter into top-level key blocks, each holding its own
// continuation lines (list items, nested maps, folded scalars).
function blocks(fmText) {
  const out = [];
  for (const line of fmText.split(/\r?\n/)) {
    const m = line.match(KEY_RE);
    if (m) out.push({ key: m[1], lines: [line] });
    else if (out.length) out[out.length - 1].lines.push(line);
    else out.push({ key: null, lines: [line] });   // leading comment
  }
  return out;
}

// Set and/or remove top-level keys. Blocks we are not touching are copied
// verbatim, so human formatting, comments and key order all survive.
function editFm(text, { set = {}, remove = [] } = {}) {
  const { hasFm, fmText, body } = splitNote(text);
  const drop = new Set(remove);
  const kept = hasFm ? blocks(fmText).filter((b) => !drop.has(b.key)) : [];

  const seen = new Set();
  const merged = [];
  for (const b of kept) {
    if (b.key !== null && b.key in set) {
      if (seen.has(b.key)) continue;              // collapse duplicate keys
      seen.add(b.key);
      merged.push(emit(b.key, set[b.key]));
    } else {
      merged.push(b.lines.join('\n'));
    }
  }
  for (const [k, v] of Object.entries(set)) if (!seen.has(k)) merged.push(emit(k, v));

  const block = merged.join('\n').replace(/\s+$/, '');
  if (!block) return hasFm ? body : text;
  return `---\n${block}\n---\n${hasFm ? body : text}`;
}

const addKeys = (text, keys) => editFm(text, { set: keys });

module.exports = { splitNote, parseFm, editFm, addKeys, emit, scalar };
