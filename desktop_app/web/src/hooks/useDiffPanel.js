import { useCallback, useState } from "react";

// Which assistant turn the right-side diff panel shows. The panel belongs to
// one chat, so it is hidden when the user switches to another chat.
export default function useDiffPanel({ activeChatId, repoRoot }) {
  const [target, setTarget] = useState(null);

  const openTurn = useCallback((turnId) => {
    if (!turnId || !activeChatId) return;
    setTarget((current) => (
      current?.turnId === turnId && current.chatId === activeChatId
        ? null // clicking the open turn's summary again closes it
        : { chatId: activeChatId, repoRoot: repoRoot || "", turnId }
    ));
  }, [activeChatId, repoRoot]);

  const close = useCallback(() => setTarget(null), []);

  const visible = target && target.chatId === activeChatId && target.repoRoot === (repoRoot || "")
    ? target
    : null;

  return { target: visible, openTurn, close };
}
