/** Find-in-note helpers. The offset matcher is pure so it can be tested
 * without a DOM; the range collector wraps it over a live subtree. */

/** Offsets of every non-overlapping occurrence of `query` in `text`. */
export function matchOffsets(
  text: string,
  query: string,
  caseSensitive = false
): Array<[number, number]> {
  if (!query) return [];
  const haystack = caseSensitive ? text : text.toLowerCase();
  const needle = caseSensitive ? query : query.toLowerCase();
  const out: Array<[number, number]> = [];
  let from = 0;

  for (;;) {
    const at = haystack.indexOf(needle, from);

    if (at === -1) break;
    out.push([at, at + needle.length]);
    from = at + needle.length;
  }

  return out;
}

/** Text nodes under `root`, skipping script/style and collapsed nodes. */
export function collectTextNodes(root: Node): Text[] {
  const nodes: Text[] = [];

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = (node as Text).parentElement;

      if (!parent) return NodeFilter.FILTER_REJECT;
      const tag = parent.tagName;

      if (tag === "SCRIPT" || tag === "STYLE") return NodeFilter.FILTER_REJECT;

      return node.nodeValue ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });

  let current = walker.nextNode();

  while (current) {
    nodes.push(current as Text);
    current = walker.nextNode();
  }

  return nodes;
}

/** DOM Ranges for every match of `query` under `root`. A match spanning
 * multiple text nodes is skipped (rare inside one editor paragraph). */
export function findRanges(root: Node, query: string, caseSensitive = false): Range[] {
  const ranges: Range[] = [];

  for (const node of collectTextNodes(root)) {
    for (const [start, end] of matchOffsets(node.nodeValue ?? "", query, caseSensitive)) {
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, end);
      ranges.push(range);
    }
  }

  return ranges;
}
