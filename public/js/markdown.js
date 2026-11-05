// Markdown minimal et sûr : construit des nœuds DOM (jamais d'innerHTML) — gras, italique, barré, code, blocs de code, citations, liens.
const URL_RE = /\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/g;

function inline(text, out) {
  // ordre : code, gras, italique, barré, liens
  const re = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|(\*[^*\n]+\*)|(_[^_\n]+_)|(~~[^~\n]+~~)|(\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]])/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.append(document.createTextNode(text.slice(last, m.index)));
    const t = m[0]; let el;
    if (m[1]) { el = document.createElement('code'); el.textContent = t.slice(1, -1); }
    else if (m[2] || m[3]) { el = document.createElement('strong'); inline(t.slice(2, -2), el); }
    else if (m[4] || m[5]) { el = document.createElement('em'); inline(t.slice(1, -1), el); }
    else if (m[6]) { el = document.createElement('s'); inline(t.slice(2, -2), el); }
    else { el = document.createElement('a'); el.href = t; el.textContent = t; el.target = '_blank'; el.rel = 'noopener noreferrer nofollow'; }
    out.append(el); last = m.index + t.length;
  }
  if (last < text.length) out.append(document.createTextNode(text.slice(last)));
}

export function renderMarkdown(src) {
  const frag = document.createDocumentFragment();
  const parts = String(src).split(/```/);
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      const pre = document.createElement('pre'), code = document.createElement('code');
      code.textContent = part.replace(/^[a-z0-9+-]*\n/i, '').replace(/\n$/, ''); pre.append(code); frag.append(pre); return;
    }
    const lines = part.split('\n');
    let quote = null;
    lines.forEach((line, j) => {
      if (/^>\s?/.test(line)) {
        if (!quote) { quote = document.createElement('blockquote'); frag.append(quote); } else quote.append('\n');
        inline(line.replace(/^>\s?/, ''), quote); return;
      }
      quote = null;
      const li = line.match(/^\s*[-*•]\s+(.*)$/);
      if (li) { frag.append('• '); inline(li[1], frag); } else inline(line, frag);
      if (j < lines.length - 1) frag.append('\n');
    });
  });
  return frag;
}
export const plainUrls = s => String(s).match(URL_RE) || [];
