const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');

const workflow = fs.readFileSync(
  path.join(__dirname, '..', '.github', 'workflows', 'deploy-on-main.yml'),
  'utf8',
);

describe('deploy-on-main workflow', () => {
  it('runs for main and creates a commit-unique image tag', () => {
    assert.match(workflow, /push:\r?\n    branches: \[main\]/);
    assert.match(
      workflow,
      /tag=\$\(date -u \+%Y\.%m\.%d\)-\$\{GITHUB_RUN_NUMBER\}-\$\{GITHUB_SHA::12\}/,
    );
    assert.match(workflow, /HAPPY_REF=\$\{\{ github\.sha \}\}/);
  });

  it('grants package write only to the image job', () => {
    assert.match(workflow, /permissions:\r?\n  contents: read/);
    assert.equal((workflow.match(/packages: write/g) || []).length, 1);
    assert.doesNotMatch(workflow, /contents: write/);
  });

  it('pushes GHCR and opens a Helm PR for the same image metadata', () => {
    assert.match(workflow, /ghcr\.io\/sokdak\/happy:\$\{\{ steps\.meta\.outputs\.tag \}\}/);
    assert.match(workflow, /needs: image/);
    assert.match(workflow, /\.image\.tag = strenv\(TAG\)/);
    assert.match(workflow, /\.appVersion = strenv\(TAG\)/);
    assert.match(workflow, /HAPPY_REF=.*SHA/);
    assert.match(workflow, /peter-evans\/create-pull-request@v7/);
  });

  it('pins and verifies yq without persisting Helm credentials', () => {
    assert.match(workflow, /persist-credentials: false/);
    assert.match(workflow, /YQ_VERSION="v4\.53\.3"/);
    assert.match(
      workflow,
      /YQ_SHA256="fa52a4e758c63d38299163fbdd1edfb4c4963247918bf9c1c5d31d84789eded4"/,
    );
    assert.doesNotMatch(workflow, /releases\/latest/);
  });

  it('does not publish fork wire, server, or npm packages', () => {
    assert.doesNotMatch(workflow, /happy-wire|publish-server|npm publish|pnpm publish/);
  });
});
