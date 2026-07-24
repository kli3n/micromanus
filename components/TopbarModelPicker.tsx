"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { ModelSpec } from "@/lib/registry";
import { ModelPicker } from "@/components/ModelPicker";

/**
 * TopbarModelPicker (KEY-05) — the mounting seam that turns the ModelPicker
 * "picker" variant into a live topbar control.
 *
 * This "use client" wrapper is intentionally the ONLY interactive/state-owning
 * piece: AppShell is a server component and imports MODEL_REGISTRY (a plain
 * module) as data, then hands it here. Picking a selectable row produces the
 * `/app/c/new?model=<id>` URL that the chat page's `new` sentinel already reads
 * into ChatThread's modelId — no chat-page or ChatThread edit is needed.
 *
 * Because AppShell lives in the (app) layout it stays mounted across chat
 * navigations, so `value` naturally remembers the session's last pick. The
 * wrapper adds no styling of its own — ModelPicker's picker variant carries the
 * topbar button + dropdown design tokens.
 */
export function TopbarModelPicker({
  models,
  savedProviders,
}: {
  models: readonly ModelSpec[];
  savedProviders: readonly string[];
}) {
  const router = useRouter();
  const [value, setValue] = useState<string | undefined>(undefined);

  function handlePick(id: string) {
    setValue(id);
    router.push("/app/c/new?model=" + encodeURIComponent(id));
  }

  return (
    <ModelPicker
      variant="picker"
      models={models}
      savedProviders={savedProviders}
      value={value}
      onChange={handlePick}
    />
  );
}
