import * as React from 'react';
import { Keyboard, Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { AgentFormCommunication } from '@/sync/agentCommunications';
import { t } from '@/text';
import { InlineQuestionForm, type InlineQuestionAnswers } from './InlineQuestionForm';

interface RequestUserInputCardProps {
    communication: AgentFormCommunication;
    canInteract: boolean;
    onSubmit: (answers: InlineQuestionAnswers) => Promise<void>;
    onCancel: () => Promise<void>;
}

/** The same question card is used on web, desktop, and native mobile. */
export function RequestUserInputCard({ communication, canInteract, onSubmit, onCancel }: RequestUserInputCardProps) {
    const { theme } = useUnistyles();
    const [expanded, setExpanded] = React.useState(communication.status === 'pending');
    const [localResult, setLocalResult] = React.useState<{
        status: 'answered' | 'cancelled';
        answers: InlineQuestionAnswers;
    } | null>(null);
    const status = communication.status === 'pending' ? localResult?.status ?? 'pending' : communication.status;

    // An answer from another device also resolves this card. It can still be
    // opened afterwards to review the questions and answers.
    React.useEffect(() => {
        if (status !== 'pending') setExpanded(false);
    }, [status]);

    const submittedAnswers = React.useMemo<InlineQuestionAnswers | null>(() => {
        if (communication.status === 'pending') return localResult?.answers ?? null;
        const answers: InlineQuestionAnswers = {};
        for (const [id, answer] of Object.entries(communication.answers ?? {})) {
            answers[id] = [...answer.options, ...(answer.custom ? [answer.custom] : [])];
        }
        return answers;
    }, [communication.status, communication.answers, localResult]);

    const title = communication.questions.map(question => question.header).filter(Boolean).join(' · ') || t('agentQuestion.title');
    const statusText = status === 'pending'
        ? t('agentQuestion.waitingForAnswer')
        : status === 'answered' ? t('agentQuestion.answered') : t('agentQuestion.cancelled');

    return (
        <View style={styles.card}>
            <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${expanded ? t('agentQuestion.collapse') : t('agentQuestion.expand')}: ${title}. ${statusText}`}
                accessibilityState={{ expanded }}
                aria-expanded={expanded}
                onPress={() => {
                    if (expanded) Keyboard.dismiss();
                    setExpanded(value => !value);
                }}
                style={styles.header}
            >
                <Ionicons
                    name={status === 'pending' ? 'help-circle-outline' : status === 'answered' ? 'checkmark-circle-outline' : 'remove-circle-outline'}
                    size={22}
                    color={status === 'pending' ? theme.colors.textLink : theme.colors.textSecondary}
                />
                <View style={styles.heading}>
                    <Text style={styles.title} numberOfLines={2}>{title}</Text>
                    <Text accessibilityLiveRegion="polite" style={[styles.status, status === 'pending' && styles.pending]}>{statusText}</Text>
                    {!expanded && (
                        <Text style={styles.summary} numberOfLines={2}>{communication.questions[0]?.question}</Text>
                    )}
                </View>
                <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={20} color={theme.colors.textSecondary} />
            </Pressable>

            {/* Keep the form mounted so folding never discards a draft or retry.
                Hidden controls must also leave keyboard and screen-reader navigation. */}
            <View
                style={expanded ? styles.body : styles.hidden}
                accessibilityElementsHidden={!expanded}
                aria-hidden={!expanded}
                importantForAccessibility={expanded ? 'auto' : 'no-hide-descendants'}
            >
                <InlineQuestionForm
                    questions={communication.questions}
                    canInteract={canInteract && status === 'pending'}
                    submittedAnswers={submittedAnswers}
                    showSubmittedQuestions
                    onSubmit={async answers => {
                        await onSubmit(answers);
                        setLocalResult({ status: 'answered', answers });
                    }}
                    onCancel={async () => {
                        await onCancel();
                        setLocalResult({ status: 'cancelled', answers: {} });
                    }}
                />
            </View>
        </View>
    );
}

const styles = StyleSheet.create(theme => ({
    card: {
        backgroundColor: theme.colors.surfaceHigh,
        borderRadius: 12,
        marginVertical: 8,
        overflow: 'hidden',
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        minHeight: 56,
        padding: 12,
        backgroundColor: theme.colors.surfaceHighest,
    },
    heading: { flex: 1, minWidth: 0, gap: 3 },
    title: { fontSize: 14, fontWeight: '600', color: theme.colors.text },
    status: { fontSize: 12, color: theme.colors.textSecondary },
    pending: { color: theme.colors.textLink },
    summary: { fontSize: 13, lineHeight: 18, color: theme.colors.textSecondary },
    body: { paddingHorizontal: 12, paddingTop: 12 },
    hidden: { display: 'none' },
}));
