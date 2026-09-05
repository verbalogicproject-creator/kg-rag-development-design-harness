/**
 * Build the design knowledge graph from curated YAML.
 *
 * The graph's value is that its edges are facts, so the build enforces what
 * makes them facts rather than trusting the author:
 *
 *   - no source, no node — every node cites the file it was read from
 *   - the edge vocabulary is closed at six, and a seventh fails the build
 *   - every edge references nodes that exist
 *   - no node has degree zero, because a node nothing connects to answers
 *     no question and is corpus, not graph
 *
 * The output is content-addressed: the same curated input produces the same
 * logical checksum, so a rebuild that differs is a change somebody made rather
 * than a change the toolchain introduced.
 */
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import YAML from 'yaml';

/** The closed vocabulary. Opening it is a schema change, not an insert. */
export const RELATIONS = [
  'requires', 'suits_use_case', 'conflicts_with',
  'substitutes_for', 'component_of', 'warns_about',
] as const;
export type Relation = (typeof RELATIONS)[number];

export const NODE_KINDS = [
  'direction_family', 'condition', 'check', 'primitive', 'value', 'antipattern',
] as const;

export interface GraphNode {
  id: string; node_type: string; name: string; summary: string;
  metadata: Record<string, unknown>;
}
export interface GraphEdge {
  id: string; source_id: string; target_id: string; relation: Relation;
  metadata: Record<string, unknown>;
}
export interface BuildResult {
  nodes: GraphNode[]; edges: GraphEdge[]; checksum: string; problems: string[];
}

const RESERVED = new Set(['id', 'name', 'summary', 'evidence']);

/** Read curated YAML into nodes and edges, collecting every problem rather than throwing on the first. */
export function collect(curatedDir: string): BuildResult {
  const problems: string[] = [];
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  const nodeDoc = YAML.parse(readFileSync(join(curatedDir, 'nodes.yaml'), 'utf8')) ?? {};
  for (const kind of NODE_KINDS) {
    for (const entry of nodeDoc[kind] ?? []) {
      // No source, no node. This is the rule that keeps assertions out.
      const source = entry?.evidence?.source;
      if (!source) { problems.push(`${entry?.id ?? '(unnamed)'}: no evidence.source`); continue; }
      if (!entry.id) { problems.push(`a ${kind} entry has no id`); continue; }

      const metadata: Record<string, unknown> = { evidence_source: source };
      for (const [key, value] of Object.entries(entry)) {
        if (!RESERVED.has(key)) metadata[key] = value;
      }
      delete metadata.node_type;
      nodes.push({
        id: entry.id, node_type: kind, name: String(entry.name ?? entry.id),
        summary: String(entry.summary ?? ''), metadata,
      });
    }
  }

  const known = new Map(nodes.map((node) => [node.id, node]));
  const seen = new Set<string>();
  for (const [id] of known) {
    if (seen.has(id)) problems.push(`duplicate node id: ${id}`);
    seen.add(id);
  }

  const edgeDoc = YAML.parse(readFileSync(join(curatedDir, 'edges.yaml'), 'utf8')) ?? {};
  for (const [relation, entries] of Object.entries(edgeDoc)) {
    if (relation === 'schema') continue;
    if (!RELATIONS.includes(relation as Relation)) {
      problems.push(`"${relation}" is not one of the six declared relations; opening the vocabulary is a schema change`);
      continue;
    }
    for (const entry of (entries as Record<string, unknown>[]) ?? []) {
      const source = String(entry.source ?? '');
      const target = String(entry.target ?? '');
      if (!known.has(source)) problems.push(`${relation}: source "${source}" is not a declared node`);
      if (!known.has(target)) problems.push(`${relation}: target "${target}" is not a declared node`);
      if (source === target) problems.push(`${relation}: "${source}" points at itself`);
      if (!known.has(source) || !known.has(target)) continue;

      const metadata: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(entry)) {
        if (key === 'source' || key === 'target') continue;
        if (key === 'evidence') { metadata.evidence_source = (value as { source?: string })?.source ?? ''; continue; }
        metadata[key] = value;
      }
      edges.push({ id: `${relation}:${source}->${target}`, source_id: source, target_id: target, relation: relation as Relation, metadata });
    }
  }

  // A node nothing connects to answers no question. It is corpus, not graph.
  const touched = new Set(edges.flatMap((edge) => [edge.source_id, edge.target_id]));
  for (const node of nodes) {
    if (!touched.has(node.id)) problems.push(`${node.id}: degree zero — nothing links it, so no traversal can reach it`);
  }

  return { nodes, edges, checksum: checksum(nodes, edges), problems };
}

