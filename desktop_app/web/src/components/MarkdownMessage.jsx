import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy } from "lucide-react";

const COPIED_MS = 1600;

// Wraps a fenced code block with a copy button. Copies the rendered text, so
// what lands on the clipboard matches what the user sees.
function CodeBlock({ children, node: _node, ...props }) {
  const preRef = useRef(null);
  const timerRef = useRef(null);
  const [state, setState] = useState("idle"); // "idle" | "copied" | "failed"

  useEffect(() => () => clearTimeout(timerRef.current), []);

  const handleCopy = async () => {
    const text = preRef.current?.querySelector("code")?.textContent ?? preRef.current?.textContent ?? "";
    try {
      await navigator.clipboard.writeText(text.replace(/\n$/, ""));
      setState("copied");
    } catch {
      setState("failed");
    }
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setState("idle"), COPIED_MS);
  };

  const label = state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "Copy";
  return (
    <div className="code-block">
      <button
        type="button"
        className={`code-block-copy${state === "copied" ? " is-copied" : ""}`}
        onClick={() => void handleCopy()}
        aria-label={state === "idle" ? "Copy code" : label}
        title="Copy code"
      >
        {state === "copied" ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
        <span>{label}</span>
      </button>
      <pre ref={preRef} {...props}>{children}</pre>
    </div>
  );
}

export default function MarkdownMessage({ content }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ href, children, node: _node, ...props }) => (
          <a href={href} target="_blank" rel="noreferrer" {...props}>
            {children}
          </a>
        ),
        pre: CodeBlock,
      }}
    >
      {String(content || "")}
    </ReactMarkdown>
  );
}
