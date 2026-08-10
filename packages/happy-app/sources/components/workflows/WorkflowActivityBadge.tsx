import * as React from 'react';
import { Animated, Pressable, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { getWorkflowBadgeModel } from './workflowModel';

type WorkflowActivityBadgeProps = {
    count: number;
    onPress: () => void;
};

const stylesheet = StyleSheet.create((theme) => ({
    badge: {
        minHeight: 28,
        paddingHorizontal: 9,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.warning,
        borderRadius: 999,
        backgroundColor: `${theme.colors.warning}1F`,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    dot: {
        width: 7,
        height: 7,
        borderRadius: 4,
        backgroundColor: theme.colors.warning,
    },
    label: {
        color: theme.colors.warning,
        fontSize: 12,
        lineHeight: 16,
        ...Typography.default('semiBold'),
    },
}));

export const WorkflowActivityBadge = React.memo(function WorkflowActivityBadge({
    count,
    onPress,
}: WorkflowActivityBadgeProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const model = getWorkflowBadgeModel(count);
    const pulseOpacity = React.useRef(new Animated.Value(0.45)).current;
    const activeCount = model?.count ?? 0;

    React.useEffect(() => {
        if (activeCount <= 0) {
            pulseOpacity.stopAnimation();
            pulseOpacity.setValue(0.45);
            return;
        }

        const pulse = Animated.loop(
            Animated.sequence([
                Animated.timing(pulseOpacity, {
                    toValue: 1,
                    duration: 650,
                    useNativeDriver: true,
                }),
                Animated.timing(pulseOpacity, {
                    toValue: 0.45,
                    duration: 650,
                    useNativeDriver: true,
                }),
            ]),
        );

        pulse.start();
        return () => pulse.stop();
    }, [activeCount, pulseOpacity]);

    if (!model) {
        return null;
    }

    return (
        <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('workflows.badgeAccessibility', { count: model.count })}
            hitSlop={8}
            onPress={onPress}
            style={({ pressed }) => [styles.badge, { opacity: pressed ? 0.72 : 1 }]}
        >
            <Animated.View style={[styles.dot, { backgroundColor: theme.colors.warning, opacity: pulseOpacity }]} />
            <View>
                <Text numberOfLines={1} style={styles.label}>
                    {t('workflows.workflowCount', { count: model.count })}
                </Text>
            </View>
        </Pressable>
    );
});
