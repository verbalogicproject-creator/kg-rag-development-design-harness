# Freelance developer dashboard

> Track freelance opportunities from first sighting to won or lost, and surface new ones worth a proposal.

**Audience** A solo developer starting to freelance, working offline on their own machine  
**Scope class** architectural  
**Format** aose-blueprint/v2  
**Generated** 2026-09-05T15:06:02.982Z

## Success criteria

- WHEN a job post is pasted in THE SYSTEM SHALL extract its title, budget, rate and skills, or report exactly which fields it could not read.
- WHEN an opportunity changes stage THE SYSTEM SHALL record the transition and reject a stage change that the pipeline does not permit.
- WHILE a scout run is in progress THE SYSTEM SHALL fetch only from sources on the feed_sources allowlist.
- WHEN a fetched listing matches one already stored THE SYSTEM SHALL deduplicate it rather than creating a second opportunity.
- WHEN listings are scored against the profile THE SYSTEM SHALL rank them by fit and show why each scored as it did.
- WHERE the dashboard is opened with no data THE SYSTEM SHALL show an explicit empty state rather than invented sample rows.

## Non-goals

- Invoicing, time tracking and earnings reporting, which are version two
- Any hosted backend, account system or telemetry
- Scraping a site whose terms prohibit programmatic access

## Constitution

