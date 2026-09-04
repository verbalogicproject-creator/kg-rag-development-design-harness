/**
 * Compiler step: authored artifacts -> a normalized, dispatchable triad.
 *
 * Antigravity's harness described this phase in prose ("switch into Compiler
 * Mode") but never implemented it. Here it is mechanical: upstream_exports are
 * derived from the manifest DAG rather than hand-copied, a topological order is
 * computed (Parsel/CodePlan: decompose into a dependency structure, then plan
 * per node), and a flat five-plane blueprint is expanded into a one-boundary
 * triad so a spike never has to be written twice.
 */
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { FlatBlueprintSchema, ManifestSchema, TaskSchema, SpecSchema, safeParse } from './schema.ts';
import type { FlatBlueprint, Manifest, Spec, Task } from './schema.ts';
import { findCycle, topoOrder, loadYaml } from './lint.ts';

export interface CompileResult {
  ok: boolean;
  errors: string[];
  written: string[];
  topo_order: string[];
  expanded_from_flat: boolean;
}

/**
 * Expand the original condensed five-plane format into the canonical triad.
 * The flat form stays a valid *input* for spike/bounded scope (PRP-style:
 * spec and implementation detail in one document); everything downstream only
 * ever sees the triad.
 */
export function expandFlat(flat: FlatBlueprint, constitutionPath = 'constitution.yaml', articles: string[] = []):
  { manifest: Manifest; spec: Spec; task: Task } {
  const domain = flat.meta.module;
  const deliverables = Object.keys(flat.files);
  const exported = [...new Set(Object.keys(flat.contracts).map((sig) => sig.slice(0, Math.max(0, sig.indexOf('('))).trim()).filter(Boolean))];

  const manifest: Manifest = {
    system: {
      name: flat.meta.name,
      constitution: constitutionPath,
      scope_class: 'bounded',
      boundaries: [{
        domain,
        responsibility: `Single-module implementation of ${flat.meta.name}.`,
        depends_on: [],
        exports: exported.length ? exported : ['default'],
        spec: `${domain.replace(/\//g, '.')}.spec.yaml`,
        task: `${domain.replace(/\//g, '.')}.task.yaml`,
      }],
    },
    invariants: articles.length ? articles : ['ART-01'],
    decisions: [],
  };

  const spec: Spec = {
    module: domain,
    runtime: flat.meta.runtime.join(', '),
    requirements: flat.requirements,
    types: flat.types,
    contracts: flat.contracts,
    verification: flat.verification,
  };

  const task: Task = {
    task: {
      target_module: domain,
      context: { constitution_articles: articles, spec: manifest.system.boundaries[0].spec, upstream_exports: {} },
      deliverables,
      execution_gate: flat.execution_gate,
      budget: {},
    },
  };

  return { manifest, spec, task };
}

