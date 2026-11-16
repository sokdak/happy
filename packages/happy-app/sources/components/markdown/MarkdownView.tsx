import {
    MarkdownAlertKind,
    MarkdownBlock,
    MarkdownListItem,
    MarkdownSpan,
    parseMarkdown,
} from './parseMarkdown';
import * as React from 'react';
import { Image, Pressable, View, Platform } from 'react-native';
import { HorizontalScrollView } from '../HorizontalScrollView';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '../StyledText';
import { Typography } from '@/constants/Typography';
import { SimpleSyntaxHighlighter } from '../SimpleSyntaxHighlighter';
import { Modal } from '@/modal';
import { storage, useLocalSetting } from '@/sync/storage';
import { storeTempText } from '@/sync/persistence';
import { useRouter } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import { MermaidRenderer } from './MermaidRenderer';
import { t } from '@/text';
import { isFileMarkdownLink, isHttpMarkdownLink, parseFileMarkdownLink } from './linkUtils';
import { openExternalUrl } from '@/utils/openExternalUrl';
import { buildSessionFileRoute } from '@/utils/sessionFileLinks';

// Option type for callback
export type Option = {
    title: string;
};

export const MarkdownView = React.memo((props: { 
    markdown: string;
    onOptionPress?: (option: Option) => void;
    sessionId?: string;
    /**
     * The parent owns long-press copy (see LongPressCopyable). Suppresses native
     * selection and the built-in copy gesture so only one of them fires.
     */
    externalCopyHandler?: boolean;
}) => {
    const blocks = React.useMemo(() => parseMarkdown(props.markdown), [props.markdown]);
    
    // Backwards compatibility: The original version just returned the view, wrapping the list of blocks.
    // It made each of the individual text elements selectable. When we enable the markdownCopyV2 feature,
    // we disable the selectable property on individual text segments on mobile only. Instead, the long press
    // will be handled by a wrapper Pressable. If we don't disable the selectable property, then you will see
    // the native copy modal come up at the same time as the long press handler is fired.
    const markdownCopyV2 = useLocalSetting('markdownCopyV2');
    const selectable = Platform.OS === 'web' || !(markdownCopyV2 || props.externalCopyHandler);
    const router = useRouter();
    const canOpenFileLinks = Boolean(props.sessionId);

    const handleLinkPress = React.useCallback((url: string) => {
        if (isHttpMarkdownLink(url)) {
            void openExternalUrl(url);
            return;
        }
        if (!props.sessionId) {
            return;
        }
        const sessionRoot = storage.getState()?.sessions?.[props.sessionId]?.metadata?.path ?? null;
        const fileLink = parseFileMarkdownLink(url, sessionRoot);
        if (fileLink) {
            router.push(buildSessionFileRoute(props.sessionId, fileLink));
        }
    }, [props.sessionId, router]);

    const handleLongPress = React.useCallback(() => {
        try {
            const textId = storeTempText(props.markdown);
            router.push(`/text-selection?textId=${textId}`);
        } catch (error) {
            console.error('Error storing text for selection:', error);
            Modal.alert('Error', 'Failed to open text selection. Please try again.');
        }
    }, [props.markdown, router]);

    const renderContent = () => (
        <RenderMarkdownBlocks
            blocks={blocks}
            selectable={selectable}
            canOpenFileLinks={canOpenFileLinks}
            onLinkPress={handleLinkPress}
            onOptionPress={props.onOptionPress}
        />
    );

    if (props.externalCopyHandler || !markdownCopyV2) {
        return renderContent();
    }
    
    if (Platform.OS === 'web') {
        return renderContent();
    }
    
    // Use GestureDetector with LongPress gesture - it doesn't block pan gestures
    // so horizontal scrolling in code blocks and tables still works
    const longPressGesture = Gesture.LongPress()
        .minDuration(500)
        .onStart(() => {
            handleLongPress();
        })
        .runOnJS(true);

    return (
        <GestureDetector gesture={longPressGesture}>
            <View style={{ width: '100%' }}>
                {renderContent()}
            </View>
        </GestureDetector>
    );
});

