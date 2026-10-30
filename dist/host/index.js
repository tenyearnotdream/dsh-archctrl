// src/host/index.ts
import { existsSync as existsSync4, readFileSync as readFileSync5 } from "node:fs";
import { join as join6 } from "node:path";

// src/host/check.ts
import { existsSync as existsSync2, readdirSync as readdirSync2 } from "node:fs";
import { join as join2, sep as sep2 } from "node:path";

// src/host/tree.ts
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, normalize, relative, sep } from "node:path";

// src/host/frontmatter.ts
var EMPTY_SCOPE = { owns: [], depends: [], verifies: [] };
var LIST_KEYS = /* @__PURE__ */ new Set(["owns", "depends", "verifies"]);
function parseFrontmatter(source) {
  if (!source.startsWith("---\n")) return { ...EMPTY_SCOPE, body: source };
  const end = source.indexOf("\n---\n", 4);
  if (end < 0) {
    return { ...EMPTY_SCOPE, body: source, problem: "frontmatter is not closed with a --- line" };
  }
  const head = source.slice(4, end);
  const body = source.slice(end + 5);
  const lists = { owns: [], depends: [], verifies: [] };
  let problem;
  let field = null;
  const unquote = (value) => value.trim().replace(/^["']|["']$/g, "");
  for (const rawLine of head.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const inline = /^([a-z]+):\s*\[(.*)\]$/.exec(line);
    if (inline !== null) {
      const key = inline[1] ?? "";
      const inner = inline[2] ?? "";
      if (!LIST_KEYS.has(key)) {
        problem ??= `unknown frontmatter key "${key}"`;
        continue;
      }
      const list = inner.split(",").map(unquote).filter((item2) => item2 !== "");
      lists[key] = list;
      field = null;
      continue;
    }
    const block = /^([a-z]+):\s*$/.exec(line);
    if (block !== null) {
      const key = block[1] ?? "";
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
      if (target !== void 0) target.push(unquote(item[1] ?? ""));
      continue;
    }
    problem ??= `unreadable frontmatter line: ${line}`;
  }
  return {
    owns: lists.owns ?? [],
    depends: lists.depends ?? [],
    verifies: lists.verifies ?? [],
    body,
    ...problem === void 0 ? {} : { problem }
  };
}
function splitDocument(text) {
  if (!text.startsWith("---\n")) return { frontmatter: "", body: text };
  const end = text.indexOf("\n---\n", 4);
  if (end < 0) return { frontmatter: "", body: text };
  return { frontmatter: text.slice(0, end + 5), body: text.slice(end + 5) };
}

// src/host/tree.ts
var PATH_PREFIXES = /^(internal|test|web|resource|docs|api|cmd|scripts|hack|plugins)\//;
var SKIP_PATTERNS = /[*{]/;
function toPosix(path) {
  return path.split(sep).join("/");
}
function git(root, args) {
  try {
    return execFileSync("git", [...args], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    }).trim();
  } catch {
    return null;
  }
}
function listContractFiles(archDir) {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith(".md")) {
        found.push({ path: full, primary: entry.name === "arch.md" });
      }
    }
  };
  walk(archDir);
  return found.sort((a, b) => a.path.localeCompare(b.path));
}
function moduleOfContract(relativePath, primary) {
  if (!primary) {
    const slash = relativePath.lastIndexOf("/");
    return slash < 0 ? null : relativePath.slice(0, slash);
  }
  return relativePath === "arch.md" ? null : relativePath.slice(0, -"/arch.md".length);
}
function approximateTokens(text) {
  const cjk = (text.match(/[\u3400-\u9fff]/g) ?? []).length;
  return Math.round(cjk + (text.length - cjk) / 3.6);
}
function referencedPaths(text) {
  const out = /* @__PURE__ */ new Set();
  for (const match of text.matchAll(/`([^`\n]+)`/g)) {
    const token = (match[1] ?? "").trim();
    if (SKIP_PATTERNS.test(token) || token.includes("NNNNNN")) continue;
    const word = token.split(/\s+/).find((candidate) => PATH_PREFIXES.test(candidate));
    if (word === void 0) continue;
    out.add(word.replace(/\/+$/, ""));
  }
  return [...out];
}
function lastCommitOf(root, contractPath) {
  const out = git(root, ["log", "-1", "--format=%H%x09%ct%x09%s", "--", contractPath]);
  if (out === null || out === "") return null;
  const [hash, time, subject] = out.split("	");
  if (hash === void 0 || time === void 0) return null;
  return { hash, time: Number(time), subject: subject ?? "" };
}
function readTree(root) {
  const archDir = join(root, ".archctrl");
  if (!existsSync(archDir) || !statSync(archDir).isDirectory()) return null;
  const contracts = [];
  for (const { path: full, primary } of listContractFiles(archDir)) {
    const rel = toPosix(relative(archDir, full));
    const text = readFileSync(full, "utf8");
    const head = parseFrontmatter(text);
    const links = [];
    for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const target = (match[1] ?? "").split("#")[0] ?? "";
      if (target === "" || /^[a-z]+:/i.test(target)) continue;
      links.push(toPosix(relative(root, normalize(join(dirname(full), target)))));
    }
    const contractPath = toPosix(relative(root, full));
    contracts.push({
      module: moduleOfContract(rel, primary),
      contract: rel,
      path: contractPath,
      tokens: approximateTokens(head.body),
      bytes: Buffer.byteLength(text),
      owns: head.owns,
      depends: head.depends,
      verifies: head.verifies,
      ...head.problem === void 0 ? {} : { problem: head.problem },
      lastCommit: lastCommitOf(root, `.archctrl/${rel}`),
      refs: referencedPaths(text),
      links
    });
  }
  const owners = /* @__PURE__ */ new Map();
  const conflicts = [];
  for (const contract of contracts) {
    if (contract.owns.length === 0) continue;
    for (const owned of contract.owns) {
      const prior = owners.get(owned);
      if (prior !== void 0 && prior !== contract.module) {
        conflicts.push({ path: owned, modules: [String(prior), String(contract.module)] });
      } else {
        owners.set(owned, contract.module);
      }
    }
  }
  return { root, contracts, owners, conflicts };
}

// src/host/check.ts
var GENERATED = /* @__PURE__ */ new Set([
  "internal/dao",
  "internal/service",
  "internal/controller",
  "internal/lib"
]);
function matchesTail(root, citation) {
  const segments = citation.split("/").filter(Boolean);
  if (segments.length < 2) return false;
  const suffix = `/${citation}`;
  const walk = (dir, depth) => {
    if (depth > 4) return false;
    let entries;
    try {
      entries = readdirSync2(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries) {
      const full = join2(dir, entry.name);
      const rel = full.slice(root.length + 1).split(sep2).join("/");
      if ((rel === citation || rel.endsWith(suffix)) && (entry.isDirectory() || existsSync2(full))) {
        return true;
      }
      if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") {
        if (walk(full, depth + 1)) return true;
      }
    }
    return false;
  };
  return walk(root, 0);
}
function pathExists(root, path) {
  return existsSync2(join2(root, path)) || git(root, ["cat-file", "-e", `HEAD:${path}`]) !== null;
}
function effectiveOwns(tree, module) {
  const mine = tree.contracts.find((c) => c.module === module)?.owns ?? [];
  const deeper = tree.contracts.filter((c) => c.module !== module).flatMap((c) => c.owns);
  return mine.filter(
    (owned) => !deeper.some((other) => other !== owned && other.startsWith(`${owned}/`))
  );
}
function directoryCovered(root, rel, owned) {
  if (owned.some((p) => rel === p || rel.startsWith(`${p}/`))) return true;
  if (!existsSync2(join2(root, rel))) return false;
  let children;
  try {
    children = readdirSync2(join2(root, rel), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => `${rel}/${entry.name}`);
  } catch {
    return false;
  }
  if (children.length === 0) return false;
  return children.every((child) => owned.some((p) => child === p || child.startsWith(`${p}/`)));
}
function checkTree(tree) {
  const errors = [];
  const warnings = [];
  const hints = [];
  const byPath = new Map(tree.contracts.map((contract) => [contract.path, contract]));
  for (const conflict of tree.conflicts) {
    errors.push({
      rule: "shared-ownership",
      path: conflict.path,
      message: `${conflict.path} is claimed by both "${conflict.modules[0]}" and "${conflict.modules[1]}"`
    });
  }
  for (const contract of tree.contracts) {
    if (contract.problem !== void 0) {
      errors.push({ rule: "frontmatter", contract: contract.path, message: contract.problem });
    }
    for (const link of contract.links) {
      if (link.startsWith(".archctrl/")) {
        if (!byPath.has(link)) {
          errors.push({
            rule: "broken-link",
            contract: contract.path,
            message: `links to missing contract ${link}`
          });
        }
        continue;
      }
      if (!pathExists(tree.root, link)) {
        errors.push({
          rule: "stale-reference",
          contract: contract.path,
          message: `links to ${link}, which no longer exists`
        });
      }
    }
    for (const owned2 of contract.owns) {
      if (!pathExists(tree.root, owned2)) {
        errors.push({
          rule: "stale-ownership",
          contract: contract.path,
          message: `owns ${owned2}, which does not exist`
        });
      }
    }
    for (const ref of contract.refs) {
      if (pathExists(tree.root, ref) || matchesTail(tree.root, ref)) continue;
      errors.push({
        rule: "stale-reference",
        contract: contract.path,
        message: `references ${ref}, which no longer exists`
      });
    }
  }
  for (const contract of tree.contracts) {
    if (contract.module === null) continue;
    const since = contract.lastCommit?.time ?? 0;
    let commits = 0;
    for (const owned2 of effectiveOwns(tree, contract.module)) {
      const out = git(tree.root, ["rev-list", "--count", `--since=@${since}`, "HEAD", "--", owned2]);
      if (out !== null && out !== "") commits += Number(out);
    }
    if (commits > 0) {
      hints.push({ module: contract.module, contract: contract.path, commits });
    }
  }
  const owned = [...tree.owners.keys()];
  for (const top of ["internal", "web/src"]) {
    const base = join2(tree.root, top);
    if (!existsSync2(base)) continue;
    for (const entry of readdirSync2(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const rel = `${top}/${entry.name}`;
      if (GENERATED.has(rel)) continue;
      if (!directoryCovered(tree.root, rel, owned)) {
        warnings.push({
          rule: "unowned-directory",
          path: rel,
          message: `${rel} is not claimed by any contract`
        });
      }
    }
  }
  return { errors, warnings, hints };
}

// src/host/impact.ts
import { normalize as normalize2 } from "node:path";
function ownerOf(tree, path) {
  let best = null;
  for (const [owned, module] of tree.owners) {
    if (path === owned || path.startsWith(`${owned}/`)) {
      if (best === null || owned.length > best.owned.length) best = { module, owned };
    }
  }
  return best;
}
function impact(tree, paths) {
  const hits = /* @__PURE__ */ new Map();
  const unmatched = [];
  for (const raw of paths) {
    const path = normalize2(raw).replace(/^\.\//, "");
    const owner = ownerOf(tree, path);
    if (owner === null) {
      unmatched.push(path);
      continue;
    }
    const existing = hits.get(owner.module);
    if (existing === void 0) hits.set(owner.module, [path]);
    else existing.push(path);
  }
  const modules = [...hits.entries()].map(([module, hitPaths]) => ({
    module: String(module),
    paths: hitPaths
  }));
  const affected = /* @__PURE__ */ new Set();
  for (const hit of modules) {
    affected.add(hit.module);
    const segments = hit.module.split("/");
    while (segments.length > 1) {
      segments.pop();
      affected.add(segments.join("/"));
    }
  }
  let grew = true;
  while (grew) {
    grew = false;
    for (const contract of tree.contracts) {
      if (contract.module === null || affected.has(contract.module)) continue;
      if (contract.depends.some((dep) => affected.has(dep))) {
        affected.add(contract.module);
        grew = true;
      }
    }
  }
  for (const hit of modules) affected.delete(hit.module);
  return { modules, unmatched, dependents: [...affected].sort() };
}
function signatureLines(diff, limit = 40) {
  const out = [];
  for (const line of diff.split("\n")) {
    if (/^\+\s*(func|type|export|interface|class)\b/.test(line)) out.push(line.trim());
    if (out.length >= limit) break;
  }
  return out;
}
function reviewChanges(tree, base) {
  const range = `${base}...HEAD`;
  const read = (args) => git(tree.root, args) ?? "";
  const contractPaths = new Set(tree.contracts.map((c) => c.path));
  const changed = [
    ...new Set(
      [
        ...read(["diff", "--name-only", range]).split("\n"),
        ...read(["diff", "--name-only", "HEAD"]).split("\n"),
        ...read(["ls-files", "--others", "--exclude-standard"]).split("\n")
      ].map((line) => line.trim()).filter((line) => line !== "")
    )
  ];
  const code = changed.filter((p) => !contractPaths.has(p) && !p.startsWith(".archctrl/"));
  const contractsTouched = changed.filter((p) => contractPaths.has(p));
  const attribution = impact(tree, code);
  const checked = checkTree(tree);
  const byModule = new Map(tree.contracts.map((c) => [c.module, c]));
  const modules = attribution.modules.map((hit) => {
    const wanted = hit.module === "null" || hit.module === "" ? null : hit.module;
    const contract = byModule.get(wanted) ?? null;
    const stat = read(["diff", "--stat", range, "--", ...hit.paths]);
    const totals = stat.split("\n").find((line) => line.includes("changed")) ?? "";
    const cited2 = (contract?.refs ?? []).filter(
      (ref) => hit.paths.some((p) => p === ref || p.startsWith(`${ref}/`))
    );
    const lag = checked.hints.find((hint) => hint.module === hit.module);
    return {
      module: hit.module,
      contract: contract?.contract ?? null,
      contractTokens: contract?.tokens ?? 0,
      contractTouched: contract !== null && contractsTouched.includes(contract.path),
      paths: hit.paths,
      diffStat: totals.trim(),
      citesTouchedPaths: cited2,
      commitsSinceContract: lag?.commits ?? 0,
      verifies: contract?.verifies ?? [],
      depends: contract?.depends ?? []
    };
  });
  let signatures = [];
  if (attribution.modules.length > 0) {
    const owned = attribution.modules.flatMap((hit) => hit.paths);
    signatures = signatureLines(read(["diff", "-U0", range, "--", ...owned]));
  }
  const evidenceChars = JSON.stringify({ modules, signatureLines: signatures }).length;
  const stale = modules.filter((m) => !m.contractTouched && m.commitsSinceContract > 0);
  const cited = modules.filter((m) => m.citesTouchedPaths.length > 0);
  let verdict;
  if (modules.length === 0 && checked.errors.length === 0) {
    verdict = "no architectural surface changed";
  } else if (stale.length > 0) {
    verdict = "code changed in modules whose contracts were not updated";
  } else if (cited.length > 0) {
    verdict = "changed paths are cited by a contract; verify those invariants still hold";
  } else {
    verdict = "contracts involved; review the listed invariants";
  }
  return {
    base,
    changedFiles: changed.length,
    codeFiles: code.length,
    contractsTouched,
    modules,
    dependents: attribution.dependents,
    unmatched: attribution.unmatched,
    errors: checked.errors,
    warnings: checked.warnings,
    signatureLines: signatures,
    estimate: { evidenceTokens: Math.ceil(evidenceChars / 3.2) },
    verdict
  };
}

// src/host/routes.ts
import { mkdirSync, readFileSync as readFileSync4, writeFileSync as writeFileSync2 } from "node:fs";
import { dirname as dirname3, join as join5 } from "node:path";

// src/host/onboard.ts
import { existsSync as existsSync3, readFileSync as readFileSync2, readdirSync as readdirSync3, statSync as statSync2 } from "node:fs";
import { dirname as dirname2, join as join3, relative as relative2, resolve } from "node:path";
var CANDIDATE_ROOTS = ["internal", "app", "src", "cmd", "web/src", "frontend/src", "lib", "pkg"];
var GOVERNABLE = /^(internal|app|frontend|web|cmd|resource|scripts|lib|pkg|src)\//;
var IGNORED = /* @__PURE__ */ new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "vendor",
  "internal/dao",
  "internal/service",
  "internal/controller",
  "internal/packed"
]);
function governingDirectory(repoRoot, cited) {
  let candidate = cited.replace(/\/+$/, "");
  if (!GOVERNABLE.test(candidate)) return null;
  if (IGNORED.has(candidate)) return null;
  for (let depth = 0; depth < 4; depth += 1) {
    const full = join3(repoRoot, candidate);
    if (existsSync3(full)) {
      try {
        if (statSync2(full).isDirectory()) return candidate;
      } catch {
        return null;
      }
    }
    const parent = dirname2(candidate);
    if (parent === "." || parent === "") return null;
    candidate = toPosix(parent);
  }
  return null;
}
function pruneNested(paths) {
  const sorted = [...new Set(paths)].sort((a, b) => a.length - b.length);
  const kept = [];
  for (const path of sorted) {
    if (kept.some((parent) => path === parent || path.startsWith(`${parent}/`))) continue;
    kept.push(path);
  }
  return kept.sort();
}
function proposalModules(repoRoot) {
  const found = [];
  for (const root of CANDIDATE_ROOTS) {
    const base = join3(repoRoot, root);
    if (!existsSync3(base)) continue;
    let entries;
    try {
      entries = readdirSync3(base, { withFileTypes: true }).map((entry) => ({
        name: entry.name,
        dir: entry.isDirectory()
      }));
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || IGNORED.has(`${root}/${entry.name}`)) continue;
      const path = `${root}/${entry.name}`;
      if (entry.dir) {
        found.push({ module: path.replace(/^(internal|app|src|lib|pkg)\//, ""), owns: [path], because: `${path}/ exists` });
      }
    }
  }
  return found;
}
function proposeFrontmatter(tree) {
  const out = [];
  for (const contract of tree.contracts) {
    if (contract.module === null && contract.contract !== "arch.md") continue;
    if (contract.owns.length > 0) continue;
    const derived = [];
    const unresolved = [];
    for (const cited of [...contract.refs, ...contract.links.map(stripArchctrlPrefix)]) {
      if (cited === "") continue;
      const directory = governingDirectory(tree.root, cited);
      if (directory === null) unresolved.push(cited);
      else derived.push(directory);
    }
    out.push({
      module: contract.module,
      contract: contract.contract,
      owns: pruneNested(derived),
      unresolved: [...new Set(unresolved)].sort()
    });
  }
  return out;
}
function stripArchctrlPrefix(link) {
  return link.startsWith(".archctrl/") ? "" : link;
}
function renderFrontmatter(owns, depends = []) {
  const list = (key, values) => values.length === 0 ? `${key}: []
` : `${key}:
${values.map((v) => `  - ${v}
`).join("")}`;
  return `---
${list("owns", owns)}${list("depends", depends)}---

`;
}
function withFrontmatter(source, block) {
  if (source.startsWith("---\n")) return source;
  return `${block}${source}`;
}
function scaffoldContract(module, owns) {
  const title = module === "" ? "Architecture contracts" : module;
  const scope = owns.length === 0 ? "(none declared)" : owns.join(", ");
  return [
    renderFrontmatter(owns).trimEnd(),
    "",
    `# ${title}`,
    "",
    `> Scaffolded by archctrl from the repository layout. Replace this note with`,
    `> the boundary this module must hold; nothing below is a decision yet.`,
    "",
    `Governs: ${scope}`,
    "",
    "## \u8FB9\u754C",
    "",
    "- \u8FD9\u4E2A\u6A21\u5757\u8D1F\u8D23\u4EC0\u4E48\u3001\u4E0D\u8D1F\u8D23\u4EC0\u4E48\uFF1F",
    "- \u54EA\u4E9B\u4E0D\u53D8\u91CF\u4E00\u65E6\u88AB\u8FDD\u80CC\u5C31\u9700\u8981\u663E\u5F0F\u51B3\u7B56\uFF1F",
    "",
    "## \u9A8C\u8BC1",
    "",
    "- \u54EA\u4E9B\u6D4B\u8BD5\u8BC1\u660E\u4E0A\u9762\u7684\u7EA6\u675F\u4ECD\u7136\u6210\u7ACB\uFF1F",
    ""
  ].join("\n");
}
function scaffoldPath(module) {
  return module === "" ? ".archctrl/arch.md" : `.archctrl/${module}/arch.md`;
}
function contestedPaths(proposals) {
  const claims = /* @__PURE__ */ new Map();
  for (const proposal of proposals) {
    for (const owned of proposal.owns) {
      const existing = claims.get(owned);
      if (existing === void 0) claims.set(owned, [proposal.contract]);
      else if (!existing.includes(proposal.contract)) existing.push(proposal.contract);
    }
  }
  return [...claims.entries()].filter(([, contracts]) => contracts.length > 1).map(([path, contracts]) => ({ path, contracts })).sort((a, b) => a.path.localeCompare(b.path));
}
function ownershipQuestions(tree, contested, excerptLimit = 2) {
  return contested.map((entry) => ({
    path: entry.path,
    candidates: entry.contracts.map((contractPath) => {
      const full = join3(tree.root, ".archctrl", contractPath);
      let text;
      try {
        text = readFileSync2(full, "utf8");
      } catch {
        text = "";
      }
      const title = /^#\s+(.+)$/m.exec(text)?.[1]?.trim() ?? contractPath;
      const stem = entry.path.split("/").pop() ?? entry.path;
      const excerpt = text.split("\n").filter((line) => line.includes(entry.path) || line.includes(stem)).slice(0, excerptLimit).map((line) => line.trim()).join(" / ");
      return {
        module: contractPath.replace(/\/arch\.md$/, "").replace(/^arch\.md$/, "(root)"),
        title,
        excerpt: excerpt === "" ? "(no direct mention)" : excerpt
      };
    })
  }));
}
function applyOwnershipAnswers(proposals, answers) {
  const decided = /* @__PURE__ */ new Map();
  for (const answer of answers) decided.set(answer.path, answer.module);
  if (decided.size === 0) return [...proposals];
  return proposals.map((proposal) => {
    const module = proposal.module ?? "(root)";
    const kept = proposal.owns.filter((owned) => {
      if (!decided.has(owned)) return true;
      return decided.get(owned) === module;
    });
    return { ...proposal, owns: kept };
  });
}

