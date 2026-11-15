import * as React from 'react';

import { sessionAnswerQuestion, sessionCancelCommunication } from '@/sync/ops';
import { useSessionAgentFormCommunication } from '@/sync/storage';
import { canRenderAgentFormInline } from '@/sync/agentCommunications';
import type { AgentQuestionAnswer } from '@/sync/storageTypes';
import { ToolViewProps } from './_all';
import type { InlineQuestionAnswers } from './InlineQuestionForm';
import { RequestUserInputCard } from './RequestUserInputCard';

/** Inline renderer for Happy/Codex request_user_input communications. */
export const RequestUserInputView = React.memo<ToolViewProps>(({ tool, sessionId }) => {
    const communication = useSessionAgentFormCommunication(sessionId ?? '', tool.callId ?? '');

    const handleSubmit = React.useCallback(async (answers: InlineQuestionAnswers) => {
        if (!sessionId || !communication || communication.status !== 'pending') return;

        const communicationAnswers: Record<string, AgentQuestionAnswer> = {};
        for (const question of communication.questions) {
            const selected = answers[question.id];
            if (!selected?.length) continue;
            const options = selected.filter(value => question.options.some(option => option.label === value));
            const custom = selected.filter(value => !question.options.some(option => option.label === value)).join('\n');
            communicationAnswers[question.id] = {
                options: question.multiSelect
                    ? options
                    : options.slice(0, 1),
                ...(custom ? { custom } : {}),
            };
        }
        await sessionAnswerQuestion(sessionId, communication.id, communicationAnswers, communication.kind);
    }, [communication, sessionId]);

    const handleCancel = React.useCallback(async () => {
        if (!sessionId || !communication || communication.status !== 'pending') return;
        await sessionCancelCommunication(sessionId, communication.id, communication.kind);
    }, [communication, sessionId]);

    if (!communication || (communication.status === 'pending' && !canRenderAgentFormInline(communication))) return null;

    return (
        <RequestUserInputCard
            key={communication.id}
            communication={communication}
            canInteract={Boolean(sessionId) && tool.state === 'running'}
            onSubmit={handleSubmit}
            onCancel={handleCancel}
        />
    );
});
