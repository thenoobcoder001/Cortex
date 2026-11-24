import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  Code, Cpu, Folder, FolderOpen, History, MessageSquare, MessageSquarePlus, Monitor, Moon, PanelLeft, Search,
  Settings, SquareTerminal, Sun,
} from "lucide-react";
import { filterItems, highlightSegments } from "../app/fuzzy.js";
import { defaultPaletteItems, groupItems } from "../app/paletteCommands.js";
import { isMacPlatform, shortcutKeys } from "../app/shortcuts.js";
import "./commandPalette.css";

const ICONS = {
  Code, Cpu, Folder, FolderOpen, History, MessageSquare, MessageSquarePlus, Monitor, Moon, PanelLeft, Settings,
  SquareTerminal, Sun,
};
const RESULT_LIMIT = 60;
const PAGE_STEP = 8;

function Highlighted({ text, positions }) {
  return highlightSegments(text, positions).map((segment, index) =>
    segment.match ? <mark key={index}>{segment.text}</mark> : <span key={index}>{segment.text}</span>,
  );
}

// Ctrl+K palette. `items` come from buildPaletteCommands(); choosing one
// closes the palette and then runs it.
export default function CommandPalette({ open, items, onClose }) {
  if (!open) return null;
  return <PaletteDialog items={items} onClose={onClose} />;
}

function PaletteDialog({ items, onClose }) {
  const listId = useId();
  const inputRef = useRef(null);
  const dialogRef = useRef(null);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const isMac = useMemo(() => isMacPlatform(), []);

  const groups = useMemo(() => {
    const ranked = query.trim()
      ? filterItems(items, query, { limit: RESULT_LIMIT })
      : filterItems(defaultPaletteItems(items), "");
    return groupItems(ranked);
  }, [items, query]);
  const flat = useMemo(() => groups.flatMap((group) => group.items), [groups]);
  const indexById = useMemo(() => new Map(flat.map((item, index) => [item.id, index])), [flat]);
  const safeIndex = flat.length ? Math.min(activeIndex, flat.length - 1) : -1;
  const activeItem = safeIndex >= 0 ? flat[safeIndex] : null;
  const optionId = (index) => `${listId}-option-${index}`;

  // Remember what had focus and give it back on close.
  useEffect(() => {
    const previous = document.activeElement;
    inputRef.current?.focus();
    return () => {
      if (previous && previous.isConnected && typeof previous.focus === "function") previous.focus();
    };
  }, []);

  useLayoutEffect(() => {
    if (safeIndex < 0) return;
    document.getElementById(optionId(safeIndex))?.scrollIntoView({ block: "nearest" });
  });

  const choose = (item) => {
    if (!item) return;
    onClose();
    // Run after the palette is gone, so focus is back where it was and the
    // action can move it (e.g. into the composer) if it wants to.
    window.setTimeout(() => {
      void Promise.resolve(item.run?.()).catch(() => {});
    }, 0);
  };

  const move = (delta) => {
    if (!flat.length) return;
    setActiveIndex((current) => {
      const from = Math.min(current, flat.length - 1);
      if (Math.abs(delta) > 1) return Math.max(0, Math.min(flat.length - 1, from + delta));
      return (from + delta + flat.length) % flat.length;
    });
  };

  const onKeyDown = (event) => {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        move(1);
        break;
      case "ArrowUp":
        event.preventDefault();
        move(-1);
        break;
      case "PageDown":
        event.preventDefault();
        move(PAGE_STEP);
        break;
      case "PageUp":
        event.preventDefault();
        move(-PAGE_STEP);
        break;
      case "Home":
        if (event.ctrlKey || event.metaKey) {
          event.preventDefault();
          setActiveIndex(0);
        }
        break;
      case "End":
        if (event.ctrlKey || event.metaKey) {
          event.preventDefault();
          setActiveIndex(Math.max(0, flat.length - 1));
        }
        break;
      case "Enter":
        if (event.nativeEvent.isComposing) return;
        event.preventDefault();
        choose(activeItem);
        break;
      case "Escape":
        event.preventDefault();
        event.stopPropagation();
        onClose();
        break;
      case "Tab": {
        // Focus trap: the search box is the only tab stop inside the dialog.
        event.preventDefault();
        inputRef.current?.focus();
        break;
      }
      default:
        break;
    }
  };

  // Keep focus inside the dialog if something tries to move it out.
  const onBlurCapture = (event) => {
    const next = event.relatedTarget;
    if (next && dialogRef.current && !dialogRef.current.contains(next)) {
      window.requestAnimationFrame(() => inputRef.current?.focus());
    }
  };

  return (
    <div className="command-palette-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div
        ref={dialogRef}
        className="command-palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onKeyDown={onKeyDown}
        onBlurCapture={onBlurCapture}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="command-palette-search">
          <Search size={16} aria-hidden="true" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
            }}
            placeholder="Search actions, chats, projects, models…"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={safeIndex >= 0 ? optionId(safeIndex) : undefined}
            aria-autocomplete="list"
            autoComplete="off"
            spellCheck={false}
          />
          <kbd className="command-palette-esc">Esc</kbd>
        </div>
        <div id={listId} className="command-palette-list" role="listbox" aria-label="Commands">
          {!flat.length && <div className="command-palette-empty">No matching commands</div>}
          {groups.map((group) => (
            <div key={group.name} role="group" aria-label={group.name} className="command-palette-group">
              <div className="command-palette-group-label" aria-hidden="true">{group.name}</div>
              {group.items.map((item) => {
                const index = indexById.get(item.id);
                const Icon = ICONS[item.icon];
                const keys = item.shortcut ? shortcutKeys(item.shortcut, isMac) : [];
                return (
                  <div
                    key={item.id}
                    id={optionId(index)}
                    role="option"
                    aria-selected={index === safeIndex}
                    className={index === safeIndex ? "command-palette-item active" : "command-palette-item"}
                    onMouseMove={() => { if (index !== safeIndex) setActiveIndex(index); }}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => choose(item)}
                  >
                    <span className="command-palette-item-icon">{Icon && <Icon size={15} aria-hidden="true" />}</span>
                    <span className="command-palette-item-text">
                      <span className="command-palette-item-title"><Highlighted text={item.title} positions={item.matches} /></span>
                      {item.subtitle && <span className="command-palette-item-subtitle" title={item.subtitle}>{item.subtitle}</span>}
                    </span>
                    {keys.length > 0 && (
                      <span className="command-palette-keys" aria-label={`Shortcut ${keys.join(" ")}`}>
                        {keys.map((key) => <kbd key={key}>{key}</kbd>)}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
        <div className="command-palette-footer" aria-hidden="true">
          <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
          <span><kbd>Enter</kbd> run</span>
          <span><kbd>Esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
}
