// Bringing a repository into the tree: reading a hand-written document, and
// scaffolding a repository that has none.
//
// The failure this file exists for: a mature tree whose documents state their
// boundaries in prose reported 273 errors on first open, because the plugin
// could not tell a link to source code from a link to a sibling contract, and
// had no way to propose the scope the documents were already describing.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import {
  applyOwnershipAnswers,
  contestedPaths,
  ownershipQuestions,
  proposalModules,
  proposeFrontmatter,
  readTree,
  renderFrontmatter,
  scaffoldContract,
  scaffoldPath,
  withFrontmatter,
  checkTree,
} from '../dist/host/index.js';

/** A repository whose tree was written by hand: prose boundaries, no scope. */
function handWrittenRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'archctrl-onboard-'));
  const files = {
    '.archctrl/arch.md': '# Root\n\nSee [storage](storage/arch.md).\n',
    '.archctrl/storage/arch.md':
      '# Storage\n\nState lives in [schema.go](../../internal/dao/schema.go).\n\nThe cache is [store](../../internal/store/store.go).\n',
    // A supplement beside a contract: part of the tree, no scope of its own.
    '.archctrl/storage/migrations.md': '# Migrations\n\nSee [sql](../../resource/dbs/migrations).\n',
    'internal/dao/schema.go': 'package dao\n',
    'internal/store/store.go': 'package store\n',
    'resource/dbs/migrations/0001.sql': 'select 1;\n',
  };
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('a link to source code is a reference, not a broken contract link', () => {
  const repo = handWrittenRepo();
  try {
    const tree = readTree(repo.dir);
    assert.ok(tree !== null);
    const checked = checkTree(tree);
    // Before this was fixed every code link was reported as a broken link.
    assert.deepEqual(checked.errors, []);
  } finally {
    repo.cleanup();
  }
});

test('a supplement beside a contract is part of the tree', () => {
  const repo = handWrittenRepo();
  try {
    const tree = readTree(repo.dir);
    assert.ok(tree !== null);
    const supplement = tree.contracts.find((c) => c.contract === 'storage/migrations.md');
    assert.ok(supplement !== undefined, 'the supplement must be read');
    // It sits in `storage`, so it reports that module, but claims nothing.
    assert.equal(supplement.module, 'storage');
    assert.deepEqual(supplement.owns, []);
  } finally {
    repo.cleanup();
  }
});

test('scope is derived from what the document already cites', () => {
  const repo = handWrittenRepo();
  try {
    const tree = readTree(repo.dir);
    assert.ok(tree !== null);
    const proposals = proposeFrontmatter(tree);
    const storage = proposals.find((p) => p.contract === 'storage/arch.md');
    assert.ok(storage !== undefined);
    // A file becomes the directory that governs it.
    assert.deepEqual([...storage.owns].sort(), ['internal/dao', 'internal/store']);
  } finally {
    repo.cleanup();
  }
});

