'use strict';

const fs = require('node:fs');
const path = require('node:path');

const FORK_PACKAGE_NAME = '@sokdak/happy';
const UPSTREAM_WIRE_NAME = '@slopus/happy-wire';
const FORK_WIRE_NAME = '@sokdak/happy-wire';
const PUBLISH_CONFIG = {
  registry: 'https://registry.npmjs.org',
  access: 'public',
};
const STABLE_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function normalizeRunNumber(runNumber) {
  const normalized = String(runNumber ?? '');
  if (!/^[1-9]\d*$/.test(normalized)) {
    throw new Error('GitHub run number must be a positive integer');
  }
  return normalized;
}

function normalizeSourceSha(sourceSha) {
  const normalized = String(sourceSha ?? '').toLowerCase();
  if (!/^[0-9a-f]{40,64}$/.test(normalized)) {
    throw new Error('Source SHA must be a 40-64 character hexadecimal Git object ID');
  }
  return normalized;
}

function stableVersionFromReference(reference) {
  const normalized = String(reference ?? '');
  if (!normalized.startsWith('npm-publish/')) {
    throw new Error('Stable releases require the full npm-publish/<major.minor.patch> tag');
  }
  const version = normalized.slice('npm-publish/'.length);
  if (!STABLE_VERSION_PATTERN.test(version)) {
    throw new Error('Stable releases require the full npm-publish/<major.minor.patch> tag');
  }
  return version;
}

function assertBundledUpstreamWire(manifest) {
  const runtimeSections = ['dependencies', 'optionalDependencies', 'peerDependencies'];
  for (const section of runtimeSections) {
    for (const [dependencyName, dependencySpec] of Object.entries(manifest[section] ?? {})) {
      const spec = String(dependencySpec);
      if (
        dependencyName === UPSTREAM_WIRE_NAME
        || dependencyName === FORK_WIRE_NAME
        || spec.includes(UPSTREAM_WIRE_NAME)
        || spec.includes(FORK_WIRE_NAME)
      ) {
        throw new Error(
          `${UPSTREAM_WIRE_NAME} must remain bundled from devDependencies, not declared in ${section}`,
        );
      }
    }
  }

  const devDependencies = manifest.devDependencies ?? {};
  if (devDependencies[UPSTREAM_WIRE_NAME] !== 'workspace:*') {
    throw new Error(
      `CLI devDependencies must contain "${UPSTREAM_WIRE_NAME}": "workspace:*" for pkgroll bundling`,
    );
  }

  for (const [dependencyName, dependencySpec] of Object.entries(devDependencies)) {
    if (
      dependencyName === FORK_WIRE_NAME
      || String(dependencySpec).includes(FORK_WIRE_NAME)
    ) {
      throw new Error(`${FORK_WIRE_NAME} aliases and dependencies are forbidden`);
    }
  }

  const bundledDependencies = manifest.bundledDependencies ?? manifest.bundleDependencies ?? [];
  if (
    Array.isArray(bundledDependencies)
    && bundledDependencies.some((name) => name === UPSTREAM_WIRE_NAME || name === FORK_WIRE_NAME)
  ) {
    throw new Error('happy-wire must be code-bundled by pkgroll, not listed in bundledDependencies');
  }
}

function prepareForkCliPackage(options) {
  const rootDir = path.resolve(options.rootDir);
  const mode = String(options.mode ?? '').toLowerCase();
  const manifestPath = path.join(rootDir, 'packages', 'happy-cli', 'package.json');
  const manifest = readJson(manifestPath);

  if (manifest.name !== 'happy') {
    throw new Error(`Expected the upstream CLI package name "happy", found "${manifest.name}"`);
  }
  if (!STABLE_VERSION_PATTERN.test(manifest.version)) {
    throw new Error(`CLI manifest version must be a stable major.minor.patch version, found "${manifest.version}"`);
  }
  assertBundledUpstreamWire(manifest);

  let version;
  let distTag;
  if (mode === 'main') {
    const runNumber = normalizeRunNumber(options.runNumber);
    const sourceSha = normalizeSourceSha(options.sourceSha);
    version = `${manifest.version}-main.${runNumber}.sha.${sourceSha.slice(0, 12)}`;
    distTag = 'main';
  } else if (mode === 'stable') {
    const expectedVersion = stableVersionFromReference(options.expectedVersion);
    if (expectedVersion !== manifest.version) {
      throw new Error(
        `Release version mismatch: reference requests ${expectedVersion}, manifest contains ${manifest.version}`,
      );
    }
    version = manifest.version;
    distTag = 'latest';
  } else {
    throw new Error(`Unsupported publish mode "${options.mode}"; expected "main" or "stable"`);
  }

  manifest.name = FORK_PACKAGE_NAME;
  manifest.version = version;
  manifest.publishConfig = { ...PUBLISH_CONFIG };
  writeJson(manifestPath, manifest);

  return {
    mode,
    packageName: FORK_PACKAGE_NAME,
    version,
    distTag,
  };
}

function appendGitHubOutputs(result, outputPath) {
  if (!outputPath) {
    return;
  }
  fs.appendFileSync(
    outputPath,
    [
      `mode=${result.mode}`,
      `package_name=${result.packageName}`,
      `version=${result.version}`,
      `dist_tag=${result.distTag}`,
      '',
    ].join('\n'),
  );
}

if (require.main === module) {
  const mode = process.argv[2];
  const result = mode === 'main'
    ? prepareForkCliPackage({
      rootDir: process.cwd(),
      mode,
      runNumber: process.argv[3] ?? process.env.GITHUB_RUN_NUMBER,
      sourceSha: process.argv[4] ?? process.env.GITHUB_SHA,
    })
    : prepareForkCliPackage({
      rootDir: process.cwd(),
      mode,
      expectedVersion: process.argv[3],
    });

  appendGitHubOutputs(result, process.env.GITHUB_OUTPUT);
  console.log(`prepared ${result.packageName}@${result.version} for the ${result.distTag} dist-tag`);
}

module.exports = {
  FORK_PACKAGE_NAME,
  FORK_WIRE_NAME,
  PUBLISH_CONFIG,
  UPSTREAM_WIRE_NAME,
  assertBundledUpstreamWire,
  prepareForkCliPackage,
  stableVersionFromReference,
};
