/**
 * Pre-flight blueprint linter (LINT-01 .. LINT-25).
 *
 * The DAG acyclicity check and undeclared-dependency check are ported from the
 * Antigravity harness's validate-spec.mjs (validateManifest), which already did
 * real work. Three things changed:
 *   1. Its Result-type check was a substring test (`signature.includes('result')`);
 *      here the return type is actually parsed (parseSignature/classifyReturn).
 *   2. Its contract checks were warnings; pre+post are now errors, because
 *      NL2Contract (arXiv:2510.12702) shows preconditions materially matter.
 *   3. New rules for the artifacts both harnesses lacked: constitution articles,
 *      EARS requirements (Kiro), requirement->scenario coverage, verified
 *      citations (CiteCheck, arXiv:2605.27700), approval supersession, and a
 *      payload token budget (context is a finite resource).
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, isAbsolute, normalize } from 'node:path';
import YAML from 'yaml';
import { isContained, containedPath } from './integrity.ts';
import {
  ConstitutionSchema, IdeaSchema, ManifestSchema, SpecSchema, TaskSchema, SourceSchema,
  safeParse, EARS_PATTERN,
} from './schema.ts';
import type { Constitution, Idea, Manifest, Spec, Task, Source } from './schema.ts';

export interface Finding { id: string; severity: 'error' | 'warn'; message: string; where: string; }
export interface LintResult { errors: Finding[]; warnings: Finding[]; ok: boolean; }

export interface LintInput {
  dir: string;
  constitution?: Constitution;
  idea?: Idea;
  manifest?: Manifest;
  specs?: Record<string, Spec>;
  tasks?: Record<string, Task>;
  sources?: Source[];
  approval?: { created_at: string } | null;
  latestArtifactEdit?: string | null;
}

const err = (id: string, where: string, message: string): Finding => ({ id, severity: 'error', message, where });
const warn = (id: string, where: string, message: string): Finding => ({ id, severity: 'warn', message, where });

/* ---------------- signature parsing (replaces the substring heuristic) --------------- */

export interface ParsedSignature { name: string; params: string; returns: string; }

