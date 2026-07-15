const fs = require('fs');
const path = require('path');

const nodeModulesRoots = [
    path.resolve(__dirname, '..', 'node_modules'),
    path.resolve(__dirname, '..', 'packages/happy-app/node_modules'),
];

let patched = 0;

for (const nodeModulesRoot of nodeModulesRoots) {
    const gradlePath = path.join(nodeModulesRoot, 'react-native-audio-api/android/build.gradle');
    if (!fs.existsSync(gradlePath)) continue;

    let content = fs.readFileSync(gradlePath, 'utf8');
    if (!content.includes('happy-audio-api-cxx')) {
        const replacement = [
            '      path "CMakeLists.txt"',
            '      buildStagingDirectory Os.isFamily(Os.FAMILY_WINDOWS)',
            '        ? file("${System.getenv(\'SystemDrive\')}/happy-audio-api-cxx")',
            '        : new File(System.getProperty("java.io.tmpdir"), "happy-audio-api-cxx")',
        ].join(String.fromCharCode(10));
        content = content.replace('      path "CMakeLists.txt"', replacement);
        fs.writeFileSync(gradlePath, content, 'utf8');
        patched++;
    }
}

if (patched > 0) {
    console.log(`[patch] Shortened react-native-audio-api native build paths (${patched} file(s))`);
}
