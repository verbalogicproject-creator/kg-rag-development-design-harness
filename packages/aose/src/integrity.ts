/**
 * Content addressing and path containment.
 *
 * An adversarial review of this harness found that an approval was bound to
 * nothing: it survived any edit the harness did not happen to notice, and a
 * design handoff path could escape its own project and seed another one's
 * files into a supposedly cold worker. Both holes come from trusting a name
 * where a hash or a containment check was needed, so both live here.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';

/** Files whose content an approval is bound to, in a stable order. */
export const APPROVED_ARTIFACTS = [
  'constitution.yaml', 'idea.yaml', 'system.manifest.yaml', 'sources.yaml', 'topo_order.yaml',
];

export interface DigestEntry { path: string; sha256: string }
export interface Digest { value: string; entries: DigestEntry[] }

function hashFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** Every file under a directory, relative and sorted, skipping noise. */
function walk(root: string, prefix = ''): string[] {
  const out: string[] = [];
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(join(root, entry.name), rel));
    else out.push(rel);
  }
  return out;
}

/**
 * A digest over everything an approval covers: the blueprint artifacts, every
 * spec and task, the design contract and the frozen handoff. Approving records
 * it; dispatching recomputes it. A change anywhere invalidates the approval
 * whether or not the harness was the thing that made the change.
 */
export function approvalDigest(blueprintDir: string, extraFiles: string[] = [], designDir?: string): Digest {
  const entries: DigestEntry[] = [];

  const add = (absolute: string, label: string): void => {
    if (!existsSync(absolute) || !statSync(absolute).isFile()) return;
    entries.push({ path: label, sha256: hashFile(absolute) });
  };

  for (const name of APPROVED_ARTIFACTS) add(join(blueprintDir, name), name);
  for (const name of [...extraFiles].sort()) add(join(blueprintDir, name), name);

  if (designDir && existsSync(designDir)) {
    for (const rel of walk(designDir)) {
      /* An approval covers what a person approved: the contract, the tokens,
         the screens. Not the directory's incidental contents.
         
         Two things were leaking in. `design-check` writes
         __checks__/tokens.report.json, so RUNNING the design gate changed the
         digest the approval is bound to — a read-only check invalidating the
         approval it had just verified. And an unrelated tool kept read logs in
         design/.vouch/, so merely LOOKING at a screen did the same. Between
         them the digest moved from e144d4d7 to 28a0a5f4 to 947e32ff without a
         single authored byte changing.
         
         So: no dot-prefixed segment anywhere in the path — that is tooling
         state by convention, which is what the original `.studio` exclusion
         was already saying — no lockfiles, and none of the harness's own
         generated reports. */
      if (rel.endsWith('.lock')) continue;
      if (rel.split(/[/\\]/).some((segment) => segment.startsWith('.'))) continue;
      if (rel.startsWith('__checks__')) continue;
      add(join(designDir, rel), `design/${rel}`);
    }
  }

  const combined = createHash('sha256');
  for (const entry of entries) combined.update(`${entry.path} ${entry.sha256} `);
  return { value: combined.digest('hex'), entries };
}

/** A digest of the files a worker actually produced, used to bind evidence to a run. */
export function worktreeDigest(worktree: string, files: string[]): string {
  const hash = createHash('sha256');
  for (const file of [...files].sort()) {
    const path = join(worktree, file);
    hash.update(`${file} `);
    hash.update(existsSync(path) && statSync(path).isFile() ? hashFile(path) : 'ABSENT');
    hash.update(' ');
  }
  return hash.digest('hex');
}

export class PathEscapeError extends Error {
  constructor(target: string, root: string) {
    super(`Path "${target}" resolves outside "${root}". A blueprint may only reference files inside its own project.`);
    this.name = 'PathEscapeError';
  }
}

/**
 * Resolve a blueprint-declared path and refuse anything outside its root.
 * Absolute paths, `..` traversal and symlinks that point away are all rejected,
 * because a cold worker's inputs must come from its own project and nowhere else.
 */
export function containedPath(root: string, target: string): string {
  if (isAbsolute(target)) throw new PathEscapeError(target, root);
  const normalized = normalize(target);
  if (normalized === '..' || normalized.startsWith(`..${sep}`)) throw new PathEscapeError(target, root);

  const resolvedRoot = existsSync(root) ? realpathSync(resolve(root)) : resolve(root);
  const candidate = resolve(root, normalized);
  const resolved = existsSync(candidate) ? realpathSync(candidate) : candidate;

  const rel = relative(resolvedRoot, resolved);
  if (rel === '') return resolved;
  if (rel.startsWith('..') || isAbsolute(rel)) throw new PathEscapeError(target, root);
  return resolved;
}

/** Containment as a boolean, for a linter that reports rather than throws. */
export function isContained(root: string, target: string): boolean {
  try { containedPath(root, target); return true; } catch { return false; }
}
