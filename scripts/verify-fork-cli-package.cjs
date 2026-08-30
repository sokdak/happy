'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const tar = require('tar');

const FORK_PACKAGE_NAME = '@sokdak/happy';
const WIRE_PACKAGE_NAMES = ['@slopus/happy-wire', '@sokdak/happy-wire'];
const RUNTIME_EXTENSIONS = new Set(['.js', '.cjs', '.mjs']);

function withoutRegistryCredentials(sourceEnvironment = process.env) {
  const environment = { ...sourceEnvironment };
  const exactCredentialKeys = new Set([
    'NODE_AUTH_TOKEN',
    'NPM_TOKEN',
    'COREPACK_NPM_TOKEN',
    'YARN_NPM_AUTH_TOKEN',
    'YARN_NPM_AUTH_IDENT',
  ]);
  for (const key of Object.keys(environment)) {
    if (
      exactCredentialKeys.has(key.toUpperCase())
      || (/^npm_config_/i.test(key) && /(auth|token)/i.test(key))
    ) {
      delete environment[key];
    }
  }
  return environment;
}

function numericVersionCore(version) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/.exec(version);
  if (!match) {
    throw new Error(`Registry dist-tag contains an unsupported version: ${version}`);
  }
  return {
    core: match.slice(1, 4).map(Number),
    prerelease: match[4] ?? null,
  };
}

function compareNumericCore(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) {
      return left[index] < right[index] ? -1 : 1;
    }
  }
  return 0;
}

function mainVersionOrder(version) {
  const parsed = numericVersionCore(version);
  const match = /^main\.([1-9]\d*)(?:\.sha\.([0-9a-f]{12}))?$/.exec(parsed.prerelease ?? '');
  if (!match) {
    throw new Error(`The main dist-tag contains an unsupported version: ${version}`);
  }
  return { core: parsed.core, runNumber: Number(match[1]) };
}

function assertDistTagPromotion(distTag, candidateVersion, currentVersion) {
  const candidate = String(candidateVersion ?? '');
  const current = String(currentVersion ?? '');
  if (!current || current === candidate) {
    return;
  }

  if (distTag === 'main') {
    const candidateOrder = mainVersionOrder(candidate);
    const currentOrder = mainVersionOrder(current);
    const coreOrder = compareNumericCore(candidateOrder.core, currentOrder.core);
    if (coreOrder > 0 || (coreOrder === 0 && candidateOrder.runNumber > currentOrder.runNumber)) {
      return;
    }
  } else if (distTag === 'latest') {
    const candidateOrder = numericVersionCore(candidate);
    const currentOrder = numericVersionCore(current);
    if (candidateOrder.prerelease !== null) {
      throw new Error(`latest may only be promoted to a stable version, found ${candidate}`);
    }
    const coreOrder = compareNumericCore(candidateOrder.core, currentOrder.core);
    if (coreOrder > 0 || (coreOrder === 0 && currentOrder.prerelease !== null)) {
      return;
    }
  } else {
    throw new Error(`Unsupported dist-tag promotion: ${distTag}`);
  }

  throw new Error(
    `Refusing to move dist-tag ${distTag} backward from ${current} to ${candidate}`,
  );
}

