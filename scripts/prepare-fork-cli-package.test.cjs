'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  FORK_PACKAGE_NAME,
  PUBLISH_CONFIG,
  prepareForkCliPackage,
} = require('./prepare-fork-cli-package.cjs');

const realManifestPath = path.resolve(__dirname, '../packages/happy-cli/package.json');
const realManifest = JSON.parse(fs.readFileSync(realManifestPath, 'utf8'));

function fixture(t, mutate = () => {}) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happy-fork-cli-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const manifestPath = path.join(rootDir, 'packages', 'happy-cli', 'package.json');
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  const manifest = structuredClone(realManifest);
  mutate(manifest);
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { rootDir, manifestPath };
}

function readManifest(manifestPath) {
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
}

test('prepares a unique SHA-coupled main prerelease from the real CLI manifest', (t) => {
  const { rootDir, manifestPath } = fixture(t);
  const result = prepareForkCliPackage({
    rootDir,
    mode: 'main',
    runNumber: '42',
    sourceSha: '0123456789abcdef0123456789abcdef01234567',
  });
  const prepared = readManifest(manifestPath);

  assert.deepEqual(result, {
    mode: 'main',
    packageName: FORK_PACKAGE_NAME,
    version: `${realManifest.version}-main.42.sha.0123456789ab`,
    distTag: 'main',
  });
  assert.equal(prepared.name, FORK_PACKAGE_NAME);
  assert.equal(prepared.version, result.version);
  assert.deepEqual(prepared.publishConfig, PUBLISH_CONFIG);
  assert.equal(prepared.devDependencies['@slopus/happy-wire'], 'workspace:*');
  assert.equal(prepared.dependencies?.['@slopus/happy-wire'], undefined);
  assert.equal(JSON.stringify(prepared).includes('@sokdak/happy-wire'), false);
});

test('prepares an exact stable version and reserves latest for that path', (t) => {
  const { rootDir, manifestPath } = fixture(t);
  const result = prepareForkCliPackage({
    rootDir,
    mode: 'stable',
    expectedVersion: `npm-publish/${realManifest.version}`,
  });

  assert.equal(result.version, realManifest.version);
  assert.equal(result.distTag, 'latest');
  assert.equal(readManifest(manifestPath).version, realManifest.version);
});

test('rejects a mismatched stable tag before changing the manifest', (t) => {
  const { rootDir, manifestPath } = fixture(t);
  const before = fs.readFileSync(manifestPath, 'utf8');

  assert.throws(
    () => prepareForkCliPackage({
      rootDir,
      mode: 'stable',
      expectedVersion: 'npm-publish/9.9.9',
    }),
    /Release version mismatch/,
  );
  assert.equal(fs.readFileSync(manifestPath, 'utf8'), before);
});

test('rejects a bare stable version even when it matches the manifest', (t) => {
  const { rootDir, manifestPath } = fixture(t);
  const before = fs.readFileSync(manifestPath, 'utf8');

  assert.throws(
    () => prepareForkCliPackage({
      rootDir,
      mode: 'stable',
      expectedVersion: realManifest.version,
    }),
    /full npm-publish/,
  );
  assert.equal(fs.readFileSync(manifestPath, 'utf8'), before);
});

test('rejects missing or runtime happy-wire dependencies', (t) => {
  const missing = fixture(t, (manifest) => {
    delete manifest.devDependencies['@slopus/happy-wire'];
  });
  assert.throws(
    () => prepareForkCliPackage({
      rootDir: missing.rootDir,
      mode: 'main',
      runNumber: 1,
      sourceSha: 'a'.repeat(40),
    }),
    /must contain.*workspace:\*/,
  );

  const runtime = fixture(t, (manifest) => {
    manifest.dependencies['@slopus/happy-wire'] = '0.1.0';
  });
  assert.throws(
    () => prepareForkCliPackage({
      rootDir: runtime.rootDir,
      mode: 'main',
      runNumber: 1,
      sourceSha: 'b'.repeat(40),
    }),
    /must remain bundled.*not declared in dependencies/,
  );
});

test('rejects a fork wire alias and invalid main identifiers', (t) => {
  const aliased = fixture(t, (manifest) => {
    manifest.devDependencies['@slopus/happy-wire'] = 'npm:@sokdak/happy-wire@0.1.0';
  });
  assert.throws(
    () => prepareForkCliPackage({
      rootDir: aliased.rootDir,
      mode: 'main',
      runNumber: 1,
      sourceSha: 'c'.repeat(40),
    }),
    /workspace:\*/,
  );

  const invalid = fixture(t);
  assert.throws(
    () => prepareForkCliPackage({
      rootDir: invalid.rootDir,
      mode: 'main',
      runNumber: 'zero',
      sourceSha: 'not-a-sha',
    }),
    /positive integer/,
  );
});
