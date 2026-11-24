import type { LocalFiles, Result } from "./model";
import { SyncError, checkAbort } from "./model";
import { hash } from "./content";
import type { GitHubStore } from "./github-store";

/** What one device remembers of a mirror sync: the path to the file's own
 *  hash as this device left it, and to the blob it had on the branch. */
export type MirrorBase = Record<
  string,
  { local: string; remote: string } | undefined
>;

export const parseMirrorBase = (value: unknown): MirrorBase => {
  if (!value || typeof value !== "object") return {};
  const files = (value as { files?: unknown }).files;
  if (!files || typeof files !== "object") return {};
  const out: MirrorBase = {};
  for (const [path, one] of Object.entries(files as Record<string, unknown>)) {
    const side = one as { local?: unknown; remote?: unknown } | null;
    if (typeof side?.local === "string" && typeof side?.remote === "string")
      out[path] = { local: side.local, remote: side.remote };
  }
  return out;
};

export interface MirrorSyncOptions {
  store: GitHubStore;
  local: LocalFiles;
  base: MirrorBase;
  saveBase: (base: MirrorBase) => Promise<void>;
  progress?: (phase: string, current: number, total: number) => void;
  signal?: AbortSignal;
}

/** Our own namespace in a mirror repository: what the chunked sync wrote
 *  there before the repository became the workspace whole, and where the
 *  lock would live. Never mirrored, never fetched as notes. */
const OWN = /^v1\//;

const conflictName = (path: string, at: Date) => {
  const dot = path.lastIndexOf(".");
  const stem = dot > 0 ? path.slice(0, dot) : path;
  const tail = dot > 0 ? path.slice(dot) : "";
  const stamp = at.toISOString().replace(/[-:]/g, "").replace(/\..+/, "");
  return `${stem} (conflict ${stamp})${tail}`;
};

/** A sync that keeps the repository a plain folder: every note is a real
 *  file at its real path, so any Git tool works on the same repository.
 *  One commit carries the sync's whole change. Three sides decide each
 *  file: what this device remembers (base), what the branch has now, and
 *  what the folder has now.
 *
 *  Deletions only travel from this device's folder: a file that another
 *  tool deleted on the branch is brought back rather than removed here,
 *  because a mirror must never empty the workspace on its own - the wipe
 *  this project's broken release once made taught that. To drop a file
 *  everywhere, delete it in the folder. */
