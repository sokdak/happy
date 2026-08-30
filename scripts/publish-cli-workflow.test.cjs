'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const workflowPath = path.resolve(__dirname, '../.github/workflows/publish-cli.yml');
const workflow = fs.readFileSync(workflowPath, 'utf8');

test('CLI publishing has only the intended automatic and manual triggers', () => {
  assert.match(workflow, /^on:\r?\n  push:/m);
  assert.match(workflow, /^    branches: \[main\]$/m);
  assert.match(workflow, /^      - 'npm-publish\/\*\*'$/m);
  assert.match(workflow, /^  workflow_dispatch:$/m);
  assert.doesNotMatch(workflow, /^  pull_request:|^  schedule:|^  release:/m);
});

test('CLI publishing uses read-only repository permissions and detached credentials', () => {
  assert.match(workflow, /^permissions:\r?\n  contents: read$/m);
  assert.match(workflow, /persist-credentials: false/);
  assert.doesNotMatch(workflow, /contents: write|packages: write|id-token: write/);
  assert.doesNotMatch(workflow, /uses: [^\r\n]+@v\d/);
});

test('workflow publishes only the scoped CLI tarball and never a wire or server package', () => {
  assert.match(workflow, /prepare-fork-cli-package\.cjs/);
  assert.match(workflow, /npm publish "\$TARBALL"/);
  assert.doesNotMatch(workflow, /pack(?:ages)?\/happy-server|--filter happy-server/);
  assert.doesNotMatch(workflow, /pack --pack-destination packages\/happy-wire/);
  assert.doesNotMatch(workflow, /@sokdak\/happy-wire/);
});

test('workflow gates upload on exact tarball verification and safely handles missing tokens and collisions', () => {
  assert.match(workflow, /verify-fork-cli-package\.cjs verify/);
  assert.match(workflow, /verify-fork-cli-package\.cjs smoke-install/);
  assert.match(workflow, /verify-fork-cli-package\.cjs compare/);
  assert.match(workflow, /verify-fork-cli-package\.cjs assert-promotion/);
  assert.match(workflow, /NPM_TOKEN is not configured; validating with a publish dry run/);
  assert.match(workflow, /--dry-run/);
  assert.doesNotMatch(workflow, /npm dist-tag add/);
  assert.match(workflow, /leaving registry state unchanged/);
  assert.match(workflow, /dist-tags\.\$DIST_TAG/);
  const promotion = workflow.slice(
    workflow.indexOf('- name: Validate monotonic dist-tag promotion'),
    workflow.indexOf('- name: Publish the tested tarball'),
  );
  assert.doesNotMatch(promotion, /npm view[^\r\n]+\|\| true/);
  assert.match(promotion, /E404\|404 Not Found/);
});

test('manual publishing is bound to main or the exact stable tag ref', () => {
  assert.match(workflow, /Manual main publishing must run from refs\/heads\/main/);
  assert.match(workflow, /Manual stable publishing must run from refs\/tags\/\$MANUAL_EXPECTED_VERSION/);
});

test('registry smoke does not receive the npm token', () => {
  const finalVerification = workflow.slice(workflow.indexOf('- name: Verify the exact registry version'));
  assert.doesNotMatch(finalVerification, /NODE_AUTH_TOKEN|NPM_TOKEN/);
  assert.match(finalVerification, /REGISTRY_EXPECTED/);
});
