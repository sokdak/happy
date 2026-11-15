import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentFormCommunication } from '@/sync/agentCommunications';

const state = vi.hoisted(() => ({ communication: null as AgentFormCommunication | null, platform: 'web' }));
const ops = vi.hoisted(() => ({ sessionAnswerQuestion: vi.fn(), sessionCancelCommunication: vi.fn() }));
vi.mock('@/sync/ops', () => ops);
vi.mock('@/sync/storage', () => ({ useSessionAgentFormCommunication: () => state.communication }));
vi.mock('react-native', async () => {
    const react = await import('react');
    const host = (name: string) => (props: any) => react.createElement(name, props, props.children);
    return {
        Platform: { get OS() { return state.platform; }, select: (choices: any) => choices[state.platform] ?? choices.default },
        Keyboard: { dismiss: vi.fn() }, Pressable: host('Pressable'),
        ActivityIndicator: host('ActivityIndicator'), Text: host('Text'), TextInput: host('TextInput'),
        TouchableOpacity: host('TouchableOpacity'), View: host('View'),
    };
});
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('react-native-unistyles', () => {
    const theme = { colors: { button: { primary: {} }, radio: {} } };
    return { StyleSheet: { create: (factory: any) => factory(theme) }, useUnistyles: () => ({ theme }) };
});

import { RequestUserInputView } from './RequestUserInputView';

let renderer: ReturnType<typeof create> | undefined;
const originalConsoleError = console.error;
beforeAll(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    vi.spyOn(console, 'error').mockImplementation((message: unknown, ...args: unknown[]) => {
        if (typeof message === 'string' && message.startsWith('react-test-renderer is deprecated')) return;
        if (message === 'Failed to submit question answer:') return;
        originalConsoleError(message, ...args);
    });
});
afterAll(() => vi.restoreAllMocks());
afterEach(() => { if (renderer) act(() => renderer.unmount()); renderer = undefined; });
beforeEach(() => {
    ops.sessionAnswerQuestion.mockReset().mockResolvedValue(undefined);
    ops.sessionCancelCommunication.mockReset().mockResolvedValue(undefined);
    state.platform = 'web';
    state.communication = {
        id: 'communication', toolUseId: 'call', kind: 'form', status: 'pending', createdAt: 1,
        questions: [{ id: 'storage', header: 'Storage', question: 'Where?', options: [{ label: 'Local' }, { label: 'Cloud' }], allowCustom: true }],
    };
});

function renderQuestion() {
    act(() => { renderer = create(React.createElement(RequestUserInputView, {
        sessionId: 'session', tool: { callId: 'call', name: 'request_user_input', state: 'running' },
    } as any)); });
}
function button(label: string) {
    return renderer!.root.findAllByType('TouchableOpacity').find((node: any) => (
        node.findAllByType('Text').some((text: any) => text.props.children === label)
    ));
}

