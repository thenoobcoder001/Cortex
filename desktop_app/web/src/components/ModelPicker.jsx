import { createPortal } from "react-dom";

export default function ModelPicker({
  activeModelParent,
  hoveredModelGroup,
  modelGroupStates,
  modelGroups,
  modelMenuOpen,
  modelMenuPos,
  modelPickerRef,
  onChooseModel,
  onHoverGroup,
  onToggle,
  selectedModelId,
}) {
  return (
    <div className="model-picker">
      <button
        ref={modelPickerRef}
        type="button"
        className="model-picker-trigger"
        title={selectedModelId}
        onClick={onToggle}
      >
        <span>{activeModelParent}</span>
        <span className={modelMenuOpen ? "model-picker-caret open" : "model-picker-caret"}>{">"}</span>
      </button>
      {modelMenuOpen &&
        createPortal(
          <>
            <div
              className="model-picker-menu"
              onClick={(event) => event.stopPropagation()}
              style={{ position: "fixed", bottom: modelMenuPos.bottom, left: modelMenuPos.left, top: "auto" }}
            >
              <div className="model-group-list">
                {modelGroups.map(([group]) => (
                  <button
                    key={group}
                    type="button"
                    className={
                      !modelGroupStates.get(group)?.connected
                        ? "model-group-item disabled"
                        : hoveredModelGroup === group
                          ? "model-group-item active"
                          : "model-group-item"
                    }
                    disabled={!modelGroupStates.get(group)?.connected}
                    onMouseEnter={() => onHoverGroup(group)}
                    onFocus={() => onHoverGroup(group)}
                    title={
                      modelGroupStates.get(group)?.connected
                        ? group
                        : `${group} is not ready`
                    }
                  >
                    <span>{group}</span>
                    <span className="model-group-arrow">
                      {modelGroupStates.get(group)?.connected ? ">" : "!"}
                    </span>
                  </button>
                ))}
              </div>
            </div>
            <div
              className="model-submenu-flyout"
              onClick={(event) => event.stopPropagation()}
              style={{ position: "fixed", bottom: modelMenuPos.bottom, left: modelMenuPos.left + 188, top: "auto" }}
            >
              <div className="model-submenu">
                {(
                  modelGroups.find(([group]) => group === hoveredModelGroup) ||
                  modelGroups.find(([group]) => modelGroupStates.get(group)?.connected) ||
                  [null, []]
                )[1].map((model) => (
                  <button
                    key={model.id}
                    type="button"
                    className={selectedModelId === model.id ? "model-subitem active" : "model-subitem"}
                    title={model.label}
                    onClick={() => onChooseModel(model.id)}
                  >
                    <span className="model-subitem-name">{model.id.replace(/^codex:|^gemini-cli:/, "")}</span>
                    <span className="model-subitem-meta">{model.label}</span>
                  </button>
                ))}
              </div>
            </div>
          </>,
          document.body,
        )}
    </div>
  );
}
