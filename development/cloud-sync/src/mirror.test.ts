import { describe, expect, it } from "vitest";
import { GitHubStore } from "./github-store";
import { mirrorSync, parseMirrorBase, type MirrorBase } from "./mirror";
import { MemoryLocal } from "./test-fixtures";
import { bytes, text } from "./test-fixtures";
import { normalizeConfig } from "./config";
import type { Fetch } from "./transport";

/** A fake of the GitHub API that keeps one branch and its tree, and
 *  refuses what GitHub refuses: a deletion of a path its base tree
 *  doesn't have, a commit that would empty the tree. */
const github = (files: Record<string, string> = {}) => {
  const tree = new Map<string, string>(); // path to blob sha
  const blobs = new Map<string, string>(); // sha to content
  let n = 0;
  /** Another tool pushing: a real change, so a real new blob sha. */
  /** Git's object name for the content, as GitHub's tree reports it. */
  const gitSha = (content: string) => {
    const body = Buffer.from(content);
    return require("crypto")
      .createHash("sha1")
      .update(Buffer.concat([Buffer.from(`blob ${body.length}\0`), body]))
      .digest("hex");
  };
  const push = (path: string, content: string) => {
    blobs.set(gitSha(content), content);
    tree.set(path, gitSha(content));
  };
  /** A blob too big for the plugin bridge to carry into the plugin, in the
   *  words the host uses for it. */
  const overBridge = new Set<string>();
  const tooBig = (path: string) => overBridge.add(tree.get(path)!);
  for (const [p, c] of Object.entries(files)) push(p, c);
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status }) as never;
  const fetch: Fetch = (async (url, init) => {
    const method = init?.method ?? "GET";
    const path = String(url).replace(
      "https://api.github.com/repos/owner/notes",
      "",
    );
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (method === "GET" && path === "")
      return json(200, { default_branch: "main" });
    if (method === "GET" && path === "/branches/main")
      return json(200, {
        commit: { sha: "c", commit: { tree: { sha: "t" } } },
      });
    if (method === "GET" && path.startsWith("/git/trees/"))
      return json(200, {
        tree: [...tree].map(([p, sha]) => ({ path: p, sha, type: "blob" })),
      });
    if (method === "GET" && path.startsWith("/git/blobs/")) {
      const sha = decodeURIComponent(path.slice("/git/blobs/".length));
      // Past the host's own limit the bytes never arrive: the bridge says
      // so instead, and retrying it would say the same.
      if (overBridge.has(sha))
        throw Error("plugin_http: The response is too big.");
      // The raw media type, as the store asks for it: bytes, no base64.
      return blobs.has(sha)
        ? (new Response(blobs.get(sha)!, { status: 200 }) as never)
        : json(404, {});
    }
    if (method === "POST" && path === "/git/blobs") {
      const content = Buffer.from(body.content, "base64").toString("utf8");
      blobs.set(gitSha(content), content);
      return json(201, { sha: gitSha(content) });
    }
    if (method === "POST" && path === "/git/trees") {
      const after = new Map(tree);
      for (const item of body.tree as { path: string; sha: string | null }[])
        if (item.sha === null) after.delete(item.path);
        else after.set(item.path, item.sha);
      // GitHub refuses a commit that would empty the tree (404 in the
      // wild), but a deletion leaving other files is ordinary.
      if (!after.size && tree.size) return json(422, {});
      tree.clear();
      for (const [p, sha] of after) tree.set(p, sha);
      return json(201, { sha: `tree-${++n}` });
    }
    if (method === "POST" && path === "/git/commits")
      return json(201, { sha: `c-${++n}` });
    if (method === "PATCH" && path === "/git/refs/heads/main")
      return json(200, {});
    return json(404, {});
  }) as Fetch;
  return { fetch, tree: () => tree, push, tooBig };
};

const store = (fetch: Fetch) =>
  new GitHubStore(
    normalizeConfig({ provider: "github", bucket: "notes" }),
    { account: "owner", secret: "test-only-secret" },
    fetch,
    () => new Promise(() => {}),
  );

/** A first sync of a folder to an empty repository. */
const base = async (
  fake: ReturnType<typeof github>,
  files: Record<string, string>,
  remembered: MirrorBase = {},
) => {
  const local = new MemoryLocal(files);
  const saved: MirrorBase[] = [];
  const result = await mirrorSync({
    store: store(fake.fetch),
    local,
    base: remembered,
    saveBase: async (next) => {
      saved.push(next);
    },
  });
  return { local, result, saved: saved[0] };
};

