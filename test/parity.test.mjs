// The plugin's own rules: frontmatter parsing, ownership resolution, and the
// reading log. These run without DSH, against a throwaway repository.

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { checkTree, impact, markRead, parseFrontmatter, readModules, readTree } from '../dist/host/index.js';

function repoWith(files) {
  const dir = mkdtempSync(join(tmpdir(), 'archctrl-'));
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    if (content === '') mkdirSync(full, { recursive: true });
    else writeFileSync(full, content);
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const fm = (owns, depends = [], verifies = []) =>
  `---\nowns:\n${owns.map((o) => `  - ${o}`).join('\n')}\ndepends: [${depends.join(', ')}]\nverifies: [${verifies.join(', ')}]\n---\n\n# module\n`;

test('frontmatter block lists and inline lists parse the same', () => {
  const block = parseFrontmatter('---\nowns:\n  - a\n  - b\ndepends: [c]\nverifies: []\n---\nbody');
  assert.deepEqual(block.owns, ['a', 'b']);
  assert.deepEqual(block.depends, ['c']);
  assert.deepEqual(block.verifies, []);
  assert.equal(block.body.trim(), 'body');

  const inline = parseFrontmatter('---\nowns: [a, b]\ndepends: []\nverifies: []\n---\nbody');
  assert.deepEqual(inline.owns, ['a', 'b']);
});

test('a contract without frontmatter is body-only, not an error', () => {
  const parsed = parseFrontmatter('# just a document\n');
  assert.deepEqual(parsed.owns, []);
  assert.equal(parsed.problem, undefined);
});

test('an unclosed frontmatter block is reported', () => {
  assert.match(parseFrontmatter('---\nowns: [a]\n').problem, /not closed/);
});

test('an unknown frontmatter key is reported rather than dropped', () => {
  assert.match(parseFrontmatter('---\nowns: [a]\nowner: [b]\n---\nx').problem, /unknown frontmatter key/);
});

test('directory layout is the module hierarchy', () => {
  const repo = repoWith({
    '.archctrl/arch.md': fm(['.archctrl']),
    '.archctrl/project/arch.md': fm(['internal/logic/project']),
    '.archctrl/platform/arch.md': fm(['internal/cmd']),
    '.archctrl/platform/http/arch.md': fm(['internal/cmd/routes']),
    'internal/logic/project': '',
    'internal/cmd': '',
    'internal/cmd/routes': '',
  });
  try {
    const tree = readTree(repo.dir);
    assert.deepEqual(
      tree.contracts.map((c) => c.module).sort((a, b) => String(a).localeCompare(String(b))),
      [null, 'platform', 'platform/http', 'project'],
    );
    assert.equal(tree.owners.get('internal/cmd/routes'), 'platform/http');
  } finally {
    repo.cleanup();
  }
});

test('the deepest owner wins, and a parent does not also claim the child', () => {
  const repo = repoWith({
    '.archctrl/arch.md': fm([]),
    '.archctrl/html/arch.md': fm(['internal/html']),
    '.archctrl/html/form/arch.md': fm(['internal/html/form']),
    'internal/html': '',
    'internal/html/form': '',
  });
  try {
    const tree = readTree(repo.dir);
    assert.equal(impact(tree, ['internal/html/form/a.go']).modules[0].module, 'html/form');
    assert.equal(impact(tree, ['internal/html/b.go']).modules[0].module, 'html');
  } finally {
    repo.cleanup();
  }
});

test('two contracts claiming one path is an error', () => {
  const repo = repoWith({
    '.archctrl/arch.md': fm([]),
    '.archctrl/a/arch.md': fm(['internal/shared']),
    '.archctrl/b/arch.md': fm(['internal/shared']),
    'internal/shared': '',
  });
  try {
    const tree = readTree(repo.dir);
    assert.equal(tree.conflicts.length, 1);
    assert.ok(checkTree(tree).errors.some((e) => e.rule === 'shared-ownership'));
  } finally {
    repo.cleanup();
  }
});

test('owning a path that does not exist is an error', () => {
  const repo = repoWith({ '.archctrl/arch.md': fm(['internal/ghost']) });
  try {
    const tree = readTree(repo.dir);
    assert.ok(checkTree(tree).errors.some((e) => e.rule === 'stale-ownership'));
  } finally {
    repo.cleanup();
  }
});

test('a fully claimed container directory is not reported as unowned', () => {
  const repo = repoWith({
    '.archctrl/arch.md': fm([]),
    '.archctrl/a/arch.md': fm(['internal/group/one']),
    '.archctrl/b/arch.md': fm(['internal/group/two']),
    'internal/group/one': '',
    'internal/group/two': '',
  });
  try {
    const tree = readTree(repo.dir);
    assert.deepEqual(checkTree(tree).warnings, []);
  } finally {
    repo.cleanup();
  }
});

test('dependencies pull a module in transitively', () => {
  const repo = repoWith({
    '.archctrl/arch.md': fm([]),
    '.archctrl/app/arch.md': fm(['internal/app'], ['lib']),
    '.archctrl/lib/arch.md': fm(['internal/lib']),
    'internal/app': '',
    'internal/lib': '',
  });
  try {
    const tree = readTree(repo.dir);
    const result = impact(tree, ['internal/lib/x.go']);
    assert.deepEqual(result.modules.map((m) => m.module), ['lib']);
    assert.deepEqual(result.dependents, ['app']);
  } finally {
    repo.cleanup();
  }
});

test('the reading log is per session and forgets nothing within the process', () => {
  markRead('session-a', 'project');
  markRead('session-a', null);
  markRead('session-b', 'api');
  assert.deepEqual(readModules('session-a'), ['(root)', 'project']);
  assert.deepEqual(readModules('session-b'), ['api']);
  assert.deepEqual(readModules('session-never-seen'), []);
  markRead('', 'ignored');
  assert.deepEqual(readModules(''), []);
});

// --- stage three: document splitting and apply ---------------------------------

import { splitDocument } from '../dist/host/index.js';

test('splitDocument keeps frontmatter apart from the body the model may rewrite', () => {
  const doc = '---\nowns:\n  - internal/a\n---\n\n# module\n\nrule text\n';
  const { frontmatter, body } = splitDocument(doc);
  assert.equal(frontmatter, '---\nowns:\n  - internal/a\n---\n');
  assert.equal(body.trim(), '# module\n\nrule text');
});

test('splitDocument treats a document without frontmatter as all body', () => {
  const { frontmatter, body } = splitDocument('# plain\n');
  assert.equal(frontmatter, '');
  assert.equal(body, '# plain\n');
});

test('a document whose frontmatter is unclosed is treated as plain body', () => {
  const { frontmatter, body } = splitDocument('---\nowns: [a]\n# no close\n');
  assert.equal(frontmatter, '');
  assert.equal(body, '---\nowns: [a]\n# no close\n');
});

// --- apply: document-only commit ---------------------------------------------

import { execFileSync } from 'node:child_process';
import { writeFileSync as writeFile } from 'node:fs';
import { applyContract } from '../dist/host/index.js';

const gitInit = (dir) => {
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir });
};

