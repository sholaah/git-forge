// gitstore.ts — a dependency-free git object store for the forge: SHA-1 object
// hashing, tree/commit/tag build and parse, packfile read (with OFS/REF delta
// resolution) and packfile write (whole objects), reachability walks, fetch
// set computation with shallow support, and tree-level three-way merges.
//
// Everything lives in memory: a repository is a Map from object id to object.
// Only Node built-ins are used (node:crypto for SHA-1, node:zlib for pack
// compression), because the trial sandbox has no git binary and no packages.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export const ZERO_OID = '0'.repeat(40);

const TYPE_TO_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TO_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** git's object id: SHA-1 over "<type> <size>\0" followed by the raw bytes. */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${data.length}\0`, 'utf8'));
  hash.update(data);
  return hash.digest('hex');
}

export type ObjectLookup = (oid: string) => GitObject | undefined;

/** A mutable in-memory object database. */
export class ObjectStore {
  readonly objects = new Map<string, GitObject>();

  get(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  has(oid: string): boolean {
    return this.objects.has(oid);
  }

  /** Store an object under its computed id; returns the id. */
  put(type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  /** Store an object whose id the caller already knows (pack ingest). */
  putKnown(oid: string, type: GitObjectType, data: Buffer): void {
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
  }
}

// ---------------------------------------------------------------------------
// trees

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object's bytes into entries, in stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry without a mode separator');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('tree entry is truncated');
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

/** git's tree ordering: byte order, directories compared as "name/". */
function treeEntrySortKey(entry: TreeEntry): Buffer {
  return Buffer.from(entry.mode === '40000' ? `${entry.name}/` : entry.name, 'utf8');
}

/** Serialize entries into a tree object, sorted the way git sorts them. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => Buffer.compare(treeEntrySortKey(a), treeEntrySortKey(b)));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Flatten a tree (recursively) into a map from slash path to blob entry. */
export function flattenTree(store: ObjectLookup, treeOid: string, prefix = '', out = new Map<string, TreeEntry>()): Map<string, TreeEntry> {
  const tree = store(treeOid);
  if (!tree || tree.type !== 'tree') return out;
  for (const entry of parseTree(tree.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(store, entry.oid, path, out);
    else out.set(path, entry);
  }
  return out;
}

/** Build nested trees from a flat path -> blob-oid map; returns the root tree id. */
export function buildTreeFromFlat(store: ObjectStore, flat: ReadonlyMap<string, { mode: string; oid: string }>): string {
  interface Node {
    files: Map<string, { mode: string; oid: string }>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, entry] of flat) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const name = segments[i]!;
      if (!node.dirs.has(name)) node.dirs.set(name, { files: new Map(), dirs: new Map() });
      node = node.dirs.get(name)!;
    }
    node.files.set(segments[segments.length - 1]!, entry);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, file] of node.files) entries.push({ mode: file.mode, name, oid: file.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return store.put('tree', buildTree(entries));
  };
  return build(root);
}

/** The blob id at a slash path inside a tree, or undefined. */
export function treeEntryAt(store: ObjectLookup, treeOid: string, path: string): TreeEntry | undefined {
  const segments = path.split('/');
  let current = treeOid;
  for (let i = 0; i < segments.length; i += 1) {
    const tree = store(current);
    if (!tree || tree.type !== 'tree') return undefined;
    const entry = parseTree(tree.data).find((candidate) => candidate.name === segments[i]);
    if (!entry) return undefined;
    if (i === segments.length - 1) return entry;
    if (entry.mode !== '40000') return undefined;
    current = entry.oid;
  }
  return undefined;
}

/** Directory listing of one tree level: entries of the tree at a path prefix. */
export function treeLevelAt(store: ObjectLookup, treeOid: string, dirPath: string): TreeEntry[] | undefined {
  if (dirPath === '' || dirPath === '/') {
    const tree = store(treeOid);
    return tree && tree.type === 'tree' ? parseTree(tree.data) : undefined;
  }
  const entry = treeEntryAt(store, treeOid, dirPath);
  if (!entry || entry.mode !== '40000') return undefined;
  const tree = store(entry.oid);
  return tree && tree.type === 'tree' ? parseTree(tree.data) : undefined;
}

