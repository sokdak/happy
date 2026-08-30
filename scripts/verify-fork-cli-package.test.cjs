'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');

const {
  assertDistTagPromotion,
  comparePackageTarballs,
  withoutRegistryCredentials,
  verifyForkCliTarball,
} = require('./verify-fork-cli-package.cjs');

test('only advances main and latest dist-tags monotonically', () => {
  assert.doesNotThrow(() => assertDistTagPromotion(
    'main',
    '1.2.2-main.43.sha.aaaaaaaaaaaa',
    '1.2.2-main.42.sha.bbbbbbbbbbbb',
  ));
  assert.doesNotThrow(() => assertDistTagPromotion('latest', '1.2.2', '1.2.2-beta.3'));
  assert.doesNotThrow(() => assertDistTagPromotion('latest', '1.3.0', '1.2.9'));
  assert.throws(
    () => assertDistTagPromotion(
      'main',
      '1.2.2-main.41.sha.aaaaaaaaaaaa',
      '1.2.2-main.42.sha.bbbbbbbbbbbb',
    ),
    /Refusing to move dist-tag main backward/,
  );
  assert.throws(
    () => assertDistTagPromotion('latest', '1.2.1', '1.2.2'),
    /Refusing to move dist-tag latest backward/,
  );
});

test('removes registry credentials before install or package execution', () => {
  const sanitized = withoutRegistryCredentials({
    PATH: '/bin',
    NODE_AUTH_TOKEN: 'node-secret',
    NPM_TOKEN: 'npm-secret',
    npm_config_auth: 'basic-secret',
    NPM_CONFIG_FOO_TOKEN: 'config-secret',
    YARN_NPM_AUTH_TOKEN: 'yarn-secret',
    SAFE_VALUE: 'kept',
  });

  assert.deepEqual(sanitized, {
    PATH: '/bin',
    SAFE_VALUE: 'kept',
  });
});

function makeTarball(t, options = {}) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'happy-cli-verify-test-'));
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  const packageDir = path.join(temporaryRoot, 'package');
  const distDir = path.join(packageDir, 'dist');
  const binDir = path.join(packageDir, 'bin');
  fs.mkdirSync(distDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  const manifest = {
    name: '@sokdak/happy',
    version: '1.2.2-main.7.sha.0123456789ab',
    bin: { happy: './bin/happy.mjs' },
    dependencies: { chalk: '^5.0.0' },
    devDependencies: { '@slopus/happy-wire': 'workspace:*' },
    publishConfig: { registry: 'https://registry.npmjs.org', access: 'public' },
    ...options.manifest,
  };
  fs.writeFileSync(path.join(packageDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(
    path.join(distDir, 'index.mjs'),
    options.runtime ?? 'function createEnvelope() {}\nexport { createEnvelope };\n',
  );
  fs.writeFileSync(path.join(binDir, 'happy.mjs'), 'console.log("happy version: test");\n');
  if (options.runtimeMode) {
    fs.chmodSync(path.join(distDir, 'index.mjs'), options.runtimeMode);
  }
  if (options.symlink) {
    fs.symlinkSync('index.mjs', path.join(distDir, 'linked.mjs'), 'file');
  }
  if (options.extraFile) {
    fs.writeFileSync(path.join(distDir, 'extra.cjs'), options.extraFile);
  }
  const tarballPath = path.join(temporaryRoot, options.tarballName ?? 'package.tgz');
  execFileSync('tar', ['-czf', tarballPath, '-C', temporaryRoot, 'package']);
  return tarballPath;
}

test('verifies a scoped CLI tarball with bundled wire code', (t) => {
  const tarball = makeTarball(t);
  const result = verifyForkCliTarball(tarball, '1.2.2-main.7.sha.0123456789ab');

  assert.equal(result.manifest.name, '@sokdak/happy');
  assert.equal(result.runtimeFiles.length, 2);
});

test('rejects runtime wire dependencies and surviving imports', (t) => {
  const dependencyTarball = makeTarball(t, {
    tarballName: 'dependency.tgz',
    manifest: { dependencies: { '@slopus/happy-wire': '0.1.0' } },
  });
  assert.throws(
    () => verifyForkCliTarball(dependencyTarball, '1.2.2-main.7.sha.0123456789ab'),
    /runtime happy-wire dependency/,
  );

  const importTarball = makeTarball(t, {
    tarballName: 'import.tgz',
    runtime: 'import { createEnvelope } from "@slopus/happy-wire";\n',
  });
  assert.throws(
    () => verifyForkCliTarball(importTarball, '1.2.2-main.7.sha.0123456789ab'),
    /external happy-wire import/,
  );
});

test('accepts an identical registry tarball and rejects a version collision', (t) => {
  const localTarball = makeTarball(t, { tarballName: 'local.tgz' });
  const identicalTarball = makeTarball(t, { tarballName: 'identical.tgz' });
  const changedTarball = makeTarball(t, {
    tarballName: 'changed.tgz',
    extraFile: 'module.exports = "different";\n',
  });

  assert.ok(comparePackageTarballs(localTarball, identicalTarball).fileCount > 0);
  assert.throws(
    () => comparePackageTarballs(localTarball, changedTarball),
    /Registry version collision/,
  );
});

test('rejects symbolic links before extracting a package tarball', (t) => {
  let linkedTarball;
  try {
    linkedTarball = makeTarball(t, { tarballName: 'linked.tgz', symlink: true });
  } catch (error) {
    if (process.platform === 'win32' && error?.code === 'EPERM') {
      t.skip('creating symlinks requires Windows developer mode');
      return;
    }
    throw error;
  }

  assert.throws(
    () => verifyForkCliTarball(linkedTarball, '1.2.2-main.7.sha.0123456789ab'),
    /forbidden link or special entry/,
  );
});

test('treats executable mode changes as an immutable version collision', { skip: process.platform === 'win32' }, (t) => {
  const regularTarball = makeTarball(t, { tarballName: 'regular-mode.tgz', runtimeMode: 0o644 });
  const executableTarball = makeTarball(t, { tarballName: 'executable-mode.tgz', runtimeMode: 0o755 });

  assert.throws(
    () => comparePackageTarballs(regularTarball, executableTarball),
    /Registry version collision/,
  );
});
