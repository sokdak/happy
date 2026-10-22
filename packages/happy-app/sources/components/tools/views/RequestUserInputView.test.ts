import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentFormCommunication } from '@/sync/agentCommunications';

const state = vi.hoisted(() => ({ communication: null as AgentFormCommunication | null }));
const ops = vi.hoisted(() => ({ sessionAnswerQuestion: vi.fn(), sessionCancelCommunication: vi.fn() }));
vi.mock('@/sync/ops', () => ops);
vi.mock('@/sync/storage', () => ({ useSessionAgentFormCommunication: () => state.communication }));
vi.mock('react-native', async () => {
    const react = await import('react');
    const host = (name: string) => (props: any) => react.createElement(name, props, props.children);
    return {
        Platform: { OS: 'web', select: (choices: any) => choices.web ?? choices.default },
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

    it('keeps text-only pending forms in the modal and shows their completed answer in chat', () => {
        state.communication!.questions[0].options = [];
        renderQuestion();
        expect(renderer!.toJSON()).toBeNull();
        state.communication = {
            ...state.communication!, status: 'answered', answers: { storage: { options: [], custom: 'Remote storage' } },
        };
        act(() => renderer!.update(React.createElement(RequestUserInputView, {
            sessionId: 'session', tool: { callId: 'call', name: 'request_user_input', state: 'completed' },
        } as any)));
        expect(JSON.stringify(renderer!.toJSON())).toContain('Remote storage');
    });
});
