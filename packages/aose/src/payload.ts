/**
 * Worker payload builder.
 *
 * Antigravity's "cold dispatch" idea: the worker receives only its target
 * spec, the invariants that bind it, and its gate — never the rest of the
 * system. Anthropic's long-running-agent harness contributes the progress log
 * carried across attempts; OpenAI's harness-engineering note contributes the
 * discipline that this document stays small, because context is finite.
 */
import type { Constitution, Spec, Task } from './schema.ts';
import YAML from 'yaml';

export interface PayloadInput {
  domain: string;
  attempt: number;
  maxAttempts: number;
  constitution?: Constitution;
  spec: Spec;
  task: Task['task'];
  priorNotes?: string;
  /** What prior runs of this domain failed on, from `recall`. Empty when cold. */
  recall?: string;
  fixtureRoot?: string;
}

export function buildPayload(input: PayloadInput): string {
  const { domain, attempt, maxAttempts, constitution, spec, task } = input;
  const articles = (constitution?.constitution?.articles ?? [])
    .filter((article) => (task.context.constitution_articles ?? []).includes(article.id));

  const upstream = Object.entries(task.context.upstream_exports ?? {});
  const sections: string[] = [];

  sections.push(`# AOSE cold task — ${domain} (attempt ${attempt} of ${maxAttempts})`);
  sections.push('You are a fresh worker. Everything you need is in this document. Do not look for other project context.');

  if (articles.length) {
    sections.push('## Non-negotiables\n' + articles.map((a) => `- **${a.id} ${a.title}** — ${a.rule}`).join('\n'));
  }

  if (upstream.length) {
    sections.push('## Upstream exports (import these, do not edit them)\n' +
      upstream.map(([mod, names]) => `- \`${mod}\`: ${names.map((n) => `\`${n}\``).join(', ')}`).join('\n'));
  }

  sections.push('## Domain specification\n```yaml\n' + YAML.stringify(spec).trim() + '\n```');

  sections.push('## Deliverables — create exactly these files and change nothing else\n' +
    task.deliverables.map((file) => `- \`${file}\``).join('\n'));

  sections.push(`## Execution gate\nRun \`${task.execution_gate.command}\`. It must exit 0.\nSuccess criteria: ${task.execution_gate.success_criteria}`);

  sections.push([
    '## Protocol',
    '1. Write the tests first. Create one test per scenario in `verification.scenarios`, named exactly its `test_name`.',
    '2. Implement until the gate command exits 0. Do not weaken a test to make it pass.',
    '3. Append what you did to `.aose/PROGRESS.md`.',
    '4. End your final message with one line: `GATE: PASS|FAIL — <files you touched>`.',
  ].join('\n'));

  /* Before the retry notes, because this is what OTHER runs learned; the retry
     notes are what THIS attempt learned. Both bounded by LINT-24. */
  if (input.recall?.trim()) {
    sections.push(input.recall.trim());
  }

  if (input.priorNotes?.trim()) {
    sections.push('## Prior attempt notes\n```\n' + input.priorNotes.trim() + '\n```');
  }

  if (input.fixtureRoot) sections.push(`<!-- aose:fixture_root=${input.fixtureRoot} -->`);

  return sections.join('\n\n') + '\n';
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