const gitOut = (dir, args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();

test('apply commits only the contract, leaving code uncommitted', async () => {
  const repo = repoWith({
    '.archctrl/m/arch.md': '---\nowns:\n  - internal/m\n---\n\n# m\n\nrule one\n',
    'internal/m/a.go': 'package m\n',
  });
  try {
    gitInit(repo.dir);
    gitOut(repo.dir, ['add', '-A']);
    gitOut(repo.dir, ['commit', '-qm', 'init']);

    // A code change that must NOT be swept into the document commit.
    writeFile(join(repo.dir, 'internal/m/a.go'), 'package m\n\n// changed\n');

    const tree = readTree(repo.dir);
    const contract = tree.contracts.find((c) => c.module === 'm');
    const result = applyContract(tree, contract, '# m\n\nrule one revised\n');

    assert.match(result.message, /docs\(archctrl\): update m contract/);
    assert.equal(gitOut(repo.dir, ['show', '--name-only', '--format=', 'HEAD']), '.archctrl/m/arch.md');
    assert.equal(gitOut(repo.dir, ['status', '--porcelain']).includes('internal/m/a.go'), true);
  } finally {
    repo.cleanup();
  }
});

test('apply preserves frontmatter byte-for-byte', () => {
  const repo = repoWith({
    '.archctrl/m/arch.md': '---\nowns:\n  - internal/m\ndepends:\n  - api\n---\n\n# m\n\nold\n',
    'internal/m/a.go': '',
  });
  try {
    gitInit(repo.dir);
    gitOut(repo.dir, ['add', '-A']);
    gitOut(repo.dir, ['commit', '-qm', 'init']);
    const tree = readTree(repo.dir);
    const contract = tree.contracts.find((c) => c.module === 'm');
    applyContract(tree, contract, '# m\n\nnew\n');
    const after = readFileSync(join(repo.dir, '.archctrl/m/arch.md'), 'utf8');
    assert.equal(after, '---\nowns:\n  - internal/m\ndepends:\n  - api\n---\n# m\n\nnew\n');
  } finally {
    repo.cleanup();
  }
});

// --- stage three: judging a contract ------------------------------------------

import { judgeContract } from '../dist/host/index.js';

const mockLLM = (text) => ({
  calls: [],
  async prepareCall(config) {
    const calls = this.calls;
    return {
      config,
      async *stream(options) {
        calls.push(options);
        yield { type: 'text-delta', text };
        yield { type: 'finish', reason: { kind: 'stop' } };
      },
    };
  },
});

function judgeFixture() {
  return repoWith({
    '.archctrl/m/arch.md': '---\nowns:\n  - internal/m\n---\n\n# m\n\n禁止原生 confirm。\n',
    'internal/m/a.go': '',
  });
}

test('the prompt carries the body and never the frontmatter', async () => {
  const repo = judgeFixture();
  try {
    const tree = readTree(repo.dir);
    const contract = tree.contracts.find((c) => c.module === 'm');
    const llm = mockLLM('{"change": false, "reason": "ok"}');
    await judgeContract(llm, { provider: 'p', model: 'm' }, tree, contract, 'diff', undefined);
    const sent = llm.calls[0].messages[0].content[0].text;
    assert.match(sent, /禁止原生 confirm/);
    assert.doesNotMatch(sent, /owns:/);
    assert.match(llm.calls[0].system, /not a changelog/);
  } finally {
    repo.cleanup();
  }
});

test('a refusal is a first-class answer', async () => {
  const repo = judgeFixture();
  try {
    const tree = readTree(repo.dir);
    const contract = tree.contracts.find((c) => c.module === 'm');
    const result = await judgeContract(mockLLM('{"change": false, "reason": "契约仍然成立"}'), { provider: 'p', model: 'm' }, tree, contract, '', undefined);
    assert.equal(result.change, false);
    assert.equal(result.body, undefined);
  } finally {
    repo.cleanup();
  }
});

test('a change proposal carries the replacement body', async () => {
  const repo = judgeFixture();
  try {
    const tree = readTree(repo.dir);
    const contract = tree.contracts.find((c) => c.module === 'm');
    const result = await judgeContract(
      mockLLM('{"change": true, "reason": "规则变了", "basis": "禁止原生 confirm。", "body": "# m\\n\\n新的规则\\n"}'),
      { provider: 'p', model: 'm' },
      tree,
      contract,
      '',
      undefined,
    );
    assert.equal(result.change, true);
    assert.match(result.body, /新的规则/);
    assert.equal(result.basis, '禁止原生 confirm。');
  } finally {
    repo.cleanup();
  }
});

test('an answer without JSON fails instead of being read as approval', async () => {
  const repo = judgeFixture();
  try {
    const tree = readTree(repo.dir);
    const contract = tree.contracts.find((c) => c.module === 'm');
    await assert.rejects(
      () => judgeContract(mockLLM('看起来没问题'), { provider: 'p', model: 'm' }, tree, contract, '', undefined),
      /did not answer with JSON/,
    );
  } finally {
    repo.cleanup();
  }
});

test('an answer without a boolean change fails', async () => {
  const repo = judgeFixture();
  try {
    const tree = readTree(repo.dir);
    const contract = tree.contracts.find((c) => c.module === 'm');
    await assert.rejects(
      () => judgeContract(mockLLM('{"reason": "..."}'), { provider: 'p', model: 'm' }, tree, contract, '', undefined),
      /no boolean "change"/,
    );
  } finally {
    repo.cleanup();
  }
});

test('JSON wrapped in prose is still read', async () => {
  const repo = judgeFixture();
  try {
    const tree = readTree(repo.dir);
    const contract = tree.contracts.find((c) => c.module === 'm');
    const result = await judgeContract(mockLLM('Sure: {"change": false, "reason": "ok"} — done'), { provider: 'p', model: 'm' }, tree, contract, '', undefined);
    assert.equal(result.change, false);
  } finally {
    repo.cleanup();
  }
});
