import { PROMPT_PRESETS, TOOL_SAFETY_OPTIONS } from "../app/constants.js";
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
  enterToSend = true,
  onToggleModelMenu,
  onToolSafetyChange,
  sendingDisabled,
  selectedModelId,
  terminalPanelOpen,
  terminalViewMode,
  toolSafetyMode,
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
            value={toolSafetyMode || "write"}
            onChange={(event) => void onToolSafetyChange(event.target.value)}
            title="Chat permissions"
          >
            {TOOL_SAFETY_OPTIONS.map((option) => (
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
        <button
          type="button"
          className="primary-button"
          onClick={onSend}
          disabled={sendingDisabled}
        >
          {terminalViewMode === "live" && terminalPanelOpen ? "Run" : "Send"}
        </button>
      </div>
    </div>
  );
}
