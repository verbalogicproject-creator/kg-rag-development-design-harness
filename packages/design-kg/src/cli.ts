#!/usr/bin/env node
/**
 * Ask the design graph a question, or rebuild it.
 *
 * Every answer prints its support. An answer with no support prints the refusal
 * and what the graph does know, because a dead end you cannot act on is only
 * marginally better than an invented answer.
 */
import { parseArgs } from 'node:util';
import { build } from './build.ts';
import { DesignGraph } from './query.ts';

const CURATED = 'packages/design-kg/curated';
const DB = 'packages/design-kg/ls-design.db';

const USAGE = `design-kg — ask the design knowledge graph

  build                          Rebuild from curated/ and print the checksum
  directions <condition>...      Which direction families suit these conditions
  commitments <direction>        What choosing it requires and warns about
  composite <value>...           Does this set of values trip a threshold rule
  conflicts <node>               What this should not be combined with
  list <kind>                    direction_family | condition | check | primitive | value | antipattern
`;

const { positionals } = parseArgs({ allowPositionals: true, strict: false });
const [command, ...args] = positionals;

if (!command || command === 'help') { process.stdout.write(USAGE); process.exit(0); }

if (command === 'build') {
  const result = build(CURATED, DB);
  if (result.problems.length) {
    for (const problem of result.problems) process.stderr.write(`  ${problem}\n`);
    process.stderr.write(`\nRefused: ${result.problems.length} problem(s). A graph built over broken edges is worse than none.\n`);
    process.exit(1);
  }
  process.stdout.write(`${result.nodes.length} nodes, ${result.edges.length} edges\n${result.checksum}\n`);
  process.exit(0);
}

const graph = new DesignGraph(DB);

const support = (items: { rationale: string; source: string }[]): void => {
  for (const entry of items) {
    if (entry.rationale) process.stdout.write(`      ${entry.rationale.trim().replace(/\s+/g, ' ')}\n`);
    if (entry.source) process.stdout.write(`        → ${entry.source}\n`);
  }
};

switch (command) {
  case 'list': {
    for (const node of graph.ofKind(args[0] ?? 'direction_family')) {
      process.stdout.write(`  ${node.id.padEnd(38)} ${node.name}\n`);
    }
    break;
  }
  case 'directions': {
    const answer = graph.directionsFor(args);
    if (answer.status === 'refused') {
      process.stdout.write(`refused (${answer.reason})\n\nthe graph knows these conditions:\n`);
      for (const id of answer.known ?? []) process.stdout.write(`  ${id}\n`);
      process.exitCode = 1;
      break;
    }
    for (const item of answer.items) {
      process.stdout.write(`  ${item.direction.name.padEnd(24)} covers ${item.covers.length}${item.chosen ? '  [chosen by a person]' : '  [canon]'}\n`);
    }
    process.stdout.write('\n');
    support(answer.support);
    break;
  }
  case 'commitments': {
    const answer = graph.commitments(args[0] ?? '');
    if (answer.status === 'refused') { process.stdout.write(`refused (${answer.reason})\n`); process.exitCode = 1; break; }
    for (const item of answer.items) process.stdout.write(`  ${item.relation.padEnd(14)} ${item.node.name}\n`);
    process.stdout.write('\n');
    support(answer.support);
    break;
  }
  case 'composite': {
    for (const hit of graph.compositeHits(args)) {
      process.stdout.write(`  ${hit.fires ? 'FIRES' : 'ok   '}  ${hit.antipattern.name}  (${hit.matched.length}/${hit.threshold})\n`);
      if (hit.matched.length) process.stdout.write(`         matched: ${hit.matched.map((m) => m.name).join(', ')}\n`);
      if (hit.fires) process.stdout.write(`         ${String(hit.antipattern.metadata.resolution ?? '').replace(/\s+/g, ' ').trim()}\n`);
    }
    break;
  }
  case 'conflicts': {
    const answer = graph.conflicts(args[0] ?? '');
    if (answer.status === 'refused') { process.stdout.write(`refused (${answer.reason})\n`); process.exitCode = 1; break; }
    for (const node of answer.items) process.stdout.write(`  ${node.name}\n`);
    process.stdout.write('\n');
    support(answer.support);
    break;
  }
  default:
    process.stderr.write(`Unknown command "${command}".\n\n${USAGE}`);
    process.exitCode = 1;
}
graph.close();
