#!/usr/bin/env node
'use strict';

// Entry point for the LaunchAgent: classify -> accept -> maps, then a daily
// snapshot. Every step is independent; one failing must not stop the rest.

const path = require('path');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');

const C = require('./lib/config.js');

const stamp = () => new Date().toISOString();
const log = (...a) => console.log(`[${stamp()}]`, ...a);

const GIT_DIR = process.env.CAPPY_GIT_DIR || C.SNAPSHOT_GIT_DIR;
const SNAPSHOT_STATE = C.SNAPSHOT_STATE;

function step(name, script) {
  log(`--- ${name} ---`);
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;   // the subscription login must win
  const r = spawnSync(process.execPath, [path.join(C.REPO, script)], {
    cwd: C.REPO, env, encoding: 'utf8', stdio: 'inherit',
  });
  if (r.error) { log(`${name} FAILED: ${r.error.message}`); return false; }
  if (r.status !== 0) { log(`${name} exited ${r.status}`); return false; }
  return true;
}

// Safety net for any interactive agent session on the vault. The git dir lives
// outside the vault on purpose — iCloud must never see a .git directory.
function snapshot() {
  if (!fs.existsSync(GIT_DIR)) {
    log(`snapshot: no git dir at ${GIT_DIR} — skipping (see SETUP.md to enable)`);
    return;
  }
  const today = new Date().toISOString().slice(0, 10);
  if (fs.existsSync(SNAPSHOT_STATE) && fs.readFileSync(SNAPSHOT_STATE, 'utf8').trim() === today) return;

  const git = (...args) => spawnSync('/usr/bin/git',
    ['--git-dir', GIT_DIR, '--work-tree', C.VAULT, ...args],
    { encoding: 'utf8' });

  log('--- snapshot ---');
  git('add', '-A');
  const r = git('commit', '-m', `vault snapshot ${today}`);
  const out = (r.stdout || '') + (r.stderr || '');
  if (r.status === 0) log('snapshot committed');
  else if (/nothing to commit/.test(out)) log('snapshot: no changes');
  else log(`snapshot failed: ${out.trim().split('\n')[0]}`);
  fs.writeFileSync(SNAPSHOT_STATE, today + '\n');
}

// launchd appends to the log forever and rotates nothing. The fd is opened
// O_APPEND, so truncating in place is safe: later writes resume at offset 0.
function trimLogs() {
  for (const f of ['out.log', 'err.log']) {
    const p = path.join(C.LOG_DIR, f);
    try { if (fs.statSync(p).size > 1024 * 1024) fs.truncateSync(p, 0); } catch { /* absent */ }
  }
}

function main() {
  trimLogs();
  log(`cappy start — vault=${C.VAULT}`);
  const classified = step('classify', 'classify.js');
  const accepted = step('accept', 'accept.js');
  // maps.js is a no-op when nothing changed, so it is cheap to always run and
  // safer than trying to guess whether the taxonomy moved.
  if (classified || accepted) step('maps', 'maps.js');
  else log('--- maps --- skipped (earlier steps failed)');
  try { snapshot(); } catch (e) { log(`snapshot error: ${e.message}`); }
  log('cappy done');
}

main();
