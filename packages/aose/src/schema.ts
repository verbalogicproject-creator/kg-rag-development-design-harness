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
export const DEFAULT_VERIFICATION = { status: 'unverified' as const, fetched_title: '', checked_at: '', detail: '', excerpt: '', canonical_id: '' };

/**
 * Named allowlists a domain's spec must stay inside.
 *
 * This is how a policy stops being a promise. "Only fetch from sources that
 * permit programmatic access" is written once as an allowlist, referenced by
 * the domain that fetches, and checked by LINT-30 — so a source nobody cleared
 * fails the blueprint instead of reaching a worker.
 */
export const AllowlistSchema = z.object({
  id: nonEmpty.regex(/^[a-z][a-z0-9_]*$/, 'allowlist id must be lower_snake_case'),
  rationale: nonEmpty,
  entries: z.array(nonEmpty).min(1),
});

export const ConstitutionSchema = z.object({
  constitution: z.object({
    name: nonEmpty,
    version: z.number().int().min(1),
    stack: z.array(nonEmpty).min(1),
    articles: z.array(ArticleSchema).min(1),
    allowlists: z.array(AllowlistSchema).default([]),
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
  /** Retrieved text, kept so a reader can judge the claim rather than trust a score. */
  excerpt: z.string().default(''),
  claim_support: z.number().min(0).max(1).optional(),
  canonical_id: z.string().default(''),
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
  /* Why a query returning a bare type cannot fail. LINT-13 asks an author to
     "confirm it cannot fail" and there was nowhere to put the answer, so the
     warning could only ever be re-read, never resolved. Recording the reason
     turns it from a nag into a claim someone can disagree with. */
  totality: z.string().optional(),
});

export const ScenarioSchema = z.object({
  id: nonEmpty.regex(/^SC-\d{2}$/, 'scenario id must look like SC-01'),
  given: nonEmpty,
  when: nonEmpty,
  then: nonEmpty,
  test_name: nonEmpty,
});

/* ------------------------------------------------------------------ */
/* design.system.yaml — the design plane's constitution.               */
/*                                                                     */
/* Every other plane here has declare -> verify -> gate. The design    */
/* plane had declare -> nothing -> does-the-file-exist, which is how   */
/* design.json could carry contrast targets from the day a project was */
/* initialised without one of them ever being measured. This artifact  */
/* is to design what constitution.yaml is to code, and it reuses that  */
/* grammar rather than inventing a second one.                         */
/* ------------------------------------------------------------------ */

/** The five canonical families. A direction is chosen from these, never invented. */
export const DIRECTION_FAMILIES = [
  'editorial-restraint', 'precise-technical', 'tactile-human',
  'cinematic-spatial', 'cultural-expressive',
] as const;
export const DirectionFamilySchema = z.enum(DIRECTION_FAMILIES);

/**
 * A negative constraint — the reason the design plane is checkable at all.
 *
 * "Is this good design?" cannot be scored, so scoring it yields noise. "Does
 * this exhibit the convergence composite, or monospace as costume?" is
 * answerable with a defensible yes or no. `threshold` carries the composite
 * case, where the source rule is that any one value is legitimate and only the
 * bundle is a problem, and the counted rules ("more than one per three
 * sections") that a pairwise model cannot express at all.
 */
/**
 * One member of a composite rule.
 *
 * A bare string describes the member for a human. `matches` is what a gate can
 * actually compare against — the literal values that count as this member being
 * present. Without it a threshold is unenforceable, which is how AD-01 declared
 * four components and a threshold of three while nothing ever compared it to
 * the tokens.
 */
export const AntiDirectionComponentSchema = z.union([
  nonEmpty,
  z.object({
    describes: nonEmpty,
    matches: z.array(nonEmpty).min(1),
  }),
]);

export const AntiDirectionSchema = z.object({
  id: nonEmpty.regex(/^AD-\d{2}$/, 'anti-direction id must look like AD-01'),
  rule: nonEmpty,
  /** Fire only when at least this many `components` match. Absent means the rule fires alone. */
  threshold: z.number().int().min(1).optional(),
  components: z.array(AntiDirectionComponentSchema).default([]),
  /** Where the rule came from. ART-11: a review that cannot cite has reviewed nothing. */
  source: nonEmpty,
  note: z.string().default(''),
});

export const DesignDirectionSchema = z.object({
  family: DirectionFamilySchema,
  counterpoint: DirectionFamilySchema.optional(),
  thesis: nonEmpty,
  signature: z.string().default(''),
  voice: z.array(nonEmpty).default([]),
  evidence: z.array(nonEmpty).default([]),
  anti_direction: z.array(AntiDirectionSchema).min(1),
});

/** A foreground/background pair and the ratio it must meet. Measured, never assumed. */
export const ContrastPairSchema = z.object({
  foreground: nonEmpty,
  background: nonEmpty,
  target: z.number().min(1).max(21),
});

export const DesignScalesSchema = z.object({
  type: z.object({
    unit: z.string().default('rem'),
    steps: z.record(nonEmpty, nonEmpty),
    fluid_endpoints_must_be_on_scale: z.boolean().default(true),
    measure: z.object({ min: z.number(), max: z.number() }).optional(),
  }),
  spacing: z.object({ base: nonEmpty, steps: z.array(nonEmpty).min(2) }),
  radius: z.object({ steps: z.array(nonEmpty).min(1) }),
  motion: z.object({
    durations: z.record(nonEmpty, nonEmpty),
    easings: z.record(nonEmpty, nonEmpty).default({}),
    reduced_motion: z.enum(['required', 'optional']).default('required'),
  }),
  /* Border widths and letter-spacing are scales too, and the public design.md
     format has no field for either — so like motion they are declared here and
     code is checked against this set. Leaving them undeclared is what makes a
     2px focus ring read as a magic number. */
  border: z.object({ steps: z.array(nonEmpty).min(1) }).optional(),
  tracking: z.object({ steps: z.array(nonEmpty).min(1) }).optional(),
});

export const DesignRequirementSchema = z.object({
  id: nonEmpty.regex(/^DREQ-\d{2}$/, 'design requirement id must look like DREQ-01'),
  ears: earsString,
  enforcement: EnforcementSchema,
  verified_by: z.array(nonEmpty.regex(/^DSC-\d{2}$/)).min(1),
});

export const DesignScenarioSchema = z.object({
  id: nonEmpty.regex(/^DSC-\d{2}$/, 'design scenario id must look like DSC-01'),
  given: nonEmpty,
  when: nonEmpty,
  then: nonEmpty,
  test_name: nonEmpty,
});

export const DesignSystemSchema = z.object({
  design_system: z.object({
    name: nonEmpty,
    version: z.number().int().min(1).default(1),
    contract: nonEmpty,
    tokens: nonEmpty,
    /** Binds the contract to the exact tokens approved. Drift is LINT-33. */
    tokens_hash: nonEmpty.regex(/^sha256:[0-9a-f]{64}$/, 'tokens_hash must be "sha256:" + 64 hex'),
    direction: DesignDirectionSchema,
    scales: DesignScalesSchema,
    palette: z.object({
      max_hues: z.number().int().min(1).max(8),
      neutral_ramp: z.array(nonEmpty).min(2),
      semantic: z.array(nonEmpty).default([]),
      modes: z.array(z.enum(['light', 'dark'])).min(1),
      accent_budget: z.object({
        rule: nonEmpty,
        max_per_surface: z.number().int().min(0),
      }).optional(),
    }),
    accessibility: z.object({
      contrast_pairs: z.array(ContrastPairSchema).min(1),
      modes_must_both_pass: z.boolean().default(true),
      min_touch_target: z.string().default('44px'),
      focus_visible: z.enum(['required', 'optional']).default('required'),
      baseline: z.string().default('WCAG 2.1 AA'),
      target: z.string().default('WCAG 2.2 AA'),
    }),
    required_states: z.array(nonEmpty).min(1),
    /* The widths every surface must hold without overflowing. DESIGN.md listed
       these as acceptance criteria in prose and nothing checked them, so they
       are declared here where a gate can read them. */
    viewports: z.array(z.number().int().min(200).max(4000)).min(1).default([360, 768, 1440]),
    requirements: z.array(DesignRequirementSchema).min(1),
    verification: z.object({
      check_suite: nonEmpty,
      report: nonEmpty,
      scenarios: z.array(DesignScenarioSchema).min(1),
    }),
  }),
});

/** One surface, carrying the intent a bare name could not. */
export const SurfaceSchema = z.object({
  id: nonEmpty,
  density: z.enum(['dense', 'spacious']).default('spacious'),
  states: z.array(nonEmpty).default([]),
  primary_action: z.string().default(''),
});

/**
 * The design plane's hook into a domain spec.
 *
 * A surface domain names the L.S.Design contract it is built against and the
 * frozen handoff the studio released. The harness treats that handoff exactly
 * as it treats an upstream domain's deliverables: frozen input a cold worker
 * receives and must not relitigate.
 *
 * `surfaces` takes a bare string or a full surface, so every blueprint written
 * before design.system.yaml existed keeps validating and `compile` normalises
 * the bare form rather than the author having to.
 */
export const DesignBindingSchema = z.object({
  /** Path to design.system.yaml. Absent means the surface has no checkable contract. */
  system: z.string().optional(),
  contract: nonEmpty,
  handoff: z.string().optional(),
  surfaces: z.array(z.union([nonEmpty, SurfaceSchema])).min(1),
  target_stack: z.string().optional(),
});

/** A source a domain is permitted to reach, checked against a constitution allowlist. */
export const ExternalSourceSchema = z.object({
  url: nonEmpty,
  allowlist: nonEmpty,
  access: z.enum(['public-feed', 'public-api', 'authenticated']),
  note: z.string().default(''),
});

export const SpecSchema = z.object({
  module: nonEmpty.regex(DOMAIN_PATTERN),
  runtime: nonEmpty,
  requirements: z.array(RequirementSchema).min(1),
  types: nonEmpty,
  contracts: z.record(nonEmpty, ContractSchema),
  design: DesignBindingSchema.optional(),
  external_sources: z.array(ExternalSourceSchema).default([]),
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
    /* What this domain costs a worker, declared rather than remembered.
       ui/client needed 120 turns and 40 minutes and could only be told so on
       the command line, so it timed out twice at the 15-minute default and
       would have again for anyone who re-ran `aose dispatch` without knowing.
       The worker's budget is separate from the gate's on purpose: a gate that
       runs `npm install && vite build && vitest` needs a few minutes, and
       letting it inherit a 40-minute worker budget would let a hung gate sit
       there for 40 minutes. */
    budget: z.object({
      max_attempts: z.number().int().min(1).max(10).optional(),
      /** Turn budget for the worker, where the adapter supports one. */
      max_turns: z.number().int().min(1).max(500).optional(),
      /** Wall-clock minutes for the worker, distinct from execution_gate.timeout_minutes. */
      timeout_minutes: z.number().int().min(1).max(180).optional(),
    }).default({}),
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
export type Allowlist = z.infer<typeof AllowlistSchema>;
export type DesignBinding = z.infer<typeof DesignBindingSchema>;
export type ExternalSource = z.infer<typeof ExternalSourceSchema>;
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
