import { Ionicons } from '@expo/vector-icons';
import * as React from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { WorkflowPanel } from '@/components/workflows/WorkflowPanel';
import {
    getWorkflowRouteContent,
    normalizeWorkflowSessionId,
    selectActiveWorkflows,
} from '@/components/workflows/workflowModel';
import { t } from '@/text';
import { useIsDataReady, useSession } from '@/sync/storage';

const stylesheet = StyleSheet.create((theme) => ({
    centered: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
    },
    empty: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 32,
        gap: 8,
    },
    emptyIcon: {
        marginBottom: 4,
    },
    emptyTitle: {
        color: theme.colors.text,
        fontSize: 16,
        lineHeight: 21,
        textAlign: 'center',
        ...Typography.default('semiBold'),
    },
    emptyDescription: {
        color: theme.colors.textSecondary,
        fontSize: 13,
        lineHeight: 18,
        textAlign: 'center',
        ...Typography.default(),
    },
}));

export default React.memo(function WorkflowsScreen() {
    const { id } = useLocalSearchParams<{ id?: string | string[] }>();
    const sessionId = normalizeWorkflowSessionId(id);
    const isDataReady = useIsDataReady();
    const session = useSession(sessionId ?? '');
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const workflows = React.useMemo(
        () => selectActiveWorkflows(session?.agentState?.activeWorkflows),
        [session?.agentState?.activeWorkflows],
    );

    if (!sessionId) {
        return null;
    }

    const content = getWorkflowRouteContent({
        isDataReady,
        hasSession: Boolean(session),
        activeCount: workflows.length,
    });

    if (content === 'loading') {
        return (
            <View style={styles.centered}>
                <ActivityIndicator color={theme.colors.textSecondary} />
            </View>
        );
    }

    if (content === 'missing-session') {
        return null;
    }

    // The route stays reachable from session info at any time, so an empty
    // workflow list is a normal state that has to explain itself instead of
    // bouncing the user back to chat.
    if (content === 'empty') {
        return (
            <View style={styles.empty}>
                <Ionicons
                    name="git-network-outline"
                    size={48}
                    color={theme.colors.textSecondary}
                    style={styles.emptyIcon}
                />
                <Text style={styles.emptyTitle}>{t('workflows.emptyTitle')}</Text>
                <Text style={styles.emptyDescription}>{t('workflows.emptyDescription')}</Text>
            </View>
        );
    }

    return <WorkflowPanel workflows={workflows} showHeader={false} />;
});