// ---------------------------------------------------------------------------
// commits and tags

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const head = blank < 0 ? data.toString('utf8') : data.subarray(0, blank).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    const space = line.indexOf(' ');
    if (space < 0) continue;
    const key = line.slice(0, space);
    const value = line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(input: {
  tree: string;
  parents: readonly string[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  const lines = [`tree ${input.tree}`];
  for (const parent of input.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${input.author}`);
  lines.push(`committer ${input.committer}`);
  const message = input.message.endsWith('\n') ? input.message : `${input.message}\n`;
  return Buffer.from(`${lines.join('\n')}\n\n${message}`, 'utf8');
}

export interface TagView {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagView {
  const blank = data.indexOf('\n\n');
  const head = blank < 0 ? data.toString('utf8') : data.subarray(0, blank).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  const fields = new Map<string, string>();
  for (const line of head.split('\n')) {
    const space = line.indexOf(' ');
    if (space > 0) fields.set(line.slice(0, space), line.slice(space + 1));
  }
  return {
    object: fields.get('object') ?? '',
    type: fields.get('type') ?? '',
    tag: fields.get('tag') ?? '',
    tagger: fields.get('tagger') ?? '',
    message,
  };
}

/** Peel an object id through tag objects until a non-tag object; undefined if missing. */
export function peelToCommit(store: ObjectLookup, oid: string): string | undefined {
  let current = oid;
  for (let guard = 0; guard < 32; guard += 1) {
    const object = store(current);
    if (!object) return undefined;
    if (object.type === 'commit') return current;
    if (object.type === 'tag') {
      current = parseTag(object.data).object;
      continue;
    }
    return undefined;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// reachability

/** Every object id reachable from the given tips (commits, trees, blobs, tags). */
export function collectReachable(store: ObjectLookup, tips: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const stack = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid) || oid === ZERO_OID) continue;
    const object = store(oid);
    if (!object) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      stack.push(commit.tree, ...commit.parents);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    }
  }
  return seen;
}

/** Commit ancestry only: every commit reachable from a tip through parents. */
export function commitAncestors(store: ObjectLookup, tip: string): Set<string> {
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    const object = store(oid);
    if (!object || object.type !== 'commit') continue;
    seen.add(oid);
    stack.push(...parseCommit(object.data).parents);
  }
  return seen;
}

/** True when `ancestor` is `descendant` itself or one of its ancestors. */
export function isAncestor(store: ObjectLookup, ancestor: string, descendant: string): boolean {
  return commitAncestors(store, descendant).has(ancestor);
}

/** The best common ancestor of two commits (first shared commit in BFS order), or undefined. */
export function mergeBase(store: ObjectLookup, a: string, b: string): string | undefined {
  const ancestorsOfA = commitAncestors(store, a);
  const seen = new Set<string>();
  const queue = [b];
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (ancestorsOfA.has(oid)) return oid;
    const object = store(oid);
    if (object && object.type === 'commit') queue.push(...parseCommit(object.data).parents);
  }
  return undefined;
}

/** History walk from a tip, newest first (breadth-first over parents). */
export function walkHistory(store: ObjectLookup, tip: string, limit = 1000): string[] {
  const order: string[] = [];
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length > 0 && order.length < limit) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    const object = store(oid);
    if (!object || object.type !== 'commit') continue;
    seen.add(oid);
    order.push(oid);
    queue.push(...parseCommit(object.data).parents);
  }
  return order;
}

// ---------------------------------------------------------------------------
// packfiles

/** Serialize objects into a version-2 packfile (whole objects, zlib deflated). */
export function writePack(store: ObjectLookup, oids: Iterable<string>): Buffer {
  const list = [...new Set(oids)].filter((oid) => store(oid) !== undefined);
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  const parts: Buffer[] = [header];
  for (const oid of list) {
    const object = store(oid)!;
    parts.push(encodePackObjectHeader(TYPE_TO_CODE[object.type]!, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

function encodePackObjectHeader(typeCode: number, size: number): Buffer {
  const bytes: number[] = [];
  let first = (typeCode << 4) | (size & 0x0f);
  size = Math.floor(size / 16);
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let byte = size & 0x7f;
    size = Math.floor(size / 128);
    if (size > 0) byte |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

/** Apply a git binary delta (as used by OFS_DELTA / REF_DELTA) to a base buffer. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset]!;
      offset += 1;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const targetSize = readVarint();
  const out: Buffer[] = [];
  let produced = 0;
  while (offset < delta.length) {
    const op = delta[offset]!;
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let i = 0; i < 4; i += 1) {
        if (op & (1 << i)) {
          copyOffset += delta[offset]! * 2 ** (8 * i);
          offset += 1;
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if (op & (0x10 << i)) {
          copySize += delta[offset]! * 2 ** (8 * i);
          offset += 1;
        }
      }
      if (copySize === 0) copySize = 0x10000;
      out.push(base.subarray(copyOffset, copyOffset + copySize));
      produced += copySize;
    } else if (op > 0) {
      out.push(delta.subarray(offset, offset + op));
      produced += op;
      offset += op;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== targetSize || produced !== targetSize) throw new Error('delta target size mismatch');
  return result;
}

export interface PackReadResult {
  /** Every object the pack carries, fully resolved, keyed by its computed id. */
  objects: Map<string, GitObject>;
  count: number;
}

/**
 * Parse a packfile. Delta bases may come from the pack itself or from
 * `externalBase` (thin packs). Throws on structural corruption.
 */
export function readPack(pack: Buffer, externalBase?: ObjectLookup): PackReadResult {
  if (pack.length < 12 + 20) throw new Error('pack is too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack header missing');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack version ${version} is not supported`);
  const count = pack.readUInt32BE(8);
  const trailer = pack.subarray(pack.length - 20);
  const digest = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest();
  if (!digest.equals(trailer)) throw new Error('pack checksum mismatch');

  interface RawEntry {
    offset: number;
    typeCode: number;
    data?: Buffer;
    baseOffset?: number;
    baseOid?: string;
    delta?: Buffer;
  }
  const entries: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    const start = offset;
    let byte = pack[offset]!;
    offset += 1;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset]!;
      offset += 1;
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    const entry: RawEntry = { offset: start, typeCode };
    if (typeCode === 6) {
      // OFS_DELTA: a negative offset to the base, in git's offset encoding.
      let b = pack[offset]!;
      offset += 1;
      let baseOffset = b & 0x7f;
      while (b & 0x80) {
        b = pack[offset]!;
        offset += 1;
        baseOffset = (baseOffset + 1) * 128 + (b & 0x7f);
      }
      entry.baseOffset = start - baseOffset;
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }
    const inflated = inflateSync(pack.subarray(offset));
    // inflateSync consumes what it needs; find the consumed length by re-walking
    // is not possible, so use the streaming length trick below instead.
    entry.data = inflated;
    entries.push(entry);
    byOffset.set(start, entry);
    offset += consumedCompressedLength(pack, offset, size);
  }

  const resolved = new Map<number, GitObject>();
  const objects = new Map<string, GitObject>();
  const resolve = (entry: RawEntry): GitObject => {
    const cached = resolved.get(entry.offset);
    if (cached) return cached;
    let object: GitObject;
    if (entry.typeCode >= 1 && entry.typeCode <= 4) {
      object = { type: CODE_TO_TYPE[entry.typeCode]!, data: entry.data! };
    } else if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new Error('ofs-delta base is not in the pack');
      const base = resolve(baseEntry);
      object = { type: base.type, data: applyDelta(base.data, entry.data!) };
    } else if (entry.typeCode === 7) {
      let base: GitObject | undefined;
      const inPack = [...byOffset.values()].find((candidate) => {
        if (candidate.typeCode < 1 || candidate.typeCode > 4) return false;
        return hashObject(CODE_TO_TYPE[candidate.typeCode]!, candidate.data!) === entry.baseOid;
      });
      if (inPack) base = resolve(inPack);
      else if (externalBase) base = externalBase(entry.baseOid!);
      if (!base) throw new Error(`ref-delta base ${entry.baseOid} is unavailable`);
      object = { type: base.type, data: applyDelta(base.data, entry.data!) };
    } else {
      throw new Error(`pack object type ${entry.typeCode} is not supported`);
    }
    resolved.set(entry.offset, object);
    objects.set(hashObject(object.type, object.data), object);
    return object;
  };
  for (const entry of entries) resolve(entry);
  return { objects, count };
}

