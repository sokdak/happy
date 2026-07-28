# Design: Deploy-on-main — GHCR image + npm prereleases + happy-helm bump PR

- **Date:** 2026-07-28
- **Repo:** `sokdak/happy` (fork of `slopus/happy`)
- **Status:** Approved (design), pending implementation plan

## Goal

On every merge to `main` in `sokdak/happy`, automatically:

1. Build the deployable **container image** and push it to **GHCR**.
2. Build and publish two **npm packages** to **npmjs** as unique prereleases.
3. Open a **pull request** on `sokdak/happy-helm` that bumps the image reference.

This replaces today's manual flow (happy-helm's `build-image.yml` is `workflow_dispatch`, and `values.yaml` / `docker/build.sh` are hand-edited).

## Background (current reality)

`sokdak/happy-helm` deploys a **single combined arm64 image** — `docker.io/sokdak/happy:<tag>` (mirrored to `ghcr.io/sokdak/happy`). Key facts discovered:

- The image is built by happy-helm's own `docker/Dockerfile`, which **clones `sokdak/happy` at a pinned `HAPPY_REF` SHA** (shallow fetch by SHA), builds the Expo web UI + standalone `happy-server`, and ships a slim `node:20-slim` runtime that serves both api and fe from one image.
- `happy-helm/values.yaml`: `image.repository: docker.io/sokdak/happy`, `image.tag: latest` (overridden per release, date-based e.g. `2026.06.03`), `nodeArch: arm64`.
- `happy-helm/docker/build.sh`: `HAPPY_REF` (pinned SHA), `IMAGE=docker.io/sokdak/happy`, `PLATFORM=linux/arm64`.
- `happy-helm/Chart.yaml`: `appVersion` tracks the pinned happy release.
- `happy-helm/.github/workflows/build-image.yml`: `workflow_dispatch`, builds on `ubuntu-24.04-arm`, pushes to `ghcr.io/<owner>/happy` (via `GITHUB_TOKEN`) and `docker.io/sokdak/happy` (via `DOCKERHUB_*` secrets).
- Secrets: `happy-helm` has `DOCKERHUB_USERNAME` + `DOCKERHUB_TOKEN`. `sokdak/happy` (this repo) has only `NPM_TOKEN`.
- Existing `sokdak/happy` workflow `publish-cli.yml`: on tag `npm-publish/**`, renames `packages/happy-cli` → `@sokdak/happy` and publishes to npmjs (stable `latest`).

## Decisions (locked)

| Topic | Decision |
|---|---|
| Image registry | **GHCR only** — `ghcr.io/sokdak/happy` |
| Image build definition | **Reuse happy-helm's `docker/Dockerfile`**, built at the merged SHA (zero drift vs deployed image) |
| Image tag scheme | **Date only** — `YYYY.MM.DD` (+ `latest`) |
| npm packages | **Both**: CLI (`packages/happy-cli`) and server (`packages/happy-server`) |
| npm versioning | **Prerelease per merge** — never collides |
| happy-helm PR auth | **PAT secret** `HELM_REPO_TOKEN` in this repo |

## Design

A single workflow, `.github/workflows/deploy-on-main.yml`.

**Trigger:** `push` to `main`, plus `workflow_dispatch` for manual re-runs.
**Concurrency:** group `deploy-on-main`, `cancel-in-progress: true` — a newer merge supersedes an in-flight run so no stale helm PR is opened. Trade-off: a rapid follow-up merge may cancel an in-flight run before its npm prerelease publishes; skipping an intermediate prerelease is acceptable (only the newest merge needs to ship).

### Job 1 — `image` (build & push to GHCR)

- **Runner:** `ubuntu-24.04-arm` (image is arm64-only).
- **Permissions:** `contents: read`, `packages: write`.
- **Steps:**
  1. Resolve tag: `TAG=$(date -u +%Y.%m.%d)`; capture `SHA=${{ github.sha }}`.
  2. `actions/checkout` of `sokdak/happy-helm` (public repo) into a subdir to obtain its `docker/` build context.
  3. `docker/setup-buildx-action`.
  4. `docker/login-action` → `ghcr.io` with `username: ${{ github.actor }}`, `password: ${{ secrets.GITHUB_TOKEN }}`.
  5. `docker/build-push-action`:
     - `context: <happy-helm>/docker`
     - `platforms: linux/arm64`
     - `push: true`
     - `build-args: HAPPY_REPO=https://github.com/sokdak/happy.git`, `HAPPY_REF=${{ github.sha }}`
     - `tags: ghcr.io/sokdak/happy:${TAG}`, `ghcr.io/sokdak/happy:latest`
