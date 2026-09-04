/**
 * AOSE v2 artifact schemas.
 *
 * Merges the Codex harness's zod-validated Idea/Source/Decision shapes with the
 * Antigravity triad (system.manifest / <domain>.spec / task), and adds the
 * artifacts the ecosystem survey showed both were missing: a constitution
 * (github/spec-kit), EARS requirements (AWS Kiro), scope classification
 * (obra/superpowers) and elicitation (BMAD-METHOD).
 *
 * Runtime note: executed directly by Node's type stripping. No enums, no
 * namespaces, no parameter properties; imports carry the .ts extension.
 */
import { z } from 'zod';

/** EARS (Easy Approach to Requirements Syntax), as used by AWS Kiro. */
export const EARS_PATTERN =
  /^\s*(?:(?:WHEN|WHILE|IF|WHERE)\b[\s\S]+\bTHE SYSTEM SHALL\b|THE SYSTEM SHALL\b)[\s\S]*$/i;

export const DOMAIN_PATTERN = /^[a-z0-9]+(?:\/[a-z0-9-]+)*$/;
export const SLUG_PATTERN = /^[a-z0-9-]+$/;

const nonEmpty = z.string().min(1);
const earsString = nonEmpty.regex(EARS_PATTERN, 'must use EARS syntax: "<WHEN|WHILE|IF|WHERE> ... THE SYSTEM SHALL ..."');

/* ------------------------------------------------------------------ */
/* constitution.yaml — spec-kit's "constitution"; Antigravity's        */
/* shared_invariants promoted to a first-class, addressable artifact.  */
/* ------------------------------------------------------------------ */

export const EnforcementSchema = z.enum(['lint', 'gate', 'review']);

export const ArticleSchema = z.object({
  id: nonEmpty.regex(/^ART-\d{2}$/, 'article id must look like ART-01'),
  title: nonEmpty,
  rule: nonEmpty,
  enforcement: EnforcementSchema,
});

export const BudgetsSchema = z.object({
  max_attempts: z.number().int().min(1).max(10).default(2),
  max_respec: z.number().int().min(0).max(10).default(2),
  timeout_minutes: z.number().int().min(1).max(120).default(15),
  max_payload_tokens: z.number().int().min(200).max(200000).default(4000),
});

/** zod does not re-parse a `.default()` value, so nested defaults would be
 *  dropped if the whole object were defaulted to `{}`. State them once here. */
export const DEFAULT_BUDGETS = { max_attempts: 2, max_respec: 2, timeout_minutes: 15, max_payload_tokens: 4000 };
export const DEFAULT_VERIFICATION = { status: 'unverified' as const, fetched_title: '', checked_at: '', detail: '' };

export const ConstitutionSchema = z.object({
  constitution: z.object({
    name: nonEmpty,
    version: z.number().int().min(1),
    stack: z.array(nonEmpty).min(1),
    articles: z.array(ArticleSchema).min(1),
    budgets: BudgetsSchema.default(DEFAULT_BUDGETS),
  }),
});

/* ------------------------------------------------------------------ */
/* idea.yaml — brainstorm output.                                      */
/* ------------------------------------------------------------------ */

export const ScopeClassSchema = z.enum(['spike', 'bounded', 'architectural']);
export const SeedAuthorSchema = z.enum(['human', 'agent']);

export const AlternativeSchema = z.object({
  option: nonEmpty,
  rejected_because: nonEmpty,
});

export const ElicitationSchema = z.object({
  challenge: nonEmpty,
  response: nonEmpty,
});

export const IdeaSchema = z.object({
  idea: z.object({
    title: nonEmpty,
    goal: nonEmpty,
    audience: nonEmpty,
    seed_author: SeedAuthorSchema,
    scope_class: ScopeClassSchema,
    success_criteria: z.array(earsString).min(1),
    non_goals: z.array(nonEmpty).default([]),
    constraints: z.array(nonEmpty).default([]),
    open_questions: z.array(nonEmpty).default([]),
    alternatives_considered: z.array(AlternativeSchema).default([]),
    elicitation: z.array(ElicitationSchema).default([]),
  }),
});