/**
 * The number of compressed bytes an inflated object of `expectedSize` occupies
 * at `offset` in the pack. zlib streams are self-terminating; this walks the
 * stream with a fresh inflate over a growing window — packs here are small,
 * and correctness beats cleverness.
 */
function consumedCompressedLength(pack: Buffer, offset: number, expectedSize: number): number {
  // A zlib stream's end can be found by inflating with a dictionary-free
  // incremental decoder; Node exposes the consumed count only through the
  // async API, so instead probe increasing lengths: the true stream inflates
  // to exactly expectedSize and any longer slice fails or overshoots.
  // In practice git packs store each object back to back; use the fact that
  // inflateSync on a truncated stream throws, and on an over-long buffer it
  // silently ignores trailing bytes — so binary-search the smallest length
  // that inflates successfully to expectedSize.
  let lo = 1;
  let hi = pack.length - offset - 20; // never into the trailer
  const total = hi;
  const probe = (length: number): boolean => {
    try {
      return inflateSync(pack.subarray(offset, offset + length)).length === expectedSize;
    } catch {
      return false;
    }
  };
  // The stream cannot be longer than the remaining pack; walk exponentially
  // to bracket, then binary-search inside the bracket.
  let step = 1;
  while (step < total && !probe(step)) step *= 2;
  lo = Math.floor(step / 2);
  hi = Math.min(step, total);
  while (lo + 1 < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (probe(mid)) hi = mid;
    else lo = mid;
  }
  if (!probe(hi)) throw new Error('could not locate the end of a pack object stream');
  return hi;
}