// src/host/judge.ts
import { readFileSync as readFileSync3, writeFileSync } from "node:fs";
import { join as join4 } from "node:path";
var JUDGE_INSTRUCTIONS = `You review whether an architecture contract still describes the code.

You are given: one contract document, the diff summary of the files it governs,
and the declarations added or changed in them.

Report a change ONLY when all three hold:
1. The diff touches a rule the contract states explicitly, not merely "code was added".
2. That rule is now false, incomplete, or requires a new exception.
3. You can quote the contract line that must change.

Otherwise answer {"change": false, "reason": "..."} and say why the contract still
holds. Do not propose edits to record that work happened: a contract is a set of
decisions, not a changelog. Never propose adding a rule the code does not already
obey, and never restate what the diff did. If a rule is merely worth rewording,
that is not a change.

When a change is required, return the COMPLETE new document body (not a patch),
keeping every unaffected line byte-identical, and list the single contract line
your change is based on.`;
function evidenceFor(tree, contract, base) {
  const range = `${base}...HEAD`;
  const read = (args) => git(tree.root, args) ?? "";
  const owned = contract.owns.length > 0 ? contract.owns : [".archctrl"];
  const lines = [
    read(["diff", "--stat", range, "--", ...owned]),
    read(["diff", "--stat", "HEAD", "--", ...owned]),
    read(["diff", "-U0", range, "--", ...owned]).split("\n").filter((line) => /^\+\s*(func|type|export|interface|class)\b/.test(line)).slice(0, 40).join("\n")
  ];
  return lines.join("\n").trim();
}
function judgePrompt(tree, contract, evidence) {
  const full = readFileSync3(join4(tree.root, contract.path), "utf8");
  const { body } = splitDocument(full);
  return [
    `Contract: ${contract.path}`,
    `Module: ${contract.module ?? "(root)"}`,
    `Governs: ${contract.owns.join(", ") || "(nothing declared)"}`,
    "",
    "=== CONTRACT (current) ===",
    body.trim(),
    "",
    "=== DIFF SUMMARY OF THE GOVERNED FILES ===",
    evidence.trim() || "(no diff)"
  ].join("\n");
}
function parseAnswer(text) {
  const trimmed = text.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error(`model did not answer with JSON: ${trimmed.slice(0, 200)}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(trimmed.slice(start, end + 1));
  } catch (error) {
    throw new Error(`model answer is not valid JSON`, { cause: error });
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("model answer is not an object");
  }
  const record = parsed;
  if (typeof record.change !== "boolean") {
    throw new Error('model answer has no boolean "change"');
  }
  return {
    change: record.change,
    reason: typeof record.reason === "string" ? record.reason : "",
    basis: typeof record.basis === "string" ? record.basis : "",
    ...typeof record.body === "string" ? { body: record.body } : {}
  };
}
async function judgeContract(llm, callConfig, tree, contract, base, signal) {
  const prompt = judgePrompt(tree, contract, evidenceFor(tree, contract, base));
  const prepared = await llm.prepareCall(callConfig, signal);
  let text = "";
  for await (const chunk of prepared.stream({
    provider: prepared.config.provider,
    model: prepared.config.model,
    messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
    system: JUDGE_INSTRUCTIONS,
    signal
  })) {
    if (chunk.type === "text-delta" && typeof chunk.text === "string") text += chunk.text;
  }
  const answer = parseAnswer(text);
  return {
    module: String(contract.module),
    contract: contract.contract,
    change: answer.change,
    reason: answer.reason,
    basis: answer.basis,
    ...answer.body === void 0 ? {} : { body: answer.body }
  };
}
function applyContract(tree, contract, body) {
  const full = join4(tree.root, contract.path);
  const current = readFileSync3(full, "utf8");
  const { frontmatter } = splitDocument(current);
  const normalized = body.endsWith("\n") ? body : `${body}
`;
  writeFileSync(full, frontmatter + normalized, "utf8");
  if (git(tree.root, ["add", "--", contract.path]) === null) {
    throw new Error(`git add failed for ${contract.path}`);
  }
  const message = `docs(archctrl): update ${contract.module ?? "root"} contract`;
  if (git(tree.root, ["commit", "-m", message, "--", contract.path]) === null) {
    throw new Error("git commit failed; the file was written but not committed");
  }
  const hash = git(tree.root, ["rev-parse", "--short", "HEAD"]) ?? "";
  return { path: contract.path, commit: hash, message };
}
var OWNERSHIP_INSTRUCTIONS = `You assign code paths to architecture contracts.

For each path, choose the ONE contract that decides how that code must be built
or changed. A contract that merely mentions a path is not its owner: a startup
file is mentioned by every module but is governed by the one that defines
startup order.

Rules:
1. Exactly one contract per path. If none decides it, answer "none".
2. Prefer the narrowest contract that states a rule about the path.
3. Test and generated files belong to the contract that owns the code they
   verify or generate.
4. Answer only the JSON asked for. Never invent a contract name.`;
async function resolveOwnership(llm, callConfig, questions, signal) {
  if (questions.length === 0) return [];
  const prompt = [
    "Resolve ownership for these paths.",
    "",
    ...questions.map(
      (q) => [
        `PATH: ${q.path}`,
        ...q.candidates.map((c) => `  - ${c.module}: ${c.title}
    ${c.excerpt}`)
      ].join("\n")
    ),
    "",
    "Answer with JSON only:",
    '{"answers":[{"path":"...","module":"<module or null>","because":"<one clause>"}]}'
  ].join("\n");
  const prepared = await llm.prepareCall(callConfig, signal);
  let text = "";
  for await (const chunk of prepared.stream({
    provider: prepared.config.provider,
    model: prepared.config.model,
    messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
    system: OWNERSHIP_INSTRUCTIONS,
    signal
  })) {
    if (chunk.type === "text-delta" && typeof chunk.text === "string") text += chunk.text;
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("ownership answer is not JSON");
  const parsed = JSON.parse(text.slice(start, end + 1));
  const answers = parsed.answers;
  if (!Array.isArray(answers)) throw new Error('ownership answer has no "answers" array');
  return answers.filter((entry) => typeof entry === "object" && entry !== null).map((entry) => ({
    path: typeof entry.path === "string" ? entry.path : "",
    module: typeof entry.module === "string" && entry.module !== "" && entry.module !== "none" ? entry.module : null,
    because: typeof entry.because === "string" ? entry.because : ""
  })).filter((answer) => answer.path !== "");
}

// src/host/routes.ts
var ROUTES = {
  state: "/api/archctrl/state",
  check: "/api/archctrl/check",
  contract: "/api/archctrl/contract",
  review: "/api/archctrl/review",
  propose: "/api/archctrl/propose",
  judge: "/api/archctrl/judge",
  apply: "/api/archctrl/apply",
  workspaces: "/api/archctrl/workspaces",
  active: "/api/archctrl/active",
  // Onboarding: diagnose a tree that was written by hand, then propose the
  // frontmatter it is missing or a scaffold for a repository that has none.
  diagnose: "/api/archctrl/diagnose",
  repair: "/api/archctrl/repair",
  scaffold: "/api/archctrl/scaffold"
};
var json = (value, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });
var ok = (value) => json({ ok: true, value });
var fail = (code, message) => json({ ok: false, error: { code, message } });
async function readBody(request) {
  if (request.method !== "POST") return {};
  try {
    const parsed = await request.json();
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}
function createRoutes(services) {
  const requireTree = (root) => root === void 0 ? null : readTree(root);
  return {
    [ROUTES.workspaces]: async () => {
      const collected = [];
      const seen = /* @__PURE__ */ new Set();
      for (const workspace of services.workspaces?.() ?? []) {
        if (seen.has(workspace.path)) continue;
        seen.add(workspace.path);
        collected.push(workspace);
      }
      const registryCount = collected.length;
      for (const directory of services.sessionDirectories?.() ?? []) {
        if (seen.has(directory)) continue;
        seen.add(directory);
        collected.push({
          id: directory,
          title: directory.split("/").filter(Boolean).pop() ?? directory,
          path: directory,
          hasContracts: false,
          source: "session"
        });
      }
      if (collected.length === 0) {
        const host = services.hostDirectory?.();
        if (host !== void 0 && host !== "") {
          collected.push({
            id: host,
            title: host.split("/").filter(Boolean).pop() ?? host,
            path: host,
            hasContracts: false,
            source: "host"
          });
        }
      }
      return ok({
        items: collected,
        source: { registry: registryCount, sessions: collected.length - registryCount }
      });
    },
    [ROUTES.state]: async (request) => {
      const root = services.resolveRoot(request, await readBody(request));
      if (root === void 0) return fail("no-root", "no working directory");
      const tree = requireTree(root);
      if (tree === null) return fail("no-archctrl", `.archctrl was not found under ${root}`);
      const checked = checkTree(tree);
      return ok({
        root: tree.root,
        contracts: tree.contracts,
        errors: checked.errors,
        warnings: checked.warnings,
        hints: checked.hints,
        totals: {
          contracts: tree.contracts.length,
          tokens: tree.contracts.reduce((sum, c) => sum + c.tokens, 0),
          errors: checked.errors.length,
          warnings: checked.warnings.length
        }
      });
    },
    [ROUTES.check]: async (request) => {
      const root = services.resolveRoot(request, await readBody(request));
      if (root === void 0) return fail("no-root", "no working directory");
      const tree = requireTree(root);
      if (tree === null) return fail("no-archctrl", `.archctrl was not found under ${root}`);
      return ok(checkTree(tree));
    },
    [ROUTES.contract]: async (request) => {
      const body = await readBody(request);
      const root = services.resolveRoot(request, body);
      if (root === void 0) return fail("no-root", "no working directory");
      const module = typeof body.module === "string" ? body.module : new URL(request.url).searchParams.get("module") ?? "";
      const tree = requireTree(root);
      if (tree === null) return fail("no-archctrl", `.archctrl was not found under ${root}`);
      const wanted = module === "" || module === "root" || module === "null" ? null : module;
      const contract = tree.contracts.find((c) => c.module === wanted);
      if (contract === void 0) return fail("unknown-module", `no contract for module "${module}"`);
      return ok({
        module: contract.module,
        contract: contract.contract,
        path: contract.path,
        tokens: contract.tokens,
        text: readFileSync4(join5(tree.root, contract.path), "utf8")
      });
    },
    [ROUTES.review]: async (request) => {
      const body = await readBody(request);
      const root = services.resolveRoot(request, body);
      if (root === void 0) return fail("no-root", "no working directory");
      const tree = requireTree(root);
      if (tree === null) return fail("no-archctrl", `.archctrl was not found under ${root}`);
      const base = typeof body.base === "string" && body.base !== "" ? body.base : "main";
      return ok(reviewChanges(tree, base));
    },
    [ROUTES.propose]: async (request) => {
      const body = await readBody(request);
      const root = services.resolveRoot(request, body);
      if (root === void 0) return fail("no-root", "no working directory");
      const tree = requireTree(root);
      if (tree === null) return fail("no-archctrl", `.archctrl was not found under ${root}`);
      const paths = Array.isArray(body.paths) ? body.paths.filter((p) => typeof p === "string") : [];
      const attribution = impact(tree, paths);
      const checked = checkTree(tree);
      return ok({
        targets: attribution.modules.map((hit) => {
          const contract = tree.contracts.find((c) => String(c.module) === hit.module) ?? null;
          return {
            module: hit.module,
            contract: contract?.contract ?? null,
            tokens: contract?.tokens ?? 0,
            paths: hit.paths,
            depends: contract?.depends ?? [],
            verifies: contract?.verifies ?? []
          };
        }),
        dependents: attribution.dependents,
        unmatched: attribution.unmatched,
        errors: checked.errors,
        warnings: checked.warnings
      });
    },
    [ROUTES.judge]: async (request, runtime) => {
      const body = await readBody(request);
      const root = services.resolveRoot(request, body);
      if (root === void 0) return fail("no-root", "no working directory");
      const tree = requireTree(root);
      if (tree === null) return fail("no-archctrl", `.archctrl was not found under ${root}`);
      const module = typeof body.module === "string" ? body.module : "";
      const wanted = module === "" || module === "root" ? null : module;
      const contract = tree.contracts.find((c) => c.module === wanted);
      if (contract === void 0) return fail("unknown-module", `no contract for module "${module}"`);
      if (runtime.llm === void 0) return fail("no-llm", "this Host provides no model service");
      if (runtime.llmConfig === void 0) {
        return fail("no-model", "this Session has not chosen a model yet; send one message first");
      }
      const base = typeof body.base === "string" && body.base !== "" ? body.base : "main";
      try {
        return ok(await judgeContract(runtime.llm, runtime.llmConfig, tree, contract, base, request.signal));
      } catch (error) {
        return fail("judge-failed", error instanceof Error ? error.message : String(error));
      }
    },
    [ROUTES.apply]: async (request) => {
      const body = await readBody(request);
      const root = services.resolveRoot(request, body);
      if (root === void 0) return fail("no-root", "no working directory");
      const tree = requireTree(root);
      if (tree === null) return fail("no-archctrl", `.archctrl was not found under ${root}`);
      const module = typeof body.module === "string" ? body.module : "";
      const wanted = module === "" || module === "root" ? null : module;
      const contract = tree.contracts.find((c) => c.module === wanted);
      if (contract === void 0) return fail("unknown-module", `no contract for module "${module}"`);
      if (typeof body.body !== "string" || body.body.trim() === "") {
        return fail("empty-body", "the accepted revision is empty");
      }
      try {
        return ok(applyContract(tree, contract, body.body));
      } catch (error) {
        return fail("apply-failed", error instanceof Error ? error.message : String(error));
      }
    },
    [ROUTES.diagnose]: async (request) => {
      const body = await readBody(request);
      const root = services.resolveRoot(request, body);
      if (root === void 0) return fail("no-root", "no working directory");
      const tree = requireTree(root);
      if (tree === null) {
        return ok({
          state: "empty",
          root,
          modules: proposalModules(root),
          contracts: [],
          frontmatter: []
        });
      }
      const checked = checkTree(tree);
      const proposals = proposeFrontmatter(tree);
      const undeclared = tree.contracts.filter((c) => c.owns.length === 0).length;
      return ok({
        state: undeclared === 0 ? "declared" : "undeclared",
        root,
        modules: [],
        contracts: tree.contracts.map((c) => ({
          module: c.module,
          contract: c.contract,
          tokens: c.tokens,
          owns: c.owns.length
        })),
        frontmatter: proposals.map((p) => ({
          ...p,
          block: renderFrontmatter(p.owns)
        })),
        totals: {
          contracts: tree.contracts.length,
          undeclared,
          errors: checked.errors.length,
          warnings: checked.warnings.length
        }
      });
    },
    [ROUTES.repair]: async (request, runtime) => {
      const body = await readBody(request);
      const root = services.resolveRoot(request, body);
      if (root === void 0) return fail("no-root", "no working directory");
      const tree = requireTree(root);
      if (tree === null) return fail("no-archctrl", `.archctrl was not found under ${root}`);
      const apply2 = body.apply === true;
      const proposals = proposeFrontmatter(tree);
      const contested = contestedPaths(proposals);
      let resolved = [];
      let modelNote;
      if (body.useModel === true && contested.length > 0) {
        if (runtime.llm === void 0) {
          modelNote = "no-llm";
        } else if (runtime.llmConfig === void 0) {
          modelNote = "no-model";
        } else {
          try {
            resolved = await resolveOwnership(
              runtime.llm,
              runtime.llmConfig,
              ownershipQuestions(tree, contested, 2),
              request.signal
            );
          } catch (error) {
            modelNote = error instanceof Error ? error.message : String(error);
          }
        }
      }
      const merged = applyOwnershipAnswers(proposals, resolved);
      const results = [];
      for (const proposal of merged) {
        if (!apply2 || proposal.owns.length === 0) {
          results.push({ ...proposal, applied: false });
          continue;
        }
        const commit = insertFrontmatter(tree.root, proposal.contract, proposal.owns);
        results.push({
          contract: proposal.contract,
          owns: proposal.owns,
          unresolved: proposal.unresolved,
          applied: commit !== void 0,
          ...commit === void 0 ? {} : { commit }
        });
      }
      return ok({
        applied: apply2,
        proposed: proposals.length,
        contested: contested.length,
        resolved: resolved.length,
        ...modelNote === void 0 ? {} : { modelNote },
        results
      });
    },
    [ROUTES.scaffold]: async (request) => {
      const body = await readBody(request);
      const root = services.resolveRoot(request, body);
      if (root === void 0) return fail("no-root", "no working directory");
      const modules = proposalModules(root);
      const wanted = Array.isArray(body.modules) ? body.modules.filter((m) => typeof m === "string") : modules.map((m) => m.module);
      const plan = modules.filter((m) => wanted.includes(m.module)).map((m) => ({
        module: m.module,
        path: scaffoldPath(m.module),
        owns: m.owns,
        text: scaffoldContract(m.module, m.owns)
      }));
      if (body.apply !== true) return ok({ applied: false, plan });
      const written = writeScaffold(root, plan);
      return ok({ applied: true, plan, written });
    },
    [ROUTES.active]: async (request) => {
      const body = await readBody(request);
      const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
      const root = services.resolveRoot(request, body);
      const tree = root === void 0 ? null : readTree(root);
      const read = services.readModules(sessionId);
      return ok({
        sessionId,
        root: tree?.root ?? null,
        read,
        contracts: (tree?.contracts ?? []).map((c) => ({
          module: String(c.module),
          tokens: c.tokens,
          read: read.includes(String(c.module))
        }))
      });
    }
  };
}
function insertFrontmatter(root, contract, owns) {
  const full = join5(root, contract);
  const source = readFileSync4(full, "utf8");
  if (source.startsWith("---\n")) return void 0;
  writeFileSync2(full, withFrontmatter(source, `${renderFrontmatter(owns)}`), "utf8");
  const message = `docs(archctrl): declare scope for ${contract}`;
  if (git(root, ["add", "--", contract]) === null) return void 0;
  if (git(root, ["commit", "-m", message, "--", contract]) === null) return void 0;
  return git(root, ["rev-parse", "--short", "HEAD"]) ?? void 0;
}
function writeScaffold(root, plan) {
  const out = [];
  for (const entry of plan) {
    const full = join5(root, entry.path);
    mkdirSync(dirname3(full), { recursive: true });
    writeFileSync2(full, entry.text, "utf8");
    out.push({ path: entry.path });
  }
  if (plan.length === 0) return out;
  const paths = plan.map((entry) => entry.path);
  if (git(root, ["add", "--", ...paths]) !== null) {
    const message = `docs(archctrl): scaffold ${paths.length} contracts`;
    if (git(root, ["commit", "-m", message, "--", ...paths]) !== null) {
      const hash = git(root, ["rev-parse", "--short", "HEAD"]);
      if (hash !== null) for (const entry of out) entry.commit = hash;
    }
  }
  return out;
}

// src/host/index.ts
var PROMPT_SECTION = "archctrl:contracts";
var DEFAULTS = {
  enabled: true,
  promptSection: true,
  promptSectionOrder: 900,
  maxToolPaths: 40
};
function resolveConfig(input) {
  const raw = typeof input === "object" && input !== null ? input : {};
  const bool = (value, fallback) => typeof value === "boolean" ? value : fallback;
  const num = (value, fallback, min, max) => typeof value === "number" && Number.isFinite(value) && value >= min && value <= max ? value : fallback;
  return {
    enabled: bool(raw.enabled, DEFAULTS.enabled),
    promptSection: bool(raw.promptSection, DEFAULTS.promptSection),
    promptSectionOrder: num(raw.promptSectionOrder, DEFAULTS.promptSectionOrder, -1e4, 2e4),
    maxToolPaths: num(raw.maxToolPaths, DEFAULTS.maxToolPaths, 1, 500)
  };
}
var readSessions = /* @__PURE__ */ new Map();
function markRead(sessionId, module) {
  if (typeof sessionId !== "string" || sessionId === "") return;
  const key = module ?? "(root)";
  const existing = readSessions.get(sessionId);
  if (existing === void 0) readSessions.set(sessionId, /* @__PURE__ */ new Set([key]));
  else existing.add(key);
}
function readModules(sessionId) {
  return [...readSessions.get(sessionId) ?? []].sort();
}
function resetReadingLog() {
  readSessions.clear();
}
function promptText(tree) {
  if (tree === null || tree.contracts.length === 0) return "";
  const top = tree.contracts.filter((c) => c.module !== null && !c.module.includes("/"));
  const total = tree.contracts.reduce((sum, c) => sum + c.tokens, 0);
  return [
    `Architecture contracts live under .archctrl/ (${tree.contracts.length} files, ~${total} tokens total).`,
    `A directory is a module and its arch.md is that module's contract. Read .archctrl/arch.md first, then only the module you are changing:`,
    top.map((c) => `.archctrl/${c.contract}`).join("  "),
    `Call arch_impact before editing code to learn which contract owns the files. Call arch_contract for one module's full text. Do not invent architecture the contracts forbid.`
  ].join("\n");
}
var textBlocks = (value) => [
  { type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }
];
var failure = (error) => ({
  error: error instanceof Error ? error.message : String(error)
});
function workspaceRootOf(agent) {
  const cwd = agent?.session?.header?.cwd;
  return typeof cwd === "string" && cwd !== "" ? cwd : void 0;
}
var name = "archctrl";
var inject = ["tools", "systemPrompt"];
function apply(ctx, input) {
  const config = resolveConfig(input);
  if (!config.enabled) return;
  const routeServices = {};
  const requireTree = (agent) => {
    const root = workspaceRootOf(agent);
    if (root === void 0) throw new Error("no working directory for this session");
    const tree = readTree(root);
    if (tree === null) throw new Error("this repository has no .archctrl contracts");
    return tree;
  };
  if (config.promptSection && ctx.systemPrompt !== void 0) {
    ctx.effect(
      () => ctx.systemPrompt?.section({
        name: PROMPT_SECTION,
        order: config.promptSectionOrder,
        text: () => {
          const working = routeServices.workingDirectory?.defaultDirectory;
          if (typeof working !== "string" || working === "") return "";
          try {
            return promptText(readTree(working));
          } catch {
            return "";
          }
        },
        interpolate: false
      })
    );
  }
  const register = (definition) => {
    ctx.effect(() => ctx.tools?.register(definition));
  };
  register({
    name: "arch_impact",
    description: "Which architecture contract owns these files, and which modules depend on them. Call this before editing code so the change stays inside the approved boundaries instead of re-deriving them by reading source.",
    parameters: {
      type: "object",
      properties: {
        paths: {
          type: "array",
          items: { type: "string" },
          description: "Repository-relative file or directory paths, e.g. internal/logic/canvas/canvas.go."
        }
      },
      required: ["paths"]
    },
    output: { schema: { type: "object" }, render: (_args, value) => textBlocks(value) },
    async execute(args, exec) {
      const paths = Array.isArray(args?.paths) ? args.paths.filter((p) => typeof p === "string" && p !== "") : [];
      if (paths.length === 0) return failure(new Error("paths must be a non-empty array of strings"));
      if (paths.length > config.maxToolPaths) {
        return failure(new Error(`paths accepts at most ${config.maxToolPaths} entries`));
      }
      try {
        const tree = requireTree(exec.agent);
        const result = impact(tree, paths);
        for (const hit of result.modules) {
          markRead(exec.agent?.id, hit.module === "null" ? null : hit.module);
        }
        return {
          ...result,
          contracts: result.modules.map((hit) => {
            const contract = tree.contracts.find((c) => String(c.module) === hit.module);
            return {
              module: hit.module,
              contract: contract?.contract ?? null,
              tokens: contract?.tokens ?? 0,
              verifies: contract?.verifies ?? [],
              paths: hit.paths
            };
          }),
          ...result.unmatched.length > 0 ? {
            note: "Unmatched paths belong to no contract; either the module is new or its arch.md frontmatter does not claim them."
          } : {}
        };
      } catch (error) {
        return failure(error);
      }
    }
  });
  register({
    name: "arch_contract",
    description: "Read one architecture contract in full, with its verification anchors and recent commits. Use after arch_impact names the module; omit the module to list what is available.",
    parameters: {
      type: "object",
      properties: {
        module: {
          type: "string",
          description: "Module name from arch_impact, e.g. project or platform/http. Omit to list modules."
        }
      }
    },
    output: { schema: { type: "object" }, render: (_args, value) => textBlocks(value) },
    async execute(args, exec) {
      try {
        const tree = requireTree(exec.agent);
        const module = typeof args?.module === "string" ? args.module.trim() : "";
        if (module === "") {
          return {
            modules: tree.contracts.map((c) => ({
              module: String(c.module),
              contract: c.contract,
              tokens: c.tokens,
              owns: c.owns.length,
              lastCommit: c.lastCommit?.subject ?? null
            }))
          };
        }
        const wanted = module === "(root)" ? null : module;
        const contract = tree.contracts.find((c) => c.module === wanted);
        if (contract === void 0) {
          return failure(new Error(`unknown module "${module}"; call arch_contract without a module to list them`));
        }
        markRead(exec.agent?.id, contract.module);
        return {
          module,
          contract: contract.contract,
          path: contract.path,
          tokens: contract.tokens,
          lastCommit: contract.lastCommit,
          owns: contract.owns,
          depends: contract.depends,
          verifies: contract.verifies,
          text: readFileSync5(join6(tree.root, contract.path), "utf8")
        };
      } catch (error) {
        return failure(error);
      }
    }
  });
  register({
    name: "arch_check",
    description: "Deterministic drift report for the architecture contracts: broken links, references to paths that no longer exist, ownership of missing paths, and directories no contract claims. Free to run.",
    parameters: {
      type: "object",
      properties: {
        includeHints: {
          type: "boolean",
          description: 'Include the informational "this contract lags N commits" list. Defaults to true.'
        }
      }
    },
    output: { schema: { type: "object" }, render: (_args, value) => textBlocks(value) },
    async execute(args, exec) {
      try {
        const tree = requireTree(exec.agent);
        const result = checkTree(tree);
        return {
          errors: result.errors,
          warnings: result.warnings,
          ...args?.includeHints === false ? {} : { hints: result.hints },
          summary: {
            contracts: tree.contracts.length,
            tokens: tree.contracts.reduce((sum, c) => sum + c.tokens, 0),
            errors: result.errors.length,
            warnings: result.warnings.length
          }
        };
      } catch (error) {
        return failure(error);
      }
    }
  });
  register({
    name: "arch_review",
    description: "Review the changes since a base ref without spending model tokens: which contracts own the changed files, whether those contracts were updated, which of their cited paths the change touches, and the diff size involved. Use before a commit the user asks you to review.",
    parameters: {
      type: "object",
      properties: {
        base: { type: "string", description: "Base ref to compare against, e.g. main. Defaults to main." }
      }
    },
    output: { schema: { type: "object" }, render: (_args, value) => textBlocks(value) },
    async execute(args, exec) {
      try {
        const tree = requireTree(exec.agent);
        const base = typeof args?.base === "string" && args.base.trim() !== "" ? args.base.trim() : "main";
        return reviewChanges(tree, base);
      } catch (error) {
        return failure(error);
      }
    }
  });
  const routes = createRoutes({
    resolveRoot: (request, body) => {
      const url = new URL(request.url);
      const explicit = typeof body.root === "string" && body.root !== "" ? body.root : url.searchParams.get("root") ?? void 0;
      if (explicit !== void 0 && explicit !== "") return explicit;
      const sessionId = typeof body.sessionId === "string" && body.sessionId !== "" ? body.sessionId : url.searchParams.get("sessionId") ?? void 0;
      if (sessionId !== void 0 && sessionId !== "") {
        const session = routeServices.sessions?.get(sessionId);
        const cwd = session?.header?.cwd;
        if (typeof cwd === "string" && cwd !== "") return cwd;
      }
      return void 0;
    },
    workspaces: () => (routeServices.workspaceRegistry?.list() ?? []).map((workspace) => ({
      id: workspace.id,
      title: workspace.title,
      path: workspace.path,
      hasContracts: existsSync4(join6(workspace.path, ".archctrl")),
      source: "registry"
    })),
    sessionDirectories: () => (routeServices.sessions?.list() ?? []).map((session) => session.header?.cwd).filter((cwd) => typeof cwd === "string" && cwd !== ""),
    hostDirectory: () => routeServices.workingDirectory?.defaultDirectory,
    readModules
  });
  const runtimeFor = (request, scope) => {
    const llm = scope.get("llm");
    let llmConfig;
    try {
      const sessionId = new URL(request.url).searchParams.get("sessionId");
      const sessions = routeServices.sessions;
      const session = sessionId !== null ? sessions?.get(sessionId) : void 0;
      const header = session?.requestHeader?.();
      if (typeof header?.config?.provider === "string" && typeof header?.config?.model === "string") {
        llmConfig = { provider: header.config.provider, model: header.config.model };
      }
    } catch {
      llmConfig = void 0;
    }
    return { ...llm === void 0 ? {} : { llm }, ...llmConfig === void 0 ? {} : { llmConfig } };
  };
  ctx.inject(["connection"], (scope) => {
    for (const key of ["workspaceRegistry", "sessions", "workingDirectory"]) {
      const value = scope.get(key);
      if (value !== void 0) {
        routeServices[key] = value;
      }
    }
    const connection = scope.get("connection");
    const registerFetch = connection?.fetch;
    if (typeof registerFetch?.register !== "function") return;
    for (const [path, handler] of Object.entries(routes)) {
      scope.effect(
        () => registerFetch.register({
          path,
          methods: ["GET", "POST"],
          requestBody: "buffered",
          fetch: (request) => handler(request, runtimeFor(request, scope))
        })
      );
    }
  });
}
export {
  ROUTES,
  apply,
  applyContract,
  applyOwnershipAnswers,
  approximateTokens,
  checkTree,
  contestedPaths,
  effectiveOwns,
  impact,
  inject,
  judgeContract,
  markRead,
  name,
  ownershipQuestions,
  parseFrontmatter,
  promptText,
  proposalModules,
  proposeFrontmatter,
  readModules,
  readTree,
  referencedPaths,
  renderFrontmatter,
  resetReadingLog,
  resolveConfig,
  resolveOwnership,
  reviewChanges,
  scaffoldContract,
  scaffoldPath,
  splitDocument,
  withFrontmatter
};
