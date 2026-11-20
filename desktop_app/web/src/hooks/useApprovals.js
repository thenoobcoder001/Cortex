import { useCallback, useMemo, useState } from "react";

// Pending approval requests from running agents. Merges two sources:
// stream events (approval_request / approval_resolved, instant) and the
// snapshot's pendingApprovals (polled while a chat runs, so a reload or a
// request raised by another client still shows up).
export default function useApprovals({ snapshot, postJson, setError }) {
  const [streamed, setStreamed] = useState({});
  const [resolvedIds, setResolvedIds] = useState(() => new Set());
  const [answering, setAnswering] = useState({});
  const [turnEndedAt, setTurnEndedAt] = useState({});

  const markResolved = useCallback((ids) => {
    if (!ids.length) return;
    setResolvedIds((current) => new Set([...current, ...ids]));
    setStreamed((current) => {
      const next = { ...current };
      for (const id of ids) delete next[id];
      return next;
    });
  }, []);

  const handleApprovalEvent = useCallback((event) => {
    if (event.type === "approval_request" && event.approval?.id) {
      setStreamed((current) => ({ ...current, [event.approval.id]: event.approval }));
    } else if (event.type === "approval_resolved" && event.approvalId) {
      markResolved([event.approvalId]);
    } else if (["completed", "error", "interrupted"].includes(event.type) && event.chatId) {
      // Anything this chat asked before now was declined by the backend when
      // the turn ended, even if an older snapshot still lists it.
      setTurnEndedAt((current) => ({ ...current, [event.chatId]: new Date().toISOString() }));
      setStreamed((current) => Object.fromEntries(
        Object.entries(current).filter(([, approval]) => approval.chatId !== event.chatId),
      ));
    }
  }, [markResolved]);

  const respond = async (approval, decision, { alwaysAllow = false } = {}) => {
    setAnswering((current) => ({ ...current, [approval.id]: decision }));
    try {
      await postJson("/api/approvals/respond", {
        approvalId: approval.id,
        chatId: approval.chatId,
        decision,
        alwaysAllow,
      });
      markResolved([approval.id]);
    } catch (nextError) {
      // Usually "already answered" (timeout, or answered on the phone).
      markResolved([approval.id]);
      setError(String(nextError));
    } finally {
      setAnswering((current) => {
        const next = { ...current };
        delete next[approval.id];
        return next;
      });
    }
  };

  const snapshotApprovals = snapshot?.pendingApprovals;
  const list = useMemo(() => {
    const merged = { ...streamed };
    for (const approval of Array.isArray(snapshotApprovals) ? snapshotApprovals : []) {
      merged[approval.id] = approval;
    }
    return Object.values(merged)
      .filter((approval) => !resolvedIds.has(approval.id))
      .filter((approval) => !(turnEndedAt[approval.chatId] && String(approval.requestedAt) < turnEndedAt[approval.chatId]))
      .sort((a, b) => String(a.requestedAt).localeCompare(String(b.requestedAt)));
  }, [streamed, snapshotApprovals, resolvedIds, turnEndedAt]);

  const waitingChatIds = useMemo(() => [...new Set(list.map((approval) => approval.chatId))], [list]);
  const activeChatId = snapshot?.config?.activeChatId || "";
  const activeApprovals = useMemo(() => list.filter((approval) => approval.chatId === activeChatId), [list, activeChatId]);

  return { activeApprovals, answering, handleApprovalEvent, respond, waitingChatIds };
}
