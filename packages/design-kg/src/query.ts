/**
 * Traversals over the design graph.
 *
 * One small function per question, each hand-written against a declared
 * relation. No scoring, no embeddings, no thresholds to tune — with typed
 * directed edges most design questions are a walk, and a walk cannot be fooled
 * by fluent-irrelevant input the way a similarity score can.
 *
 * Every answer carries its evidence, and an answer with no support returns
 * `refused` with a reason rather than something plausible. That refusal is the
 * whole point: this graph exists because four direction families were invented
 * on the spot while five sat in the corpus, and the invention looked completely
 * reasonable.
 */
import { DatabaseSync } from 'node:sqlite';
import type { Relation } from './build.ts';

export interface Node {
  id: string; node_type: string; name: string; summary: string;
  metadata: Record<string, unknown>;
}
export interface Support {
  relation: Relation; from: string; to: string; rationale: string; source: string;
}
export interface Answer<T> {
  status: 'answer' | 'refused';
  reason?: 'no_support' | 'unknown_node' | 'no_candidates';
  items: T[];
  support: Support[];
  /** What the graph does know, so a refusal is actionable rather than a dead end. */
  known?: string[];
}

export class DesignGraph {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path, { readOnly: true });
  }

  close(): void { this.db.close(); }

  private hydrate(row: Record<string, unknown>): Node {
    return {
      id: String(row.id), node_type: String(row.node_type), name: String(row.name),
      summary: String(row.summary ?? ''),
      metadata: JSON.parse(String(row.metadata ?? '{}')),
    };
  }

  node(id: string): Node | null {
    const row = this.db.prepare('SELECT * FROM nodes WHERE id = ?').get(id);
    return row ? this.hydrate(row as Record<string, unknown>) : null;
  }

  ofKind(kind: string): Node[] {
    return this.db.prepare('SELECT * FROM nodes WHERE node_type = ? ORDER BY id').all(kind)
      .map((row) => this.hydrate(row as Record<string, unknown>));
  }

  /** Neighbours across one relation. `direction` decides which end is fixed. */
  neighbours(id: string, relation: Relation, direction: 'out' | 'in' | 'both' = 'out'): { node: Node; support: Support }[] {
    const clause = direction === 'out' ? 'source_id = ?' : direction === 'in' ? 'target_id = ?' : '(source_id = ? OR target_id = ?)';
    const args = direction === 'both' ? [id, id] : [id];
    const rows = this.db.prepare(
      `SELECT e.source_id, e.target_id, e.relation, e.metadata AS emeta, n.*
         FROM edges e JOIN nodes n
           ON n.id = CASE WHEN e.source_id = ? THEN e.target_id ELSE e.source_id END
        WHERE e.relation = ? AND ${clause}
        ORDER BY n.id`,
    ).all(id, relation, ...args) as Record<string, unknown>[];

    return rows.map((row) => {
      const meta = JSON.parse(String(row.emeta ?? '{}'));
      return {
        node: this.hydrate(row),
        support: {
          relation, from: String(row.source_id), to: String(row.target_id),
          rationale: String(meta.rationale ?? ''), source: String(meta.evidence_source ?? ''),
        },
      };
    });
  }

  /**
   * Which direction families suit these conditions.
   *
   * The question that was answered by invention. Ranked by how many of the
   * given conditions each family covers, with a `chosen` edge outranking a
   * `canon` one — a family someone actually picked for this shape of problem
   * is stronger evidence than a family the corpus merely describes.
   */
  directionsFor(conditionIds: string[]): Answer<{ direction: Node; covers: string[]; chosen: boolean }> {
    const unknown = conditionIds.filter((id) => !this.node(id));
    if (unknown.length) {
      return {
        status: 'refused', reason: 'unknown_node', items: [], support: [],
        known: this.ofKind('condition').map((node) => node.id),
      };
    }

    const tally = new Map<string, { covers: string[]; chosen: boolean; support: Support[] }>();
    for (const conditionId of conditionIds) {
      for (const { node, support } of this.neighbours(conditionId, 'suits_use_case', 'in')) {
        const entry = tally.get(node.id) ?? { covers: [], chosen: false, support: [] };
        entry.covers.push(conditionId);
        entry.support.push(support);
        tally.set(node.id, entry);
      }
    }
    // A chosen edge is a human decision; canon is a description. Rank accordingly.
    for (const [id, entry] of tally) {
      const rows = this.db.prepare(
        "SELECT metadata FROM edges WHERE relation = 'suits_use_case' AND source_id = ?",
      ).all(id) as Record<string, unknown>[];
      entry.chosen = rows.some((row) => JSON.parse(String(row.metadata ?? '{}')).provenance === 'chosen');
    }

    if (!tally.size) {
      return {
        status: 'refused', reason: 'no_support', items: [], support: [],
        known: this.ofKind('condition').map((node) => node.id),
      };
    }

    const items = [...tally.entries()]
      .map(([id, entry]) => ({ direction: this.node(id)!, covers: entry.covers, chosen: entry.chosen }))
      .sort((a, b) => b.covers.length - a.covers.length
        || Number(b.chosen) - Number(a.chosen)
        || a.direction.id.localeCompare(b.direction.id));

    return { status: 'answer', items, support: [...tally.values()].flatMap((entry) => entry.support) };
  }

  /** What choosing this commits you to, and what it warns you about. */
  commitments(directionId: string): Answer<{ node: Node; relation: Relation }> {
    if (!this.node(directionId)) {
      return { status: 'refused', reason: 'unknown_node', items: [], support: [], known: this.ofKind('direction_family').map((n) => n.id) };
    }
    const out: { node: Node; relation: Relation }[] = [];
    const support: Support[] = [];
    for (const relation of ['requires', 'warns_about'] as Relation[]) {
      for (const hit of this.neighbours(directionId, relation, 'out')) {
        out.push({ node: hit.node, relation });
        support.push(hit.support);
      }
    }
    return out.length
      ? { status: 'answer', items: out, support }
      : { status: 'refused', reason: 'no_support', items: [], support: [] };
  }

  /**
   * Does this set of values trip a composite antipattern?
   *
   * The convergence check, mechanised. A threshold rule fires only when enough
   * members are present, because the source rule is explicit that any one value
   * is legitimate and only the bundle is a problem.
   */
  compositeHits(values: string[]): { antipattern: Node; matched: Node[]; threshold: number; fires: boolean }[] {
    const lowered = values.map((value) => value.trim().toLowerCase());
    const results: { antipattern: Node; matched: Node[]; threshold: number; fires: boolean }[] = [];

    for (const antipattern of this.ofKind('antipattern')) {
      const threshold = Number(antipattern.metadata.threshold ?? 0);
      if (!threshold) continue;
      const members = this.neighbours(antipattern.id, 'component_of', 'in').map((hit) => hit.node);
      const matched = members.filter((member) => lowered.includes(member.name.trim().toLowerCase()));
      results.push({ antipattern, matched, threshold, fires: matched.length >= threshold });
    }
    return results;
  }

  /** What this primitive should not be combined with. */
  conflicts(nodeId: string): Answer<Node> {
    if (!this.node(nodeId)) {
      return { status: 'refused', reason: 'unknown_node', items: [], support: [] };
    }
    const hits = this.neighbours(nodeId, 'conflicts_with', 'both');
    return hits.length
      ? { status: 'answer', items: hits.map((hit) => hit.node), support: hits.map((hit) => hit.support) }
      : { status: 'refused', reason: 'no_support', items: [], support: [] };
  }
}