/** Parse `name(params): Return`, respecting nesting in params and generics. */
export function parseSignature(signature: string): ParsedSignature | null {
  const open = signature.indexOf('(');
  if (open <= 0) return null;
  let depth = 0;
  let close = -1;
  for (let i = open; i < signature.length; i += 1) {
    const ch = signature[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') { depth -= 1; if (depth === 0) { close = i; break; } }
  }
  if (close < 0) return null;
  const name = signature.slice(0, open).trim();
  if (!name || !/^[A-Za-z_$][\w$.]*$/.test(name)) return null;
  const rest = signature.slice(close + 1).trim();
  if (!rest.startsWith(':')) return null;
  const returns = rest.slice(1).trim();
  if (!returns) return null;
  return { name, params: signature.slice(open + 1, close).trim(), returns };
}

/** Split a union at top level only, so `Result<A, B|C>` stays intact. */
export function splitUnion(type: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of type) {
    if (ch === '<' || ch === '(' || ch === '{' || ch === '[') depth += 1;
    else if (ch === '>' || ch === ')' || ch === '}' || ch === ']') depth -= 1;
    if (ch === '|' && depth === 0) { parts.push(current.trim()); current = ''; continue; }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

export type ReturnClass = 'result-generic' | 'discriminated-union' | 'error-union' | 'bare';

/** Extract the right-hand side of `type Name = ...` from a types block. */
export function resolveAlias(name: string, types: string): string | null {
  const match = new RegExp(`\\btype\\s+${name}\\s*(?:<[^>]*>)?\\s*=\\s*([\\s\\S]*?)(?=\\n\\s*(?:type|interface|const|function)\\s|$)`).exec(types);
  return match ? match[1].trim().replace(/;\s*$/, '') : null;
}

/**
 * Classify a return type for error containment (LINT-12).
 *
 * When `types` is supplied a named alias is resolved against the spec's own
 * types block rather than guessed from its name, which is what makes this a
 * real check instead of the substring heuristic it replaces.
 */
export function classifyReturn(returns: string, types = '', depth = 0): ReturnClass {
  let type = returns.trim();

  /* An async transition returns Promise<Result<...>>. The wrapper says when the
     value arrives, not whether failure is a value, so unwrap before judging. */
  const awaited = /^(?:Promise|Awaited)\s*<([\s\S]+)>$/.exec(type);
  if (awaited && depth < 4) return classifyReturn(awaited[1], types, depth + 1);

  if (/^Result\s*</.test(type)) return 'result-generic';
  const members = splitUnion(type);
  if (members.length > 1) {
    const hasOkTrue = members.some((m) => /\{\s*ok\s*:\s*true\b/.test(m));
    const hasOkFalse = members.some((m) => /\{\s*ok\s*:\s*false\b/.test(m));
    if (hasOkTrue && hasOkFalse) return 'discriminated-union';
    if (members.some((m) => /(^|\W)(Error|[A-Z]\w*Error)$/.test(m.trim()))) return 'error-union';
    if (types && depth < 3) {
      for (const member of members) {
        if (/^[A-Z]\w*$/.test(member)) {
          const alias = resolveAlias(member, types);
          if (alias && classifyReturn(alias, types, depth + 1) !== 'bare') return 'discriminated-union';
        }
      }
    }
  }
  if (members.length === 1 && /^[A-Z]\w*$/.test(type) && types && depth < 3) {
    const alias = resolveAlias(type, types);
    if (alias) return classifyReturn(alias, types, depth + 1);
  }
  return 'bare';
}

/* ---------------- DAG (ported from Antigravity validate-spec.mjs) --------------- */

export function findCycle(edges: Map<string, string[]>): string[] | null {
  const visited = new Map<string, number>();
  const stack: string[] = [];
  const dfs = (node: string): string[] | null => {
    visited.set(node, 1);
    stack.push(node);
    for (const next of edges.get(node) ?? []) {
      if (visited.get(next) === 1) return [...stack.slice(stack.indexOf(next)), next];
      if (!visited.has(next) || visited.get(next) === 0) {
        const cycle = dfs(next);
        if (cycle) return cycle;
      }
    }
    stack.pop();
    visited.set(node, 2);
    return null;
  };
  for (const node of edges.keys()) {
    if (!visited.has(node) || visited.get(node) === 0) {
      const cycle = dfs(node);
      if (cycle) return cycle;
    }
  }
  return null;
}

/** Kahn topological order over the boundary DAG (dependencies first). */
export function topoOrder(edges: Map<string, string[]>): string[] {
  const indegree = new Map<string, number>();
  for (const node of edges.keys()) indegree.set(node, 0);
  for (const [node, deps] of edges) {
    for (const _dep of deps) indegree.set(node, (indegree.get(node) ?? 0) + 1);
  }
  const ready = [...indegree.entries()].filter(([, n]) => n === 0).map(([k]) => k).sort();
  const order: string[] = [];
  while (ready.length) {
    const node = ready.shift()!;
    order.push(node);
    for (const [other, deps] of edges) {
      if (deps.includes(node)) {
        indegree.set(other, (indegree.get(other) ?? 1) - 1);
        if (indegree.get(other) === 0) { ready.push(other); ready.sort(); }
      }
    }
  }
  return order;
}

/* ---------------- loading --------------- */

export function loadYaml(path: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: YAML.parse(readFileSync(path, 'utf8')) };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

/** Read a blueprint directory into a LintInput, collecting parse/schema errors. */
export function loadBlueprintDir(dir: string): { input: LintInput; findings: Finding[] } {
  const findings: Finding[] = [];
  const input: LintInput = { dir, specs: {}, tasks: {} };

  const read = <T>(file: string, schema: { safeParse: (v: unknown) => never }, label: string): T | undefined => {
    const path = join(dir, file);
    if (!existsSync(path)) {
      findings.push(err('LINT-01', file, `Missing required artifact: ${file}`));
      return undefined;
    }
    const doc = loadYaml(path);
    if (!doc.ok) { findings.push(err('LINT-01', file, `YAML parse error: ${doc.error}`)); return undefined; }
    const parsed = safeParse<T>(schema as never, doc.value);
    if (!parsed.ok) {
      for (const message of parsed.errors) findings.push(err('LINT-01', file, `${label} ${message}`));
      return undefined;
    }
    return parsed.value;
  };

  /* sources.yaml mirrors the ledger so `aose lint --dir` can check citations
     with no database — the path a Codex or Gemini user takes. */
  const sourcesPath = join(dir, 'sources.yaml');
  if (existsSync(sourcesPath)) {
    const doc = loadYaml(sourcesPath);
    if (!doc.ok) findings.push(err('LINT-01', 'sources.yaml', `YAML parse error: ${doc.error}`));
    else {
      const list = (doc.value as { sources?: unknown[] } | null)?.sources ?? [];
      const parsed: Source[] = [];
      for (const [index, entry] of list.entries()) {
        const one = safeParse<Source>(SourceSchema as never, entry);
        if (!one.ok) for (const m of one.errors) findings.push(err('LINT-01', 'sources.yaml', `sources[${index}] ${m}`));
        else parsed.push(one.value);
      }
      input.sources = parsed;
    }
  }

  input.constitution = read<Constitution>('constitution.yaml', ConstitutionSchema as never, 'constitution');
  input.idea = read<Idea>('idea.yaml', IdeaSchema as never, 'idea');
  input.manifest = read<Manifest>('system.manifest.yaml', ManifestSchema as never, 'manifest');

  for (const boundary of input.manifest?.system.boundaries ?? []) {
    const specPath = join(dir, boundary.spec);
    if (!existsSync(specPath)) {
      findings.push(err('LINT-05', boundary.spec, `Boundary "${boundary.domain}" declares spec "${boundary.spec}" which does not exist.`));
    } else {
      const doc = loadYaml(specPath);
      if (!doc.ok) findings.push(err('LINT-01', boundary.spec, `YAML parse error: ${doc.error}`));
      else {
        const parsed = safeParse<Spec>(SpecSchema as never, doc.value);
        if (!parsed.ok) for (const m of parsed.errors) findings.push(err('LINT-01', boundary.spec, `spec ${m}`));
        else input.specs![boundary.domain] = parsed.value;
      }
    }
    const taskPath = join(dir, boundary.task);
    if (!existsSync(taskPath)) {
      findings.push(err('LINT-05', boundary.task, `Boundary "${boundary.domain}" declares task "${boundary.task}" which does not exist.`));
    } else {
      const doc = loadYaml(taskPath);
      if (!doc.ok) findings.push(err('LINT-01', boundary.task, `YAML parse error: ${doc.error}`));
      else {
        const parsed = safeParse<Task>(TaskSchema as never, doc.value);
        if (!parsed.ok) for (const m of parsed.errors) findings.push(err('LINT-01', boundary.task, `task ${m}`));
        else input.tasks![boundary.domain] = parsed.value;
      }
    }
  }
  return { input, findings };
}

/* ---------------- the rules --------------- */

export function lint(input: LintInput): LintResult {
  const findings: Finding[] = [];
  const { constitution, idea, manifest, specs = {}, tasks = {}, sources = [] } = input;

  /* LINT-20: constitution articles */
  if (constitution?.constitution) {
    const ids = (constitution.constitution.articles ?? []).map((a) => a.id);
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    if (dupes.length) findings.push(err('LINT-20', 'constitution.yaml', `Duplicate article ids: ${[...new Set(dupes)].join(', ')}.`));
  }

  /* idea rules */
  if (idea) {
    if (idea.idea.seed_author !== 'human') {
      findings.push(warn('LINT-21', 'idea.yaml', 'seed_author is not "human". LLM-first ideation can suppress independent design exploration (arXiv:2410.03703); prefer a human seed the agent then expands.'));
    }
    if (idea.idea.open_questions.length) {
      findings.push(err('LINT-26', 'idea.yaml', `Idea still has ${idea.idea.open_questions.length} open question(s); resolve them before compiling.`));
    }
    if (idea.idea.scope_class === 'architectural') {
      if (idea.idea.alternatives_considered.length < 1) {
        findings.push(err('LINT-22', 'idea.yaml', 'scope_class "architectural" requires at least one recorded alternative with a reason it was rejected.'));
      }
      if (idea.idea.elicitation.length < 2) {
        findings.push(err('LINT-22', 'idea.yaml', 'scope_class "architectural" requires at least two elicitation entries (challenge + response) before the plan is accepted.'));
      }
    }
  }

  if (!manifest) {
    return finalize(findings.concat(err('LINT-01', 'system.manifest.yaml', 'No usable system manifest; remaining structural rules were skipped.')));
  }

  const boundaries = manifest.system.boundaries;
  const domains = new Set(boundaries.map((b) => b.domain));

  /* LINT-02 constitution path */
  if (!existsSync(join(input.dir, manifest.system.constitution))) {
    findings.push(err('LINT-02', 'system.manifest.yaml', `system.constitution points at "${manifest.system.constitution}", which does not exist.`));
  }

  /* LINT-03 declared deps, LINT-06 warnings */
  const edges = new Map<string, string[]>();
  for (const boundary of boundaries) {
    edges.set(boundary.domain, boundary.depends_on);
    for (const dep of boundary.depends_on) {
      if (!domains.has(dep)) {
        findings.push(err('LINT-03', 'system.manifest.yaml', `Boundary "${boundary.domain}" depends on undeclared domain "${dep}".`));
      }
    }
    if (!boundary.exports.length) findings.push(warn('LINT-06', 'system.manifest.yaml', `Boundary "${boundary.domain}" exports nothing.`));
  }

  /* LINT-04 acyclicity */
  const cycle = findCycle(edges);
  if (cycle) {
    findings.push(err('LINT-04', 'system.manifest.yaml', `Circular dependency in the architecture DAG: ${cycle.join(' -> ')}.`));
  }

  /* LINT-07 invariants reference constitution articles */
  const articleIds = new Set((constitution?.constitution?.articles ?? []).map((a) => a.id));
  for (const invariant of manifest.invariants) {
    if (/^ART-\d{2}$/.test(invariant)) {
      if (!articleIds.has(invariant)) findings.push(err('LINT-07', 'system.manifest.yaml', `Invariant references "${invariant}", which is not an article in the constitution.`));
    } else {
      findings.push(warn('LINT-07', 'system.manifest.yaml', `Invariant "${truncate(invariant)}" is free text; prefer an ART-nn reference so it is enforceable.`));
    }
  }

  /* LINT-16 / LINT-17 decisions and citations */
  const ledgerByUrl = new Map(sources.map((s) => [s.url, s]));
  for (const decision of manifest.decisions) {
    for (const url of decision.sources) {
      if (!url.startsWith('https://')) {
        findings.push(err('LINT-16', 'system.manifest.yaml', `${decision.id} cites "${url}"; decision sources must use https.`));
        continue;
      }
      const source = ledgerByUrl.get(url);
      if (!source) {
        findings.push(err('LINT-16', 'system.manifest.yaml', `${decision.id} cites "${url}", which is not recorded in the research ledger.`));
        continue;
      }
      if (source.verified.status !== 'verified') {
        findings.push(err('LINT-17', 'research ledger', `${decision.id} cites "${url}" whose verification status is "${source.verified.status}". Run "aose research-verify" and drop or replace sources that do not match.`));
      }
    }
  }

  /* per-domain spec rules */
  for (const boundary of boundaries) {
    const spec = specs[boundary.domain];
    if (!spec) continue;
    const where = boundary.spec;

    if (spec.module !== boundary.domain) {
      findings.push(err('LINT-08', where, `spec.module is "${spec.module}" but the manifest boundary is "${boundary.domain}".`));
    }

    /* LINT-09 types block is real, and defines Result if contracts use it */
    if (!/\b(type|interface)\s+\w+/.test(spec.types)) {
      findings.push(err('LINT-09', where, 'types block declares no type or interface.'));
    }
    /* A spec may define Result itself or import it from an upstream domain.
       An import is a declaration of where the type comes from, which is what
       this rule is actually checking for. */
    const usesResult = Object.keys(spec.contracts).some((sig) => /Result\s*</.test(parseSignature(sig)?.returns ?? ''));
    const definesResult = /\b(type|interface)\s+Result\b/.test(spec.types) || /\{\s*ok\s*:/.test(spec.types);
    const importsResult = /\bimport\s+type\s*\{[^}]*\bResult\b[^}]*\}\s*from\s*['"]([^'"]+)['"]/.test(spec.types);
    if (usesResult && !definesResult && !importsResult) {
      findings.push(err('LINT-09', where, 'contracts return Result<...> but the types block neither defines Result nor imports it from an upstream domain.'));
    }

    const declaredErrors = new Set<string>();
    for (const match of spec.types.matchAll(/'([A-Z0-9_]+)'/g)) declaredErrors.add(match[1]);
    for (const match of spec.types.matchAll(/\bimport\s+type\s*\{([^}]*)\}/g)) {
      for (const name of match[1].split(',')) declaredErrors.add(name.trim());
    }

    for (const [signature, contract] of Object.entries(spec.contracts)) {
      /* LINT-10 pre + post (NL2Contract) */
      if (!contract.precondition.trim()) findings.push(err('LINT-10', where, `Contract "${signature}" has no precondition.`));
      if (!contract.postcondition.trim()) findings.push(err('LINT-10', where, `Contract "${signature}" has no postcondition.`));

      /* LINT-11 signature parses */
      const parsed = parseSignature(signature);
      if (!parsed) {
        findings.push(err('LINT-11', where, `Contract key "${signature}" is not a parseable signature of the form name(params): ReturnType.`));
        continue;
      }

      /* LINT-12 / LINT-13 error containment */
      const returnClass = classifyReturn(parsed.returns, spec.types);
      if (contract.kind === 'transition' && returnClass === 'bare') {
        findings.push(err('LINT-12', where, `Transition contract "${parsed.name}" returns bare "${parsed.returns}". A state transition must return a discriminated result (Result<T, E>, an { ok: true } | { ok: false } union, or a T | Error union) so failures are values, not throws. Named aliases are resolved against this spec\u0027s own types block.`));
      }
      if (contract.kind === 'query' && returnClass === 'bare') {
        findings.push(warn('LINT-13', where, `Query contract "${parsed.name}" returns bare "${parsed.returns}". Acceptable for a total function; confirm it cannot fail.`));
      }

      /* declared error codes must exist in the types block */
      for (const code of contract.errors) {
        if (!declaredErrors.has(code) && !spec.types.includes(code)) {
          findings.push(err('LINT-09', where, `Contract "${parsed.name}" declares error "${code}", which does not appear in the types block.`));
        }
      }
    }

    /* LINT-30: a domain may only reach sources a constitution allowlist cleared.
       This is the rule that turns "we do not break a site's terms" from an
       intention into a check: an uncleared host fails the blueprint here,
       before any worker is ever handed the spec. */
    const allowlists = new Map((constitution?.constitution?.allowlists ?? []).map((list) => [list.id, list]));
    const allowedOrigins: string[] = (constitution?.constitution?.allowlists ?? []).flatMap((list) => list.entries);
    for (const source of spec.external_sources ?? []) {
      const list = allowlists.get(source.allowlist);
      if (!list) {
        findings.push(err('LINT-30', where, `"${source.url}" cites allowlist "${source.allowlist}", which the constitution does not define.`));
        continue;
      }
      if (!list.entries.some((entry) => sameOrigin(source.url, entry))) {
        findings.push(err('LINT-30', where, `"${source.url}" is not on the "${source.allowlist}" allowlist. Add it to the constitution with a rationale, or drop the source. Reason the list exists: ${list.rationale}`));
      }
      allowedOrigins.push(source.url);
      if (source.access === 'authenticated' && !/\bkey\b|\btoken\b|\bcredential/i.test(source.note)) {
        findings.push(warn('LINT-30', where, `"${source.url}" is marked authenticated but its note does not say which credential it needs.`));
      }
    }

    /* LINT-27 / LINT-28: the design plane binding for a surface domain. */
    const isSurface = /^ui\//.test(boundary.domain);
    if (spec.design) {
      if (!isContained(input.dir, spec.design.contract)) {
        findings.push(err('LINT-27', where, `design.contract "${spec.design.contract}" resolves outside the project.`));
      } else if (!existsSync(join(input.dir, spec.design.contract))) {
        findings.push(err('LINT-27', where, `design.contract "${spec.design.contract}" does not exist. Run ls-design-contract before compiling this surface.`));
      }
      if (spec.design.handoff) {
        if (!isContained(input.dir, spec.design.handoff)) {
          findings.push(err('LINT-28', where, `design.handoff "${spec.design.handoff}" resolves outside the project's design directory. A worker's inputs must come from its own project.`));
          continue;
        }
        const handoffDir = containedPath(input.dir, spec.design.handoff);
        if (!existsSync(handoffDir)) {
          findings.push(err('LINT-28', where, `design.handoff "${spec.design.handoff}" does not exist. The studio writes it only when every screen is approved.`));
        } else {
          const brief = join(handoffDir, 'BRIEF.md');
          if (!existsSync(brief)) findings.push(err('LINT-28', where, 'the handoff has no BRIEF.md, so it did not come from a passing studio gate.'));
          else if (/not\s+hav(e|ing)\s+passed\s+the\s+gate|provisional/i.test(readFileSync(brief, 'utf8'))) {
            findings.push(err('LINT-28', where, 'the handoff is stamped as a forced export that did not pass the studio gate. Approve the remaining screens or accept it explicitly.'));
          }
        }
      }
      /* LINT-32..35: the checkable design contract.
         LINT-27/28 above prove files exist. These prove the contract can
         actually bite: that it is present, that it still describes the tokens
         it was approved against, that every surface says what it is, and that
         it declares the negative constraints a review can cite. */
      const systemPath = spec.design.system;
      if (systemPath) {
        if (!isContained(input.dir, systemPath)) {
          findings.push(err('LINT-32', where, `design.system "${systemPath}" resolves outside the project.`));
        } else if (!existsSync(join(input.dir, systemPath))) {
          findings.push(err('LINT-32', where, `design.system "${systemPath}" does not exist. It is the design plane's constitution; without it nothing about this surface is checkable.`));
        } else {
          let system: any = null;
          try { system = YAML.parse(readFileSync(join(input.dir, systemPath), 'utf8'))?.design_system ?? null; }
          catch (error) { findings.push(err('LINT-32', where, `design.system "${systemPath}" is not readable YAML: ${(error as Error).message}`)); }

          if (system) {
            /* LINT-33: drift. design.json owns tokensHash; the contract froze one.
               A tokens.css edited after approval is exactly what this catches, and
               it is the design-plane twin of an approval superseded by a later edit. */
            const declared = String(system.tokens_hash ?? '').replace(/^sha256:/, '');
            const statePath = join(input.dir, 'design', 'design.json');
            if (!declared) {
              findings.push(err('LINT-33', where, 'design.system declares no tokens_hash, so nothing binds the contract to the tokens it was approved against.'));
            } else if (existsSync(statePath)) {
              try {
                const actual = String(JSON.parse(readFileSync(statePath, 'utf8'))?.tokensHash ?? '');
                if (actual && actual !== declared) {
                  findings.push(err('LINT-33', where, `tokens drift: design.system froze ${declared.slice(0, 12)}… but design.json now reports ${actual.slice(0, 12)}…. The tokens changed after the contract was written; re-approve them or restore the frozen set.`));
                }
              } catch { /* design.json unreadable is LINT-27's business, not this rule's */ }
            }

            /* LINT-34: a surface that does not say what it is cannot be checked
               against required_states, so the state scenarios would silently pass. */
            const required: string[] = Array.isArray(system.required_states) ? system.required_states : [];
            for (const surface of spec.design.surfaces ?? []) {
              if (typeof surface === 'string') {
                findings.push(warn('LINT-34', where, `surface "${surface}" is a bare name. Give it a density and the states it must prove, or it inherits ${required.length} required state(s) it was never checked for.`));
                continue;
              }
              const missing = required.filter((state) => !(surface.states ?? []).includes(state));
              if (missing.length && surface.states?.length) {
                findings.push(warn('LINT-34', where, `surface "${surface.id}" omits required state(s): ${missing.join(', ')}. Declare them, or say why they do not apply.`));
              }
            }

            /* LINT-35 / ART-11: a review with nothing to cite has reviewed nothing. */
            const anti = system.direction?.anti_direction;
            if (!Array.isArray(anti) || anti.length === 0) {
              findings.push(err('LINT-35', where, 'design.system declares no anti_direction. "Is this good?" cannot be scored; a named list of what the design must not be is the only checkable half (ART-11).'));
            } else {
              for (const entry of anti) {
                if (!entry?.source) {
                  findings.push(warn('LINT-35', where, `anti_direction "${entry?.id ?? '?'}" cites no source. A reviewer must be able to check the rule, not just trust the list.`));
                }
                if (entry?.threshold && (entry.components?.length ?? 0) < entry.threshold) {
                  findings.push(err('LINT-35', where, `anti_direction "${entry.id}" needs ${entry.threshold} matching components but lists only ${entry.components?.length ?? 0}. It can never fire.`));
                }
              }
            }
          }
        }
      } else if (isSurface) {
        findings.push(warn('LINT-32', where, `"${boundary.domain}" binds a design contract but no design.system. Only file existence is checked; nothing measures contrast, scales or direction.`));
      }
    } else if (isSurface) {
      findings.push(warn('LINT-27', where, `"${boundary.domain}" is a surface domain with no design binding. Add a design block naming its contract, or the worker will invent the visual language.`));
    }

    /* LINT-31: the declaration check above governs the blueprint, not the
       running worker. Scan whatever code exists for URL literals naming a host
       no allowlist cleared, so a source that was never declared still fails
       here rather than only at code review. This is a static check over
       artifacts, not a network sandbox; see docs/HARNESS.md for the limit. */
    if (spec.external_sources?.length || allowedOrigins.length) {
      const deliverables = tasks[boundary.domain]?.task.deliverables ?? [];
      for (const deliverable of deliverables) {
        const path = join(input.dir, deliverable);
        if (!existsSync(path)) continue;
        for (const host of undeclaredHosts(readFileSync(path, 'utf8'), allowedOrigins)) {
          findings.push(err('LINT-31', deliverable, `reaches "${host}", which no constitution allowlist cleared. Add the source to an allowlist with a rationale, or remove the call.`));
        }
      }
    }

    /* LINT-14 EARS, LINT-15 traceability */
    const scenarioIds = new Set(spec.verification.scenarios.map((s) => s.id));
    for (const requirement of spec.requirements) {
      if (!EARS_PATTERN.test(requirement.ears)) {
        findings.push(err('LINT-14', where, `${requirement.id} is not in EARS form: "${truncate(requirement.ears)}".`));
      }
      for (const scenario of requirement.verified_by) {
        if (!scenarioIds.has(scenario)) {
          findings.push(err('LINT-15', where, `${requirement.id} says it is verified by ${scenario}, which is not a declared scenario.`));
        }
      }
    }
    const covered = new Set(spec.requirements.flatMap((r) => r.verified_by));
    for (const scenario of spec.verification.scenarios) {
      if (!scenario.test_name.trim()) {
        findings.push(err('LINT-15', where, `Scenario ${scenario.id} has no test_name; the worker cannot be held to a nameless test.`));
      }
      if (!covered.has(scenario.id)) {
        findings.push(warn('LINT-15', where, `Scenario ${scenario.id} is not referenced by any requirement.`));
      }
    }
  }

  /* per-domain task rules */
  for (const boundary of boundaries) {
    const task = tasks[boundary.domain]?.task;
    if (!task) continue;
    const where = boundary.task;

    if (!domains.has(task.target_module)) {
      findings.push(err('LINT-18', where, `task.target_module "${task.target_module}" is not a declared boundary.`));
    } else if (task.target_module !== boundary.domain) {
      findings.push(err('LINT-18', where, `task.target_module "${task.target_module}" does not match its boundary "${boundary.domain}".`));
    }
    if (!task.execution_gate.command.trim()) findings.push(err('LINT-18', where, 'execution_gate.command is empty; there is nothing to prove the work.'));
    if (!task.execution_gate.success_criteria.trim()) findings.push(err('LINT-18', where, 'execution_gate.success_criteria is empty.'));

    /* LINT-19 deliverables + upstream exports */
    const seen = new Set<string>();
    for (const deliverable of task.deliverables) {
      if (seen.has(deliverable)) findings.push(err('LINT-19', where, `Duplicate deliverable "${deliverable}".`));
      seen.add(deliverable);
      if (isAbsolute(deliverable) || normalize(deliverable).startsWith('..')) {
        findings.push(err('LINT-19', where, `Deliverable "${deliverable}" must be a relative path inside the workspace.`));
      }
    }
    for (const [upstream, exported] of Object.entries(task.context.upstream_exports)) {
      if (!boundary.depends_on.includes(upstream)) {
        findings.push(err('LINT-19', where, `upstream_exports names "${upstream}", which "${boundary.domain}" does not depend on.`));
        continue;
      }
      const declared = new Set(boundaries.find((b) => b.domain === upstream)?.exports ?? []);
      for (const name of exported) {
        if (!declared.has(name)) {
          findings.push(err('LINT-19', where, `upstream_exports claims "${upstream}" exports "${name}", which its boundary does not declare.`));
        }
      }
    }
    for (const article of task.context.constitution_articles) {
      if (articleIds.size && !articleIds.has(article)) {
        findings.push(err('LINT-18', where, `task context names article "${article}", which is not in the constitution.`));
      }
    }
    if (task.context.spec !== boundary.spec) {
      findings.push(warn('LINT-18', where, `task.context.spec "${task.context.spec}" differs from the boundary's spec "${boundary.spec}".`));
    }

    /* LINT-29: the studio's quarantined fixture values must not be shipped.
       A generated screen carries invented prices and names so a builder can
       recognize them, not so they reach production. */
    const designBinding = specs[boundary.domain]?.design;
    if (designBinding?.handoff && isContained(input.dir, designBinding.handoff)) {
      const fixtures = join(containedPath(input.dir, designBinding.handoff), 'fixtures');
      if (existsSync(fixtures)) {
        const quarantined = collectFixtureValues(fixtures);
        for (const deliverable of task.deliverables) {
          const path = join(input.dir, deliverable);
          if (!existsSync(path)) continue;
          const body = readFileSync(path, 'utf8');
          const leaked = quarantined.filter((value) => body.includes(value));
          if (leaked.length) {
            findings.push(err('LINT-29', deliverable, `ships quarantined fixture values from the design handoff: ${leaked.slice(0, 3).join(', ')}. Replace them with real content or an explicit empty state.`));
          }
        }
      }
    }

    /* LINT-24 payload budget (context is a finite resource) */
    const budget = constitution?.constitution?.budgets?.max_payload_tokens ?? 4000;
    const spec = specs[boundary.domain];
    if (spec) {
      const estimate = estimatePayloadTokens(spec, task, constitution);
      if (estimate > budget) {
        findings.push(err('LINT-24', where, `Estimated worker payload is ~${estimate} tokens, over the ${budget}-token budget. Split the domain or trim the spec.`));
      } else if (estimate > budget * 0.8) {
        findings.push(warn('LINT-24', where, `Estimated worker payload is ~${estimate} tokens, within 20% of the ${budget}-token budget.`));
      }
    }
  }

  /* LINT-23 approval must not survive a later edit */
  if (input.approval && input.latestArtifactEdit && input.latestArtifactEdit > input.approval.created_at) {
    findings.push(err('LINT-23', 'approvals', 'An artifact was edited after the recorded approval. Re-run review and approve before dispatching.'));
  }

  return finalize(findings);
}

export function estimatePayloadTokens(spec: Spec, task: Task['task'], constitution?: Constitution): number {
  const articles = (constitution?.constitution?.articles ?? [])
    .filter((a) => (task.context.constitution_articles ?? []).includes(a.id))
    .map((a) => `${a.id} ${a.title} ${a.rule}`)
    .join('\n');
  const body = [
    articles,
    JSON.stringify(spec),
    JSON.stringify(task.deliverables),
    task.execution_gate.command,
    task.execution_gate.success_criteria,
  ].join('\n');
  return Math.ceil(body.length / 4);
}

/**
 * Hosts a body of code reaches that no allowlist cleared.
 *
 * Localhost and relative URLs are ignored; this is about third-party egress.
 * It reads source text, so it catches a literal but not a host assembled at
 * runtime. The allowlist is a design-time and artifact-time control, not a
 * runtime sandbox, and the docs say so rather than overclaiming.
 */
export function undeclaredHosts(source: string, allowedEntries: string[]): string[] {
  const allowed = new Set<string>();
  for (const entry of allowedEntries) {
    try { allowed.add(new URL(entry).host); } catch { /* not a url */ }
  }
  const local = /^(localhost|127\.|0\.0\.0\.0|::1|\[::1\])/;
  const found = new Set<string>();
  for (const match of source.matchAll(/https?:\/\/([A-Za-z0-9.-]+(?::\d+)?)/g)) {
    const host = match[1];
    if (local.test(host) || allowed.has(host)) continue;
    if (host.endsWith('.local') || host === 'example.com') continue;
    found.add(host);
  }
  return [...found];
}

/** Two URLs match if the allowlist entry is a prefix of, or shares an origin with, the source. */
export function sameOrigin(url: string, entry: string): boolean {
  if (url === entry || url.startsWith(entry)) return true;
  try {
    const left = new URL(url);
    const right = new URL(entry);
    return left.origin === right.origin && left.pathname.startsWith(right.pathname.replace(/\/$/, ''));
  } catch {
    return false;
  }
}

/** Distinct string and number literals a handoff quarantined as invented. */
export function collectFixtureValues(fixturesDir: string): string[] {
  const values = new Set<string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.(json|ya?ml)$/.test(entry.name)) continue;
      let parsed: unknown;
      try { parsed = JSON.parse(readFileSync(full, 'utf8')); } catch { continue; }
      const visit = (node: unknown): void => {
        if (typeof node === 'string' && node.trim().length >= 4) values.add(node);
        else if (typeof node === 'number') values.add(String(node));
        else if (Array.isArray(node)) node.forEach(visit);
        else if (node && typeof node === 'object') Object.values(node as Record<string, unknown>).forEach(visit);
      };
      visit(parsed);
    }
  };
  try { walk(fixturesDir); } catch { /* no fixtures is fine */ }
  return [...values];
}

function resolvePath(dir: string, target: string): string {
  return containedPath(dir, target);
}

function truncate(text: string, max = 60): string {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function finalize(findings: Finding[]): LintResult {
  const errors = findings.filter((f) => f.severity === 'error');
  const warnings = findings.filter((f) => f.severity === 'warn');
  return { errors, warnings, ok: errors.length === 0 };
}

/** Lint a blueprint directory end to end. */
export function lintDir(dir: string, extra: Partial<LintInput> = {}): LintResult {
  const { input, findings } = loadBlueprintDir(dir);
  const result = lint({ ...input, ...extra });
  const errors = [...findings.filter((f) => f.severity === 'error'), ...result.errors];
  const warnings = [...findings.filter((f) => f.severity === 'warn'), ...result.warnings];
  return { errors, warnings, ok: errors.length === 0 };
}