| Article | Rule | Enforced by |
| --- | --- | --- |
| **ART-01** Pure cores | A core/* domain performs no I/O, no network access and no DOM access; it is a function of its inputs. | review |
| **ART-02** Errors are values | A state transition reports failure by returning a discriminated Result, never by throwing across a domain boundary. | lint |
| **ART-03** Immutable transitions | Domain state objects are never mutated in place; a transition returns a new object. | review |
| **ART-04** Every scenario is a named test | Each verification scenario maps to exactly one test whose name matches the scenario's test_name. | gate |
| **ART-05** Local first | The dashboard runs offline against local storage. No account, no hosted backend, no telemetry. | review |
| **ART-06** Fetch only what a source permits | A domain may reach a network source only if that source appears on the feed_sources allowlist. Scraping a site whose terms forbid programmatic access is prohibited regardless of technical feasibility. | lint |
| **ART-07** The design contract is law | A surface renders from the design contract's tokens. A raw colour literal, a magic pixel value or a one-off font size in a component is a defect. | gate |
| **ART-08** No invented content ships | Fixture values from generated screens are quarantined. Real content or an explicit empty state, never a plausible-looking invention. | lint |
| **ART-09** Scales are closed sets | Every visual value is a member of a declared scale. A one-off size, duration or radius is a defect even when it is expressed as a token. | gate |
| **ART-10** Both modes ship | Every declared contrast pair meets its target in light and in dark. A mode that was never measured has not shipped. | gate |
| **ART-11** The direction is falsifiable | Every design system declares an anti_direction, and every entry cites its source. A review that cannot name the item it is judging against has reviewed nothing. | review |

## Architecture

Build order (dependencies first): `core/opportunity` → `core/match` → `core/parse` → `infra/feeds` → `infra/store` → `ui/client`

| Domain | Responsibility | Depends on | Exports |
| --- | --- | --- | --- |
| `core/opportunity` | The opportunity record and its pipeline state machine. Pure; no I/O. | — | `STAGES`, `createOpportunity`, `advance`, `canAdvance`, `isTerminal` |
| `core/match` | Score an opportunity against a freelancer profile and explain the score. Pure; no I/O. | `core/opportunity` | `scoreOpportunity`, `rankOpportunities` |
| `core/parse` | Turn a pasted job post into an opportunity, naming every field it could not read. Pure; no I/O. | `core/opportunity` | `parsePost`, `parseRate`, `parseBudget`, `extractSkills` |
| `infra/feeds` | Fetch allowlisted job feeds through an injected fetch, normalize them to opportunities and deduplicate. | `core/opportunity`, `core/parse` | `SOURCES`, `runScout`, `normalizeItem`, `dedupeKey` |
| `infra/store` | Persistence for opportunities, profile and scout history, with schema migration, over whichever backend the host offers — node:sqlite, browser storage, or memory. | `core/opportunity` | `openStore`, `saveOpportunity`, `listOpportunities`, `saveProfile`, `loadProfile` |
| `ui/client` | The dashboard surfaces. Pipeline board, scout inbox, opportunity detail, profile. | `core/opportunity`, `core/match`, `infra/store` | `App`, `PipelineBoard`, `ScoutInbox`, `OpportunityDetail`, `ProfileForm`, `toBoardColumns`, `toInboxRows`, `emptyStateFor` |

## Decisions

- **DEC-01** Every contract declares a precondition and a postcondition, not only a signature.
  - Why: Generating preconditions alongside postconditions measurably reduces false alarms when contracts are checked, so both are required rather than optional.
  - Rejected: Postconditions only; Prose descriptions only
  - Source: https://arxiv.org/abs/2510.12702 (verified)
- **DEC-02** Decompose into a dependency DAG of pure cores plus thin adapters, and build in topological order.
  - Why: Independent lines of work converge on decomposing into a dependency structure and planning per node rather than generating a system in one pass.
  - Rejected: One module per screen; A single service with internal layering
  - Source: https://arxiv.org/abs/2309.12499 (verified)
- **DEC-03** The scout injects its fetch function rather than calling the network directly.
  - Why: Normalization, deduplication and scoring stay deterministic and gate-testable offline, and the only network edge is a single substitutable seam.
  - Rejected: Direct fetch inside the domain; A recorded-cassette HTTP layer
- **DEC-04** Source access is governed by the feed_sources allowlist in the constitution, and Upwork is excluded until API access is granted.
  - Why: Its terms prohibit scraping and its API needs approval, so the allowlist encodes the legal boundary where a linter can enforce it rather than where a developer must remember it.
  - Rejected: Scrape the public search pages; Ship with no sources at all
- **DEC-05** The surface is built against a frozen L.S.Design handoff rather than styled during implementation.
  - Why: A human approves the visual direction on real screens once, and the builder implements what was approved instead of relitigating it, which is what keeps a token system from drifting.
  - Rejected: Style during implementation; Apply a component library default theme
- **DEC-06** The store selects a persistence backend from its host and reaches the node-only one through a dynamic import, so one module serves both the CLI and the browser surface.
  - Why: ui/client is browser-targeted and depends on infra/store. While the store declared "esm-only, node24" the shipped bundle opened with `import{DatabaseSync}from"node:sqlite"` and no browser could load it — and neither gate could see it, because a bundler externalises specifiers it does not recognise and the unit tests run in node, where that module is real. A static import is resolved by a bundler whether or not it ever executes, so the host check has to guard an `import()`, not an `if`. Keeping one module behind one contract also keeps ART-05 honest: every backend here is local, and the surface cannot quietly acquire a hosted one.
  - Rejected: Keep the store node-only and give ui/client its own browser store — two implementations of one contract, drifting apart, with migrations to write twice; Put a port in ui/client and inject the node store — correct, but it moves the host decision into the surface and leaves the browser case unimplemented; Persist nothing in the browser and treat the CLI as the only real client — contradicts the premise that the dashboard is the product

## Domain `core/opportunity`

### Requirements

| Id | Requirement (EARS) | Verified by |
| --- | --- | --- |
| REQ-01 | WHEN an opportunity is created from a title and a source THE SYSTEM SHALL place it at the lead stage with a stable identifier and a creation timestamp. | SC-01 |
| REQ-02 | WHEN a stage change is requested THE SYSTEM SHALL apply it only if the pipeline permits that transition, and otherwise return a discriminated error naming the rejected transition. | SC-02, SC-03 |
| REQ-03 | WHEN a stage change is applied THE SYSTEM SHALL return a new opportunity with the transition appended to its history and leave the input unchanged. | SC-04 |
| REQ-04 | WHERE an opportunity has reached won, lost or archived THE SYSTEM SHALL treat it as terminal and reject any further stage change. | SC-05 |
| REQ-05 | WHEN two opportunities describe the same posting THE SYSTEM SHALL produce the same deduplication key for both. | SC-06 |

### Types

```ts
type Stage = 'lead' | 'drafting' | 'submitted' | 'interviewing' | 'won' | 'lost' | 'archived';
type StageError = 'ILLEGAL_TRANSITION' | 'TERMINAL_STAGE' | 'UNKNOWN_STAGE';

type Result<T, E extends string = string> =
  | { ok: true; value: T }
  | { ok: false; error: E; detail: string };

interface Money { readonly amount: number; readonly currency: string }

interface Transition {
  readonly from: Stage;
  readonly to: Stage;
  readonly at: string;          // ISO 8601
  readonly note: string;
}

interface Opportunity {
  readonly id: string;
  readonly title: string;
  readonly source: string;      // the feed or 'manual'
  readonly url: string;
  readonly stage: Stage;
  readonly budget: Money | null;
  readonly hourlyRate: Money | null;
  readonly skills: readonly string[];
  readonly postedAt: string | null;
  readonly createdAt: string;
  readonly history: readonly Transition[];
  readonly notes: string;
}
```

### Contracts

- `createOpportunity(draft: Partial<Opportunity>, now: string): Result<Opportunity, StageError>` (transition)
  - pre: draft.title is a non-empty string and now is an ISO 8601 timestamp.
  - post: Returns an opportunity at stage 'lead' with an empty history, createdAt set to now, and an id derived deterministically from source and url so the same posting yields the same id.
  - errors: UNKNOWN_STAGE
- `canAdvance(from: Stage, to: Stage): boolean` (query)
  - pre: Both arguments are declared Stage values.
  - post: Returns true only for a transition the pipeline permits, and false for every transition out of a terminal stage.
- `advance(opportunity: Opportunity, to: Stage, now: string, note: string): Result<Opportunity, StageError>` (transition)
  - pre: canAdvance(opportunity.stage, to) is true and now is an ISO 8601 timestamp.
  - post: Returns a new opportunity at the requested stage with one transition appended to history. The input object is not mutated. Returns TERMINAL_STAGE when the current stage is terminal and ILLEGAL_TRANSITION otherwise.
  - errors: ILLEGAL_TRANSITION, TERMINAL_STAGE, UNKNOWN_STAGE
- `isTerminal(stage: Stage): boolean` (query)
  - pre: stage is a declared Stage value.
  - post: Returns true exactly for won, lost and archived.

### Verification

Suite: `test/opportunity.test.js`

| Id | Given | When | Then | Test name |
| --- | --- | --- | --- | --- |
| SC-01 | a draft with a title and a source url | an opportunity is created | it starts at lead with an empty history and a deterministic id | `creates a lead with a deterministic id and empty history` |
| SC-02 | an opportunity at lead | it is advanced to drafting | a new opportunity at drafting is returned | `permits a legal stage transition` |
| SC-03 | an opportunity at lead | it is advanced directly to won | an ILLEGAL_TRANSITION error is returned | `rejects a transition the pipeline does not permit` |
| SC-04 | an opportunity at submitted | it is advanced to interviewing | the input object is unchanged and the returned history has one more entry | `advancing does not mutate the input opportunity` |
| SC-05 | an opportunity at won | any further advance is attempted | a TERMINAL_STAGE error is returned | `refuses to move an opportunity out of a terminal stage` |
| SC-06 | two drafts describing the same posting | both are created | their ids are equal | `the same posting yields the same id` |

### Task

Deliverables: `src/core/opportunity.js`, `test/opportunity.test.js`

Gate: `node --test test/opportunity.test.js` — Exit code 0 with one passing test per verification scenario, each named exactly as its test_name.

## Domain `core/match`

### Requirements

| Id | Requirement (EARS) | Verified by |
| --- | --- | --- |
| REQ-01 | WHEN an opportunity is scored against a profile THE SYSTEM SHALL return a score between 0 and 100 together with the reasons that produced it. | SC-01, SC-02 |
| REQ-02 | IF an opportunity matches a profile exclusion THE SYSTEM SHALL score it zero and name the exclusion that rejected it. | SC-03 |
| REQ-03 | IF an opportunity's rate is below the profile minimum THE SYSTEM SHALL reduce its score and record the shortfall as a reason. | SC-04 |
| REQ-04 | WHEN a list of opportunities is ranked THE SYSTEM SHALL order it by score descending and break ties by the more recent posting. | SC-05 |
| REQ-05 | WHERE a profile declares no skills THE SYSTEM SHALL score every opportunity on rate and recency alone rather than returning zero for all. | SC-06 |

### Types

```ts
import type { Opportunity, Money } from '../core/opportunity';

interface Profile {
  readonly skills: readonly string[];
  readonly minRate: Money | null;
  readonly keywords: readonly string[];
  readonly exclusions: readonly string[];
}

type ReasonKind = 'skill' | 'rate' | 'keyword' | 'recency' | 'exclusion';

interface Reason {
  readonly kind: ReasonKind;
  readonly detail: string;
  readonly delta: number;       // contribution to the final score
}

interface Score {
  readonly value: number;       // 0..100
  readonly reasons: readonly Reason[];
  readonly excluded: boolean;
}
```

### Contracts

- `scoreOpportunity(opportunity: Opportunity, profile: Profile, now: string): Score` (query)
  - pre: now is an ISO 8601 timestamp and profile arrays are defined, possibly empty.
  - post: Returns a score in 0..100 whose reasons' deltas sum to the score, or a zero score with excluded true and a single exclusion reason. The same inputs always produce the same score.
  - algorithm: weighted sum of skill overlap, rate margin above the profile minimum, keyword hits and posting recency, clamped to 0..100, short-circuited to zero on any exclusion match
- `rankOpportunities(opportunities: readonly Opportunity[], profile: Profile, now: string): readonly { opportunity: Opportunity; score: Score }[]` (query)
  - pre: Every opportunity is well formed and now is an ISO 8601 timestamp.
  - post: Returns every input paired with its score, ordered by score descending then by postedAt descending. The input array is not mutated.

### Verification

Suite: `test/match.test.js`

| Id | Given | When | Then | Test name |
| --- | --- | --- | --- | --- |
| SC-01 | an opportunity whose skills fully overlap the profile | it is scored | the score is high and a skill reason names the overlap | `scores a full skill overlap highly and explains why` |
| SC-02 | any scored opportunity | the reasons are summed | the deltas add up to the reported score | `the reasons account for the whole score` |
| SC-03 | an opportunity containing a profile exclusion | it is scored | the score is zero, excluded is true and the exclusion is named | `an exclusion drives the score to zero and says which one` |
| SC-04 | an opportunity paying below the profile minimum rate | it is scored | the score is reduced and a rate reason records the shortfall | `a rate below the minimum reduces the score with a stated shortfall` |
| SC-05 | several opportunities with different scores and dates | they are ranked | they are ordered by score then by recency | `ranks by score and breaks ties by recency` |
| SC-06 | a profile that declares no skills | opportunities are scored | they are still separated by rate and recency rather than all scoring zero | `an empty skill list still produces a useful ranking` |

### Task

Deliverables: `src/core/match.js`, `test/match.test.js`

Gate: `node --test test/match.test.js` — Exit code 0 with one passing test per verification scenario. Scoring is deterministic, so a repeated run gives identical scores.

## Domain `core/parse`

### Requirements

| Id | Requirement (EARS) | Verified by |
| --- | --- | --- |
| REQ-01 | WHEN a pasted job post is parsed THE SYSTEM SHALL return the fields it recognized together with an explicit list of the fields it could not read. | SC-01, SC-02 |
| REQ-02 | IF the post contains no recognizable title THE SYSTEM SHALL return a discriminated error rather than guessing one. | SC-03 |
| REQ-03 | WHEN a rate is written in any of the common forms THE SYSTEM SHALL extract its amount and currency. | SC-04, SC-05 |
| REQ-04 | WHEN a fixed budget is stated as a range THE SYSTEM SHALL record the lower bound and note that a range was given. | SC-06 |
| REQ-05 | WHILE extracting skills THE SYSTEM SHALL return only terms that appear in the post, never terms inferred from context. | SC-07 |

### Types

```ts
import type { Opportunity, Money, Result } from '../core/opportunity';

type ParseError = 'NO_TITLE' | 'EMPTY_INPUT';
type Field = 'title' | 'budget' | 'hourlyRate' | 'skills' | 'postedAt' | 'url';

interface ParseOutcome {
  readonly draft: Partial<Opportunity>;
  readonly missing: readonly Field[];    // fields the parser could not read
  readonly notes: readonly string[];     // e.g. "budget given as a range"
}
```

### Contracts

- `parsePost(text: string, now: string): Result<ParseOutcome, ParseError>` (transition)
  - pre: text is a string and now is an ISO 8601 timestamp.
  - post: Returns a draft carrying only fields found verbatim in the text, plus every field it failed to read listed in missing. Returns EMPTY_INPUT for blank text and NO_TITLE when no title line can be identified. Never invents a value.
  - errors: NO_TITLE, EMPTY_INPUT
- `parseRate(text: string): Money | null` (query)
  - pre: text is a string.
  - post: Returns the hourly rate with its currency when one is stated, and null when none is stated. Never returns a rate the text does not contain.
- `parseBudget(text: string): Result<{ budget: Money; wasRange: boolean }, ParseError>` (transition)
  - pre: text is a string.
  - post: Returns the stated fixed budget, using the lower bound and flagging wasRange when a range is given. Returns an error when no budget is stated.
  - errors: EMPTY_INPUT
- `extractSkills(text: string, vocabulary: readonly string[]): readonly string[]` (query)
  - pre: vocabulary is a list of known skill terms, possibly empty.
  - post: Returns the vocabulary terms that occur in the text, deduplicated and lowercased, in the order they first appear. Returns an empty array rather than guessing when nothing matches.

### Verification

Suite: `test/parse.test.js`

| Id | Given | When | Then | Test name |
| --- | --- | --- | --- | --- |
| SC-01 | a complete job post | it is parsed | title, rate and skills are extracted and missing is empty | `extracts every stated field from a complete post` |
| SC-02 | a post with no budget and no date | it is parsed | those fields are listed in missing rather than filled in | `names the fields it could not read instead of inventing them` |
| SC-03 | a body of text with no title line | it is parsed | a NO_TITLE error is returned | `refuses to guess a title` |
| SC-04 | a rate written as 85 dollars per hour | the rate is parsed | the amount and currency are returned | `reads an hourly rate written in prose` |
| SC-05 | text with no rate at all | the rate is parsed | null is returned | `returns null rather than a default rate` |
| SC-06 | a budget stated as a range | the budget is parsed | the lower bound is recorded and wasRange is true | `records the lower bound of a budget range and flags it` |
| SC-07 | a post mentioning two known skills and implying a third | skills are extracted | only the two stated skills are returned | `extracts only skills the post actually names` |

### Task

Deliverables: `src/core/parse.js`, `test/parse.test.js`

Gate: `node --test test/parse.test.js` — Exit code 0 with one passing test per verification scenario. A field the parser could not read appears in `missing`; it is never filled with a guess.

## Domain `infra/feeds`

### Requirements

| Id | Requirement (EARS) | Verified by |
| --- | --- | --- |
| REQ-01 | WHILE a scout run is in progress THE SYSTEM SHALL request only URLs whose origin appears in the shipped source list. | SC-01, SC-02 |
| REQ-02 | IF a source is unreachable or returns a malformed body THE SYSTEM SHALL record that source as failed and continue with the remaining sources. | SC-03 |
| REQ-03 | WHEN a listing is normalized THE SYSTEM SHALL produce an opportunity carrying the source it came from and its original url. | SC-04 |
| REQ-04 | WHEN a listing has already been seen THE SYSTEM SHALL deduplicate it rather than emitting a second opportunity. | SC-05 |
| REQ-05 | WHERE a source requires a credential that has not been supplied THE SYSTEM SHALL skip it and report it as skipped rather than attempting an unauthenticated request. | SC-06 |

### Types

```ts
import type { Opportunity, Result } from '../core/opportunity';

type FeedError = 'UNREACHABLE' | 'MALFORMED' | 'NOT_ALLOWED' | 'MISSING_CREDENTIAL';
type Access = 'public-feed' | 'public-api' | 'authenticated';

interface Source {
  readonly id: string;
  readonly url: string;
  readonly access: Access;
  readonly format: 'json' | 'rss';
  readonly credentialEnvVar: string | null;
}

interface SourceOutcome {
  readonly source: string;
  readonly status: 'ok' | 'failed' | 'skipped';
  readonly detail: string;
  readonly found: number;
}

interface ScoutReport {
  readonly ranAt: string;
  readonly opportunities: readonly Opportunity[];
  readonly outcomes: readonly SourceOutcome[];
  readonly duplicatesDropped: number;
}

type FetchLike = (url: string) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;
```

### Contracts

- `runScout(sources: readonly Source[], fetchImpl: FetchLike, seen: readonly string[], now: string): Promise<Result<ScoutReport, FeedError>>` (transition)
  - pre: Every source url origin appears in SOURCES, fetchImpl is supplied by the caller, and now is an ISO 8601 timestamp.
  - post: Returns one outcome per source and the deduplicated opportunities found. A source that is unreachable or malformed is recorded as failed without aborting the run. A source whose credential env var is unset is recorded as skipped and never requested. Returns NOT_ALLOWED without any request when a url is not in SOURCES.
  - errors: UNREACHABLE, MALFORMED, NOT_ALLOWED, MISSING_CREDENTIAL
- `normalizeItem(raw: unknown, source: Source, now: string): Result<Opportunity, FeedError>` (transition)
  - pre: source is a declared source and raw is one item from its response body.
  - post: Returns an opportunity at the lead stage carrying source.id and the item's own url. Returns MALFORMED when the item lacks a title or a url, rather than substituting a placeholder.
  - errors: MALFORMED
- `dedupeKey(opportunity: Opportunity): string` (query)
  - pre: The opportunity has a url or a title.
  - post: Returns a stable key such that two listings of the same posting from different sources collide, and different postings do not.

### Verification

Suite: `test/feeds.test.js`

| Id | Given | When | Then | Test name |
| --- | --- | --- | --- | --- |
| SC-01 | the shipped source list | a scout run executes with a recording fetch | every requested url origin is one of the shipped sources | `requests only the shipped allowlisted sources` |
| SC-02 | a source whose url is not in the shipped list | a scout run is attempted | NOT_ALLOWED is returned and no request is made | `refuses an unlisted source without touching the network` |
| SC-03 | one source that errors and one that succeeds | the run executes | the failure is recorded and the successful source still yields listings | `one failing source does not abort the run` |
| SC-04 | a well formed feed item | it is normalized | an opportunity at lead carrying the source and url is returned | `normalizes a feed item into a lead opportunity` |
| SC-05 | the same posting present in two feeds | the run executes | one opportunity is emitted and the duplicate is counted | `deduplicates the same posting seen in two feeds` |
| SC-06 | an authenticated source with no credential in the environment | the run executes | it is reported as skipped and never requested | `skips an authenticated source when its credential is absent` |

### Task

Deliverables: `src/infra/feeds.js`, `test/feeds.test.js`

Gate: `node --test test/feeds.test.js` — Exit code 0 with one passing test per verification scenario, and every test supplies its own fetch function so the suite makes no real network request. A request to any host outside the shipped source list is a failure, not a warning.

## Domain `infra/store`

### Requirements

| Id | Requirement (EARS) | Verified by |
| --- | --- | --- |
| REQ-01 | WHEN the store is opened against a new location THE SYSTEM SHALL create its schema and record the schema version. | SC-01 |
| REQ-02 | WHEN the store is opened against a location from an older schema version THE SYSTEM SHALL migrate it forward without losing existing rows. | SC-02 |
| REQ-03 | WHEN an opportunity is saved twice THE SYSTEM SHALL update the existing row rather than creating a duplicate. | SC-03 |
| REQ-04 | WHEN opportunities are listed by stage THE SYSTEM SHALL return only that stage, most recently updated first. | SC-04 |
| REQ-05 | IF a write fails THE SYSTEM SHALL leave the store unchanged and return a discriminated error. | SC-05 |
| REQ-06 | WHERE the module is loaded by a bundler THE SYSTEM SHALL carry no static import of a host-only module, so a browser build contains no unresolvable specifier. | SC-06 |
| REQ-07 | WHEN opportunities are listed by stage THE SYSTEM SHALL resolve the query through an index rather than scanning every row. | SC-07 |
| REQ-08 | WHEN a browser-backed store is reopened at the same location THE SYSTEM SHALL return the rows written before it was closed. | SC-08 |

### Types

```ts
import type { Opportunity, Stage, Result } from '../core/opportunity';
import type { Profile } from '../core/match';

type StoreError = 'NOT_FOUND' | 'WRITE_FAILED' | 'MIGRATION_FAILED' | 'NO_BACKEND';

/* Which host the module found at load time. Reported rather than assumed, so
   a caller can say which store it is talking to instead of guessing. */
