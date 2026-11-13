// Keeps an xterm in step with a backend terminal session.
//
// The backend numbers its output: a snapshot's `history` ends at absolute
// offset `total`, and every streamed chunk carries the offset it ends at.
// Tracking how far this xterm has written lets the stream, the poll and the
// remount replay overlap freely without any output being written twice.
//
// A full replay also follows the session's recorded size changes, because
// ConPTY output is cursor-addressed for the size the terminal had when it
// was produced; replaying it at another size misplaces and repeats lines.
//
// All terminal operations run through one queue, waiting for each write to
// be parsed, so resizes and resets land between the right bytes.

export function createTerminalSync(term, { getViewSize, onGap } = {}) {
  let epoch = null;
  let written = 0;
  let disposed = false;
  let queue = Promise.resolve();

  const run = (op) => {
    queue = queue.then(() => (disposed ? undefined : op())).catch(() => {});
    return queue;
  };
  const write = (data) => new Promise((resolve) => {
    if (disposed || !data) {
      resolve();
      return;
    }
    term.write(data, resolve);
  });
  const resize = (size) => {
    if (!size || disposed) return;
    const cols = Math.trunc(Number(size.cols));
    const rows = Math.trunc(Number(size.rows));
    if (cols > 0 && rows > 0 && (term.cols !== cols || term.rows !== rows)) {
      term.resize(cols, rows);
    }
  };

  const replay = (history, start, sizes) => {
    const marks = (Array.isArray(sizes) ? sizes : [])
      .filter((entry) => Number.isFinite(entry?.at))
      .sort((a, b) => a.at - b.at);
    // The size in effect where the history starts, then each later change.
    let initial = null;
    const later = [];
    for (const entry of marks) {
      if (entry.at <= start) initial = entry;
      else later.push(entry);
    }
    run(async () => {
      term.reset();
      if (initial) resize(initial);
      let pos = start;
      for (const entry of later) {
        await write(history.slice(pos - start, entry.at - start));
        resize(entry);
        pos = entry.at;
      }
      await write(history.slice(pos - start));
      resize(getViewSize?.());
    });
  };

  return {
    run,

    // Full state from GET /api/terminal or the stream's first message.
    applySnapshot(snap) {
      const history = String(snap?.history || "");
      const total = Number(snap?.total);
      if (!Number.isFinite(total)) return;
      const start = total - history.length;
      if (snap.epoch !== epoch || start > written) {
        // New session, first load, or output we never saw was trimmed away.
        epoch = snap.epoch;
        written = total;
        replay(history, start, snap.sizes);
        return;
      }
      if (total > written) {
        const chunk = history.slice(written - start);
        written = total;
        run(() => write(chunk));
      }
    },

    // One streamed chunk: { data, epoch, end }.
    applyData(msg) {
      const data = String(msg?.data || "");
      const end = Number(msg?.end);
      if (!data || !Number.isFinite(end)) return;
      if (msg.epoch !== epoch) {
        onGap?.();
        return;
      }
      const start = end - data.length;
      if (end <= written) return;
      if (start > written) {
        // Missed something (e.g. the stream reconnected); resync from a snapshot.
        onGap?.();
        return;
      }
      const chunk = data.slice(written - start);
      written = end;
      run(() => write(chunk));
    },

    dispose() {
      disposed = true;
    },
  };
}
