// Card showing the active plan file with copy / open / continue actions.
export default function PlanCard({
  activePlan,
  copyText,
  handleOpenLocalFile,
  handleContinueWithPlan,
}) {
  return (
    <section className="plan-card">
      <div className="plan-card-header">
        <div>
          <div className="plan-card-label">Plan</div>
          <div className="plan-card-title">{activePlan.title || "Implementation Plan"}</div>
        </div>
        <div className="plan-card-actions">
          <button type="button" className="secondary-button" onClick={() => void copyText(activePlan.content || "", "Plan copied")}>
            Copy
          </button>
          <button type="button" className="secondary-button" onClick={() => void handleOpenLocalFile(activePlan.path)}>
            Open file
          </button>
          <button type="button" className="secondary-button" onClick={() => void handleContinueWithPlan()}>
            Continue with plan
          </button>
        </div>
      </div>
      <div className="plan-card-path">{activePlan.path}</div>
      <pre className="plan-card-preview">{String(activePlan.content || "")}</pre>
    </section>
  );
}
