export function resolveNativeHeaderTitleInset(
    backControlWidth: number,
    rightSlotWidth: number,
    gap: number,
): number {
    return Math.max(0, backControlWidth, rightSlotWidth) + Math.max(0, gap);
}