function RenderMarkdownBlocks(props: {
    blocks: MarkdownBlock[];
    selectable: boolean;
    canOpenFileLinks: boolean;
    onLinkPress: (url: string) => void;
    onOptionPress?: (option: Option) => void;
    compact?: boolean;
}) {
    return (
        <View style={{ width: '100%' }}>
            {props.blocks.map((block, index) => {
                const first = index === 0;
                const last = index === props.blocks.length - 1;
                if (block.type === 'text') {
                    return <RenderTextBlock spans={block.content} key={index} first={first} last={last} compact={props.compact} selectable={props.selectable} canOpenFileLinks={props.canOpenFileLinks} onLinkPress={props.onLinkPress} />;
                } else if (block.type === 'header') {
                    return <RenderHeaderBlock level={block.level} spans={block.content} key={index} first={first} last={last} selectable={props.selectable} canOpenFileLinks={props.canOpenFileLinks} onLinkPress={props.onLinkPress} />;
                } else if (block.type === 'horizontal-rule') {
                    return <View style={style.horizontalRule} key={index} />;
                } else if (block.type === 'list' || block.type === 'numbered-list') {
                    return <RenderListBlock items={block.items} key={index} first={first} last={last} compact={props.compact} selectable={props.selectable} canOpenFileLinks={props.canOpenFileLinks} onLinkPress={props.onLinkPress} />;
                } else if (block.type === 'blockquote') {
                    return (
                        <RenderBlockquoteBlock
                            alert={block.alert}
                            blocks={block.blocks}
                            key={index}
                            first={first}
                            last={last}
                            selectable={props.selectable}
                            canOpenFileLinks={props.canOpenFileLinks}
                            onLinkPress={props.onLinkPress}
                            onOptionPress={props.onOptionPress}
                        />
                    );
                } else if (block.type === 'code-block') {
                    return <RenderCodeBlock content={block.content} language={block.language} key={index} first={first} last={last} selectable={props.selectable} />;
                } else if (block.type === 'mermaid') {
                    return <MermaidRenderer content={block.content} key={index} />;
                } else if (block.type === 'options') {
                    return <RenderOptionsBlock items={block.items} key={index} first={first} last={last} selectable={props.selectable} onOptionPress={props.onOptionPress} />;
                } else if (block.type === 'table') {
                    return <RenderTableBlock headers={block.headers} rows={block.rows} onLinkPress={props.onLinkPress} canOpenFileLinks={props.canOpenFileLinks} selectable={props.selectable} key={index} first={first} last={last} />;
                } else if (block.type === 'image') {
                    return <RenderImageBlock url={block.url} alt={block.alt} key={index} first={first} last={last} />;
                } else {
                    return null;
                }
            })}
        </View>
    );
}

type RenderSpanProps = {
    spans: MarkdownSpan[];
    baseStyle?: any;
    inHeader?: boolean;
    selectable: boolean;
    canOpenFileLinks: boolean;
    onLinkPress: (url: string) => void;
};

function RenderTextBlock(props: {
    spans: MarkdownSpan[];
    first: boolean;
    last: boolean;
    compact?: boolean;
    selectable: boolean;
    canOpenFileLinks: boolean;
    onLinkPress: (url: string) => void;
}) {
    const textStyle = [
        style.text,
        props.compact && style.compactText,
        props.first && (props.compact ? style.compactFirst : style.first),
        props.last && (props.compact ? style.compactLast : style.last),
    ];
    return (
        <Text selectable={props.selectable} style={textStyle}>
            <RenderSpans spans={props.spans} baseStyle={style.text} selectable={props.selectable} canOpenFileLinks={props.canOpenFileLinks} onLinkPress={props.onLinkPress} />
        </Text>
    );
}

function RenderHeaderBlock(props: {
    level: 1 | 2 | 3 | 4 | 5 | 6;
    spans: MarkdownSpan[];
    first: boolean;
    last: boolean;
    selectable: boolean;
    canOpenFileLinks: boolean;
    onLinkPress: (url: string) => void;
}) {
    const s = (style as any)[`header${props.level}`];
    const headerStyle = [style.header, s, props.first && style.first, props.last && style.last];
    return (
        <Text selectable={props.selectable} style={headerStyle}>
            <RenderSpans spans={props.spans} baseStyle={headerStyle} inHeader selectable={props.selectable} canOpenFileLinks={props.canOpenFileLinks} onLinkPress={props.onLinkPress} />
        </Text>
    );
}

const BULLETS = ['•', '◦', '▪'] as const;

