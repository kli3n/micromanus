"use client";

import { useMemo, useState } from "react";
import type { ModelSpec } from "@/lib/registry";
import { buildRegistryView, type RegistryRow } from "@/lib/registry-view";

/**
 * ModelPicker (KEY-05 / D-22 / OQ-1) — replaces the disabled AppShell "Model"
 * slot. Ports design/screens/02-phase2-demos.html §02 registry + §03 picker.
 *
 * Two variants share one source of truth (buildRegistryView):
 *   - "registry": the grouped, priced list on Settings (Step 3). Locked rows are
 *     greyed with an "add key" nudge; Claude rows are greyed/non-selectable.
 *   - "picker": a compact topbar button + dropdown for the chat plan. The button
 *     shows the selected model + "$in / $out"; clicking a selectable row calls
 *     onChange(model.id). Persistence to chats.model_id is the chat plan's job
 *     (this component only surfaces the selection via onChange).
 *
 * Icons are inline <svg> mirroring AppShell — lucide-react is not installed/owned.
 */

type Variant = "registry" | "picker";

interface ModelPickerProps {
  models: readonly ModelSpec[];
  savedProviders: readonly string[];
  value?: string;
  onChange: (modelId: string) => void;
  variant: Variant;
}

// Role pill labels (demo fidelity) keyed on registry id; falls back to none.
const ROLE_BY_ID: Record<string, string> = {
  "claude-opus-4-8": "Flagship",
  "claude-sonnet-4-6": "Balanced",
  "claude-haiku-4-5": "Fast",
  "gpt-5.6-sol": "Flagship",
  "gpt-5.6-terra": "Balanced",
  "gpt-5.6-luna": "Fast",
  "gpt-5.4-mini": "Cheap",
  "kimi-k3": "Flagship",
  "kimi-k2.7-code": "Agentic",
  "kimi-k2.6": "Cheap",
};

const PROVIDER_HEADING: Record<string, string> = {
  anthropic: "Anthropic — Claude",
  openai: "OpenAI",
  kimi: "Kimi — Moonshot",
  openrouter: "OpenRouter",
  custom: "Custom",
};

const money = (n: number) => `$${n.toFixed(2)}`;

function LockIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      className="h-3 w-3"
    >
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-[15px] w-[15px]"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

/** One registry row (name + id + prices + lock/nudge), optionally clickable. */
function Row({
  row,
  onPick,
  compact,
}: {
  row: RegistryRow;
  onPick?: (id: string) => void;
  compact?: boolean;
}) {
  const role = ROLE_BY_ID[row.id];
  const clickable = row.selectable && onPick;
  return (
    <div
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      aria-disabled={!row.selectable}
      onClick={clickable ? () => onPick!(row.id) : undefined}
      onKeyDown={
        clickable
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onPick!(row.id);
              }
            }
          : undefined
      }
      className={[
        "grid grid-cols-[1fr_auto] items-center gap-[14px] border-b border-[var(--border)] px-[14px] py-[11px] last:border-b-0",
        row.locked ? "bg-[var(--surface-2)] opacity-[.72]" : "",
        clickable ? "cursor-pointer hover:bg-[var(--surface-2)]" : "",
        !row.selectable ? "cursor-not-allowed" : "",
      ].join(" ")}
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2 text-[13.5px] font-[600]">
          {row.label}
          {role && (
            /* --accent-hover, not --accent: --accent on the pill's soft fill
               measures 4.43:1 (the fourth measured AA pair); --accent-hover
               reads at 6.32:1 (04-11 sweep). */
            <span className="rounded-[5px] border border-[var(--accent-line)] bg-[var(--accent-soft)] px-1.5 py-0.5 text-[9.5px] font-[700] uppercase tracking-[.04em] text-[var(--accent-hover)]">
              {role}
            </span>
          )}
        </div>
        <div className="mt-0.5 font-[var(--mono)] text-[11px] text-[var(--text-2)]">
          {row.id}
        </div>
      </div>
      <div className="flex items-center gap-3 justify-self-end">
        {!compact && (
          <div className="text-right font-[var(--mono)] text-[12px] tabular-nums text-[var(--text-2)]">
            <span className="font-[600] text-[var(--text)]">
              {money(row.inputPrice)}
            </span>{" "}
            in ·{" "}
            <span className="font-[600] text-[var(--text)]">
              {money(row.outputPrice)}
            </span>{" "}
            out
            <div className="mt-0.5 text-[10.5px] text-[var(--text-2)]">
              cache {money(row.cacheReadPrice)} r
              {row.cacheWritePrice > 0 ? ` / ${money(row.cacheWritePrice)} w` : ""}
            </div>
          </div>
        )}
        {row.nudge && (
          /* --text-2, not --warning: warning-as-text fails AA on every
             surface, and this row's dimmed fill makes it worse (04-11). */
          <span className="inline-flex items-center gap-1 text-[10.5px] font-[600] text-[var(--text-2)]">
            <LockIcon />
            {row.nudge}
          </span>
        )}
      </div>
    </div>
  );
}

export function ModelPicker({
  models,
  savedProviders,
  value,
  onChange,
  variant,
}: ModelPickerProps) {
  const rows = useMemo(
    () => buildRegistryView(models, savedProviders),
    [models, savedProviders],
  );
  const [open, setOpen] = useState(false);

  if (variant === "registry") {
    // Group by provider, preserving first-appearance order.
    const order: string[] = [];
    const groups = new Map<string, RegistryRow[]>();
    for (const r of rows) {
      if (!groups.has(r.provider)) {
        groups.set(r.provider, []);
        order.push(r.provider);
      }
      groups.get(r.provider)!.push(r);
    }
    return (
      <div className="flex flex-col gap-[18px]">
        {order.map((prov) => {
          const hasKey = savedProviders.includes(prov);
          return (
            <div key={prov}>
              <div className="mb-2 flex items-center gap-[9px]">
                <span className="text-[12.5px] font-[700] tracking-[.02em]">
                  {PROVIDER_HEADING[prov] ?? prov}
                </span>
                <span
                  className="font-[var(--mono)] text-[11px]"
                  style={{ color: hasKey ? "var(--success)" : "var(--text-2)" }}
                >
                  {hasKey ? "✓ key saved" : "○ no key"}
                </span>
              </div>
              <div className="overflow-hidden rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)]">
                {groups.get(prov)!.map((row) => (
                  <Row key={row.id} row={row} onPick={onChange} />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  // "picker" variant — compact topbar button + dropdown (chat plan).
  const selected = rows.find((r) => r.id === value);
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex h-9 items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)] px-3 text-[13px] font-[550] text-[var(--text)]"
      >
        <span>{selected ? selected.label : "Select model"}</span>
        {selected && (
          <span className="font-[var(--mono)] text-[11px] tabular-nums text-[var(--text-2)]">
            {money(selected.inputPrice)} / {money(selected.outputPrice)}
          </span>
        )}
        <ChevronIcon />
      </button>
      {open && (
        <div
          role="listbox"
          className="absolute right-0 z-10 mt-1 max-h-[320px] w-[360px] overflow-auto rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-lg)]"
        >
          {rows.map((row) => (
            <Row
              key={row.id}
              row={row}
              onPick={(id) => {
                onChange(id);
                setOpen(false);
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
