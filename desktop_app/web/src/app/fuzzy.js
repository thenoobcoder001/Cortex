// Small fuzzy matcher for the command palette. Plain JS (no JSX) so the
// backend test runner can import it.

const WORD_BREAK = /[\s/\\_\-.:·()]/;

function isWordStart(text, index) {
  if (index === 0) return true;
  const prev = text[index - 1];
  if (WORD_BREAK.test(prev)) return true;
  // camelCase boundary: "newChat" -> "C"
  const char = text[index];
  return prev === prev.toLowerCase() && char !== char.toLowerCase();
}

// Scores an exact substring of the query, preferring one that starts a word.
function substringMatch(q, source, t) {
  let at = -1;
  for (let from = t.indexOf(q); from !== -1; from = t.indexOf(q, from + 1)) {
    if (at === -1) at = from;
    if (isWordStart(source, from)) {
      at = from;
      break;
    }
  }
  if (at === -1) return null;
  const positions = Array.from({ length: q.length }, (_, i) => at + i);
  let score;
  if (isWordStart(source, at)) {
    score = 100 + q.length * 8 - at;
    if (at === 0) score += 40;
  } else {
    // Inside a word ("ts" in "Tests"): weaker than an initials match.
    score = 20 + q.length * 6 - Math.min(at, 15);
  }
  if (q.length === t.length) score += 30;
  return { score, positions };
}

// Greedy subsequence, preferring word starts and continuing runs.
function subsequenceMatch(q, source, t) {
  const positions = [];
  let ti = 0;
  for (let qi = 0; qi < q.length; qi += 1) {
    const ch = q[qi];
    let found = -1;
    for (let i = ti; i < t.length; i += 1) {
      if (t[i] !== ch) continue;
      if (found === -1) found = i;
      const prevMatched = positions.length && positions[positions.length - 1] === i - 1;
      if (prevMatched || isWordStart(source, i)) {
        found = i;
        break;
      }
    }
    if (found === -1) return null;
    positions.push(found);
    ti = found + 1;
  }

  let score = 0;
  let allWordStarts = true;
  for (let i = 0; i < positions.length; i += 1) {
    const pos = positions[i];
    score += 2;
    if (isWordStart(source, pos)) score += 15;
    else allWordStarts = false;
    if (i > 0) {
      const gap = pos - positions[i - 1] - 1;
      if (gap === 0) score += 6;
      else score -= Math.min(gap, 8);
    }
  }
  if (allWordStarts && positions.length > 1) score += 20; // initials, e.g. "ts" -> "Toggle sidebar"
  score -= Math.min(positions[0], 15);
  return { score, positions };
}

// Matches `query` as a subsequence of `text`, case-insensitively.
// Returns { score, positions } or null. Higher scores are better: an exact
// substring at a word start beats everything, then initials and other matches
// at word starts and runs of consecutive characters; gaps and a late first
// match take points away.
export function fuzzyMatch(query, text) {
  const q = String(query || "").toLowerCase();
  const source = String(text || "");
  const t = source.toLowerCase();
  if (!q) return { score: 0, positions: [] };
  if (q.length > t.length) return null;
  const sub = substringMatch(q, source, t);
  const seq = subsequenceMatch(q, source, t);
  if (!sub) return seq;
  if (!seq) return sub;
  return seq.score > sub.score ? seq : sub;
}

// Filters and ranks palette items. Each item has a `title` and optional
// `keywords` (string). Every whitespace-separated word of the query has to
// match the title or the keywords; title matches count for more. Results keep
// their original order when scores tie, and carry `matches` (title character
// positions) for highlighting.
export function filterItems(items, query, { limit = Infinity } = {}) {
  const tokens = String(query || "").trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return items.slice(0, limit).map((item) => ({ ...item, matches: [] }));

  const ranked = [];
  items.forEach((item, index) => {
    const title = String(item.title || "");
    const extra = `${item.subtitle || ""} ${item.keywords || ""}`;
    let total = 0;
    const matches = new Set();
    for (const token of tokens) {
      const inTitle = fuzzyMatch(token, title);
      const inExtra = fuzzyMatch(token, extra);
      const extraScore = inExtra ? inExtra.score * 0.6 : -Infinity;
      if (inTitle && inTitle.score >= extraScore) {
        total += inTitle.score;
        inTitle.positions.forEach((pos) => matches.add(pos));
      } else if (inExtra) {
        total += extraScore;
      } else {
        return;
      }
    }
    ranked.push({ item, index, score: total + (item.boost || 0), matches: [...matches].sort((a, b) => a - b) });
  });

  ranked.sort((a, b) => b.score - a.score || a.index - b.index);
  return ranked.slice(0, limit).map(({ item, matches }) => ({ ...item, matches }));
}

// Splits `text` into [{ text, match }] runs for highlighting.
export function highlightSegments(text, positions) {
  const source = String(text || "");
  if (!positions?.length) return [{ text: source, match: false }];
  const marked = new Set(positions);
  const segments = [];
  for (let i = 0; i < source.length; i += 1) {
    const match = marked.has(i);
    const last = segments[segments.length - 1];
    if (last && last.match === match) last.text += source[i];
    else segments.push({ text: source[i], match });
  }
  return segments;
}
