import { ArrowUp, Square } from "lucide-react";
import { PERMISSION_MODE_OPTIONS, PROMPT_PRESETS } from "../app/constants.js";
import { providerCliCommand } from "../app/utils.js";
import ModelPicker from "./ModelPicker.jsx";

export default function ComposerPanel({
  activeModelParent,
  draft,
  hoveredModelGroup,
  hoveredModelSubGroup,
  modelGroups,
  modelGroupStates,
  modelMenuOpen,
  modelMenuPos,
  modelPickerRef,
  onChangeDraft,
  onChooseModel,
  onHoverGroup,
  onHoverSubGroup,
  onPromptPresetChange,
  onSend,
  onStop,
  running = false,
  enterToSend = true,
  onToggleModelMenu,
  onPermissionModeChange,
  sendingDisabled,
  selectedModelId,
  terminalPanelOpen,
  terminalViewMode,
  permissionMode,
  permissionModeInfo,
  promptPreset,
}) {
  return (
    <div
      className="composer-panel"
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      <textarea
        value={draft}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
        onChange={(event) => onChangeDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          // "Send message" mode: Enter sends, Shift+Enter inserts a newline.
          // "Insert newline" mode: Enter is a newline, Ctrl/Cmd+Enter sends.
          const shouldSend = enterToSend ? !event.shiftKey : event.metaKey || event.ctrlKey;
          if (shouldSend) {
            event.preventDefault();
            void onSend();
          }
        }}
        placeholder={
          terminalViewMode === "live" && terminalPanelOpen
            ? `Talking to ${providerCliCommand(selectedModelId || "")} — type anything...`
            : "Ask for changes, inspect the repo, or debug a file..."
        }
      />
      <div className="composer-footer">
        <div className="composer-controls">
          <select
            value={promptPreset || "code"}
            onChange={(event) => void onPromptPresetChange(event.target.value)}
            title="Prompt mode"
          >
            {PROMPT_PRESETS.map((preset) => (
              <option key={preset.value} value={preset.value}>
                {preset.label}
              </option>
            ))}
          </select>
          <select
            className={permissionModeInfo?.note ? "permission-mode-select has-fallback" : "permission-mode-select"}
            value={permissionMode || "full-access"}
            onChange={(event) => void onPermissionModeChange(event.target.value)}
            title={[
              PERMISSION_MODE_OPTIONS.find((option) => option.value === (permissionMode || "full-access"))?.hint,
              permissionModeInfo?.note,
            ].filter(Boolean).join("\n")}
            aria-label="Chat permissions"
          >
            {PERMISSION_MODE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <ModelPicker
            activeModelParent={activeModelParent}
            hoveredModelGroup={hoveredModelGroup}
            hoveredModelSubGroup={hoveredModelSubGroup}
            modelGroupStates={modelGroupStates}
            modelGroups={modelGroups}
            modelMenuOpen={modelMenuOpen}
            modelMenuPos={modelMenuPos}
            modelPickerRef={modelPickerRef}
            onChooseModel={onChooseModel}
            onHoverGroup={onHoverGroup}
            onHoverSubGroup={onHoverSubGroup}
            onToggle={onToggleModelMenu}
            selectedModelId={selectedModelId}
          />
        </div>
        {running && onStop && !draft.trim() ? (
          <button type="button" className="primary-button composer-send" onClick={onStop} title="Stop the running response">
            <Square size={14} className="ui-icon" fill="currentColor" />
            Stop
          </button>
        ) : (
          <button
            type="button"
            className="primary-button composer-send"
            onClick={onSend}
            disabled={sendingDisabled || (!draft.trim() && !(terminalViewMode === "live" && terminalPanelOpen))}
            title={enterToSend ? "Send (Enter)" : "Send (Ctrl+Enter)"}
          >
            <ArrowUp size={16} className="ui-icon" />
            {terminalViewMode === "live" && terminalPanelOpen ? "Run" : "Send"}
          </button>
        )}
      </div>
      {permissionModeInfo?.note ? (
        <div className="permission-mode-note" role="note">{permissionModeInfo.note}</div>
      ) : (permissionMode || "full-access") === "full-access" && permissionModeInfo?.asksForRiskyCommands ? (
        <div className="permission-mode-note" role="note">
          Risky commands (recursive deletes, force pushes, downloads, leaving the project folder) still ask first.
        </div>
      ) : null}
    </div>
  );
}
