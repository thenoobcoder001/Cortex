import { useMemo } from "react";
import { groupedModels, parentModelLabel, providerStateForGroup } from "../app/utils.js";

// Models from the snapshot grouped by provider, with each group's connection state.
export default function useModelGroups(snapshot) {
  const modelGroups = useMemo(() => groupedModels(snapshot?.models || []), [snapshot]);
  const modelGroupStates = useMemo(
    () =>
      new Map(
        modelGroups.map(([group]) => [group, providerStateForGroup(group, snapshot?.providers || {})]),
      ),
    [modelGroups, snapshot?.providers],
  );
  const activeModelParent = useMemo(
    () => parentModelLabel(snapshot?.config?.model || "", modelGroups),
    [modelGroups, snapshot?.config?.model],
  );
  return { activeModelParent, modelGroups, modelGroupStates };
}
