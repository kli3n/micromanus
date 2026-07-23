"use client";

import { useEffect, useState } from "react";
import { DEFAULT_BASE_URLS, MODEL_REGISTRY, type Provider } from "@/lib/registry";
import type { KeyMetadata } from "@/lib/keys/metadata";
import { ModelPicker } from "@/components/ModelPicker";

/**
 * /app/settings — the persistent BYOK Settings page (D-14, Steps 2 & 3).
 *
 * Ports design/screens/02-phase2-demos.html §02 into a client island (D-11: the
 * mockup is the contract). Auth is already enforced by the (app) layout guard;
 * this page fetches its own data (GET /api/keys) and never sees ciphertext.
 *
 * Task 1 scope: provider select + editable pre-filled base URL + key input +
 * Save (KEY-01), plus the last-4 saved-key list and the no-keys empty state
 * (UX-02). The verify-before-save gate (Task 2) and the model registry (Task 3)
 * mount into this same page.
 */

// Providers offered in the select. Anthropic is rendered disabled (OQ-1).
const PROVIDER_OPTIONS: { value: Provider; label: string; disabled?: boolean }[] =
  [
    { value: "openai", label: "OpenAI" },
    { value: "kimi", label: "Kimi / Moonshot" },
    { value: "openrouter", label: "OpenRouter" },
    { value: "custom", label: "Custom (OpenAI-compatible)" },
    { value: "anthropic", label: "Anthropic (Claude) · arrives soon", disabled: true },
  ];

const PROVIDER_TITLE: Record<string, string> = {
  openai: "OpenAI",
  kimi: "Kimi / Moonshot",
  openrouter: "OpenRouter",
  custom: "Custom",
  anthropic: "Anthropic",
};

