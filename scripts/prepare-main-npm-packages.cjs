const fs = require('node:fs');
const path = require('node:path');

const PUBLISH_CONFIG = {
  registry: 'https://registry.npmjs.org',
  access: 'public',
};

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function normalizeRunNumber(runNumber) {
  const value = String(runNumber ?? '');
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error('GitHub run number must be a positive integer');
  }
  return value;
}

function prepareMainNpmPackages(rootDir, runNumber) {
  const normalizedRunNumber = normalizeRunNumber(runNumber);
  const wirePath = path.join(rootDir, 'packages', 'happy-wire', 'package.json');
  const cliPath = path.join(rootDir, 'packages', 'happy-cli', 'package.json');
  const wire = readJson(wirePath);
  const cli = readJson(cliPath);

  if (!cli.dependencies || !Object.hasOwn(cli.dependencies, '@slopus/happy-wire')) {
    throw new Error('CLI manifest is missing @slopus/happy-wire');
  }

  const wireVersion = `${wire.version}-main.${normalizedRunNumber}`;
  const cliVersion = `${cli.version}-main.${normalizedRunNumber}`;

  wire.name = '@sokdak/happy-wire';
  wire.version = wireVersion;
  wire.publishConfig = { ...PUBLISH_CONFIG };

  cli.name = '@sokdak/happy';
  cli.version = cliVersion;
  cli.publishConfig = { ...PUBLISH_CONFIG };
  cli.dependencies['@slopus/happy-wire'] = `npm:@sokdak/happy-wire@${wireVersion}`;

  writeJson(wirePath, wire);
  writeJson(cliPath, cli);

  return { wireVersion, cliVersion };
}

if (require.main === module) {
  const versions = prepareMainNpmPackages(
    process.cwd(),
    process.argv[2] ?? process.env.GITHUB_RUN_NUMBER,
  );
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(
      process.env.GITHUB_OUTPUT,
      `wire_version=${versions.wireVersion}\ncli_version=${versions.cliVersion}\n`,
    );
  }
  console.log(`prepared @sokdak/happy-wire@${versions.wireVersion}`);
  console.log(`prepared @sokdak/happy@${versions.cliVersion}`);
}

module.exports = { prepareMainNpmPackages };
