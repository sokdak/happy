import * as React from 'react';
import { ActivityIndicator, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';
import { WorkflowPanel } from '@/components/workflows/WorkflowPanel';
import { normalizeWorkflowSessionId, selectActiveWorkflows } from '@/components/workflows/workflowModel';
import { useIsDataReady, useSession } from '@/sync/storage';

export default React.memo(function WorkflowsScreen() {
    const { id } = useLocalSearchParams<{ id?: string | string[] }>();
    const sessionId = normalizeWorkflowSessionId(id);
    const router = useRouter();
    const isDataReady = useIsDataReady();
    const session = useSession(sessionId ?? '');
    const { theme } = useUnistyles();
    const sessionHref = sessionId ? `/session/${sessionId}` as const : null;
    const workflows = React.useMemo(
        () => selectActiveWorkflows(session?.agentState?.activeWorkflows),
        [session?.agentState?.activeWorkflows],
    );

    React.useEffect(() => {
        if (isDataReady && sessionHref && workflows.length === 0) {
            router.dismissTo(sessionHref);
        }
    }, [isDataReady, router, sessionHref, workflows.length]);

    if (!sessionId) {
        return null;
    }

    if (!isDataReady) {
        return (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                <ActivityIndicator color={theme.colors.textSecondary} />
            </View>
        );
    }

    if (!session || workflows.length === 0) {
        return null;
    }

    return <WorkflowPanel workflows={workflows} showHeader={false} />;
});
