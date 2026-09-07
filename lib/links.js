'use strict';

// `related` entries are strings so Obsidian's mobile property editor can handle
// them and so nothing nests. An optional edge label rides after ` :: `:
//
//   '[[Transformers]]'
//   '[[Attention]] :: builds on'
//
// `#` cannot be used as the separator — YAML would treat it as a comment and
// silently drop the label. Wikilinks must stay quoted in YAML too, or `[[x]]`
// parses as a nested flow sequence rather than a string.

const SEP = ' :: ';
const WIKILINK = /^\[\[([^\]|]+?)(?:\|[^\]]*)?\]\]$/;

// Accepts '[[Title]] :: label', '[[Title]]', 'Title :: label' or 'Title'.
function parseRelated(entry) {
  if (typeof entry !== 'string') return null;
  const i = entry.indexOf(SEP);
  const head = (i === -1 ? entry : entry.slice(0, i)).trim();
  const label = i === -1 ? '' : entry.slice(i + SEP.length).trim().replace(/\s+/g, ' ');
  if (!head) return null;
  const m = head.match(WIKILINK);
  const title = (m ? m[1] : head).trim();
  return title ? { title, label } : null;
}

function formatRelated(title, label) {
  return label ? `[[${title}]]${SEP}${label}` : `[[${title}]]`;
}

module.exports = { parseRelated, formatRelated, SEP };
