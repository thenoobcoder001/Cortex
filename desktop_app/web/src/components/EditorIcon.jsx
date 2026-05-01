export default function EditorIcon({ editorId }) {
  if (editorId === "vscode") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path
          fill="currentColor"
          d="M16.2 2.4 7.8 10l-4-3.1L1.4 8.1l4.2 3.9-4.2 3.9 2.4 1.2 4-3.1 8.4 7.6 5.4-2.6V5z"
        />
      </svg>
    );
  }
  if (editorId === "cursor") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path
          fill="currentColor"
          d="M12 2 4 7v10l8 5 8-5V7zm0 2.2 5.8 3.6L12 11.4 6.2 7.8zM6 9.5l5 3.1v6.8L6 16.3zm7 9.9v-6.8l5-3.1v6.8z"
        />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M12 2c-1.7 3.6-5.3 5.1-8 5.6 1.5 1.8 2.6 4.3 2.6 7 0 2.7-1.1 5.2-2.6 7 2.7-.5 6.3-2 8-5.6 1.7 3.6 5.3 5.1 8 5.6-1.5-1.8-2.6-4.3-2.6-7 0-2.7 1.1-5.2 2.6-7-2.7-.5-6.3-2-8-5.6z"
      />
    </svg>
  );
}
