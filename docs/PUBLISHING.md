# Publishing to npm, and licensing under Apache 2.0

Everything needed to publish a package you can then `npm install` anywhere, and
to license it so the protection you think you have is the protection you
actually have.

Written against this repository, so the examples are real: `@aose/design-kg` and
`packages/aose` in an npm-workspaces monorepo.

---

# Part 1 — Publishing

## 1. The account, once

```bash
npm adduser              # or `npm login` if the account exists
npm whoami               # confirms which account you are about to publish as
```

**Turn on two-factor authentication before you publish anything.** npm supports
`auth-only` (2FA to log in) and `auth-and-writes` (2FA to publish too). Choose
`auth-and-writes`:

```bash
npm profile enable-2fa auth-and-writes
```

A published package name is a permanent public identifier. An account takeover
on a package other people depend on is a supply-chain incident, not an
inconvenience.

## 2. Choose the name before you write the code

Two shapes:

| Shape | Example | Notes |
|---|---|---|
| **Unscoped** | `aose-harness` | First come, first served across all of npm. Most good names are taken. |
| **Scoped** | `@verbalogic/aose` | Namespaced under you or an org. Effectively always available. **Prefer this.** |

Check availability without publishing:

```bash
npm view aose-harness          # "404 Not Found" means it is free
npm org ls verbalogic          # if you are using an org scope
```

**The trap that catches everyone once:** a scoped package is **private by
default**, and a private publish on a free account fails. Public scoped packages
must say so explicitly, every time:

```bash
npm publish --access public
```

Or permanently, in `package.json`:

```json
{ "publishConfig": { "access": "public" } }
```

Set `publishConfig` and forget the flag. This repo's packages should carry it.

## 3. The fields that actually matter

A publishable `package.json`, annotated for what each field does at publish time:

```json
{
  "name": "@verbalogic/design-kg",
  "version": "0.1.0",
  "description": "A design knowledge graph with a closed relation vocabulary and a deterministic build",
  "license": "Apache-2.0",
  "author": "Your Name <you@example.com>",
  "repository": { "type": "git", "url": "git+https://github.com/verbalogicproject-creator/kg-rag-development-design-harness.git" },
  "homepage": "https://github.com/verbalogicproject-creator/kg-rag-development-design-harness#readme",
  "bugs": { "url": "https://github.com/verbalogicproject-creator/kg-rag-development-design-harness/issues" },
  "keywords": ["knowledge-graph", "design-system", "kg-rag"],
  "type": "module",
  "engines": { "node": ">=24" },
  "exports": {
    ".": "./src/query.ts",
    "./build": "./src/build.ts"
  },
  "bin": { "design-kg": "./src/cli.ts" },
  "files": ["src", "curated", "README.md", "LICENSE", "NOTICE"],
  "publishConfig": { "access": "public" }
}
```

Three of these are load-bearing and routinely wrong:

**`license`** must be an SPDX identifier — `"Apache-2.0"`, not `"Apache 2"` or
`"Apache License 2.0"`. Tooling reads this string mechanically; a non-SPDX value
reads as "unlicensed" to every scanner your users run.

**`files`** is an allowlist of what ships. Without it you ship everything not
excluded, which on this repo would mean `.aose/`, worktrees, test fixtures, and
a 300 KB database. `files` is safer than `.npmignore` because it fails closed:
you list what goes, not what stays.

**`private: true`** blocks publishing entirely. The root `package.json` of this
monorepo has it, correctly — the workspace root should never be published. Each
*package* omits it.

Some files ship regardless of `files`: `package.json`, `README.md`, `LICENSE`,
`LICENSE.*`, `NOTICE`. Some never ship: `.git`, `node_modules`, `.npmrc`.

## 4. Look at the tarball before you publish it

This is the step that prevents almost every publishing regret.

```bash
npm pack --dry-run
```

It prints exactly what would ship, file by file, with the total size. Read it.
Every time.

```bash
npm pack --dry-run --json | python3 -c "
import json,sys
p = json.load(sys.stdin)[0]
print(f\"{p['name']}@{p['version']}  {p['size']} bytes, {p['entryCount']} files\")
for f in p['files']: print(' ', f['path'])"
```

What you are looking for:

- **Secrets.** A `.env` that slipped past `files`. Publishing is irreversible in
  practice — assume anything published was scraped within seconds.
- **Bulk.** Databases, fixtures, screenshots, `node_modules`.
- **Absences.** A `bin` that points at a file `files` excluded, so the CLI is
  broken for everyone who installs it.

Then publish for real:

```bash
npm publish            # add --access public if publishConfig does not set it
```

## 5. Versioning

npm enforces immutability: **a version number, once published, can never be
reused** — not even after unpublishing. Get comfortable with that.

```bash
npm version patch      # 0.1.0 → 0.1.1   bug fix, no API change
npm version minor      # 0.1.1 → 0.2.0   additive, nothing breaks
npm version major      # 0.2.0 → 1.0.0   something breaks
```

