/**
 * Workflow state and evidence store.
 *
 * The `projects` / `revisions` / `approvals` tables are ported from the Codex
 * harness's Store (blue/brainstorm-to-implementation-plan-harness/src/store.ts),
 * which established append-only revisions as artifact provenance. Added here:
 * `sources` (research ledger with a verify status), `runs` (dispatch + gate
 * evidence the harness produced itself), `transitions` (an auditable FSM log,
 * per Alfredvc/aharness), `findings`, and `approvals.superseded_at` so an
 * approval cannot silently survive a later edit.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type ProjectState =
  | 'IDEA_DRAFT' | 'IDEA_READY' | 'COMPILED' | 'LINTED' | 'AWAITING_APPROVAL'
  | 'APPROVED' | 'DISPATCHED' | 'BLOCKED' | 'GATED' | 'CONVERGED'
  | 'EXPORTED' | 'ARCHIVED' | 'ABANDONED';

export interface Project {
  slug: string;
  state: ProjectState;
  respec_count: number;
  createdAt: string;
  updatedAt: string;
}

export interface RunRow {
  id: number;
  slug: string;
  domain: string;
  adapter: string;
  attempt: number;
  started_at: string;
  finished_at: string;
  worker_exit: number | null;
  gate_exit: number | null;
  gate_stdout_sha256: string;
  duration_ms: number;
  run_dir: string;
  /** Constraint ids this run was held to, as JSON. The join key for `recall`. */
  constraints: string;
  notes: string;
}

const now = () => new Date().toISOString();