test('a proposal never claims documentation or tooling directories', () => {
  const repo = handWrittenRepo();
  try {
    const tree = readTree(repo.dir);
    assert.ok(tree !== null);
    for (const proposal of proposeFrontmatter(tree)) {
      for (const owned of proposal.owns) {
        assert.match(owned, /^(internal|app|frontend|web|cmd|resource|scripts|lib|pkg)\//);
      }
    }
  } finally {
    repo.cleanup();
  }
});

test('a nested path is dropped when its parent is already claimed', () => {
  const repo = handWrittenRepo();
  try {
    const tree = readTree(repo.dir);
    assert.ok(tree !== null);
    for (const proposal of proposeFrontmatter(tree)) {
      for (const owned of proposal.owns) {
        const parent = owned.slice(0, owned.lastIndexOf('/'));
        assert.equal(
          proposal.owns.includes(parent),
          false,
          `${owned} is claimed together with its parent ${parent}`,
        );
      }
    }
  } finally {
    repo.cleanup();
  }
});

test('frontmatter renders a block the parser reads back', () => {
  const block = renderFrontmatter(['internal/dao'], ['platform']);
  const source = withFrontmatter('# Title\n\nbody\n', block);
  assert.ok(source.startsWith('---\n'));
  assert.match(source, /owns:\n {2}- internal\/dao/);
  assert.match(source, /depends:\n {2}- platform/);
  assert.match(source, /# Title/);
});

test('withFrontmatter leaves an already-declared document alone', () => {
  const existing = '---\nowns:\n  - a\n---\n\n# T\n';
  assert.equal(withFrontmatter(existing, renderFrontmatter(['b'])), existing);
});

test('scaffolding chooses directories the repository itself made', () => {
  const repo = handWrittenRepo();
  try {
    const modules = proposalModules(repo.dir);
    const names = modules.map((m) => m.module);
    assert.ok(names.includes('store'), `expected a store module, got ${names.join(',')}`);
    // `internal/dao` is a generated area: it follows its owners and never carries
    // a decision of its own, so a scaffold must not offer it.
    assert.equal(names.includes('dao'), false);
  } finally {
    repo.cleanup();
  }
});

test('a scaffold states no rule the repository has not decided', () => {
  const text = scaffoldContract('storage', ['internal/dao']);
  // Boundaries and prompts only: an invented rule is a decision nobody made.
  assert.match(text, /^---\n/);
  assert.match(text, /owns:\n {2}- internal\/dao/);
  assert.match(text, /Scaffolded by archctrl/);
  assert.equal(/must |禁止|不得 [a-z]/.test(text.replace(/^>.*$/gm, '')), false);
});

test('scaffold paths stay inside .archctrl', () => {
  assert.equal(scaffoldPath(''), '.archctrl/arch.md');
  assert.equal(scaffoldPath('storage'), '.archctrl/storage/arch.md');
});

// ---------------------------------------------------------------------------
// Conflicts
//
// A citation says a document mentions a path; ownership says one document
// decides it. Deriving from citations alone put five contracts on one startup
// file, so the ambiguous paths are separated and handed to a reader.
// ---------------------------------------------------------------------------

/** Two contracts mention one file; only one of them states a rule about it. */
function contestedRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'archctrl-contested-'));
  const files = {
    '.archctrl/startup/arch.md':
      '# Startup\n\n启动顺序由本契约规定，见 [boot](../../internal/middleware/auth.go)。\n',
    '.archctrl/reference/arch.md':
      '# Reference\n\n本契约只提到 [auth](../../internal/middleware/auth.go) 作为参考。\n',
    'internal/middleware/auth.go': 'package middleware\n',
  };
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('a path two contracts would claim is reported as contested', () => {
  const repo = contestedRepo();
  try {
    const tree = readTree(repo.dir);
    assert.ok(tree !== null);
    const contested = contestedPaths(proposeFrontmatter(tree));
    assert.deepEqual(contested, [
      { path: 'internal/middleware', contracts: ['reference/arch.md', 'startup/arch.md'] },
    ]);
  } finally {
    repo.cleanup();
  }
});

test('the evidence carries the sentence that mentions the path', () => {
  const repo = contestedRepo();
  try {
    const tree = readTree(repo.dir);
    assert.ok(tree !== null);
    const questions = ownershipQuestions(tree, contestedPaths(proposeFrontmatter(tree)), 2);
    const startup = questions[0].candidates.find((c) => c.module === 'startup');
    assert.ok(startup !== undefined);
    // The document's own title and the line naming the path: that is what tells
    // "this contract decides it" from "this contract refers to it".
    assert.equal(startup.title, 'Startup');
    assert.match(startup.excerpt, /启动顺序由本契约规定/);
  } finally {
    repo.cleanup();
  }
});

test('the model answer removes the path from every other proposal', () => {
  const proposals = [
    { module: 'startup', contract: 'startup/arch.md', owns: ['internal/middleware'], unresolved: [] },
    { module: 'reference', contract: 'reference/arch.md', owns: ['internal/middleware'], unresolved: [] },
  ];
  const merged = applyOwnershipAnswers(proposals, [
    { path: 'internal/middleware', module: 'startup', because: 'states the startup rule' },
  ]);
  assert.deepEqual(merged[0].owns, ['internal/middleware']);
  // Two contracts on one path is an error that blocks the tree; an unowned path
  // is a warning the author can act on.
  assert.deepEqual(merged[1].owns, []);
});

test('an answer of null removes the path everywhere', () => {
  const proposals = [
    { module: 'a', contract: 'a/arch.md', owns: ['internal/x'], unresolved: [] },
    { module: 'b', contract: 'b/arch.md', owns: ['internal/x'], unresolved: [] },
  ];
  const merged = applyOwnershipAnswers(proposals, [{ path: 'internal/x', module: null, because: 'nobody decides it' }]);
  assert.deepEqual(merged.map((p) => p.owns), [[], []]);
});

test('undecided paths are left alone', () => {
  const proposals = [{ module: 'a', contract: 'a/arch.md', owns: ['internal/x'], unresolved: [] }];
  const merged = applyOwnershipAnswers(proposals, []);
  assert.deepEqual(merged[0].owns, ['internal/x']);
});
