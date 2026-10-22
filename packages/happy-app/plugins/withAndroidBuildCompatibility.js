'use strict';

const ENTRY_FILE_ANCHOR = '    bundleCommand = "export:embed"';
const ENTRY_FILE_CONFIG = '    extraPackagerArgs = ["--entry-file", new File(projectRoot, "index.ts").getAbsolutePath()]';
const ANDROID_BLOCK_ANCHOR = 'android {';
const NATIVE_BUILD_MARKER = 'buildStagingDirectory System.getProperty("os.name").toLowerCase().contains("windows")';
const GRADLE_JVM_ARGS = '-Xmx4096m -XX:MaxMetaspaceSize=1024m';

function lineEndingOf(contents) {
    return contents.includes('\r\n') ? '\r\n' : '\n';
}

function requireUniqueAnchor(contents, anchor, description) {
    const occurrences = contents.split(anchor).length - 1;
    if (occurrences !== 1) {
        throw new Error(
            `[withAndroidBuildCompatibility] Expected exactly one ${description} anchor, found ${occurrences}`,
        );
    }
}

function patchAppBuildGradle(contents) {
    if (typeof contents !== 'string') {
        throw new TypeError('[withAndroidBuildCompatibility] app build.gradle contents must be a string');
    }

    requireUniqueAnchor(contents, ENTRY_FILE_ANCHOR, 'Expo bundle command');
    requireUniqueAnchor(contents, ANDROID_BLOCK_ANCHOR, 'Android block');

    const lineEnding = lineEndingOf(contents);
    let patched = contents;

    if (!patched.includes(ENTRY_FILE_CONFIG)) {
        patched = patched.replace(
            ENTRY_FILE_ANCHOR,
            `${ENTRY_FILE_ANCHOR}${lineEnding}${ENTRY_FILE_CONFIG}`,
        );
    }

    if (!patched.includes(NATIVE_BUILD_MARKER)) {
        const nativeBuildConfig = [
            ANDROID_BLOCK_ANCHOR,
            '    externalNativeBuild {',
            '        cmake {',
            `            ${NATIVE_BUILD_MARKER}`,
            '                ? new File(System.getenv("SystemDrive") + "/happy-app-cxx")',
            '                : new File(System.getProperty("java.io.tmpdir"), "happy-app-cxx")',
            '        }',
            '    }',
        ].join(lineEnding);
        patched = patched.replace(ANDROID_BLOCK_ANCHOR, nativeBuildConfig);
    }

    return patched;
}

function patchGradleProperties(properties) {
    if (!Array.isArray(properties)) {
        throw new TypeError('[withAndroidBuildCompatibility] Gradle properties must be an array');
    }

    const matchingIndexes = properties
        .map((property, index) => (
            property.type === 'property' && property.key === 'org.gradle.jvmargs' ? index : -1
        ))
        .filter((index) => index !== -1);

    if (matchingIndexes.length > 1) {
        throw new Error('[withAndroidBuildCompatibility] Found duplicate org.gradle.jvmargs properties');
    }

    if (matchingIndexes.length === 0) {
        return [
            ...properties,
            {
                type: 'property',
                key: 'org.gradle.jvmargs',
                value: GRADLE_JVM_ARGS,
            },
        ];
    }

    const targetIndex = matchingIndexes[0];
    return properties.map((property, index) => (
        index === targetIndex ? { ...property, value: GRADLE_JVM_ARGS } : property
    ));
}

function patchAppBuildGradleMod(modResults) {
    if (modResults.language !== 'groovy') {
        throw new Error(
            `[withAndroidBuildCompatibility] Unsupported app build.gradle language: ${modResults.language ?? 'unknown'}`,
        );
    }

    return {
        ...modResults,
        contents: patchAppBuildGradle(modResults.contents),
    };
}

function withAndroidBuildCompatibility(config) {
    const { withAppBuildGradle, withGradleProperties } = require('@expo/config-plugins');

    config = withAppBuildGradle(config, (gradleConfig) => {
        gradleConfig.modResults = patchAppBuildGradleMod(gradleConfig.modResults);
        return gradleConfig;
    });

    return withGradleProperties(config, (gradleConfig) => {
        gradleConfig.modResults = patchGradleProperties(gradleConfig.modResults);
        return gradleConfig;
    });
}

module.exports = withAndroidBuildCompatibility;
module.exports.ENTRY_FILE_ANCHOR = ENTRY_FILE_ANCHOR;
module.exports.ENTRY_FILE_CONFIG = ENTRY_FILE_CONFIG;
module.exports.ANDROID_BLOCK_ANCHOR = ANDROID_BLOCK_ANCHOR;
module.exports.NATIVE_BUILD_MARKER = NATIVE_BUILD_MARKER;
module.exports.GRADLE_JVM_ARGS = GRADLE_JVM_ARGS;
module.exports.patchAppBuildGradle = patchAppBuildGradle;
module.exports.patchAppBuildGradleMod = patchAppBuildGradleMod;
module.exports.patchGradleProperties = patchGradleProperties;
