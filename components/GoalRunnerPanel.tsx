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
    lockStaleMs: number;
    watchdogIntervalMs: number;
    maxRetryMs: number;
    maxEvents: number;
    defaultMode: string;
    lockPath: string;
    backupPath: string;
  };
  lock?: {
    exists: boolean;
    stale: boolean;
    path: string;
    ageMs: number | null;
  };
  backup?: {
    exists: boolean;
    readable: boolean;
    restorable: boolean;
    path: string;
    ageMs: number | null;
    sessionCount: number | null;
    containsCurrentSession: boolean | null;
    currentSessionStatus: string | null;
  };
  watchdog?: {
    enabled: boolean;
    active: boolean;
    intervalMs: number;
    startedAt: number | null;
    lastScanAt: number | null;
    lastScanDurationMs: number | null;
    nextScanAt: number | null;
    nextScanOverdueMs: number;
    lastCandidateCount: number;
    lastRestoredCount: number;
    lastSkippedRunningCount: number;
    lastRestoreAt: number | null;
    lastError: string | null;
  };
  current?: {
    sessionId: string;
    objective: string;
    status: "running" | "paused" | "stopped" | "complete" | "draft";
    phase: "clarifying" | "executing";
    mode: "finish" | "forever";
    iteration: number;
    consecutiveFailures: number;
    subtasks: Array<{
      id: string;
      text: string;
      status: "pending" | "active" | "done" | "blocked";
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
      compacted?: boolean;
      returnedTotal?: number;
      filtered?: boolean;
      filterTypes?: string[];
      oldestAt?: number | null;
      byType?: Record<string, number>;
      topTypes?: Array<{
        type: string;
        count: number;
        latestAt?: number | null;
        latestMessage?: string | null;
      }>;
    };
    runtime?: {
      liveRunning: boolean;
      completionNotificationSuppressed?: boolean;
    };
    diagnostics?: {
      health: "running" | "healthy" | "retry" | "idle" | "error";
      retryDelayMs: number | null;
      retryOverdueMs: number | null;
    };
  } | null;
  goals?: Array<{
    sessionId: string;
    objective: string;
    status: string;
    phase: string;
    mode: string;
    iteration: number;
    updatedAt: number;
  }>;
}

type GoalEventFilter = "all" | "restore" | "settled" | "run" | "retry" | "error" | "subtask";
type PanelTab = "objective" | "subgoals" | "events" | "diagnostics" | "all-goals";

function goalStatusUrl(sessionId: string, eventFilter: GoalEventFilter): string {
  const base = `/api/goals/status?sessionId=${encodeURIComponent(sessionId)}`;
  if (eventFilter === "all") return base;
  return `${base}&eventTypes=${encodeURIComponent(eventFilter)}`;
}

