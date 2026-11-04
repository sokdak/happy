/**
 * FlashList 2.3.x forwards autoscrollToTopThreshold to ScrollView, but React
 * Native Web does not implement it. Its JS anchor correction consequently
 * pushes an inverted chat away from the newest message on every prepend.
 * Apply the threshold to the pre-update offset in the web correction path.
 */
const fs = require('node:fs');
const path = require('node:path');

const replacements = [
    ['import { I18nManager } from "react-native";', 'import { I18nManager, Platform } from "react-native";'],
    ['const diff = horizontal',
        'const autoscrollToTopThreshold = recyclerViewManager.props.maintainVisibleContentPosition?.autoscrollToTopThreshold;\n'
        + 'const followTop = Platform.OS === "web" && !horizontal\n'
        + '&& typeof autoscrollToTopThreshold === "number" && autoscrollToTopThreshold >= 0\n'
        + '&& recyclerViewManager.getAbsoluteLastScrollOffset() <= autoscrollToTopThreshold;\n'
        + 'const diff = followTop && recyclerViewManager.getLayout(currentIndexOfFirstVisibleItem).y !== firstVisibleItemLayout.current?.y\n'
        + '? -recyclerViewManager.getAbsoluteLastScrollOffset() : horizontal'],
];

function patchSource(source) {
    const normalized = source.replace(/^[ \t]+/gm, '');
    if (replacements.every(([, after]) => normalized.split(after).length === 2)) return source;
    for (const [before, after] of replacements) {
        if (normalized.split(before).length !== 2 || normalized.includes(after)) {
            throw new Error('[patch] Unexpected FlashList scroll controller; review fix-flash-list-web-autoscroll.cjs');
        }
    }
    for (const [before, after] of replacements) {
        const indent = source.slice(0, source.indexOf(before)).split('\n').pop();
        source = source.replace(before, after.replace(/\n/g, `\n${indent}`));
    }
    return source;
}

function patchFlashListWebAutoscroll(nodeModulesRoots = [
    path.resolve(__dirname, '..', 'node_modules'),
    path.resolve(__dirname, '..', 'packages/happy-app/node_modules'),
]) {
    const changes = new Map();
    for (const root of nodeModulesRoots) {
        const packageRoot = path.join(root, '@shopify/flash-list');
        if (!fs.existsSync(path.join(packageRoot, 'package.json'))) continue;
        for (const relative of ['src/recyclerview/hooks/useRecyclerViewController.tsx', 'dist/recyclerview/hooks/useRecyclerViewController.js']) {
            const file = fs.realpathSync(path.join(packageRoot, relative));
            const source = fs.readFileSync(file, 'utf8');
            const patched = patchSource(source);
            if (patched !== source) changes.set(file, patched);
        }
    }
    // Reject upstream drift in any installed copy before writing any of them.
    for (const [file, source] of changes) fs.writeFileSync(file, source);
    if (changes.size) console.log(`[patch] Fixed FlashList web autoscroll (${changes.size} file(s))`);
    return changes.size;
}

module.exports = { patchSource, patchFlashListWebAutoscroll };
if (require.main === module) patchFlashListWebAutoscroll();