function inspectPackageTarball(tarballPath) {
  const entries = [];
  const seenPaths = new Set();
  tar.t({
    file: path.resolve(tarballPath),
    sync: true,
    strict: true,
    onReadEntry: (entry) => {
      const normalized = String(entry.path).replaceAll('\\', '/').replace(/\/+$/, '');
      const segments = normalized.split('/');
      if (
        !(normalized === 'package' || normalized.startsWith('package/'))
        || segments.slice(1).some((segment) => segment === '' || segment === '.' || segment === '..')
        || normalized.includes('\0')
      ) {
        throw new Error(`Unsafe or unexpected package tar entry: ${entry.path}`);
      }
      if (entry.type !== 'File' && entry.type !== 'Directory') {
        throw new Error(
          `Package tarball contains a forbidden link or special entry: ${normalized} (${entry.type})`,
        );
      }
      if (seenPaths.has(normalized)) {
        throw new Error(`Package tarball contains a duplicate entry: ${normalized}`);
      }
      seenPaths.add(normalized);
      if (!Number.isInteger(entry.mode)) {
        throw new Error(`Package tarball entry has no portable mode: ${normalized}`);
      }
      entries.push({
        path: normalized,
        type: entry.type,
        mode: entry.mode & 0o777,
      });
    },
  });

  if (entries.length === 0) {
    throw new Error(`Package tarball is empty: ${tarballPath}`);
  }
  const packageRoot = entries.find((entry) => entry.path === 'package');
  if (packageRoot && packageRoot.type !== 'Directory') {
    throw new Error('Package tarball root must be a directory');
  }
  return entries;
}

function extractPackageTarball(tarballPath, destination) {
  inspectPackageTarball(tarballPath);
  tar.x({
    file: path.resolve(tarballPath),
    cwd: destination,
    sync: true,
    strict: true,
    preservePaths: false,
  });
  const packageDir = path.join(destination, 'package');
  if (!fs.statSync(packageDir, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`Tarball does not contain a package directory: ${tarballPath}`);
  }
  return packageDir;
}

function runtimeDependencyEntries(manifest) {
  const sections = ['dependencies', 'optionalDependencies', 'peerDependencies'];
  return sections.flatMap((section) => (
    Object.entries(manifest[section] ?? {}).map(([name, spec]) => ({ section, name, spec: String(spec) }))
  ));
}

function assertNoRuntimeWireDependency(manifest) {
  for (const { section, name, spec } of runtimeDependencyEntries(manifest)) {
    if (WIRE_PACKAGE_NAMES.some((wireName) => name === wireName || spec.includes(wireName))) {
      throw new Error(`Published manifest contains a runtime happy-wire dependency in ${section}: ${name}`);
    }
  }
}

function walkFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(entryPath));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }
  return files;
}

function findBareWireImports(contents) {
  const patterns = [
    /\bfrom\s*["']@(?:slopus|sokdak)\/happy-wire(?:\/[^"']*)?["']/,
    /\bimport\s*["']@(?:slopus|sokdak)\/happy-wire(?:\/[^"']*)?["']/,
    /\b(?:import|require)\s*\(\s*["']@(?:slopus|sokdak)\/happy-wire(?:\/[^"']*)?["']\s*\)/,
  ];
  return patterns.some((pattern) => pattern.test(contents));
}

