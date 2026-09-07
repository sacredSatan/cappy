#!/usr/bin/env node
'use strict';

// One-shot setup for a new machine. Safe to re-run: every step is a no-op when
// it is already done. `--check` verifies prerequisites and changes nothing.
//
//   node setup.js --check
//   node setup.js [--vault "/path/to/Vault"] [--no-launchd] [--interval 900]

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = __dirname;
const CONFIG_FILE = path.join(REPO, 'cappy.config.json');
const ICLOUD = path.join(os.homedir(), 'Library', 'Mobile Documents',
                         'iCloud~md~obsidian', 'Documents');

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const noLaunchd = args.includes('--no-launchd');
const argVal = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

let problems = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m) => { problems++; console.log(`  FAIL  ${m}`); };
const note = (m) => console.log(`  ..    ${m}`);
const head = (m) => console.log(`\n${m}`);

const which = (bin) => {
  const r = spawnSync('/usr/bin/which', [bin], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
};

// TCC denies readdir on iCloud paths while stat still succeeds, so an
// unreadable vault looks exactly like an empty one. Always probe with readdir.
function readable(dir) {
  try { fs.readdirSync(dir); return true; } catch { return false; }
}

function findVault() {
  const explicit = argVal('--vault', null);
  if (explicit) return path.resolve(explicit);
  if (!fs.existsSync(ICLOUD)) return null;
  if (!readable(ICLOUD)) return null;
  const dirs = fs.readdirSync(ICLOUD, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => path.join(ICLOUD, e.name));
  if (dirs.length === 1) return dirs[0];
  if (dirs.length > 1) {
    console.log('\nMultiple vaults found — pick one with --vault:');
    for (const d of dirs) console.log(`  ${d}`);
  }
  return null;
}

function checkPrereqs(vault) {
  head('Prerequisites');

  const major = Number(process.versions.node.split('.')[0]);
  major >= 20 ? ok(`node ${process.versions.node}`)
              : bad(`node ${process.versions.node} — need 20 or newer`);

  const claude = which('claude');
  if (claude) {
    const v = spawnSync(claude, ['-v'], { encoding: 'utf8' }).stdout.trim();
    ok(`claude at ${claude} (${v})`);
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    const st = spawnSync(claude, ['auth', 'status'], { encoding: 'utf8', env });
    try {
      const j = JSON.parse(st.stdout);
      j.loggedIn ? ok(`claude logged in via ${j.authMethod}`)
                 : bad('claude not logged in — run: claude auth login');
    } catch { note('could not read claude auth status'); }
  } else {
    bad('claude not on PATH — see https://claude.com/claude-code');
  }

  if (process.env.ANTHROPIC_API_KEY) {
    note('ANTHROPIC_API_KEY is set in this shell. cappy strips it from every');
    note('call so the claude.ai subscription is used, but unset it in your');
    note('shell profile if you did not mean to have it.');
  }

  if (!fs.existsSync(path.join(REPO, 'node_modules', 'js-yaml'))) {
    bad('dependencies missing — run: npm install');
  } else ok('dependencies installed');

  head('Vault');
  if (!vault) {
    bad(`no vault found under ${ICLOUD} — pass --vault "/path/to/Vault"`);
    return;
  }
  if (!fs.existsSync(vault)) { bad(`vault does not exist: ${vault}`); return; }
  if (!readable(vault)) {
    bad(`vault is not readable: ${vault}`);
    note('This is macOS TCC, not a missing folder. Grant Full Disk Access to');
    note('your terminal app (and to the node binary, for the LaunchAgent) in');
    note('System Settings > Privacy & Security > Full Disk Access.');
    return;
  }
  ok(`vault readable: ${vault}`);

  const ob = path.join(vault, '.obsidian');
  const core = path.join(ob, 'core-plugins.json');
  if (fs.existsSync(core)) {
    try {
      JSON.parse(fs.readFileSync(core, 'utf8')).bases
        ? ok('Obsidian Bases core plugin enabled')
        : bad('Bases core plugin is disabled — maps and Review will not render');
    } catch { note('could not read core-plugins.json'); }
  } else note('no .obsidian yet — open the vault in Obsidian once');

  const app = path.join(ob, 'app.json');
  if (fs.existsSync(app)) {
    try {
      const a = JSON.parse(fs.readFileSync(app, 'utf8'));
      a.newFileLocation === 'folder' && a.newFileFolderPath === 'notes'
        ? ok('new notes default to notes/')
        : note('new notes do NOT default to notes/ — see SETUP.md step 4');
    } catch { note('could not read app.json'); }
  }
}

function scaffoldVault(vault) {
  head('Vault layout');
  for (const d of ['notes', '_maps', '_system']) {
    const p = path.join(vault, d);
    if (fs.existsSync(p)) ok(`${d}/ exists`);
    else { fs.mkdirSync(p, { recursive: true }); ok(`${d}/ created`); }
  }
  const tax = path.join(vault, '_system', 'taxonomy.md');
  if (fs.existsSync(tax)) ok('_system/taxonomy.md exists (left alone)');
  else {
    fs.copyFileSync(path.join(REPO, 'taxonomy.seed.md'), tax);
    ok('_system/taxonomy.md seeded');
  }
}

function writeConfig(vault) {
  head('Config');
  const existing = fs.existsSync(CONFIG_FILE)
    ? JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) : {};
  const cfg = {
    vault,
    model: existing.model || 'haiku',
    claudeBin: existing.claudeBin || which('claude') || '/opt/homebrew/bin/claude',
    label: existing.label || `com.${os.userInfo().username}.cappy`,
    logDir: existing.logDir || path.join(os.homedir(), 'Library', 'Logs', 'cappy'),
    snapshotGitDir: existing.snapshotGitDir || path.join(os.homedir(), '.cappy-vault.git'),
  };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n');
  ok(`wrote ${path.relative(REPO, CONFIG_FILE)}`);
  return cfg;
}

