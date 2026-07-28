# Fork Wire Publishing and Main History Cleanup Design

- **Date:** 2026-07-29
- **Repository:** `sokdak/happy`
- **Status:** Approved

## Goal

Fix the broken `@sokdak/happy@1.2.0-main.*` packages and rewrite the fork's
`main` history into four coherent commits on top of the latest
`upstream/main`.

## Root Cause

The `deploy-on-main` workflow builds `packages/happy-wire` locally before it
builds and tests the CLI. The CLI therefore passes CI against the current
workspace implementation.

The CLI bundle keeps `@slopus/happy-wire` external. During publication, pnpm
converts the CLI's `workspace:*` dependency to the workspace package version,
currently `0.1.0`. npm users then receive the previously published
`@slopus/happy-wire@0.1.0`, which does not export
`stripLeadingTaskNotificationWrappers`. Node fails while loading the CLI.

The fork cannot solve this by publishing a new `@slopus/happy-wire` version:
that npm package is owned outside the `@sokdak` scope.

## Considered Packaging Approaches

### Publish a fork wire package and use an npm alias — selected

Publish the workspace wire package as `@sokdak/happy-wire` with a unique
`0.1.0-main.<run_number>` version. Before publishing the CLI, replace its
runtime dependency with an exact alias:

```json
{
  "@slopus/happy-wire": "npm:@sokdak/happy-wire@0.1.0-main.<run_number>"
}
```

This keeps all existing source imports unchanged while ensuring that npm
installs the matching fork build at the module path expected by the bundle.

### Bundle happy-wire into the CLI

This avoids a second package publication, but changes the CLI's bundling and
export behavior. The wire package is intentionally shared and external today,
so this option has a larger regression surface.

### Wait for an upstream wire release

This leaves fork releases dependent on an independently owned npm package and
does not make `deploy-on-main` self-contained. It is unsuitable for automated
fork prereleases.

## Package Preparation

A small Node script will own all publication-only manifest changes. Given the
GitHub run number, it will:

1. Rename `@slopus/happy-wire` to `@sokdak/happy-wire`.
2. Set the wire version to `<wire-base>-main.<run_number>`.
3. Rename the CLI to `@sokdak/happy`.
4. Set the CLI version to `<cli-base>-main.<run_number>`.
5. Replace the CLI's `@slopus/happy-wire` dependency with an exact npm alias
   to the fork wire version.
6. Apply public npm publish configuration to both packages.

The script will expose testable functions and a command-line entry point. Its
tests will use temporary manifests and verify the names, versions, alias, and
preservation of unrelated fields.

## deploy-on-main Flow

The `publish-cli` job will retain its existing checkout, Node setup, pnpm
setup, and dependency installation. It will then:

1. Run the package-preparation script with `GITHUB_RUN_NUMBER`.
2. Publish `packages/happy-wire` with dist-tag `main`.
3. Publish `packages/happy-cli` with dist-tag `main`.
4. When `NPM_TOKEN` is configured, create a clean temporary project, install
   the exact CLI version from npm, and dynamically import `@sokdak/happy`.

The wire publication must complete before the CLI publication. A failure at
any step stops the job. When `NPM_TOKEN` is absent, both publish commands use
`--dry-run` and the registry installation smoke test is skipped because no
package versions were uploaded.

The smoke test reproduces the original failure boundary: npm dependency
resolution followed by Node ESM loading. Workspace unit tests alone cannot
cover this boundary.

## Main History Rewrite

The rewrite starts at the latest fetched `upstream/main`. The thirteen
fork-only commits currently reachable from `origin/main`, plus this fix, will
be reconstructed as four commits:

1. `feat(claude): align model, effort, and permission handling`
   - expose the relevant 1M Claude model variants in the app and Codium;
   - preserve session model, effort, and permission choices after aborts;
   - validate effort values during model changes;
   - align local and remote Claude permission handling;
   - remove Happy-specific commit attribution.
2. `feat(models): update Claude model defaults and aliases`
   - pin SDK-boundary aliases to explicit model IDs;
   - update the app and CLI model defaults and picker entries.
3. `fix(sync): refresh open chats after resume and reconnect`
   - retain the existing app resume, web refocus, and socket reconnect fix.
4. `ci: automate fork releases and deployments`
   - combine tagged CLI publishing and its documentation;
   - combine Android APK validation and release automation;
   - combine `deploy-on-main`, its design, server version gate, GHCR image,
     Helm pull request, fork wire publication, CLI aliasing, and npm smoke test.

Reordering is limited to placing related fork commits next to one another.
The resulting tree must retain every fork change and include the latest
upstream tree.

## Safety and Push

All work occurs in a separate worktree so the existing dirty checkout remains
untouched. Before rewriting the remote branch, record and re-check the current
`origin/main` object ID. Push with an explicit lease:

```text
git push --force-with-lease=main:<recorded-origin-main> origin <clean-head>:main
```

If `origin/main` changed after the recorded fetch, the push must fail rather
than overwrite the new work. No unconditional force push is allowed.

## Verification

Verification covers both the code change and history rewrite:

- observe the package-preparation regression test fail before implementation;
- run the focused test after implementation and the relevant CLI unit suite;
- build both wire and CLI packages;
- validate the workflow YAML and inspect packed manifests;
- install packed or published artifacts in an isolated directory and import
  the CLI entry point;
- confirm the rewritten branch is exactly four commits ahead of
  `upstream/main`;
- inspect each rewritten commit's files and message;
- compare the rewritten tree with the expected upstream-plus-fork tree so no
  existing fork changes disappear;
- fetch immediately before the force-with-lease push and verify the remote SHA
  still matches the recorded value;
- after the push, confirm `origin/main` equals the rewritten head and inspect
  the triggered `deploy-on-main` result.
