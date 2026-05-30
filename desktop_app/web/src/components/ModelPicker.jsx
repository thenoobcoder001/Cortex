import { createPortal } from "react-dom";

export default function ModelPicker({
  activeModelParent,
  hoveredModelGroup,
  hoveredModelSubGroup,
  modelGroupStates,
  modelGroups,
  modelMenuOpen,
  modelMenuPos,
  modelPickerRef,
  onChooseModel,
  onHoverGroup,
  onHoverSubGroup,
  onToggle,
  selectedModelId,
}) {
  // Get models for the currently hovered group
  const activeGroupModels = (
    modelGroups.find(([group]) => group === hoveredModelGroup) ||
    modelGroups.find(([group]) => modelGroupStates.get(group)?.connected) ||
    [null, []]
  )[1];

  // Detect if this group has sub-groups (e.g. Codex with gpt-5.5, gpt-5.4…)
  const hasSubGroups = activeGroupModels.some((m) => m.subGroup);

  // Unique sub-group names in order
  const subGroups = hasSubGroups
    ? [...new Set(activeGroupModels.map((m) => m.subGroup).filter(Boolean))]
    : [];

  // Models for the currently hovered sub-group (effort levels)
  const activeSubGroupModels = hasSubGroups
    ? activeGroupModels.filter((m) => m.subGroup === (hoveredModelSubGroup || subGroups[0]))
    : activeGroupModels;

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
            {/* Level 1 — provider groups */}
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
                    onMouseEnter={() => { onHoverGroup(group); onHoverSubGroup(""); }}
                    onFocus={() => { onHoverGroup(group); onHoverSubGroup(""); }}
                    title={
                      modelGroupStates.get(group)?.connected ? group : `${group} is not ready`
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

            {/* Level 2 — model names (sub-groups) or direct models */}
            <div
              className="model-submenu-flyout"
              onClick={(event) => event.stopPropagation()}
              style={{ position: "fixed", bottom: modelMenuPos.bottom, left: modelMenuPos.left + 188, top: "auto" }}
            >
              <div className="model-submenu">
                {hasSubGroups ? (
                  subGroups.map((sub) => (
                    <button
                      key={sub}
                      type="button"
                      className={
                        (hoveredModelSubGroup || subGroups[0]) === sub
                          ? "model-subitem active"
                          : "model-subitem"
                      }
                      onMouseEnter={() => onHoverSubGroup(sub)}
                      onFocus={() => onHoverSubGroup(sub)}
                      title={sub}
                    >
                      <span className="model-subitem-name">{sub}</span>
                      <span className="model-subitem-arrow">{">"}</span>
                    </button>
                  ))
                ) : (
                  activeGroupModels.map((model) => (
                    <button
                      key={model.id}
                      type="button"
                      className={selectedModelId === model.id ? "model-subitem active" : "model-subitem"}
                      title={model.label}
                      onClick={() => onChooseModel(model.id)}
                    >
                      <span className="model-subitem-name">{model.id.replace(/^codex:|^gemini-cli:|^agy:|^claude:/, "")}</span>
                      <span className="model-subitem-meta">{model.label}</span>
                    </button>
                  ))
                )}
              </div>
            </div>

            {/* Level 3 — effort levels (only when group has sub-groups) */}
            {hasSubGroups && (
              <div
                className="model-submenu-flyout"
                onClick={(event) => event.stopPropagation()}
                style={{ position: "fixed", bottom: modelMenuPos.bottom, left: modelMenuPos.left + 376, top: "auto" }}
              >
                <div className="model-submenu">
                  {activeSubGroupModels.map((model) => {
                    const effortLabel = model.label.split("·")[1]?.trim() || model.label;
                    return (
                      <button
                        key={model.id}
                        type="button"
                        className={selectedModelId === model.id ? "model-subitem active" : "model-subitem"}
                        title={model.label}
                        onClick={() => onChooseModel(model.id)}
                      >
                        <span className="model-subitem-name">{effortLabel}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </>,
          document.body,
        )}
    </div>
  );
}