/** Normalize an authored blueprint directory in place. */
export function compile(dir: string, options: { write?: boolean } = {}): CompileResult {
  const write = options.write ?? true;
  const errors: string[] = [];
  const written: string[] = [];
  let expandedFromFlat = false;

  const flatPath = join(dir, 'blueprint.flat.yaml');
  const manifestPath = join(dir, 'system.manifest.yaml');

  if (!existsSync(manifestPath) && existsSync(flatPath)) {
    const doc = loadYaml(flatPath);
    if (!doc.ok) return { ok: false, errors: [`blueprint.flat.yaml: ${doc.error}`], written, topo_order: [], expanded_from_flat: false };
    const parsed = safeParse<FlatBlueprint>(FlatBlueprintSchema as never, doc.value);
    if (!parsed.ok) return { ok: false, errors: parsed.errors.map((e) => `blueprint.flat.yaml: ${e}`), written, topo_order: [], expanded_from_flat: false };

    const articles = existsSync(join(dir, 'constitution.yaml'))
      ? ((loadYaml(join(dir, 'constitution.yaml')) as { ok: true; value: { constitution?: { articles?: { id: string }[] } } }).value?.constitution?.articles ?? []).map((a) => a.id)
      : [];
    const { manifest, spec, task } = expandFlat(parsed.value, 'constitution.yaml', articles);
    if (write) {
      writeFileSync(manifestPath, header('system.manifest.yaml', 'expanded from blueprint.flat.yaml') + YAML.stringify(manifest));
      writeFileSync(join(dir, manifest.system.boundaries[0].spec), header(manifest.system.boundaries[0].spec, 'expanded from blueprint.flat.yaml') + YAML.stringify(spec));
      writeFileSync(join(dir, manifest.system.boundaries[0].task), header(manifest.system.boundaries[0].task, 'expanded from blueprint.flat.yaml') + YAML.stringify(task));
      written.push(manifestPath, join(dir, manifest.system.boundaries[0].spec), join(dir, manifest.system.boundaries[0].task));
    }
    expandedFromFlat = true;
  }

  const manifestDoc = loadYaml(manifestPath);
  if (!manifestDoc.ok) return { ok: false, errors: [`system.manifest.yaml: ${manifestDoc.error}`], written, topo_order: [], expanded_from_flat: expandedFromFlat };
  const manifestParsed = safeParse<Manifest>(ManifestSchema as never, manifestDoc.value);
  if (!manifestParsed.ok) return { ok: false, errors: manifestParsed.errors.map((e) => `system.manifest.yaml: ${e}`), written, topo_order: [], expanded_from_flat: expandedFromFlat };
  const manifest = manifestParsed.value;

  const edges = new Map(manifest.system.boundaries.map((b) => [b.domain, b.depends_on]));
  const cycle = findCycle(edges);
  if (cycle) {
    return { ok: false, errors: [`Cannot compile a cyclic architecture: ${cycle.join(' -> ')}`], written, topo_order: [], expanded_from_flat: expandedFromFlat };
  }
  const order = topoOrder(edges);

  /* Derive upstream_exports from the DAG instead of trusting hand-copied lists. */
  const exportsByDomain = new Map(manifest.system.boundaries.map((b) => [b.domain, b.exports]));
  for (const boundary of manifest.system.boundaries) {
    const taskPath = join(dir, boundary.task);
    if (!existsSync(taskPath)) { errors.push(`Missing task file for ${boundary.domain}: ${boundary.task}`); continue; }
    const doc = loadYaml(taskPath);
    if (!doc.ok) { errors.push(`${boundary.task}: ${doc.error}`); continue; }
    const parsed = safeParse<Task>(TaskSchema as never, doc.value);
    if (!parsed.ok) { errors.push(...parsed.errors.map((e) => `${boundary.task}: ${e}`)); continue; }

    const task = parsed.value;
    const upstream: Record<string, string[]> = {};
    for (const dep of boundary.depends_on) upstream[dep] = exportsByDomain.get(dep) ?? [];
    task.task.context.upstream_exports = upstream;
    task.task.context.spec = boundary.spec;
    task.task.target_module = boundary.domain;

    if (write) {
      writeFileSync(taskPath, header(boundary.task, 'normalized by aose compile') + YAML.stringify(task));
      written.push(taskPath);
    }

    const specPath = join(dir, boundary.spec);
    if (!existsSync(specPath)) errors.push(`Missing spec file for ${boundary.domain}: ${boundary.spec}`);
    else {
      const specDoc = loadYaml(specPath);
      if (!specDoc.ok) errors.push(`${boundary.spec}: ${specDoc.error}`);
      else {
        const specParsed = safeParse<Spec>(SpecSchema as never, specDoc.value);
        if (!specParsed.ok) errors.push(...specParsed.errors.map((e) => `${boundary.spec}: ${e}`));
      }
    }
  }

  if (write) {
    writeFileSync(join(dir, 'topo_order.yaml'), header('topo_order.yaml', 'computed by aose compile') + YAML.stringify({ topo_order: order }));
    written.push(join(dir, 'topo_order.yaml'));
  }

  return { ok: errors.length === 0, errors, written, topo_order: order, expanded_from_flat: expandedFromFlat };
}

export function readTopoOrder(dir: string): string[] {
  const path = join(dir, 'topo_order.yaml');
  if (!existsSync(path)) return [];
  try {
    return (YAML.parse(readFileSync(path, 'utf8')) as { topo_order?: string[] }).topo_order ?? [];
  } catch { return []; }
}

function header(file: string, note: string): string {
  return `# ${file} — ${note}. Edit the source artifacts, not this header.\n`;
}