- **Outputs:** `tag`, `sha` (consumed by Job 3).

Rationale: the Dockerfile clones happy@`HAPPY_REF` itself, so passing `HAPPY_REF=${{ github.sha }}` yields an image containing exactly the merged commit — no dependence on this repo's own Dockerfiles.

### Job 2 — `npm` (publish prereleases to npmjs)

- **Runner:** `ubuntu-latest`. **Independent** of Jobs 1/3 (runs in parallel).
- **Setup:** `actions/setup-node@v4` (node 22), `corepack enable`, `pnpm install --frozen-lockfile`.
- **Auth:** write `//registry.npmjs.org/:_authToken=${NPM_TOKEN}` to `~/.npmrc`.
- **For each package**, mutate `package.json` (via a small node script), then `pnpm --filter <pkg> publish --no-git-checks --tag main`:
  - **CLI** — `packages/happy-cli`: name → `@sokdak/happy`; version → `<base>-main.<run_number>`; `publishConfig = { registry: https://registry.npmjs.org, access: public }`.
  - **Server** — `packages/happy-server`: name → `@sokdak/happy-server-self-host` (scoped — the unscoped `happy-server-self-host` is owned upstream and would 403); version → `<base>-main.<run_number>`; same `publishConfig`.
- **Dist-tag `main`** (not `latest`) so ordinary `npm install` stays on the stable release; prereleases are opt-in via `@main`.
- `prepublishOnly`/build hooks run automatically during `pnpm publish` (packages build/test themselves).

### Job 3 — `helm-pr` (bump happy-helm, open PR)

- **Runner:** `ubuntu-latest`. **`needs: image`** (image must exist before the reference is bumped).
- **Auth:** `HELM_REPO_TOKEN` (PAT with write to `sokdak/happy-helm`).
- **Steps:**
  1. `actions/checkout` of `sokdak/happy-helm` with `token: ${{ secrets.HELM_REPO_TOKEN }}`.
  2. Edit files (prefer `yq` for YAML; anchored `sed` for the shell script):
     - `values.yaml`: `image.repository` → `ghcr.io/sokdak/happy`; `image.tag` → `<tag>`.
     - `docker/build.sh`: default `HAPPY_REF` → `<sha>`; default `IMAGE` → `ghcr.io/sokdak/happy`.
     - `Chart.yaml`: `appVersion` → `<tag>`.
  3. `peter-evans/create-pull-request`:
     - branch `bump-image-<tag>-<sha7>`
     - title/body describing the new image tag + source SHA + run link
- Chart `version` (chart semver) is **not** bumped by default — happy-helm is consumed from git by ArgoCD (`examples/argocd-application.yaml`), which re-renders on values change. (Revisit if the chart is ever packaged to a Helm repo.)
- The PR always has a diff because `HAPPY_REF` (= `github.sha`) changes on every merge, even when the date tag is unchanged for same-day merges.

## Required manual setup (out of the workflow's control)

1. **`HELM_REPO_TOKEN`** — PAT with write access to `sokdak/happy-helm`, added as an Actions secret in `sokdak/happy`. *Blocking for Job 3.*
2. **GHCR package visibility** — after the first push, set the `ghcr.io/sokdak/happy` package to **public**, or add an `imagePullSecret` to the chart. `values.yaml` currently assumes a public registry. *Blocking for the cluster to pull.*
3. **npm scope ownership** — `NPM_TOKEN` must own the `@sokdak` scope (already true; it publishes `@sokdak/happy`). ✓

## Open items to verify during implementation

- **`packages/happy-server` npm-pack readiness** — confirm it produces a valid `npm pack` (correct `files`/`bin`/build) under the scoped rename. If not set up for packaging, a small `package.json` (`files`) or build tweak may be needed. `happy-cli` is already proven (published today).
- **`yq` availability** on the runner — install the mikefarah binary in Job 3 if not preinstalled.

## Relationship to existing workflows

- `publish-cli.yml` (tag-triggered, stable `latest` for `@sokdak/happy`) is **left intact**. The new merge-based publish uses the `main` dist-tag and prerelease versions, so the two never collide.
- happy-helm's `build-image.yml` (manual `workflow_dispatch`) stays as a manual fallback.

## Out of scope

- Docker Hub push (registry choice is GHCR-only).
- Automatic GHCR package publicization / pull-secret provisioning.
- Chart `version` bumps and Helm-repo packaging.
- Multi-arch (amd64) images — arm64-only, matching the current deployment.
