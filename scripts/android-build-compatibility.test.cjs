'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const androidPlugin = require('../packages/happy-app/plugins/withAndroidBuildCompatibility.js');
const audioApiPatch = require('../patches/fix-react-native-audio-api-windows-build.cjs');
const libsodiumPatch = require('../patches/fix-react-native-libsodium-windows-cmake.cjs');

test('app Gradle patch is idempotent and configures Expo entry and a short native build path', () => {
  const input = [
    'react {',
    androidPlugin.ENTRY_FILE_ANCHOR,
    '}',
    '',
    androidPlugin.ANDROID_BLOCK_ANCHOR,
    '}',
    '',
  ].join('\r\n');

  const once = androidPlugin.patchAppBuildGradle(input);
  const twice = androidPlugin.patchAppBuildGradle(once);

  assert.equal(twice, once);
  assert.match(once, /extraPackagerArgs = \["--entry-file"/);
  assert.match(once, /happy-app-cxx/);
  assert.ok(once.includes('\r\n'));
});

test('app Gradle patch fails loudly when either generated anchor drifts', () => {
  assert.throws(
    () => androidPlugin.patchAppBuildGradle('android {\n}\n'),
    /Expo bundle command anchor, found 0/,
  );
  assert.throws(
    () => androidPlugin.patchAppBuildGradle(`${androidPlugin.ENTRY_FILE_ANCHOR}\n`),
    /Android block anchor, found 0/,
  );
});

test('app Gradle mod rejects unsupported Gradle languages', () => {
  assert.throws(
    () => androidPlugin.patchAppBuildGradleMod({ language: 'kotlin', contents: '' }),
    /Unsupported app build\.gradle language: kotlin/,
  );
});

test('Gradle properties patch adds or replaces one JVM memory property', () => {
  const added = androidPlugin.patchGradleProperties([{ type: 'comment', value: 'keep me' }]);
  assert.equal(added.at(-1).value, androidPlugin.GRADLE_JVM_ARGS);

  const replaced = androidPlugin.patchGradleProperties([
    { type: 'property', key: 'org.gradle.jvmargs', value: '-Xmx1g' },
  ]);
  assert.deepEqual(replaced, [
    { type: 'property', key: 'org.gradle.jvmargs', value: androidPlugin.GRADLE_JVM_ARGS },
  ]);
});

test('audio API patch is idempotent and fails if its target anchor changes', () => {
  const input = `externalNativeBuild {\n${audioApiPatch.CMAKE_PATH_ANCHOR}\n}\n`;
  const once = audioApiPatch.patchAudioApiBuildGradle(input);

  assert.equal(audioApiPatch.patchAudioApiBuildGradle(once), once);
  assert.match(once, /happy-audio-api-cxx/);
  assert.throws(
    () => audioApiPatch.patchAudioApiBuildGradle('externalNativeBuild {}'),
    /CMake path anchor, found 0/,
  );
});

test('libsodium patch is idempotent and fails if its target anchor changes', () => {
  const input = `cmake_minimum_required(VERSION 3.4.1)\n${libsodiumPatch.CXX_STANDARD_ANCHOR}\n`;
  const once = libsodiumPatch.patchLibsodiumCmake(input);

  assert.equal(libsodiumPatch.patchLibsodiumCmake(once), once);
  assert.ok(once.includes(libsodiumPatch.NODE_MODULES_PATH_NORMALIZATION));
  assert.throws(
    () => libsodiumPatch.patchLibsodiumCmake('set(CMAKE_CXX_STANDARD 20)'),
    /C\+\+ standard anchor, found 0/,
  );
});

test('file patchers change installed dependency targets once', (t) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'happy-android-patches-'));
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));

  const audioPath = path.join(temporaryRoot, ...audioApiPatch.BUILD_GRADLE_RELATIVE_PATH.split('/'));
  const sodiumPath = path.join(temporaryRoot, ...libsodiumPatch.CMAKE_RELATIVE_PATH.split('/'));
  fs.mkdirSync(path.dirname(audioPath), { recursive: true });
  fs.mkdirSync(path.dirname(sodiumPath), { recursive: true });
  fs.writeFileSync(audioPath, `${audioApiPatch.CMAKE_PATH_ANCHOR}\n`, 'utf8');
  fs.writeFileSync(sodiumPath, `${libsodiumPatch.CXX_STANDARD_ANCHOR}\n`, 'utf8');

  assert.equal(
    audioApiPatch.applyReactNativeAudioApiWindowsBuildPatch({ nodeModulesRoots: [temporaryRoot] }),
    1,
  );
  assert.equal(
    libsodiumPatch.applyReactNativeLibsodiumWindowsCmakePatch({ nodeModulesRoots: [temporaryRoot] }),
    1,
  );
  assert.equal(
    audioApiPatch.applyReactNativeAudioApiWindowsBuildPatch({ nodeModulesRoots: [temporaryRoot] }),
    0,
  );
  assert.equal(
    libsodiumPatch.applyReactNativeLibsodiumWindowsCmakePatch({ nodeModulesRoots: [temporaryRoot] }),
    0,
  );
});

test('file patchers surface installed dependency anchor drift', (t) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'happy-android-anchor-drift-'));
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));

  const audioPath = path.join(temporaryRoot, ...audioApiPatch.BUILD_GRADLE_RELATIVE_PATH.split('/'));
  const sodiumPath = path.join(temporaryRoot, ...libsodiumPatch.CMAKE_RELATIVE_PATH.split('/'));
  fs.mkdirSync(path.dirname(audioPath), { recursive: true });
  fs.mkdirSync(path.dirname(sodiumPath), { recursive: true });
  fs.writeFileSync(audioPath, 'externalNativeBuild {}\n', 'utf8');
  fs.writeFileSync(sodiumPath, 'set(CMAKE_CXX_STANDARD 20)\n', 'utf8');

  assert.throws(
    () => audioApiPatch.applyReactNativeAudioApiWindowsBuildPatch({
      nodeModulesRoots: [temporaryRoot],
    }),
    /CMake path anchor, found 0/,
  );
  assert.throws(
    () => libsodiumPatch.applyReactNativeLibsodiumWindowsCmakePatch({
      nodeModulesRoots: [temporaryRoot],
    }),
    /C\+\+ standard anchor, found 0/,
  );
});

test('Android validation workflow is PR-only, read-only, and does not publish artifacts', () => {
  const workflowPath = path.resolve(__dirname, '../.github/workflows/android-apk-validation.yml');
  const workflow = fs.readFileSync(workflowPath, 'utf8');

  assert.match(workflow, /^on:\r?\n  pull_request:/m);
  assert.match(workflow, /^permissions:\r?\n  contents: read$/m);
  assert.match(workflow, /runs-on: ubuntu-latest/);
  assert.match(workflow, /persist-credentials: false/);
  assert.doesNotMatch(workflow, /^  (schedule|release|workflow_dispatch):/m);
  assert.doesNotMatch(workflow, /upload-artifact|gh release|contents: write/);
});

test('app config and postinstall wire compatibility patches explicitly', () => {
  const appConfig = fs.readFileSync(
    path.resolve(__dirname, '../packages/happy-app/app.config.js'),
    'utf8',
  );
  const postinstall = fs.readFileSync(path.resolve(__dirname, 'postinstall.cjs'), 'utf8');

  assert.match(appConfig, /require\("\.\/plugins\/withAndroidBuildCompatibility\.js"\)/);
  assert.match(postinstall, /applyReactNativeAudioApiWindowsBuildPatch\(\)/);
  assert.match(postinstall, /applyReactNativeLibsodiumWindowsCmakePatch\(\)/);
});
