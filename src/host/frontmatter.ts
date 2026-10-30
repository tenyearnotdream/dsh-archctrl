/**
 * The contract tree is the whole input: a directory is a module and `arch.md`
 * inside it is that module's contract. Ownership is declared in each contract's
 * own frontmatter, so the repository needs no file that exists only for this
 * plugin.
 *
 * ```
 * .archctrl/arch.md                 -> the root index, module null
 * .archctrl/project/arch.md         -> module "project"
 * .archctrl/platform/http/arch.md   -> module "platform/http"
 * ```
 */

/** What a contract declares about itself. */
export interface ContractScope {
  /** Repository-relative paths this contract governs. */
  readonly owns: readonly string[];
  /** Modules this one depends on; used for transitive impact. */
  readonly depends: readonly string[];
  /** Tests that hold this contract's invariants. */
  readonly verifies: readonly string[];
}

export interface Frontmatter extends ContractScope {
  /** Everything after the closing `---`, unmodified. */
  readonly body: string;
  /** A malformed declaration, reported rather than ignored. */
  readonly problem?: string;
}

const EMPTY_SCOPE: ContractScope = { owns: [], depends: [], verifies: [] };

const LIST_KEYS = new Set(['owns', 'depends', 'verifies']);

/**
 * Read the YAML subset a contract needs: three list keys, each either `[]`
 * inline or a block of `- item` lines.
 *
 * A full YAML parser would be a dependency for a document format this plugin
 * also owns the shape of. Unknown keys are reported instead of dropped, so a
 * typo cannot silently remove a module's ownership.
 */
export function parseFrontmatter(source: string): Frontmatter {
  if (!source.startsWith('---\n')) return { ...EMPTY_SCOPE, body: source };

  const end = source.indexOf('\n---\n', 4);
  if (end < 0) {
    return { ...EMPTY_SCOPE, body: source, problem: 'frontmatter is not closed with a --- line' };
  }

  const head = source.slice(4, end);
  const body = source.slice(end + 5);
  const lists: Record<string, string[]> = { owns: [], depends: [], verifies: [] };
  let problem: string | undefined;
  let field: string | null = null;

  const unquote = (value: string): string => value.trim().replace(/^["']|["']$/g, '');

  for (const rawLine of head.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;

    const inline = /^([a-z]+):\s*\[(.*)\]$/.exec(line);
    if (inline !== null) {
      const key = inline[1] ?? '';
      const inner = inline[2] ?? '';
      if (!LIST_KEYS.has(key)) {
        problem ??= `unknown frontmatter key "${key}"`;
        continue;
      }
      const list: string[] = inner
        .split(',')
        .map(unquote)
        .filter((item) => item !== '');
      lists[key] = list;
      field = null;
      continue;
    }

    const block = /^([a-z]+):\s*$/.exec(line);
    if (block !== null) {
      const key = block[1] ?? '';
      if (!LIST_KEYS.has(key)) {
        problem ??= `unknown frontmatter key "${key}"`;
        field = null;
        continue;
      }
      lists[key] = [];
      field = key;
      continue;
    }

    const item = /^-\s+(.*)$/.exec(line);
    if (item !== null && field !== null) {
      const target = lists[field];
      if (target !== undefined) target.push(unquote(item[1] ?? ''));
      continue;
    }

    problem ??= `unreadable frontmatter line: ${line}`;
  }

  return {
    owns: lists.owns ?? [],
    depends: lists.depends ?? [],
    verifies: lists.verifies ?? [],
    body,
    ...(problem === undefined ? {} : { problem }),
  };
}

/** Split a document so a writer can replace the body and keep the declaration. */
export function splitDocument(text: string): { frontmatter: string; body: string } {
  if (!text.startsWith('---\n')) return { frontmatter: '', body: text };
  const end = text.indexOf('\n---\n', 4);
  if (end < 0) return { frontmatter: '', body: text };
  return { frontmatter: text.slice(0, end + 5), body: text.slice(end + 5) };
}
