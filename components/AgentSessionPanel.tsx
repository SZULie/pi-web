"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { SessionInfo, SubagentSessionStatus } from "@/lib/types";

interface Props {
  rootSession: SessionInfo;
  subagents: SessionInfo[];
  selectedSessionId: string;
  runningSessionIds: ReadonlySet<string>;
  onSelectSession: (session: SessionInfo) => void;
}

interface MagicContextStatusData {
  available: boolean;
  historian?: {
    model: string;
    recentInvocations: Array<{
      id: number;
      started_at: number;
      ended_at?: number;
      status: string;
      input_tokens: number;
      output_tokens: number;
      error?: string | null;
    }>;
  };
  dreamer?: {
    model: string;
    latestRun?: {
      id: number;
      started_at: number;
      finished_at: number;
      tasks_succeeded: number;
      tasks_failed: number;
      tasks_json?: string;
    };
    recentInvocations: Array<{
      id: number;
      task?: string;
      started_at: number;
      ended_at?: number;
      status: string;
      input_tokens: number;
      output_tokens: number;
    }>;
  };
  memories?: {
    total: number;
    items: Array<{ id: number; category: string; content: string }>;
  };
}

function sessionTitle(session: SessionInfo): string {
  return session.name || session.firstMessage || session.id.slice(0, 12);
}

function formatRelativeTime(value: string | number, locale: string): string {
  const timestamp = typeof value === "number" ? value : new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return "";
  const elapsedSeconds = Math.round((timestamp - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (Math.abs(elapsedSeconds) < 60) return formatter.format(elapsedSeconds, "second");
  const elapsedMinutes = Math.round(elapsedSeconds / 60);
  if (Math.abs(elapsedMinutes) < 60) return formatter.format(elapsedMinutes, "minute");
  const elapsedHours = Math.round(elapsedMinutes / 60);
  if (Math.abs(elapsedHours) < 24) return formatter.format(elapsedHours, "hour");
  return formatter.format(Math.round(elapsedHours / 24), "day");
}

export function statusColor(status: SubagentSessionStatus): string {
  if (status === "running" || status === "starting") return "var(--accent)";
  if (status === "completed") return "#16a34a";
  if (status === "failed") return "#dc2626";
  if (status === "aborted") return "#d97706";
  return "var(--text-dim)";
}

export function StatusIcon({ status }: { status: SubagentSessionStatus }) {
  if (status === "running" || status === "starting") {
    return (
      <svg className="animate-spin" width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" opacity="0.25" />
        <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    );
  }
  if (status === "failed") {
    return (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
        <circle cx="12" cy="12" r="9" /><path d="m9 9 6 6M15 9l-6 6" />
      </svg>
    );
  }
  if (status === "aborted" || status === "interrupted") {
    return (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
        <circle cx="12" cy="12" r="9" /><path d="M9 9h6v6H9z" />
      </svg>
    );
  }
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" /><path d="m8 12 3 3 5-6" />
    </svg>
  );
}

function AgentRow({
  session,
  main,
  selected,
  running,
  onSelect,
}: {
  session: SessionInfo;
  main?: boolean;
  selected: boolean;
  running: boolean;
  onSelect: () => void;
}) {
  const { locale, t } = useI18n();
  const relation = session.relation?.kind === "subagent" ? session.relation : null;
  const status: SubagentSessionStatus = running ? "running" : relation?.status ?? "completed";
  const primary = main ? t("agentSwitcher.main") : relation?.description || sessionTitle(session);
  const secondary = main
    ? sessionTitle(session)
    : `${relation?.profile ?? t("agentSwitcher.subagent")} · ${formatRelativeTime(session.modified, locale)}`;

  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onClick={onSelect}
      style={{
        width: "100%",
        minHeight: 56,
        display: "grid",
        gridTemplateColumns: "28px minmax(0, 1fr) auto",
        alignItems: "center",
        gap: 9,
        padding: "7px 12px",
        border: "none",
        borderBottom: "1px solid var(--border)",
        borderLeft: selected ? "2px solid var(--accent)" : "2px solid transparent",
        background: selected ? "var(--bg-selected)" : "transparent",
        color: "var(--text)",
        cursor: "pointer",
        textAlign: "left",
      }}
      onMouseEnter={(event) => {
        if (!selected) event.currentTarget.style.background = "var(--bg-hover)";
      }}
      onMouseLeave={(event) => {
        if (!selected) event.currentTarget.style.background = "transparent";
      }}
    >
      <span style={{ width: 28, height: 28, display: "grid", placeItems: "center", color: main ? "var(--text-muted)" : "var(--accent)" }}>
        {main ? (
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" />
          </svg>
        ) : (
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="5" y="7" width="14" height="11" rx="2" /><path d="M9 11h.01M15 11h.01M9 15h6M12 7V4M10 4h4" />
          </svg>
        )}
      </span>
      <span style={{ minWidth: 0 }}>
        <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12, fontWeight: selected ? 600 : 500 }} title={primary}>
          {primary}
        </span>
        <span style={{ display: "block", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text-dim)", fontSize: 11 }} title={secondary}>
          {secondary}
        </span>
      </span>
      <span style={{ display: "flex", alignItems: "center", gap: 6, color: main && !running ? "var(--text-dim)" : statusColor(status), fontSize: 11, whiteSpace: "nowrap" }}>
        {main && !running ? (
          selected ? t("agentSwitcher.current") : null
        ) : (
          <>
            <StatusIcon status={status} />
            <span>{t(`agentSwitcher.status.${status}`)}</span>
          </>
        )}
      </span>
    </button>
  );
}

