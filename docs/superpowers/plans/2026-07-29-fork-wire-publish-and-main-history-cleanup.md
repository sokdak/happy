# Fork Wire Publishing and Main History Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish a matching fork-owned happy-wire package with every main CLI prerelease, verify the installed npm package, and rewrite `main` into four coherent fork commits on the latest upstream base.

**Architecture:** A tested CommonJS helper rewrites the wire and CLI manifests to matching `-main.<run>` versions and uses an npm alias so existing `@slopus/happy-wire` imports resolve to `@sokdak/happy-wire`. `deploy-on-main` publishes wire before CLI and smoke-tests the exact registry version. After verification, the fork-only history is replayed onto `upstream/main`, grouped into four commits, tree-compared with the unsquashed rebase, and pushed with an explicit lease.

**Tech Stack:** Node.js 22, `node:test`, pnpm 10, npm package aliases, GitHub Actions YAML, Git rebase/cherry-pick, PowerShell.

---

### Task 1: Add a failing manifest-preparation regression test

**Files:**
- Create: `scripts/prepare-main-npm-packages.test.cjs`
- Create later: `scripts/prepare-main-npm-packages.cjs`

- [ ] **Step 1: Create the test before the implementation exists**

```js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, describe, it } = require('node:test');

const temporaryRoots = [];

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

describe('prepareMainNpmPackages', () => {
  afterEach(() => {
    for (const root of temporaryRoots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('prepares matching fork wire and CLI prereleases', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'happy-main-packages-'));
    temporaryRoots.push(root);
    const wirePath = path.join(root, 'packages', 'happy-wire', 'package.json');
    const cliPath = path.join(root, 'packages', 'happy-cli', 'package.json');

    writeJson(wirePath, {
      name: '@slopus/happy-wire',
      version: '0.1.0',
      dependencies: { zod: '^4.0.0' },
    });
    writeJson(cliPath, {
      name: 'happy',
      version: '1.2.0',
      dependencies: {
        '@slopus/happy-wire': 'workspace:*',
        chalk: '^5.6.2',
      },
    });

    const { prepareMainNpmPackages } = require('./prepare-main-npm-packages.cjs');
    const versions = prepareMainNpmPackages(root, '17');
    const wire = readJson(wirePath);
    const cli = readJson(cliPath);

    assert.deepEqual(versions, {
      wireVersion: '0.1.0-main.17',
      cliVersion: '1.2.0-main.17',
    });
    assert.equal(wire.name, '@sokdak/happy-wire');
    assert.equal(wire.version, versions.wireVersion);
    assert.deepEqual(wire.publishConfig, {
      registry: 'https://registry.npmjs.org',
      access: 'public',
    });
    assert.equal(cli.name, '@sokdak/happy');
    assert.equal(cli.version, versions.cliVersion);
    assert.equal(
      cli.dependencies['@slopus/happy-wire'],
      `npm:@sokdak/happy-wire@${versions.wireVersion}`,
    );
    assert.equal(cli.dependencies.chalk, '^5.6.2');
  });

  it('rejects a non-numeric run number without changing manifests', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'happy-main-packages-'));
    temporaryRoots.push(root);
    const wirePath = path.join(root, 'packages', 'happy-wire', 'package.json');
    const cliPath = path.join(root, 'packages', 'happy-cli', 'package.json');
    writeJson(wirePath, { name: '@slopus/happy-wire', version: '0.1.0' });
    writeJson(cliPath, {
      name: 'happy',
      version: '1.2.0',
      dependencies: { '@slopus/happy-wire': 'workspace:*' },
    });

    const { prepareMainNpmPackages } = require('./prepare-main-npm-packages.cjs');
    assert.throws(
      () => prepareMainNpmPackages(root, 'bad-run'),
      /positive integer/,
    );
    assert.equal(readJson(wirePath).name, '@slopus/happy-wire');
    assert.equal(readJson(cliPath).name, 'happy');
  });
});
```

- [ ] **Step 2: Run the test and verify the intended red state**

Run:

```powershell
node --test scripts/prepare-main-npm-packages.test.cjs
```

Expected: FAIL with `Cannot find module './prepare-main-npm-packages.cjs'`.

### Task 2: Implement package manifest preparation

**Files:**
- Create: `scripts/prepare-main-npm-packages.cjs`
- Test: `scripts/prepare-main-npm-packages.test.cjs`

- [ ] **Step 1: Add the minimal implementation**