describe("a mirror sync", () => {
  it("uploads the folder to an empty repository as real files", async () => {
    const fake = github();
    const { result, saved } = await base(fake, {
      "notes/a.md": "a",
      "notes/deep/b.md": "b",
    });
    expect(result.uploaded).toBe(2);
    expect([...fake.tree().keys()].sort()).toEqual([
      "notes/a.md",
      "notes/deep/b.md",
    ]);
    expect(Object.keys(saved!)).toHaveLength(2);
  });

  it("downloads what the branch gained, in one unchanged sync after", async () => {
    const fake = github();
    const first = await base(fake, { "a.md": "a" });
    const remembered = first.saved!;
    fake.push("b.md", "b");
    const local = new MemoryLocal({ "a.md": "a" });
    const kept: MirrorBase[] = [];
    const result = await mirrorSync({
      store: store(fake.fetch),
      local,
      base: remembered,
      saveBase: async (next) => {
        kept.push(next);
      },
    });
    expect(result.downloaded).toBe(1);
    expect(await local.read("b.md")).toEqual(bytes("b"));
    const again = await mirrorSync({
      store: store(fake.fetch),
      local,
      base: kept[0],
      saveBase: async () => {},
    });
    expect(again.unchanged).toBe(2);
    expect(again.uploaded).toBe(0);
  });

  it("takes the folder's version when both sides changed, keeping a copy", async () => {
    const fake = github({ "a.md": "first" });
    const first = await base(fake, { "a.md": "first" });
    // Another tool pushes while the folder changes too.
    fake.push("a.md", "branch version");
    const local = new MemoryLocal({ "a.md": "folder version" });
    const result = await mirrorSync({
      store: store(fake.fetch),
      local,
      base: first.saved!,
      saveBase: async () => {},
    });
    expect(result.conflicts).toHaveLength(1);
    expect(await local.read("a.md")).toEqual(bytes("folder version"));
    const copy = result.conflicts[0];
    expect(copy).toContain("conflict");
    // The branch keeps the folder's version; the copy goes out next sync.
    expect(fake.tree().has(copy)).toBe(false);
    expect(result.uploaded).toBe(1);
  });

  it("brings back a file another tool deleted on the branch", async () => {
    const fake = github();
    const first = await base(fake, { "a.md": "a", "b.md": "b" });
    fake.tree().delete("b.md"); // another tool pushed a deletion
    const local = new MemoryLocal({ "a.md": "a", "b.md": "b" });
    const result = await mirrorSync({
      store: store(fake.fetch),
      local,
      base: first.saved!,
      saveBase: async () => {},
    });
    expect(result.uploaded).toBe(1); // b.md back out
    expect(fake.tree().has("b.md")).toBe(true);
    expect(result.removed).toBe(0);
  });

  it("sends a deletion made in the folder to the branch", async () => {
    const fake = github();
    const first = await base(fake, { "a.md": "a", "b.md": "b" });
    const local = new MemoryLocal({ "a.md": "a" }); // b.md deleted here
    const result = await mirrorSync({
      store: store(fake.fetch),
      local,
      base: first.saved!,
      saveBase: async () => {},
    });
    expect(result.removed).toBe(1);
    expect(fake.tree().has("b.md")).toBe(false);
    expect(fake.tree().has("a.md")).toBe(true);
  });

  it("re-uploads the whole folder when the branch was emptied", async () => {
    const fake = github();
    const local = new MemoryLocal({ "a.md": "a", "b.md": "b" });
    const result = await mirrorSync({
      store: store(fake.fetch),
      local,
      base: {
        "a.md": { local: "was", remote: "blob-of-a.md" },
        "b.md": { local: "was", remote: "blob-of-b.md" },
      },
      saveBase: async () => {},
    });
    expect(result.uploaded).toBe(2);
    expect(result.downloaded).toBe(0);
    expect(result.removed).toBe(0);
    expect([...fake.tree().keys()].sort()).toEqual(["a.md", "b.md"]);
  });

  it("ignores the chunked sync's own v1 folder", async () => {
    const fake = github({ "v1/head.json": "{}", "keep.md": "keep" });
    const local = new MemoryLocal({ "keep.md": "keep" });
    const result = await mirrorSync({
      store: store(fake.fetch),
      local,
      base: {},
      saveBase: async () => {},
    });
    expect(result.downloaded).toBe(0);
    expect(await local.read("v1/head.json")).toBeNull();
  });
});

describe("a mirror base", () => {
  it("leaves a file the plugin bridge cannot carry, and syncs the rest", async () => {
    // The repository holds a file this Textus build's bridge can't hand to
    // the plugin; the folder never had it.
    const fake = github({ "big.pdf": "b".repeat(40), "note.md": "n" });
    fake.tooBig("big.pdf");
    const { local, result } = await base(fake, { "note.md": "n" });
    expect(result.unreachable).toEqual(["big.pdf"]);
    expect(result.downloaded).toBe(0);
    expect(result.unchanged).toBe(1);
    expect(await local.read("big.pdf")).toBeNull();
  });

  it("keeps the folder's copy of a file it cannot fetch", async () => {
    const fake = github({ "big.pdf": "one", "note.md": "n" });
    const first = await base(fake, { "big.pdf": "one", "note.md": "n" });
    // Another tool rewrites the big file and adds one the bridge can carry.
    fake.push("big.pdf", "two");
    fake.push("small.md", "s");
    fake.tooBig("big.pdf");
    const local = new MemoryLocal({ "big.pdf": "one", "note.md": "n" });
    const result = await mirrorSync({
      store: store(fake.fetch),
      local,
      base: first.saved!,
      saveBase: async () => {},
    });
    expect(result.unreachable).toEqual(["big.pdf"]);
    expect(result.downloaded).toBe(1); // small.md came in
    expect(text(await local.read("big.pdf"))).toBe("one"); // left as it was
    expect(text(await local.read("small.md"))).toBe("s");
  });

  it("reads only the entries with both sides", () => {
    const parsed = parseMirrorBase({
      files: {
        good: { local: "a", remote: "b" },
        half: { local: "a" },
        wrong: "nope",
      },
    });
    expect(parsed).toEqual({ good: { local: "a", remote: "b" } });
    expect(parseMirrorBase(null)).toEqual({});
  });
});
