"use client";

import { useCallback, useEffect, useState } from "react";
import { parseTokenAmount } from "@/lib/token-format";

type Translate = (key: string, params?: Record<string, string | number>) => string;

interface Props {
  isOpen: boolean;
  onClose: () => void;
  session: { id: string; name?: string } | null;
  currentContextWindow?: number | null;
  translate: Translate;
  onLimitUpdated?: (newLimit: number | null) => void;
}

const PRESETS = [
  { label: "64k", value: 64_000 },
  { label: "128k", value: 128_000 },
  { label: "200k", value: 200_000 },
  { label: "270k", value: 270_000 },
  { label: "500k", value: 500_000 },
  { label: "1M", value: 1_000_000 },
];

function formatNumber(n: number): string {
  return n.toLocaleString();
}

export function SessionContextLimitModal({
  isOpen,
  onClose,
  session,
  currentContextWindow,
  translate,
  onLimitUpdated,
}: Props) {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [customLimitInput, setCustomLimitInput] = useState("");
  const [thresholdPercentInput, setThresholdPercentInput] = useState("");
  const [modelContextWindow, setModelContextWindow] = useState<number | null>(null);
  const [serverCustomLimit, setServerCustomLimit] = useState<number | null>(null);
  const [feedback, setFeedback] = useState<{ text: string; isError?: boolean } | null>(null);

  const sessionId = session?.id;

  // Load current session config
  useEffect(() => {
    if (!isOpen || !sessionId) return;
    setLoading(true);
    setFeedback(null);
    fetch(`/api/sessions/${encodeURIComponent(sessionId)}/context-limit`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data) {
          setServerCustomLimit(data.customLimit ?? null);
          setModelContextWindow(data.modelContextWindow ?? currentContextWindow ?? null);
          if (data.customLimit) {
            setCustomLimitInput(String(data.customLimit));
          } else {
            setCustomLimitInput("");
          }
          if (data.thresholdPercent) {
            setThresholdPercentInput(String(data.thresholdPercent));
          } else {
            setThresholdPercentInput("");
          }
        }
      })
      .catch((err) => {
        setFeedback({ text: String(err), isError: true });
      })
      .finally(() => {
        setLoading(false);
      });
  }, [isOpen, sessionId, currentContextWindow]);

  const parsedLimit = customLimitInput.trim() ? parseTokenAmount(customLimitInput) : null;

  const handleSave = useCallback(async () => {
    if (!sessionId) return;
    setSaving(true);
    setFeedback(null);
    try {
      const thresholdVal = thresholdPercentInput.trim() ? parseInt(thresholdPercentInput, 10) : null;
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/context-limit`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contextLimit: parsedLimit,
          thresholdPercent: thresholdVal && thresholdVal > 0 && thresholdVal <= 100 ? thresholdVal : null,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Save failed");
      }

      const data = await res.json();
      setServerCustomLimit(data.customLimit ?? null);
      onLimitUpdated?.(data.customLimit ?? null);
      setFeedback({ text: translate("contextLimit.saveSuccess") });
      setTimeout(() => {
        onClose();
      }, 900);
    } catch (err) {
      setFeedback({ text: err instanceof Error ? err.message : String(err), isError: true });
    } finally {
      setSaving(false);
    }
  }, [sessionId, parsedLimit, thresholdPercentInput, onLimitUpdated, onClose, translate]);

  const handleReset = useCallback(async () => {
    if (!sessionId) return;
    setSaving(true);
    setFeedback(null);
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/context-limit`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contextLimit: null, thresholdPercent: null }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Reset failed");
      }

      setCustomLimitInput("");
      setThresholdPercentInput("");
      setServerCustomLimit(null);
      onLimitUpdated?.(null);
      setFeedback({ text: translate("contextLimit.resetSuccess") });
      setTimeout(() => {
        onClose();
      }, 900);
    } catch (err) {
      setFeedback({ text: err instanceof Error ? err.message : String(err), isError: true });
    } finally {
      setSaving(false);
    }
  }, [sessionId, onLimitUpdated, onClose, translate]);

  if (!isOpen || !session) return null;

  return (
    <div
      className="context-limit-modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="context-limit-modal" role="dialog" aria-modal="true" aria-label={translate("contextLimit.title")}>
        <div className="context-limit-modal-header">
          <div className="context-limit-modal-title">
            <span>⚙️ {translate("contextLimit.title")}</span>
          </div>
          <button type="button" className="context-limit-modal-close" onClick={onClose} title={translate("tools.cancel")}>
            ✕
          </button>
        </div>

        <div className="context-limit-modal-body">
          <p className="context-limit-modal-desc">{translate("contextLimit.desc")}</p>

          <div className="context-limit-session-info">
            <div className="context-limit-info-row">
              <span className="context-limit-info-label">{translate("session.name")}:</span>
              <span className="context-limit-info-value">{session.name || session.id.slice(0, 16)}</span>
            </div>
            {modelContextWindow && (
              <div className="context-limit-info-row">
                <span className="context-limit-info-label">{translate("contextLimit.currentModel")}:</span>
                <span className="context-limit-info-value">{formatNumber(modelContextWindow)} tokens</span>
              </div>
            )}
            <div className="context-limit-info-row">
              <span className="context-limit-info-label">{translate("contextLimit.customLimit")}:</span>
              <span className={`context-limit-info-value ${serverCustomLimit ? "active" : ""}`}>
                {serverCustomLimit
                  ? `${formatNumber(serverCustomLimit)} tokens (${translate("tools.customizedBadge")})`
                  : translate("contextLimit.default")}
              </span>
            </div>
          </div>

          <div className="context-limit-section">
            <div className="context-limit-section-title">{translate("contextLimit.preset")}</div>
            <div className="context-limit-presets">
              {PRESETS.map((p) => {
                const active = parsedLimit === p.value;
                return (
                  <button
                    key={p.label}
                    type="button"
                    className={`context-limit-preset-btn ${active ? "active" : ""}`}
                    onClick={() => setCustomLimitInput(p.label)}
                  >
                    {p.label}
                  </button>
                );
              })}
              <button
                type="button"
                className={`context-limit-preset-btn ${!parsedLimit ? "active" : ""}`}
                onClick={() => setCustomLimitInput("")}
              >
                {translate("contextLimit.default")}
              </button>
            </div>
          </div>

          <div className="context-limit-section">
            <label className="context-limit-label" htmlFor="custom-token-input">
              {translate("contextLimit.customLimit")} (Tokens):
            </label>
            <div className="context-limit-input-wrap">
              <input
                id="custom-token-input"
                type="text"
                className="context-limit-input"
                placeholder={translate("contextLimit.inputPlaceholder")}
                value={customLimitInput}
                onChange={(e) => setCustomLimitInput(e.target.value)}
              />
              {parsedLimit && (
                <div className="context-limit-parsed-preview">
                  = {formatNumber(parsedLimit)} tokens
                </div>
              )}
            </div>
          </div>

          <div className="context-limit-section">
            <label className="context-limit-label" htmlFor="threshold-percent-input">
              {translate("contextLimit.thresholdPercent")}:
            </label>
            <input
              id="threshold-percent-input"
              type="number"
              min="20"
              max="95"
              className="context-limit-input context-limit-input-sm"
              placeholder="65"
              value={thresholdPercentInput}
              onChange={(e) => setThresholdPercentInput(e.target.value)}
            />
            <div className="context-limit-hint">{translate("contextLimit.thresholdHint")}</div>
          </div>

          {feedback && (
            <div className={`context-limit-feedback ${feedback.isError ? "error" : "success"}`}>
              {feedback.text}
            </div>
          )}
        </div>

        <div className="context-limit-modal-footer">
          {serverCustomLimit && (
            <button
              type="button"
              className="context-limit-btn context-limit-btn-reset"
              disabled={saving || loading}
              onClick={handleReset}
            >
              ↺ {translate("contextLimit.reset")}
            </button>
          )}
          <div style={{ flex: 1 }} />
          <button
            type="button"
            className="context-limit-btn context-limit-btn-cancel"
            disabled={saving}
            onClick={onClose}
          >
            {translate("tools.cancel")}
          </button>
          <button
            type="button"
            className="context-limit-btn context-limit-btn-primary"
            disabled={saving || loading}
            onClick={handleSave}
          >
            {translate(saving ? "contextLimit.saving" : "contextLimit.save")}
          </button>
        </div>
      </div>

      <style>{`
        .context-limit-modal-backdrop {
          position: fixed;
          inset: 0;
          background: rgba(0, 0, 0, 0.55);
          backdrop-filter: blur(2px);
          z-index: 1100;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 16px;
        }
        .context-limit-modal {
          background: var(--bg-panel);
          border: 1px solid var(--border);
          border-radius: 10px;
          box-shadow: 0 16px 40px rgba(0, 0, 0, 0.35);
          width: 100%;
          max-width: 460px;
          display: flex;
          flex-direction: column;
          overflow: hidden;
          font-family: inherit;
        }
        .context-limit-modal-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 14px 18px;
          border-bottom: 1px solid var(--border);
        }
        .context-limit-modal-title {
          font-size: 14px;
          font-weight: 700;
          color: var(--text);
        }
        .context-limit-modal-close {
          background: transparent;
          border: none;
          color: var(--text-dim);
          cursor: pointer;
          font-size: 14px;
          padding: 4px;
        }
        .context-limit-modal-close:hover {
          color: var(--text);
        }
        .context-limit-modal-body {
          padding: 16px 18px;
          display: flex;
          flex-direction: column;
          gap: 14px;
          overflow-y: auto;
          max-height: 70vh;
        }
        .context-limit-modal-desc {
          margin: 0;
          font-size: 11.5px;
          line-height: 1.5;
          color: var(--text-muted);
        }
        .context-limit-session-info {
          background: color-mix(in srgb, var(--bg-panel) 90%, var(--bg));
          border: 1px solid var(--border);
          border-radius: 6px;
          padding: 10px 12px;
          display: flex;
          flex-direction: column;
          gap: 6px;
          font-size: 11px;
        }
        .context-limit-info-row {
          display: flex;
          justify-content: space-between;
          align-items: center;
        }
        .context-limit-info-label {
          color: var(--text-dim);
        }
        .context-limit-info-value {
          color: var(--text);
          font-weight: 500;
          font-family: var(--font-mono);
        }
        .context-limit-info-value.active {
          color: var(--accent);
          font-weight: 600;
        }
        .context-limit-section {
          display: flex;
          flex-direction: column;
          gap: 6px;
        }
        .context-limit-section-title,
        .context-limit-label {
          font-size: 11px;
          font-weight: 600;
          color: var(--text-dim);
        }
        .context-limit-presets {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
        }
        .context-limit-preset-btn {
          font-size: 11px;
          padding: 4px 10px;
          border-radius: 4px;
          border: 1px solid var(--border);
          background: var(--bg);
          color: var(--text-muted);
          cursor: pointer;
          font-family: var(--font-mono);
          transition: all 0.15s ease;
        }
        .context-limit-preset-btn:hover {
          background: var(--bg-hover);
          color: var(--text);
          border-color: var(--border-hover, var(--border));
        }
        .context-limit-preset-btn.active {
          background: color-mix(in srgb, var(--accent) 15%, transparent);
          color: var(--accent);
          border-color: var(--accent);
          font-weight: 600;
        }
        .context-limit-input-wrap {
          display: flex;
          flex-direction: column;
          gap: 4px;
        }
        .context-limit-input {
          width: 100%;
          box-sizing: border-box;
          padding: 7px 10px;
          font-size: 12px;
          border-radius: 6px;
          border: 1px solid var(--border);
          background: var(--bg);
          color: var(--text);
          font-family: var(--font-mono);
        }
        .context-limit-input:focus {
          outline: none;
          border-color: var(--accent);
        }
        .context-limit-input-sm {
          max-width: 120px;
        }
        .context-limit-parsed-preview {
          font-size: 11px;
          color: var(--accent);
          font-family: var(--font-mono);
        }
        .context-limit-hint {
          font-size: 10.5px;
          color: var(--text-dim);
        }
        .context-limit-feedback {
          padding: 7px 10px;
          border-radius: 6px;
          font-size: 11px;
        }
        .context-limit-feedback.success {
          background: color-mix(in srgb, #10b981 15%, transparent);
          color: #10b981;
          border: 1px solid color-mix(in srgb, #10b981 30%, transparent);
        }
        .context-limit-feedback.error {
          background: color-mix(in srgb, #ef4444 15%, transparent);
          color: #ef4444;
          border: 1px solid color-mix(in srgb, #ef4444 30%, transparent);
        }
        .context-limit-modal-footer {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 12px 18px;
          border-top: 1px solid var(--border);
          background: color-mix(in srgb, var(--bg-panel) 96%, var(--bg));
        }
        .context-limit-btn {
          font-size: 11px;
          padding: 6px 14px;
          border-radius: 6px;
          border: 1px solid var(--border);
          cursor: pointer;
          font-weight: 500;
          transition: all 0.15s ease;
        }
        .context-limit-btn-primary {
          background: var(--accent);
          color: #fff;
          border-color: var(--accent);
        }
        .context-limit-btn-primary:hover {
          opacity: 0.9;
        }
        .context-limit-btn-cancel,
        .context-limit-btn-reset {
          background: transparent;
          color: var(--text-muted);
        }
        .context-limit-btn-cancel:hover,
        .context-limit-btn-reset:hover {
          background: var(--bg-hover);
          color: var(--text);
        }
      `}</style>
    </div>
  );
}
