import { useEffect, useState } from "react";
import { DEFAULT_UI_PREFS } from "../app/constants.js";
import {
  loadShowResourceDashboard,
  loadThemeMode,
  loadUiPrefs,
  saveShowResourceDashboard,
  saveThemeMode,
  saveUiPrefs,
} from "../app/utils.js";

// Theme, resource dashboard toggle and UI prefs, persisted to localStorage.
export default function useDisplayPrefs() {
  const [themeMode, setThemeMode] = useState(() => loadThemeMode());
  const [showResourceDashboard, setShowResourceDashboard] = useState(() => loadShowResourceDashboard());
  const [uiPrefs, setUiPrefs] = useState(() => loadUiPrefs());
  const [systemPrefersDark, setSystemPrefersDark] = useState(() =>
    window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)").matches : true,
  );

  const resolvedTheme = themeMode === "system" ? (systemPrefersDark ? "dark" : "light") : themeMode;

  useEffect(() => {
    if (!window.matchMedia) {
      return undefined;
    }
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = (event) => {
      setSystemPrefersDark(event.matches);
    };
    setSystemPrefersDark(mediaQuery.matches);
    if (mediaQuery.addEventListener) {
      mediaQuery.addEventListener("change", handleChange);
      return () => mediaQuery.removeEventListener("change", handleChange);
    }
    mediaQuery.addListener(handleChange);
    return () => mediaQuery.removeListener(handleChange);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme;
    document.documentElement.style.colorScheme = resolvedTheme;
    saveThemeMode(themeMode);
  }, [resolvedTheme, themeMode]);

  useEffect(() => {
    saveShowResourceDashboard(showResourceDashboard);
  }, [showResourceDashboard]);

  useEffect(() => {
    saveUiPrefs(uiPrefs);
    document.documentElement.dataset.codeWrap = uiPrefs.codeWrap ? "on" : "off";
  }, [uiPrefs]);

  const updateUiPref = (patch) => setUiPrefs((prev) => ({ ...prev, ...patch }));
  const restoreDisplayDefaults = () => {
    setThemeMode("dark");
    setShowResourceDashboard(false);
    setUiPrefs({ ...DEFAULT_UI_PREFS });
  };

  return {
    themeMode,
    setThemeMode,
    resolvedTheme,
    showResourceDashboard,
    setShowResourceDashboard,
    uiPrefs,
    updateUiPref,
    restoreDisplayDefaults,
  };
}
