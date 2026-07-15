const fs = require('fs');
const path = require('path');

const nodeModulesRoots = [
    path.resolve(__dirname, '..', 'node_modules'),
    path.resolve(__dirname, '..', 'packages/happy-app/node_modules'),
];

let patched = 0;

for (const nodeModulesRoot of nodeModulesRoots) {
    const cmakePath = path.join(
        nodeModulesRoot,
        '@more-tech/react-native-libsodium/android/CMakeLists.txt'
    );
    if (!fs.existsSync(cmakePath)) continue;

    let content = fs.readFileSync(cmakePath, 'utf8');
    const marker = 'file(TO_CMAKE_PATH "${NODE_MODULES_DIR}" NODE_MODULES_DIR)';
    if (!content.includes(marker)) {
        content = content.replace(
            'set (CMAKE_CXX_STANDARD 20)',
            'set (CMAKE_CXX_STANDARD 20)' + String.fromCharCode(10) + marker
        );
        fs.writeFileSync(cmakePath, content, 'utf8');
        patched++;
    }
}

if (patched > 0) {
    console.log(`[patch] Fixed react-native-libsodium Windows CMake paths (${patched} file(s))`);
}