```js
const fs = require('node:fs');
const path = require('node:path');

const PUBLISH_CONFIG = {
  registry: 'https://registry.npmjs.org',
  access: 'public',
};

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function normalizeRunNumber(runNumber) {
  const value = String(runNumber ?? '');
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error('GitHub run number must be a positive integer');
  }
  return value;
}

function prepareMainNpmPackages(rootDir, runNumber) {
  const normalizedRunNumber = normalizeRunNumber(runNumber);
  const wirePath = path.join(rootDir, 'packages', 'happy-wire', 'package.json');
  const cliPath = path.join(rootDir, 'packages', 'happy-cli', 'package.json');
  const wire = readJson(wirePath);
  const cli = readJson(cliPath);

  if (!cli.dependencies || !Object.hasOwn(cli.dependencies, '@slopus/happy-wire')) {
    throw new Error('CLI manifest is missing @slopus/happy-wire');
  }

  const wireVersion = `${wire.version}-main.${normalizedRunNumber}`;
  const cliVersion = `${cli.version}-main.${normalizedRunNumber}`;

  wire.name = '@sokdak/happy-wire';
  wire.version = wireVersion;
  wire.publishConfig = { ...PUBLISH_CONFIG };

  cli.name = '@sokdak/happy';
  cli.version = cliVersion;
  cli.publishConfig = { ...PUBLISH_CONFIG };
  cli.dependencies['@slopus/happy-wire'] = `npm:@sokdak/happy-wire@${wireVersion}`;

  writeJson(wirePath, wire);
  writeJson(cliPath, cli);

  return { wireVersion, cliVersion };
}

if (require.main === module) {
  const versions = prepareMainNpmPackages(
    process.cwd(),
    process.argv[2] ?? process.env.GITHUB_RUN_NUMBER,
  );
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(
      process.env.GITHUB_OUTPUT,
      `wire_version=${versions.wireVersion}\ncli_version=${versions.cliVersion}\n`,
    );
  }
  console.log(`prepared @sokdak/happy-wire@${versions.wireVersion}`);
  console.log(`prepared @sokdak/happy@${versions.cliVersion}`);
}

module.exports = { prepareMainNpmPackages };
```

- [ ] **Step 2: Run the focused test and verify green**

Run:

```powershell
node --test scripts/prepare-main-npm-packages.test.cjs
```

Expected: 2 tests pass, 0 fail.

### Task 3: Publish wire before CLI and smoke-test the registry install

**Files:**
- Modify: `.github/workflows/deploy-on-main.yml`
- Test: `scripts/prepare-main-npm-packages.test.cjs`

- [ ] **Step 1: Replace the inline CLI-only rename and publish steps**

After `pnpm install --frozen-lockfile`, use these steps:

```yaml
      - name: Test npm package preparation
        run: node --test scripts/prepare-main-npm-packages.test.cjs

      - name: Prepare fork package manifests
        id: packages
        run: node scripts/prepare-main-npm-packages.cjs "$GITHUB_RUN_NUMBER"

      # Each package's prepublishOnly runs its build and unit tests. The wire
      # must reach npm before the CLI version that aliases it is published.
      - name: Publish wire then CLI (dist-tag main; dry-run when NPM_TOKEN unset)
        id: publish
        env:
          NPM_TOKEN: ${{ secrets.NPM_TOKEN }}
        run: |
          if [ -n "$NPM_TOKEN" ]; then
            echo "//registry.npmjs.org/:_authToken=${NPM_TOKEN}" >> ~/.npmrc
            pnpm --dir packages/happy-wire publish --no-git-checks --tag main
            pnpm --dir packages/happy-cli publish --no-git-checks --tag main
            echo "published=true" >> "$GITHUB_OUTPUT"
          else
            echo "::warning::NPM_TOKEN not set — running dry-runs"
            pnpm --dir packages/happy-wire publish --no-git-checks --tag main --dry-run
            pnpm --dir packages/happy-cli publish --no-git-checks --tag main --dry-run
            echo "published=false" >> "$GITHUB_OUTPUT"
          fi

      - name: Smoke test published CLI
        if: steps.publish.outputs.published == 'true'
        env:
          CLI_VERSION: ${{ steps.packages.outputs.cli_version }}
        run: |
          SMOKE_DIR="$(mktemp -d)"
          trap 'rm -rf "$SMOKE_DIR"' EXIT
          cd "$SMOKE_DIR"
          npm init -y >/dev/null
          npm install "@sokdak/happy@${CLI_VERSION}"
          node -e "const pkg = require('./node_modules/@sokdak/happy/package.json'); if (pkg.dependencies['@slopus/happy-wire'] !== 'npm:@sokdak/happy-wire@${{ steps.packages.outputs.wire_version }}') process.exit(1)"
          node --input-type=module -e "await import('@sokdak/happy')"
```

- [ ] **Step 2: Verify the helper output against disposable manifest copies**

Run from a temporary copy of the two manifests so tracked files remain clean:

```powershell
$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("happy-package-prep-" + [guid]::NewGuid())
New-Item -ItemType Directory -Force -Path (Join-Path $testRoot 'packages/happy-wire'), (Join-Path $testRoot 'packages/happy-cli') | Out-Null
Copy-Item packages/happy-wire/package.json (Join-Path $testRoot 'packages/happy-wire/package.json')
Copy-Item packages/happy-cli/package.json (Join-Path $testRoot 'packages/happy-cli/package.json')
Push-Location $testRoot
node C:/Users/Administrator/Desktop/dev/happy-main-rewrite/scripts/prepare-main-npm-packages.cjs 999999
Pop-Location
Get-Content -Raw (Join-Path $testRoot 'packages/happy-wire/package.json')
Get-Content -Raw (Join-Path $testRoot 'packages/happy-cli/package.json')
Remove-Item -LiteralPath $testRoot -Recurse -Force
```

Expected: wire is `@sokdak/happy-wire@0.1.0-main.999999`; CLI is `@sokdak/happy@1.2.0-main.999999`; CLI contains the exact npm alias.

- [ ] **Step 3: Run relevant local verification**

Run:

```powershell
node --test scripts/prepare-main-npm-packages.test.cjs
pnpm --filter @slopus/happy-wire test
pnpm --filter happy exec vitest run --project unit
pnpm --filter happy build
npx --yes prettier@3.6.2 --check .github/workflows/deploy-on-main.yml
git diff --check
```

Expected: all commands exit 0.

- [ ] **Step 4: Commit the fix on the working branch**

```powershell
git add -- scripts/prepare-main-npm-packages.cjs scripts/prepare-main-npm-packages.test.cjs .github/workflows/deploy-on-main.yml docs/superpowers/specs/2026-07-29-fork-wire-publish-and-main-history-cleanup-design.md docs/superpowers/plans/2026-07-29-fork-wire-publish-and-main-history-cleanup.md
git commit -m "fix(ci): publish matching fork wire package"
```

### Task 4: Rebase all fork changes onto current upstream

**Files:**
- No new file changes; Git history only.

- [ ] **Step 1: Refresh remote refs and record safety anchors**

```powershell
git fetch origin main
git fetch upstream main
$expectedOriginMain = git rev-parse origin/main
$forkBase = git merge-base origin/main upstream/main
git branch backup/origin-main-before-cleanup $expectedOriginMain
```

Expected before rewriting: `$expectedOriginMain` is the remote main being replaced, and the backup branch points to it.

- [ ] **Step 2: Rebase the complete working branch**

```powershell
git rebase --onto upstream/main $forkBase rewrite/main-cleanup
```

Resolve conflicts by preserving both the latest upstream changes and the fork behavior described in the design. Continue with `git rebase --continue`, then run:

```powershell
git rev-list --count upstream/main..rewrite/main-cleanup
git status --short
```

Expected: all fork commits plus the design/fix commits are above upstream and the worktree is clean.

- [ ] **Step 3: Record the unsquashed reference for tree comparison**

```powershell
git branch backup/rebased-main-unsquashed rewrite/main-cleanup
```

### Task 5: Reconstruct four coherent commits

**Files:**
- Existing files are grouped without changing the final tree.

- [ ] **Step 1: Create the final branch at upstream**

```powershell
git switch -c rewrite/main-final upstream/main
```

- [ ] **Step 2: Apply and commit the Claude behavior group**

Locate and apply the rebased commit by its unique subject:

```powershell
$claudeCommit = git log backup/rebased-main-unsquashed --format='%H' --grep='^feat: refresh antigravity Claude support$' -1
if (-not $claudeCommit) { throw 'Claude behavior commit not found' }
git cherry-pick --no-commit $claudeCommit
```

Then commit:

```text
feat(claude): align model, effort, and permission handling

- expose 1M model variants across the app and Codium
- preserve session mode selections after aborts
- validate effort values when switching models
- align local and remote permission behavior
- remove Happy-specific commit attribution
```

- [ ] **Step 3: Apply and commit the model group**

Apply the two rebased model commits in dependency order:

```powershell
$modelAliasCommit = git log backup/rebased-main-unsquashed --format='%H' --grep='^fix(cli): pin Claude model aliases to explicit ids at SDK boundary$' -1
$modelDefaultsCommit = git log backup/rebased-main-unsquashed --format='%H' --grep='^feat(models): default to Opus 5 / Sonnet 5, drop 4.8/4.6 picker entries$' -1
if (-not $modelAliasCommit -or -not $modelDefaultsCommit) { throw 'Model commits not found' }
git cherry-pick --no-commit $modelAliasCommit
git cherry-pick --no-commit $modelDefaultsCommit
```

Then commit:

```text
feat(models): update Claude model defaults and aliases
```

- [ ] **Step 4: Apply and commit the sync group**

Apply the rebased sync commit:

