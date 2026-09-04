/**
 * Export and archive.
 *
 * The YAML + Markdown handoff is adapted from the Codex harness's
 * payload()/markdown() (src/service.ts:29-30) and widened to aose-blueprint/v2,
 * so the exported plan now carries what the v1 export could not: typed
 * contracts, EARS requirements, scenario-to-test traceability, the dependency
 * order, and the verification status of every citation. Archiving a finished
 * blueprint instead of deleting it follows OpenSpec's archive convention.
 */
import { cpSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import type { Blueprint, Constitution, Idea, Manifest, Source, Spec, Task } from './schema.ts';

export interface ExportInput {
  slug: string;
  constitution: Constitution;
  idea: Idea;
  manifest: Manifest;
  specs: Record<string, Spec>;
  tasks: Record<string, Task>;
  sources: Source[];
  topoOrder: string[];
}

export function buildBlueprint(input: ExportInput): Blueprint {
  return {
    meta: { slug: input.slug, format: 'aose-blueprint/v2', generated_at: new Date().toISOString() },
    constitution: input.constitution.constitution,
    idea: input.idea.idea,
    sources: input.sources,
    manifest: input.manifest,
    specs: input.specs,
    tasks: Object.fromEntries(Object.entries(input.tasks).map(([domain, task]) => [domain, task.task])),
    topo_order: input.topoOrder,
  };
}

/** The condensed implementation plan — the artifact a worker or a human reads. */
export function renderMarkdown(blueprint: Blueprint): string {
  const lines: string[] = [];
  const { idea, manifest, specs, tasks, constitution } = blueprint;

  lines.push(`# ${idea.title}`, '');
  lines.push(`> ${idea.goal}`, '');
  lines.push(`**Audience** ${idea.audience}  `);
  lines.push(`**Scope class** ${idea.scope_class}  `);
  lines.push(`**Format** ${blueprint.meta.format}  `);
  lines.push(`**Generated** ${blueprint.meta.generated_at}`, '');

  lines.push('## Success criteria', '');
  for (const criterion of idea.success_criteria) lines.push(`- ${criterion}`);
  lines.push('');

  if (idea.non_goals.length) {
    lines.push('## Non-goals', '');
    for (const item of idea.non_goals) lines.push(`- ${item}`);
    lines.push('');
  }

  lines.push('## Constitution', '');
  lines.push('| Article | Rule | Enforced by |', '| --- | --- | --- |');
  for (const article of constitution.articles) {
    lines.push(`| **${article.id}** ${article.title} | ${article.rule} | ${article.enforcement} |`);
  }
  lines.push('');

  lines.push('## Architecture', '');
  lines.push('Build order (dependencies first): ' + blueprint.topo_order.map((d) => `\`${d}\``).join(' → '), '');
  lines.push('| Domain | Responsibility | Depends on | Exports |', '| --- | --- | --- | --- |');
  for (const boundary of manifest.system.boundaries) {
    lines.push(`| \`${boundary.domain}\` | ${boundary.responsibility} | ${boundary.depends_on.map((d) => `\`${d}\``).join(', ') || '—'} | ${boundary.exports.map((e) => `\`${e}\``).join(', ')} |`);
  }
  lines.push('');

  if (manifest.decisions.length) {
    lines.push('## Decisions', '');
    for (const decision of manifest.decisions) {
      lines.push(`- **${decision.id}** ${decision.statement}`);
      lines.push(`  - Why: ${decision.rationale}`);
      if (decision.alternatives.length) lines.push(`  - Rejected: ${decision.alternatives.join('; ')}`);
      for (const url of decision.sources) {
        const source = blueprint.sources.find((s) => s.url === url);
        lines.push(`  - Source: ${url} (${source ? source.verified.status : 'not in ledger'})`);
      }
    }
    lines.push('');
  }

  for (const domain of blueprint.topo_order) {
    const spec = specs[domain];
    const task = tasks[domain];
    if (!spec) continue;
    lines.push(`## Domain \`${domain}\``, '');
    lines.push('### Requirements', '');
    lines.push('| Id | Requirement (EARS) | Verified by |', '| --- | --- | --- |');
    for (const requirement of spec.requirements) {
      lines.push(`| ${requirement.id} | ${requirement.ears} | ${requirement.verified_by.join(', ')} |`);
    }
    lines.push('', '### Types', '', '```ts', spec.types.trim(), '```', '');
    lines.push('### Contracts', '');
    for (const [signature, contract] of Object.entries(spec.contracts)) {
      lines.push(`- \`${signature}\` (${contract.kind})`);
      lines.push(`  - pre: ${contract.precondition}`);
      lines.push(`  - post: ${contract.postcondition}`);
      if (contract.algorithm) lines.push(`  - algorithm: ${contract.algorithm}`);
      if (contract.errors.length) lines.push(`  - errors: ${contract.errors.join(', ')}`);
    }
    lines.push('', '### Verification', '');
    lines.push(`Suite: \`${spec.verification.test_suite}\``, '');
    lines.push('| Id | Given | When | Then | Test name |', '| --- | --- | --- | --- | --- |');
    for (const scenario of spec.verification.scenarios) {
      lines.push(`| ${scenario.id} | ${scenario.given} | ${scenario.when} | ${scenario.then} | \`${scenario.test_name}\` |`);
    }
    lines.push('');
    if (task) {
      lines.push('### Task', '');
      lines.push(`Deliverables: ${task.deliverables.map((f) => `\`${f}\``).join(', ')}`, '');
      lines.push(`Gate: \`${task.execution_gate.command}\` — ${task.execution_gate.success_criteria}`, '');
    }
  }

  if (blueprint.sources.length) {
    lines.push('## Research ledger', '');
    lines.push('| Source | Claim | Confidence | Verification |', '| --- | --- | --- | --- |');
    for (const source of blueprint.sources) {
      lines.push(`| [${source.title}](${source.url}) | ${source.claim} | ${source.confidence} | ${source.verified.status} |`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

export function writeExport(dir: string, blueprint: Blueprint): string[] {
  mkdirSync(dir, { recursive: true });
  const yamlPath = join(dir, 'blueprint.yaml');
  const markdownPath = join(dir, 'implementation-plan.md');
  writeFileSync(yamlPath, YAML.stringify(blueprint));
  writeFileSync(markdownPath, renderMarkdown(blueprint));
  return [yamlPath, markdownPath];
}

export function archive(dir: string, archiveRoot: string, slug: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = join(archiveRoot, `${slug}-${stamp}`);
  mkdirSync(archiveRoot, { recursive: true });
  cpSync(dir, target, { recursive: true });
  return target;
}
