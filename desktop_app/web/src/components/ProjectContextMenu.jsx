export default function ProjectContextMenu({
  left,
  onCopyPath,
  onOpenFolder,
  onRemove,
  top,
}) {
  return (
    <div
      className="project-menu fixed-menu"
      style={{
        position: "fixed",
        top: `${top}px`,
        left: `${left}px`,
      }}
      onClick={(event) => event.stopPropagation()}
    >
      <button type="button" onClick={onOpenFolder}>
        Open folder
      </button>
      <button type="button" onClick={onCopyPath}>
        Copy path
      </button>
      <button type="button" className="danger-action" onClick={onRemove}>
        Remove from list
      </button>
    </div>
  );
}