// ---------------------------------------------------------------------------
// fetch set computation

export interface FetchPlan {
  /** Object ids to place in the pack. */
  objects: Set<string>;
  /** Commits that become the client's new shallow boundary. */
  shallow: string[];
  /** Previously shallow commits whose parents are now included. */
  unshallow: string[];
}

/**
 * Compute what a fetch must send.
 *
 * `wants` are commit tips the client asks for; `haves` are commits it already
 * holds in full; `clientShallow` are commits it holds WITHOUT their ancestry;
 * `depth` (when set) bounds how many generations back from the wants to send.
 */
export function planFetch(
  store: ObjectLookup,
  wants: readonly string[],
  haves: readonly string[],
  clientShallow: readonly string[],
  depth: number | null,
): FetchPlan {
  const shallowSet = new Set(clientShallow);
  // Objects the client provably holds: full closure of non-shallow haves, and
  // for shallow haves just the commit plus its tree closure (not its parents).
  const clientHas = new Set<string>();
  for (const have of haves) {
    if (shallowSet.has(have)) {
      clientHas.add(have);
      const object = store(have);
      if (object && object.type === 'commit') {
        for (const oid of collectReachable(store, [parseCommit(object.data).tree])) clientHas.add(oid);
      }
    } else {
      for (const oid of collectReachable(store, [have])) clientHas.add(oid);
    }
  }
  const clientCommits = new Set<string>([...haves]);

  // Walk from the wants, assigning each commit its shortest distance. A want
  // that names a tag walks from the commit the tag peels to (the tag object
  // itself is added to the pack separately, below).
  const distance = new Map<string, number>();
  const queue: Array<{ oid: string; depthHere: number }> = [];
  for (const want of wants) {
    queue.push({ oid: want, depthHere: 1 });
    const object = store(want);
    if (object && object.type === 'tag') {
      const peeled = peelToCommit(store, want);
      if (peeled && peeled !== want) queue.push({ oid: peeled, depthHere: 1 });
    }
  }
  const includedCommits = new Set<string>();
  while (queue.length > 0) {
    const { oid, depthHere } = queue.shift()!;
    const known = distance.get(oid);
    if (known !== undefined && known <= depthHere) continue;
    distance.set(oid, depthHere);
    const object = store(oid);
    if (!object || object.type !== 'commit') continue;
    const hasInFull = clientCommits.has(oid) && !shallowSet.has(oid);
    if (hasInFull) continue; // the client holds this commit and its ancestry
    const isShallowHave = clientCommits.has(oid) && shallowSet.has(oid);
    if (!isShallowHave) {
      if (depth === null || depthHere <= depth) includedCommits.add(oid);
    }
    // Expand parents: for a shallow have the client lacks them, so they are
    // candidates at the next distance; for an included commit likewise.
    if (depth === null || depthHere < depth || isShallowHave) {
      for (const parent of parseCommit(object.data).parents) {
        queue.push({ oid: parent, depthHere: depthHere + 1 });
      }
    }
  }

  const objects = new Set<string>();
  // Each included commit contributes itself and its tree closure. Parents are
  // NOT followed here: a commit's parents join the pack only when they are
  // themselves in includedCommits — that is what makes a shallow fetch stop
  // at the boundary instead of leaking the whole ancestry.
  for (const oid of includedCommits) {
    if (!clientHas.has(oid)) objects.add(oid);
    const object = store(oid);
    if (object && object.type === 'commit') {
      for (const inner of collectReachable(store, [parseCommit(object.data).tree])) {
        if (!clientHas.has(inner)) objects.add(inner);
      }
    }
  }
  // Tag objects pointing into the included set ride along (a clone of a tag
  // ref wants the tag object itself; wants may name tags directly).
  for (const want of wants) {
    const object = store(want);
    if (object && object.type === 'tag' && !clientHas.has(want)) objects.add(want);
  }

  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (depth !== null) {
    for (const oid of includedCommits) {
      const object = store(oid);
      if (!object || object.type !== 'commit') continue;
      const parents = parseCommit(object.data).parents;
      const cut = parents.some((parent) => !includedCommits.has(parent) && !clientCommits.has(parent) && store(parent) !== undefined);
      if (cut) shallow.push(oid);
    }
    for (const boundary of shallowSet) {
      const object = store(boundary);
      if (!object || object.type !== 'commit') continue;
      const parents = parseCommit(object.data).parents;
      if (parents.length > 0 && parents.every((parent) => includedCommits.has(parent) || clientCommits.has(parent))) {
        unshallow.push(boundary);
      }
    }
  }
  return { objects, shallow, unshallow };
}

