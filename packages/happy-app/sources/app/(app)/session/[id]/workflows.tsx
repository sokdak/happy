import * as React from 'react';
import { ActivityIndicator, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';
import { WorkflowPanel } from '@/components/workflows/WorkflowPanel';
import { selectActiveWorkflows } from '@/components/workflows/workflowModel';
import { useIsDataReady, useSession } from '@/sync/storage';

export default React.memo(function WorkflowsScreen() {
    const { id } = useLocalSearchParams<{ id: string }>();
    const router = useRouter();
    const isDataReady = useIsDataReady();
    const session = useSession(id);
    const { theme } = useUnistyles();
    const workflows = React.useMemo(
        () => selectActiveWorkflows(session?.agentState?.activeWorkflows),
        [session?.agentState?.activeWorkflows],
    );

    React.useEffect(() => {
        if (isDataReady && workflows.length === 0) {
            router.replace(`/session/${id}`);
        }
    }, [id, isDataReady, router, workflows.length]);

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