export function GoalRunnerPanel({ rootSession, active = false, onGoalStatusChange }: Props) {
  const { locale } = useI18n();
  const [goalStatus, setGoalStatus] = useState<GoalRunnerStatusData | null>(null);
  const [activeTab, setActiveTab] = useState<PanelTab>("objective");
  const [goalEventFilter, setGoalEventFilter] = useState<GoalEventFilter>("all");
  const [actionFeedback, setActionFeedback] = useState<string | null>(null);
  const [goalSubtaskText, setGoalSubtaskText] = useState("");
  const [newObjectiveText, setNewObjectiveText] = useState("");

  const reloadGoalStatus = useCallback(async () => {
    try {
      const res = await fetch(goalStatusUrl(rootSession.id, goalEventFilter));
      if (!res.ok) return;
      const data: GoalRunnerStatusData = await res.json();
      setGoalStatus(data);
      onGoalStatusChange?.(data);
    } catch {
      // ignore network errors during polling
    }
  }, [rootSession.id, goalEventFilter, onGoalStatusChange]);

  useEffect(() => {
    if (!active) return;
    reloadGoalStatus();
    const timer = setInterval(reloadGoalStatus, 3000);
    return () => clearInterval(timer);
  }, [active, reloadGoalStatus]);

  const triggerGoalAction = useCallback(async (
    action: "resume" | "run-now" | "pause" | "stop" | "complete" | "mode" | "add" | "subtask" | "unlock-stale-lock" | "restore-backup" | "start",
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
      if (action === "start") setNewObjectiveText("");
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

  const currentGoal = goalStatus?.current;
  const isRunning = currentGoal?.status === "running";
  const isComplete = currentGoal?.status === "complete";
  const isStopped = currentGoal?.status === "stopped";
  const openSubtasksCount = currentGoal?.subtasks?.filter((task) => task.status !== "done").length ?? 0;
  const totalSubtasksCount = currentGoal?.subtasks?.length ?? 0;
  const eventsCount = currentGoal?.eventSummary?.total ?? currentGoal?.events?.length ?? 0;
  const otherGoals = goalStatus?.goals?.filter((g) => g.sessionId !== rootSession.id) ?? [];

  return (
    <div className="goal-definitions-panel" role="region" aria-label="Goal Runner">
      {/* Left Sidebar Navigation */}
      <nav className="goal-definitions-sidebar" aria-label="Goal Runner Sections">
        <div className="goal-sidebar-header">
          <div className="goal-sidebar-brand">
            <span className="goal-sidebar-icon">🎯</span>
            <div>
              <div className="goal-sidebar-title">Goal Runner</div>
              <div className="goal-sidebar-version">
                v{goalStatus?.config?.version || "1.4.0"}
                {goalStatus?.config?.storePath ? ` · ${goalStatus.config.storePath.split("/").slice(-2).join("/")}` : ""}
              </div>
            </div>
          </div>
          {currentGoal && (
            <span
              className={`goal-status-badge ${isRunning ? "running" : isComplete ? "complete" : "idle"}`}
            >
              {isRunning ? `${currentGoal.status}/${currentGoal.phase}` : currentGoal.status}
            </span>
          )}
        </div>

        <div className="goal-nav-list">
          <button
            type="button"
            className={`goal-nav-item ${activeTab === "objective" ? "selected" : ""}`}
            onClick={() => setActiveTab("objective")}
          >
            <span className="goal-nav-icon">🎯</span>
            <div className="goal-nav-text">
              <span className="goal-nav-label">当前目标与控制</span>
              <span className="goal-nav-sub">
                {currentGoal ? `iter: ${currentGoal.iteration} · ${currentGoal.mode}` : "暂无活跃目标"}
              </span>
            </div>
          </button>

          <button
            type="button"
            className={`goal-nav-item ${activeTab === "subgoals" ? "selected" : ""}`}
            onClick={() => setActiveTab("subgoals")}
          >
            <span className="goal-nav-icon">📋</span>
            <div className="goal-nav-text">
              <span className="goal-nav-label">子任务清单</span>
              <span className="goal-nav-sub">
                {totalSubtasksCount > 0 ? `${openSubtasksCount}/${totalSubtasksCount} 待完成` : "无子任务"}
              </span>
            </div>
            {openSubtasksCount > 0 && <span className="goal-nav-badge">{openSubtasksCount}</span>}
          </button>

          <button
            type="button"
            className={`goal-nav-item ${activeTab === "events" ? "selected" : ""}`}
            onClick={() => setActiveTab("events")}
          >
            <span className="goal-nav-icon">📜</span>
            <div className="goal-nav-text">
              <span className="goal-nav-label">事件与日志</span>
              <span className="goal-nav-sub">{eventsCount} 条历史记录</span>
            </div>
            {eventsCount > 0 && <span className="goal-nav-badge secondary">{eventsCount}</span>}
          </button>

          <button
            type="button"
            className={`goal-nav-item ${activeTab === "diagnostics" ? "selected" : ""}`}
            onClick={() => setActiveTab("diagnostics")}
          >
            <span className="goal-nav-icon">🛡️</span>
            <div className="goal-nav-text">
              <span className="goal-nav-label">运行状态与守护</span>
              <span className="goal-nav-sub">
                watchdog: {goalStatus?.watchdog?.enabled ? goalStatus.watchdog.active ? "scanning" : "idle" : "not started"}
              </span>
            </div>
          </button>

          {otherGoals.length > 0 && (
            <button
              type="button"
              className={`goal-nav-item ${activeTab === "all-goals" ? "selected" : ""}`}
              onClick={() => setActiveTab("all-goals")}
            >
              <span className="goal-nav-icon">🌐</span>
              <div className="goal-nav-text">
                <span className="goal-nav-label">其他会话目标</span>
                <span className="goal-nav-sub">{otherGoals.length} 个历史会话</span>
              </div>
              <span className="goal-nav-badge secondary">{otherGoals.length}</span>
            </button>
          )}
        </div>

        {/* Sidebar Footer Stats */}
        <div className="goal-sidebar-footer">
          <div className="goal-footer-row">
            <span>Watchdog</span>
            <span className={goalStatus?.watchdog?.enabled ? "text-green" : "text-dim"}>
              {goalStatus?.watchdog?.enabled ? "active (30s)" : "off"}
            </span>
          </div>
          <div className="goal-footer-row">
            <span>Lock</span>
            <span className={goalStatus?.lock?.stale ? "text-red" : goalStatus?.lock?.exists ? "text-amber" : "text-green"}>
              {goalStatus?.lock?.stale ? "stale" : goalStatus?.lock?.exists ? "held" : "free"}
            </span>
          </div>
          <div className="goal-footer-row">
            <span>Backup</span>
            <span className={goalStatus?.backup?.readable ? "text-green" : "text-dim"}>
              {goalStatus?.backup?.readable ? "readable" : "missing"}
            </span>
          </div>
        </div>
      </nav>

      {/* Right Detail Content Area */}
      <section className="goal-definitions-detail" aria-label="Goal Details">
        {/* Top Header Actions Bar */}
        <div className="goal-detail-header">
          <div className="goal-detail-header-left">
            <span className="goal-detail-section-title">
              {activeTab === "objective" && "🎯 当前目标与控制"}
              {activeTab === "subgoals" && "📋 子任务拆解与进度"}
              {activeTab === "events" && "📜 目标执行日志与事件"}
              {activeTab === "diagnostics" && "🛡️ 系统诊断与守护状态"}
              {activeTab === "all-goals" && "🌐 其它会话目标列表"}
            </span>
            {actionFeedback && <span className="goal-action-feedback">{actionFeedback}</span>}
          </div>

          {currentGoal && (
            <div className="goal-detail-header-actions">
              {isRunning ? (
                <button
                  type="button"
                  className="goal-btn goal-btn-secondary"
                  onClick={() => triggerGoalAction("pause")}
                >
                  ⏸ 暂停 (Pause)
                </button>
              ) : (
                <button
                  type="button"
                  className="goal-btn goal-btn-primary"
                  onClick={() => triggerGoalAction("resume")}
                >
                  ▶ 继续 (Resume)
                </button>
              )}

              <button
                type="button"
                className="goal-btn goal-btn-secondary"
                onClick={() => triggerGoalAction("run-now")}
                disabled={Boolean(currentGoal.runtime?.liveRunning)}
                title={currentGoal.runtime?.liveRunning ? "Already running" : "立即触发一轮执行"}
              >
                ⚡ 立即执行 (Run now)
              </button>

              <button
                type="button"
                className="goal-btn goal-btn-danger"
                onClick={() => triggerGoalAction("stop")}
                disabled={isStopped || isComplete}
              >
                ⏹ 停止 (Stop)
              </button>

              <button
                type="button"
                className="goal-btn goal-btn-success"
                onClick={() => triggerGoalAction("complete")}
                disabled={isComplete}
              >
                ✓ 完成 (Done)
              </button>

              <button
                type="button"
                className="goal-btn goal-btn-secondary"
                onClick={() => triggerGoalAction("mode", currentGoal.mode === "forever" ? "finish" : "forever")}
              >
                🔄 模式: {currentGoal.mode}
              </button>
            </div>
          )}
        </div>

        {/* Scrollable Detail Body */}
        <div className="goal-detail-scroll">
          {activeTab === "objective" && (
            <div className="goal-tab-content">
              {currentGoal ? (
                <>
                  <div className="goal-card goal-primary-card">
                    <div className="goal-card-header">
                      <span className="goal-card-label">目标内容</span>
                      <span className="goal-iter-tag">Iteration #{currentGoal.iteration}</span>
                    </div>
                    <div className="goal-objective-text">{currentGoal.objective}</div>

                    <div className="goal-meta-grid">
                      <div className="goal-meta-item">
                        <span className="goal-meta-key">运行模式 (Mode)</span>
                        <span className="goal-meta-val highlight">{currentGoal.mode}</span>
                      </div>
                      <div className="goal-meta-item">
                        <span className="goal-meta-key">当前状态 (Status)</span>
                        <span className="goal-meta-val">{currentGoal.status}</span>
                      </div>
                      <div className="goal-meta-item">
                        <span className="goal-meta-key">执行阶段 (Phase)</span>
                        <span className="goal-meta-val">{currentGoal.phase}</span>
                      </div>
                      <div className="goal-meta-item">
                        <span className="goal-meta-key">连续重试失败 (Failures)</span>
                        <span className="goal-meta-val">{currentGoal.consecutiveFailures}</span>
                      </div>
                      <div className="goal-meta-item">
                        <span className="goal-meta-key">最大回退间隔 (Max Backoff)</span>
                        <span className="goal-meta-val">
                          {goalStatus?.config?.maxRetryMs ? `${Math.round(goalStatus.config.maxRetryMs / 60000)}m` : "20m"}
                        </span>
                      </div>
                      <div className="goal-meta-item">
                        <span className="goal-meta-key">当前会话运行时 (Runtime)</span>
                        <span className={`goal-meta-val ${currentGoal.runtime?.liveRunning ? "text-green" : "text-dim"}`}>
                          {currentGoal.runtime?.liveRunning ? "live running" : "idle"}
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Subgoals preview in Objective tab */}
                  <div className="goal-card">
                    <div className="goal-card-header">
                      <span className="goal-card-label">子任务概览 (Subgoals)</span>
                      <button
                        type="button"
                        className="goal-link-btn"
                        onClick={() => setActiveTab("subgoals")}
                      >
                        查看全部 ({totalSubtasksCount}) →
                      </button>
                    </div>

                    {currentGoal.subtasks?.length > 0 ? (
                      <div className="goal-subtasks-list compact">
                        {currentGoal.subtasks.map((task) => (
                          <div key={task.id} className={`goal-subtask-row ${task.status}`}>
                            <span className={`goal-subtask-status-pill ${task.status}`}>{task.status}</span>
                            <span className="goal-subtask-title" title={task.text}>{task.text}</span>
                            {task.status !== "done" ? (
                              <button
                                type="button"
                                className="goal-subtask-action-btn done"
                                onClick={() => triggerGoalAction("subtask", "done", undefined, task.id)}
                              >
                                标记完成
                              </button>
                            ) : (
                              <button
                                type="button"
                                className="goal-subtask-action-btn reopen"
                                onClick={() => triggerGoalAction("subtask", "pending", undefined, task.id)}
                              >
                                重开
                              </button>
                            )}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="goal-empty-inline">暂无子任务，可在下方快速添加。</div>
                    )}

                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        if (goalSubtaskText.trim()) triggerGoalAction("add", undefined, goalSubtaskText.trim());
                      }}
                      className="goal-add-subtask-form"
                    >
                      <input
                        type="text"
                        value={goalSubtaskText}
                        onChange={(e) => setGoalSubtaskText(e.target.value)}
                        placeholder="添加子任务 (Add subgoal)..."
                        className="goal-input"
                      />
                      <button
                        type="submit"
                        disabled={!goalSubtaskText.trim()}
                        className="goal-btn goal-btn-primary"
                      >
                        添加
                      </button>
                    </form>
                  </div>
                </>
              ) : (
                <div className="goal-empty-panel">
                  <div className="goal-empty-icon">🎯</div>
                  <div className="goal-empty-title">当前会话暂无活跃目标 (No Active Goal)</div>
                  <div className="goal-empty-desc">
                    你可以直接在下方输入目标发起，或在对话框中使用 <code>/goal &lt;目标描述&gt;</code> 命令。
                  </div>

                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (newObjectiveText.trim()) triggerGoalAction("start", undefined, newObjectiveText.trim());
                    }}
                    style={{ display: "flex", gap: 8, width: "100%", maxWidth: 440, marginTop: 12 }}
                  >
                    <input
                      type="text"
                      value={newObjectiveText}
                      onChange={(e) => setNewObjectiveText(e.target.value)}
                      placeholder="输入长期目标（例如：完善xxx模块、自动化测试...）"
                      aria-label="New Goal Objective"
                      className="goal-input"
                      style={{ height: 34, fontSize: 13 }}
                    />
                    <button
                      type="submit"
                      disabled={!newObjectiveText.trim()}
                      className="goal-btn goal-btn-primary"
                      style={{ padding: "0 16px", height: 34, fontSize: 13 }}
                    >
                      启动目标
                    </button>
                  </form>
                </div>
              )}
            </div>
          )}

          {activeTab === "subgoals" && (
            <div className="goal-tab-content">
              <div className="goal-card">
                <div className="goal-card-header">
                  <span className="goal-card-label">子任务管理</span>
                  <span className="goal-card-count">
                    已完成 {totalSubtasksCount - openSubtasksCount} / 总计 {totalSubtasksCount}
                  </span>
                </div>

                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (goalSubtaskText.trim()) triggerGoalAction("add", undefined, goalSubtaskText.trim());
                  }}
                  className="goal-add-subtask-form"
                  style={{ marginBottom: 14 }}
                >
                  <input
                    type="text"
                    value={goalSubtaskText}
                    onChange={(e) => setGoalSubtaskText(e.target.value)}
                    placeholder="输入新的子目标/任务描述..."
                    className="goal-input"
                  />
                  <button
                    type="submit"
                    disabled={!goalSubtaskText.trim()}
                    className="goal-btn goal-btn-primary"
                  >
                    添加子任务
                  </button>
                </form>

                {currentGoal?.subtasks && currentGoal.subtasks.length > 0 ? (
                  <div className="goal-subtasks-list">
                    {currentGoal.subtasks.map((task) => (
                      <div key={task.id} className={`goal-subtask-row ${task.status}`}>
                        <span className={`goal-subtask-status-pill ${task.status}`}>{task.status}</span>
                        <span className="goal-subtask-title">{task.text}</span>
                        <div className="goal-subtask-actions">
                          {task.status !== "done" ? (
                            <button
                              type="button"
                              className="goal-subtask-action-btn done"
                              onClick={() => triggerGoalAction("subtask", "done", undefined, task.id)}
                            >
                              ✓ 标记完成
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="goal-subtask-action-btn reopen"
                              onClick={() => triggerGoalAction("subtask", "pending", undefined, task.id)}
                            >
                              ↺ 重新开启
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="goal-empty-inline">暂无子任务。</div>
                )}
              </div>
            </div>
          )}

          {activeTab === "events" && (
            <div className="goal-tab-content">
              <div className="goal-card">
                <div className="goal-card-header">
                  <div className="goal-events-summary-line">
                    <span>
                      事件窗口: <strong>{currentGoal?.eventSummary?.total || 0}</strong> / {goalStatus?.config?.maxEvents || 40}
                      {currentGoal?.eventSummary?.rawTotal != null && ` (未压缩总量: ${currentGoal.eventSummary.rawTotal})`}
                    </span>
                    {currentGoal?.eventSummary?.oldestAt && (
                      <span className="text-dim">
                        · 最早: {formatRelativeTime(currentGoal.eventSummary.oldestAt, locale)}
                      </span>
                    )}
                  </div>
                </div>

                {/* Filter chips */}
                <div className="goal-filter-chips-row">
                  {(["all", "restore", "settled", "run", "retry", "error", "subtask"] as GoalEventFilter[]).map((filter) => {
                    const totalCount = currentGoal?.eventSummary?.total || 0;
                    const returnedCount = currentGoal?.eventSummary?.returnedTotal ?? currentGoal?.events?.length;
                    const count = filter === "all" ? totalCount : currentGoal?.eventSummary?.byType?.[filter] || 0;
                    const label = filter === "all" && returnedCount != null && returnedCount !== totalCount ? `all ${totalCount}/${returnedCount}` : `${filter} (${count})`;
                    const isSelected = goalEventFilter === filter;
                    return (
                      <button
                        key={filter}
                        type="button"
                        onClick={() => setGoalEventFilter(filter)}
                        className={`goal-filter-chip ${isSelected ? "selected" : ""} ${count === 0 ? "empty" : ""}`}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>

                {/* Events list */}
                {currentGoal?.events && currentGoal.events.length > 0 ? (
                  <div className="goal-events-table">
                    {currentGoal.events.map((event) => (
                      <div key={event.id} className="goal-event-item">
                        <span className={`goal-event-type-pill ${event.type}`}>{event.type}</span>
                        <span className="goal-event-message">{event.message}</span>
                        <span className="goal-event-time">{formatRelativeTime(event.createdAt, locale)}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="goal-empty-inline">
                    当前筛选下无匹配事件记录。
                  </div>
                )}
              </div>
            </div>
          )}

          {activeTab === "diagnostics" && (
            <div className="goal-tab-content">
              <div className="goal-diagnostics-grid">
                {/* Lock Card */}
                <div className="goal-diag-card">
                  <div className="goal-diag-card-title">🔒 跨进程文件锁 (Lock)</div>
                  <div className="goal-diag-item">
                    <span>状态</span>
                    <strong className={goalStatus?.lock?.stale ? "text-red" : goalStatus?.lock?.exists ? "text-amber" : "text-green"}>
                      {goalStatus?.lock?.stale ? "stale (过期)" : goalStatus?.lock?.exists ? "held (占用中)" : "free (空闲)"}
                    </strong>
                  </div>
                  <div className="goal-diag-item">
                    <span>锁文件路径</span>
                    <code className="text-dim" style={{ fontSize: 11 }}>{goalStatus?.lock?.path}</code>
                  </div>
                  {goalStatus?.lock?.ageMs != null && (
                    <div className="goal-diag-item">
                      <span>持有时长</span>
                      <span>{formatRelativeTime(Date.now() - goalStatus.lock.ageMs, locale)}</span>
                    </div>
                  )}
                  {goalStatus?.lock?.stale && (
                    <button
                      type="button"
                      className="goal-btn goal-btn-danger"
                      onClick={() => triggerGoalAction("unlock-stale-lock")}
                      style={{ marginTop: 8 }}
                    >
                      清理过期锁
                    </button>
                  )}
                </div>

                {/* Watchdog Card */}
                <div className="goal-diag-card">
                  <div className="goal-diag-card-title">🐕 看门狗巡检 (Watchdog)</div>
                  <div className="goal-diag-item">
                    <span>状态</span>
                    <strong className={goalStatus?.watchdog?.enabled ? "text-green" : "text-dim"}>
                      {goalStatus?.watchdog?.enabled ? goalStatus.watchdog.active ? "scanning (巡检中)" : "idle (空闲守护)" : "未启动"}
                    </strong>
                  </div>
                  <div className="goal-diag-item">
                    <span>巡检间隔</span>
                    <span>{Math.round((goalStatus?.watchdog?.intervalMs || 30000) / 1000)} 秒</span>
                  </div>
                  {goalStatus?.watchdog?.lastScanAt && (
                    <div className="goal-diag-item">
                      <span>上次巡检</span>
                      <span>
                        {formatRelativeTime(goalStatus.watchdog.lastScanAt, locale)}
                        {goalStatus.watchdog.lastScanDurationMs != null && ` (${Math.round(goalStatus.watchdog.lastScanDurationMs)}ms)`}
                      </span>
                    </div>
                  )}
                  {goalStatus?.watchdog?.nextScanAt && (
                    <div className="goal-diag-item">
                      <span>下次巡检</span>
                      <span>{formatRelativeTime(goalStatus.watchdog.nextScanAt, locale)}</span>
                    </div>
                  )}
                  <div className="goal-diag-item">
                    <span>恢复候选/成功</span>
                    <span>{goalStatus?.watchdog?.lastCandidateCount ?? 0} / {goalStatus?.watchdog?.lastRestoredCount ?? 0}</span>
                  </div>
                </div>

                {/* Backup Card */}
                <div className="goal-diag-card">
                  <div className="goal-diag-card-title">💾 自动备份 (Backup)</div>
                  <div className="goal-diag-item">
                    <span>备份状态</span>
                    <strong className={goalStatus?.backup?.readable ? "text-green" : "text-red"}>
                      {goalStatus?.backup?.readable ? "readable (可用)" : "missing"}
                    </strong>
                  </div>
                  <div className="goal-diag-item">
                    <span>备份会话数</span>
                    <span>{goalStatus?.backup?.sessionCount ?? 0}</span>
                  </div>
                  <div className="goal-diag-item">
                    <span>当前会话包含</span>
                    <span>{goalStatus?.backup?.containsCurrentSession ? "是 (包含)" : "否"}</span>
                  </div>
                  {goalStatus?.backup?.restorable && (
                    <button
                      type="button"
                      className="goal-btn goal-btn-danger"
                      onClick={() => triggerGoalAction("restore-backup")}
                      style={{ marginTop: 8 }}
                    >
                      从备份恢复
                    </button>
                  )}
                </div>

                {/* Configuration Card */}
                <div className="goal-diag-card">
                  <div className="goal-diag-card-title">⚙️ 配置与存储 (Config)</div>
                  <div className="goal-diag-item">
                    <span>主存储路径</span>
                    <code className="text-dim" style={{ fontSize: 11 }}>{goalStatus?.config?.storePath}</code>
                  </div>
                  <div className="goal-diag-item">
                    <span>默认模式</span>
                    <span>{goalStatus?.config?.defaultMode || "finish"}</span>
                  </div>
                  <div className="goal-diag-item">
                    <span>最大回退时间</span>
                    <span>{goalStatus?.config?.maxRetryMs ? `${Math.round(goalStatus.config.maxRetryMs / 60000)}m` : "20m"}</span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === "all-goals" && (
            <div className="goal-tab-content">
              <div className="goal-card">
                <div className="goal-card-header">
                  <span className="goal-card-label">全局会话目标列表</span>
                  <span className="goal-card-count">共 {otherGoals.length + (currentGoal ? 1 : 0)} 个</span>
                </div>
                <div className="goal-all-goals-list">
                  {currentGoal && (
                    <div className="goal-all-goal-item current">
                      <div className="goal-all-goal-badge">当前会话</div>
                      <div className="goal-all-goal-title">{currentGoal.objective}</div>
                      <div className="goal-all-goal-meta">
                        <span>{currentGoal.status}</span>
                        <span>iter: {currentGoal.iteration}</span>
                        <span>mode: {currentGoal.mode}</span>
                      </div>
                    </div>
                  )}
                  {otherGoals.map((g) => (
                    <div key={g.sessionId} className="goal-all-goal-item">
                      <div className="goal-all-goal-title">{g.objective}</div>
                      <div className="goal-all-goal-meta">
                        <span>{g.status}</span>
                        <span>iter: {g.iteration}</span>
                        <span>mode: {g.mode}</span>
                        <span>{formatRelativeTime(g.updatedAt, locale)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </section>

      <style>{`
        .goal-definitions-panel {
          display: grid;
          grid-template-columns: clamp(200px, 25%, 280px) minmax(0, 1fr);
          height: min(680px, 80dvh);
          min-height: 360px;
          overflow: hidden;
          background: var(--bg-panel);
          border-bottom: 1px solid var(--border);
          box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
        }
        .goal-definitions-sidebar,
        .goal-definitions-detail {
          display: flex;
          min-width: 0;
          min-height: 0;
          flex-direction: column;
        }
        .goal-definitions-sidebar {
          border-right: 1px solid var(--border);
          background: color-mix(in srgb, var(--bg-panel) 94%, var(--bg));
        }
        .goal-sidebar-header {
          padding: 12px 14px;
          border-bottom: 1px solid var(--border);
          display: flex;
          align-items: center;
          justify-content: space-between;
        }
        .goal-sidebar-brand {
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .goal-sidebar-icon {
          font-size: 18px;
        }
        .goal-sidebar-title {
          font-size: 13px;
          font-weight: 700;
          color: var(--text);
        }
        .goal-sidebar-version {
          font-size: 10px;
          color: var(--text-dim);
        }
        .goal-status-badge {
          font-size: 10px;
          font-weight: 600;
          padding: 2px 6px;
          border-radius: 4px;
        }
        .goal-status-badge.running {
          background: rgba(22, 163, 74, 0.15);
          color: #16a34a;
        }
        .goal-status-badge.complete {
          background: var(--bg-hover);
          color: var(--text-dim);
        }
        .goal-status-badge.idle {
          background: var(--bg);
          color: var(--text-dim);
        }
        .goal-nav-list {
          flex: 1;
          overflow-y: auto;
          display: flex;
          flex-direction: column;
        }
        .goal-nav-item {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 10px 14px;
          border: none;
          border-bottom: 1px solid color-mix(in srgb, var(--border) 50%, transparent);
          background: transparent;
          color: var(--text-muted);
          cursor: pointer;
          text-align: left;
          transition: background 0.15s ease;
        }
        .goal-nav-item:hover {
          background: var(--bg-hover);
          color: var(--text);
        }
        .goal-nav-item.selected {
          background: var(--bg-selected);
          box-shadow: inset 3px 0 0 var(--accent);
          color: var(--text);
        }
        .goal-nav-icon {
          font-size: 14px;
          flex-shrink: 0;
        }
        .goal-nav-text {
          flex: 1;
          min-width: 0;
          display: flex;
          flex-direction: column;
          gap: 2px;
        }
        .goal-nav-label {
          font-size: 12px;
          font-weight: 600;
        }
        .goal-nav-sub {
          font-size: 10px;
          color: var(--text-dim);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .goal-nav-badge {
          font-size: 10px;
          font-weight: 600;
          padding: 1px 6px;
          border-radius: 10px;
          background: var(--accent);
          color: #fff;
        }
        .goal-nav-badge.secondary {
          background: var(--bg-hover);
          color: var(--text-dim);
          border: 1px solid var(--border);
        }
        .goal-sidebar-footer {
          padding: 10px 14px;
          border-top: 1px solid var(--border);
          background: var(--bg);
          display: flex;
          flex-direction: column;
          gap: 4px;
          font-size: 11px;
          color: var(--text-dim);
        }
        .goal-footer-row {
          display: flex;
          justify-content: space-between;
          align-items: center;
        }
        .goal-detail-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 10px 16px;
          border-bottom: 1px solid var(--border);
          background: var(--bg-panel);
          flex-wrap: wrap;
          gap: 8px;
        }
        .goal-detail-header-left {
          display: flex;
          align-items: center;
          gap: 12px;
        }
        .goal-detail-section-title {
          font-size: 14px;
          font-weight: 700;
          color: var(--text);
        }
        .goal-action-feedback {
          font-size: 11px;
          color: var(--accent);
          font-weight: 500;
        }
        .goal-detail-header-actions {
          display: flex;
          align-items: center;
          gap: 6px;
          flex-wrap: wrap;
        }
        .goal-detail-scroll {
          flex: 1;
          overflow-y: auto;
          padding: 16px;
        }
        .goal-tab-content {
          display: flex;
          flex-direction: column;
          gap: 14px;
        }
        .goal-card {
          background: var(--bg);
          border: 1px solid var(--border);
          border-radius: 8px;
          padding: 14px;
          display: flex;
          flex-direction: column;
          gap: 10px;
        }
        .goal-card-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
        }
        .goal-card-label {
          font-size: 13px;
          font-weight: 700;
          color: var(--text);
        }
        .goal-card-count {
          font-size: 11px;
          color: var(--text-dim);
        }
        .goal-iter-tag {
          font-size: 11px;
          font-weight: 600;
          background: var(--bg-hover);
          padding: 2px 8px;
          border-radius: 4px;
          color: var(--accent);
        }
        .goal-objective-text {
          font-size: 14px;
          font-weight: 600;
          line-height: 1.5;
          color: var(--text);
          word-break: break-word;
        }
        .goal-meta-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
          gap: 10px;
          padding-top: 10px;
          border-top: 1px solid var(--border);
        }
        .goal-meta-item {
          display: flex;
          flex-direction: column;
          gap: 2px;
        }
        .goal-meta-key {
          font-size: 11px;
          color: var(--text-dim);
        }
        .goal-meta-val {
          font-size: 12px;
          font-weight: 600;
          color: var(--text);
        }
        .goal-meta-val.highlight {
          color: var(--accent);
        }
        .goal-btn {
          font-size: 11px;
          padding: 4px 10px;
          border-radius: 4px;
          border: 1px solid var(--border);
          cursor: pointer;
          font-weight: 500;
          transition: all 0.15s ease;
        }
        .goal-btn-primary {
          background: var(--accent);
          color: #fff;
          border-color: var(--accent);
        }
        .goal-btn-secondary {
          background: var(--bg-hover);
          color: var(--text);
        }
        .goal-btn-success {
          background: rgba(22, 163, 74, 0.12);
          color: #16a34a;
          border-color: rgba(22, 163, 74, 0.3);
        }
        .goal-btn-danger {
          background: rgba(220, 38, 38, 0.12);
          color: #dc2626;
          border-color: rgba(220, 38, 38, 0.3);
        }
        .goal-btn:disabled {
          opacity: 0.45;
          cursor: not-allowed;
        }
        .goal-link-btn {
          font-size: 11px;
          color: var(--accent);
          background: transparent;
          border: none;
          cursor: pointer;
        }
        .goal-subtasks-list {
          display: flex;
          flex-direction: column;
          gap: 6px;
        }
        .goal-subtasks-list.compact {
          max-height: 180px;
          overflow-y: auto;
        }
        .goal-subtask-row {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 6px 10px;
          background: var(--bg-panel);
          border: 1px solid var(--border);
          border-radius: 4px;
          font-size: 12px;
        }
        .goal-subtask-row.done {
          opacity: 0.65;
        }
        .goal-subtask-row.done .goal-subtask-title {
          text-decoration: line-through;
        }
        .goal-subtask-status-pill {
          font-size: 10px;
          font-weight: 600;
          padding: 1px 5px;
          border-radius: 3px;
          background: var(--bg-hover);
          color: var(--text-dim);
        }
        .goal-subtask-status-pill.done {
          background: rgba(22, 163, 74, 0.15);
          color: #16a34a;
        }
        .goal-subtask-title {
          flex: 1;
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          color: var(--text);
        }
        .goal-subtask-action-btn {
          font-size: 10px;
          padding: 2px 8px;
          border-radius: 3px;
          border: 1px solid var(--border);
          cursor: pointer;
          background: var(--bg);
        }
        .goal-subtask-action-btn.done {
          color: #16a34a;
        }
        .goal-subtask-action-btn.reopen {
          color: var(--text-dim);
        }
        .goal-add-subtask-form {
          display: flex;
          gap: 8px;
        }
        .goal-input {
          flex: 1;
          min-width: 0;
          height: 30px;
          border: 1px solid var(--border);
          border-radius: 4px;
          padding: 0 10px;
          background: var(--bg-panel);
          color: var(--text);
          font-size: 12px;
        }
        .goal-filter-chips-row {
          display: flex;
          gap: 6px;
          flex-wrap: wrap;
        }
        .goal-filter-chip {
          font-size: 11px;
          padding: 3px 8px;
          border-radius: 4px;
          border: 1px solid var(--border);
          background: var(--bg-panel);
          color: var(--text-muted);
          cursor: pointer;
        }
        .goal-filter-chip.selected {
          background: var(--accent);
          color: #fff;
          border-color: var(--accent);
        }
        .goal-filter-chip.empty {
          opacity: 0.5;
        }
        .goal-events-table {
          display: flex;
          flex-direction: column;
          gap: 4px;
          max-height: 360px;
          overflow-y: auto;
        }
        .goal-event-item {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 6px 10px;
          background: var(--bg-panel);
          border: 1px solid var(--border);
          border-radius: 4px;
          font-size: 12px;
        }
        .goal-event-type-pill {
          font-size: 10px;
          font-weight: 700;
          padding: 1px 6px;
          border-radius: 3px;
          background: var(--bg-hover);
          color: var(--accent);
        }
        .goal-event-message {
          flex: 1;
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          color: var(--text);
        }
        .goal-event-time {
          font-size: 11px;
          color: var(--text-dim);
          white-space: nowrap;
        }
        .goal-diagnostics-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
          gap: 12px;
        }
        .goal-diag-card {
          background: var(--bg);
          border: 1px solid var(--border);
          border-radius: 6px;
          padding: 12px;
          display: flex;
          flex-direction: column;
          gap: 6px;
          font-size: 12px;
        }
        .goal-diag-card-title {
          font-size: 12px;
          font-weight: 700;
          color: var(--text);
          margin-bottom: 4px;
        }
        .goal-diag-item {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 8px;
        }
        .goal-all-goals-list {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .goal-all-goal-item {
          padding: 10px;
          background: var(--bg-panel);
          border: 1px solid var(--border);
          border-radius: 6px;
          display: flex;
          flex-direction: column;
          gap: 4px;
        }
        .goal-all-goal-item.current {
          border-color: var(--accent);
        }
        .goal-all-goal-badge {
          font-size: 10px;
          font-weight: 600;
          color: var(--accent);
        }
        .goal-all-goal-title {
          font-size: 13px;
          font-weight: 600;
          color: var(--text);
        }
        .goal-all-goal-meta {
          display: flex;
          gap: 10px;
          font-size: 11px;
          color: var(--text-dim);
        }
        .goal-empty-panel {
          padding: 40px 20px;
          text-align: center;
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 10px;
        }
        .goal-empty-icon {
          font-size: 36px;
        }
        .goal-empty-title {
          font-size: 15px;
          font-weight: 700;
          color: var(--text);
        }
        .goal-empty-desc {
          font-size: 12px;
          color: var(--text-dim);
          max-width: 400px;
          line-height: 1.5;
        }
        .goal-empty-inline {
          font-size: 12px;
          color: var(--text-dim);
          font-style: italic;
          padding: 6px 0;
        }
        .text-green { color: #16a34a; }
        .text-red { color: #dc2626; }
        .text-amber { color: #d97706; }
        .text-dim { color: var(--text-dim); }

        @media (max-width: 640px) {
          .goal-definitions-panel {
            grid-template-columns: 120px minmax(0, 1fr);
          }
          .goal-nav-item {
            padding: 8px 10px;
          }
          .goal-detail-scroll {
            padding: 10px;
          }
        }
      `}</style>
    </div>
  );
}
