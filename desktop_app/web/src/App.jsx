import React, { useEffect, useMemo, useRef, useState } from "react";
import SettingsPage from "./SettingsPage.jsx";
import AuditPage from "./AuditPage.jsx";
import { postJson as postJsonTo } from "./app/api.js";
import { PROMPT_PRESETS } from "./app/constants.js";
import { buildDisplayMessages, normalizeProject, projectLabel, saveSavedProjects } from "./app/utils.js";
import AppNavbar from "./components/AppNavbar.jsx";
import BootScreen from "./components/BootScreen.jsx";
import ComposerPanel from "./components/ComposerPanel.jsx";
import ConfirmDeleteChatDialog from "./components/ConfirmDeleteChatDialog.jsx";
import ConversationSection from "./components/ConversationSection.jsx";
import PairingRequestsBanner from "./components/PairingRequestsBanner.jsx";
import PlanCard from "./components/PlanCard.jsx";
import ProjectContextMenu from "./components/ProjectContextMenu.jsx";
import ProjectSidebar from "./components/ProjectSidebar.jsx";
import ResourceDashboard from "./components/ResourceDashboard.jsx";
import TerminalPanelSection from "./components/TerminalPanelSection.jsx";
import UpdateBanner from "./components/UpdateBanner.jsx";
import useBackendStatus from "./hooks/useBackendStatus.js";
import useBootSplash from "./hooks/useBootSplash.js";
import useChats from "./hooks/useChats.js";
import useDisplayPrefs from "./hooks/useDisplayPrefs.js";
import useMenus from "./hooks/useMenus.js";
import useModelGroups from "./hooks/useModelGroups.js";
import usePairingRequests from "./hooks/usePairingRequests.js";
import useProjects from "./hooks/useProjects.js";
import { useSettingsActions, useSettingsDrafts } from "./hooks/useSettings.js";
import useStreamingSend from "./hooks/useStreamingSend.js";
import useTerminal from "./hooks/useTerminal.js";
import useUpdateBanner from "./hooks/useUpdateBanner.js";