describe('Codex question card', () => {
    it('enables Submit after choosing an answer and sends the communication id and original question id', async () => {
        renderQuestion();
        expect(button('tools.askUserQuestion.submit').props.disabled).toBe(true);
        act(() => button('Cloud').props.onPress());
        expect(button('tools.askUserQuestion.submit').props.disabled).toBe(false);
        await act(async () => { await button('tools.askUserQuestion.submit').props.onPress(); });
        expect(ops.sessionAnswerQuestion).toHaveBeenCalledWith('session', 'communication', { storage: { options: ['Cloud'] } }, 'form');
        expect(button('tools.askUserQuestion.submit')).toBeUndefined();
    });

    it('lets the user replace a selection with a written answer', async () => {
        renderQuestion();
        act(() => button('Local').props.onPress());
        act(() => renderer!.root.findByType('TextInput').props.onChangeText(' Some other location '));
        await act(async () => { await button('tools.askUserQuestion.submit').props.onPress(); });
        expect(ops.sessionAnswerQuestion).toHaveBeenCalledWith('session', 'communication', { storage: { options: [], custom: 'Some other location' } }, 'form');
    });

    it('keeps the form editable when submission fails and allows a retry', async () => {
        ops.sessionAnswerQuestion.mockRejectedValueOnce(new Error('Disconnected'));
        renderQuestion();
        act(() => button('Local').props.onPress());
        await act(async () => { await button('tools.askUserQuestion.submit').props.onPress(); });
        expect(button('tools.askUserQuestion.submit').props.disabled).toBe(false);
        expect(renderer!.root.findAllByType('Text').some((node: any) => node.props.children === 'agentQuestion.submitFailed')).toBe(true);
        await act(async () => { await button('tools.askUserQuestion.submit').props.onPress(); });
        expect(ops.sessionAnswerQuestion).toHaveBeenCalledTimes(2);
    });

    it('dismisses the request without requiring an answer', async () => {
        renderQuestion();
        await act(async () => { await button('common.cancel').props.onPress(); });
        expect(ops.sessionCancelCommunication).toHaveBeenCalledWith('session', 'communication', 'form');
        expect(ops.sessionAnswerQuestion).not.toHaveBeenCalled();
    });

    it('masks secret input and its submitted value', async () => {
        state.communication!.questions[0].isSecret = true;
        renderQuestion();
        expect(renderer!.root.findByType('TextInput').props.secureTextEntry).toBe(true);
        act(() => renderer!.root.findByType('TextInput').props.onChangeText('secret-value'));
        await act(async () => { await button('tools.askUserQuestion.submit').props.onPress(); });
        expect(JSON.stringify(renderer!.toJSON())).not.toContain('secret-value');
        expect(JSON.stringify(renderer!.toJSON())).toContain('••••••');
    });

    it('renders text-only questions inline and shows their completed answer in chat', () => {
        state.communication!.questions[0].options = [];
        renderQuestion();
        expect(renderer!.root.findByType('TextInput').props.editable).toBe(true);
        state.communication = {
            ...state.communication!, status: 'answered', answers: { storage: { options: [], custom: 'Remote storage' } },
        };
        act(() => renderer!.update(React.createElement(RequestUserInputView, {
            sessionId: 'session', tool: { callId: 'call', name: 'request_user_input', state: 'completed' },
        } as any)));
        expect(JSON.stringify(renderer!.toJSON())).toContain('Remote storage');
    });

    it.each(['web', 'ios', 'android'])('folds without resolving the question or losing selections and custom text on %s', platform => {
        state.platform = platform;
        state.communication!.questions.push({
            id: 'details', header: 'Details', question: 'Anything else?', options: [], allowCustom: true,
        });
        renderQuestion();
        act(() => button('Cloud').props.onPress());
        act(() => renderer!.root.findAllByType('TextInput')[1].props.onChangeText('Keep offline support'));
        act(() => renderer!.root.findByType('Pressable').props.onPress());
        expect(renderer!.root.findByType('Pressable').props.accessibilityState).toEqual({ expanded: false });
        expect(renderer!.root.findByType('Pressable').props['aria-expanded']).toBe(false);
        const hidden = renderer!.root.findAllByType('View').find((node: any) => node.props.importantForAccessibility === 'no-hide-descendants');
        expect(hidden!.props.style).toEqual({ display: 'none' });
        expect(hidden!.props.accessibilityElementsHidden).toBe(true);
        expect(ops.sessionAnswerQuestion).not.toHaveBeenCalled();
        expect(ops.sessionCancelCommunication).not.toHaveBeenCalled();
        act(() => renderer!.root.findByType('Pressable').props.onPress());
        expect(renderer!.root.findByType('Pressable').props.accessibilityState).toEqual({ expanded: true });
        expect(renderer!.root.findByType('Pressable').props['aria-expanded']).toBe(true);
        expect(renderer!.root.findAllByType('TextInput')[1].props.value).toBe('Keep offline support');
        expect(button('tools.askUserQuestion.submit').props.disabled).toBe(false);
    });

    it('collapses after a successful answer and allows reviewing it without resubmitting', async () => {
        renderQuestion();
        act(() => button('Cloud').props.onPress());
        await act(async () => { await button('tools.askUserQuestion.submit').props.onPress(); });
        expect(renderer!.root.findByType('Pressable').props.accessibilityState.expanded).toBe(false);
        expect(JSON.stringify(renderer!.toJSON())).toContain('agentQuestion.answered');
        act(() => renderer!.root.findByType('Pressable').props.onPress());
        expect(renderer!.root.findByType('Pressable').props.accessibilityState.expanded).toBe(true);
        expect(JSON.stringify(renderer!.toJSON())).toContain('Cloud');
        expect(button('tools.askUserQuestion.submit')).toBeUndefined();
        expect(ops.sessionAnswerQuestion).toHaveBeenCalledTimes(1);
    });

    it('keeps errors and drafts when folded, then permits retrying', async () => {
        ops.sessionAnswerQuestion.mockRejectedValueOnce(new Error('Disconnected'));
        renderQuestion();
        act(() => renderer!.root.findByType('TextInput').props.onChangeText('A custom location'));
        await act(async () => { await button('tools.askUserQuestion.submit').props.onPress(); });
        act(() => renderer!.root.findByType('Pressable').props.onPress());
        act(() => renderer!.root.findByType('Pressable').props.onPress());
        expect(renderer!.root.findByType('TextInput').props.value).toBe('A custom location');
        expect(JSON.stringify(renderer!.toJSON())).toContain('agentQuestion.submitFailed');
        await act(async () => { await button('tools.askUserQuestion.submit').props.onPress(); });
        expect(ops.sessionAnswerQuestion).toHaveBeenCalledTimes(2);
    });

    it('resolves a folded card when another device answers and resets for a new request', () => {
        renderQuestion();
        act(() => renderer!.root.findByType('TextInput').props.onChangeText('Old draft'));
        act(() => renderer!.root.findByType('Pressable').props.onPress());
        state.communication = { ...state.communication!, status: 'answered', answers: { storage: { options: ['Cloud'] } } };
        renderQuestionUpdate();
        expect(JSON.stringify(renderer!.toJSON())).toContain('agentQuestion.answered');
        act(() => renderer!.root.findByType('Pressable').props.onPress());
        expect(button('tools.askUserQuestion.submit')).toBeUndefined();
        state.communication = { ...state.communication!, id: 'next-request', status: 'pending', answers: undefined };
        renderQuestionUpdate();
        expect(renderer!.root.findByType('Pressable').props.accessibilityState.expanded).toBe(true);
        expect(renderer!.root.findByType('TextInput').props.value).toBe('');
    });
});

function renderQuestionUpdate() {
    act(() => renderer!.update(React.createElement(RequestUserInputView, {
        sessionId: 'session', tool: { callId: 'call', name: 'request_user_input', state: 'running' },
    } as any)));
}
