'use strict';

const fs = require('node:fs');
const path = require('node:path');

const CMAKE_RELATIVE_PATH = '@more-tech/react-native-libsodium/android/CMakeLists.txt';
const CXX_STANDARD_ANCHOR = 'set (CMAKE_CXX_STANDARD 20)';
const NODE_MODULES_PATH_NORMALIZATION = 'file(TO_CMAKE_PATH "${NODE_MODULES_DIR}" NODE_MODULES_DIR)';

function lineEndingOf(contents) {
  return contents.includes('\r\n') ? '\r\n' : '\n';
}

function patchLibsodiumCmake(contents) {
  const occurrences = contents.split(CXX_STANDARD_ANCHOR).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `[fix-react-native-libsodium-windows-cmake] Expected exactly one C++ standard anchor, found ${occurrences}`,
    );
  }

  if (contents.includes(NODE_MODULES_PATH_NORMALIZATION)) {
    return contents;
  }

  return contents.replace(
    CXX_STANDARD_ANCHOR,
    `${CXX_STANDARD_ANCHOR}${lineEndingOf(contents)}${NODE_MODULES_PATH_NORMALIZATION}`,
  );
}

function defaultNodeModulesRoots() {
  return [
    path.resolve(__dirname, '..', 'node_modules'),
    path.resolve(__dirname, '..', 'packages/happy-app/node_modules'),
  ];
}

function applyReactNativeLibsodiumWindowsCmakePatch(options = {}) {
  const nodeModulesRoots = options.nodeModulesRoots ?? defaultNodeModulesRoots();
  let patchedFiles = 0;

  for (const nodeModulesRoot of nodeModulesRoots) {
    const cmakePath = path.join(nodeModulesRoot, ...CMAKE_RELATIVE_PATH.split('/'));
    if (!fs.existsSync(cmakePath)) {
      continue;
    }

    const contents = fs.readFileSync(cmakePath, 'utf8');
    const patched = patchLibsodiumCmake(contents);
    if (patched !== contents) {
      fs.writeFileSync(cmakePath, patched, 'utf8');
      patchedFiles += 1;
    }
  }

  return patchedFiles;
}

module.exports = {
  CMAKE_RELATIVE_PATH,
  CXX_STANDARD_ANCHOR,
  NODE_MODULES_PATH_NORMALIZATION,
  applyReactNativeLibsodiumWindowsCmakePatch,
  patchLibsodiumCmake,
};