export default function App() {
  const scrollRef = useRef(null);
  const [backendUrl, setBackendUrl] = useState("");
  const [snapshot, setSnapshot] = useState(null);
  const [error, setError] = useState("");
  const [repoDraft, setRepoDraft] = useState("");
  const [currentScreen, setCurrentScreen] = useState("chat");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  const postJson = (path, payload) => postJsonTo(backendUrl, path, payload);

  const { updateBanner, dismissUpdateBanner } = useUpdateBanner();
  const displayPrefs = useDisplayPrefs();
  const { resolvedTheme, showResourceDashboard, uiPrefs } = displayPrefs;
  const boot = useBootSplash({ snapshot, error });

  const projects = useProjects({ backendUrl, snapshot });
  const { activeRepoRoot, fetchProjectChats, savedProjects, setSavedProjects, syncSavedProjects } = projects;

  const settingsDrafts = useSettingsDrafts({ snapshot });

  const { activeModelParent, modelGroups, modelGroupStates } = useModelGroups(snapshot);
  const menus = useMenus({ activeModelParent, modelGroups, modelGroupStates });
  const { closeAllMenus, projectMenuPath, setEditorMenuOpen, setHeaderMoreOpen, setProjectMenuPath } = menus;

  const pairing = usePairingRequests({ backendUrl, postJson, setError });

  const terminal = useTerminal({ backendUrl, snapshot, postJson, setError });
  const { terminalPanelOpen, terminalViewMode } = terminal;

  const streaming = useStreamingSend({
    backendUrl,
    snapshot,
    setSnapshot,
    setRepoDraft,
    setError,
    postJson,
    syncSavedProjects,
    fetchProjectChats,
    terminal,
  });
  const { activePendingTurn, pendingTurns, sendingChatIds, setDraft, setPendingTurns, setSendingChatIds } = streaming;

  // Memoised so the fallback [] keeps one identity between renders.
  const runningChatIds = useMemo(() => snapshot?.runningChatIds || [], [snapshot?.runningChatIds]);
  const interruptedRuns = useMemo(() => snapshot?.interruptedRuns || [], [snapshot?.interruptedRuns]);

  const { applyDesktopConfig, refreshStatus } = useBackendStatus({
    backendUrl,
    setBackendUrl,
    setSnapshot,
    setRepoDraft,
    setError,
    setRemoteAccessEnabledDraft: settingsDrafts.setRemoteAccessEnabledDraft,
    setRemoteAccessUrls: settingsDrafts.setRemoteAccessUrls,
    syncSavedProjects,
    fetchProjectChats,
    refreshPairingRequests: pairing.refreshPairingRequests,
    runningChatIds,
    sendingChatIds,
  });

  const interruptedRunByChat = useMemo(
    () =>
      new Map(
        interruptedRuns
          .filter((run) => run?.chatId)
          .map((run) => [run.chatId, run]),
      ),
    [interruptedRuns],
  );
  const activeInterruptedRun = useMemo(
    () => interruptedRunByChat.get(snapshot?.config?.activeChatId || "") || null,
    [interruptedRunByChat, snapshot?.config?.activeChatId],
  );
  const activeChatRunning = useMemo(
    () => runningChatIds.includes(snapshot?.config?.activeChatId || ""),
    [runningChatIds, snapshot?.config?.activeChatId],
  );

  const activeModelId = snapshot?.config?.model || "";
  const activeModelShort = activeModelId.replace(/^codex:|^gemini-cli:|^claude:|^hermes:/, "");
  const activePlan = snapshot?.activePlan || null;

  const displayMessages = useMemo(
    () => buildDisplayMessages(snapshot?.messages, activePendingTurn),
    [activePendingTurn, snapshot],
  );

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [displayMessages, pendingTurns]);

  const handleConfigUpdate = async (patch) => {
    setError("");
    try {
      const nextSnapshot = await postJson("/api/config", patch);
      setSnapshot(nextSnapshot);
      setRepoDraft(nextSnapshot.config.repoRoot);
      syncSavedProjects(nextSnapshot.config.repoRoot);
      void fetchProjectChats(nextSnapshot.config.repoRoot).catch(() => {});
      return nextSnapshot;
    } catch (nextError) {
      setError(String(nextError));
      throw nextError;
    }
  };

  const settingsActions = useSettingsActions({
    drafts: settingsDrafts,
    snapshot,
    setSnapshot,
    backendUrl,
    repoDraft,
    setRepoDraft,
    setError,
    postJson,
    handleConfigUpdate,
    applyDesktopConfig,
    refreshStatus,
    savedProjects,
    onCacheCleared: () => {
      setSavedProjects([]);
      projects.setProjectChats({});
      setPendingTurns({});
      setSendingChatIds([]);
      setCurrentScreen("chat");
    },
  });

  const chats = useChats({
    snapshot,
    setSnapshot,
    setRepoDraft,
    setError,
    postJson,
    activeRepoRoot,
    syncSavedProjects,
    fetchProjectChats,
    setProjectChats: projects.setProjectChats,
    setPendingTurns,
    setSendingChatIds,
    closeAllMenus,
  });

  const handleToolSafetyChange = async (toolSafetyMode) => {
    setError("");
    try {
      const nextSnapshot = await postJson("/api/chats/preferences", {
        chatId: snapshot?.config?.activeChatId || null,
        repoRoot: snapshot?.config?.repoRoot || "",
        toolSafetyMode,
      });
      setSnapshot(nextSnapshot);
      setRepoDraft(nextSnapshot.config.repoRoot);
    } catch (nextError) {
      setError(String(nextError));
    }
  };

  const handlePromptPresetChange = async (promptPreset) => {
    await handleConfigUpdate({ promptPreset });
  };

  const handleOpenInEditor = async (editorId) => {
    const repoRoot = snapshot?.config?.repoRoot || "";
    if (!repoRoot) {
      setError("Select a project folder first.");
      setEditorMenuOpen(false);
      return;
    }
    setError("");
    try {
      await window.desktopApi?.openInEditor?.(editorId, repoRoot);
      setEditorMenuOpen(false);
    } catch (nextError) {
      setError(String(nextError));
      setEditorMenuOpen(false);
    }
  };

  const copyText = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch (nextError) {
      setError(String(nextError));
    }
  };

  const handleOpenLocalFile = async (filePath) => {
    setError("");
    try {
      await window.desktopApi?.openFile?.(filePath);
    } catch (nextError) {
      setError(String(nextError));
    }
  };

  const handleContinueWithPlan = async () => {
    if (!activePlan) {
      return;
    }
    const prompt = [
      `Continue by executing the approved plan from: ${activePlan.path}`,
      "",
      activePlan.content,
    ].join("\n");
    setDraft(prompt);
    if ((snapshot?.config?.promptPreset || "") !== "code") {
      await handleConfigUpdate({ promptPreset: "code" });
    }
  };

  const handleCopyWorkspacePath = async (repoRoot = snapshot?.config?.repoRoot || "") => {
    const normalizedRepoRoot = normalizeProject(repoRoot);
    if (!normalizedRepoRoot) {
      return;
    }
    setProjectMenuPath("");
    setHeaderMoreOpen(false);
    await copyText(normalizedRepoRoot, "Workspace path copied");
  };

  const handlePickRepo = async () => {
    const picked = await window.desktopApi?.pickRepoDirectory?.();
    if (!picked) return;
    setProjectMenuPath("");
    setRepoDraft(picked);
    syncSavedProjects(picked);
    await handleConfigUpdate({ repoRoot: picked });
  };

  const handleOpenSavedProject = async (repoRoot) => {
    if (!repoRoot || repoRoot === snapshot?.config?.repoRoot) {
      setProjectMenuPath("");
      return;
    }
    setProjectMenuPath("");
    setRepoDraft(repoRoot);
    await handleConfigUpdate({ repoRoot });
  };

  const handleRemoveSavedProject = async (repoRoot) => {
    const nextProjects = savedProjects.filter((project) => project.path !== repoRoot);
    saveSavedProjects(nextProjects);
    setSavedProjects(nextProjects);
    setProjectMenuPath("");

    if (repoRoot === snapshot?.config?.repoRoot && nextProjects.length > 0) {
      await handleConfigUpdate({ repoRoot: nextProjects[0].path });
    }
  };

  if (!snapshot) {
    return (
      <BootScreen
        appVersion={boot.appVersion}
        bootHeadline={boot.bootHeadline}
        bootMessage={boot.bootMessage}
        bootStatusText={boot.bootStatusText}
        error={error}
        snapshot={snapshot}
      />
    );
  }

  if (currentScreen === "settings") {
    return (
      <SettingsPage
        error={error}
        networkSettingsSaving={settingsDrafts.networkSettingsSaving}
        onBack={() => setCurrentScreen("chat")}
        onSave={settingsActions.handleSaveSettings}
        repoDraft={repoDraft}
        setRepoDraft={setRepoDraft}
        onPickRepo={handlePickRepo}
        promptPresets={PROMPT_PRESETS}
        settingsPromptPreset={settingsDrafts.settingsPromptPreset}
        setSettingsPromptPreset={settingsDrafts.setSettingsPromptPreset}
        assistantMemoryDraft={settingsDrafts.assistantMemoryDraft}
        setAssistantMemoryDraft={settingsDrafts.setAssistantMemoryDraft}
        contextCarryMessagesDraft={settingsDrafts.contextCarryMessagesDraft}
        setContextCarryMessagesDraft={settingsDrafts.setContextCarryMessagesDraft}
        themeMode={displayPrefs.themeMode}
        setThemeMode={displayPrefs.setThemeMode}
        resolvedTheme={resolvedTheme}
        showResourceDashboard={showResourceDashboard}
        setShowResourceDashboard={displayPrefs.setShowResourceDashboard}
        uiPrefs={uiPrefs}
        updateUiPref={displayPrefs.updateUiPref}
        onRestoreDisplayDefaults={displayPrefs.restoreDisplayDefaults}
        remoteAccessEnabledDraft={settingsDrafts.remoteAccessEnabledDraft}
        setRemoteAccessEnabledDraft={settingsDrafts.setRemoteAccessEnabledDraft}
        remoteAccessUrls={settingsDrafts.remoteAccessUrls}
        providers={snapshot.providers}
        providerTestState={settingsDrafts.providerTestState}
        onTestProvider={settingsActions.handleTestProvider}
        showClearCacheConfirm={settingsDrafts.showClearCacheConfirm}
        setShowClearCacheConfirm={settingsDrafts.setShowClearCacheConfirm}
        onClearCache={settingsActions.handleClearCache}
        showDeleteSettingsConfirm={settingsDrafts.showDeleteSettingsConfirm}
        setShowDeleteSettingsConfirm={settingsDrafts.setShowDeleteSettingsConfirm}
        onDeleteSettingsFile={settingsActions.handleDeleteSettingsFile}
        configPath={snapshot?.config?.configPath || ""}
        backendUrl={backendUrl}
      />
    );
  }

  if (currentScreen === "audit") {
    return (
      <AuditPage
        backendUrl={backendUrl}
        repoRoot={snapshot.config.repoRoot}
        onBack={() => setCurrentScreen("chat")}
      />
    );
  }

  const workspaceShellStyle = {
    ...(updateBanner ? { paddingTop: 40 } : {}),
    ...(resolvedTheme === "light" ? { "--sidebar-bg": "#f8f8f8" } : {}),
  };

  return (
    <>
      <UpdateBanner updateBanner={updateBanner} onDismiss={dismissUpdateBanner} />
      <div
        className={`workspace-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}
        data-theme={resolvedTheme}
        style={workspaceShellStyle}
        onClick={closeAllMenus}
      >
        <AppNavbar
          snapshot={snapshot}
          activeModelId={activeModelId}
          activeModelShort={activeModelShort}
          activeChatRunning={activeChatRunning}
          sidebarCollapsed={sidebarCollapsed}
          setSidebarCollapsed={setSidebarCollapsed}
          headerInfoOpen={menus.headerInfoOpen}
          setHeaderInfoOpen={menus.setHeaderInfoOpen}
          headerMoreOpen={menus.headerMoreOpen}
          setHeaderMoreOpen={setHeaderMoreOpen}
          editorMenuOpen={menus.editorMenuOpen}
          setEditorMenuOpen={setEditorMenuOpen}
          terminalPanelOpen={terminalPanelOpen}
          setCurrentScreen={setCurrentScreen}
          handlePickRepo={handlePickRepo}
          handleActivateChat={chats.handleActivateChat}
          handleToggleTerminal={terminal.handleToggleTerminal}
          handleOpenInEditor={handleOpenInEditor}
          handleNewChat={chats.handleNewChat}
          handleInterruptChat={streaming.handleInterruptChat}
          handleCopyWorkspacePath={handleCopyWorkspacePath}
        />

        <div className="workspace-body">
        <ProjectSidebar
          snapshot={snapshot}
          activeRepoRoot={activeRepoRoot}
          savedProjects={savedProjects}
          expandedRepos={projects.expandedRepos}
          toggleRepo={projects.toggleRepo}
          chatsForProject={projects.chatsForProject}
          runningChatIds={runningChatIds}
          sendingChatIds={sendingChatIds}
          uiPrefs={uiPrefs}
          renamingChat={chats.renamingChat}
          renameChatDraft={chats.renameChatDraft}
          setRenameChatDraft={chats.setRenameChatDraft}
          setConfirmDeleteChat={chats.setConfirmDeleteChat}
          handleOpenMenu={menus.handleOpenMenu}
          handleNewChat={chats.handleNewChat}
          handleActivateChat={chats.handleActivateChat}
          handleStartRenameChat={chats.handleStartRenameChat}
          handleSubmitRenameChat={chats.handleSubmitRenameChat}
          handleCancelRenameChat={chats.handleCancelRenameChat}
          handleDeleteChat={chats.handleDeleteChat}
        />

        <main className="chat-area">

          <div className="chat-main">
          {error && <div className="error-banner">{error}</div>}
          {pairing.pendingPairingDevices.length > 0 && (
            <PairingRequestsBanner
              pendingPairingDevices={pairing.pendingPairingDevices}
              pairingActionLoading={pairing.pairingActionLoading}
              handleApprovePairingDevice={pairing.handleApprovePairingDevice}
              handleRejectPairingDevice={pairing.handleRejectPairingDevice}
            />
          )}
          {!error && activeInterruptedRun && (
            <div className="recovery-banner">
              Previous response was interrupted. Continue from the last saved turn.
            </div>
          )}
          <TerminalPanelSection
            activeTerminalChatId={terminal.activeTerminalChatId}
            backendUrl={backendUrl}
            liveTermWriteRef={terminal.liveTermWriteRef}
            onClose={terminal.handleCloseTerminal}
            onRefresh={() => terminal.refreshTerminal().catch((nextError) => setError(String(nextError)))}
            onRunCommand={terminal.handleSendTerminalCommand}
            onSwitchToLive={terminal.handleSwitchToLive}
            onToggle={terminal.handleToggleTerminal}
            repoRoot={snapshot.config.repoRoot || ""}
            setTerminalDraft={terminal.setTerminalDraft}
            setTerminalViewMode={terminal.setTerminalViewMode}
            terminalDraft={terminal.terminalDraft}
            terminalOutputRef={terminal.terminalOutputRef}
            terminalPanelOpen={terminalPanelOpen}
            terminalSnapshot={terminal.terminalSnapshot}
            terminalViewMode={terminalViewMode}
          />
          {activePlan && (
            <PlanCard
              activePlan={activePlan}
              copyText={copyText}
              handleOpenLocalFile={handleOpenLocalFile}
              handleContinueWithPlan={handleContinueWithPlan}
            />
          )}

          {showResourceDashboard && (
            <ResourceDashboard resources={snapshot.resources} chats={snapshot.chats || []} />
          )}

          <ConversationSection
            activePendingTurn={activePendingTurn}
            copyText={copyText}
            displayMessages={displayMessages}
            onPickStarter={(prompt) => {
              setDraft(prompt);
              window.requestAnimationFrame(() => document.querySelector(".composer-panel textarea")?.focus());
            }}
            projectName={snapshot.config.repoRoot ? projectLabel(snapshot.config.repoRoot) : ""}
            scrollRef={scrollRef}
          />
          </div>{/* chat-main */}

          <ComposerPanel
            activeModelParent={activeModelParent}
            draft={streaming.draft}
            hoveredModelGroup={menus.hoveredModelGroup}
            hoveredModelSubGroup={menus.hoveredModelSubGroup}
            modelGroups={modelGroups}
            modelGroupStates={modelGroupStates}
            modelMenuOpen={menus.modelMenuOpen}
            modelMenuPos={menus.modelMenuPos}
            modelPickerRef={menus.modelPickerRef}
            onChangeDraft={setDraft}
            onChooseModel={(modelId) => {
              menus.setModelMenuOpen(false);
              menus.setHoveredModelGroup("");
              menus.setHoveredModelSubGroup("");
              void handleConfigUpdate({ model: modelId });
            }}
            onHoverGroup={(g) => { menus.setHoveredModelGroup(g); menus.setHoveredModelSubGroup(""); }}
            onHoverSubGroup={menus.setHoveredModelSubGroup}
            onPromptPresetChange={handlePromptPresetChange}
            onSend={streaming.handleSend}
            onStop={streaming.handleInterruptChat}
            running={terminalViewMode === "chat" && activeChatRunning}
            enterToSend={uiPrefs.enterToSend}
            onToggleModelMenu={menus.toggleModelMenu}
            onToolSafetyChange={handleToolSafetyChange}
            promptPreset={snapshot.config.promptPreset}
            selectedModelId={snapshot.config.model}
            sendingDisabled={terminalViewMode === "chat" && Boolean(snapshot.config.activeChatId) && sendingChatIds.includes(snapshot.config.activeChatId)}
            terminalPanelOpen={terminalPanelOpen}
            terminalViewMode={terminalViewMode}
            toolSafetyMode={snapshot.config.toolSafetyMode}
          />
        </main>
        </div>{/* workspace-body */}
      </div>

      {projectMenuPath && (
        <ProjectContextMenu
          left={menus.projectMenuPos.left}
          onCopyPath={() => {
            void handleCopyWorkspacePath(projectMenuPath);
          }}
          onOpenFolder={() => {
            void handleOpenSavedProject(projectMenuPath);
            setProjectMenuPath("");
          }}
          onRemove={() => {
            void handleRemoveSavedProject(projectMenuPath);
            setProjectMenuPath("");
          }}
          top={menus.projectMenuPos.top}
        />
      )}

      {chats.confirmDeleteChat && (
        <ConfirmDeleteChatDialog
          confirmDeleteChat={chats.confirmDeleteChat}
          setConfirmDeleteChat={chats.setConfirmDeleteChat}
          handleDeleteChat={chats.handleDeleteChat}
        />
      )}

      {boot.splashVisible && (
        <BootScreen
          appVersion={boot.appVersion}
          bootDismissed={boot.bootDismissed}
          bootHeadline={boot.bootHeadline}
          bootMessage={boot.bootMessage}
          bootStatusText={boot.bootStatusText}
          error={error}
          overlay
          snapshot={snapshot}
          workspaceLabel={snapshot?.config?.repoRoot ? projectLabel(snapshot.config.repoRoot) : "PENDING"}
        />
      )}
    </>
  );
}
