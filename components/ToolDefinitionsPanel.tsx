"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ToolEntry } from "@/lib/tool-presets";
import type { ToolOverride, ToolOverridesMap } from "@/lib/tool-overrides";

type Translate = (key: string, params?: Record<string, string | number>) => string;

interface Props {
  loading: boolean;
  tools: ToolEntry[] | null;
  translate: Translate;
  onToolsUpdated?: () => Promise<void> | void;
  sessionId?: string;
}

interface ParameterField {
  name: string;
  type: string;
  description?: string;
  required: boolean;
  allowedValues?: string;
  defaultValue?: string;
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function formatSchemaType(schema: Record<string, unknown>): string {
  const variants = Array.isArray(schema.anyOf)
    ? schema.anyOf
    : Array.isArray(schema.oneOf)
      ? schema.oneOf
      : null;
  if (variants) {
    return variants
      .map((variant) =>
        variant && typeof variant === "object"
          ? formatSchemaType(variant as Record<string, unknown>)
          : "unknown",
      )
      .filter((value, index, values) => values.indexOf(value) === index)
      .join(" | ");
  }

  if (schema.const !== undefined) return formatValue(schema.const);
  if (Array.isArray(schema.enum) && schema.enum.length > 0 && schema.type === undefined) {
    return [...new Set(schema.enum.map((value) => (value === null ? "null" : typeof value)))].join(" | ");
  }

  const rawType = schema.type;
  const type = Array.isArray(rawType)
    ? rawType.filter((value): value is string => typeof value === "string").join(" | ")
    : typeof rawType === "string"
      ? rawType
      : typeof schema.$ref === "string"
        ? schema.$ref.split("/").pop() ?? "object"
        : "unknown";

  if (type === "array") {
    const items = schema.items;
    const itemType = items && typeof items === "object"
      ? formatSchemaType(items as Record<string, unknown>)
      : "unknown";
    return `${itemType}[]`;
  }
  return type;
}

export function getToolParameterFields(parameters?: Record<string, unknown>): ParameterField[] {
  if (!parameters || !parameters.properties || typeof parameters.properties !== "object") return [];
  const properties = parameters.properties as Record<string, unknown>;
  const required = new Set(
    Array.isArray(parameters.required)
      ? parameters.required.filter((value): value is string => typeof value === "string")
      : [],
  );

  return Object.entries(properties).map(([name, value]) => {
    const schema = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
    return {
      name,
      type: formatSchemaType(schema),
      description: typeof schema.description === "string" ? schema.description : undefined,
      required: required.has(name),
      allowedValues: Array.isArray(schema.enum) ? schema.enum.map(formatValue).join(", ") : undefined,
      defaultValue: schema.default === undefined ? undefined : formatValue(schema.default),
    };
  });
}

function EmptyState({ children }: { children: string }) {
  return <div className="tool-definitions-empty">{children}</div>;
}

export function ToolDefinitionsPanel({ loading, tools, translate, onToolsUpdated, sessionId }: Props) {
  const [filterActiveTab, setFilterActiveTab] = useState<"all" | "active" | "inactive">("all");
  const [filterScopeTab, setFilterScopeTab] = useState<"all" | "workspace" | "global">("all");
  const [isToggling, setIsToggling] = useState(false);

  // All non-hidden tools (both active and inactive) can be inspected in the panel
  const declaredTools = useMemo(
    () => tools?.filter((tool) => !tool.declarationHidden) ?? null,
    [tools],
  );

  const filteredTools = useMemo(() => {
    if (!declaredTools) return null;
    return declaredTools.filter((tool) => {
      if (filterActiveTab === "active" && !tool.active) return false;
      if (filterActiveTab === "inactive" && tool.active) return false;
      if (filterScopeTab === "workspace" && tool.scope !== "workspace") return false;
      if (filterScopeTab === "global" && tool.scope === "workspace") return false;
      return true;
    });
  }, [declaredTools, filterActiveTab, filterScopeTab]);
  const [selectedToolName, setSelectedToolName] = useState<string | null>(null);

  // Overrides management state
  const [overrides, setOverrides] = useState<ToolOverridesMap>({});
  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ text: string; isError?: boolean } | null>(null);

