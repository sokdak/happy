import { describe, expect, it } from 'vitest';
import type { Message } from './typesMessage';
import { mergeMessagesInto } from './messageList';

function message(id: string, createdAt: number): Message {
    return { kind: 'agent-text', id, localId: null, createdAt, text: id } as Message;
}

function seed(messages: Message[]) {
    const lookup: Record<string, Message> = {};
    for (const item of messages) lookup[item.id] = item;
    return {
        current: [...messages].sort((left, right) => right.createdAt - left.createdAt),
        lookup,
    };
}

const ids = (messages: Message[]) => messages.map((item) => item.id);

describe('mergeMessagesInto', () => {
    it('keeps array identity for an empty reducer result', () => {
        const { current, lookup } = seed([message('a', 1)]);
        expect(mergeMessagesInto(current, lookup, [])).toBe(current);
    });

    it('inserts streamed messages in newest-first order', () => {
        const { current, lookup } = seed([message('a', 1), message('c', 3)]);
        expect(ids(mergeMessagesInto(current, lookup, [message('b', 2)])))
            .toEqual(['c', 'b', 'a']);
    });

    it('replaces an updated message without moving or duplicating it', () => {
        const { current, lookup } = seed([message('a', 1), message('b', 2)]);
        const updated = message('b', 2);
        const next = mergeMessagesInto(current, lookup, [updated]);
        expect(ids(next)).toEqual(['b', 'a']);
        expect(next[0]).toBe(updated);
        expect(lookup.b).toBe(updated);
    });

    it('keeps arrival order for equal timestamps', () => {
        const { current, lookup } = seed([message('first', 5)]);
        const second = mergeMessagesInto(current, lookup, [message('second', 5)]);
        const third = mergeMessagesInto(second, lookup, [message('third', 5)]);
        expect(ids(third)).toEqual(['first', 'second', 'third']);
    });

    it('uses a full merge for a large older-history page', () => {
        const existing = [message('e1', 100), message('e2', 101)];
        const { current, lookup } = seed(existing);
        const older = Array.from({ length: 20 }, (_, index) => message(`o${index}`, index));
        const next = mergeMessagesInto(current, lookup, older);
        const expected = [...existing, ...older].sort((left, right) => right.createdAt - left.createdAt);
        expect(ids(next)).toEqual(ids(expected));
    });

    it('re-sorts when an update changes createdAt', () => {
        const { current, lookup } = seed([message('a', 1), message('b', 2), message('c', 3)]);
        expect(ids(mergeMessagesInto(current, lookup, [message('a', 99)])))
            .toEqual(['a', 'c', 'b']);
    });

    it('does not mutate the current array', () => {
        const { current, lookup } = seed([message('a', 1)]);
        const next = mergeMessagesInto(current, lookup, [message('b', 2)]);
        expect(next).not.toBe(current);
        expect(ids(current)).toEqual(['a']);
    });
});