export function AgentSessionPanel({ rootSession, subagents, selectedSessionId, runningSessionIds, onSelectSession }: Props) {
  const { t, locale } = useI18n();
  const [activeTab, setActiveTab] = useState<"sessions" | "system">("sessions");
  const [query, setQuery] = useState("");
  const [magicStatus, setMagicStatus] = useState<MagicContextStatusData | null>(null);
  const [actionFeedback, setActionFeedback] = useState<string | null>(null);
  const [expandedMemoryCategory, setExpandedMemoryCategory] = useState<string | null>("PROJECT_RULES");
  const hasSystemAgents = Boolean(magicStatus?.available);

  useEffect(() => {
    fetch("/api/magic-context/status")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.available) setMagicStatus(data);
      })
      .catch(() => {});
  }, []);

  const triggerMagicAction = useCallback(async (action: "wrapup" | "dream") => {
    setActionFeedback(t("agentSwitcher.triggerSuccess"));
    try {
      await fetch("/api/magic-context/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, sessionId: rootSession.id }),
      });
      setTimeout(() => {
        setActionFeedback(null);
        // refresh status
        fetch("/api/magic-context/status")
          .then((r) => r.json())
          .then(setMagicStatus)
          .catch(() => {});
      }, 2500);
    } catch {
      setActionFeedback("Failed to trigger action");
    }
  }, [rootSession.id, t]);

  const sortedSubagents = useMemo(() => [...subagents].sort((a, b) => {
    const aRunning = runningSessionIds.has(a.id);
    const bRunning = runningSessionIds.has(b.id);
    if (aRunning !== bRunning) return aRunning ? -1 : 1;
    return b.modified.localeCompare(a.modified);
  }), [runningSessionIds, subagents]);

  const normalizedQuery = query.trim().toLowerCase();
  const visibleSubagents = normalizedQuery
    ? sortedSubagents.filter((session) => {
        const relation = session.relation?.kind === "subagent" ? session.relation : null;
        return [relation?.description, relation?.profile, session.name, session.firstMessage]
          .some((value) => value?.toLowerCase().includes(normalizedQuery));
      })
    : sortedSubagents;
  const runningCount = subagents.filter((session) => runningSessionIds.has(session.id)).length;

  const categorizedMemories = useMemo(() => {
    if (!magicStatus?.memories?.items) return {};
    const map: Record<string, Array<{ id: number; content: string }>> = {};
    for (const item of magicStatus.memories.items) {
      if (!map[item.category]) map[item.category] = [];
      map[item.category].push(item);
    }
    return map;
  }, [magicStatus?.memories?.items]);

  return (
    <div
      role="listbox"
      aria-label={t("agentSwitcher.title")}
      style={{
        background: "var(--bg-panel)",
        borderLeft: "1px solid var(--border)",
        borderRight: "1px solid var(--border)",
        borderBottom: "1px solid var(--border)",
        borderRadius: "0 0 6px 6px",
        boxShadow: "0 10px 28px rgba(0,0,0,0.10)",
        overflow: "hidden",
      }}
    >
      <div>
        <div style={{ minHeight: 44, display: "flex", alignItems: "center", gap: 8, padding: "7px 12px", borderBottom: "1px solid var(--border)" }}>
          <strong style={{ fontSize: 12, fontWeight: 600 }}>{t("agentSwitcher.title")}</strong>
          <span style={{ color: "var(--text-dim)", fontSize: 11 }}>
            {t("agentSwitcher.count", { count: subagents.length })}
          </span>
          {runningCount > 0 && (
            <span style={{ marginLeft: "auto", color: "var(--accent)", fontSize: 11 }}>
              {t("agentSwitcher.runningCount", { count: runningCount })}
            </span>
          )}
          {hasSystemAgents && (
            <div style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
              <button
                type="button"
                onClick={() => setActiveTab("sessions")}
                style={{
                  fontSize: 10.5,
                  padding: "3px 8px",
                  borderRadius: 4,
                  border: "1px solid var(--border)",
                  background: activeTab === "sessions" ? "var(--accent)" : "transparent",
                  color: activeTab === "sessions" ? "#fff" : "var(--text-muted)",
                  cursor: "pointer",
                  fontWeight: 500,
                }}
              >
                {t("agentSwitcher.sessionAgents")}
              </button>
              <button
                type="button"
                onClick={() => setActiveTab("system")}
                style={{
                  fontSize: 10.5,
                  padding: "3px 8px",
                  borderRadius: 4,
                  border: "1px solid var(--border)",
                  background: activeTab === "system" ? "var(--accent)" : "transparent",
                  color: activeTab === "system" ? "#fff" : "var(--text-muted)",
                  cursor: "pointer",
                  fontWeight: 500,
                }}
              >
                🔮 {t("agentSwitcher.systemAgents")}
              </button>
            </div>
          )}
        </div>

        {actionFeedback && (
          <div style={{ padding: "6px 12px", background: "color-mix(in srgb, var(--accent) 15%, transparent)", color: "var(--accent)", fontSize: 11 }}>
            {actionFeedback}
          </div>
        )}

        {activeTab === "sessions" ? (
          <>
            {subagents.length > 8 && (
              <div style={{ padding: 8, borderBottom: "1px solid var(--border)" }}>
                <input
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={t("agentSwitcher.search")}
                  aria-label={t("agentSwitcher.search")}
                  style={{
                    width: "100%", height: 32, padding: "0 10px",
                    border: "1px solid var(--border)", borderRadius: 6,
                    background: "var(--bg)", color: "var(--text)", fontSize: 12, outline: "none",
                  }}
                />
              </div>
            )}
            <div style={{ maxHeight: "min(58dvh, 480px)", overflowY: "auto" }}>
              <AgentRow
                session={rootSession}
                main
                selected={rootSession.id === selectedSessionId}
                running={runningSessionIds.has(rootSession.id)}
                onSelect={() => onSelectSession(rootSession)}
              />
              {visibleSubagents.map((session) => (
                <AgentRow
                  key={session.id}
                  session={session}
                  selected={session.id === selectedSessionId}
                  running={runningSessionIds.has(session.id)}
                  onSelect={() => onSelectSession(session)}
                />
              ))}
              {visibleSubagents.length === 0 && (
                <div style={{ padding: "22px 12px", color: "var(--text-dim)", fontSize: 12, textAlign: "center" }}>
                  {t("agentSwitcher.noMatches")}
                </div>
              )}
            </div>
          </>
        ) : (
          <div style={{ maxHeight: "min(65dvh, 520px)", overflowY: "auto", padding: "10px 12px", display: "flex", flexDirection: "column", gap: 12 }}>
            {/* Historian card */}
            <div style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, padding: 10 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ fontSize: 13 }}>📚</span>
                  <span style={{ fontSize: 12, fontWeight: 600 }}>{t("agentSwitcher.historian")}</span>
                </div>
                <button
                  type="button"
                  onClick={() => triggerMagicAction("wrapup")}
                  style={{
                    fontSize: 11,
                    padding: "3px 8px",
                    borderRadius: 4,
                    border: "1px solid var(--border)",
                    background: "var(--bg-hover)",
                    color: "var(--text)",
                    cursor: "pointer",
                  }}
                >
                  📦 {t("agentSwitcher.wrapup")}
                </button>
              </div>
              <div style={{ fontSize: 11, color: "var(--text-dim)", display: "flex", flexDirection: "column", gap: 4 }}>
                <div>模型: <code style={{ color: "var(--accent)" }}>{magicStatus?.historian?.model || "cpa/gpt-5.6-terra"}</code></div>
                {magicStatus?.historian?.recentInvocations?.[0] && (
                  <div>
                    最近运行: {formatRelativeTime(magicStatus.historian.recentInvocations[0].started_at, locale)}
                    {" · "}Token: {magicStatus.historian.recentInvocations[0].input_tokens} / {magicStatus.historian.recentInvocations[0].output_tokens}
                  </div>
                )}
              </div>
            </div>

            {/* Dreamer card */}
            <div style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, padding: 10 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ fontSize: 13 }}>💭</span>
                  <span style={{ fontSize: 12, fontWeight: 600 }}>{t("agentSwitcher.dreamer")}</span>
                </div>
                <button
                  type="button"
                  onClick={() => triggerMagicAction("dream")}
                  style={{
                    fontSize: 11,
                    padding: "3px 8px",
                    borderRadius: 4,
                    border: "1px solid var(--border)",
                    background: "var(--bg-hover)",
                    color: "var(--text)",
                    cursor: "pointer",
                  }}
                >
                  ✨ {t("agentSwitcher.dream")}
                </button>
              </div>
              <div style={{ fontSize: 11, color: "var(--text-dim)", display: "flex", flexDirection: "column", gap: 4 }}>
                <div>模型: <code style={{ color: "var(--accent)" }}>{magicStatus?.dreamer?.model || "cpa/gpt-5.6-terra"}</code></div>
                {magicStatus?.dreamer?.latestRun && (
                  <div>
                    最近整理: {formatRelativeTime(magicStatus.dreamer.latestRun.started_at, locale)}
                    {" · "}完成任务: {magicStatus.dreamer.latestRun.tasks_succeeded} 项
                  </div>
                )}
              </div>
            </div>

            {/* Project memories card */}
            <div style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, padding: 10 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ fontSize: 13 }}>🧠</span>
                  <span style={{ fontSize: 12, fontWeight: 600 }}>{t("agentSwitcher.memories")}</span>
                </div>
                <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
                  共 {magicStatus?.memories?.total || 0} 条
                </span>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {Object.entries(categorizedMemories).map(([cat, items]) => {
                  const isExpanded = expandedMemoryCategory === cat;
                  return (
                    <div key={cat} style={{ border: "1px solid var(--border)", borderRadius: 4, overflow: "hidden" }}>
                      <button
                        type="button"
                        onClick={() => setExpandedMemoryCategory(isExpanded ? null : cat)}
                        style={{
                          width: "100%",
                          padding: "6px 8px",
                          background: "var(--bg-panel)",
                          border: "none",
                          borderBottom: isExpanded ? "1px solid var(--border)" : "none",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          fontSize: 11,
                          fontWeight: 600,
                          color: "var(--text)",
                          cursor: "pointer",
                        }}
                      >
                        <span>{cat}</span>
                        <span style={{ color: "var(--text-dim)", fontWeight: 400 }}>{items.length} 条 {isExpanded ? "▲" : "▼"}</span>
                      </button>
                      {isExpanded && (
                        <div style={{ maxHeight: 180, overflowY: "auto", padding: "6px 8px", display: "flex", flexDirection: "column", gap: 6, fontSize: 11, color: "var(--text-muted)" }}>
                          {items.map((m) => (
                            <div key={m.id} style={{ borderBottom: "1px solid var(--border)", paddingBottom: 4 }}>
                              <span style={{ color: "var(--accent)", fontWeight: 600, marginRight: 6 }}>#{m.id}</span>
                              <span>{m.content}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