export async function mirrorSync({
  store,
  local,
  base,
  saveBase,
  progress,
  signal,
}: MirrorSyncOptions): Promise<Result> {
  checkAbort(signal);
  const result: Result = {
    uploaded: 0,
    downloaded: 0,
    removed: 0,
    moved: 0,
    conflicts: [],
    deferred: [],
    notTrashed: [],
    unchanged: 0,
  };
  const scanned = await local.scan();
  const localHash: Record<string, string> = {};
  for (const [path, entry] of Object.entries(scanned))
    if (local.wants(path)) localHash[path] = entry.hash;
  const branch = await store.mirrorTree();
  const remote = new Map(
    [...branch].filter(([path]) => !OWN.test(path) && local.wants(path)),
  );
  checkAbort(signal);

  // A branch emptied entirely while this device remembers a full sync was
  // not this device's doing - a wipe by a broken build, or a forced push
  // gone wrong. The folder is re-uploaded rather than echoed downward:
  // a branch-side loss is handled like any other branch-side deletion,
  // which always comes back.
  const restore = remote.size === 0 && Object.keys(base).length > 0;
  void restore;

  /** Path to the bytes to send, read lazily so an unchanged sync reads
   *  nothing; kept until the base is written, for its hash. */
  const uploads = new Map<string, Uint8Array>();
  const send = async (path: string): Promise<Uint8Array> => {
    let bytes = uploads.get(path);
    if (!bytes) {
      const read = await local.read(path);
      if (!read) throw new SyncError("localWriteError", [path]);
      bytes = read;
      uploads.set(path, bytes);
    }
    return bytes;
  };
  const downloads: {
    path: string;
    bytes: Uint8Array;
    expected: string | null;
    from: string;
  }[] = [];

  const next: MirrorBase = {};
  const steps = [
    ...new Set([
      ...Object.keys(base),
      ...remote.keys(),
      ...Object.keys(localHash),
    ]),
  ].sort();
  progress?.("comparing", 0, steps.length);
  let at = 0;
  for (const path of steps) {
    checkAbort(signal);
    if (!local.wants(path)) continue;
    at++;
    progress?.("comparing", at, steps.length);
    const mine = localHash[path];
    const theirs = remote.get(path);
    const remembered = base[path];
    // Gone from both the folder and the branch, or never ours: nothing.
    if (!mine && !theirs) continue;
    // The branch no longer has it.
    if (!theirs) {
      if (mine) {
        // Kept or written here while the branch lost it: back out. Even a
        // file another tool deleted comes back (see the deletion note).
        await send(path);
      }
      continue;
    }
    // The folder no longer has it.
    if (!mine) {
      if (theirs === remembered?.remote) {
        // Deleted here, untouched there: the deletion goes out.
        await store.remove(path);
        result.removed++;
      } else {
        // Changed there while deleted here: the change comes in.
        downloads.push({
          path,
          bytes: await store.mirrorBlob(theirs),
          expected: null,
          from: theirs,
        });
      }
      continue;
    }
    if (!remembered) {
      // Both sides have it, but this device has never synced it - the
      // first connection to a repository that already carries files. The
      // contents decide: the same bytes are just there; different ones
      // are a change nobody remembers, so the folder wins and the
      // branch's version is kept as a conflict copy.
      const bytes = await store.mirrorBlob(theirs);
      if ((await hash(bytes)) === mine) {
        next[path] = { local: mine, remote: theirs };
        result.unchanged++;
      } else {
        const copy = conflictName(path, new Date());
        downloads.push({ path: copy, bytes, expected: null, from: theirs });
        await send(path);
        result.conflicts.push(copy);
      }
      continue;
    }
    if (theirs === remembered?.remote && mine === remembered?.local) {
      next[path] = { local: mine, remote: theirs };
      result.unchanged++;
      continue;
    }
    if (theirs === remembered?.remote) {
      await send(path); // only this device changed it
      continue;
    }
    if (mine === remembered?.local) {
      // Only the branch changed it: the change comes in.
      downloads.push({
        path,
        bytes: await store.mirrorBlob(theirs),
        expected: mine,
        from: theirs,
      });
      continue;
    }
    // Both changed: the folder wins, the branch's version is kept beside
    // it as a conflict copy; both go out with this commit and the next.
    const bytes = await store.mirrorBlob(theirs);
    const copy = conflictName(path, new Date());
    downloads.push({ path: copy, bytes, expected: null, from: theirs });
    await send(path);
    result.conflicts.push(copy);
  }

  progress?.("downloading", 0, downloads.length);
  let arrived = 0;
  for (const one of downloads) {
    checkAbort(signal);
    progress?.("downloading", arrived++, downloads.length);
    const applied = await local.apply(one.path, one.bytes, one.expected);
    if (applied === true) {
      result.downloaded++;
      if (!OWN.test(one.path))
        next[one.path] = { local: await hash(one.bytes), remote: one.from };
    } else if (applied === "deferred") {
      result.deferred.push(one.path);
    }
    // False: the file changed here meanwhile. It stays out of the base,
    // so the next sync takes it as both-sides-changed.
  }

  progress?.("uploading", 0, uploads.size);
  let sent = 0;
  for (const [path, bytes] of uploads) {
    checkAbort(signal);
    progress?.("uploading", sent++, uploads.size);
    await store.put(path, bytes);
  }
  const committed = await store.commit("Textus sync");
  result.uploaded = committed.size;
  for (const [path, sha] of committed) {
    const bytes = uploads.get(path);
    // The sha must match what the commit carries, not what the folder
    // may hold now.
    next[path] = { local: bytes ? await hash(bytes) : "", remote: sha };
  }

  // Deferred work stays out of the base, so the next sync sees the file
  // as still to do.
  for (const path of result.deferred) delete next[path];
  await saveBase(next);
  return result;
}
