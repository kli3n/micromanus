/**
 * lib/registry-view.ts — pure view-model builder for the model registry picker
 * (KEY-05 / D-22 / OQ-1).
 *
 * PLAIN module: no next/react imports, so node-env Vitest imports it without
 * pulling in the "use client" ModelPicker component. It decides, per model:
 *   - locked:     greyed because the provider has no saved key (or it's Claude);
 *   - selectable: whether the row can be chosen for a chat;
 *   - nudge:      the "add key" affordance copy (D-22) when locked.
 *
 * Contract (D-22 shows every model, never hides; OQ-1 Claude never selectable):
 *   - non-anthropic + provider key saved  -> locked=false, selectable=true
 *   - non-anthropic + no key               -> locked=true,  selectable=false, nudge
 *   - anthropic (any)                      -> locked=true,  selectable=false, nudge
 */
import type { ModelSpec } from "@/lib/registry";

export interface RegistryRow {
  id: string;
  provider: ModelSpec["provider"];
  label: string;
  inputPrice: number;
  outputPrice: number;
  cacheReadPrice: number;
  cacheWritePrice: number;
  locked: boolean;
  selectable: boolean;
  nudge?: string;
}

/** D-22 nudge copy for locked (missing-key / Claude) rows. */
export const ADD_KEY_NUDGE = "add key";

export function buildRegistryView(
  models: readonly ModelSpec[],
  savedProviders: readonly string[],
): RegistryRow[] {
  const saved = new Set(savedProviders);
  return models.map((m) => {
    const isAnthropic = m.provider === "anthropic";
    // OQ-1: Claude is never selectable this phase, regardless of a saved key.
    const selectable = !isAnthropic && m.selectable !== false && saved.has(m.provider);
    const locked = !selectable;
    const row: RegistryRow = {
      id: m.id,
      provider: m.provider,
      label: m.label,
      inputPrice: m.inputPer1M,
      outputPrice: m.outputPer1M,
      cacheReadPrice: m.cacheReadPer1M,
      cacheWritePrice: m.cacheWritePer1M,
      locked,
      selectable,
    };
    if (locked) row.nudge = ADD_KEY_NUDGE;
    return row;
  });
}