function RenderListBlock(props: {
    items: MarkdownListItem[];
    first: boolean;
    last: boolean;
    compact?: boolean;
    selectable: boolean;
    canOpenFileLinks: boolean;
    onLinkPress: (url: string) => void;
}) {
    const listStyle = [style.text, style.list];
    return (
        <View style={{ flexDirection: 'column', marginBottom: props.compact && props.last ? 0 : 8, gap: 6 }}>
            {props.items.map((item, index) => {
                const marker = typeof item.number === 'number'
                    ? `${item.number}.`
                    : BULLETS[Math.min(item.depth, BULLETS.length - 1)];
                return (
                    <View key={index} style={{ flexDirection: 'row', alignItems: 'flex-start', paddingLeft: item.depth * 16 }}>
                        <Text selectable={false} style={[listStyle, { marginRight: 8, marginTop: 1 }]}>{marker}</Text>
                        <Text selectable={props.selectable} style={[listStyle, { flex: 1 }]}>
                            <RenderSpans spans={item.spans} baseStyle={listStyle} selectable={props.selectable} canOpenFileLinks={props.canOpenFileLinks} onLinkPress={props.onLinkPress} />
                        </Text>
                    </View>
                );
            })}
        </View>
    );
}

const ALERT_META: Record<MarkdownAlertKind, { label: string; icon: React.ComponentProps<typeof Ionicons>['name'] }> = {
    NOTE: { label: 'Note', icon: 'information-circle-outline' },
    TIP: { label: 'Tip', icon: 'bulb-outline' },
    IMPORTANT: { label: 'Important', icon: 'alert-circle-outline' },
    WARNING: { label: 'Warning', icon: 'warning-outline' },
    CAUTION: { label: 'Caution', icon: 'flame-outline' },
};

function RenderBlockquoteBlock(props: {
    alert: MarkdownAlertKind | null;
    blocks: MarkdownBlock[];
    first: boolean;
    last: boolean;
    selectable: boolean;
    canOpenFileLinks: boolean;
    onLinkPress: (url: string) => void;
    onOptionPress?: (option: Option) => void;
}) {
    const { theme } = useUnistyles();

    const palette = React.useMemo(() => {
        switch (props.alert) {
            case 'NOTE': {
                const accent = theme.dark ? '#4DA3FF' : '#007AFF';
                return {
                    border: accent,
                    background: theme.dark ? 'rgba(10, 132, 255, 0.12)' : 'rgba(0, 122, 255, 0.07)',
                    accent,
                };
            }
            case 'TIP': {
                const accent = theme.colors.success;
                return {
                    border: accent,
                    background: theme.dark ? 'rgba(52, 199, 89, 0.12)' : 'rgba(52, 199, 89, 0.08)',
                    accent,
                };
            }
            case 'IMPORTANT': {
                const accent = theme.dark ? '#9D8CFF' : '#5856D6';
                return {
                    border: accent,
                    background: theme.dark ? 'rgba(125, 122, 255, 0.14)' : 'rgba(88, 86, 214, 0.08)',
                    accent,
                };
            }
            case 'WARNING':
                return {
                    border: theme.colors.box.warning.border,
                    background: theme.colors.box.warning.background,
                    accent: theme.colors.box.warning.text,
                };
            case 'CAUTION':
                return {
                    border: theme.colors.box.error.border,
                    background: theme.colors.box.error.background,
                    accent: theme.colors.box.error.text,
                };
            default:
                return {
                    border: theme.colors.divider,
                    background: theme.colors.surfaceHigh,
                    accent: theme.colors.textSecondary,
                };
        }
    }, [props.alert, theme]);

    const alertMeta = props.alert ? ALERT_META[props.alert] : null;

    return (
        <View
            style={[
                style.blockquote,
                {
                    borderLeftColor: palette.border,
                    backgroundColor: palette.background,
                },
                props.first && style.first,
                props.last && style.last,
            ]}
        >
            {alertMeta ? (
                <View style={style.alertHeader}>
                    <Ionicons name={alertMeta.icon} size={16} color={palette.accent} />
                    <Text selectable={props.selectable} style={[style.alertTitle, { color: palette.accent }]}>
                        {alertMeta.label}
                    </Text>
                </View>
            ) : null}
            {props.blocks.length > 0 ? (
                <RenderMarkdownBlocks
                    blocks={props.blocks}
                    selectable={props.selectable}
                    canOpenFileLinks={props.canOpenFileLinks}
                    onLinkPress={props.onLinkPress}
                    onOptionPress={props.onOptionPress}
                    compact
                />
            ) : null}
        </View>
    );
}

