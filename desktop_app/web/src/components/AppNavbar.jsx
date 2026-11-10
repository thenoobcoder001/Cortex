import {
  ChevronDown,
  FolderPlus,
  Info,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Settings as SettingsIcon,
  ShieldCheck,
  SquarePen,
  SquareTerminal,
} from "lucide-react";
import { EXTERNAL_EDITOR_OPTIONS } from "../app/constants.js";
import { projectLabel } from "../app/utils.js";
import EditorIcon from "./EditorIcon.jsx";

// Top bar: sidebar toggle, chat switcher, model/provider badges, and the Terminal / Open in / Audit / Settings / New chat actions.
export default function AppNavbar({
  snapshot,
  activeModelId,
  activeModelShort,
  activeChatRunning,
  sidebarCollapsed,
  setSidebarCollapsed,
  headerInfoOpen,
  setHeaderInfoOpen,
  headerMoreOpen,
  setHeaderMoreOpen,
  editorMenuOpen,
  setEditorMenuOpen,
  terminalPanelOpen,
  setCurrentScreen,
  handlePickRepo,
  handleActivateChat,
  handleToggleTerminal,
  handleOpenInEditor,
  handleNewChat,
  handleInterruptChat,
  handleCopyWorkspacePath,
}) {
  return (
    <div className="app-navbar">
      <div className="app-navbar-brand">
        <span className="sidebar-brand">Cortex</span>
        <button type="button" className="icon-button" onClick={handlePickRepo} title="Add project" aria-label="Add project">
          <FolderPlus size={18} className="ui-icon" />
        </button>
      </div>
      <div className="app-navbar-main">
        <div className="topbar-left">
          <button
            type="button"
            className="sidebar-toggle-btn"
            onClick={(event) => {
              event.stopPropagation();
              setSidebarCollapsed((prev) => !prev);
            }}
            title={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
            aria-label={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
          >
            {sidebarCollapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
          </button>
          <select
            className="header-thread-select"
            value={snapshot.config.activeChatId || ""}
            onChange={(event) => {
              if (event.target.value) {
                void handleActivateChat(event.target.value);
              }
            }}
          >
            <option value="">New chat</option>
            {snapshot.chats.map((chat) => (
              <option key={chat.chatId} value={chat.chatId}>
                {chat.title}
              </option>
            ))}
          </select>
          <span className="project-badge">{projectLabel(snapshot.config.repoRoot)}</span>
          <span className="provider-badge">{snapshot.providerName}</span>
          <span className="model-badge" title={activeModelId}>{activeModelShort}</span>

          <div className="header-info-wrap" onClick={(event) => event.stopPropagation()}>
            <button
              type="button"
              className="header-info-trigger"
              onClick={() => {
                setHeaderMoreOpen(false);
                setHeaderInfoOpen((current) => !current);
              }}
              title="Context info"
              aria-label="Context info"
            >
              <Info size={16} />
            </button>
            {headerInfoOpen && (
              <div className="header-menu header-info-menu">
                <div className="info-section">
                  <div className="info-label">Project</div>
                  <div className="info-value">{snapshot.config.repoRoot}</div>
                </div>
                <div className="info-section">
                  <div className="info-label">Provider</div>
                  <div className="info-value">{snapshot.providerName}</div>
                </div>
                <div className="info-section">
                  <div className="info-label">Model</div>
                  <div className="info-value">{activeModelShort}</div>
                  <div className="info-detail">{activeModelId}</div>
                </div>
              </div>
            )}
          </div>
        </div>
        <div className="topbar-right">
          <div className="topbar-actions-primary">
            <button
              type="button"
              className={terminalPanelOpen ? "ghost-button terminal-toggle active" : "ghost-button terminal-toggle"}
              onClick={() => void handleToggleTerminal()}
              aria-pressed={terminalPanelOpen}
              title={terminalPanelOpen ? "Hide terminal" : "Show terminal"}
            >
              <SquareTerminal size={16} className="ui-icon" />
              Terminal
            </button>
          </div>
          <div className="topbar-actions-secondary">
            <div className="header-menu-wrap">
              <button
                type="button"
                className="ghost-button header-menu-trigger"
                onClick={(event) => {
                  event.stopPropagation();
                  setHeaderMoreOpen(false);
                  setEditorMenuOpen((current) => !current);
                }}
                aria-expanded={editorMenuOpen}
              >
                Open in
                <ChevronDown size={14} className="ui-icon" />
              </button>
              {editorMenuOpen && (
                <div className="header-menu">
                  {EXTERNAL_EDITOR_OPTIONS.map((editor) => (
                    <button
                      key={editor.id}
                      type="button"
                      onClick={(event) => { event.stopPropagation(); void handleOpenInEditor(editor.id); }}
                    >
                      <span className="header-menu-item-icon">
                        <EditorIcon editorId={editor.id} />
                      </span>
                      <span>{editor.label}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button type="button" className="ghost-button" onClick={() => setCurrentScreen("audit")} title="Audit trail">
              <ShieldCheck size={16} className="ui-icon" />
              Audit
            </button>
            <button type="button" className="ghost-button" onClick={() => setCurrentScreen("settings")} title="Settings">
              <SettingsIcon size={16} className="ui-icon" />
              Settings
            </button>
            <button type="button" className="ghost-button" onClick={() => void handleNewChat()} title="New chat">
              <SquarePen size={16} className="ui-icon" />
              New chat
            </button>
          </div>
          <div className="header-more-wrap" onClick={(event) => event.stopPropagation()}>
            <button
              type="button"
              className="icon-button header-more-trigger"
              onClick={(event) => {
                event.stopPropagation();
                setEditorMenuOpen(false);
                setHeaderMoreOpen((current) => !current);
              }}
              title="More"
              aria-label="More"
              aria-expanded={headerMoreOpen}
            >
              <MoreHorizontal size={18} />
            </button>
            {headerMoreOpen && (
              <div className="header-menu header-more-menu">
                <div className="header-menu-section mobile-only-actions">
                  <button
                    type="button"
                    onClick={() => {
                      setHeaderMoreOpen(false);
                      void handleToggleTerminal();
                    }}
                  >
                    <span>{terminalPanelOpen ? "Hide terminal" : "Show terminal"}</span>
                  </button>
                  {activeChatRunning && (
                    <button
                      type="button"
                      onClick={() => {
                        setHeaderMoreOpen(false);
                        handleInterruptChat();
                      }}
                    >
                      <span>Stop</span>
                    </button>
                  )}
                  <div className="header-menu-divider"></div>
                </div>
                {EXTERNAL_EDITOR_OPTIONS.map((editor) => (
                  <button
                    key={editor.id}
                    type="button"
                    onClick={() => {
                      setHeaderMoreOpen(false);
                      void handleOpenInEditor(editor.id);
                    }}
                  >
                    <span className="header-menu-item-icon">
                      <EditorIcon editorId={editor.id} />
                    </span>
                    <span>Open in {editor.label}</span>
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => {
                    setHeaderMoreOpen(false);
                    setCurrentScreen("audit");
                  }}
                >
                  <span>Audit trail</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setHeaderMoreOpen(false);
                    void handleNewChat();
                  }}
                >
                  <span>New chat</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setHeaderMoreOpen(false);
                    void handleCopyWorkspacePath();
                  }}
                >
                  <span>Copy workspace path</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setHeaderMoreOpen(false);
                    setCurrentScreen("settings");
                  }}
                >
                  <span>Settings</span>
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
