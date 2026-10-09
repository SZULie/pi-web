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

interface GoalRunnerDiagnostics {
  health: "idle" | "running" | "healthy" | "waiting" | "retrying" | "overdue" | "stale" | "failed";
  healthReason: string;
  retryDelayMs: number | null;
  retryOverdueMs?: number | null;
  updatedAgeMs: number;
}

interface GoalRunnerStatusData {
  available: boolean;
  storePath: string;
  config?: {
    version: string;
    storePath?: string;
    maxRetryMs: number;
    defaultMode: string;
    lockTimeoutMs?: number;
    lockStaleMs?: number;
    lockPath?: string;
    backupPath?: string;
    watchdogIntervalMs?: number;
    maxEvents?: number;
  };
  lock?: {
    path: string;
    exists: boolean;
    ageMs: number | null;
    stale: boolean;
    owner: Record<string, unknown> | null;
  };
  backup?: {
    path: string;
    exists: boolean;
    readable: boolean;
    ageMs: number | null;
    sizeBytes: number | null;
    sessionCount: number | null;
    containsCurrentSession?: boolean | null;
    currentSessionStatus?: string | null;
    primaryExists: boolean;
    primaryReadable: boolean;
    restorable: boolean;
    error?: string;
    primaryError?: string;
  };
  watchdog?: {
    enabled: boolean;
    active: boolean;
    intervalMs: number;
    startedAt?: number | null;
    nextScanAt?: number | null;
    nextScanOverdueMs?: number;
    lastScanAt: number | null;
    lastScanDurationMs?: number | null;
    lastRestoreAt: number | null;
    lastCandidateCount: number;
    lastRestoredCount: number;
    lastSkippedRunningCount?: number;
    lastError: string | null;
  };
  current: null | {
    sessionId: string;
    objective: string;
    status: string;
    phase: string;
    mode: string;
    iteration: number;
    consecutiveFailures: number;
    nextRetryAt?: number;
    lastError?: string;
    diagnostics?: GoalRunnerDiagnostics;
    runtime?: { liveRunning: boolean; completionNotificationSuppressed: boolean };
    subtasks: Array<{ id: string; text: string; status: string }>;
    eventSummary?: { total: number; rawTotal?: number; returnedTotal?: number; compacted?: boolean; filtered?: boolean; filterTypes?: string[]; maxEvents?: number; oldestAt?: number | null; byType: Record<string, number>; topTypes?: Array<{ type: string; count: number; latestAt?: number; latestMessage?: string }>; latestAt: number | null; latestType: string | null; latestMessage: string | null };
    events?: Array<{ id: string; type: string; message: string; createdAt: number }>;
  };
  active: Array<{
    sessionId: string;
    objective: string;
    status: string;
    phase: string;
    mode?: string;
    iteration: number;
    consecutiveFailures: number;
    nextRetryAt?: number;
    diagnostics?: GoalRunnerDiagnostics;
    runtime?: { liveRunning: boolean; completionNotificationSuppressed: boolean };
    subtasks?: Array<{ id: string; text: string; status: string }>;
    events?: Array<{ id: string; type: string; message: string; createdAt: number }>;
  }>;
  total: number;
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

const GOAL_EVENT_FILTERS = ["all", "restore", "settled", "run", "retry", "error", "subtask"] as const;
type GoalEventFilter = typeof GOAL_EVENT_FILTERS[number];

function goalStatusUrl(sessionId: string, eventFilter: GoalEventFilter): string {
  const params = new URLSearchParams({ sessionId });
  if (eventFilter !== "all") params.set("eventTypes", eventFilter);
  return `/api/goals/status?${params.toString()}`;
}

function StatusIcon({ status }: { status: SubagentSessionStatus }) {
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
  const [goalStatus, setGoalStatus] = useState<GoalRunnerStatusData | null>(null);
  const [goalEventFilter, setGoalEventFilter] = useState<GoalEventFilter>("all");
  const [actionFeedback, setActionFeedback] = useState<string | null>(null);
  const [goalSubtaskText, setGoalSubtaskText] = useState("");
  const [expandedMemoryCategory, setExpandedMemoryCategory] = useState<string | null>("PROJECT_RULES");
  const hasSystemAgents = Boolean(magicStatus?.available || goalStatus?.available);

  useEffect(() => {
    fetch("/api/magic-context/status")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.available) setMagicStatus(data);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetch(goalStatusUrl(rootSession.id, goalEventFilter))
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          if (!cancelled && data?.available) setGoalStatus(data);
        })
        .catch(() => {});
    };
    load();
    const interval = setInterval(load, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [rootSession.id, goalEventFilter]);

  const reloadGoalStatus = useCallback(() => {
    fetch(goalStatusUrl(rootSession.id, goalEventFilter))
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.available) setGoalStatus(data);
      })
      .catch(() => {});
  }, [rootSession.id, goalEventFilter]);

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

  const triggerGoalAction = useCallback(async (
    action: "resume" | "run-now" | "pause" | "stop" | "complete" | "mode" | "add" | "subtask" | "unlock-stale-lock" | "restore-backup",
    mode?: "finish" | "forever" | "done" | "blocked" | "pending" | "active",
    text?: string,
    subtaskId?: string,
  ) => {
    setActionFeedback("Goal action dispatched");
    try {
      const res = await fetch("/api/goals/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, mode, text, subtaskId, sessionId: rootSession.id }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const result = await res.json().catch(() => ({}));
      if (action === "add") setGoalSubtaskText("");
      if ((action === "resume" || action === "run-now") && result?.skippedBecauseRunning) {
        setActionFeedback("Goal is already running");
      } else if ((action === "resume" || action === "run-now") && result?.dispatched) {
        setActionFeedback("Goal continuation dispatched");
      }
      reloadGoalStatus();
      setTimeout(() => setActionFeedback(null), 1800);
    } catch {
      setActionFeedback("Failed to trigger goal action");
    }
  }, [reloadGoalStatus, rootSession.id]);

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
            {/* Goal Runner card */}
            <div style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, padding: 10 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ fontSize: 13 }}>🎯</span>
                  <span style={{ fontSize: 12, fontWeight: 600 }}>Goal Runner</span>
                </div>
                <span style={{ fontSize: 11, color: goalStatus?.current?.status === "running" ? "var(--accent)" : "var(--text-dim)" }}>
                  {goalStatus?.current
                    ? goalStatus.current.status === "running" || goalStatus.current.status === "draft"
                      ? `${goalStatus.current.status}/${goalStatus.current.phase}`
                      : goalStatus.current.status
                    : "idle"}
                </span>
              </div>
              <div style={{ fontSize: 11, color: "var(--text-dim)", display: "flex", flexDirection: "column", gap: 4 }}>
                {goalStatus?.current ? (
                  <>
                    <div style={{ color: "var(--text)", fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={goalStatus.current.objective}>
                      {goalStatus.current.objective}
                    </div>
                    <div>
                      mode: <code style={{ color: "var(--accent)" }}>{goalStatus.current.mode}</code>
                      {" · "}iter: {goalStatus.current.iteration}
                      {" · "}failures: {goalStatus.current.consecutiveFailures}
                    </div>
                    {goalStatus.config && (
                      <div>
                        v{goalStatus.config.version} · max backoff {formatRelativeTime(Date.now() + goalStatus.config.maxRetryMs, locale)}
                        {goalStatus.config.storePath ? ` · store ${goalStatus.config.storePath.split("/").slice(-2).join("/")}` : ""}
                        {goalStatus.config.lockTimeoutMs ? ` · lock ${Math.round(goalStatus.config.lockTimeoutMs / 1000)}s/${Math.round((goalStatus.config.lockStaleMs || 0) / 1000)}s` : ""}
                        {goalStatus.config.watchdogIntervalMs ? ` · watchdog ${Math.round(goalStatus.config.watchdogIntervalMs / 1000)}s` : ""}
                        {goalStatus.config.maxEvents ? ` · events ${goalStatus.config.maxEvents}` : ""}
                        {goalStatus.config.backupPath ? <><br />backup: <code>{goalStatus.config.backupPath}</code></> : null}
                      </div>
                    )}
                    {goalStatus.lock && (
                      <div title={goalStatus.lock.path} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span>lock: <code style={{ color: goalStatus.lock.stale ? "#dc2626" : goalStatus.lock.exists ? "#d97706" : "#16a34a" }}>{goalStatus.lock.stale ? "stale" : goalStatus.lock.exists ? "held" : "free"}</code>
                        {goalStatus.lock.exists && goalStatus.lock.ageMs != null ? ` · age ${formatRelativeTime(Date.now() - goalStatus.lock.ageMs, locale)}` : ""}</span>
                        {goalStatus.lock.stale && (
                          <button type="button" onClick={() => triggerGoalAction("unlock-stale-lock")} style={{ fontSize: 10, padding: "1px 5px", borderRadius: 4, border: "1px solid var(--border)", background: "var(--bg-hover)", color: "#dc2626", cursor: "pointer" }}>Clear stale</button>
                        )}
                      </div>
                    )}
                    {goalStatus.watchdog && (
                      <div title={goalStatus.watchdog.lastError || undefined}>
                        watchdog: <code style={{ color: goalStatus.watchdog.nextScanOverdueMs ? "#d97706" : goalStatus.watchdog.enabled ? "#16a34a" : "var(--text-dim)" }}>{goalStatus.watchdog.enabled ? goalStatus.watchdog.active ? "scanning" : goalStatus.watchdog.nextScanOverdueMs ? "overdue" : "idle" : "not started"}</code>
                        {` · every ${Math.round(goalStatus.watchdog.intervalMs / 1000)}s`}
                        {goalStatus.watchdog.lastScanAt ? ` · scan ${formatRelativeTime(goalStatus.watchdog.lastScanAt, locale)}${goalStatus.watchdog.lastScanDurationMs != null ? ` (${Math.round(goalStatus.watchdog.lastScanDurationMs)}ms)` : ""}` : goalStatus.watchdog.startedAt ? ` · pending first scan since ${formatRelativeTime(goalStatus.watchdog.startedAt, locale)}` : " · pending first scan"}
                        {goalStatus.watchdog.nextScanAt ? ` · next ${formatRelativeTime(goalStatus.watchdog.nextScanAt, locale)}` : ""}
                        {goalStatus.watchdog.nextScanOverdueMs ? ` · scan overdue ${formatRelativeTime(Date.now() - goalStatus.watchdog.nextScanOverdueMs, locale)}` : ""}
                        {` · due ${goalStatus.watchdog.lastCandidateCount}/restored ${goalStatus.watchdog.lastRestoredCount}`}
                        {goalStatus.watchdog.lastSkippedRunningCount ? ` · running ${goalStatus.watchdog.lastSkippedRunningCount}` : ""}
                        {goalStatus.watchdog.lastError ? <span style={{ color: "#dc2626" }}> · error</span> : null}
                      </div>
                    )}
                    {goalStatus.backup && (
                      <div title={goalStatus.backup.path} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span>backup: <code style={{ color: goalStatus.backup.readable ? "#16a34a" : goalStatus.backup.exists ? "#dc2626" : "var(--text-dim)" }}>{goalStatus.backup.readable ? "readable" : goalStatus.backup.exists ? "unreadable" : "missing"}</code>
                        {goalStatus.backup.ageMs != null ? ` · age ${formatRelativeTime(Date.now() - goalStatus.backup.ageMs, locale)}` : ""}
                        {typeof goalStatus.backup.sessionCount === "number" ? ` · sessions ${goalStatus.backup.sessionCount}` : ""}
                        {goalStatus.backup.containsCurrentSession === true ? ` · current ${goalStatus.backup.currentSessionStatus || "present"}` : goalStatus.backup.containsCurrentSession === false ? " · current missing" : ""}</span>
                        {goalStatus.backup.restorable && (
                          <button type="button" onClick={() => triggerGoalAction("restore-backup")} style={{ fontSize: 10, padding: "1px 5px", borderRadius: 4, border: "1px solid var(--border)", background: "var(--bg-hover)", color: "#dc2626", cursor: "pointer" }}>Restore</button>
                        )}
                      </div>
                    )}
                    {goalStatus.current.runtime?.liveRunning || goalStatus.current.runtime?.completionNotificationSuppressed ? (
                      <div>
                        runtime: <code style={{ color: goalStatus.current.runtime.liveRunning ? "#16a34a" : "var(--text-dim)" }}>{goalStatus.current.runtime.liveRunning ? "running" : "idle"}</code>
                        {goalStatus.current.runtime.completionNotificationSuppressed ? " · completion suppressed" : ""}
                      </div>
                    ) : null}
                    {goalStatus.current.diagnostics && (
                      <div title={goalStatus.current.diagnostics.healthReason}>
                        health: <code style={{
                          color: goalStatus.current.diagnostics.health === "healthy" || goalStatus.current.diagnostics.health === "running" ? "#16a34a"
                            : goalStatus.current.diagnostics.health === "retrying" || goalStatus.current.diagnostics.health === "failed" ? "#dc2626"
                              : goalStatus.current.diagnostics.health === "overdue" || goalStatus.current.diagnostics.health === "stale" ? "#d97706"
                                : "var(--text-dim)",
                        }}>{goalStatus.current.diagnostics.health}</code>
                        {" · "}updated: {formatRelativeTime(Date.now() - goalStatus.current.diagnostics.updatedAgeMs, locale)}
                      </div>
                    )}
                    {goalStatus.current.subtasks?.length > 0 && (
                      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                        <div>subgoals: {goalStatus.current.subtasks.filter((task) => task.status !== "done").length}/{goalStatus.current.subtasks.length} open</div>
                        {goalStatus.current.subtasks.slice(0, 4).map((task) => (
                          <div key={task.id} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={task.text}>
                              [{task.status}] {task.text}
                            </span>
                            {task.status !== "done" ? (
                              <button type="button" onClick={() => triggerGoalAction("subtask", "done", undefined, task.id)} style={{ fontSize: 10, padding: "1px 5px", borderRadius: 4, border: "1px solid var(--border)", background: "var(--bg-hover)", color: "#16a34a", cursor: "pointer" }}>Done</button>
                            ) : (
                              <button type="button" onClick={() => triggerGoalAction("subtask", "pending", undefined, task.id)} style={{ fontSize: 10, padding: "1px 5px", borderRadius: 4, border: "1px solid var(--border)", background: "var(--bg-hover)", color: "var(--text)", cursor: "pointer" }}>Reopen</button>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                    {goalStatus.current.diagnostics?.retryDelayMs != null ? (
                      <div>next retry: {formatRelativeTime(Date.now() + goalStatus.current.diagnostics.retryDelayMs, locale)}</div>
                    ) : goalStatus.current.diagnostics?.retryOverdueMs != null ? (
                      <div style={{ color: "#d97706" }}>retry overdue: {formatRelativeTime(Date.now() - goalStatus.current.diagnostics.retryOverdueMs, locale)}</div>
                    ) : goalStatus.current.nextRetryAt && goalStatus.current.nextRetryAt > Date.now() ? (
                      <div>next retry: {formatRelativeTime(goalStatus.current.nextRetryAt, locale)}</div>
                    ) : null}
                    {goalStatus.current.lastError && (
                      <div style={{ color: "#dc2626", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={goalStatus.current.lastError}>
                        {goalStatus.current.lastError}
                      </div>
                    )}
                    {goalStatus.current.eventSummary ? (
                      <div style={{ color: "var(--text-dim)", borderTop: "1px solid var(--border)", paddingTop: 5 }}>
                        events: {goalStatus.current.eventSummary.total}{goalStatus.current.eventSummary.maxEvents ? `/${goalStatus.current.eventSummary.maxEvents}` : ""}{goalStatus.current.eventSummary.rawTotal && goalStatus.current.eventSummary.rawTotal !== goalStatus.current.eventSummary.total ? ` raw ${goalStatus.current.eventSummary.rawTotal}` : ""}{goalStatus.current.eventSummary.compacted ? " · compacted" : ""}{goalStatus.current.eventSummary.returnedTotal != null && goalStatus.current.eventSummary.returnedTotal !== goalStatus.current.eventSummary.total ? ` · shown ${goalStatus.current.eventSummary.returnedTotal}` : ""}{goalStatus.current.eventSummary.filtered ? ` · filter ${goalStatus.current.eventSummary.filterTypes?.join(",") || "active"}` : ""}{goalStatus.current.eventSummary.oldestAt ? ` since ${formatRelativeTime(goalStatus.current.eventSummary.oldestAt, locale)}` : ""}
                        {(goalStatus.current.eventSummary.topTypes || Object.entries(goalStatus.current.eventSummary.byType).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([type, count]) => ({ type, count, latestAt: undefined as number | undefined, latestMessage: undefined as string | undefined }))).map(({ type, count, latestAt }) => ` · ${type} ${count}${latestAt ? ` (${formatRelativeTime(latestAt, locale)})` : ""}`).join("")}
                      </div>
                    ) : null}
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                      {GOAL_EVENT_FILTERS.map((filter) => {
                        const totalCount = goalStatus.current?.eventSummary?.total || 0;
                        const returnedCount = goalStatus.current?.eventSummary?.returnedTotal ?? goalStatus.current?.events?.length;
                        const count = filter === "all" ? totalCount : goalStatus.current?.eventSummary?.byType?.[filter] || 0;
                        const label = filter === "all" && returnedCount != null && returnedCount !== totalCount ? `${filter} ${totalCount}/${returnedCount}` : `${filter} ${count}`;
                        const isEmpty = count === 0;
                        return (
                          <button
                            key={filter}
                            type="button"
                            onClick={() => setGoalEventFilter(filter)}
                            title={isEmpty ? `Show no ${filter} events in the current window` : filter === "all" ? "Show all recent Goal events" : `Filter recent Goal events to ${filter}`}
                            style={{
                              fontSize: 10,
                              padding: "2px 6px",
                              borderRadius: 999,
                              border: "1px solid var(--border)",
                              background: goalEventFilter === filter ? "var(--accent-muted)" : "var(--bg)",
                              color: goalEventFilter === filter ? "var(--accent)" : isEmpty ? "var(--text-faint)" : "var(--text-dim)",
                              cursor: "pointer",
                              opacity: isEmpty && goalEventFilter !== filter ? 0.65 : 1,
                            }}
                          >
                            {label}
                          </button>
                        );
                      })}
                    </div>
                    {goalStatus.current.events?.length ? (
                      <div style={{ display: "flex", flexDirection: "column", gap: 3, borderTop: "1px solid var(--border)", paddingTop: 5 }}>
                        <div style={{ color: "var(--text-muted)", fontWeight: 500 }}>recent events</div>
                        {goalStatus.current.events.slice(0, 4).map((event) => (
                          <div key={event.id} title={event.message} style={{ display: "flex", gap: 5, minWidth: 0 }}>
                            <code style={{ color: "var(--accent)", fontSize: 10 }}>{event.type}</code>
                            <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{event.message}</span>
                            <span style={{ color: "var(--text-dim)", whiteSpace: "nowrap" }}>{formatRelativeTime(event.createdAt, locale)}</span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div style={{ color: "var(--text-dim)", borderTop: "1px solid var(--border)", paddingTop: 5 }}>
                        recent events: {goalStatus.current.eventSummary?.filtered ? `no events for filter ${goalStatus.current.eventSummary.filterTypes?.join(",") || goalEventFilter}` : "none yet"} · use <code>/g-events</code>
                      </div>
                    )}
                    <form
                      onSubmit={(event) => {
                        event.preventDefault();
                        if (goalSubtaskText.trim()) triggerGoalAction("add", undefined, goalSubtaskText);
                      }}
                      style={{ display: "flex", gap: 6, marginTop: 4 }}
                    >
                      <input
                        type="text"
                        value={goalSubtaskText}
                        onChange={(event) => setGoalSubtaskText(event.target.value)}
                        placeholder="Add subgoal"
                        aria-label="Add Goal Runner subgoal"
                        style={{
                          minWidth: 0,
                          flex: 1,
                          height: 26,
                          border: "1px solid var(--border)",
                          borderRadius: 4,
                          padding: "0 7px",
                          background: "var(--bg-panel)",
                          color: "var(--text)",
                          fontSize: 11,
                        }}
                      />
                      <button
                        type="submit"
                        disabled={!goalSubtaskText.trim()}
                        style={{
                          fontSize: 11,
                          padding: "3px 8px",
                          borderRadius: 4,
                          border: "1px solid var(--border)",
                          background: goalSubtaskText.trim() ? "var(--bg-hover)" : "var(--bg)",
                          color: goalSubtaskText.trim() ? "var(--text)" : "var(--text-dim)",
                          cursor: goalSubtaskText.trim() ? "pointer" : "not-allowed",
                        }}
                      >
                        Add
                      </button>
                    </form>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 4 }}>
                      {goalStatus.current.status === "running" ? (
                        <button type="button" onClick={() => triggerGoalAction("pause")} style={{ fontSize: 11, padding: "3px 8px", borderRadius: 4, border: "1px solid var(--border)", background: "var(--bg-hover)", color: "var(--text)", cursor: "pointer" }}>Pause</button>
                      ) : (
                        <button type="button" onClick={() => triggerGoalAction("resume")} style={{ fontSize: 11, padding: "3px 8px", borderRadius: 4, border: "1px solid var(--border)", background: "var(--bg-hover)", color: "var(--text)", cursor: "pointer" }}>Resume</button>
                      )}
                      <button type="button" onClick={() => triggerGoalAction("run-now")} disabled={Boolean(goalStatus.current.runtime?.liveRunning)} title={goalStatus.current.runtime?.liveRunning ? "Already running" : "Run this Goal immediately"} style={{ fontSize: 11, padding: "3px 8px", borderRadius: 4, border: "1px solid var(--border)", background: goalStatus.current.runtime?.liveRunning ? "var(--bg)" : "var(--bg-hover)", color: goalStatus.current.runtime?.liveRunning ? "var(--text-dim)" : "var(--text)", cursor: goalStatus.current.runtime?.liveRunning ? "not-allowed" : "pointer" }}>Run now</button>
                      <button type="button" onClick={() => triggerGoalAction("stop")} style={{ fontSize: 11, padding: "3px 8px", borderRadius: 4, border: "1px solid var(--border)", background: "var(--bg-hover)", color: "#dc2626", cursor: "pointer" }}>Stop</button>
                      <button type="button" onClick={() => triggerGoalAction("complete")} style={{ fontSize: 11, padding: "3px 8px", borderRadius: 4, border: "1px solid var(--border)", background: "var(--bg-hover)", color: "#16a34a", cursor: "pointer" }}>Done</button>
                      <button type="button" onClick={() => triggerGoalAction("mode", goalStatus.current?.mode === "forever" ? "finish" : "forever")} style={{ fontSize: 11, padding: "3px 8px", borderRadius: 4, border: "1px solid var(--border)", background: "var(--bg-hover)", color: "var(--text)", cursor: "pointer" }}>
                        {goalStatus.current.mode === "forever" ? "Finish mode" : "Forever mode"}
                      </button>
                    </div>
                  </>
                ) : (
                  <div>No goal in this session. Use <code>/g &lt;objective&gt;</code> to start.</div>
                )}
                {goalStatus?.active?.length ? (
                  <div style={{ borderTop: "1px solid var(--border)", paddingTop: 5, display: "flex", flexDirection: "column", gap: 4 }}>
                    <div>active goals: {goalStatus.active.length} / total {goalStatus.total}</div>
                    {goalStatus.active
                      .filter((goal) => goal.sessionId !== goalStatus.current?.sessionId)
                      .slice(0, 5)
                      .map((goal) => (
                        <div key={goal.sessionId} title={goal.objective} style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                          <code style={{ color: goal.diagnostics?.health === "healthy" ? "#16a34a" : goal.diagnostics?.health === "retrying" || goal.diagnostics?.health === "failed" ? "#dc2626" : goal.diagnostics?.health === "overdue" || goal.diagnostics?.health === "stale" ? "#d97706" : "var(--accent)", fontSize: 10 }}>
                            {goal.diagnostics?.health || goal.status}
                          </code>
                          <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{goal.objective}</span>
                          <span style={{ color: "var(--text-dim)", whiteSpace: "nowrap" }}>#{goal.iteration}</span>
                        </div>
                      ))}
                  </div>
                ) : null}
              </div>
            </div>

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