```powershell
$syncCommit = git log backup/rebased-main-unsquashed --format='%H' --grep='^fix(sync): refresh open chat on app resume, web refocus, and socket reconnect$' -1
if (-not $syncCommit) { throw 'Sync commit not found' }
git cherry-pick --no-commit $syncCommit
```

Then commit:

```text
fix(sync): refresh open chats after resume and reconnect
```

- [ ] **Step 5: Apply and commit every CI/documentation group**

Apply all remaining CI and documentation commits in their original order:

```powershell
$ciSubjects = @(
  'ci: add npm publish workflow for @sokdak/happy CLI',
  'docs: document @sokdak/happy as this fork''s npm package',
  'ci: publish Android APK release assets',
  'ci: validate Android APKs in pull requests',
  'ci: set up Android SDK before APK build',
  'docs: spec for deploy-on-main image/npm/helm workflow',
  'docs: note concurrency prerelease-skip trade-off in deploy-on-main spec',
  'ci: build image to GHCR + npm prereleases + happy-helm bump PR on merge to main',
  'ci: gate publish-server on version bump (skip build when version unchanged)',
  'docs: design fork wire publishing and main cleanup',
  'fix(ci): publish matching fork wire package'
)
foreach ($subject in $ciSubjects) {
  $sha = git log backup/rebased-main-unsquashed --format='%H%x09%s' |
    ForEach-Object {
      $parts = $_ -split "`t", 2
      if ($parts[1] -eq $subject) { $parts[0] }
    } |
    Select-Object -First 1
  if (-not $sha) { throw "CI commit not found: $subject" }
  git cherry-pick --no-commit $sha
}
```

These commits include tagged CLI publishing, fork release docs, Android APK CI, both deploy-on-main design documents, deploy-on-main implementation, server gating, the package-preparation plan, and the matching wire fix. Commit them as:

```text
ci: automate fork releases and deployments
```

- [ ] **Step 6: Prove the squash did not alter the tree**

```powershell
git diff --exit-code backup/rebased-main-unsquashed rewrite/main-final
git rev-list --count upstream/main..rewrite/main-final
git log --reverse --format='%h %s' upstream/main..rewrite/main-final
```

Expected: no diff, count `4`, and exactly the four approved subjects in order.

### Task 6: Verify and rewrite origin/main safely

**Files:**
- No file changes unless verification reveals a defect; any CI correction is amended into the fourth commit.

- [ ] **Step 1: Run the full relevant verification on the final branch**

```powershell
node --test scripts/prepare-main-npm-packages.test.cjs
pnpm --filter @slopus/happy-wire test
pnpm --filter happy exec vitest run --project unit
pnpm --filter happy build
npx --yes prettier@3.6.2 --check .github/workflows/deploy-on-main.yml
git diff --check upstream/main...HEAD
git status --short
```

Expected: all commands exit 0 and the worktree is clean.

- [ ] **Step 2: Re-check the lease immediately before pushing**

```powershell
git fetch origin main
$actualOriginMain = git rev-parse origin/main
if ($actualOriginMain -ne $expectedOriginMain) { throw "origin/main changed: $actualOriginMain" }
```

Expected: the fetched SHA still equals the recorded pre-rewrite SHA.

- [ ] **Step 3: Force-push with the explicit lease**

```powershell
git push --force-with-lease=main:$expectedOriginMain origin rewrite/main-final:main
```

Expected: the remote accepts the non-fast-forward update without overriding any unobserved remote commit.

- [ ] **Step 4: Confirm remote history and monitor deploy-on-main**

```powershell
git fetch origin main
if ((git rev-parse origin/main) -ne (git rev-parse rewrite/main-final)) { throw 'origin/main does not match rewritten head' }
gh run list -R sokdak/happy --workflow deploy-on-main --branch main --limit 1 --json databaseId,headSha,status,conclusion,url
```

Wait for the run matching the rewritten head. Inspect its jobs and logs. Success requires the wire publish, CLI publish, and installed-package smoke test to pass.

- [ ] **Step 5: Repair a CI defect by amending the CI commit**

If the new run exposes a defect in CI-only files, switch to `rewrite/main-final`, make the test-first correction, and amend the fourth commit:

```powershell
git add -- .github/workflows/deploy-on-main.yml scripts/prepare-main-npm-packages.cjs scripts/prepare-main-npm-packages.test.cjs docs/superpowers/specs/2026-07-29-fork-wire-publish-and-main-history-cleanup-design.md docs/superpowers/plans/2026-07-29-fork-wire-publish-and-main-history-cleanup.md
git commit --amend --no-edit
git fetch origin main
$failedHead = git rev-parse origin/main
git push --force-with-lease=main:$failedHead origin rewrite/main-final:main
```

Repeat verification and workflow monitoring. A behavior change that cannot be absorbed into the CI commit must be committed separately with a subject describing that behavior, as required by the user.
