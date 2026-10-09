"use client";

import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { SessionInfo } from "@/lib/types";

function formatRelativeTime(value: string | number, locale: string): string {
  try {
    const date = typeof value === "number" ? new Date(value) : new Date(value);
    const diffSec = Math.round((Date.now() - date.getTime()) / 1000);
    if (diffSec < 60) return locale.startsWith("zh") ? "刚刚" : "just now";
    const diffMin = Math.round(diffSec / 60);
    if (diffMin < 60) return locale.startsWith("zh") ? `${diffMin}分钟前` : `${diffMin}m ago`;
    const diffHour = Math.round(diffMin / 60);
    if (diffHour < 24) return locale.startsWith("zh") ? `${diffHour}小时前` : `${diffHour}h ago`;
    const diffDay = Math.round(diffHour / 24);
    return locale.startsWith("zh") ? `${diffDay}天前` : `${diffDay}d ago`;
  } catch {
    return String(value);
  }
}

interface Props {
  rootSession: SessionInfo;
  active?: boolean;
  onGoalStatusChange?: (status: GoalRunnerStatusData | null) => void;
}

interface GoalRunnerStatusData {
  available: boolean;
  storePath: string;
  config?: {
    version: string;
    storePath: string;
    lockTimeoutMs: number;
    lockStaleMs?: number;
    maxRetryMs: number;
    watchdogIntervalMs?: number;
    maxEvents?: number;
    backupPath?: string;
  };
  current?: {
    sessionId: string;
    objective: string;
    status: string;
    phase: string;
    mode: "finish" | "forever";
    iteration: number;
    consecutiveFailures: number;
    nextRetryAt?: number | null;
    runtime?: {
      liveRunning?: boolean;
      completionNotificationSuppressed?: boolean;
    };
    diagnostics?: {
      health: string;
      healthReason: string;
      updatedAgeMs: number;
      retryDelayMs?: number | null;
      retryOverdueMs?: number | null;
    };
    subtasks: Array<{
      id: string;
      text: string;
      status: "pending" | "done" | "active" | "blocked";
    }>;
    events: Array<{
      id: string;
      type: string;
      message: string;
      createdAt: number;
    }>;
    eventSummary?: {
      total: number;
      rawTotal?: number;
      returnedTotal?: number;
      compacted?: boolean;
      filtered?: boolean;
      filterTypes?: string[];
      maxEvents?: number;
      oldestAt?: number;
      byType?: Record<string, number>;
      topTypes?: Array<{
        type: string;
        count: number;
        latestAt?: number;
        latestMessage?: string;
      }>;
    };
  } | null;
  active: Array<{
    sessionId: string;
    objective: string;
    status: string;
    phase: string;
    iteration: number;
    diagnostics?: {
      health: string;
      healthReason: string;
    };
  }>;
  total: number;
  lock?: {
    exists: boolean;
    stale: boolean;
    ageMs?: number;
    path: string;
  };
  watchdog?: {
    enabled: boolean;
    active: boolean;
    intervalMs: number;
    startedAt?: number;
    lastScanAt?: number;
    nextScanAt?: number;
    nextScanOverdueMs?: number;
    lastScanDurationMs?: number | null;
    lastCandidateCount: number;
    lastRestoredCount: number;
    lastSkippedRunningCount?: number;
    lastError?: string | null;
  };
  backup?: {
    exists: boolean;
    readable: boolean;
    ageMs?: number;
    path: string;
    sessionCount?: number;
    containsCurrentSession?: boolean | null;
    currentSessionStatus?: string | null;
    restorable?: boolean;
  };
}

type GoalEventFilter = "all" | "restore" | "settled" | "run" | "retry" | "error" | "subtask";

function goalStatusUrl(sessionId: string, filter: GoalEventFilter): string {
  const base = `/api/goals/status?sessionId=${encodeURIComponent(sessionId)}`;
  return filter === "all" ? base : `${base}&eventTypes=${encodeURIComponent(filter)}`;
}