  // Editing draft state
  const [editDescription, setEditDescription] = useState("");
  const [editRequired, setEditRequired] = useState<Set<string>>(new Set());
  const [editParamDescriptions, setEditParamDescriptions] = useState<Record<string, string>>({});
  const [editParamDefaults, setEditParamDefaults] = useState<Record<string, string>>({});
  const [editGuidelines, setEditGuidelines] = useState<string[]>([]);

  // Fetch overrides on mount
  useEffect(() => {
    let unmounted = false;
    void fetch("/api/tools/overrides")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!unmounted && data?.overrides) {
          setOverrides(data.overrides);
        }
      })
      .catch(() => {});
    return () => {
      unmounted = true;
    };
  }, []);

  useEffect(() => {
    setSelectedToolName((current) =>
      filteredTools?.some((tool) => tool.name === current)
        ? current
        : filteredTools?.[0]?.name ?? null,
    );
  }, [filteredTools]);

  const selectedTool = filteredTools?.find((tool) => tool.name === selectedToolName)
    ?? filteredTools?.[0]
    ?? null;
  const fields = useMemo(() => (selectedTool ? getToolParameterFields(selectedTool.parameters) : []), [selectedTool]);

  const handleToggleTool = useCallback(async () => {
    if (!selectedTool || !sessionId || isToggling) return;
    setIsToggling(true);
    try {
      const res = await fetch(`/api/agent/${encodeURIComponent(sessionId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "toggle_tool",
          toolName: selectedTool.name,
          active: !selectedTool.active,
        }),
      });
      if (res.ok) {
        await onToolsUpdated?.();
      }
    } catch {
      // ignore
    } finally {
      setIsToggling(false);
    }
  }, [selectedTool, sessionId, isToggling, onToolsUpdated]);

  // Cancel edit when tool changes
  useEffect(() => {
    setIsEditing(false);
    setFeedback(null);
  }, [selectedToolName]);

  const startEditing = useCallback(() => {
    if (!selectedTool) return;
    setEditDescription(selectedTool.description || "");
    const req = new Set(
      Array.isArray(selectedTool.parameters?.required)
        ? (selectedTool.parameters.required as string[]).filter((x) => typeof x === "string")
        : [],
    );
    setEditRequired(req);
    const descriptions: Record<string, string> = {};
    const defaults: Record<string, string> = {};
    for (const field of fields) {
      if (field.description) descriptions[field.name] = field.description;
      if (field.defaultValue !== undefined) defaults[field.name] = field.defaultValue;
    }
    setEditParamDescriptions(descriptions);
    setEditParamDefaults(defaults);
    setEditGuidelines(selectedTool.promptGuidelines ? [...selectedTool.promptGuidelines] : []);
    setIsEditing(true);
    setFeedback(null);
  }, [selectedTool, fields]);

  const handleSave = useCallback(async () => {
    if (!selectedTool) return;
    setIsSaving(true);
    setFeedback(null);
    try {
      const override: ToolOverride = {
        description: editDescription.trim() || undefined,
        required: Array.from(editRequired),
        promptGuidelines: editGuidelines.map((g) => g.trim()).filter(Boolean),
        properties: {},
      };
      for (const field of fields) {
        const desc = editParamDescriptions[field.name]?.trim();
        const def = editParamDefaults[field.name]?.trim();
        if (desc !== undefined || def !== undefined) {
          override.properties![field.name] = {
            description: desc || undefined,
            defaultValue: def || undefined,
          };
        }
      }

      const res = await fetch("/api/tools/overrides", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toolName: selectedTool.name, override }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Save failed");
      }

      const data = await res.json();
      if (data.overrides) setOverrides(data.overrides);

      await onToolsUpdated?.();
      setIsEditing(false);
      setFeedback({ text: translate("tools.saveSuccess") });
      setTimeout(() => setFeedback(null), 3000);
    } catch (error) {
      setFeedback({
        text: error instanceof Error ? error.message : String(error),
        isError: true,
      });
    } finally {
      setIsSaving(false);
    }
  }, [selectedTool, editDescription, editRequired, editGuidelines, fields, editParamDescriptions, editParamDefaults, onToolsUpdated, translate]);

  const handleReset = useCallback(async () => {
    if (!selectedTool) return;
    setIsSaving(true);
    setFeedback(null);
    try {
      const res = await fetch("/api/tools/overrides", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toolName: selectedTool.name, override: null }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Reset failed");
      }

      const data = await res.json();
      if (data.overrides) setOverrides(data.overrides);

      await onToolsUpdated?.();
      setIsEditing(false);
      setFeedback({ text: translate("tools.resetSuccess") });
      setTimeout(() => setFeedback(null), 3000);
    } catch (error) {
      setFeedback({
        text: error instanceof Error ? error.message : String(error),
        isError: true,
      });
    } finally {
      setIsSaving(false);
    }
  }, [selectedTool, onToolsUpdated, translate]);

  const isCustomized = selectedTool ? Boolean(overrides[selectedTool.name]) : false;

  return (
    <div className="tool-definitions-panel">
      <nav className="tool-definitions-sidebar" aria-label={translate("tools.title")}>
        <div className="tool-sidebar-filters">
          <div className="tool-filter-group">
            <span className="tool-filter-label">{translate("tools.activeFilter")}:</span>
            <div className="tool-filter-buttons">
              <button
                type="button"
                className={`tool-filter-btn ${filterActiveTab === "all" ? "active" : ""}`}
                onClick={() => setFilterActiveTab("all")}
              >
                {translate("tools.allFilter")}
              </button>
              <button
                type="button"
                className={`tool-filter-btn ${filterActiveTab === "active" ? "active" : ""}`}
                onClick={() => setFilterActiveTab("active")}
              >
                {translate("tools.activeFilter")}
              </button>
              <button
                type="button"
                className={`tool-filter-btn ${filterActiveTab === "inactive" ? "active" : ""}`}
                onClick={() => setFilterActiveTab("inactive")}
              >
                {translate("tools.inactiveFilter")}
              </button>
            </div>
          </div>
          <div className="tool-filter-group">
            <span className="tool-filter-label">{translate("tools.scopeAll")}:</span>
            <div className="tool-filter-buttons">
              <button
                type="button"
                className={`tool-filter-btn ${filterScopeTab === "all" ? "active" : ""}`}
                onClick={() => setFilterScopeTab("all")}
              >
                {translate("tools.allFilter")}
              </button>
              <button
                type="button"
                className={`tool-filter-btn ${filterScopeTab === "workspace" ? "active" : ""}`}
                onClick={() => setFilterScopeTab("workspace")}
              >
                {translate("tools.workspaceScope")}
              </button>
              <button
                type="button"
                className={`tool-filter-btn ${filterScopeTab === "global" ? "active" : ""}`}
                onClick={() => setFilterScopeTab("global")}
              >
                {translate("tools.globalScope")}
              </button>
            </div>
          </div>
        </div>

        <div className="tool-definitions-list">
          {filteredTools && filteredTools.length > 0 ? (
            filteredTools.map((tool) => {
              const selected = tool.name === selectedTool?.name;
              const hasOverride = Boolean(overrides[tool.name]);
              return (
                <button
                  key={tool.name}
                  type="button"
                  className={`tool-definitions-item${selected ? " selected" : ""}${tool.active ? " is-active" : " is-inactive"}`}
                  aria-pressed={selected}
                  onClick={() => setSelectedToolName(tool.name)}
                >
                  <div className="tool-item-info">
                    <span className={`tool-item-status-dot ${tool.active ? "active" : "inactive"}`} />
                    <code>{tool.name}</code>
                    {hasOverride && (
                      <span
                        className="tool-customized-dot"
                        title={translate("tools.customizedBadge")}
                      >
                        ●
                      </span>
                    )}
                  </div>
                  <span className="tool-item-scope-tag">
                    {tool.scope === "workspace" ? translate("tools.workspaceScope") : translate("tools.globalScope")}
                  </span>
                </button>
              );
            })
          ) : filteredTools ? (
            <EmptyState>{translate("tools.noTools")}</EmptyState>
          ) : (
            <EmptyState>{loading ? translate("tools.loading") : translate("tools.load")}</EmptyState>
          )}
        </div>
      </nav>

      <section className="tool-definition-detail" aria-label={translate("tools.details")}>
        {selectedTool ? (
          <div className="tool-definition-scroll">
            <div className="tool-definition-header">
              <div className="tool-definition-title-row">
                <code className="tool-title-name">{selectedTool.name}</code>
                <span className={`tool-status-pill ${selectedTool.active ? "active" : "inactive"}`}>
                  {selectedTool.active ? `${translate("tools.activeFilter")} (Active)` : `${translate("tools.inactiveFilter")} (Inactive)`}
                </span>
                <span className="tool-scope-pill">
                  {selectedTool.scope === "workspace"
                    ? `${translate("tools.workspaceScope")} (Workspace)`
                    : `${translate("tools.globalScope")} (Global)`}
                </span>
                {isCustomized && (
                  <span className="tool-customized-tag">{translate("tools.customizedBadge")}</span>
                )}
              </div>
              <div className="tool-definition-actions">
                {sessionId && (
                  <button
                    type="button"
                    className={`tool-action-btn ${selectedTool.active ? "tool-btn-deactivate" : "tool-btn-activate"}`}
                    disabled={isToggling}
                    onClick={handleToggleTool}
                  >
                    {isToggling
                      ? "切换中…"
                      : selectedTool.active
                        ? "⏸ 停用该工具"
                        : "▶ 激活该工具"}
                  </button>
                )}
                {isEditing ? (
                  <>
                    <button
                      type="button"
                      className="tool-action-btn tool-btn-save"
                      disabled={isSaving}
                      onClick={handleSave}
                    >
                      {translate(isSaving ? "tools.saving" : "tools.save")}
                    </button>
                    <button
                      type="button"
                      className="tool-action-btn tool-btn-secondary"
                      disabled={isSaving}
                      onClick={() => setIsEditing(false)}
                    >
                      {translate("tools.cancel")}
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      className="tool-action-btn tool-btn-primary"
                      onClick={startEditing}
                    >
                      ✏️ {translate("tools.customize")}
                    </button>
                    {isCustomized && (
                      <button
                        type="button"
                        className="tool-action-btn tool-btn-secondary"
                        disabled={isSaving}
                        onClick={handleReset}
                      >
                        ↺ {translate("tools.reset")}
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>

            {feedback && (
              <div className={`tool-feedback-banner ${feedback.isError ? "error" : "success"}`}>
                {feedback.text}
              </div>
            )}

            <section className="tool-definition-section">
              <div className="tool-definition-section-label">{translate("tools.description")}</div>
              {isEditing ? (
                <textarea
                  className="tool-edit-textarea"
                  rows={3}
                  value={editDescription}
                  placeholder={translate("tools.paramDescPlaceholder")}
                  onChange={(e) => setEditDescription(e.target.value)}
                />
              ) : (
                selectedTool.description && (
                  <div className="tool-definition-description">{selectedTool.description}</div>
                )
              )}
            </section>

            <section className="tool-definition-section">
              <div className="tool-definition-section-label">
                <span>{translate("tools.parameters")}</span>
                <span>{translate("tools.parameterCount", { count: fields.length })}</span>
              </div>
              {fields.length > 0 ? (
                <div className="tool-definition-fields">
                  {fields.map((field) => {
                    const isRequired = isEditing
                      ? editRequired.has(field.name)
                      : field.required;

                    return (
                      <div className="tool-definition-field" key={field.name}>
                        <div className="tool-definition-field-name">
                          <code>{field.name}</code>
                          {isEditing ? (
                            <label className="tool-required-checkbox-label">
                              <input
                                type="checkbox"
                                checked={isRequired}
                                onChange={(e) => {
                                  const next = new Set(editRequired);
                                  if (e.target.checked) next.add(field.name);
                                  else next.delete(field.name);
                                  setEditRequired(next);
                                }}
                              />
                              <span className={isRequired ? "required" : undefined}>
                                {translate(isRequired ? "tools.required" : "tools.optional")}
                              </span>
                            </label>
                          ) : (
                            <span className={isRequired ? "required" : undefined}>
                              {translate(isRequired ? "tools.required" : "tools.optional")}
                            </span>
                          )}
                        </div>
                        <div className="tool-definition-field-value">
                          <code className="tool-definition-type">{field.type}</code>
                          {isEditing ? (
                            <div className="tool-edit-param-inputs">
                              <input
                                type="text"
                                className="tool-edit-input"
                                placeholder={translate("tools.paramDescPlaceholder")}
                                value={
                                  editParamDescriptions[field.name] ??
                                  (field.description || "")
                                }
                                onChange={(e) => {
                                  setEditParamDescriptions((prev) => ({
                                    ...prev,
                                    [field.name]: e.target.value,
                                  }));
                                }}
                              />
                              <div className="tool-edit-param-default-row">
                                <span className="tool-definition-meta-label">
                                  {translate("tools.defaultValue")}:
                                </span>
                                <input
                                  type="text"
                                  className="tool-edit-input tool-edit-input-sm"
                                  placeholder={field.defaultValue ?? ""}
                                  value={
                                    editParamDefaults[field.name] ??
                                    (field.defaultValue || "")
                                  }
                                  onChange={(e) => {
                                    setEditParamDefaults((prev) => ({
                                      ...prev,
                                      [field.name]: e.target.value,
                                    }));
                                  }}
                                />
                              </div>
                            </div>
                          ) : (
                            <>
                              {field.description && <div>{field.description}</div>}
                              {field.allowedValues && (
                                <div className="tool-definition-meta">
                                  {translate("tools.allowedValues")}:{" "}
                                  <code>{field.allowedValues}</code>
                                </div>
                              )}
                              {field.defaultValue !== undefined && (
                                <div className="tool-definition-meta">
                                  {translate("tools.defaultValue")}:{" "}
                                  <code>{field.defaultValue}</code>
                                </div>
                              )}
                            </>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="tool-definition-no-parameters">{translate("tools.noParameters")}</div>
              )}
            </section>

            <section className="tool-definition-section">
              <div className="tool-definition-section-label">
                <span>{translate("tools.guidelines")}</span>
                {isEditing && (
                  <button
                    type="button"
                    className="tool-guideline-add-btn"
                    onClick={() => setEditGuidelines((prev) => [...prev, ""])}
                  >
                    + {translate("tools.addGuideline")}
                  </button>
                )}
              </div>
              {isEditing ? (
                <div className="tool-guidelines-edit-list">
                  {editGuidelines.length > 0 ? (
                    editGuidelines.map((guideline, index) => (
                      <div key={index} className="tool-guideline-edit-row">
                        <input
                          type="text"
                          className="tool-edit-input"
                          placeholder={translate("tools.guidelinePlaceholder")}
                          value={guideline}
                          onChange={(e) => {
                            const next = [...editGuidelines];
                            next[index] = e.target.value;
                            setEditGuidelines(next);
                          }}
                        />
                        <button
                          type="button"
                          className="tool-guideline-del-btn"
                          title={translate("tools.deleteGuideline")}
                          onClick={() => {
                            setEditGuidelines((prev) => prev.filter((_, i) => i !== index));
                          }}
                        >
                          ✕
                        </button>
                      </div>
                    ))
                  ) : (
                    <div className="tool-definition-no-parameters">
                      {translate("tools.noParameters")}
                    </div>
                  )}
                </div>
              ) : selectedTool.promptGuidelines && selectedTool.promptGuidelines.length > 0 ? (
                <ul className="tool-definition-guidelines">
                  {selectedTool.promptGuidelines.map((guideline, index) => (
                    <li key={`${selectedTool.name}:${index}`}>{guideline}</li>
                  ))}
                </ul>
              ) : null}
            </section>
          </div>
        ) : (
          <EmptyState>
            {declaredTools
              ? translate("tools.noTools")
              : loading
                ? translate("tools.loading")
                : translate("tools.load")}
          </EmptyState>
        )}
      </section>

      <style>{`
        .tool-sidebar-filters {
          padding: 8px 10px;
          border-bottom: 1px solid var(--border);
          display: flex;
          flex-direction: column;
          gap: 6px;
          background: var(--bg);
        }
        .tool-filter-group {
          display: flex;
          align-items: center;
          gap: 6px;
          font-size: 11px;
        }
        .tool-filter-label {
          color: var(--text-dim);
          font-size: 10px;
          width: 28px;
          flex-shrink: 0;
        }
        .tool-filter-buttons {
          display: flex;
          gap: 2px;
          flex: 1;
        }
        .tool-filter-btn {
          flex: 1;
          padding: 2px 4px;
          font-size: 10px;
          border-radius: 3px;
          border: 1px solid var(--border);
          background: var(--bg-panel);
          color: var(--text-muted);
          cursor: pointer;
          text-align: center;
        }
        .tool-filter-btn:hover {
          background: var(--bg-hover);
          color: var(--text);
        }
        .tool-filter-btn.active {
          background: var(--accent);
          color: #fff;
          border-color: var(--accent);
          font-weight: 600;
        }
        .tool-item-info {
          display: flex;
          align-items: center;
          gap: 6px;
          min-width: 0;
          flex: 1;
        }
        .tool-item-status-dot {
          width: 6px;
          height: 6px;
          border-radius: 5px;
          flex-shrink: 0;
        }
        .tool-item-status-dot.active {
          background: #16a34a;
          box-shadow: 0 0 4px rgba(22, 163, 74, 0.4);
        }
        .tool-item-status-dot.inactive {
          background: var(--border);
        }
        .tool-item-scope-tag {
          font-size: 9px;
          padding: 1px 4px;
          border-radius: 2px;
          background: var(--bg-hover);
          color: var(--text-dim);
          flex-shrink: 0;
          margin-left: 4px;
        }
        .tool-status-pill {
          font-size: 10px;
          font-weight: 600;
          padding: 2px 6px;
          border-radius: 4px;
        }
        .tool-status-pill.active {
          background: rgba(22, 163, 74, 0.15);
          color: #16a34a;
          border: 1px solid rgba(22, 163, 74, 0.3);
        }
        .tool-status-pill.inactive {
          background: var(--bg-hover);
          color: var(--text-dim);
          border: 1px solid var(--border);
        }
        .tool-scope-pill {
          font-size: 10px;
          padding: 2px 6px;
          border-radius: 4px;
          background: var(--bg-panel);
          color: var(--text-muted);
          border: 1px solid var(--border);
        }
        .tool-btn-activate {
          background: rgba(22, 163, 74, 0.15);
          color: #16a34a;
          border: 1px solid rgba(22, 163, 74, 0.3);
        }
        .tool-btn-activate:hover {
          background: #16a34a;
          color: #fff;
        }
        .tool-btn-deactivate {
          background: rgba(239, 68, 68, 0.12);
          color: #ef4444;
          border: 1px solid rgba(239, 68, 68, 0.3);
        }
        .tool-btn-deactivate:hover {
          background: #ef4444;
          color: #fff;
        }
        .tool-definitions-item.is-inactive {
          opacity: 0.7;
        }
        .tool-definitions-panel {
          display: grid;
          grid-template-columns: clamp(140px, 28%, 240px) minmax(0, 1fr);
          height: min(600px, 75dvh);
          min-height: 240px;
          overflow: hidden;
          background: var(--bg-panel);
          border-bottom: 1px solid var(--border);
        }
        .tool-definitions-sidebar,
        .tool-definition-detail {
          display: flex;
          min-width: 0;
          min-height: 0;
          flex-direction: column;
        }
        .tool-definitions-sidebar {
          border-right: 1px solid var(--border);
          background: color-mix(in srgb, var(--bg-panel) 94%, var(--bg));
        }
        .tool-definitions-list,
        .tool-definition-scroll {
          min-height: 0;
          flex: 1;
          overflow: auto;
        }
        .tool-definitions-item {
          display: flex;
          width: 100%;
          min-height: 38px;
          align-items: center;
          justify-content: space-between;
          padding: 8px 12px;
          border: none;
          border-bottom: 1px solid var(--border);
          background: transparent;
          color: var(--text-muted);
          cursor: pointer;
          text-align: left;
        }
        .tool-definitions-item:hover {
          background: var(--bg-hover);
          color: var(--text);
        }
        .tool-definitions-item.selected {
          background: var(--bg-selected);
          box-shadow: inset 2px 0 0 var(--accent);
          color: var(--text);
        }
        .tool-definitions-item code {
          max-width: calc(100% - 16px);
          color: inherit;
          font-size: 11px;
          font-weight: 600;
          overflow-wrap: anywhere;
        }
        .tool-customized-dot {
          color: var(--accent);
          font-size: 8px;
          margin-left: 6px;
        }
        .tool-definition-scroll {
          padding: 14px 16px 20px;
        }
        .tool-definition-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          flex-wrap: wrap;
          gap: 10px;
          padding-bottom: 12px;
          margin-bottom: 12px;
          border-bottom: 1px solid var(--border);
        }
        .tool-definition-title-row {
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .tool-title-name {
          font-size: 14px;
          font-weight: 700;
          color: var(--text);
        }
        .tool-customized-tag {
          font-size: 10px;
          padding: 2px 6px;
          border-radius: 4px;
          background: color-mix(in srgb, var(--accent) 15%, transparent);
          color: var(--accent);
          font-weight: 600;
        }
        .tool-definition-actions {
          display: flex;
          align-items: center;
          gap: 6px;
        }
        .tool-action-btn {
          font-size: 11px;
          padding: 4px 10px;
          border-radius: 4px;
          border: 1px solid var(--border);
          cursor: pointer;
          font-weight: 500;
          transition: all 0.15s ease;
        }
        .tool-btn-primary {
          background: var(--bg-hover);
          color: var(--text);
        }
        .tool-btn-primary:hover {
          background: var(--bg-selected);
          border-color: var(--accent);
        }
        .tool-btn-save {
          background: var(--accent);
          color: #fff;
          border-color: var(--accent);
        }
        .tool-btn-save:hover {
          opacity: 0.9;
        }
        .tool-btn-save:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
        .tool-btn-secondary {
          background: transparent;
          color: var(--text-muted);
        }
        .tool-btn-secondary:hover {
          background: var(--bg-hover);
          color: var(--text);
        }
        .tool-feedback-banner {
          padding: 6px 10px;
          border-radius: 4px;
          font-size: 11px;
          margin-bottom: 12px;
        }
        .tool-feedback-banner.success {
          background: color-mix(in srgb, #10b981 15%, transparent);
          color: #10b981;
          border: 1px solid color-mix(in srgb, #10b981 30%, transparent);
        }
        .tool-feedback-banner.error {
          background: color-mix(in srgb, #ef4444 15%, transparent);
          color: #ef4444;
          border: 1px solid color-mix(in srgb, #ef4444 30%, transparent);
        }
        .tool-definition-section + .tool-definition-section {
          margin-top: 18px;
        }
        .tool-definition-section-label {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          margin-bottom: 7px;
          color: var(--text-dim);
          font-size: 11px;
          font-weight: 600;
        }
        .tool-definition-section-label > span:last-child {
          font-weight: 400;
          white-space: nowrap;
        }
        .tool-definition-description {
          color: var(--text-muted);
          font-size: 12px;
          line-height: 1.55;
          overflow-wrap: anywhere;
          white-space: pre-wrap;
        }
        .tool-edit-textarea {
          width: 100%;
          box-sizing: border-box;
          padding: 8px;
          font-size: 12px;
          line-height: 1.5;
          border-radius: 4px;
          border: 1px solid var(--border);
          background: var(--bg);
          color: var(--text);
          resize: vertical;
          font-family: inherit;
        }
        .tool-edit-textarea:focus,
        .tool-edit-input:focus {
          outline: none;
          border-color: var(--accent);
        }
        .tool-edit-input {
          width: 100%;
          box-sizing: border-box;
          padding: 5px 8px;
          font-size: 11px;
          border-radius: 4px;
          border: 1px solid var(--border);
          background: var(--bg);
          color: var(--text);
        }
        .tool-edit-input-sm {
          max-width: 140px;
        }
        .tool-definition-fields {
          border-top: 1px solid var(--border);
        }
        .tool-definition-field {
          display: grid;
          grid-template-columns: minmax(88px, 0.75fr) minmax(0, 1.5fr);
          gap: 12px;
          padding: 9px 0;
          border-bottom: 1px solid var(--border);
          font-size: 11px;
          line-height: 1.45;
        }
        .tool-definition-field-name {
          display: flex;
          min-width: 0;
          flex-direction: column;
          gap: 3px;
          color: var(--text);
        }
        .tool-definition-field-name code {
          overflow-wrap: anywhere;
        }
        .tool-definition-field-name span {
          color: var(--text-dim);
          font-size: 10px;
        }
        .tool-definition-field-name span.required {
          color: var(--accent);
          font-weight: 600;
        }
        .tool-required-checkbox-label {
          display: flex;
          align-items: center;
          gap: 4px;
          cursor: pointer;
          user-select: none;
        }
        .tool-required-checkbox-label input[type="checkbox"] {
          margin: 0;
          cursor: pointer;
          accent-color: var(--accent);
        }
        .tool-edit-param-inputs {
          display: flex;
          flex-direction: column;
          gap: 6px;
        }
        .tool-edit-param-default-row {
          display: flex;
          align-items: center;
          gap: 6px;
          font-size: 10px;
          color: var(--text-dim);
        }
        .tool-definition-field-value {
          min-width: 0;
          color: var(--text-muted);
          overflow-wrap: anywhere;
        }
        .tool-definition-type {
          display: block;
          margin-bottom: 3px;
          color: var(--text);
        }
        .tool-definition-meta {
          margin-top: 4px;
          color: var(--text-dim);
        }
        .tool-definition-meta code {
          color: var(--text-muted);
        }
        .tool-definition-no-parameters {
          padding: 2px 0 10px;
          color: var(--text-dim);
          font-size: 11px;
        }
        .tool-definition-guidelines {
          margin: 0;
          padding-left: 18px;
          color: var(--text-muted);
          font-size: 11px;
          line-height: 1.5;
        }
        .tool-guideline-add-btn {
          font-size: 10px;
          padding: 2px 6px;
          border-radius: 3px;
          border: 1px solid var(--border);
          background: transparent;
          color: var(--accent);
          cursor: pointer;
        }
        .tool-guideline-add-btn:hover {
          background: var(--bg-hover);
        }
        .tool-guidelines-edit-list {
          display: flex;
          flex-direction: column;
          gap: 6px;
        }
        .tool-guideline-edit-row {
          display: flex;
          align-items: center;
          gap: 6px;
        }
        .tool-guideline-del-btn {
          padding: 4px 8px;
          border: 1px solid var(--border);
          background: transparent;
          color: var(--text-dim);
          border-radius: 4px;
          cursor: pointer;
          font-size: 11px;
          flex-shrink: 0;
        }
        .tool-guideline-del-btn:hover {
          color: #ef4444;
          border-color: #ef4444;
          background: color-mix(in srgb, #ef4444 10%, transparent);
        }
        .tool-definitions-empty {
          padding: 14px 12px;
          color: var(--text-muted);
          font-size: 12px;
          font-style: italic;
          overflow-wrap: anywhere;
        }
        @media (max-width: 640px) {
          .tool-definitions-panel {
            grid-template-columns: 112px minmax(0, 1fr);
          }
          .tool-definitions-item {
            padding: 8px 10px;
          }
          .tool-definition-scroll {
            padding: 12px;
          }
          .tool-definition-field {
            grid-template-columns: minmax(74px, 0.7fr) minmax(0, 1.3fr);
            gap: 9px;
          }
        }
      `}</style>
    </div>
  );
}
