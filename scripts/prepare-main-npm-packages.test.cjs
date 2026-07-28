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