export class Ledger {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        slug TEXT PRIMARY KEY, state TEXT NOT NULL, respec_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS revisions (
        id INTEGER PRIMARY KEY, slug TEXT NOT NULL, kind TEXT NOT NULL,
        body TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS approvals (
        id INTEGER PRIMARY KEY, slug TEXT NOT NULL, approved_by TEXT NOT NULL,
        created_at TEXT NOT NULL, superseded_at TEXT, digest TEXT NOT NULL DEFAULT '');
      CREATE TABLE IF NOT EXISTS sources (
        id INTEGER PRIMARY KEY, slug TEXT NOT NULL, url TEXT NOT NULL,
        body TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(slug, url));
      CREATE TABLE IF NOT EXISTS runs (
        id INTEGER PRIMARY KEY, slug TEXT NOT NULL, domain TEXT NOT NULL, adapter TEXT NOT NULL,
        attempt INTEGER NOT NULL, started_at TEXT NOT NULL, finished_at TEXT NOT NULL DEFAULT '',
        worker_exit INTEGER, gate_exit INTEGER, gate_stdout_sha256 TEXT NOT NULL DEFAULT '',
        duration_ms INTEGER NOT NULL DEFAULT 0, run_dir TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '',
        constraints TEXT NOT NULL DEFAULT '[]');
      CREATE TABLE IF NOT EXISTS transitions (
        id INTEGER PRIMARY KEY, slug TEXT NOT NULL, from_state TEXT NOT NULL, to_state TEXT NOT NULL,
        event TEXT NOT NULL, created_at TEXT NOT NULL, evidence_revision_id INTEGER);
      CREATE TABLE IF NOT EXISTS findings (
        id INTEGER PRIMARY KEY, slug TEXT NOT NULL, phase TEXT NOT NULL,
        body TEXT NOT NULL, created_at TEXT NOT NULL);
    `);

    /* A run records which constraints applied to it. Without that there is
       nothing for `recall` to join on, and recall would have to guess which
       prior work is relevant — which is the fuzzy matching this whole design
       avoids. Added by migration so an existing ledger keeps working. */
    const columns = this.db.prepare(`PRAGMA table_info(runs)`).all() as { name: string }[];
    if (!columns.some((column) => column.name === 'constraints')) {
      this.db.exec(`ALTER TABLE runs ADD COLUMN constraints TEXT NOT NULL DEFAULT '[]'`);
    }
  }

  /* projects */
  createProject(slug: string): Project {
    const at = now();
    this.db.prepare('INSERT INTO projects (slug, state, respec_count, created_at, updated_at) VALUES (?, ?, 0, ?, ?)')
      .run(slug, 'IDEA_DRAFT', at, at);
    this.logTransition(slug, 'NONE', 'IDEA_DRAFT', 'init', null);
    return this.getProject(slug)!;
  }

  getProject(slug: string): Project | undefined {
    const row = this.db.prepare('SELECT * FROM projects WHERE slug = ?').get(slug) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      slug: row.slug as string,
      state: row.state as ProjectState,
      respec_count: Number(row.respec_count),
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }

  listProjects(): Project[] {
    const rows = this.db.prepare('SELECT slug FROM projects ORDER BY created_at').all() as { slug: string }[];
    return rows.map((r) => this.getProject(r.slug)!);
  }

  setState(slug: string, state: ProjectState): void {
    this.db.prepare('UPDATE projects SET state = ?, updated_at = ? WHERE slug = ?').run(state, now(), slug);
  }

  /** Atomically consume one respec allowance, refusing once the bound is spent. */
  consumeRespec(slug: string, maxRespec: number): { allowed: boolean; used: number; remaining: number } {
    const project = this.getProject(slug);
    if (!project) return { allowed: false, used: 0, remaining: 0 };
    if (project.respec_count >= maxRespec) {
      return { allowed: false, used: project.respec_count, remaining: 0 };
    }
    const used = this.bumpRespec(slug);
    return { allowed: true, used, remaining: Math.max(0, maxRespec - used) };
  }

  bumpRespec(slug: string): number {
    this.db.prepare('UPDATE projects SET respec_count = respec_count + 1, updated_at = ? WHERE slug = ?').run(now(), slug);
    return this.getProject(slug)!.respec_count;
  }

  /* revisions (append-only, Codex) */
  addRevision(slug: string, kind: string, body: unknown): number {
    const result = this.db.prepare('INSERT INTO revisions (slug, kind, body, created_at) VALUES (?, ?, ?, ?)')
      .run(slug, kind, JSON.stringify(body), now());
    return Number(result.lastInsertRowid);
  }

  latest<T>(slug: string, kind: string): T | undefined {
    const row = this.db.prepare('SELECT body FROM revisions WHERE slug = ? AND kind = ? ORDER BY id DESC LIMIT 1')
      .get(slug, kind) as { body: string } | undefined;
    return row ? (JSON.parse(row.body) as T) : undefined;
  }

  latestRevisionId(slug: string, kind: string): number | undefined {
    const row = this.db.prepare('SELECT id FROM revisions WHERE slug = ? AND kind = ? ORDER BY id DESC LIMIT 1')
      .get(slug, kind) as { id: number } | undefined;
    return row ? Number(row.id) : undefined;
  }

  all<T>(slug: string, kind: string): T[] {
    const rows = this.db.prepare('SELECT body FROM revisions WHERE slug = ? AND kind = ? ORDER BY id').all(slug, kind) as { body: string }[];
    return rows.map((r) => JSON.parse(r.body) as T);
  }

  /* approvals */
  /** An approval is bound to a digest of exactly what was approved. */
  addApproval(slug: string, by: string, digest = ''): void {
    this.db.prepare('INSERT INTO approvals (slug, approved_by, created_at, digest) VALUES (?, ?, ?, ?)')
      .run(slug, by, now(), digest);
  }

  activeApproval(slug: string): { approved_by: string; created_at: string; digest: string } | undefined {
    return this.db.prepare('SELECT approved_by, created_at, digest FROM approvals WHERE slug = ? AND superseded_at IS NULL ORDER BY id DESC LIMIT 1')
      .get(slug) as { approved_by: string; created_at: string; digest: string } | undefined;
  }

  supersedeApprovals(slug: string): void {
    this.db.prepare('UPDATE approvals SET superseded_at = ? WHERE slug = ? AND superseded_at IS NULL').run(now(), slug);
  }

  /* research ledger */
  upsertSource(slug: string, source: { url: string } & Record<string, unknown>): void {
    this.db.prepare(`INSERT INTO sources (slug, url, body, created_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(slug, url) DO UPDATE SET body = excluded.body`).run(slug, source.url, JSON.stringify(source), now());
  }

  sources<T>(slug: string): T[] {
    const rows = this.db.prepare('SELECT body FROM sources WHERE slug = ? ORDER BY id').all(slug) as { body: string }[];
    return rows.map((r) => JSON.parse(r.body) as T);
  }

  source<T>(slug: string, url: string): T | undefined {
    const row = this.db.prepare('SELECT body FROM sources WHERE slug = ? AND url = ?').get(slug, url) as { body: string } | undefined;
    return row ? (JSON.parse(row.body) as T) : undefined;
  }

  /* runs — evidence the harness produced, never a worker's claim */
  startRun(slug: string, domain: string, adapter: string, attempt: number, runDir: string, constraints: string[] = []): number {
    const result = this.db.prepare('INSERT INTO runs (slug, domain, adapter, attempt, started_at, run_dir, constraints) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(slug, domain, adapter, attempt, now(), runDir, JSON.stringify([...constraints].sort()));
    return Number(result.lastInsertRowid);
  }

  finishRun(id: number, patch: { worker_exit?: number | null; gate_exit?: number | null; gate_stdout_sha256?: string; duration_ms?: number; notes?: string }): void {
    this.db.prepare(`UPDATE runs SET finished_at = ?, worker_exit = ?, gate_exit = ?,
      gate_stdout_sha256 = ?, duration_ms = ?, notes = ? WHERE id = ?`)
      .run(now(), patch.worker_exit ?? null, patch.gate_exit ?? null,
        patch.gate_stdout_sha256 ?? '', patch.duration_ms ?? 0, patch.notes ?? '', id);
  }

  runs(slug: string, domain?: string): RunRow[] {
    const rows = domain
      ? this.db.prepare('SELECT * FROM runs WHERE slug = ? AND domain = ? ORDER BY id').all(slug, domain)
      : this.db.prepare('SELECT * FROM runs WHERE slug = ? ORDER BY id').all(slug);
    return (rows as Record<string, unknown>[]).map((r) => ({
      id: Number(r.id), slug: r.slug as string, domain: r.domain as string, adapter: r.adapter as string,
      attempt: Number(r.attempt), started_at: r.started_at as string, finished_at: r.finished_at as string,
      worker_exit: r.worker_exit === null ? null : Number(r.worker_exit),
      gate_exit: r.gate_exit === null ? null : Number(r.gate_exit),
      gate_stdout_sha256: r.gate_stdout_sha256 as string, duration_ms: Number(r.duration_ms),
      run_dir: r.run_dir as string, notes: r.notes as string,
    }));
  }

  /** Every run across every project. `recall` joins on constraints, not on slug:
   *  a failure under the same constraint is relevant wherever it happened. */
  allRuns(): RunRow[] {
    return this.db.prepare('SELECT * FROM runs ORDER BY id').all() as unknown as RunRow[];
  }

  attemptsFor(slug: string, domain: string, adapter?: string): number {
    const row = adapter
      ? this.db.prepare('SELECT COUNT(*) AS n FROM runs WHERE slug = ? AND domain = ? AND adapter = ?').get(slug, domain, adapter)
      : this.db.prepare('SELECT COUNT(*) AS n FROM runs WHERE slug = ? AND domain = ?').get(slug, domain);
    return Number((row as { n: number }).n);
  }

  domainPassed(slug: string, domain: string): boolean {
    const row = this.db.prepare('SELECT 1 FROM runs WHERE slug = ? AND domain = ? AND gate_exit = 0 LIMIT 1').get(slug, domain);
    return Boolean(row);
  }

  /* transitions + findings */
  logTransition(slug: string, from: string, to: string, event: string, evidenceRevisionId: number | null): void {
    this.db.prepare('INSERT INTO transitions (slug, from_state, to_state, event, created_at, evidence_revision_id) VALUES (?, ?, ?, ?, ?, ?)')
      .run(slug, from, to, event, now(), evidenceRevisionId);
  }

  transitions(slug: string): { from_state: string; to_state: string; event: string; created_at: string }[] {
    return this.db.prepare('SELECT from_state, to_state, event, created_at FROM transitions WHERE slug = ? ORDER BY id')
      .all(slug) as { from_state: string; to_state: string; event: string; created_at: string }[];
  }

  addFinding(slug: string, phase: string, body: unknown): void {
    this.db.prepare('INSERT INTO findings (slug, phase, body, created_at) VALUES (?, ?, ?, ?)')
      .run(slug, phase, JSON.stringify(body), now());
  }

  findings(slug: string, phase?: string): { phase: string; body: unknown; created_at: string }[] {
    const rows = phase
      ? this.db.prepare('SELECT phase, body, created_at FROM findings WHERE slug = ? AND phase = ? ORDER BY id').all(slug, phase)
      : this.db.prepare('SELECT phase, body, created_at FROM findings WHERE slug = ? ORDER BY id').all(slug);
    return (rows as { phase: string; body: string; created_at: string }[])
      .map((r) => ({ phase: r.phase, body: JSON.parse(r.body), created_at: r.created_at }));
  }

  close(): void { this.db.close(); }
}
