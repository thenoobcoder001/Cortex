import { useEffect, useState } from "react";
import { loadSavedProjects, normalizeProject, saveSavedProjects, upsertProject } from "../app/utils.js";

// Saved projects in the sidebar, which ones are expanded, and the chat list
// cached for each project that is not the active one.
export default function useProjects({ backendUrl, snapshot }) {
  const [savedProjects, setSavedProjects] = useState(() => loadSavedProjects());
  const [projectChats, setProjectChats] = useState({});
  const [expandedRepos, setExpandedRepos] = useState(() => new Set());

  const activeRepoRoot = normalizeProject(snapshot?.config?.repoRoot || "");

  useEffect(() => {
    if (!activeRepoRoot || !snapshot?.chats) {
      return;
    }
    setProjectChats((current) => ({
      ...current,
      [activeRepoRoot]: snapshot.chats,
    }));
  }, [activeRepoRoot, snapshot?.chats]);

  useEffect(() => {
    if (snapshot?.config?.repoRoot) {
      setExpandedRepos((prev) => new Set([...prev, snapshot.config.repoRoot]));
    }
  }, [snapshot?.config?.repoRoot]);

  const toggleRepo = (repoPath) => {
    setExpandedRepos((prev) => {
      const next = new Set(prev);
      if (next.has(repoPath)) {
        next.delete(repoPath);
      } else {
        next.add(repoPath);
      }
      return next;
    });
  };

  const syncSavedProjects = (repoRoot) => {
    setSavedProjects((current) => {
      const nextProjects = upsertProject(current, repoRoot);
      saveSavedProjects(nextProjects);
      return nextProjects;
    });
  };

  const fetchProjectChats = async (repoRoot, urlOverride) => {
    const normalizedRepoRoot = normalizeProject(repoRoot);
    const targetUrl = urlOverride || backendUrl;
    if (!normalizedRepoRoot || !targetUrl) {
      return [];
    }
    const response = await fetch(
      `${targetUrl}/api/chats?repoRoot=${encodeURIComponent(normalizedRepoRoot)}`,
    );
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.detail || `Chat list request failed (${response.status})`);
    }
    const chats = Array.isArray(data.chats) ? data.chats : [];
    setProjectChats((current) => ({
      ...current,
      [normalizedRepoRoot]: chats,
    }));
    return chats;
  };

  useEffect(() => {
    if (!backendUrl) {
      return;
    }
    const expandedProjectPaths = savedProjects
      .map((project) => normalizeProject(project.path))
      .filter((path) => expandedRepos.has(path));
    expandedProjectPaths.forEach((repoRoot) => {
      if (repoRoot !== activeRepoRoot && !projectChats[repoRoot]) {
        void fetchProjectChats(repoRoot).catch(() => {});
      }
    });
  // fetchProjectChats is recreated each render; the listed state is what should trigger a fetch.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRepoRoot, backendUrl, expandedRepos, projectChats, savedProjects]);

  // Saved projects whose folder is gone (moved, renamed, deleted). They stay
  // in the list, marked, until the person removes them. Rechecked when the
  // list changes and when the window regains focus.
  const [missingProjects, setMissingProjects] = useState(() => new Set());
  const projectPathsKey = savedProjects.map((project) => project.path).join("\n");
  useEffect(() => {
    if (!backendUrl || !projectPathsKey) {
      setMissingProjects(new Set());
      return undefined;
    }
    let cancelled = false;
    const check = async () => {
      try {
        const response = await fetch(`${backendUrl}/api/projects/exists`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ paths: projectPathsKey.split("\n") }),
        });
        if (!response.ok) return;
        const data = await response.json();
        if (cancelled) return;
        const missing = Object.entries(data.exists || {}).filter(([, exists]) => !exists).map(([path]) => path);
        setMissingProjects(new Set(missing));
      } catch {
        // Backend unreachable: say nothing rather than mark everything missing.
      }
    };
    void check();
    window.addEventListener("focus", check);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", check);
    };
  }, [backendUrl, projectPathsKey]);

  const chatsForProject = (repoRoot) => {
    const projectPath = normalizeProject(repoRoot);
    if (projectPath === activeRepoRoot) {
      return snapshot?.chats || [];
    }
    return projectChats[projectPath] || [];
  };

  return {
    activeRepoRoot,
    chatsForProject,
    expandedRepos,
    fetchProjectChats,
    missingProjects,
    savedProjects,
    setProjectChats,
    setSavedProjects,
    syncSavedProjects,
    toggleRepo,
  };
}