// ---------------------------------------------------------------------------
// tree diffs and three-way merges

export interface FileChange {
  path: string;
  status: 'added' | 'removed' | 'modified';
  oldOid?: string;
  newOid?: string;
}

/** Path-level diff between two trees (through their merge base semantics: direct). */
export function diffTrees(store: ObjectLookup, fromTree: string | undefined, toTree: string | undefined): FileChange[] {
  const from = fromTree ? flattenTree(store, fromTree) : new Map<string, TreeEntry>();
  const to = toTree ? flattenTree(store, toTree) : new Map<string, TreeEntry>();
  const changes: FileChange[] = [];
  for (const [path, entry] of to) {
    const before = from.get(path);
    if (!before) changes.push({ path, status: 'added', newOid: entry.oid });
    else if (before.oid !== entry.oid) changes.push({ path, status: 'modified', oldOid: before.oid, newOid: entry.oid });
  }
  for (const [path, entry] of from) {
    if (!to.has(path)) changes.push({ path, status: 'removed', oldOid: entry.oid });
  }
  changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return changes;
}

/** Count added/removed lines between two texts with a compact LCS diff. */
export function lineDiffCounts(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  // Drop the shared trailing empty segment produced by a final newline so a
  // file's line count reads the way GitHub's does.
  if (oldLines.length && oldLines[oldLines.length - 1] === '') oldLines.pop();
  if (newLines.length && newLines[newLines.length - 1] === '') newLines.pop();
  const m = oldLines.length;
  const n = newLines.length;
  if (m * n > 4_000_000) {
    // Very large inputs: fall back to a whole-file approximation.
    return { additions: n, deletions: m };
  }
  const dp = new Uint32Array((m + 1) * (n + 1));
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i * (n + 1) + j] = oldLines[i] === newLines[j]
        ? dp[(i + 1) * (n + 1) + j + 1]! + 1
        : Math.max(dp[(i + 1) * (n + 1) + j]!, dp[i * (n + 1) + j + 1]!);
    }
  }
  const common = dp[0]!;
  return { additions: n - common, deletions: m - common };
}

export interface MergeOutcome {
  ok: boolean;
  /** The merged flat tree (path -> entry), when ok. */
  flat?: Map<string, { mode: string; oid: string }>;
  conflicts: string[];
}

/**
 * A path-level three-way merge: apply the changes head made since the merge
 * base onto the base tip's tree. A path both sides changed differently (or
 * one side deleted while the other modified) is a conflict.
 */
export function mergeTrees(
  store: ObjectLookup,
  baseTipTree: string,
  mergeBaseTree: string,
  headTree: string,
): MergeOutcome {
  const baseFlat = flattenTree(store, baseTipTree);
  const ancestorFlat = flattenTree(store, mergeBaseTree);
  const headFlat = flattenTree(store, headTree);
  const result = new Map<string, { mode: string; oid: string }>();
  for (const [path, entry] of baseFlat) result.set(path, { mode: entry.mode, oid: entry.oid });
  const conflicts: string[] = [];
  const paths = new Set([...ancestorFlat.keys(), ...headFlat.keys()]);
  for (const path of paths) {
    const ancestor = ancestorFlat.get(path);
    const head = headFlat.get(path);
    if (ancestor && head && ancestor.oid === head.oid) continue; // unchanged on the head side
    if (!ancestor && !head) continue;
    const base = baseFlat.get(path);
    const baseChanged = (base?.oid ?? undefined) !== (ancestor?.oid ?? undefined) || (base === undefined) !== (ancestor === undefined);
    if (!head) {
      // Head deleted the path.
      if (baseChanged) {
        if (base) conflicts.push(path); // base modified what head deleted
        continue;
      }
      result.delete(path);
      continue;
    }
    if (baseChanged && base?.oid !== head.oid) {
      conflicts.push(path);
      continue;
    }
    result.set(path, { mode: head.mode, oid: head.oid });
  }
  if (conflicts.length > 0) return { ok: false, conflicts };
  return { ok: true, flat: result, conflicts: [] };
}