function RenderCodeBlock(props: { content: string, language: string | null, first: boolean, last: boolean, selectable: boolean }) {
    const [isHovered, setIsHovered] = React.useState(false);

    const copyCode = React.useCallback(async () => {
        try {
            await Clipboard.setStringAsync(props.content);
            Modal.alert(t('common.success'), t('markdown.codeCopied'), [{ text: t('common.ok'), style: 'cancel' }]);
        } catch (error) {
            console.error('Failed to copy code:', error);
            Modal.alert(t('common.error'), t('markdown.copyFailed'), [{ text: t('common.ok'), style: 'cancel' }]);
        }
    }, [props.content]);

    return (
        <View
            style={[style.codeBlock, props.first && style.first, props.last && style.last]}
            // @ts-ignore - Web only events
            onMouseEnter={() => setIsHovered(true)}
            // @ts-ignore - Web only events
            onMouseLeave={() => setIsHovered(false)}
        >
            {props.language && <Text selectable={props.selectable} style={style.codeLanguage}>{props.language}</Text>}
            <HorizontalScrollView
                contentContainerStyle={{ paddingHorizontal: 16, paddingVertical: 16 }}
            >
                <SimpleSyntaxHighlighter
                    code={props.content}
                    language={props.language}
                    selectable={props.selectable}
                />
            </HorizontalScrollView>
            <View
                style={[style.copyButtonWrapper, isHovered && style.copyButtonWrapperVisible]}
                {...(Platform.OS === 'web' ? ({ className: 'copy-button-wrapper' } as any) : {})}
            >
                <Pressable
                    style={style.copyButton}
                    onPress={copyCode}
                >
                    <Text style={style.copyButtonText}>{t('common.copy')}</Text>
                </Pressable>
            </View>
        </View>
    );
}

function RenderImageBlock(props: { url: string, alt: string, first: boolean, last: boolean }) {
    const accessibleLabel = props.alt || 'Markdown image';

    return (
        <View style={[style.imageBlock, props.first && style.first, props.last && style.last]}>
            <Image
                source={{ uri: props.url }}
                style={style.image}
                accessibilityLabel={accessibleLabel}
                resizeMode="contain"
            />
            {props.alt ? (
                <Text style={style.imageCaption}>{props.alt}</Text>
            ) : null}
        </View>
    );
}

function RenderOptionsBlock(props: { 
    items: string[], 
    first: boolean, 
    last: boolean, 
    selectable: boolean,
    onOptionPress?: (option: Option) => void 
}) {
    return (
        <View style={[style.optionsContainer, props.first && style.first, props.last && style.last]}>
            {props.items.map((item, index) => {
                if (props.onOptionPress) {
                    return (
                        <Pressable
                            key={index}
                            style={({ pressed }) => [
                                style.optionPressable,
                                style.optionButton,
                                pressed && style.optionButtonPressed
                            ]}
                            onPress={() => props.onOptionPress?.({ title: item })}
                        >
                            <Text selectable={props.selectable} style={style.optionButtonText}>{item}</Text>
                        </Pressable>
                    );
                } else {
                    return (
                        <View key={index} style={style.optionItem}>
                            <Text selectable={props.selectable} style={style.optionText}>{item}</Text>
                        </View>
                    );
                }
            })}
        </View>
    );
}

function RenderSpans(props: RenderSpanProps) {
    return (<>
        {props.spans.map((span, index) => {
            const spanStyles = span.styles.map(s => (s === 'code' && props.inHeader ? style.headerCode : style[s]));
            if (span.url) {
                const isExternalLink = isHttpMarkdownLink(span.url);
                const isFileLink = !isExternalLink && isFileMarkdownLink(span.url);
                const isInteractiveLink = isExternalLink || (isFileLink && props.canOpenFileLinks);
                const linkStyle = isExternalLink
                    ? style.link
                    : isFileLink
                        ? (props.canOpenFileLinks ? style.fileLink : style.fileLinkStatic)
                        : null;
                return (
                    <Text
                        key={index}
                        selectable={props.selectable}
                        accessibilityRole={isInteractiveLink ? 'link' : undefined}
                        style={[props.baseStyle, spanStyles, linkStyle]}
                        {...(isInteractiveLink && Platform.OS === 'web' ? { onClick: () => props.onLinkPress(span.url!) } as any : {})}
                        onPress={isInteractiveLink && Platform.OS !== 'web'
                            ? () => props.onLinkPress(span.url!)
                            : undefined}
                    >
                        {span.text}
                    </Text>
                );
            } else {
                return <Text key={index} selectable={props.selectable} style={[props.baseStyle, spanStyles]}>{span.text}</Text>
            }
        })}
    </>)
}