function verifyExtractedForkCli(packageDir, expectedVersion) {
  const manifestPath = path.join(packageDir, 'package.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.name, FORK_PACKAGE_NAME, 'published package name must be scoped to @sokdak');
  assert.equal(manifest.version, expectedVersion, 'published package version must match the prepared version');
  assert.deepEqual(
    manifest.publishConfig,
    { registry: 'https://registry.npmjs.org', access: 'public' },
    'published package must use the public npm registry configuration',
  );
  assert.equal(
    manifest.bin?.happy,
    './bin/happy.mjs',
    'published package must expose the expected happy CLI binary',
  );
  const happyBinPath = path.resolve(packageDir, manifest.bin.happy);
  if (
    !happyBinPath.startsWith(`${path.resolve(packageDir)}${path.sep}`)
    || !fs.statSync(happyBinPath, { throwIfNoEntry: false })?.isFile()
  ) {
    throw new Error('Published happy CLI binary target is missing or escapes the package');
  }
  assertNoRuntimeWireDependency(manifest);
  if (JSON.stringify(manifest).includes('@sokdak/happy-wire')) {
    throw new Error('Published manifest must not reference @sokdak/happy-wire');
  }

  const runtimeRoots = ['dist', 'bin', 'scripts']
    .map((relativePath) => path.join(packageDir, relativePath))
    .filter((candidate) => fs.statSync(candidate, { throwIfNoEntry: false })?.isDirectory());
  const runtimeFiles = runtimeRoots
    .flatMap(walkFiles)
    .filter((filePath) => RUNTIME_EXTENSIONS.has(path.extname(filePath)));
  if (runtimeFiles.length === 0) {
    throw new Error('Published CLI tarball contains no runtime JavaScript files');
  }

  for (const runtimeFile of runtimeFiles) {
    const contents = fs.readFileSync(runtimeFile, 'utf8');
    if (findBareWireImports(contents)) {
      throw new Error(
        `Published runtime contains an external happy-wire import: ${path.relative(packageDir, runtimeFile)}`,
      );
    }
  }

  return { manifest, runtimeFiles };
}

function withExtractedTarball(tarballPath, callback) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'happy-cli-tarball-'));
  try {
    const packageDir = extractPackageTarball(tarballPath, temporaryRoot);
    return callback(packageDir);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function verifyForkCliTarball(tarballPath, expectedVersion) {
  return withExtractedTarball(tarballPath, (packageDir) => (
    verifyExtractedForkCli(packageDir, expectedVersion)
  ));
}

function packageSnapshot(packageDir, entries) {
  const snapshot = new Map();
  for (const entry of entries) {
    const relativePath = entry.path === 'package'
      ? '.'
      : entry.path.slice('package/'.length);
    const extractedPath = relativePath === '.' ? packageDir : path.join(packageDir, ...relativePath.split('/'));
    const stat = fs.lstatSync(extractedPath, { throwIfNoEntry: false });
    if (entry.type === 'Directory') {
      if (!stat?.isDirectory() || stat.isSymbolicLink()) {
        throw new Error(`Extracted package directory does not match archive metadata: ${relativePath}`);
      }
      snapshot.set(relativePath, `Directory:${entry.mode.toString(8)}`);
      continue;
    }
    if (!stat?.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Extracted package file does not match archive metadata: ${relativePath}`);
    }
    const contents = fs.readFileSync(extractedPath);
    const digest = crypto.createHash('sha256').update(contents).digest('hex');
    snapshot.set(relativePath, `File:${entry.mode.toString(8)}:${digest}`);
  }
  return snapshot;
}

function comparePackageTarballs(localTarballPath, registryTarballPath) {
  const localEntries = inspectPackageTarball(localTarballPath);
  const registryEntries = inspectPackageTarball(registryTarballPath);
  return withExtractedTarball(localTarballPath, (localPackageDir) => (
    withExtractedTarball(registryTarballPath, (registryPackageDir) => {
      const local = packageSnapshot(localPackageDir, localEntries);
      const registry = packageSnapshot(registryPackageDir, registryEntries);
      const allPaths = [...new Set([...local.keys(), ...registry.keys()])].sort();
      const differences = allPaths.filter((filePath) => local.get(filePath) !== registry.get(filePath));
      if (differences.length > 0) {
        throw new Error(
          `Registry version collision: package contents differ (${differences.slice(0, 10).join(', ')})`,
        );
      }
      return { fileCount: allPaths.length };
    })
  ));
}

function npmInvocation() {
  if (process.platform !== 'win32') {
    return { executable: 'npm', leadingArguments: [] };
  }

  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].filter(Boolean);
  const npmCliPath = candidates.find((candidate) => fs.existsSync(candidate));
  if (!npmCliPath) {
    throw new Error('Could not locate npm-cli.js for the clean-install smoke test');
  }
  return { executable: process.execPath, leadingArguments: [npmCliPath] };
}

function smokeInstallForkCli(packageSpec, expectedVersion) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'happy-cli-install-'));
  const { executable: npmExecutable, leadingArguments: npmLeadingArguments } = npmInvocation();
  const resolvedPackageSpec = fs.existsSync(packageSpec) ? path.resolve(packageSpec) : packageSpec;
  const credentialFreeEnvironment = withoutRegistryCredentials();
  try {
    fs.writeFileSync(
      path.join(temporaryRoot, 'package.json'),
      `${JSON.stringify({ name: 'happy-cli-install-smoke', private: true }, null, 2)}\n`,
    );
    execFileSync(
      npmExecutable,
      [...npmLeadingArguments, 'install', '--no-audit', '--no-fund', resolvedPackageSpec],
      { cwd: temporaryRoot, env: credentialFreeEnvironment, stdio: 'inherit' },
    );

    const installedPackageDir = path.join(temporaryRoot, 'node_modules', '@sokdak', 'happy');
    const manifest = JSON.parse(
      fs.readFileSync(path.join(installedPackageDir, 'package.json'), 'utf8'),
    );
    assert.equal(manifest.name, FORK_PACKAGE_NAME, 'clean install resolved the wrong package');
    assert.equal(manifest.version, expectedVersion, 'clean install resolved the wrong version');
    assert.equal(manifest.bin?.happy, './bin/happy.mjs', 'installed package exposes the wrong happy binary');
    assertNoRuntimeWireDependency(manifest);
    if (fs.existsSync(path.join(temporaryRoot, 'node_modules', '@slopus', 'happy-wire'))) {
      throw new Error('Clean install unexpectedly resolved the external @slopus/happy-wire package');
    }

    const smokeEnvironment = {
      ...credentialFreeEnvironment,
      HAPPY_HOME_DIR: path.join(temporaryRoot, 'happy-home'),
    };
    execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        'const value = await import("@sokdak/happy/lib"); if (!value.ApiClient) throw new Error("missing ApiClient export");',
      ],
      { cwd: temporaryRoot, env: smokeEnvironment, stdio: 'inherit' },
    );
    execFileSync(
      process.execPath,
      [
        '--eval',
        'const value = require("@sokdak/happy/lib"); if (!value.ApiClient) throw new Error("missing CJS ApiClient export");',
      ],
      { cwd: temporaryRoot, env: smokeEnvironment, stdio: 'inherit' },
    );
    const versionOutput = execFileSync(
      process.execPath,
      [path.resolve(installedPackageDir, manifest.bin.happy), '--version'],
      { cwd: temporaryRoot, env: smokeEnvironment, encoding: 'utf8' },
    );
    if (!versionOutput.includes(`happy version: ${expectedVersion}`)) {
      throw new Error(
        `Installed CLI binary reported the wrong version; output was: ${versionOutput.trim()}`,
      );
    }

    return { manifest, versionOutput };
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

if (require.main === module) {
  const command = process.argv[2];
  if (command === 'verify') {
    const result = verifyForkCliTarball(process.argv[3], process.argv[4]);
    console.log(`verified ${result.manifest.name}@${result.manifest.version} (${result.runtimeFiles.length} runtime files)`);
  } else if (command === 'compare') {
    const result = comparePackageTarballs(process.argv[3], process.argv[4]);
    console.log(`registry tarball matches the local tarball (${result.fileCount} files)`);
  } else if (command === 'smoke-install') {
    const result = smokeInstallForkCli(process.argv[3], process.argv[4]);
    console.log(`clean install verified ${result.manifest.name}@${result.manifest.version}`);
  } else if (command === 'assert-promotion') {
    assertDistTagPromotion(process.argv[3], process.argv[4], process.argv[5]);
    console.log(`dist-tag ${process.argv[3]} may advance to ${process.argv[4]}`);
  } else {
    throw new Error(
      'Usage: verify-fork-cli-package.cjs <verify TAR VERSION | compare LOCAL_TAR REGISTRY_TAR | smoke-install SPEC VERSION | assert-promotion TAG CANDIDATE CURRENT>',
    );
  }
}

module.exports = {
  assertDistTagPromotion,
  assertNoRuntimeWireDependency,
  comparePackageTarballs,
  extractPackageTarball,
  findBareWireImports,
  inspectPackageTarball,
  smokeInstallForkCli,
  withoutRegistryCredentials,
  verifyExtractedForkCli,
  verifyForkCliTarball,
};
