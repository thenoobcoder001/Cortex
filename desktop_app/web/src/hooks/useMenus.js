import { useRef, useState } from "react";

// Open/closed state and position for the app's popup menus: the project
// context menu, the composer model picker, and the navbar dropdowns.
export default function useMenus({ activeModelParent, modelGroups, modelGroupStates }) {
  const modelPickerRef = useRef(null);
  const [projectMenuPath, setProjectMenuPath] = useState("");
  const [projectMenuPos, setProjectMenuPos] = useState({ top: 0, left: 0 });
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [modelMenuPos, setModelMenuPos] = useState({ bottom: 0, left: 0 });
  const [hoveredModelGroup, setHoveredModelGroup] = useState("");
  const [hoveredModelSubGroup, setHoveredModelSubGroup] = useState("");
  const [editorMenuOpen, setEditorMenuOpen] = useState(false);
  const [headerMoreOpen, setHeaderMoreOpen] = useState(false);
  const [headerInfoOpen, setHeaderInfoOpen] = useState(false);

  const closeAllMenus = () => {
    setProjectMenuPath("");
    setModelMenuOpen(false);
    setEditorMenuOpen(false);
    setHeaderMoreOpen(false);
    setHeaderInfoOpen(false);
  };

  const handleOpenMenu = (event, path) => {
    event.stopPropagation();
    setEditorMenuOpen(false);
    setHeaderMoreOpen(false);
    const rect = event.currentTarget.getBoundingClientRect();
    if (projectMenuPath === path) {
      setProjectMenuPath("");
    } else {
      setProjectMenuPath(path);
      setProjectMenuPos({ top: rect.bottom + 8, left: rect.left - 130 });
    }
  };

  const toggleModelMenu = (event) => {
    event.stopPropagation();
    setEditorMenuOpen(false);
    setHeaderMoreOpen(false);
    if (!modelGroups.length) {
      return;
    }
    const nextOpen = !modelMenuOpen;
    setModelMenuOpen(nextOpen);
    if (!nextOpen) {
      setHoveredModelGroup("");
      return;
    }
    if (modelPickerRef.current) {
      const rect = modelPickerRef.current.getBoundingClientRect();
      setModelMenuPos({ bottom: window.innerHeight - rect.top + 8, left: rect.left });
    }
    const preferredGroup = modelGroupStates.get(activeModelParent)?.connected
      ? activeModelParent
      : modelGroups.find(([group]) => modelGroupStates.get(group)?.connected)?.[0] || activeModelParent;
    setHoveredModelGroup(preferredGroup);
  };

  return {
    closeAllMenus,
    editorMenuOpen,
    handleOpenMenu,
    headerInfoOpen,
    headerMoreOpen,
    hoveredModelGroup,
    hoveredModelSubGroup,
    modelMenuOpen,
    modelMenuPos,
    modelPickerRef,
    projectMenuPath,
    projectMenuPos,
    setEditorMenuOpen,
    setHeaderInfoOpen,
    setHeaderMoreOpen,
    setHoveredModelGroup,
    setHoveredModelSubGroup,
    setModelMenuOpen,
    setProjectMenuPath,
    toggleModelMenu,
  };
}