// Plain-text length of a span array — used to estimate column widths.
function spansLength(spans: MarkdownSpan[]): number {
    let n = 0;
    for (const s of spans) n += s.text.length;
    return n;
}

const TABLE_MIN_COL_WIDTH = 80;
const TABLE_MAX_COL_WIDTH = 360;
const TABLE_CHAR_WIDTH = 8.5;  // approx px per char at 16px default font
const TABLE_CELL_H_PADDING = 24;

function RenderTableBlock(props: {
    headers: MarkdownSpan[][],
    rows: MarkdownSpan[][][],
    onLinkPress: (url: string) => void,
    canOpenFileLinks: boolean,
    selectable: boolean,
    first: boolean,
    last: boolean
}) {
    const columnCount = props.headers.length;
    const rowCount = props.rows.length;
    const isLastCol = (colIndex: number) => colIndex === columnCount - 1;
    const isLastRow = (rowIndex: number) => rowIndex === rowCount - 1;

    const columnWidths = React.useMemo(() => {
        const widths = new Array(columnCount).fill(0);
        for (let c = 0; c < columnCount; c++) {
            widths[c] = Math.max(widths[c], spansLength(props.headers[c] ?? []));
        }
        for (const row of props.rows) {
            for (let c = 0; c < columnCount; c++) {
                widths[c] = Math.max(widths[c], spansLength(row[c] ?? []));
            }
        }
        return widths.map(len => Math.min(TABLE_MAX_COL_WIDTH, Math.max(TABLE_MIN_COL_WIDTH, len * TABLE_CHAR_WIDTH + TABLE_CELL_H_PADDING)));
    }, [props.headers, props.rows, columnCount]);

    return (
        <View style={[style.tableContainer, props.first && style.first, props.last && style.last]}>
            {/* flexGrow:0 stops iOS from stretching the horizontal ScrollView
                vertically to fill the parent — the cause of the table's frame
                extending down past the last row into empty space. */}
            <HorizontalScrollView style={{ flexGrow: 0 }}>
                <View>
                    {/* Header row */}
                    <View style={[style.tableRow, style.tableHeaderRow]}>
                        {props.headers.map((header, colIndex) => (
                            <View
                                key={`header-${colIndex}`}
                                style={[style.tableCell, style.tableHeaderCell, { width: columnWidths[colIndex] }, !isLastCol(colIndex) && style.tableCellBorderRight]}
                            >
                                <Text style={style.tableHeaderText}>
                                    <RenderSpans spans={header} baseStyle={style.tableHeaderText} onLinkPress={props.onLinkPress} canOpenFileLinks={props.canOpenFileLinks} selectable={props.selectable} />
                                </Text>
                            </View>
                        ))}
                    </View>
                    {/* Data rows */}
                    {props.rows.map((row, rowIndex) => (
                        <View
                            key={`row-${rowIndex}`}
                            style={[style.tableRow, !isLastRow(rowIndex) && style.tableRowBorderBottom]}
                        >
                            {props.headers.map((_, colIndex) => (
                                <View
                                    key={`cell-${rowIndex}-${colIndex}`}
                                    style={[style.tableCell, { width: columnWidths[colIndex] }, !isLastCol(colIndex) && style.tableCellBorderRight]}
                                >
                                    <Text style={style.tableCellText}>
                                        <RenderSpans spans={row[colIndex] ?? []} baseStyle={style.tableCellText} onLinkPress={props.onLinkPress} canOpenFileLinks={props.canOpenFileLinks} selectable={props.selectable} />
                                    </Text>
                                </View>
                            ))}
                        </View>
                    ))}
                </View>
            </HorizontalScrollView>
        </View>
    );
}


