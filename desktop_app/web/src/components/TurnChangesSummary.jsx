import { FileDiff } from "lucide-react";

// Compact "N files changed +X −Y" line under an assistant message whose turn
// changed files. Clicking opens that turn in the diff panel.
export default function TurnChangesSummary({ turn, active, onOpen }) {
  if (!turn?.id || !turn.files) return null;
  const label = turn.files === 1 ? "1 file changed" : `${turn.files} files changed`;
  const revertedLabel = turn.reverted === "all" ? "Reverted" : turn.reverted === "partial" ? "Partly reverted" : "";
  return (
    <button
      type="button"
      className={`turn-changes-summary${active ? " active" : ""}`}
      onClick={() => onOpen?.(turn.id)}
      title="Show what this turn changed"
    >
      <FileDiff size={14} aria-hidden="true" />
      <span>{label}</span>
      <span className="turn-changes-add">+{turn.additions || 0}</span>
      <span className="turn-changes-del">−{turn.deletions || 0}</span>
      {revertedLabel && <span className="turn-changes-reverted">{revertedLabel}</span>}
    </button>
  );
}
