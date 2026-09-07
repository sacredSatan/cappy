'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const CONFIG_FILE = process.env.CAPPY_CONFIG || path.join(REPO, 'cappy.config.json');

function loadConfigFile() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw new Error(`cannot read ${CONFIG_FILE}: ${e.message}`);
  }
}

const file = loadConfigFile();

// CAPPY_VAULT wins over the config file so tests and one-off runs can point at
// a scratch vault without touching the real one.
const VAULT = process.env.CAPPY_VAULT || file.vault;
if (!VAULT) {
  throw new Error(
    'No vault configured.\n' +
    `  Expected "vault" in ${CONFIG_FILE}, or the CAPPY_VAULT environment variable.\n` +
    '  Run:  node setup.js');
}

const LOG_DIR = file.logDir || path.join(os.homedir(), 'Library', 'Logs', 'cappy');

module.exports = {
  VAULT,
  REPO,
  CONFIG_FILE,
  LOG_DIR,
  NOTES_DIR: path.join(VAULT, 'notes'),
  MAPS_DIR: path.join(VAULT, '_maps'),
  TAXONOMY_FILE: path.join(VAULT, '_system', 'taxonomy.md'),
  SYSTEM_PROMPT: path.join(REPO, 'prompts', 'classifier-system.md'),
  CLAUDE_BIN: process.env.CLAUDE_BIN || file.claudeBin || '/opt/homebrew/bin/claude',
  BRCTL_BIN: '/usr/bin/brctl',
  MODEL: file.model || 'haiku',
  SNAPSHOT_GIT_DIR: file.snapshotGitDir || path.join(os.homedir(), '.cappy-vault.git'),
  SNAPSHOT_STATE: path.join(os.homedir(), '.cappy-last-snapshot'),
  LABEL: file.label || `com.${os.userInfo().username}.cappy`,
  // iCloud settle window: don't touch a file that changed in the last 2 min.
  SETTLE_MS: 120 * 1000,
  MAX_TAGS: 4,
  MAX_RELATED: 5,
  MAX_NEW_TAGS: 3,
};
