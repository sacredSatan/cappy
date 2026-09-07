'use strict';

const fs = require('fs');

// Parse _system/taxonomy.md into an ordered, de-duplicated tag list.
// Human-edited file: tolerate blank lines, comments, list bullets, stray '#'
// and trailing whitespace. Anything left must look like a/b/c.
function parseTaxonomy(text) {
  const seen = new Set();
  const tags = [];
  const rejected = [];
  let inComment = false;

  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line) continue;

    // HTML comments, single-line or spanning lines.
    if (inComment) {
      if (line.includes('-->')) {
        inComment = false;
        line = line.slice(line.indexOf('-->') + 3).trim();
        if (!line) continue;
      } else continue;
    }
    while (line.includes('<!--')) {
      const head = line.slice(0, line.indexOf('<!--')).trim();
      const rest = line.slice(line.indexOf('<!--') + 4);
      if (rest.includes('-->')) {
        line = (head + ' ' + rest.slice(rest.indexOf('-->') + 3)).trim();
      } else {
        inComment = true;
        line = head;
        break;
      }
    }
    if (!line) continue;
    line = line.replace(/^[-*+]\s+/, ''); // markdown bullet
    if (line.startsWith('#') && /\s/.test(line)) continue; // markdown heading
    line = line.replace(/^#/, ''); // tag written as #cs/algorithms
    line = line.trim();
    if (!line) continue;

    if (!/^[a-z0-9][a-z0-9-]*(\/[a-z0-9][a-z0-9-]*)*$/.test(line)) {
      rejected.push(raw.trim());
      continue;
    }
    if (seen.has(line)) continue;
    seen.add(line);
    tags.push(line);
  }
  return { tags, rejected };
}

function readTaxonomy(file) {
  const { tags, rejected } = parseTaxonomy(fs.readFileSync(file, 'utf8'));
  if (tags.length === 0) throw new Error(`taxonomy is empty: ${file}`);
  return { tags, rejected };
}

// Top-level nodes, in first-seen order — one Map of Content per node.
function topLevelNodes(tags) {
  const seen = new Set();
  const out = [];
  for (const t of tags) {
    const head = t.split('/')[0];
    if (!seen.has(head)) { seen.add(head); out.push(head); }
  }
  return out;
}

// The enum constraint is what stops the model inventing tags, so the tag list
// is baked into the schema at runtime rather than checked afterwards. The
// script re-validates anyway — see classify.js.
function buildSchema(tags) {
  return {
    type: 'object',
    properties: {
      proposed_tags: {
        type: 'array',
        minItems: 1,
        maxItems: 4,
        items: { type: 'string', enum: tags },
      },
      related: {
        type: 'array',
        maxItems: 5,
        items: { type: 'string' },
      },
      new_tag_proposals: {
        type: 'array',
        maxItems: 3,
        items: { type: 'string' },
      },
      classifier_note: { type: 'string' },
    },
    required: ['proposed_tags', 'related', 'new_tag_proposals', 'classifier_note'],
    additionalProperties: false,
  };
}

module.exports = { parseTaxonomy, readTaxonomy, topLevelNodes, buildSchema };
