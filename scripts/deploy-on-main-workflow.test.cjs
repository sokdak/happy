const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { describe, it } = require("node:test");

const workflow = fs.readFileSync(
  path.join(__dirname, "..", ".github", "workflows", "deploy-on-main.yml"),
  "utf8",
);

describe("deploy-on-main workflow", () => {
  it("uses an immutable image tag for each commit", () => {
    assert.match(
      workflow,
      /tag=\$\(date -u \+%Y\.%m\.%d\)-\$\{GITHUB_RUN_NUMBER\}-\$\{GITHUB_SHA::12\}/,
    );
  });

  it("can resume after either npm package was already published", () => {
    assert.match(
      workflow,
      /publish_if_missing "@sokdak\/happy-wire" "\$WIRE_VERSION" "packages\/happy-wire"/,
    );
    assert.match(
      workflow,
      /publish_if_missing "@sokdak\/happy" "\$CLI_VERSION" "packages\/happy-cli"/,
    );
    assert.match(
      workflow,
      /npm view "\$\{package_name\}@\$\{package_version\}" version/,
    );
  });

  it("runs pnpm publish from each package directory", () => {
    assert.doesNotMatch(workflow, /pnpm --dir .* publish/);
    assert.match(
      workflow,
      /\(cd "\$package_dir" && pnpm publish --no-git-checks --tag main\)/,
    );
    assert.match(
      workflow,
      /\(cd packages\/happy-wire && pnpm publish --no-git-checks --tag main --dry-run\)/,
    );
    assert.match(
      workflow,
      /\(cd packages\/happy-cli && pnpm publish --no-git-checks --tag main --dry-run\)/,
    );
  });

  it("moves both main and latest to each exact published package version", () => {
    assert.match(
      workflow,
      /npm dist-tag add "\$\{package_name\}@\$\{package_version\}" main/,
    );
    assert.match(
      workflow,
      /npm dist-tag add "\$\{package_name\}@\$\{package_version\}" latest/,
    );
  });

  it("waits for both packages to propagate before the install smoke test", () => {
    assert.match(
      workflow,
      /wait_for_npm_version "@sokdak\/happy-wire" "\$WIRE_VERSION"/,
    );
    assert.match(
      workflow,
      /wait_for_npm_version "@sokdak\/happy" "\$CLI_VERSION"/,
    );
    assert.match(
      workflow,
      /npm view "\$\{package_name\}@\$\{package_version\}" version --prefer-online/,
    );
  });

  it("smoke tests an untagged install and verifies the deployed CLI version", () => {
    assert.match(workflow, /npm install --prefer-online "@sokdak\/happy"/);
    assert.doesNotMatch(
      workflow,
      /npm install --prefer-online "@sokdak\/happy@\$\{CLI_VERSION\}"/,
    );
    assert.match(workflow, /pkg\.version !== process\.env\.CLI_VERSION/);
  });

  it("installs a pinned and checksummed yq without persisting the Helm token", () => {
    assert.match(workflow, /persist-credentials: false/);
    assert.match(workflow, /YQ_VERSION="v4\.53\.3"/);
    assert.match(
      workflow,
      /YQ_SHA256="fa52a4e758c63d38299163fbdd1edfb4c4963247918bf9c1c5d31d84789eded4"/,
    );
    assert.doesNotMatch(workflow, /mikefarah\/yq\/releases\/latest/);
  });
});
