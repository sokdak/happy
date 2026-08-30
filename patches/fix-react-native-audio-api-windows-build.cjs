'use strict';

const fs = require('node:fs');
const path = require('node:path');

const BUILD_GRADLE_RELATIVE_PATH = 'react-native-audio-api/android/build.gradle';
const CMAKE_PATH_ANCHOR = '      path "CMakeLists.txt"';
const BUILD_STAGING_MARKER = '      buildStagingDirectory Os.isFamily(Os.FAMILY_WINDOWS)';

function lineEndingOf(contents) {
  return contents.includes('\r\n') ? '\r\n' : '\n';
}

function patchAudioApiBuildGradle(contents) {
  const occurrences = contents.split(CMAKE_PATH_ANCHOR).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `[fix-react-native-audio-api-windows-build] Expected exactly one CMake path anchor, found ${occurrences}`,
    );
  }

  if (contents.includes(BUILD_STAGING_MARKER)) {
    return contents;
  }

  const lineEnding = lineEndingOf(contents);
  const replacement = [
    CMAKE_PATH_ANCHOR,
    BUILD_STAGING_MARKER,
    '        ? file("${System.getenv(\'SystemDrive\')}/happy-audio-api-cxx")',
    '        : new File(System.getProperty("java.io.tmpdir"), "happy-audio-api-cxx")',
  ].join(lineEnding);

  return contents.replace(CMAKE_PATH_ANCHOR, replacement);
}

function defaultNodeModulesRoots() {
  return [
    path.resolve(__dirname, '..', 'node_modules'),
    path.resolve(__dirname, '..', 'packages/happy-app/node_modules'),
  ];
}

function applyReactNativeAudioApiWindowsBuildPatch(options = {}) {
  const nodeModulesRoots = options.nodeModulesRoots ?? defaultNodeModulesRoots();
  let patchedFiles = 0;

  for (const nodeModulesRoot of nodeModulesRoots) {
    const gradlePath = path.join(nodeModulesRoot, ...BUILD_GRADLE_RELATIVE_PATH.split('/'));
    if (!fs.existsSync(gradlePath)) {
      continue;
    }

    const contents = fs.readFileSync(gradlePath, 'utf8');
    const patched = patchAudioApiBuildGradle(contents);
    if (patched !== contents) {
      fs.writeFileSync(gradlePath, patched, 'utf8');
      patchedFiles += 1;
    }
  }

  return patchedFiles;
}

module.exports = {
  BUILD_GRADLE_RELATIVE_PATH,
  BUILD_STAGING_MARKER,
  CMAKE_PATH_ANCHOR,
  applyReactNativeAudioApiWindowsBuildPatch,
  patchAudioApiBuildGradle,
};
