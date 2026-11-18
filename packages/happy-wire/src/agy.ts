// AGY advertises a native model ID for each effort variant. Happy keeps model
// and effort separate in its composer and in queued messages.
export const AGY_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh'] as const;
export type AgyModelOption = { code: string; value: string; description?: string | null };
type AgyModelGroup = { key: string; name: string; description?: string | null; variants: Map<string, string> };

export function groupAgyModels(models: readonly AgyModelOption[]): AgyModelGroup[] {
  const exactKeys = new Set(models.flatMap(model => [model.code, model.value]));
  const candidates = new Map<string, Array<{ model: AgyModelOption; effort?: string }>>();
  for (const model of models) {
    const variant = /^((?:Gemini|Claude) .+) \((Low|Medium|High|XHigh)\)$/.exec(model.value);
    const key = variant?.[1] ?? model.code;
    const entries = candidates.get(key) ?? [];
    entries.push({ model, effort: variant?.[2].toLowerCase() });
    candidates.set(key, entries);
  }

  const groups: AgyModelGroup[] = [];
  for (const [key, entries] of candidates) {
    const variants = new Map<string, string>();
    for (const { model, effort } of entries) {
      if (effort) variants.set(effort, model.code);
    }
    if (variants.size === entries.length && !exactKeys.has(key)) {
      groups.push({ key, name: key, variants, description: entries[0].model.description });
    } else {
      // Display labels may repeat. Preserve every opaque ID
      // if two models advertise the same label or collide with a family name.
      for (const { model } of entries) {
        groups.push({ key: model.code, name: model.value, description: model.description, variants: new Map() });
      }
    }
  }
  return groups;
}

export function selectAgyEffort(levels: readonly string[], preferred?: string | null): string | undefined {
  if (preferred && levels.includes(preferred)) return preferred;
  return levels.includes('medium') ? 'medium' : levels[0];
}
