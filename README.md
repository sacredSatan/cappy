# cappy

Quick notes you capture in Obsidian get proposed tags and links from a single
Claude Code call. You review on your phone by ticking one checkbox. A second
script promotes the approved proposals to real tags and grows your vocabulary.
Maps of Content per topic keep themselves current.

Nothing here needs an API key, a server, or Obsidian Sync. Model calls go
through `claude -p` on your existing Claude subscription; iCloud is the only
transport.

## The loop

```
  capture on any device            notes/Whatever.md            you, Obsidian
          |
          v
  classify.js  (every 15 min)      proposes tags + links        claude -p
          |                        status: proposed
          v                        approve: false
  you review                       tick the checkbox            you, phone
          |                        approve: true
          v
  accept.js                        tags: written                cappy
          |                        status: filed
          |                        new tags appended to taxonomy
          v
  maps.js                          _maps/<node>.md refreshed    cappy
```

`run.js` chains all three and is what the LaunchAgent invokes every 900 s.

## What it will and will not touch

It writes **frontmatter only**. Note bodies are preserved byte for byte — the
writer copies the body as an exact substring and every write is verified. It
never moves, renames, or deletes anything in your vault. `tags` is written in
exactly one place, `accept.js`, and only for notes you approved.

Writes are atomic (temp file, then rename) and abort if the file changed since
it was read. Files modified in the last 120 s are left alone so iCloud has time
to settle.

## Vault layout

```
notes/                  every captured note (set as Obsidian's default new-note folder)
_maps/                  generated Maps of Content, one per top-level tag
_system/taxonomy.md     your controlled vocabulary (you edit; accept.js appends)
_system/Review.md       generated review queue
```

Notes are never moved between folders. Lifecycle lives in the `status` property.

## Frontmatter

| property            | written by                        | values                                |
|---------------------|-----------------------------------|---------------------------------------|
| `status`            | classify.js -> accept.js          | `proposed` -> `filed`                 |
| `approve`           | classify.js writes `false`; you tick it; accept.js removes | checkbox |
| `proposed_tags`     | classify.js                       | 1-4 tags, all from your taxonomy      |
| `related`           | classify.js, kept on accept       | `[[Note title]]`, existing notes only |
| `new_tag_proposals` | classify.js                       | suggested additions, often empty      |
| `classifier_note`   | classify.js                       | one sentence of rationale             |
| `classified_at`     | classify.js                       | ISO-8601 timestamp                    |
| `tags`              | **accept.js only**                | copied from `proposed_tags` on accept |

Obsidian has no dropdown property type, so `approve` is a Checkbox — the only
one-tap control it offers, and the reason you are not typing "approved" on a
phone keyboard. Setting `status: approved` by hand still works.

## The taxonomy is the point

`_system/taxonomy.md` is a flat list of allowed tags, one per line, nested with
`/`. It becomes the `enum` in the JSON schema handed to the model, so the
classifier *cannot* invent a tag — the constraint is structural, not a request
in a prompt.

When a note's subject genuinely has no home, the model proposes a new tag as a
child of an existing node. Approving the note appends it to the taxonomy, and
it is selectable from the next note onward. That is how the vocabulary grows:
only through notes you approved.

## Commands

```bash
node setup.js --check      # verify prerequisites, change nothing
node setup.js              # set up this machine end to end

node classify.js --dry-run # show what it would write, touch nothing
node classify.js --dry-run "path/to/note.md"
node classify.js           # classify everything pending
node accept.js --dry-run
node accept.js             # file everything approved
node maps.js               # regenerate maps and Review.md
node run.js                # all of the above, what launchd runs

npm test                   # 38 assertions, no model calls, no vault needed
```

## Setup

See [SETUP.md](SETUP.md). It is written to be followed by a person or handed to
a coding agent on a new machine.

## Cost

About $0.006 per note with Haiku, billed to your Claude subscription. Notes are
only ever classified once — `status` is the idempotency marker.

## Design notes

`docs/probe.md` records the exact `claude -p` response envelope this is built
against, including two things worth knowing if you fork this: the validated
object lands in `.structured_output`, and `subtype` reads `"success"` even on a
hard failure, so it is useless for error detection.

## License

WTFPL. See [LICENSE](LICENSE).
