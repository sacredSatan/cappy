# Setting up cappy on a machine

Works on macOS. Takes about ten minutes, most of it waiting for iCloud.

If you are handing this to a coding agent: steps 1-3 and 6 are yours to run;
steps 4, 5 and 7 require a human in a GUI and cannot be automated. Run
`node setup.js --check` first — it reports exactly which of these are missing.

## 1. Prerequisites

- **Node 20+** — `node -v`
- **Claude Code** — `claude -v`, then `claude auth login` if needed.
  cappy uses your subscription; no API key is required or wanted.
- **Obsidian** with a vault in iCloud Drive.

If `ANTHROPIC_API_KEY` is set in your shell, cappy strips it from every model
call so the subscription is used — but unset it in your shell profile anyway if
you did not put it there deliberately. It silently outranks the claude.ai login
for everything else you run.

## 2. Clone and install

```bash
git clone git@github.com:sacredSatan/cappy.git
cd cappy
npm install
```

## 3. Full Disk Access

iCloud Drive is TCC-protected. Grant Full Disk Access in
**System Settings > Privacy & Security > Full Disk Access** to:

- your terminal app (iTerm, Terminal, …) — for running cappy by hand
- your `node` binary (`which node`, often `/opt/homebrew/bin/node`) — for the
  LaunchAgent, which does not run under your terminal

Restart the terminal afterwards; a running process does not pick up a new grant.

**The failure looks like an empty vault, not an error.** `test -d` on a blocked
directory succeeds while `ls` fails with `Operation not permitted`, so a
permissions problem reads as "0 notes found". If cappy reports no notes when
notes exist, check this before anything else.

## 4. Obsidian: default new-note folder  *(manual, per device)*

**Settings > Files and links > Default location for new notes >
"In the folder specified below" > `notes`**

cappy only looks at `notes/**/*.md`. Notes captured to the vault root are
invisible to it. Do this on every device you capture from — the setting lives
in `.obsidian/app.json` and syncs, but confirm it on the phone.

## 5. Obsidian: Bases  *(manual)*

The generated maps and `_system/Review.md` use `base` code blocks. Bases is a
**core** plugin — no install, but confirm it is enabled under
**Settings > Core plugins**. `node setup.js --check` reports its state.

## 6. Run setup

```bash
node setup.js --check      # verify everything above
node setup.js              # then actually do it
```

This finds your vault under `~/Library/Mobile Documents/iCloud~md~obsidian/Documents/`
(pass `--vault "/path"` if you have several), creates `notes/`, `_maps/` and
`_system/`, seeds `_system/taxonomy.md` if absent, writes `cappy.config.json`,
generates the LaunchAgent plist with real absolute paths, and loads it.

Re-running is safe. It never overwrites an existing taxonomy.

Useful flags: `--no-launchd`, `--interval 900`, `--vault "/path/to/Vault"`.

## 7. Edit your taxonomy  *(manual, and the part that matters)*

`_system/taxonomy.md` ships with a generic starter list. **Replace it with your
own topics.** The classifier can only ever choose from this file, so a
vocabulary that does not match what you actually write about will produce
notes tagged `misc` forever.

One tag per line, no leading `#`, nested with `/`:

```
cs/algorithms/graphs
aws/lambda
ai/llm/rag
misc
```

Keep `misc` — it is the honest answer for a one-line note.

## 8. Vault snapshots  *(optional, recommended)*

An automated process now edits your vault every 15 minutes. This is the undo.
The git directory lives **outside** the vault, because iCloud must never see a
`.git`:

```bash
VAULT="$(node -e 'console.log(require("./lib/config.js").VAULT)')"
GITDIR="$HOME/.cappy-vault.git"
git --git-dir="$GITDIR" --work-tree="$VAULT" init -b main

# Exclusions live in the git dir, so no .gitignore has to sit in your vault.
# Without these, Obsidian's UI state changes on every pane move and every
# snapshot is noise.
cat > "$GITDIR/info/exclude" <<'RULES'
.obsidian/workspace.json
.obsidian/workspace-mobile.json
.obsidian/**/*.json.bak
.trash/
.DS_Store
.*.tmp.*
*.tmp.*
RULES

git --git-dir="$GITDIR" --work-tree="$VAULT" add -A
git --git-dir="$GITDIR" --work-tree="$VAULT" commit -m "initial vault snapshot"
```

Once that exists, `run.js` commits once a day automatically — the first run of
each day, throttled by `~/.cappy-last-snapshot`.

```bash
# history
git --git-dir="$HOME/.cappy-vault.git" --work-tree="$VAULT" log --stat

# what a note looked like yesterday
git --git-dir="$HOME/.cappy-vault.git" --work-tree="$VAULT" show HEAD~1:"notes/Whatever.md"

# put a note back
git --git-dir="$HOME/.cappy-vault.git" --work-tree="$VAULT" checkout HEAD~1 -- "notes/Whatever.md"
```

Snapshots are daily, so this recovers yesterday's version, not the last edit.
Obsidian's File Recovery core plugin covers the finer-grained case.

Obsidian's File Recovery core plugin is a second net.

## Operating it

```bash
# health
launchctl print gui/$(id -u)/com.$(id -un).cappy | grep -E 'state|last exit code|runs'

# watch
tail -f ~/Library/Logs/cappy/out.log

# run now instead of waiting for the tick
launchctl kickstart -k gui/$(id -u)/com.$(id -un).cappy

# stop / uninstall
launchctl bootout gui/$(id -u)/com.$(id -un).cappy
rm ~/Library/LaunchAgents/com.$(id -un).cappy.plist
```

`last exit code = 0` and an empty `err.log` is healthy. `run.js` truncates the
logs at 1 MB; launchd rotates nothing on its own.

## Moving to a new Mac

Your vault carries everything that matters — notes, taxonomy, maps — through
iCloud. On the new machine: steps 1-6, then confirm step 4 on that device.
`cappy.config.json` is deliberately not in git; `setup.js` regenerates it with
paths for the new machine.

Remember to remove the LaunchAgent from the old Mac, or two machines will
classify the same notes and race each other. The loser aborts safely on the
mtime check, but you will pay for both calls.

## Troubleshooting

**"0 notes to classify" but notes exist.** Full Disk Access (step 3), or the
notes are outside `notes/` (step 4), or they are under the 120 s settle window,
or they already have a `status` property — cappy never reclassifies.

**Nothing happens at all.** `launchctl print` the label; check `err.log`.

**`* 2.md` files appear.** Two devices edited one note before iCloud
reconciled. cappy logs these but will not resolve them; merge by hand.

**Everything comes back `misc`.** Your taxonomy does not describe what you
write about. Step 7.

**A note is stuck in the review queue.** `accept.js` refuses to file a note
whose `proposed_tags` contains something in neither the taxonomy nor
`new_tag_proposals` — usually a typo. The log names the offending tag. Fix the
tag, or add it to `_system/taxonomy.md`.
