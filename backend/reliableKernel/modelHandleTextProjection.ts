interface TextHandle {
  readonly target: string;
  readonly ref: string;
}

interface MatcherNode {
  // Most canonical-id trie nodes have just one edge. Allocate a Map only at branches.
  character: number;
  next: number;
  alternatives?: Map<number, number>;
  depth: number;
  failure: number;
  /** Longest proper suffix whose trie prefix can still consume more text. */
  extendableFailure: number;
  /** Nearest terminal failure ancestor, never a copied list of inherited matches. */
  output: number;
  entry?: TextHandle;
  /** Terminal nodes only: logarithmic jumps over suffixes too long for an available interval. */
  suffixJumps?: number[];
}

const HANDLE_TOKEN_PATTERN = /\b(?:F|P|O|A|W|C|M|R|H|T|B)[1-9]\d*\b/g;

/** The caller owns this matcher with its immutable prepared catalog, never a global text cache. */
export function createModelHandleTextProjection(entries: readonly TextHandle[]): (value: string) => string {
  const nodes: MatcherNode[] = [];
  const addNode = (depth: number): number => nodes.push({ character: -1, next: 0, depth, failure: 0, extendableFailure: 0, output: 0 }) - 1;
  addNode(0);
  let maxLength = 0;
  const transition = (state: number, character: number): number | undefined => {
    const node = nodes[state];
    return node.character === character ? node.next : node.alternatives?.get(character);
  };
  for (const entry of entries) {
    if (!entry.target.length) throw new TypeError('Model handle text target must not be empty.');
    maxLength = Math.max(maxLength, entry.target.length);
    let state = 0;
    // String#indexOf uses UTF-16 code units, including unpaired surrogates. Keep that exact contract.
    for (let index = 0; index < entry.target.length; index += 1) {
      const character = entry.target.charCodeAt(index);
      let next = transition(state, character);
      if (next === undefined) {
        next = addNode(nodes[state].depth + 1);
        const node = nodes[state];
        if (node.character === -1) { node.character = character; node.next = next; }
        else (node.alternatives ??= new Map()).set(character, next);
      }
      state = next;
    }
    // Equal targets of different kinds retain the first entry in catalog order.
    nodes[state].entry ??= entry;
  }
  const queue = [0];
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const state = queue[cursor];
    const node = nodes[state];
    const visit = (character: number, child: number): void => {
      if (state !== 0) {
        let failure = node.failure;
        let next = transition(failure, character);
        while (next === undefined && failure !== 0) {
          failure = nodes[failure].failure;
          next = transition(failure, character);
        }
        nodes[child].failure = next ?? 0;
        const fallback = nodes[nodes[child].failure];
        nodes[child].extendableFailure = fallback.character !== -1 ? nodes[child].failure : fallback.extendableFailure;
        nodes[child].output = fallback.entry ? nodes[child].failure : fallback.output;
        if (nodes[child].entry && nodes[child].output) {
          // Only terminals allocate jumps. Their count is at most ceil(log2(target.length)), keeping
          // total auxiliary storage bounded by the sum of the catalog's target lengths.
          const jumps = [nodes[child].output];
          for (let level = 0; ; level += 1) {
            const ancestor = nodes[jumps[level]].suffixJumps?.[level];
            if (ancestor === undefined) break;
            jumps.push(ancestor);
          }
          nodes[child].suffixJumps = jumps;
        }
      }
      queue.push(child);
    };
    if (node.character !== -1) visit(node.character, node.next);
    node.alternatives?.forEach((child, character) => visit(character, child));
  }
  // The build callback closes over queue; release its backing storage before retaining the projector.
  queue.length = 0;
  const atMost = (match: number, length: number): number => {
    if (!match || nodes[match].entry!.target.length <= length) return match;
    const levels = nodes[match].suffixJumps?.length ?? 0;
    for (let level = levels - 1; level >= 0; level -= 1) {
      const ancestor = nodes[match].suffixJumps?.[level];
      if (ancestor !== undefined && nodes[ancestor].entry!.target.length > length) match = ancestor;
    }
    return nodes[match].output;
  };

  return (value: string): string => {
    if (!value.length || !maxLength) return value;
    let state = 0;
    let offset = 0;
    let references: Array<{ start: number; end: number }> | undefined;
    const pending: Array<{ start: number; end: number; entry: TextHandle }> = [];
    let firstPending = 0;
    let pieces: string[] | undefined;
    const finish = (through: number): void => {
      while (firstPending < pending.length && pending[firstPending].start <= through) {
        const { start, end, entry } = pending[firstPending++];
        (pieces ??= []).push(value.slice(offset, start), entry.ref);
        offset = end;
      }
      if (firstPending === pending.length) { pending.length = 0; firstPending = 0; }
      else if (firstPending >= 1024 && firstPending * 2 >= pending.length) {
        pending.splice(0, firstPending);
        firstPending = 0;
      }
    };
    for (let index = 0; index < value.length; index += 1) {
      const character = value.charCodeAt(index);
      let next = transition(state, character);
      while (next === undefined && state !== 0) {
        state = nodes[state].failure;
        next = transition(state, character);
      }
      state = next ?? 0;
      let match = atMost(nodes[state].entry ? state : nodes[state].output, index + 1 - offset);
      while (match !== 0) {
        const entry = nodes[match].entry!;
        const start = index + 1 - entry.target.length;
        let low = firstPending;
        let high = pending.length;
        while (low < high) {
          const middle = Math.floor((low + high) / 2);
          if (pending[middle].start < start) low = middle + 1;
          else high = middle;
        }
        if (low > firstPending && pending[low - 1].end > start) {
          match = atMost(match, index + 1 - pending[low - 1].end);
          continue;
        }
        // Exclude only partial overlap with an existing short ref. A target may contain a whole ref.
        references ??= Array.from(value.matchAll(HANDLE_TOKEN_PATTERN), token => ({
          start: token.index, end: token.index + token[0].length
        }));
        const allowedLength = maximumUnprotectedMatchLength(start, index + 1, references);
        if (allowedLength !== undefined) { match = atMost(match, allowedLength); continue; }
        // Keep the greedy nonoverlapping frontier. A new earlier/same-start match ends no earlier
        // than every pending interval it replaces. All shorter suffixes at this end are contained
        // by it, so neither those intervals nor the remaining suffix outputs can ever be selected.
        pending.length = low;
        pending.push({ start, end: index + 1, entry });
        break;
      }
      // Every future match starts at a suffix-prefix that can extend from this state. Commit all
      // earlier starts now: an unrelated long target must not hold a text-sized pending frontier.
      const extending = nodes[state].character !== -1 ? state : nodes[state].extendableFailure;
      const ready = index - nodes[extending].depth;
      if (ready >= 0 && firstPending < pending.length) finish(ready);
    }
    finish(value.length);
    return pieces ? pieces.join('') + value.slice(offset) : value;
  };
}

/** If a match cuts a token, skip directly to suffixes starting after it; if its end cuts a token,
 * every suffix cuts that same token. Containing an entire token remains valid. */
function maximumUnprotectedMatchLength(start: number, end: number, references: readonly { start: number; end: number }[]): number | undefined {
  let low = 0;
  let high = references.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (references[middle].end <= start) low = middle + 1;
    else high = middle;
  }
  const first = references[low];
  if (!first || first.start >= end) return undefined;
  high = references.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (references[middle].start < end) low = middle + 1;
    else high = middle;
  }
  // References are sorted and disjoint. Only the first and last intersecting token can be cut;
  // repeatedly walking fully contained tokens would make growing multi-token targets quadratic.
  if (end < references[low - 1].end) return 0;
  return start > first.start ? end - first.end : undefined;
}