export function GoalRunnerPanel({ rootSession, active = false, onGoalStatusChange }: Props) {
  const { t, locale } = useI18n();
  const [goalStatus, setGoalStatus] = useState<GoalRunnerStatusData | null>(null);
  const [goalEventFilter, setGoalEventFilter] = useState<GoalEventFilter>("all");
  const [actionFeedback, setActionFeedback] = useState<string | null>(null);
  const [goalSubtaskText, setGoalSubtaskText] = useState("");

  const reloadGoalStatus = useCallback(() => {
    fetch(goalStatusUrl(rootSession.id, goalEventFilter))
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.available) {
          setGoalStatus(data);
          onGoalStatusChange?.(data);
        }
      })
      .catch(() => {});
  }, [rootSession.id, goalEventFilter, onGoalStatusChange]);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetch(goalStatusUrl(rootSession.id, goalEventFilter))
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          if (!cancelled && data?.available) {
            setGoalStatus(data);
            onGoalStatusChange?.(data);
          }
        })
        .catch(() => {});
    };
    load();
    const interval = setInterval(load, active ? 3000 : 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [rootSession.id, goalEventFilter, active, onGoalStatusChange]);

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

  const isRunning = goalStatus?.current?.status === "running";
  const isComplete = goalStatus?.current?.status === "complete";
  const isStopped = goalStatus?.current?.status === "stopped";
  const isPaused = goalStatus?.current?.status === "paused";

  return (
    <div
      role="region"
      aria-label="Goal Runner"
      style={{
        background: "var(--bg-panel)",
        borderLeft: "1px solid var(--border)",
        borderRight: "1px solid var(--border)",
        borderBottom: "1px solid var(--border)",
        borderRadius: "0 0 6px 6px",
        boxShadow: "0 10px 28px rgba(0,0,0,0.12)",
        overflow: "hidden",
      }}
    >
      {/* Header bar */}
      <div
        style={{
          padding: "10px 14px",
          borderBottom: "1px solid var(--border)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          background: "var(--bg)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 16 }}>🎯</span>
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, display: "flex", alignItems: "center", gap: 6 }}>
              <span>Goal Runner</span>
              {isRunning && (
                <span
                  style={{
                    display: "inline-block",
                    width: 7,
                    height: 7,
                    borderRadius: "50%",
                    background: "#16a34a",
                    boxShadow: "0 0 0 2px rgba(22,163,74,0.25)",
                  }}
                  title="Running"
                />
              )}
            </div>
            {goalStatus?.config?.version && (
              <div style={{ fontSize: 10, color: "var(--text-dim)" }}>
                v{goalStatus.config.version}
                {goalStatus.config.storePath ? ` · ${goalStatus.config.storePath.split("/").slice(-2).join("/")}` : ""}
              </div>
            )}
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {actionFeedback && (
            <span style={{ fontSize: 11, color: "var(--accent)" }}>{actionFeedback}</span>
          )}
          <span
            style={{
              fontSize: 11,
              fontWeight: 500,
              padding: "2px 8px",
              borderRadius: 4,
              background: isRunning ? "rgba(22,163,74,0.12)" : "var(--bg-hover)",
              color: isRunning ? "#16a34a" : isComplete ? "var(--text-muted)" : "var(--text-dim)",
            }}
          >
            {goalStatus?.current
              ? isRunning || goalStatus.current.status === "draft"
                ? `${goalStatus.current.status}/${goalStatus.current.phase}`
                : goalStatus.current.status
              : "idle"}
          </span>
        </div>
      </div>

      <div style={{ maxHeight: "min(72dvh, 580px)", overflowY: "auto", padding: "12px 14px", display: "flex", flexDirection: "column", gap: 12 }}>
        {goalStatus?.current ? (
          <>
            {/* Main Objective Card */}
            <div style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, padding: 12 }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <div style={{ color: "var(--text)", fontWeight: 600, fontSize: 13, lineHeight: 1.4 }} title={goalStatus.current.objective}>
                  {goalStatus.current.objective}
                </div>
                <div style={{ fontSize: 11, color: "var(--text-dim)", display: "flex", flexWrap: "wrap", gap: 8 }}>
                  <span>
                    mode: <code style={{ color: "var(--accent)", fontWeight: 600 }}>{goalStatus.current.mode}</code>
                  </span>
                  <span>·</span>
                  <span>iter: {goalStatus.current.iteration}</span>
                  <span>·</span>
                  <span>failures: {goalStatus.current.consecutiveFailures}</span>
                  {goalStatus.config?.maxRetryMs ? (
                    <>
                      <span>·</span>
                      <span>max backoff: {Math.round(goalStatus.config.maxRetryMs / 60000)}m</span>
                    </>
                  ) : null}
                </div>

                {/* Subgoals */}
                <div style={{ borderTop: "1px solid var(--border)", paddingTop: 8, marginTop: 4, display: "flex", flexDirection: "column", gap: 6 }}>
                  <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", display: "flex", justifyContent: "space-between" }}>
                    <span>Subgoals</span>
                    {goalStatus.current.subtasks?.length > 0 && (
                      <span style={{ fontWeight: 400, color: "var(--text-dim)" }}>
                        {goalStatus.current.subtasks.filter((task) => task.status !== "done").length}/{goalStatus.current.subtasks.length} open
                      </span>
                    )}
                  </div>
                  {goalStatus.current.subtasks?.length > 0 && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 150, overflowY: "auto" }}>
                      {goalStatus.current.subtasks.map((task) => (
                        <div key={task.id} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11 }}>
                          <span
                            style={{
                              flex: 1,
                              minWidth: 0,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                              textDecoration: task.status === "done" ? "line-through" : "none",
                              color: task.status === "done" ? "var(--text-dim)" : "var(--text)",
                            }}
                            title={task.text}
                          >
                            [{task.status}] {task.text}
                          </span>
                          {task.status !== "done" ? (
                            <button
                              type="button"
                              onClick={() => triggerGoalAction("subtask", "done", undefined, task.id)}
                              style={{ fontSize: 10, padding: "1px 6px", borderRadius: 4, border: "1px solid var(--border)", background: "var(--bg-hover)", color: "#16a34a", cursor: "pointer" }}
                            >
                              Done
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={() => triggerGoalAction("subtask", "pending", undefined, task.id)}
                              style={{ fontSize: 10, padding: "1px 6px", borderRadius: 4, border: "1px solid var(--border)", background: "var(--bg-hover)", color: "var(--text-dim)", cursor: "pointer" }}
                            >
                              Reopen
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (goalSubtaskText.trim()) triggerGoalAction("add", undefined, goalSubtaskText);
                    }}
                    style={{ display: "flex", gap: 6, marginTop: 2 }}
                  >
                    <input
                      type="text"
                      value={goalSubtaskText}
                      onChange={(event) => setGoalSubtaskText(event.target.value)}
                      placeholder="Add subgoal..."
                      aria-label="Add subgoal"
                      style={{
                        minWidth: 0,
                        flex: 1,
                        height: 26,
                        border: "1px solid var(--border)",
                        borderRadius: 4,
                        padding: "0 8px",
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
                        padding: "2px 10px",
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
                </div>

                {/* Controls */}
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", borderTop: "1px solid var(--border)", paddingTop: 8, marginTop: 4 }}>
                  {isRunning ? (
                    <button type="button" onClick={() => triggerGoalAction("pause")} style={{ fontSize: 11, padding: "4px 10px", borderRadius: 4, border: "1px solid var(--border)", background: "var(--bg-hover)", color: "var(--text)", cursor: "pointer" }}>
                      Pause
                    </button>
                  ) : (
                    <button type="button" onClick={() => triggerGoalAction("resume")} style={{ fontSize: 11, padding: "4px 10px", borderRadius: 4, border: "1px solid var(--border)", background: "var(--bg-hover)", color: "var(--text)", cursor: "pointer" }}>
                      Resume
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => triggerGoalAction("run-now")}
                    disabled={Boolean(goalStatus.current.runtime?.liveRunning)}
                    title={goalStatus.current.runtime?.liveRunning ? "Already running" : "Run this Goal immediately"}
                    style={{
                      fontSize: 11,
                      padding: "4px 10px",
                      borderRadius: 4,
                      border: "1px solid var(--border)",
                      background: goalStatus.current.runtime?.liveRunning ? "var(--bg)" : "var(--bg-hover)",
                      color: goalStatus.current.runtime?.liveRunning ? "var(--text-dim)" : "var(--text)",
                      cursor: goalStatus.current.runtime?.liveRunning ? "not-allowed" : "pointer",
                    }}
                  >
                    Run now
                  </button>
                  <button
                    type="button"
                    onClick={() => triggerGoalAction("stop")}
                    disabled={isStopped || isComplete}
                    style={{
                      fontSize: 11,
                      padding: "4px 10px",
                      borderRadius: 4,
                      border: "1px solid var(--border)",
                      background: "var(--bg-hover)",
                      color: isStopped || isComplete ? "var(--text-dim)" : "#dc2626",
                      opacity: isStopped || isComplete ? 0.5 : 1,
                      cursor: isStopped || isComplete ? "not-allowed" : "pointer",
                    }}
                  >
                    Stop
                  </button>
                  <button
                    type="button"
                    onClick={() => triggerGoalAction("complete")}
                    disabled={isComplete}
                    style={{
                      fontSize: 11,
                      padding: "4px 10px",
                      borderRadius: 4,
                      border: "1px solid var(--border)",
                      background: "var(--bg-hover)",
                      color: isComplete ? "var(--text-dim)" : "#16a34a",
                      opacity: isComplete ? 0.5 : 1,
                      cursor: isComplete ? "not-allowed" : "pointer",
                    }}
                  >
                    Done
                  </button>
                  <button
                    type="button"
                    onClick={() => triggerGoalAction("mode", goalStatus.current?.mode === "forever" ? "finish" : "forever")}
                    style={{ fontSize: 11, padding: "4px 10px", borderRadius: 4, border: "1px solid var(--border)", background: "var(--bg-hover)", color: "var(--text)", cursor: "pointer" }}
                  >
                    {goalStatus.current.mode === "forever" ? "Finish mode" : "Forever mode"}
                  </button>
                </div>
              </div>
            </div>

            {/* Events card */}
            <div style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, padding: 12 }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6, flexWrap: "wrap", fontSize: 11 }}>
                  <div>
                    events: {goalStatus.current.eventSummary?.total || 0}/{goalStatus.config?.maxEvents || 40}
                    {goalStatus.current.eventSummary?.rawTotal != null ? ` · raw ${goalStatus.current.eventSummary.rawTotal}` : ""}
                    {goalStatus.current.eventSummary?.compacted ? " · compacted" : ""}
                    {goalStatus.current.eventSummary?.returnedTotal != null && goalStatus.current.eventSummary?.returnedTotal !== goalStatus.current.eventSummary?.total
                      ? ` · shown ${goalStatus.current.eventSummary.returnedTotal}`
                      : ""}
                    {goalStatus.current.eventSummary?.filtered
                      ? ` (${goalStatus.current.eventSummary.filterTypes?.join(",") || goalEventFilter})`
                      : ""}
                    {goalStatus.current.eventSummary?.oldestAt ? ` · oldest ${formatRelativeTime(goalStatus.current.eventSummary.oldestAt, locale)}` : ""}
                  </div>
                  {goalStatus.current.eventSummary?.topTypes?.length ? (
                    <div title="top event types" style={{ color: "var(--text-dim)", fontSize: 10 }}>
                      {goalStatus.current.eventSummary.topTypes
                        .slice(0, 3)
                        .map((entry) => `${entry.type} ${entry.count}${entry.latestAt ? ` (${formatRelativeTime(entry.latestAt, locale)})` : ""}`)
                        .join(" · ")}
                    </div>
                  ) : null}
                </div>

                <div style={{ display: "flex", gap: 4, flexWrap: "wrap", alignItems: "center" }}>
                  {(["all", "restore", "settled", "run", "retry", "error", "subtask"] as GoalEventFilter[]).map((filter) => {
                    const totalCount = goalStatus?.current?.eventSummary?.total || 0;
                    const returnedCount = goalStatus?.current?.eventSummary?.returnedTotal ?? goalStatus?.current?.events?.length;
                    const count = filter === "all" ? totalCount : goalStatus?.current?.eventSummary?.byType?.[filter] || 0;
                    const label = filter === "all" && returnedCount != null && returnedCount !== totalCount ? `${filter} ${totalCount}/${returnedCount}` : `${filter} ${count}`;
                    const isEmpty = count === 0;
                    return (
                      <button
                        key={filter}
                        type="button"
                        onClick={() => setGoalEventFilter(filter)}
                        title={isEmpty ? "Filter has 0 events in current window" : filter === "all" ? "Show all events" : `Filter by ${filter}`}
                        style={{
                          fontSize: 10,
                          padding: "2px 6px",
                          borderRadius: 4,
                          border: "1px solid var(--border)",
                          background: goalEventFilter === filter ? "var(--bg-hover)" : "transparent",
                          color: goalEventFilter === filter ? "var(--accent)" : "var(--text-dim)",
                          opacity: isEmpty && goalEventFilter !== filter ? 0.45 : 1,
                          cursor: "pointer",
                        }}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>

                {goalStatus.current.events?.length ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 160, overflowY: "auto" }}>
                    {goalStatus.current.events.slice(-6).map((event) => (
                      <div key={event.id} title={event.message} style={{ display: "flex", gap: 6, fontSize: 11 }}>
                        <code style={{ color: "var(--accent)", fontSize: 10 }}>{event.type}</code>
                        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {event.message}
                        </span>
                        <span style={{ color: "var(--text-dim)", fontSize: 10, whiteSpace: "nowrap" }}>
                          {formatRelativeTime(event.createdAt, locale)}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div style={{ color: "var(--text-dim)", fontSize: 11, borderTop: "1px solid var(--border)", paddingTop: 5 }}>
                    recent events: {goalStatus.current.eventSummary?.filtered ? `no events for filter ${goalStatus.current.eventSummary.filterTypes?.join(",") || goalEventFilter}` : "none yet"} · use <code>/g-events</code>
                  </div>
                )}
              </div>
            </div>
          </>
        ) : (
          /* Empty State */
          <div style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, padding: 14, display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>暂无目标 (No Active Goal)</div>
            <div style={{ fontSize: 12, color: "var(--text-dim)", lineHeight: 1.5 }}>
              当前会话尚未启动 Goal。在对话输入框中使用 <code>/g &lt;目标描述&gt;</code> 即可开启自治迭代目标。
            </div>
          </div>
        )}

        {/* System Diagnostics & Other Goals Card */}
        <div style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, padding: 10, fontSize: 11, color: "var(--text-dim)", display: "flex", flexDirection: "column", gap: 4 }}>
          <div style={{ fontWeight: 600, color: "var(--text-muted)", marginBottom: 2 }}>运行状态与守护</div>
          {goalStatus?.lock && (
            <div title={goalStatus.lock.path} style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span>lock: <code style={{ color: goalStatus.lock.stale ? "#dc2626" : goalStatus.lock.exists ? "#d97706" : "#16a34a" }}>{goalStatus.lock.stale ? "stale" : goalStatus.lock.exists ? "held" : "free"}</code>
              {goalStatus.lock.exists && goalStatus.lock.ageMs != null ? ` · age ${formatRelativeTime(Date.now() - goalStatus.lock.ageMs, locale)}` : ""}</span>
              {goalStatus.lock.stale && (
                <button type="button" onClick={() => triggerGoalAction("unlock-stale-lock")} style={{ fontSize: 10, padding: "1px 5px", borderRadius: 4, border: "1px solid var(--border)", background: "var(--bg-hover)", color: "#dc2626", cursor: "pointer" }}>Clear stale</button>
              )}
            </div>
          )}
          {goalStatus?.watchdog && (
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
          {goalStatus?.backup && (
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
          {goalStatus?.current?.runtime?.liveRunning || goalStatus?.current?.runtime?.completionNotificationSuppressed ? (
            <div>
              runtime: <code style={{ color: goalStatus.current.runtime.liveRunning ? "#16a34a" : "var(--text-dim)" }}>{goalStatus.current.runtime.liveRunning ? "running" : "idle"}</code>
              {goalStatus.current.runtime.completionNotificationSuppressed ? " · completion suppressed" : ""}
            </div>
          ) : null}
          {goalStatus?.current?.diagnostics && (
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

          {/* Other Active Goals */}
          {goalStatus?.active?.length ? (
            <div style={{ borderTop: "1px solid var(--border)", paddingTop: 5, marginTop: 3, display: "flex", flexDirection: "column", gap: 4 }}>
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
    </div>
  );
}
