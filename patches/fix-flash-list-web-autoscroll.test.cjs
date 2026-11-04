const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { patchSource, patchFlashListWebAutoscroll } = require('./fix-flash-list-web-autoscroll.cjs');

const files = ['src/recyclerview/hooks/useRecyclerViewController.tsx', 'dist/recyclerview/hooks/useRecyclerViewController.js'];
const fixture = 'import { I18nManager } from "react-native";\n  const diff = horizontal ? 10 : 20;\n';

function installation(t, roots = ['node_modules']) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flash-list-autoscroll-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    for (const root of roots) {
        const pkg = path.join(directory, root, '@shopify/flash-list');
        for (const [file, text] of [
            ...files.map(file => [file, fixture]),
            ['package.json', '{"name":"@shopify/flash-list","version":"2.3.1"}'],
        ]) {
            fs.mkdirSync(path.dirname(path.join(pkg, file)), { recursive: true });
            fs.writeFileSync(path.join(pkg, file), text);
        }
    }
    return roots.map(root => path.join(directory, root));
}

test('patches both entrypoints and installations, is idempotent, and preserves package metadata', t => {
    const roots = installation(t, ['node_modules', 'packages/happy-app/node_modules']);
    assert.equal(patchFlashListWebAutoscroll(roots), 4);
    assert.equal(patchFlashListWebAutoscroll(roots), 0);
    for (const root of roots) {
        const pkg = path.join(root, '@shopify/flash-list');
        for (const file of files) assert.match(fs.readFileSync(path.join(pkg, file), 'utf8'), /const followTop/);
        assert.equal(fs.readFileSync(path.join(pkg, 'package.json'), 'utf8'), '{"name":"@shopify/flash-list","version":"2.3.1"}');
    }
});

test('rejects drift, duplicate or partial patches before writing any entrypoint', t => {
    for (const source of [fixture + fixture, fixture.replace('const diff', 'let diff'),
        patchSource(fixture).replace('Platform.OS === "web"', 'Platform.OS === "ios"')]) {
        assert.throws(() => patchSource(source), /Unexpected FlashList/);
    }
    const roots = installation(t);
    const pkg = path.join(roots[0], '@shopify/flash-list');
    fs.writeFileSync(path.join(pkg, files[1]), 'upstream changed');
    assert.throws(() => patchFlashListWebAutoscroll(roots), /Unexpected FlashList/);
    assert.equal(fs.readFileSync(path.join(pkg, files[0]), 'utf8'), fixture);
    assert.equal(patchFlashListWebAutoscroll([path.join(roots[0], 'missing')]), 0);
});

function controller(source, { platform = 'web', offset = 0, threshold = 200, horizontal = false } = {}) {
    const scrolls = [], anchors = [], updates = [];
    let data = ['anchor', 'older'], shift = 0;
    const manager = {
        props: { horizontal, data, maintainVisibleContentPosition: { autoscrollToTopThreshold: threshold } },
        getDataLength: () => data.length,
        getIsFirstLayoutComplete: () => true,
        hasStableDataKeys: () => true,
        shouldMaintainVisibleContentPosition: () => true,
        computeVisibleIndices: () => ({ startIndex: 0 }),
        getDataKey: index => data[index],
        getLayout: () => ({ x: shift, y: shift }),
        getEngagedIndices: () => ({ findValue: predicate => data.map((_, i) => i).find(predicate) }),
        getAbsoluteLastScrollOffset: () => offset,
        updateScrollOffset: next => { updates.push(next); offset = next; },
    };
    const context = {
        exports: {},
        require: name => {
            if (name === 'react') return {
                useRef: current => ({ current }), useState: initial => [initial, () => {}],
                useCallback: callback => callback, useMemo: callback => callback(), useImperativeHandle: () => {},
            };
            if (name === 'react-native') return { I18nManager: { isRTL: false }, Platform: { OS: platform } };
            if (name.endsWith('/PlatformHelper')) return { PlatformConfig: { supportsOffsetCorrection: platform !== 'web' } };
            if (name.endsWith('/useUnmountFlag')) return { useUnmountFlag: () => ({ current: false }) };
            if (name.endsWith('/useUnmountAwareCallbacks')) return { useUnmountAwareTimeout: () => ({ setTimeout: () => {} }) };
            if (name.endsWith('/adjustOffsetForRTL') || name.endsWith('/WarningMessages')) return {};
            throw new Error(`Unexpected import: ${name}`);
        },
    };
    vm.runInNewContext(ts.transpileModule(patchSource(source), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, context);
    const hook = context.exports.useRecyclerViewController(manager, null,
        { current: { scrollTo: params => scrolls.push({ ...params }) } },
        { current: { scrollBy: diff => anchors.push(diff) } });
    hook.computeFirstVisibleIndexForOffsetCorrection();
    return {
        scrolls, anchors, updates,
        change(height, prepend = true) {
            if (prepend) { data = [`new-${data.length}`, ...data]; manager.props.data = data; }
            shift += height;
            hook.applyOffsetCorrection();
        },
    };
}

for (const file of files) {
    // Execute the installed controller, including its anchor/scroll-offset
    // bookkeeping, rather than a copy of the patched arithmetic.
    const source = fs.readFileSync(path.join(__dirname, '../node_modules/@shopify/flash-list', file), 'utf8');
    test(`${file}: tall prepends and bursts stay at the newest message`, () => {
        const chat = controller(source);
        for (const height of [450, 72, 72, 350]) chat.change(height);
        assert.deepEqual(chat.scrolls, []);
        assert.deepEqual(chat.updates, []);
    });
    test(`${file}: checks the pre-update offset, in points, including the threshold boundary`, () => {
        for (const offset of [1, 100, 200]) {
            const chat = controller(source, { offset });
            chat.change(450);
            assert.deepEqual(chat.scrolls, [{ y: 0, animated: false }]);
            assert.deepEqual(chat.updates, [0]);
        }
    });
    test(`${file}: preserves the reader's anchor in history and when no threshold is enabled`, () => {
        for (const options of [{ offset: 201 }, { offset: 900 }, { offset: 1, threshold: null }, { offset: 1, threshold: -1 }, { offset: 1, threshold: 0 }]) {
            const chat = controller(source, options);
            chat.change(350);
            assert.deepEqual(chat.scrolls, [{ y: options.offset + 350, animated: false }]);
            assert.deepEqual(chat.updates, [options.offset + 350]);
        }
    });
    test(`${file}: same-length streaming updates follow near the newest message`, () => {
        const chat = controller(source, { offset: 40 });
        chat.change(300, false);
        assert.deepEqual(chat.scrolls, [{ y: 0, animated: false }]);
    });
    test(`${file}: unrelated layouts do not pull a nearby reader back to the newest message`, () => {
        const chat = controller(source, { offset: 100 });
        chat.change(0, false);
        assert.deepEqual(chat.scrolls, []);
        assert.deepEqual(chat.updates, []);
    });
    test(`${file}: leaves native and horizontal offset corrections intact`, () => {
        for (const platform of ['ios', 'android']) {
            const chat = controller(source, { platform });
            chat.change(350);
            assert.deepEqual(chat.anchors, [350]);
            assert.deepEqual(chat.updates, [350]);
            assert.deepEqual(chat.scrolls, []);
        }
        const chat = controller(source, { horizontal: true });
        chat.change(350);
        assert.deepEqual(chat.scrolls, [{ x: 350, animated: false }]);
        assert.deepEqual(chat.updates, [350]);
    });
}
