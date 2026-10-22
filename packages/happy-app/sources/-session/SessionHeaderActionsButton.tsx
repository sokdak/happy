import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { SessionActionsAnchor, SessionActionsPopover } from '@/components/SessionActionsPopover';
import { t } from '@/text';

interface SessionHeaderActionsButtonProps {
    sessionId: string;
}

/**
 * Desktop/web header affordance that opens the session actions popover.
 *
 * Phones reach the same actions through the header avatar (session-info screen); on
 * desktop and web this overflow button is the discoverable entry point. It anchors the
 * popover to its own measured rect, matching the sidebar context-menu behaviour.
 */
export function SessionHeaderActionsButton({ sessionId }: SessionHeaderActionsButtonProps) {
    const { theme } = useUnistyles();
    const buttonRef = React.useRef<View>(null);
    const [anchor, setAnchor] = React.useState<SessionActionsAnchor | null>(null);
    const [hovered, setHovered] = React.useState(false);

    const handlePress = React.useCallback(() => {
        const node = buttonRef.current;
        if (!node || typeof node.measureInWindow !== 'function') {
            setAnchor({ type: 'rect', x: 0, y: 0, width: 0, height: 0 });
            return;
        }
        node.measureInWindow((x, y, width, height) => {
            setAnchor({ type: 'rect', x, y, width, height });
        });
    }, []);

    const handleClose = React.useCallback(() => setAnchor(null), []);

    // Web-only hover events, mirroring the reveal-on-hover idiom used elsewhere (MarkdownView).
    const hoverProps = Platform.OS === 'web' ? {
        onMouseEnter: () => setHovered(true),
        onMouseLeave: () => setHovered(false),
    } : {};

    return (
        <>
            <Pressable
                ref={buttonRef}
                accessibilityRole="button"
                accessibilityLabel={t('session.headerActionsAccessibility')}
                hitSlop={10}
                onPress={handlePress}
                style={({ pressed }) => ({
                    opacity: pressed ? 0.6 : hovered ? 0.7 : 1,
                })}
                {...hoverProps}
            >
                <Ionicons
                    name="ellipsis-horizontal"
                    size={22}
                    color={theme.colors.header.tint}
                />
            </Pressable>
            <SessionActionsPopover
                anchor={anchor}
                onClose={handleClose}
                sessionId={sessionId}
                visible={!!anchor}
            />
        </>
    );
}
