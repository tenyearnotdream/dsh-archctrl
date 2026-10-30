# archctrl

Architecture contracts as the design language for a repository: a DSH plugin that
turns `.archctrl/` into a checkable, navigable design layer.

The plugin is a **tool, not a component**. It is not part of your project, adds no
file to it, and writes nothing back. Uninstalling it leaves the repository
byte-identical — everything it knows is re-derived from the documents.

## The data model

A directory is a module; `arch.md` inside it is that module's contract:

```
.archctrl/arch.md                  -> the root index
.archctrl/project/arch.md          -> module "project"
.archctrl/platform/http/arch.md    -> module "platform/http"
```

Ownership is declared in each contract's own frontmatter, so the project needs no
file that exists only for this plugin:

```markdown
---
owns:
  - internal/logic/project
  - internal/logic/canvas
depends: [api, storage]
verifies: [test/backend/workflowcontract]
---

# project
```

| Key | Meaning |
|---|---|
| `owns` | repository paths this contract governs. The deepest claim wins, so `web` can own `web/src` while `web/ui` owns `web/src/components`. |
| `depends` | modules this one depends on; used for transitive impact. |
| `verifies` | tests that hold this contract's invariants. |

Two contracts claiming one path is an error, not a precedence rule.

## What it costs per turn

One constant prompt section, ~130 tokens. Nothing else is injected: the rest is
read on demand, which is the difference between paying 11k every turn and paying
700–3,200 for the one module a task actually changes.

## Tools

| Tool | When | Cost |
|---|---|---|
| `arch_impact(paths)` | before editing code | one call; replaces "grep around and guess which contract applies" |
| `arch_contract(module)` | when the detail is needed | the contract's own token count |
| `arch_check()` | before asking a human to update a document | free, deterministic |
| `arch_review(base)` | when the human presses the button | free, deterministic |

`arch_review` is the manual trigger. Reviewing every commit would spend attention
on changes that never touch an invariant, and partial commits during a feature
branch are exactly when the answer is "not yet".

### The third stage: asking the model

`arch_review` deliberately stops at evidence. It can prove that a module's code
changed while its contract did not; it cannot decide whether a rule was violated,
because that is a reading of intent.

**Ask model** spends one call on exactly that question, with the model this
conversation is already talking to. **Judge all** runs the same question over
every involved module in sequence — sequential because a burst of concurrent
requests against one provider is how a batch turns into rate limits, and because
one failure must not hide the rest.

The prompt is constrained against the failure mode that ruins contract trees:

> Report a change ONLY when the diff touches a rule the contract states
> explicitly, that rule is now false, incomplete or needs an exception, and you
> can quote the line that must change. Never propose edits to record that work
> happened: a contract is a set of decisions, not a changelog.

A refusal is a first-class answer. A proposal returns the complete new body, and
**Apply and commit** writes it and commits only that document:

```
fe88049  docs(archctrl): update m contract   <- the document
(working tree)  M internal/m/a.go            <- your code, still uncommitted
```

Frontmatter is never sent to the model and never overwritten.

## The three surfaces

| Surface | What it is for |
|---|---|
| **Main panel** | The full page: tree, detail, overview, and the review flow. |
| **Right rail** | The working view beside the conversation: `Active` (contracts this session has read) and `All`. |
| **Composer strip** | `arch 2/15 · 4146 tok` — how much architecture this session has loaded. |

The tree is always fully expanded: the hierarchy is fixed and shallow, and
collapsing it would hide the sibling a reader is comparing against.

## Bringing a repository in

A tree that was written by hand before this plugin existed states its boundaries
in prose. The plugin cannot read prose, so on first open every code link looks
like a broken contract link and no path belongs to any module. Three states get
three answers, and none of them writes until you press a button:

| State | What it means | What the panel offers |
|---|---|---|
| **empty** | no `.archctrl` at all | a scaffold: one contract per source directory the repository already has |
| **undeclared** | documents exist, no `owns:` | scope derived from what each document already cites |
| **declared** | every contract states its scope | nothing to do |

### Scope from citations

A contract that links to `internal/middleware/auth.go` plainly intends to govern
that code, so the tool records a decision the author already made. A file becomes
the directory that holds it, and a nested path is dropped when its parent is
already claimed.

### Conflicts go to the model

A citation says a document **mentions** a path; ownership says one document
**decides** it. Deriving from citations alone put five contracts on one startup
file — all of them legitimately mention startup. `Propose scope (model resolves
conflicts)` sends only the contested paths, with the sentence that names them:

```
PATH: internal/middleware
  - startup: Startup
    启动顺序由本契约规定，见 ../../internal/middleware/auth.go
  - reference: Reference
    本契约只提到 ../../internal/middleware/auth.go 作为参考
```

That is a reading of intent, which is what a model is for and what a regex is
not. The cost is proportional to the ambiguity, not the size of the tree.

A conflict left unresolved is reported rather than guessed: an unowned path is a
warning the author can act on, while a path two contracts both claim is an error
that blocks the whole tree.

### Repair never invents a rule

- Frontmatter is derived, never authored: the `owns:` block is written above the
  existing body, which is untouched.
- A scaffold ships boundaries with **no rules in them** — prompts such as
  "这个模块负责什么、不负责什么？" — because a contract invented by a tool is a rule
  nobody decided.
- Both are proposals first. Writing is a separate, explicit action, and each one
  commits alone so a reviewer can read it by itself.

## Development

```bash
npm install
npm run check      # typecheck + host tests + component tests
npm run verify     # check, then build
npm run dev        # rebuild the Client bundle on change
```

### Layout

```
src/host/      the Host half, bundled to dist/host/index.js (esbuild, ESM)
src/client/    the React half, bundled to dist/client/client.js (Vite, single file)
src/shared/    the types both halves import
test/          Host and bundle tests (node --test)
src/**/__tests__/   component tests (vitest + testing-library)
```

### Two gates, each catching what the other misses

| Gate | Catches |
|---|---|
| `tsc --noEmit` (strict, `noUncheckedIndexedAccess`) | a helper a refactor deleted but still called — `TS2304: Cannot find name` is the failure this was added for |
| `node --test test/*.test.mjs` | a route that mounts but cannot answer (it sends real `Request`s), and a bundle that is not a classic script |
| `vitest` | a component that throws on render |

The bundle test executes `dist/client/client.js` the way the browser does — a
plain `<script>`, then the factory — because the loader serves bundles as
**classic scripts**. A top-level `import` is a syntax error there and nowhere
else, which is why that check lives at the artefact level.

### Build constraints worth knowing

- The Host half is bundled by **esbuild** to one ESM file. `@deepseek-ai/*` stay
  external: they are resolved by the running Host, never shipped beside it.
- The Client half is bundled by **Vite** to one IIFE inside the loader's factory.
  `react` / `react-dom` / `react/jsx-runtime` are read from the factory's
  `require`, so the page keeps the shell's single React.
- Tailwind's output is inlined into that same JS file, because the loader fetches
  exactly one URL; a separate CSS asset would never be applied.
- Colours come only from `--dsw-alias-*` tokens, mapped to utilities in
  `src/client/index.css`, so light and dark both follow the Host.

## Limits

- The panel reads a **registered workspace**, not the open Session: a `main`
  panel has no Session, and the Host's own start directory is whichever
  repository launched `dsh`. The header names the repository being read.
- Drift detection is file-level. It reports "this module's code changed and its
  contract did not" and stops there; whether an invariant moved is a review
  judgement.
- Changing the Client bundle requires restarting `dsh web`: the module table is
  scanned at boot.