`npm version` also creates a git commit and tag, which is usually what you want.
Disable with `--no-git-tag-version`.

**Below 1.0.0, semver's normal promises do not apply** — `0.x` says "this may
break." That is a legitimate and honest place to be. Go to `1.0.0` when you are
prepared to keep the API stable, not when the code feels finished.

Publish a pre-release without disturbing `latest`:

```bash
npm version 0.2.0-beta.0
npm publish --tag beta         # installs only via `npm i pkg@beta`
npm dist-tag add pkg@0.2.0 latest   # promote when ready
```

Omitting `--tag` on a pre-release makes it `latest`, and everyone installing
your package gets the beta. That is the second-most-common publishing mistake.

## 6. Provenance — worth turning on

npm can attest that a package was built from a specific commit in a specific
public repo, via GitHub Actions:

```yaml
# .github/workflows/publish.yml
permissions:
  contents: read
  id-token: write        # required for provenance
steps:
  - uses: actions/checkout@v4
  - uses: actions/setup-node@v4
    with:
      node-version: 24
      registry-url: 'https://registry.npmjs.org'
  - run: npm ci
  - run: npm test
  - run: npm publish --provenance --access public
    env:
      NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

This puts a verified "Built and signed on GitHub Actions" badge on the package
page and links it to the exact commit. It is free, it takes ten minutes, and it
is the strongest signal a small package can give that it is what it claims.

Use a **granular access token** scoped to the one package, not a classic
automation token with account-wide write.

## 7. Installing your own package

```bash
npm install @verbalogic/design-kg
```

For a scoped package from a non-default registry, `.npmrc` maps the scope:

```
@verbalogic:registry=https://registry.npmjs.org/
```

**Before publishing at all,** test the real install locally. This catches the
"works in the repo, broken when installed" class of bug — usually a missing file
in `files`, or an import that resolved only because of the monorepo layout:

```bash
npm pack                                  # produces verbalogic-design-kg-0.1.0.tgz
cd /tmp && mkdir probe && cd probe && npm init -y
npm install /root/fable-blue/verbalogic-design-kg-0.1.0.tgz
node -e "import('@verbalogic/design-kg').then(m => console.log(Object.keys(m)))"
```

If that works, the published package will work. If you skip it, you will find
out from a stranger's issue report.

`npm link` is the other option, but it uses symlinks and therefore hides exactly
the packaging bugs you are trying to find. Prefer the tarball.

## 8. Publishing from this monorepo

Workspaces publish individually. The root stays `private: true` and is never
published.

```bash
npm publish -w packages/design-kg
npm publish --workspaces            # every non-private workspace
```

Two monorepo-specific traps:

**Workspace dependencies must be real versions at publish time.** If
`packages/aose` depends on `@verbalogic/design-kg`, that dependency must name a
published version. `npm` resolves workspace siblings locally during development,
but a consumer installing from the registry cannot.

**Publish dependencies first.** `design-kg` before `aose`, or the first consumer
to install hits a 404.

## 9. Mistakes and how to recover

| Situation | Reality |
|---|---|
| Published a secret | **Rotate the credential immediately.** Unpublishing does not help; assume it was harvested within seconds. |
| Published a broken version | `npm deprecate pkg@1.2.3 "broken, use 1.2.4"` and publish a fix. Do not unpublish. |
| Want it gone | `npm unpublish pkg@1.2.3` works only **within 72 hours** and only if nothing depends on it. After that, `deprecate` is the only tool. |
| Wrong package name | You cannot rename. Publish under the right name, deprecate the old one pointing at the new. |
| Version number burned | Bump and move on. It can never be reused. |

The pattern: **npm is append-only in practice.** Publish as though you cannot
take it back, because you cannot.

## 10. A pre-publish checklist

```bash
npm whoami                       # the right account
npm test                         # green
npm pack --dry-run               # read every line
git status --short               # clean
grep -r "sk-\|api_key\|SECRET" $(npm pack --dry-run --json | python3 -c "
import json,sys; print(' '.join(f['path'] for f in json.load(sys.stdin)[0]['files']))")
```

That last line greps the actual shipping file list for credential shapes. Cheap,
and it has caught real incidents.

---

# Part 2 — Apache License 2.0

## What it is, in one paragraph

Apache 2.0 is a **permissive** licence. Anyone may use, modify, distribute, and
sell software under it, including in closed-source commercial products, provided
they preserve your copyright and licence notices and state what they changed. In
exchange you disclaim warranty and liability, and you grant an explicit patent
licence.

It is the licence to choose when you want wide adoption *and* explicit patent
protection. MIT is simpler and shorter; Apache 2.0 does two things MIT does not.

## The two things Apache 2.0 gives you that MIT does not

**1. An express patent grant, with a retaliation clause (§3).**

Every contributor grants users a patent licence covering their contributions.
And critically: **if someone sues you claiming your software infringes their
patent, their licence to your software terminates automatically.** That is a
real deterrent, and it is the single strongest reason to pick Apache 2.0 over
MIT for anything that might matter commercially.

MIT is silent on patents. Silence is ambiguity, and ambiguity favours whoever
has more lawyers.

**2. An explicit trademark reservation (§6).**

The licence grants rights to the *code*, not to your names, logos, or marks.
Someone may fork your work; they may not imply you endorse their fork. MIT does
not say this, so you would be arguing from general trademark law instead of from
the licence.

## What it does NOT do

Be clear-eyed about this, because permissive licences are often oversold as
protection.

- **It does not stop commercial use.** Anyone may sell your software or build a
  paid product on it, without paying you or asking.
- **It does not require them to open their changes.** They may modify it and
  keep the modifications entirely private. If you want changes contributed back,
  you need a copyleft licence (GPL, AGPL) — a fundamentally different choice
  with different adoption consequences.
- **It does not protect an idea.** Licences cover expression. The design, the
  method, the architecture — those are patent or trade-secret territory, not
  copyright.
- **It does not protect you if you do not enforce it.** A licence is a legal
  instrument, not a technical control.

## Applying it correctly — three files, one field

**1. `LICENSE`** at the repository root: the full, unmodified Apache 2.0 text
from https://www.apache.org/licenses/LICENSE-2.0.txt. Do not edit it. Do not
paraphrase it. Modifying the text produces a licence that is no longer Apache
2.0 and that no compliance scanner will recognise.

```bash
curl -o LICENSE https://www.apache.org/licenses/LICENSE-2.0.txt
```

**2. `NOTICE`** at the root. Apache 2.0 §4(d) says that if you distribute a
NOTICE file, downstream redistributors must carry it forward. This is where your
attribution actually survives being vendored into somebody else's product.

```
AOSE Harness
Copyright 2026 Your Name

This product includes software developed at
<your project or organisation>.
```

Keep it short — attribution only. NOTICE is not a changelog and not a place for
extra terms.

**3. A per-file header.** The appendix to the licence recommends it, and it is
what makes a single copied file still traceable:

```ts
/*
 * Copyright 2026 Your Name
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
```

A short SPDX line is a widely accepted lighter alternative, and machine-readable:

```ts
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Your Name
```

**4. `package.json`:**

```json
{ "license": "Apache-2.0" }
```

The SPDX identifier exactly. This is what npm, GitHub, and every dependency
scanner read.

## What downstream users must do

Worth knowing, because it is what your licence actually buys you. Someone
redistributing your work must:

1. Include a copy of the licence.
2. State prominently that they changed files, if they did.
3. Preserve all copyright, patent, trademark and attribution notices from the
   source.
4. Include your NOTICE file contents, if you shipped one.

They do **not** have to publish their source, use the same licence, or tell you
they used it.

## Choosing between licences

| | MIT | Apache-2.0 | AGPL-3.0 |
|---|---|---|---|
| Length | ~170 words | ~10 pages | ~10 pages |
| Express patent grant | no | **yes** | yes |
| Patent retaliation | no | **yes** | yes |
| Trademark reserved | no | **yes** | yes |
| Changes must be stated | no | **yes** | yes |
| Changes must be published | no | no | **yes, including over a network** |
| Corporate adoption | easiest | easy | often blocked by policy |

**Apache 2.0 is the right default here.** It is permissive enough that companies
will adopt it without legal review friction, and it carries the patent clause,
which for a harness that might touch commercially interesting methods is the
part that matters.

One compatibility note: Apache 2.0 code cannot be included in a GPLv2 project.
It is compatible with GPLv3. This rarely matters, but it is the one
incompatibility worth remembering.

## Adding a contributor policy

If you accept pull requests, decide this early. Apache 2.0 §5 already states
that contributions are made under the licence unless explicitly stated
otherwise, which for most projects is sufficient. A separate CLA is heavier
machinery, needed mainly if you might relicense later. Add to `CONTRIBUTING.md`:

```markdown
## Licence

By contributing, you agree that your contributions are licensed under the
Apache License 2.0, per section 5 of that licence.
```

---

# Applying this to this repository

Concretely, before the first publish:

1. `LICENSE` at the root — verbatim Apache 2.0.
2. `NOTICE` at the root — copyright line and project name.
3. `"license": "Apache-2.0"` in every publishable `package.json`.
4. `"publishConfig": { "access": "public" }` in each, so the scoped-private trap
   cannot fire.
5. `"files"` in each — for `design-kg` that is `["src", "curated", "README.md"]`;
   the built `.db` should probably ship too, or the package is useless without a
   build step, which is a decision to make deliberately.
6. Root `package.json` keeps `"private": true`.
7. `npm pack --dry-run` on each, and read it.
8. Tarball install into a scratch directory, and import it.
9. Publish `design-kg` first, then anything that depends on it.

**None of the above is legal advice.** It is how these licences are conventionally
applied. If the stakes are commercial and material, have a lawyer read it.
