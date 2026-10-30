#!/usr/bin/env node
/**
 * Cut a release: one command, one version, one tag.
 *
 * The plugin is installed from a git tag (`github:<owner>/<repo>#vX.Y.Z`), and a
 * git dependency is a *source snapshot*: nothing runs `npm run build` for the
 * consumer. So `dist/` is committed, and a release is only correct when the
 * committed bundle was built from the version being tagged. This script enforces
 * that order — bump, build, commit, tag, push — instead of leaving it to
 * memory.
 *
 * Usage:
 *   node scripts/release.mjs patch|minor|major        # bump from current
 *   node scripts/release.mjs 0.2.0                    # explicit version
 *   node scripts/release.mjs patch --dry-run          # show the plan only
 *
 * Refuses to run on a dirty tree, on a non-master branch, or when the tag
 * already exists, because each of those produces a tag that does not match what
 * a consumer will download.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PKG = join(ROOT, 'package.json');
const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)$/u;
const BUMPABLE = new Set(['patch', 'minor', 'major']);

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
  });
}

function git(args, options = {}) {
  return run('git', args, options);
}

function fail(message) {
  console.error(`release: ${message}`);
  process.exit(1);
}

/** The next version, or an explicit one; never guesses past the argument. */
function nextVersion(current, wanted) {
  if (!BUMPABLE.has(wanted)) {
    if (!VERSION_RE.test(wanted)) fail(`"${wanted}" is not a version, and not one of patch|minor|major`);
    return wanted;
  }
  const match = VERSION_RE.exec(current);
  if (match === null) fail(`package.json version "${current}" is not MAJOR.MINOR.PATCH`);
  const [major, minor, patch] = match.slice(1).map(Number);
  if (wanted === 'major') return `${major + 1}.0.0`;
  if (wanted === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const wanted = args.find((arg) => !arg.startsWith('--'));
  if (wanted === undefined) fail('usage: release.mjs <patch|minor|major|X.Y.Z> [--dry-run]');

  const pkg = JSON.parse(readFileSync(PKG, 'utf8'));
  const version = nextVersion(pkg.version, wanted);
  const tag = `v${version}`;

  // A dirty tree would land unrelated edits in the release commit, and a tag
  // must point at exactly what was verified.
  const dirty = git(['status', '--porcelain'], { capture: true }).trim();
  if (dirty !== '') fail(`working tree is dirty:\n${dirty}`);

  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], { capture: true }).trim();
  if (branch !== 'master') fail(`on "${branch}"; releases are cut from master`);

  const existing = git(['tag', '--list', tag], { capture: true }).trim();
  if (existing !== '') fail(`tag ${tag} already exists`);

  console.log(`release: ${pkg.version} -> ${version} (${tag})${dryRun ? ' [dry-run]' : ''}`);
  if (dryRun) return;

  pkg.version = version;
  writeFileSync(PKG, `${JSON.stringify(pkg, null, 2)}\n`);

  // Build after the bump so the bundle and the manifest cannot disagree.
  run('npm', ['run', 'verify']);

  git(['add', '-A']);
  git(['commit', '-m', `chore(release): ${tag}`]);
  git(['tag', '-a', tag, '-m', tag]);
  git(['push', 'origin', 'master']);
  git(['push', 'origin', tag]);

  console.log(`release: ${tag} pushed. Install with:`);
  console.log(`  pnpm add "github:tenyearnotdream/dsh-archctrl#${tag}"`);
}

main();