type Backend = 'sqlite' | 'web' | 'memory';

interface Store {
  /* Opaque to this contract: a file path under node, a database name in a
     browser, ':memory:' anywhere for a store that persists nothing. */
  readonly location: string;
  readonly backend: Backend;
  readonly schemaVersion: number;
  close(): void;
}
```

### Contracts

- `openStore(location: string): Result<Store, StoreError>` (transition)
  - pre: location is a writable file path, a browser database name, or the string ':memory:'.
  - post: Selects a backend from the host — node:sqlite under node, a browser storage API in a browser, in-memory for ':memory:' — and returns an open store whose schema is at the current version, creating or migrating it as needed. Existing rows survive a migration. Returns MIGRATION_FAILED without altering the store when migration cannot complete, and NO_BACKEND when the host offers no persistence the module can use. The node backend is reached only through a dynamic import inside a host check, so a browser bundle never carries the specifier.
  - errors: MIGRATION_FAILED, WRITE_FAILED, NO_BACKEND
- `saveOpportunity(store: Store, opportunity: Opportunity): Result<Opportunity, StoreError>` (transition)
  - pre: The store is open and the opportunity has an id.
  - post: Inserts or updates the row keyed by id and returns the stored opportunity. Writing the same opportunity twice leaves exactly one row. On failure the store is unchanged.
  - errors: WRITE_FAILED
- `listOpportunities(store: Store, stage: Stage | null): Result<readonly Opportunity[], StoreError>` (transition)
  - pre: The store is open.
  - post: Returns opportunities at the requested stage, or all of them when stage is null, ordered by last update descending. The stage query is served by an index on (stage, updated_at), not a full scan.
  - errors: NOT_FOUND
- `saveProfile(store: Store, profile: Profile): Result<Profile, StoreError>` (transition)
  - pre: The store is open.
  - post: Persists the single profile row, replacing any previous one, and returns it.
  - errors: WRITE_FAILED
- `loadProfile(store: Store): Result<Profile, StoreError>` (transition)
  - pre: The store is open.
  - post: Returns the stored profile, or NOT_FOUND when none has been saved. Never returns a fabricated default profile.
  - errors: NOT_FOUND

### Verification

Suite: `test/store.test.js`

| Id | Given | When | Then | Test name |
| --- | --- | --- | --- | --- |
| SC-01 | a location with no store | the store is opened | the schema is created at the current version | `creates the schema on first open` |
| SC-02 | a store written at an older schema version | the store is opened | it migrates forward and the existing rows survive | `migrates an older store without losing rows` |
| SC-03 | an opportunity saved twice | it is listed | exactly one row is returned | `saving the same opportunity twice leaves one row` |
| SC-04 | opportunities across several stages | one stage is listed | only that stage is returned, most recent first | `lists a single stage ordered by recency` |
| SC-05 | a store whose write fails | a save is attempted | WRITE_FAILED is returned and the store is unchanged | `a failed write leaves the store untouched` |
| SC-06 | the module's own source text | its top-level import statements are read | none of them names a node: module, because a bundler resolves static imports whether or not they ever run | `the module carries no static host-only import` |
| SC-07 | a sqlite-backed store holding opportunities across stages | the query plan for a listing by stage is examined | the plan uses an index and does not scan the table | `listing by stage is served by an index` |
| SC-08 | a browser-backed store, with the browser storage API stubbed | rows are written, the store is closed and reopened at the same location | the rows written before the close are returned | `a browser store survives being closed and reopened` |

### Task

Deliverables: `src/infra/store.js`, `test/store.test.js`

Gate: `node --test test/store.test.js` — Exit code 0 with one passing test per verification scenario. The sqlite backend is exercised against ':memory:' or a temporary file; the browser backend is exercised by stubbing the storage API the module looks for, so both paths are tested from node. No test leaves a database behind.

## Domain `ui/client`

### Requirements

| Id | Requirement (EARS) | Verified by |
| --- | --- | --- |
| REQ-01 | WHEN the board is rendered THE SYSTEM SHALL show one column per pipeline stage, each listing only the opportunities at that stage. | SC-01 |
| REQ-02 | WHEN an opportunity is moved to another column THE SYSTEM SHALL apply the engine's transition and leave the board unchanged if the engine rejects it. | SC-02, SC-03 |
| REQ-03 | WHEN the scout inbox is rendered THE SYSTEM SHALL list scored listings highest first and show the reasons behind each score. | SC-04 |
| REQ-04 | WHERE a surface has no data THE SYSTEM SHALL render an explicit empty state naming the next action, never placeholder rows. | SC-05 |
| REQ-05 | WHILE a scout run is in progress THE SYSTEM SHALL show which sources are being read and report each source's outcome when the run ends. | SC-06 |
| REQ-06 | WHEN any surface renders THE SYSTEM SHALL take every colour, type, spacing and radius value from the design contract's tokens rather than from a literal. | SC-07 |

### Types

```ts
import type { Opportunity, Stage } from '../core/opportunity';
import type { Score, Profile } from '../core/match';
import type { ScoutReport } from '../infra/feeds';