function installAgent(cfg, interval) {
  head('LaunchAgent');
  const nodeBin = process.execPath;
  const plist = fs.readFileSync(path.join(REPO, 'launchd', 'cappy.plist.template'), 'utf8')
    .replace(/{{LABEL}}/g, cfg.label)
    .replace(/{{NODE}}/g, nodeBin)
    .replace(/{{REPO}}/g, REPO)
    .replace(/{{LOG_DIR}}/g, cfg.logDir)
    .replace(/{{INTERVAL}}/g, String(interval))
    .replace(/{{PATH}}/g, `${path.dirname(nodeBin)}:/usr/bin:/bin:/usr/sbin:/sbin`);

  fs.mkdirSync(cfg.logDir, { recursive: true });
  const dest = path.join(os.homedir(), 'Library', 'LaunchAgents', `${cfg.label}.plist`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, plist, { mode: 0o600 });
  ok(`wrote ${dest}`);

  const uid = process.getuid();
  spawnSync('/bin/launchctl', ['bootout', `gui/${uid}/${cfg.label}`], { stdio: 'ignore' });
  const r = spawnSync('/bin/launchctl', ['bootstrap', `gui/${uid}`, dest], { encoding: 'utf8' });
  if (r.status === 0) ok(`bootstrapped ${cfg.label} (every ${interval}s)`);
  else bad(`launchctl bootstrap failed: ${(r.stderr || '').trim()}`);
}

function main() {
  console.log('cappy setup');
  const vault = findVault();
  checkPrereqs(vault);

  if (checkOnly) {
    console.log(problems ? `\n${problems} problem(s) found.` : '\nAll checks passed.');
    process.exit(problems ? 1 : 0);
  }
  if (problems) {
    console.log(`\n${problems} problem(s) — fix them and re-run. Nothing was changed.`);
    process.exit(1);
  }

  scaffoldVault(vault);
  const cfg = writeConfig(vault);
  if (!noLaunchd) installAgent(cfg, Number(argVal('--interval', '900')));

  head('Next steps (manual — cappy cannot do these for you)');
  console.log(`  1. In Obsidian: Settings > Files and links > Default location
     for new notes > "In the folder specified below" > notes
     Do this on every device you capture from.
  2. Optional but recommended — daily vault snapshots:
       git --git-dir="${cfg.snapshotGitDir}" --work-tree="${cfg.vault}" init
       git --git-dir="${cfg.snapshotGitDir}" --work-tree="${cfg.vault}" add -A
       git --git-dir="${cfg.snapshotGitDir}" --work-tree="${cfg.vault}" commit -m "initial"
  3. Watch it work:
       tail -f "${cfg.logDir}/out.log"`);
  console.log('\nDone.');
}

main();