/* ------------------------------------------------------------------ */
/* research ledger sources — Codex's ledger plus a fetch-and-verify    */
/* status that only `aose research-verify` may write (CiteCheck).      */
/* ------------------------------------------------------------------ */

export const SourceKindSchema = z.enum(['arxiv', 'github', 'web']);
export const VerifyStatusSchema = z.enum(['verified', 'mismatch', 'unreachable', 'unverified']);

export const VerificationRecordSchema = z.object({
  status: VerifyStatusSchema,
  fetched_title: z.string().default(''),
  checked_at: z.string().default(''),
  detail: z.string().default(''),
});

export const SourceSchema = z.object({
  url: z.url().refine((u) => u.startsWith('https://'), 'source URLs must use https'),
  kind: SourceKindSchema,
  title: nonEmpty,
  claim: nonEmpty,
  confidence: z.enum(['low', 'medium', 'high']),
  supports: z.array(nonEmpty.regex(/^DEC-\d{2}$/)).default([]),
  verified: VerificationRecordSchema.default(DEFAULT_VERIFICATION),
});

/* ------------------------------------------------------------------ */
/* system.manifest.yaml — Antigravity's topology, plus Codex decisions.*/
/* ------------------------------------------------------------------ */

export const BoundarySchema = z.object({
  domain: nonEmpty.regex(DOMAIN_PATTERN, 'domain must be lowercase path segments, e.g. core/engine'),
  responsibility: nonEmpty,
  depends_on: z.array(nonEmpty).default([]),
  exports: z.array(nonEmpty).min(1),
  spec: nonEmpty,
  task: nonEmpty,
});

export const DecisionSchema = z.object({
  id: nonEmpty.regex(/^DEC-\d{2}$/, 'decision id must look like DEC-01'),
  statement: nonEmpty,
  rationale: nonEmpty,
  alternatives: z.array(nonEmpty).default([]),
  sources: z.array(z.url()).default([]),
});

export const ManifestSchema = z.object({
  system: z.object({
    name: nonEmpty,
    constitution: nonEmpty,
    scope_class: ScopeClassSchema,
    boundaries: z.array(BoundarySchema).min(1),
  }),
  invariants: z.array(nonEmpty).min(1),
  decisions: z.array(DecisionSchema).default([]),
});

/* ------------------------------------------------------------------ */
/* <domain>.spec.yaml — Antigravity's ABC contracts, plus EARS         */
/* requirements and scenario→test-name traceability (Kiro).            */
/* ------------------------------------------------------------------ */

export const RequirementSchema = z.object({
  id: nonEmpty.regex(/^REQ-\d{2}$/, 'requirement id must look like REQ-01'),
  ears: earsString,
  verified_by: z.array(nonEmpty.regex(/^SC-\d{2}$/)).min(1),
});

export const ContractSchema = z.object({
  kind: z.enum(['transition', 'query']),
  precondition: nonEmpty,
  postcondition: nonEmpty,
  errors: z.array(nonEmpty).default([]),
  algorithm: z.string().optional(),
});

export const ScenarioSchema = z.object({
  id: nonEmpty.regex(/^SC-\d{2}$/, 'scenario id must look like SC-01'),
  given: nonEmpty,
  when: nonEmpty,
  then: nonEmpty,
  test_name: nonEmpty,
});

export const SpecSchema = z.object({
  module: nonEmpty.regex(DOMAIN_PATTERN),
  runtime: nonEmpty,
  requirements: z.array(RequirementSchema).min(1),
  types: nonEmpty,
  contracts: z.record(nonEmpty, ContractSchema),
  verification: z.object({
    test_suite: nonEmpty,
    scenarios: z.array(ScenarioSchema).min(1),
  }),
});

/* ------------------------------------------------------------------ */
/* task.yaml — Antigravity's atomic payload, plus constitution slice,  */
/* upstream exports (filled by compile) and an attempt budget.         */
/* ------------------------------------------------------------------ */