interface Column {
  readonly stage: Stage;
  readonly label: string;
  readonly items: readonly Opportunity[];
}

interface InboxRow {
  readonly opportunity: Opportunity;
  readonly score: Score;
  readonly isNew: boolean;
}

interface EmptyState {
  readonly headline: string;
  readonly action: string;      // the next thing the person can do
}

type Surface = 'pipeline-board' | 'scout-inbox' | 'opportunity-detail' | 'profile';

interface DashboardProps {
  readonly opportunities: readonly Opportunity[];
  readonly profile: Profile | null;
  readonly lastScout: ScoutReport | null;
  readonly onAdvance: (id: string, to: Stage) => void;
  readonly onScout: () => void;
}
```

### Contracts

- `toBoardColumns(opportunities: readonly Opportunity[], stages: readonly Stage[]): readonly Column[]` (query)
  - pre: stages lists the pipeline stages in display order.
  - post: Returns one column per stage in the given order, each holding only the opportunities at that stage, with every input opportunity appearing in exactly one column. The input array is not mutated.
- `toInboxRows(scored: readonly { opportunity: Opportunity; score: Score }[], seenIds: readonly string[]): readonly InboxRow[]` (query)
  - pre: scored is the output of rankOpportunities and seenIds lists opportunities already reviewed.
  - post: Returns the rows in the order given, marking isNew true exactly for opportunities whose id is absent from seenIds.
- `emptyStateFor(surface: Surface): EmptyState` (query)
  - pre: surface is one of the declared surfaces.
  - post: Returns a headline and a concrete next action for that surface. Never returns sample or placeholder content.
- `PipelineBoard(props: DashboardProps): JSX.Element` (query)
  - pre: props.opportunities is defined, possibly empty.
  - post: Renders one region per stage from toBoardColumns, renders the board's empty state when there are no opportunities, and calls onAdvance with the opportunity id and target stage when a card is moved.
- `ScoutInbox(props: DashboardProps): JSX.Element` (query)
  - pre: props.profile may be null, in which case scoring is not shown.
  - post: Renders scored listings highest first with each score's reasons visible, shows per-source outcomes after a run, and calls onScout when a run is requested.
- `OpportunityDetail(props: { opportunity: Opportunity; score: Score | null }): JSX.Element` (query)
  - pre: opportunity is a stored opportunity.
  - post: Renders the opportunity's fields, its stage history in order, and its score reasons when a score is supplied. Renders a field's absence explicitly rather than substituting a value.
- `ProfileForm(props: { profile: Profile | null; onSave: (profile: Profile) => void }): JSX.Element` (query)
  - pre: profile may be null when none has been saved.
  - post: Renders the profile's skills, minimum rate, keywords and exclusions for editing, and calls onSave with the edited profile. With a null profile it renders empty fields, never invented defaults.
- `App(props: DashboardProps): JSX.Element` (query)
  - pre: The store has been loaded.
  - post: Renders the four surfaces behind navigation, each reachable, with no navigation target left unresolved.

### Verification

Suite: `src/__tests__/client.test.tsx`

| Id | Given | When | Then | Test name |
| --- | --- | --- | --- | --- |
| SC-01 | opportunities spread across several stages | the board is rendered | each column lists only its own stage and every opportunity appears once | `the board puts every opportunity in exactly one stage column` |
| SC-02 | a card at lead | it is moved to drafting | onAdvance is called with that id and stage | `moving a card requests the engine transition` |
| SC-03 | a card at won | a move is attempted | the board is unchanged and no transition is requested | `the board refuses a move the engine would reject` |
| SC-04 | scored listings with different scores | the inbox is rendered | they appear highest first with their reasons visible | `the inbox ranks by score and shows why` |
| SC-05 | no opportunities at all | the board is rendered | an empty state naming the next action is shown and no placeholder rows appear | `an empty board shows a real empty state, not sample rows` |
| SC-06 | a completed scout run with one failed source | the inbox is rendered | each source outcome is reported including the failure | `the inbox reports every source outcome after a run` |
| SC-07 | the built stylesheet and components | they are scanned for colour and size values | every value resolves to a design token and no literal remains | `every visual value comes from a design token` |

### Task

Deliverables: `package.json`, `vite.config.ts`, `index.html`, `src/main.tsx`, `src/App.tsx`, `src/view-model.ts`, `src/components/PipelineBoard.tsx`, `src/components/ScoutInbox.tsx`, `src/components/OpportunityDetail.tsx`, `src/components/ProfileForm.tsx`, `src/data/copy.ts`, `src/styles.css`, `src/__tests__/client.test.tsx`

Gate: `npm install --no-audit --no-fund --silent && npm run build && npm run test:unit` — Exit code 0. The production build compiles, and one passing test exists per verification scenario named exactly as its test_name. Interface copy lives in src/data/copy.ts rather than inline in components, and every navigation target resolves.

## Research ledger

| Source | Claim | Confidence | Verification |
| --- | --- | --- | --- |
| [Beyond Postconditions: Can Large Language Models Infer Formal Contracts from Natural Language?](https://arxiv.org/abs/2510.12702) | Generating preconditions alongside postconditions reduces the false alarms a verifier reports when the resulting contracts are checked. | medium | verified |
| [CodePlan: Repository-level Coding using LLMs and Planning](https://arxiv.org/abs/2309.12499) | Repository-scale change is better handled as dependency and impact analysis producing a multi-step plan than as one-shot generation. | medium | verified |
