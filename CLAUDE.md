# Working on cappy

## Hard rules — these are not style preferences

- **Never modify note bodies.** Frontmatter only. The writer copies the body as
  an exact substring; if a change would alter it, abort instead.
- **Never write `tags` outside `accept.js`.** It is the one place allowed to,
  and only for notes the human approved.
- **Never move, rename, or delete vault files.** Not even generated ones, not
  even ones cappy wrote itself, not to work around a bug. Report and let the
  human decide. (This rule has been broken once, working around a marker
  rename; the fix was to make `maps.js` recognise both marker forms. Do that
  kind of fix, not `rm`.)
- **Ask before the first write to a real vault** in any session.
- Absolute paths everywhere. launchd has a minimal PATH and a cwd that is not
  yours.
- Every write: temp file in the same directory, then rename. Re-stat the file
  first and abort if it changed since it was read.
- Plain Node, no framework, no build step. One dependency (`js-yaml`) and a
  good reason before adding a second.

## When you are unsure about a Claude Code flag or an Obsidian feature

Read the current docs — code.claude.com/docs, obsidian.md/help — rather than
guessing. Both have moved under this project already. `claude --help` is not
authoritative: `--system-prompt-file` and `--max-turns` work but are undocumented.

## Things that have already cost time

- **`subtype` is `"success"` even when a run fails.** Gate on a non-zero exit,
  `is_error === true`, or a missing `structured_output`. See `docs/probe.md`.
- **`--tools ""` does not disable MCP plugin tools.** Without
  `--strict-mcp-config`, locally installed plugins inject their definitions —
  measured at ~10,500 extra tokens and 8x the cost per call.
- **`--bare` forces API-key auth** and never reads the claude.ai login. Do not
  add it back.
- **`ANTHROPIC_API_KEY` silently outranks the subscription login.** Every model
  call strips it from the environment. Keep it that way.
- **TCC denies `readdir` while `stat` still succeeds**, so a permissions
  problem on the vault looks exactly like an empty vault. Probe with `ls` or
  `fs.readdirSync`, never `test -d`.
- **Obsidian rewrites frontmatter formatting** whenever a human edits a note —
  it strips quotes, so a quoted timestamp comes back as a bare one that YAML
  parses as a date. Do not depend on a written value keeping its scalar type.
- **`#` cannot separate a label in YAML** — it starts a comment, so
  `- [[x]] # label` silently loses the label. And bare `[[x]]` is flow-sequence
  syntax that parses to `[["x"]]`, not a string. `related` uses ` :: ` and keeps
  its wikilinks quoted for these two reasons.
- **dagre's compound graphs interleave clusters.** Laying out all groups in one
  compound pass produced group boxes that entirely contained their neighbours,
  which in Obsidian means dragging one group drags the other. `canvas.js` runs
  one dagre pass per group and stacks the results instead.
- **The rubric matters more than it looks, and "only when X" never fires.**
  Twice now. "Propose a new tag only when nothing fits" never fired once,
  because something always loosely fits. "Add a label only when the
  relationship is specific" produced zero labels, including on a note that said
  outright that its subject is what makes the other one work. Both were fixed
  the same way: replace the subjective threshold with a positive question about
  the note ("is the subject *named* by an existing tag?", "does the note state
  how it relates?"). If a rubric clause is not firing, suspect its escape hatch
  before you suspect the model.

## Layout

```
classify.js     select pending notes, call the model, validate, write
accept.js       promote approved proposals to real tags; grow the taxonomy
maps.js         regenerate _maps/<node>.md and _system/Review.md
canvas.js       regenerate _maps/<node>.canvas from `related` (no model call)
run.js          the four above in order, plus a daily vault snapshot
setup.js        one-shot machine setup; --check verifies and changes nothing
lib/config.js   all paths, from cappy.config.json (gitignored)
lib/taxonomy.js parse the vocabulary, build the JSON schema enum
lib/frontmatter.js  split, parse, and edit frontmatter without touching bodies
lib/links.js    parse `related` entries into { title, label }
```

## Testing without touching the real vault

`CAPPY_VAULT` overrides the configured vault:

```bash
CAPPY_VAULT=/tmp/testvault node classify.js --dry-run
```

A scratch vault needs only `_system/taxonomy.md` and `notes/`. Backdate fixture
mtimes past the settle window with `touch -t`, or everything is skipped.

`--dry-run` still calls the model (~$0.006/note). Selection, validation and
frontmatter logic can all be exercised without any model call at all.

`npm test` covers exactly that: body preservation, quoting and scalar types,
taxonomy parsing, and both validation gates (`validate` in classify.js, `plan`
in accept.js). It needs no vault and no network. Run it before and after
touching `lib/frontmatter.js` — body preservation is the property that matters
most and the easiest to break silently.
