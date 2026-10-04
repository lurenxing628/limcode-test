import { CURRENT_MODEL_HANDLE_IDENTITY_CONTRACT_REVISION, type ModelHandleCatalog } from './modelHandleCatalog';

interface Fact<T> { id: number; key: string; value: T; leaf: SetNode<T> }
interface SetNode<T> {
  id: number;
  references: number;
  roots: number;
  fact?: Fact<T>;
  left?: SetNode<T>;
  right?: SetNode<T>;
  key?: string;
}
type FactSet<T> = SetNode<T> | null;

/**
 * Canonical binary set trees share equal subtrees even when requests arrive in arbitrary id
 * order and catalogs interleave different handle kinds. Prefix-list sharing is insufficient:
 * discovering A1..An,P1..Pn before shorter cumulative catalogs retains quadratic suffixes.
 * Branch identities are exact child-node pairs, not hashes. A catalog owns only one root;
 * releasing its last reference recursively releases no-longer-shared branches and facts.
 */
class FactSets<T> {
  private readonly facts = new Map<string, Fact<T>>();
  private readonly branches = new Map<string, SetNode<T>>();
  private nextFactId = 1;
  private nextNodeId = 1;
  private emptyRoots = 0;

  public acquire(values: Array<[string, T]>): FactSet<T> {
    if (values.length === 0) { this.emptyRoots++; return null; }
    const facts = values.map(([key, value]) => {
      let fact = this.facts.get(key);
      if (!fact) {
        const leaf: SetNode<T> = { id: this.nextNodeId++, references: 0, roots: 0 };
        fact = { id: this.nextFactId++, key, value, leaf }; leaf.fact = fact; this.facts.set(key, fact);
      }
      return fact;
    }).sort((left, right) => left.id - right.id);
    const root = this.tree(facts, 0, facts.length, true)!;
    root.roots++; root.references++;
    return root;
  }

  public contains(keys: string[]): boolean {
    if (keys.length === 0) return this.emptyRoots > 0;
    const facts: Fact<T>[] = [];
    for (const key of keys) {
      const fact = this.facts.get(key);
      if (!fact) return false;
      facts.push(fact);
    }
    facts.sort((left, right) => left.id - right.id);
    return (this.tree(facts, 0, facts.length, false)?.roots ?? 0) > 0;
  }

  private tree(facts: Fact<T>[], start: number, end: number, create: boolean): SetNode<T> | undefined {
    if (end - start === 1) return facts[start].leaf;
    const first = facts[start].id;
    const last = facts[end - 1].id;
    // Highest differing bit, using exact integer arithmetic rather than 32-bit truncation.
    let bit = Math.floor(Math.log2(last));
    while (Math.floor(first / 2 ** bit) === Math.floor(last / 2 ** bit)) bit--;
    const boundary = (Math.floor(first / 2 ** bit) + 1) * 2 ** bit;
    let low = start + 1; let high = end - 1;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (facts[middle].id < boundary) low = middle + 1; else high = middle;
    }
    const left = this.tree(facts, start, low, create);
    const right = this.tree(facts, low, end, create);
    if (!left || !right) return undefined;
    const key = `${left.id}/${right.id}`;
    let node = this.branches.get(key);
    if (!node && create) {
      node = { id: this.nextNodeId++, key, left, right, references: 0, roots: 0 };
      this.branches.set(key, node); left.references++; right.references++;
    }
    return node;
  }

  public release(root: FactSet<T>): void {
    if (!root) { this.emptyRoots--; return; }
    root.roots--;
    const pending = [root];
    while (pending.length) {
      const node = pending.pop()!;
      if (--node.references > 0) continue;
      if (node.fact) this.facts.delete(node.fact.key);
      else {
        this.branches.delete(node.key!);
        pending.push(node.left!, node.right!);
      }
    }
  }

  public values(): T[] { return [...this.facts.values()].map(fact => fact.value); }
  public size(): number {
    let bytes = this.branches.size * 160;
    for (const fact of this.facts.values()) bytes += 224 + fact.key.length * 4;
    return bytes;
  }
}

export interface PackedContextHandleEvidence {
  catalogs: FactSet<ModelHandleCatalog>[];
  ordinary?: FactSet<undefined>;
}

/** Raw historical facts retain their original contract bit. Reconciled/reallocated output must
 * never become input evidence: that would invent current authority for legacy ambiguous refs. */
export class ContextHandleEvidenceFacts {
  private readonly catalogs = new FactSets<ModelHandleCatalog>();
  private readonly ordinary = new FactSets<undefined>();

  public add(catalogs: readonly ModelHandleCatalog[], currentOrdinaryCatalog?: ModelHandleCatalog): PackedContextHandleEvidence {
    return {
      catalogs: catalogs.map(catalog => this.catalogs.acquire(catalogFacts(catalog))),
      ...(currentOrdinaryCatalog ? { ordinary: this.ordinary.acquire(identityFacts(currentOrdinaryCatalog).map(key => [key, undefined])) } : {})
    };
  }

  public remove(evidence: PackedContextHandleEvidence): void {
    for (const catalog of evidence.catalogs) this.catalogs.release(catalog);
    if (evidence.ordinary !== undefined) this.ordinary.release(evidence.ordinary);
  }

  public allCatalogs(): ModelHandleCatalog[] { return this.catalogs.values(); }
  public hasCurrentOrdinaryCatalog(catalog: ModelHandleCatalog): boolean {
    return catalog.identityContractRevision === CURRENT_MODEL_HANDLE_IDENTITY_CONTRACT_REVISION
      && this.ordinary.contains(identityFacts(catalog));
  }
  public size(): number { return this.catalogs.size() + this.ordinary.size(); }
}

function catalogFacts(catalog: ModelHandleCatalog): Array<[string, ModelHandleCatalog]> {
  const current = catalog.identityContractRevision === CURRENT_MODEL_HANDLE_IDENTITY_CONTRACT_REVISION;
  const facts: Array<[string, ModelHandleCatalog]> = catalog.entries.map(entry => [JSON.stringify([current, entry]),
    { entries: [entry], ...(current ? { identityContractRevision: CURRENT_MODEL_HANDLE_IDENTITY_CONTRACT_REVISION, retiredRefs: [] } : {}) }]);
  for (const ref of catalog.retiredRefs ?? []) facts.push([JSON.stringify(['retired', ref]), {
    entries: [], identityContractRevision: CURRENT_MODEL_HANDLE_IDENTITY_CONTRACT_REVISION, retiredRefs: [ref]
  }]);
  return facts;
}

/** Exact set identity is sufficient for local evidence equality; no cryptographic digest needed. */
function identityFacts(catalog: ModelHandleCatalog): string[] {
  return [
    ...catalog.entries.map(({ kind, ref, target }) => JSON.stringify([kind, ref, target])),
    ...(catalog.retiredRefs ?? []).map(ref => JSON.stringify(['retired', ref]))
  ];
}