export const TaskSchema = z.object({
  task: z.object({
    target_module: nonEmpty.regex(DOMAIN_PATTERN),
    context: z.object({
      constitution_articles: z.array(nonEmpty.regex(/^ART-\d{2}$/)).default([]),
      spec: nonEmpty,
      upstream_exports: z.record(nonEmpty, z.array(nonEmpty)).default({}),
    }),
    deliverables: z.array(nonEmpty).min(1),
    execution_gate: z.object({
      command: nonEmpty,
      success_criteria: nonEmpty,
      timeout_minutes: z.number().int().min(1).max(120).optional(),
    }),
    budget: z.object({ max_attempts: z.number().int().min(1).max(10).optional() }).default({}),
    worker: z.string().optional(),
  }),
});

/* ------------------------------------------------------------------ */
/* Flat blueprint — the original five-plane condensed format, accepted */
/* as an INPUT shortcut for spike/bounded scope and expanded to a      */
/* one-boundary triad by compile. (PRP: spec + detail in one doc.)     */
/* ------------------------------------------------------------------ */

export const FlatBlueprintSchema = z.object({
  meta: z.object({
    name: nonEmpty,
    module: nonEmpty.regex(DOMAIN_PATTERN).default('core/main'),
    runtime: z.array(nonEmpty).min(1),
    entry: z.string().optional(),
  }),
  files: z.record(nonEmpty, nonEmpty),
  types: nonEmpty,
  contracts: z.record(nonEmpty, ContractSchema),
  requirements: z.array(RequirementSchema).min(1),
  verification: z.object({
    test_suite: nonEmpty,
    scenarios: z.array(ScenarioSchema).min(1),
  }),
  execution_gate: z.object({ command: nonEmpty, success_criteria: nonEmpty }),
});

/* ------------------------------------------------------------------ */
/* Exported blueprint (aose-blueprint/v2).                             */
/* ------------------------------------------------------------------ */

export const BlueprintSchema = z.object({
  meta: z.object({
    slug: nonEmpty,
    format: z.literal('aose-blueprint/v2'),
    generated_at: nonEmpty,
  }),
  constitution: ConstitutionSchema.shape.constitution,
  idea: IdeaSchema.shape.idea,
  sources: z.array(SourceSchema).default([]),
  manifest: ManifestSchema,
  specs: z.record(nonEmpty, SpecSchema),
  tasks: z.record(nonEmpty, TaskSchema.shape.task),
  topo_order: z.array(nonEmpty),
});

export type Article = z.infer<typeof ArticleSchema>;
export type Constitution = z.infer<typeof ConstitutionSchema>;
export type Idea = z.infer<typeof IdeaSchema>;
export type Source = z.infer<typeof SourceSchema>;
export type Boundary = z.infer<typeof BoundarySchema>;
export type Decision = z.infer<typeof DecisionSchema>;
export type Manifest = z.infer<typeof ManifestSchema>;
export type Contract = z.infer<typeof ContractSchema>;
export type Scenario = z.infer<typeof ScenarioSchema>;
export type Requirement = z.infer<typeof RequirementSchema>;
export type Spec = z.infer<typeof SpecSchema>;
export type Task = z.infer<typeof TaskSchema>;
export type FlatBlueprint = z.infer<typeof FlatBlueprintSchema>;
export type Blueprint = z.infer<typeof BlueprintSchema>;
export type ScopeClass = z.infer<typeof ScopeClassSchema>;
export type VerifyStatus = z.infer<typeof VerifyStatusSchema>;

/** Parse helper returning a uniform result instead of throwing. */
export function safeParse<T>(schema: { safeParse: (v: unknown) => { success: boolean; data?: T; error?: { issues: { path: (string | number | symbol)[]; message: string }[] } } }, value: unknown):
  { ok: true; value: T } | { ok: false; errors: string[] } {
  const parsed = schema.safeParse(value);
  if (parsed.success) return { ok: true, value: parsed.data as T };
  const errors = (parsed.error?.issues ?? []).map((issue) => {
    const path = issue.path.map(String).join('.');
    return path ? `${path}: ${issue.message}` : issue.message;
  });
  return { ok: false, errors: errors.length ? errors : ['invalid document'] };
}
