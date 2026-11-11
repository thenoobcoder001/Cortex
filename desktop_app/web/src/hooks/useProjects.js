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
    savedProjects,
    setProjectChats,
    setSavedProjects,
    syncSavedProjects,
    toggleRepo,
  };
}
