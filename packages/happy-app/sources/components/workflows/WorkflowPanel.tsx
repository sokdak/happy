import { Ionicons } from '@expo/vector-icons';
import * as React from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import type { ActiveWorkflowSnapshot } from '@/sync/storageTypes';
import { t } from '@/text';
import {
    formatWorkflowElapsed,
    formatWorkflowTokens,
    getPhaseVisualState,
    normalizeWorkflowAgentState,
    type WorkflowVisualState,
} from './workflowModel';

type WorkflowPanelProps = {
    workflows: ActiveWorkflowSnapshot[];
    onClose?: () => void;
    showHeader?: boolean;
};

type WorkflowStateColors = {
    warning: string;
    success: string;
    warningCritical: string;
    textSecondary: string;
};

function getStateLabel(state: WorkflowVisualState): string {
    switch (state) {
        case 'running':
            return t('workflows.states.running');
        case 'completed':
            return t('workflows.states.completed');
        case 'error':
            return t('workflows.states.error');
        case 'active':
            return t('workflows.states.active');
        default: {
            const exhaustiveState: never = state;
            return exhaustiveState;
        }
    }
}

function getStateColor(state: WorkflowVisualState, colors: WorkflowStateColors): string {
    switch (state) {
        case 'running':
            return colors.warning;
        case 'completed':
            return colors.success;
        case 'error':
            return colors.warningCritical;
        case 'active':
            return colors.textSecondary;
        default: {
            const exhaustiveState: never = state;
            return exhaustiveState;
        }
    }
}

const stylesheet = StyleSheet.create((theme) => ({
    root: {
        flex: 1,
        backgroundColor: theme.colors.surface,
        borderLeftWidth: StyleSheet.hairlineWidth,
        borderLeftColor: theme.colors.divider,
    },
    header: {
        height: 54,
        paddingHorizontal: 16,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.divider,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
    },
    headerText: {
        flex: 1,
        minWidth: 0,
    },
    headerTitle: {
        color: theme.colors.text,
        fontSize: 15,
        lineHeight: 20,
        ...Typography.default('semiBold'),
    },
    count: {
        color: theme.colors.textSecondary,
        fontSize: 11,
        lineHeight: 14,
        marginTop: 2,
        ...Typography.default(),
    },
    closeButton: {
        width: 32,
        height: 32,
        alignItems: 'center',
        justifyContent: 'center',
    },
    content: {
        padding: 12,
        gap: 12,
    },
    card: {
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
        borderRadius: 12,
        backgroundColor: theme.colors.surfaceHigh,
        overflow: 'hidden',
    },
    workflowHeader: {
        padding: 12,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.divider,
    },
    titleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 7,
    },
    dot: {
        width: 7,
        height: 7,
        borderRadius: 4,
        flexShrink: 0,
    },
    workflowTitle: {
        flex: 1,
        minWidth: 0,
        color: theme.colors.text,
        fontSize: 14,
        lineHeight: 19,
        ...Typography.default('semiBold'),
    },
    elapsed: {
        marginLeft: 'auto',
        color: theme.colors.textSecondary,
        fontSize: 11,
        lineHeight: 14,
        ...Typography.mono(),
    },
    description: {
        marginTop: 6,
        marginLeft: 14,
        color: theme.colors.textSecondary,
        fontSize: 12,
        lineHeight: 17,
        ...Typography.default(),
    },
    usageRow: {
        marginTop: 9,
        marginLeft: 14,
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 10,
    },
    usage: {
        color: theme.colors.textSecondary,
        fontSize: 11,
        lineHeight: 14,
        ...Typography.default(),
    },
    phase: {
        padding: 12,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.divider,
    },
    phaseTitleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 7,
    },
    phaseIndex: {
        width: 20,
        height: 20,
        borderRadius: 6,
        alignItems: 'center',
        justifyContent: 'center',
    },
    phaseIndexText: {
        fontSize: 11,
        lineHeight: 14,
        ...Typography.mono('semiBold'),
    },
    phaseTitle: {
        flex: 1,
        minWidth: 0,
        color: theme.colors.text,
        fontSize: 13,
        lineHeight: 18,
        ...Typography.default('semiBold'),
    },
    state: {
        marginLeft: 'auto',
        fontSize: 11,
        lineHeight: 14,
        ...Typography.default(),
    },
    agent: {
        marginTop: 10,
        marginLeft: 8,
        paddingLeft: 14,
        borderLeftWidth: StyleSheet.hairlineWidth,
        borderLeftColor: theme.colors.divider,
    },
    agentRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 7,
    },
    agentLabel: {
        flex: 1,
        minWidth: 0,
        color: theme.colors.text,
        fontSize: 12,
        lineHeight: 17,
        ...Typography.default(),
    },
    model: {
        maxWidth: '38%',
        color: theme.colors.textSecondary,
        fontSize: 10,
        lineHeight: 14,
        ...Typography.mono(),
    },
    srState: {
        color: theme.colors.textSecondary,
        fontSize: 10,
        lineHeight: 14,
        ...Typography.default(),
    },
    tool: {
        marginTop: 7,
        padding: 8,
        borderRadius: 6,
        backgroundColor: theme.colors.surface,
        color: theme.colors.textSecondary,
        fontSize: 10,
        lineHeight: 14,
        ...Typography.mono(),
    },
    footer: {
        paddingVertical: 2,
        color: theme.colors.textSecondary,
        fontSize: 12,
        lineHeight: 17,
        textAlign: 'center',
        ...Typography.default(),
    },
}));