/** A logical checksum over sorted content, so it does not depend on file order or sqlite internals. */
export function checksum(nodes: GraphNode[], edges: GraphEdge[]): string {
  const hash = createHash('sha256');
  for (const node of [...nodes].sort((a, b) => a.id.localeCompare(b.id))) {
    hash.update(`N ${node.id} ${node.node_type} ${node.name} ${node.summary} ${JSON.stringify(sortKeys(node.metadata))}\n`);
  }
  for (const edge of [...edges].sort((a, b) => a.id.localeCompare(b.id))) {
    hash.update(`E ${edge.id} ${edge.relation} ${JSON.stringify(sortKeys(edge.metadata))}\n`);
  }
  return `sha256:${hash.digest('hex')}`;
}

function sortKeys(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
}

export const SCHEMA_SQL = `
CREATE TABLE nodes (
  id        TEXT PRIMARY KEY,
  node_type TEXT NOT NULL,
  name      TEXT NOT NULL,
  summary   TEXT,
  metadata  TEXT NOT NULL
);
CREATE TABLE edges (
  id        TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES nodes(id),
  target_id TEXT NOT NULL REFERENCES nodes(id),
  relation  TEXT NOT NULL,
  metadata  TEXT NOT NULL
);
CREATE INDEX idx_nodes_type   ON nodes(node_type);
CREATE INDEX idx_edges_source ON edges(source_id);
CREATE INDEX idx_edges_target ON edges(target_id);
CREATE INDEX idx_edges_rel    ON edges(relation);
CREATE TABLE provenance (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

/** Write the database. Refuses on any problem: a graph built over broken edges is worse than none. */
export function build(curatedDir: string, dbPath: string): BuildResult {
  const result = collect(curatedDir);
  if (result.problems.length) return result;

  mkdirSync(dirname(dbPath), { recursive: true });
  if (existsSync(dbPath)) rmSync(dbPath);
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA_SQL);

  const insertNode = db.prepare('INSERT INTO nodes (id, node_type, name, summary, metadata) VALUES (?, ?, ?, ?, ?)');
  for (const node of [...result.nodes].sort((a, b) => a.id.localeCompare(b.id))) {
    insertNode.run(node.id, node.node_type, node.name, node.summary, JSON.stringify(sortKeys(node.metadata)));
  }
  const insertEdge = db.prepare('INSERT INTO edges (id, source_id, target_id, relation, metadata) VALUES (?, ?, ?, ?, ?)');
  for (const edge of [...result.edges].sort((a, b) => a.id.localeCompare(b.id))) {
    insertEdge.run(edge.id, edge.source_id, edge.target_id, edge.relation, JSON.stringify(sortKeys(edge.metadata)));
  }

  /* No build timestamp: the checksum identifies this graph, and a clock would
     make two identical builds differ. */
  const insertProv = db.prepare('INSERT INTO provenance (key, value) VALUES (?, ?)');
  insertProv.run('kg_id', 'ls_design');
  insertProv.run('schema_version', '1.0');
  insertProv.run('logical_checksum', result.checksum);
  insertProv.run('built_from', 'packages/design-kg/curated/');
  insertProv.run('relations', RELATIONS.join(','));
  db.close();

  return result;
}