export default function SettingsPage() {
  const [provider, setProvider] = useState<Provider>("openai");
  const [baseUrl, setBaseUrl] = useState<string>(DEFAULT_BASE_URLS.openai);
  const [apiKey, setApiKey] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [keys, setKeys] = useState<KeyMetadata[]>([]);
  const [loadingKeys, setLoadingKeys] = useState(true);
  // KEY-05: the picked model id. Persistence to chats.model_id is the chat
  // plan's job; here it just drives the registry selection surface.
  const [selectedModel, setSelectedModel] = useState<string | undefined>(
    undefined,
  );
  // KEY-02 verify-before-save gate: Save stays disabled until a successful
  // 1-token probe for the CURRENT provider/base URL/key. Any change resets it.
  const [verifyState, setVerifyState] = useState<
    "idle" | "verifying" | "ok" | "fail"
  >("idle");
  const [verifyMsg, setVerifyMsg] = useState<string | null>(null);

  function resetVerify() {
    setVerifyState("idle");
    setVerifyMsg(null);
  }

  async function refreshKeys() {
    try {
      const res = await fetch("/api/keys", { method: "GET" });
      if (res.ok) {
        const data = (await res.json()) as KeyMetadata[];
        setKeys(Array.isArray(data) ? data : []);
      }
    } catch {
      // Non-fatal: the form still works; the list simply stays empty.
    } finally {
      setLoadingKeys(false);
    }
  }

  useEffect(() => {
    void refreshKeys();
  }, []);

  function onProviderChange(next: Provider) {
    setProvider(next);
    setBaseUrl(DEFAULT_BASE_URLS[next]);
    setSaveError(null);
    setSavedMsg(null);
    resetVerify();
  }

  async function onTest() {
    if (apiKey.trim().length === 0) {
      setVerifyState("fail");
      setVerifyMsg("Enter a key first");
      return;
    }
    setVerifyState("verifying");
    setVerifyMsg("verifying… (1-token call)");
    setSaveError(null);
    setSavedMsg(null);
    try {
      const res = await fetch("/api/keys/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, base_url: baseUrl, apiKey }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        reason?: string;
      };
      if (res.ok && data.ok) {
        setVerifyState("ok");
        setVerifyMsg("✓ key works — model responded");
      } else {
        setVerifyState("fail");
        setVerifyMsg(data.reason ?? "could not verify this key — try again");
      }
    } catch {
      setVerifyState("fail");
      setVerifyMsg("could not verify this key — try again");
    }
  }

  async function onSave() {
    setSaving(true);
    setSaveError(null);
    setSavedMsg(null);
    try {
      const res = await fetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, base_url: baseUrl, apiKey }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        last4?: string;
      };
      if (!res.ok) {
        setSaveError(data.error ?? "Could not save your key. Try again.");
        return;
      }
      setApiKey("");
      resetVerify();
      setSavedMsg(`✓ saved — ${PROVIDER_TITLE[provider]} models unlocked below`);
      await refreshKeys();
    } catch {
      setSaveError("Could not save your key. Try again.");
    } finally {
      setSaving(false);
    }
  }

  // KEY-02: Save is gated on a successful verify for the current key.
  const canSave =
    apiKey.trim().length > 0 &&
    baseUrl.trim().length > 0 &&
    verifyState === "ok" &&
    !saving;

  return (
    <div className="mx-auto w-full max-w-[860px] self-start px-8 py-[34px]">
      <p className="m-0 mb-[10px] text-[11px] font-[700] uppercase tracking-[.08em] text-[var(--accent)]">
        Step 2 of 3 · Bring your own key
      </p>
      <h1 className="m-0 text-[24px] font-[650] tracking-[-.02em]">
        Connect a model provider
      </h1>
      <p className="mb-6 mt-2 max-w-[62ch] text-[14.5px] leading-[1.6] text-[var(--text-2)]">
        MicroManus never stores your key in plaintext — it&apos;s encrypted and
        used only while your run executes. Verify it with a 1-token test before
        saving.
      </p>

      <div className="mb-[22px] rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow-sm)]">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1.5 block text-[13px] font-[600]">Provider</span>
            <select
              value={provider}
              onChange={(e) => onProviderChange(e.target.value as Provider)}
              className="h-[44px] w-full cursor-pointer rounded-[var(--radius)] border border-[var(--border-strong)] bg-[var(--surface)] px-3 text-[14px] text-[var(--text)]"
            >
              {PROVIDER_OPTIONS.map((o) => (
                <option key={o.value} value={o.value} disabled={o.disabled}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="mb-1.5 block text-[13px] font-[600]">
              Base URL{" "}
              <span className="font-[400] text-[var(--text-3)]">· editable</span>
            </span>
            <div className="flex h-[44px] items-center rounded-[var(--radius)] border border-[var(--border-strong)] bg-[var(--surface)] px-[13px] focus-within:border-[var(--accent)] focus-within:shadow-[0_0_0_3px_var(--accent-soft)]">
              <input
                value={baseUrl}
                onChange={(e) => {
                  setBaseUrl(e.target.value);
                  resetVerify();
                }}
                spellCheck={false}
                className="w-full border-0 bg-transparent font-[var(--mono)] text-[13.5px] text-[var(--text)] outline-none"
              />
            </div>
          </label>
        </div>

        <div className="mt-4">
          <span className="mb-1.5 block text-[13px] font-[600]">API key</span>
          <div className="flex h-[44px] items-center gap-2 rounded-[var(--radius)] border border-[var(--border-strong)] bg-[var(--surface)] px-[13px] focus-within:border-[var(--accent)] focus-within:shadow-[0_0_0_3px_var(--accent-soft)]">
            <input
              value={apiKey}
              onChange={(e) => {
                setApiKey(e.target.value);
                resetVerify();
              }}
              type="text"
              autoComplete="off"
              spellCheck={false}
              placeholder="sk-..."
              className="w-full border-0 bg-transparent font-[var(--mono)] text-[13.5px] text-[var(--text)] outline-none"
            />
          </div>
          <div className="mt-1.5 text-[11.5px] leading-[1.5] text-[var(--text-3)]">
            After saving you&apos;ll only ever see the last 4 characters.
          </div>
        </div>

        <div className="mt-4 flex items-center gap-[10px]">
          <button
            type="button"
            onClick={onTest}
            disabled={verifyState === "verifying"}
            className="flex h-9 items-center gap-[7px] rounded-[var(--radius-sm)] border border-[var(--border-strong)] bg-transparent px-3 text-[13.5px] font-[550] text-[var(--text-2)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text)] disabled:cursor-not-allowed disabled:opacity-70"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-[15px] w-[15px]"
            >
              <path d="M9 12l2 2 4-4" />
              <circle cx="12" cy="12" r="9" />
            </svg>
            Test with 1 token
          </button>
          {verifyMsg && (
            <span
              role={verifyState === "fail" ? "alert" : undefined}
              className="text-[12.5px]"
              style={{
                color:
                  verifyState === "ok"
                    ? "var(--success)"
                    : verifyState === "fail"
                      ? "var(--error)"
                      : "var(--text-3)",
              }}
            >
              {verifyMsg}
            </span>
          )}
          <button
            type="button"
            onClick={onSave}
            disabled={!canSave}
            className="ml-auto flex h-9 items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--accent)] bg-[var(--accent)] px-[15px] text-[13.5px] font-[600] text-white transition-colors hover:bg-[var(--accent-hover)] active:translate-y-px disabled:cursor-not-allowed disabled:border-[var(--border)] disabled:bg-[var(--surface-2)] disabled:text-[var(--text-3)]"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-4 w-4"
            >
              <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
              <path d="M17 21v-8H7v8M7 3v5h8" />
            </svg>
            {saving ? "Saving…" : "Save key"}
          </button>
        </div>

        {saveError && (
          <p
            role="alert"
            className="mt-3 text-[12.5px] font-[500] text-[var(--error)]"
          >
            {saveError}
          </p>
        )}
        {savedMsg && (
          <p className="mt-3 text-[12.5px] font-[500] text-[var(--success)]">
            {savedMsg}
          </p>
        )}
      </div>

      {/* Saved keys — last-4 only (KEY-03 surface). Empty-state nudge (UX-02). */}
      <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow-sm)]">
        <div className="mb-3 text-[11px] font-[600] uppercase tracking-[.06em] text-[var(--text-3)]">
          Saved keys
        </div>
        {loadingKeys ? (
          <p className="m-0 text-[13px] text-[var(--text-3)]">Loading…</p>
        ) : keys.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-4 py-6 text-center text-[var(--text-3)]">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-[26px] w-[26px] opacity-50"
            >
              <rect x="5" y="11" width="14" height="10" rx="2" />
              <path d="M8 11V7a4 4 0 0 1 8 0v4" />
            </svg>
            <p className="m-0 max-w-[42ch] text-[12.5px] leading-[1.5]">
              No keys yet. Add your first provider key above — pick OpenAI or
              Kimi, verify it, and save. Your models unlock below.
            </p>
          </div>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {keys.map((k) => (
              <li
                key={k.provider}
                className="flex items-center gap-3 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)] px-[14px] py-[11px]"
              >
                <span className="text-[13.5px] font-[600]">
                  {PROVIDER_TITLE[k.provider] ?? k.provider}
                </span>
                {k.base_url && (
                  <span className="truncate font-[var(--mono)] text-[11px] text-[var(--text-3)]">
                    {k.base_url}
                  </span>
                )}
                <span className="ml-auto font-[var(--mono)] text-[12px] text-[var(--text-3)]">
                  last 4: {k.last4}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Step 3 · Model registry (KEY-05 / D-22). Saving a provider's key
          unlocks that provider's rows via savedProviders below. */}
      <div className="mt-[22px]">
        <p className="m-0 mb-3 text-[11px] font-[700] uppercase tracking-[.08em] text-[var(--text-3)]">
          Step 3 · Model registry{" "}
          <span className="font-[500] normal-case tracking-normal text-[var(--text-3)]">
            — verified per-1M pricing, pick per chat
          </span>
        </p>
        <ModelPicker
          variant="registry"
          models={MODEL_REGISTRY}
          savedProviders={keys.map((k) => k.provider)}
          value={selectedModel}
          onChange={setSelectedModel}
        />
        <p className="mt-4 text-[11.5px] leading-[1.5] text-[var(--text-3)]">
          Prices verified against each provider&apos;s pricing page at build time
          (D-24). Cost is always computed from provider-reported usage — never
          estimated.
        </p>
      </div>
    </div>
  );
}