export const WorkflowPanel = React.memo(function WorkflowPanel({
    workflows,
    onClose,
    showHeader = true,
}: WorkflowPanelProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const [now, setNow] = React.useState(() => Date.now());

    React.useEffect(() => {
        if (workflows.length === 0) {
            return;
        }

        const interval = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(interval);
    }, [workflows.length]);

    if (workflows.length === 0) {
        return null;
    }

    return (
        <View style={styles.root}>
            {showHeader !== false && (
                <View style={styles.header}>
                    <View style={styles.headerText}>
                        <Text style={styles.headerTitle} numberOfLines={1}>
                            {t('workflows.activeTitle')}
                        </Text>
                        <Text style={styles.count} numberOfLines={1}>
                            {t('workflows.runningCount', { count: workflows.length })}
                        </Text>
                    </View>
                    {onClose && (
                        <Pressable
                            accessibilityRole="button"
                            accessibilityLabel={t('workflows.closeMonitor')}
                            hitSlop={8}
                            onPress={onClose}
                            style={({ pressed }) => [styles.closeButton, { opacity: pressed ? 0.72 : 1 }]}
                        >
                            <Ionicons name="close" size={20} color={theme.colors.textSecondary} />
                        </Pressable>
                    )}
                </View>
            )}

            <ScrollView contentContainerStyle={styles.content}>
                {workflows.map((workflow) => {
                    const usageItems = [
                        workflow.usage?.totalTokens === undefined
                            ? undefined
                            : t('workflows.tokens', { count: formatWorkflowTokens(workflow.usage.totalTokens) }),
                        workflow.usage?.toolUses === undefined
                            ? undefined
                            : t('workflows.toolCalls', { count: workflow.usage.toolUses }),
                        workflow.usage?.durationMs === undefined
                            ? undefined
                            : formatWorkflowElapsed(0, workflow.usage.durationMs),
                    ].filter((item): item is string => item !== undefined);

                    return (
                        <View key={workflow.taskId} style={styles.card}>
                            <View style={styles.workflowHeader}>
                                <View style={styles.titleRow}>
                                    <View style={[styles.dot, { backgroundColor: theme.colors.warning }]} />
                                    <Text style={styles.workflowTitle} numberOfLines={1}>
                                        {workflow.name}
                                    </Text>
                                    <Text style={styles.elapsed} numberOfLines={1}>
                                        {formatWorkflowElapsed(workflow.startedAt, now)}
                                    </Text>
                                </View>
                                {workflow.description && (
                                    <Text style={styles.description} numberOfLines={2}>
                                        {workflow.description}
                                    </Text>
                                )}
                                {usageItems.length > 0 && (
                                    <View style={styles.usageRow}>
                                        {usageItems.map((item) => (
                                            <Text key={item} style={styles.usage} numberOfLines={1}>
                                                {item}
                                            </Text>
                                        ))}
                                    </View>
                                )}
                            </View>

                            {workflow.phases.map((phase) => {
                                const phaseState = getPhaseVisualState(phase);
                                const phaseColor = getStateColor(phaseState, theme.colors);
                                const phaseLabel = getStateLabel(phaseState);
                                const phaseTitle = phase.index < 0 ? t('workflows.otherPhase') : phase.title;

                                return (
                                    <View
                                        key={`${workflow.taskId}:${phase.index}`}
                                        style={styles.phase}
                                    >
                                        <View
                                            accessible
                                            accessibilityLabel={t('workflows.phaseAccessibility', {
                                                title: phaseTitle,
                                                state: phaseLabel,
                                            })}
                                            style={styles.phaseTitleRow}
                                        >
                                            <View style={[styles.phaseIndex, { backgroundColor: `${phaseColor}1F` }]}>
                                                <Text style={[styles.phaseIndexText, { color: phaseColor }]}>
                                                    {phase.index < 0 ? '–' : phase.index}
                                                </Text>
                                            </View>
                                            <Text style={styles.phaseTitle} numberOfLines={2}>
                                                {phaseTitle}
                                            </Text>
                                            <Text style={[styles.state, { color: phaseColor }]} numberOfLines={1}>
                                                {phaseLabel}
                                            </Text>
                                        </View>

                                        {phase.agents.map((agent) => {
                                            const agentState = normalizeWorkflowAgentState(agent.state);
                                            const agentColor = getStateColor(agentState, theme.colors);
                                            const agentLabel = getStateLabel(agentState);
                                            const toolSummary = [agent.lastToolName, agent.lastToolSummary]
                                                .filter((value): value is string => Boolean(value))
                                                .join(' · ');

                                            return (
                                                <View
                                                    key={agent.id}
                                                    style={styles.agent}
                                                >
                                                    <View
                                                        accessible
                                                        accessibilityLabel={t('workflows.agentAccessibility', {
                                                            label: agent.label,
                                                            state: agentLabel,
                                                        })}
                                                        style={styles.agentRow}
                                                    >
                                                        <View style={[styles.dot, { backgroundColor: agentColor }]} />
                                                        <Text style={styles.agentLabel} numberOfLines={1}>
                                                            {agent.label}
                                                        </Text>
                                                        {agent.model && (
                                                            <Text style={styles.model} numberOfLines={1}>
                                                                {agent.model}
                                                            </Text>
                                                        )}
                                                        <Text style={[styles.srState, { color: agentColor }]} numberOfLines={1}>
                                                            {agentLabel}
                                                        </Text>
                                                    </View>
                                                    {toolSummary && (
                                                        <Text style={styles.tool} numberOfLines={2}>
                                                            {toolSummary}
                                                        </Text>
                                                    )}
                                                </View>
                                            );
                                        })}
                                    </View>
                                );
                            })}
                        </View>
                    );
                })}

                <Text style={styles.footer}>{t('workflows.dismissAutomatically')}</Text>
            </ScrollView>
        </View>
    );
});