const style = StyleSheet.create((theme) => ({

    // Plain text

    text: {
        ...Typography.default(),
        fontSize: 16,
        lineHeight: 25,
        marginTop: 8,
        marginBottom: 10,
        color: theme.colors.text,
        fontWeight: '400',
    },
    compactText: {
        marginTop: 4,
        marginBottom: 4,
    },
    compactFirst: {
        marginTop: 0,
    },
    compactLast: {
        marginBottom: 0,
    },

    italic: {
        fontStyle: 'italic',
    },
    bold: {
        ...Typography.default('semiBold'),
        fontWeight: '700',
    },
    semibold: {
        ...Typography.default('semiBold'),
        fontWeight: '600',
    },
    code: {
        ...Typography.mono(),
        fontSize: 14,
        lineHeight: 21,
        backgroundColor: theme.colors.surfaceHighest,
        ...(Platform.OS === 'web' ? {
            borderRadius: 4,
            paddingHorizontal: 4,
            paddingVertical: 1,
        } : {}),
    },
    headerCode: {
        ...Typography.mono(),
        backgroundColor: theme.colors.surfaceHighest,
        ...(Platform.OS === 'web' ? {
            borderRadius: 4,
            paddingHorizontal: 4,
            paddingVertical: 1,
        } : {}),
    },
    link: {
        color: theme.colors.textLink,
        textDecorationLine: 'underline',
        cursor: 'pointer',
    },
    fileLink: {
        color: theme.colors.textLink,
        textDecorationLine: 'underline',
        cursor: 'pointer',
    },
    fileLinkStatic: {
        ...Typography.mono(),
        fontSize: 14,
        lineHeight: 21,
        color: theme.colors.textLink,
    },

    // Headers

    header: {
        ...Typography.default('semiBold'),
        color: theme.colors.text,
    },
    header1: {
        fontSize: 22,
        lineHeight: 30,
        fontWeight: '700',
        marginTop: 18,
        marginBottom: 8,
    },
    header2: {
        fontSize: 19,
        lineHeight: 27,
        fontWeight: '700',
        marginTop: 16,
        marginBottom: 8,
    },
    header3: {
        fontSize: 17,
        lineHeight: 24,
        fontWeight: '600',
        marginTop: 14,
        marginBottom: 6,
    },
    header4: {
        fontSize: 16,
        lineHeight: 23,
        fontWeight: '600',
        marginTop: 12,
        marginBottom: 4,
    },
    header5: {
        fontSize: 15,
        lineHeight: 22,
        fontWeight: '600',
        marginTop: 10,
        marginBottom: 4,
    },
    header6: {
        fontSize: 14,
        lineHeight: 20,
        fontWeight: '600',
        color: theme.colors.textSecondary,
        marginTop: 8,
        marginBottom: 4,
    },

    //
    // List
    //

    list: {
        ...Typography.default(),
        color: theme.colors.text,
        marginTop: 0,
        marginBottom: 0,
    },

    //
    // Blockquote / Alerts
    //

    blockquote: {
        borderLeftWidth: 3,
        borderRadius: 8,
        paddingHorizontal: 12,
        paddingVertical: 8,
        marginVertical: 8,
        gap: 4,
    },
    alertHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        marginBottom: 2,
    },
    alertTitle: {
        ...Typography.default('semiBold'),
        fontSize: 14,
        lineHeight: 20,
        fontWeight: '600',
    },

    //
    // Common
    //

    first: {
        // marginTop: 0
    },
    last: {
        // marginBottom: 0
    },

    //
    // Code Block
    //

    codeBlock: {
        backgroundColor: theme.colors.surfaceHighest,
        borderRadius: 8,
        marginVertical: 8,
        position: 'relative',
        zIndex: 1,
        width: '100%',
    },
    copyButtonWrapper: {
        position: 'absolute',
        top: 8,
        right: 8,
        opacity: 0,
        zIndex: 10,
        elevation: 10,
        pointerEvents: 'none',
    },
    copyButtonWrapperVisible: {
        opacity: 1,
        pointerEvents: 'auto',
    },
    codeLanguage: {
        ...Typography.mono(),
        color: theme.colors.textSecondary,
        fontSize: 12,
        marginTop: 8,
        paddingHorizontal: 16,
        marginBottom: 0,
    },
    codeText: {
        ...Typography.mono(),
        color: theme.colors.text,
        fontSize: 14,
        lineHeight: 20,
    },
    horizontalRule: {
        height: 1,
        backgroundColor: theme.colors.divider,
        marginTop: 8,
        marginBottom: 8,
    },
    imageBlock: {
        width: '100%',
        maxWidth: 520,
        marginVertical: 8,
        alignSelf: 'flex-start',
        gap: 8,
    },
    image: {
        width: '100%',
        minHeight: 160,
        height: 240,
        borderRadius: 12,
        backgroundColor: theme.colors.surfaceHighest,
    },
    imageCaption: {
        ...Typography.default(),
        fontSize: 14,
        lineHeight: 20,
        color: theme.colors.textSecondary,
    },
    copyButtonContainer: {
        position: 'absolute',
        top: 8,
        right: 8,
        zIndex: 10,
        elevation: 10,
        opacity: 1,
    },
    copyButtonContainerHidden: {
        opacity: 0,
    },
    copyButton: {
        backgroundColor: theme.colors.surfaceHighest,
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 4,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        cursor: 'pointer',
    },
    copyButtonHidden: {
        display: 'none',
    },
    copyButtonCopied: {
        backgroundColor: theme.colors.success,
        borderColor: theme.colors.success,
        opacity: 1,
    },
    copyButtonText: {
        ...Typography.default(),
        color: theme.colors.text,
        fontSize: 12,
        lineHeight: 16,
    },

    //
    // Options Block
    //

    optionsContainer: {
        flexDirection: 'column',
        gap: 8,
        marginVertical: 8,
    },
    optionPressable: {
        borderRadius: Platform.select({ web: 8, default: 18 }),
    },
    optionItem: {
        backgroundColor: Platform.select({ web: theme.colors.surfaceHighest, default: theme.colors.surface }),
        borderRadius: Platform.select({ web: 8, default: 18 }),
        paddingHorizontal: 16,
        paddingVertical: Platform.select({ web: 12, default: 14 }),
        borderWidth: Platform.select({ web: 1, default: StyleSheet.hairlineWidth }),
        borderColor: theme.colors.divider,
        overflow: 'hidden',
    },
    optionItemPressed: {
        backgroundColor: Platform.select({ web: theme.colors.surfaceHigh, default: theme.colors.surfacePressed }),
        opacity: Platform.select({ web: 0.7, default: 1 }),
    },
    optionText: {
        ...Typography.default(),
        fontSize: 16,
        lineHeight: 24,
        color: theme.colors.text,
    },
    // Tapping an option sends it as your message. Full-width rows in the
    // composer send button's resting grey — flat, no border.
    optionButton: {
        backgroundColor: theme.colors.surfaceHighest,
        borderRadius: 12,
        paddingHorizontal: 12,
        paddingVertical: 8,
        overflow: 'hidden',
    },
    optionButtonPressed: {
        opacity: 0.7,
    },
    optionButtonText: {
        ...Typography.default(),
        fontSize: 16,
        lineHeight: 24,
        color: theme.colors.text,
    },

    //
    // Table
    //

    tableContainer: {
        marginVertical: 8,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        borderRadius: 8,
        overflow: 'hidden',
        maxWidth: '100%',
        alignSelf: 'flex-start',
    },
    tableRow: {
        flexDirection: 'row',
        alignItems: 'stretch',
    },
    tableRowBorderBottom: {
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.divider,
    },
    tableHeaderRow: {
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.divider,
    },
    tableCell: {
        paddingHorizontal: 12,
        paddingVertical: 8,
        alignItems: 'flex-start',
    },
    tableCellBorderRight: {
        borderRightWidth: 1,
        borderRightColor: theme.colors.divider,
    },
    tableHeaderCell: {
        backgroundColor: theme.colors.surfaceHigh,
    },
    tableHeaderText: {
        ...Typography.default('semiBold'),
        color: theme.colors.text,
        fontSize: 16,
        lineHeight: 24,
    },
    tableCellText: {
        ...Typography.default(),
        color: theme.colors.text,
        fontSize: 16,
        lineHeight: 24,
    },

    // Add global style for Web platform (Unistyles supports this via compiler plugin)
    ...(Platform.OS === 'web' ? {
        // Web-only CSS styles
        _____web_global_styles: {}
    } : {}),
}));
