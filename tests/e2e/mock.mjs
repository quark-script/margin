// In-memory stand-in for the Supabase endpoints the app uses: GoTrue (auth), PostgREST
// (notes.pages, with the same RLS/trigger semantics we verified on the real DB), Realtime.
export const SUPA = "https://test.supabase.co";
export const UID = "5c9a7e1f-3b2d-4c8e-9f60-1a2b3c4d5e6f";
export const EMAIL = "me@example.com";
export const PASSWORD = "short1"; // < 8 chars on purpose: sign-in must not enforce minLength

// A second account, for people editing through a share link.
export const GUEST_UID = "9c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f";
export const GUEST_EMAIL = "rahul@example.com";
export const GUEST_PASSWORD = "guest-password";

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
// Someone who signs in with Google: comes with a name and photo.
export const GOOGLE_UID = "4e5f6a7b-8c9d-4e0f-a1b2-c3d4e5f6a7b8";
export const GOOGLE_EMAIL = "gina@example.com";
const accounts = { [UID]: EMAIL, [GUEST_UID]: GUEST_EMAIL, [GOOGLE_UID]: GOOGLE_EMAIL };
const metadata = { [GOOGLE_UID]: { full_name: "Gina Google", avatar_url: "https://lh3.example.com/gina.png" } };
// A 1x1 image: stands in for stored images and profile photos.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
export const jwt = (exp = Math.floor(Date.now() / 1000) + 3600, uid = UID) =>
  `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: uid, role: "authenticated", exp, email: accounts[uid], aud: "authenticated" })}.c2ln`;
const userFor = (uid) => ({ id: uid, aud: "authenticated", role: "authenticated", email: accounts[uid], app_metadata: { provider: metadata[uid] ? "google" : "email" }, user_metadata: metadata[uid] ?? {}, identities: [{ provider: metadata[uid] ? "google" : "email" }], created_at: "2026-08-26T12:21:48Z" });
const user = userFor(UID);
// How long a session lasts. Tests shorten it to make the app refresh soon.
let sessionSeconds = 3600;
export const setSessionSeconds = (n) => { sessionSeconds = n; };
const session = (uid = UID) => ({ access_token: jwt(undefined, uid), token_type: "bearer", expires_in: sessionSeconds, expires_at: Math.floor(Date.now() / 1000) + sessionSeconds, refresh_token: `rt-${uid}-${Math.random()}`, user: userFor(uid) });
/** auth.uid() for a request: the signed-in user's id, or null for the publishable key. */
function uidOf(req) {
  const t = (req.headers()["authorization"] ?? "").replace(/^Bearer /, "");
  try { const c = JSON.parse(Buffer.from(t.split(".")[1], "base64url").toString()); return c.role === "authenticated" ? c.sub : null; } catch { return null; }
}

let tick = 0;
// Postgres-style timestamp with microseconds and +00:00, strictly increasing.
export const pgNow = () => {
  const d = new Date(Date.now());
  const us = String((d.getMilliseconds() * 1000 + (tick++ % 1000))).padStart(6, "0");
  return d.toISOString().slice(0, 19) + "." + us + "+00:00";
};

export function createBackend() {
  const db = new Map(); // id -> row
  const log = [];
  const sockets = new Set();
  let failNext = null;
  const shares = new Map(); // page_id -> { page_id, token, can_edit }
  const locks = new Map(); // page_id -> { editor, expires }
  let cur = null; // auth.uid() of the request being handled
  // notes.page_versions + the record_version trigger. gapMs stands in for the 10-minute idle rule.
  const versions = [];
  let versionSeq = 1;
  // notes.content_signature: what a version looks like, without block ids, default styling or empty lines.
  const DEFAULT_STYLE = { textColor: "default", backgroundColor: "default", textAlignment: "left", isToggleable: false, checked: false };
  function looks(row) {
    const empty = (n) => n && typeof n === "object" && ((Array.isArray(n.content) && !n.content.length && !n.children && n.type !== "tableCell") || (n.type === "text" && n.text === "" && !n.styles));
    const clean = (x) => {
      if (Array.isArray(x)) return x.map(clean).filter((n) => !empty(n));
      if (!x || typeof x !== "object") return x;
      const o = {};
      for (const [k, v] of Object.entries(x)) {
        if (k === "id" || DEFAULT_STYLE[k] === v) continue;
        const c = clean(v);
        if ((k === "props" || k === "styles") && c && !Object.keys(c).length) continue;
        if (k === "children" && Array.isArray(c) && !c.length) continue;
        o[k] = c;
      }
      return o;
    };
    return JSON.stringify([(row.title ?? "").trim(), row.icon ?? null, clean(row.content ?? [])]);
  }
  function recordVersion(row, old) {
    if (old && JSON.stringify(old.content) === JSON.stringify(row.content) && old.title === row.title && (old.icon ?? null) === (row.icon ?? null)) return;
    if (!old && (!row.content || row.content.length === 0) && !row.title) return;
    const editor = cur ?? row.owner_id;
    const sig = looks(row);
    const mine = versions.filter((x) => x.page_id === row.id);
    const v = mine.at(-1);
    if (v && !v.sealed && v.edited_by === editor && Date.now() - v.savedMs < state.versionGapMs) {
      if (mine.at(-2)?.sig === sig) versions.splice(versions.indexOf(v), 1); // back to how the version before looked
      else Object.assign(v, { title: row.title, icon: row.icon, content: row.content, sig, saved_at: new Date().toISOString(), savedMs: Date.now() });
    } else if (v?.sig !== sig) {
      versions.push({ id: versionSeq++, page_id: row.id, owner_id: row.owner_id, title: row.title, icon: row.icon, content: row.content, sig, edited_by: editor, saved_at: new Date().toISOString(), savedMs: Date.now(), sealed: false });
    }
  }
  const state = { googleEnabled: true, googleCancel: false, versionGapMs: 600000, db, log, sockets, shares, locks, signups: 0, recovers: 0, passwordUpdated: null, failWrites(code) { failNext = code; } };

  // Same rules as notes.share_pages: shared page + non-trashed descendants; nothing if it (or an ancestor) is trashed.
  function sharePages(token) {
    const sh = [...shares.values()].find((x) => x.token === token);
    if (!sh || !db.get(sh.page_id)) return null;
    for (let p = db.get(sh.page_id); p; p = p.parent_id ? db.get(p.parent_id) : null) if (p.is_archived) return null;
    const ids = [sh.page_id];
    for (let i = 0; i < ids.length; i++) for (const r of db.values()) if (r.parent_id === ids[i] && !r.is_archived) ids.push(r.id);
    return { sh, ids };
  }
  // notes.page_subtree: a page plus its non-trashed descendants; empty if it or an ancestor is trashed.
  function subtree(root) {
    if (!db.get(root)) return [];
    for (let p = db.get(root); p; p = p.parent_id ? db.get(p.parent_id) : null) if (p.is_archived) return [];
    const ids = [root];
    for (let i = 0; i < ids.length; i++) for (const r of db.values()) if (r.parent_id === ids[i] && !r.is_archived) ids.push(r.id);
    return ids;
  }
  const members = []; // notes.page_members rows
  const myEmail = () => (cur ? accounts[cur] : null);
  function memberAccess(pageId) {
    const mine = members.filter((m) => m.email === myEmail() && subtree(m.page_id).includes(pageId));
    mine.sort((a, b) => Number(b.can_edit) - Number(a.can_edit));
    return mine[0] ?? null;
  }
  const memberCanEdit = (pageId) => Boolean(memberAccess(pageId)?.can_edit);
  // notes.page_grant: best access to a page for the caller (invite or "anyone with the link").
  function pageGrant(pageId) {
    const chain = [];
    for (let p = db.get(pageId); p && chain.length < 200; p = p.parent_id ? db.get(p.parent_id) : null) chain.push(p);
    if (!chain.length || chain.some((p) => p.is_archived)) return null;
    const grants = [];
    chain.forEach((p, depth) => {
      for (const m of members) if (m.page_id === p.id && m.email === myEmail()) grants.push({ root_id: p.id, can_edit: m.can_edit, via: "invite", depth });
      const sh = shares.get(p.id);
      if (sh) grants.push({ root_id: p.id, can_edit: sh.can_edit, via: "link", depth });
    });
    const usable = (g) => Number(g.can_edit && (g.via === "invite" || cur != null));
    grants.sort((a, b) => usable(b) - usable(a) || Number(b.via === "invite") - Number(a.via === "invite") || b.depth - a.depth);
    return grants[0] ?? null;
  }
  // notes.can_manage_sharing / notes.page_sharing and the share_* functions for people with full access.
  const roleOf = (m) => (m.can_share ? "full" : m.can_edit ? "edit" : "view");
  const uidOfEmail = (email) => Object.keys(accounts).find((id) => accounts[id] === email) ?? null;
  const nameOf = (uid) => (uid ? metadata[uid]?.full_name ?? accounts[uid]?.split("@")[0] ?? null : null);
  const canManage = (pageId) => owns(pageId) || members.some((m) => m.email === myEmail() && m.can_share && subtree(m.page_id).includes(pageId));
  const err = (code, status = 400) => Object.assign(new Error(code), { code, status });
  function pageSharing(pageId) {
    const page = db.get(pageId);
    if (!page) return null;
    const isOwner = page.owner_id === cur;
    if (!isOwner && pageGrant(pageId)?.via !== "invite") return null;
    const chain = [];
    for (let p = page; p && chain.length < 200; p = p.parent_id ? db.get(p.parent_id) : null) chain.push(p);
    const best = new Map();
    chain.forEach((p, depth) => {
      for (const m of members.filter((x) => x.page_id === p.id)) {
        const prev = best.get(m.email);
        const rank = (x) => (x.can_share ? 2 : x.can_edit ? 1 : 0);
        if (!prev || rank(m) > rank(prev.m)) best.set(m.email, { m, depth, via: p });
      }
    });
    const manage = canManage(pageId);
    const me = myEmail();
    const people = [...best.values()].sort((a, b) => a.depth - b.depth || a.m.created_at.localeCompare(b.m.created_at)).map(({ m, depth, via }) => ({
      email: manage || m.email === me ? m.email : null,
      name: nameOf(uidOfEmail(m.email)),
      role: roleOf(m),
      you: m.email === me,
      via: depth > 0 ? { id: via.id, title: via.title } : null,
    }));
    const linkAt = chain.findIndex((p) => shares.has(p.id));
    return {
      can_manage: manage,
      role: isOwner ? "owner" : people.find((p) => p.you)?.role ?? null,
      owner: { name: nameOf(page.owner_id), email: accounts[page.owner_id] ?? null },
      people,
      link: linkAt < 0 ? null : { can_edit: shares.get(chain[linkAt].id).can_edit, via: linkAt > 0 ? { id: chain[linkAt].id, title: chain[linkAt].title } : null },
    };
  }
  const flags = (role) => ({ can_edit: role !== "view", can_share: role === "full" });
  const treeRow = (id) => { const r = db.get(id); return { id, parent_id: r.parent_id, title: r.title, icon: r.icon, content: r.content, position: r.position, created_at: r.created_at, updated_at: r.updated_at }; };
  const myMembership = (root) => members.find((m) => m.page_id === root && m.email === myEmail() && subtree(root).length);
  const lockHolder = (id) => { const l = locks.get(id); return l && l.expires > Date.now() ? l.editor : null; };
  const lockName = (id) => { const l = locks.get(id); return l?.uid ? accounts[l.uid]?.split("@")[0] ?? null : null; };
  function takeLock(id, editor) {
    const h = lockHolder(id);
    if (h && h !== editor) return false;
    locks.set(id, { editor, uid: cur, expires: Date.now() + 30000 });
    return true;
  }
  // notes.my_media_bytes / notes.unused_files over state.objects (keys are "notes-media/<uid>/<file>").
  const myFiles = () => [...state.objects.entries()].filter(([k]) => k.startsWith(`notes-media/${cur}/`));
  const mediaBytes = () => myFiles().reduce((n, [, o]) => n + o.bytes.length, 0) + state.extraUsage;
  // notes.page_views with notes.page_presence / record_link_view / forget_my_views.
  const pageViews = new Map(); // `${page_id}|${user_id}` -> { page_id, user_id, last_seen, here_until, visits }
  state.pageViews = pageViews;
  state.presenceWindowMs = 25000;
  const hidesViews = (uid) => Boolean(metadata[uid]?.hide_views);
  function invitedOrOwner(pageId, uid) {
    const page = db.get(pageId);
    if (!page || !uid) return false;
    return page.owner_id === uid || members.some((m) => m.email === accounts[uid] && subtree(m.page_id).includes(pageId));
  }
  const rpcs = {
    page_presence: ({ p_page_id, p_here = true }) => {
      const page = db.get(p_page_id);
      if (!cur || !page || !invitedOrOwner(p_page_id, cur)) return null;
      const now = Date.now();
      if (!hidesViews(cur)) {
        const key = `${p_page_id}|${cur}`;
        const v = pageViews.get(key);
        const here_until = p_here ? now + state.presenceWindowMs : now;
        if (v) Object.assign(v, { visits: v.visits + (v.last_seen < now - 30 * 60000 ? 1 : 0), last_seen: now, here_until });
        else pageViews.set(key, { page_id: p_page_id, user_id: cur, last_seen: now, here_until, visits: 1 });
      }
      const ownerView = page.owner_id === cur;
      const people = [...pageViews.values()]
        .filter((v) => v.page_id === p_page_id && v.user_id !== cur && (v.here_until > now || (ownerView && v.user_id !== page.owner_id)) && !hidesViews(v.user_id) && invitedOrOwner(p_page_id, v.user_id))
        .sort((a, b) => Number(b.here_until > now) - Number(a.here_until > now) || b.last_seen - a.last_seen)
        .map((v) => {
          const l = locks.get(p_page_id);
          return {
            id: v.user_id, name: nameOf(v.user_id), avatar: metadata[v.user_id]?.avatar_url ?? null,
            email: ownerView || v.user_id === page.owner_id ? accounts[v.user_id] : null,
            owner: v.user_id === page.owner_id, here: v.here_until > now,
            editing: Boolean(l && l.uid === v.user_id && l.expires > now),
            last_seen_at: ownerView ? new Date(v.last_seen).toISOString() : null,
            visits: ownerView ? v.visits : null,
          };
        });
      return { owner_view: ownerView, people };
    },
    record_link_view: ({ p_page_id }) => {
      if (cur && invitedOrOwner(p_page_id, cur)) return null;
      const g = pageGrant(p_page_id);
      const sh = g?.via === "link" ? shares.get(g.root_id) : null;
      if (sh) Object.assign(sh, { views: (sh.views ?? 0) + 1, last_viewed_at: new Date().toISOString() });
      return null;
    },
    forget_my_views: () => { if (!cur) throw 42501; for (const [k, v] of pageViews) if (v.user_id === cur) pageViews.delete(k); return null; },
    can_manage_sharing: ({ p_page_id }) => canManage(p_page_id),
    page_sharing: ({ p_page_id }) => pageSharing(p_page_id),
    share_invite: ({ p_page_id, p_email, p_role }) => {
      if (!canManage(p_page_id)) throw err("42501", 403);
      const email = String(p_email).trim().toLowerCase();
      const owner = db.get(p_page_id).owner_id;
      if (email === accounts[owner] || members.some((m) => m.page_id === p_page_id && m.email === email)) throw err("23505", 409);
      members.push({ page_id: p_page_id, owner_id: owner, email, ...flags(p_role), created_at: new Date().toISOString() });
      return null;
    },
    share_set_role: ({ p_page_id, p_email, p_role }) => {
      if (!canManage(p_page_id) || p_email === myEmail()) throw err("42501", 403);
      members.filter((m) => m.page_id === p_page_id && m.email === p_email).forEach((m) => Object.assign(m, flags(p_role)));
      return null;
    },
    share_remove: ({ p_page_id, p_email }) => {
      if (!canManage(p_page_id) || p_email === myEmail()) throw err("42501", 403);
      for (let i = members.length - 1; i >= 0; i--) if (members[i].page_id === p_page_id && members[i].email === p_email) members.splice(i, 1);
      return null;
    },
    share_set_link: ({ p_page_id, p_mode }) => {
      if (!canManage(p_page_id)) throw err("42501", 403);
      if (p_mode === "off") shares.delete(p_page_id);
      else shares.set(p_page_id, { ...(shares.get(p_page_id) ?? { page_id: p_page_id, token: "tok" + Math.random().toString(36).slice(2, 14) }), can_edit: p_mode === "edit" });
      return null;
    },
    my_media_bytes: () => mediaBytes(),
    unused_files: () => {
      const used = new Set();
      for (const r of db.values()) for (const m of JSON.stringify(r.content ?? []).matchAll(/notes-media:([^"\\]+)/g)) used.add(m[1]);
      return myFiles()
        .filter(([k, o]) => Date.now() - o.at >= state.unusedAfterMs && !used.has(k.slice("notes-media/".length)))
        .map(([k, o]) => ({ name: k.slice("notes-media/".length), size: o.bytes.length }));
    },
    shared_pages: ({ p_token }) => { const s = sharePages(p_token); if (!s) return null;
      return { can_edit: s.sh.can_edit, root_id: s.sh.page_id, pages: s.ids.map((id) => { const r = db.get(id); return { id, parent_id: r.parent_id, title: r.title, icon: r.icon, content: r.content, position: r.position, created_at: r.created_at, updated_at: r.updated_at }; }) }; },
    shared_state: ({ p_token }) => { const s = sharePages(p_token); if (!s) return null;
      return { can_edit: s.sh.can_edit, pages: s.ids.map((id) => ({ id, updated_at: db.get(id).updated_at })), locks: s.ids.filter(lockHolder).map((id) => ({ page_id: id, editor: lockHolder(id), name: lockName(id) })) }; },
    lock_page: ({ p_page_id, p_editor, p_token }) => {
      if (!cur) throw 42501; // editing needs an account
      if (p_token == null) { if (!owns(p_page_id) && !pageGrant(p_page_id)?.can_edit) throw 42501; }
      else { const s = sharePages(p_token); if (!s || !s.sh.can_edit || !s.ids.includes(p_page_id)) throw 42501; }
      return { ok: takeLock(p_page_id, p_editor) }; },
    unlock_page: ({ p_page_id, p_editor }) => { if (lockHolder(p_page_id) === p_editor) locks.delete(p_page_id); return null; },
    page_lock_state: ({ p_page_id }) => lockHolder(p_page_id),
    page_history_v2: ({ p_page_id }) => { if (!owns(p_page_id) && !memberCanEdit(p_page_id)) return [];
      return versions.filter((v) => v.page_id === p_page_id).reverse().map((v) => ({ id: v.id, title: v.title, saved_at: v.saved_at, editor: accounts[v.edited_by]?.split("@")[0] ?? null, mine: v.edited_by === cur, via: v.via ?? null })); },
    my_agent_activity: () => (cur ? state.agentActivity.get(cur) ?? [] : []),
    page_history: ({ p_page_id }) => { if (!owns(p_page_id) && !memberCanEdit(p_page_id)) return [];
      return versions.filter((v) => v.page_id === p_page_id).reverse().map((v) => ({ id: v.id, title: v.title, saved_at: v.saved_at, editor: accounts[v.edited_by]?.split("@")[0] ?? null, mine: v.edited_by === cur })); },
    page_version: ({ p_id }) => { const v = versions.find((x) => x.id === p_id);
      return v && (owns(v.page_id) || memberCanEdit(v.page_id)) ? { title: v.title, icon: v.icon, content: v.content } : null; },
    page_lock_info: ({ p_page_id }) => { const h = lockHolder(p_page_id); return h && owns(p_page_id) ? { editor: h, name: lockName(p_page_id) } : null; },
    shared_with_me: () => members.filter((m) => m.email === myEmail() && subtree(m.page_id).length)
      .map((m) => ({ page_id: m.page_id, title: db.get(m.page_id).title, icon: db.get(m.page_id).icon, owner_name: accounts[m.owner_id]?.split("@")[0] ?? null, can_edit: m.can_edit })),
    member_pages: ({ p_root }) => { const m = myMembership(p_root); if (!m) return null;
      return { can_edit: m.can_edit, root_id: p_root, pages: subtree(p_root).map((id) => { const r = db.get(id); return { id, parent_id: r.parent_id, title: r.title, icon: r.icon, content: r.content, position: r.position, created_at: r.created_at, updated_at: r.updated_at }; }) }; },
    member_state: ({ p_root }) => { const m = myMembership(p_root); if (!m) return null; const ids = subtree(p_root);
      return { can_edit: m.can_edit, pages: ids.map((id) => ({ id, updated_at: db.get(id).updated_at })), locks: ids.filter(lockHolder).map((id) => ({ page_id: id, editor: lockHolder(id), name: lockName(id) })) }; },
    member_save: ({ p_page_id, p_editor, p_content, p_search_text }) => {
      if (!memberCanEdit(p_page_id)) throw 42501;
      if (lockHolder(p_page_id) !== p_editor) return { ok: false, reason: "lock" };
      const row = state.remoteWrite(p_page_id, { content: p_content, search_text: p_search_text });
      takeLock(p_page_id, p_editor);
      return { ok: true, updated_at: row.updated_at }; },
    member_restore: ({ p_id, p_editor, p_search_text }) => { const v = versions.find((x) => x.id === p_id);
      if (!v || !memberCanEdit(v.page_id)) throw 42501;
      if (lockHolder(v.page_id) !== p_editor) return { ok: false, reason: "lock" };
      versions.filter((x) => x.page_id === v.page_id).forEach((x) => (x.sealed = true));
      const row = state.remoteWrite(v.page_id, { title: v.title, icon: v.icon, content: v.content, search_text: p_search_text });
      return { ok: true, updated_at: row.updated_at }; },
    leave_shared: ({ p_root }) => { for (let i = members.length - 1; i >= 0; i--) if (members[i].page_id === p_root && members[i].email === myEmail()) members.splice(i, 1); return null; },
    shared_tree: ({ p_page_id }) => { const g = pageGrant(p_page_id); if (!g) return null;
      return { root_id: g.root_id, can_edit: g.can_edit, via: g.via, pages: subtree(g.root_id).map(treeRow) }; },
    shared_tree_state: ({ p_page_id }) => { const g = pageGrant(p_page_id); if (!g) return null; const ids = subtree(g.root_id);
      return { root_id: g.root_id, can_edit: g.can_edit, via: g.via, pages: ids.map((id) => ({ id, updated_at: db.get(id).updated_at })), locks: ids.filter(lockHolder).map((id) => ({ page_id: id, editor: lockHolder(id), name: lockName(id) })) }; },
    shared_page_save: ({ p_page_id, p_editor, p_content, p_search_text }) => {
      if (!cur || !pageGrant(p_page_id)?.can_edit) throw 42501;
      if (lockHolder(p_page_id) !== p_editor) return { ok: false, reason: "lock" };
      const row = state.remoteWrite(p_page_id, { content: p_content, search_text: p_search_text });
      takeLock(p_page_id, p_editor);
      return { ok: true, updated_at: row.updated_at }; },
    share_root: ({ p_token }) => [...shares.values()].find((x) => x.token === p_token)?.page_id ?? null,
    member_root_for: ({ p_page_id }) => memberAccess(p_page_id)?.page_id ?? null,
    seal_page_versions: ({ p_page_id }) => { if (owns(p_page_id)) versions.filter((v) => v.page_id === p_page_id).forEach((v) => (v.sealed = true)); return null; },
    shared_save: ({ p_token, p_page_id, p_editor, p_content, p_search_text }) => {
      if (!cur) throw 42501;
      const s = sharePages(p_token); if (!s || !s.sh.can_edit || !s.ids.includes(p_page_id)) throw 42501;
      if (lockHolder(p_page_id) !== p_editor) return { ok: false, reason: "lock" };
      const row = state.remoteWrite(p_page_id, { content: p_content, search_text: p_search_text });
      takeLock(p_page_id, p_editor);
      return { ok: true, updated_at: row.updated_at }; },
  };

  const pgErr = (status, code, message) => ({ status, contentType: "application/json", body: JSON.stringify({ code, message, details: null, hint: null }) });
  const json = (status, body, headers = {}) => ({ status, contentType: "application/json", headers, body: JSON.stringify(body) });

  function parseFilters(url) {
    const f = [];
    for (const [k, v] of url.searchParams) {
      if (["select", "order", "limit", "offset", "on_conflict", "columns"].includes(k)) continue;
      const m = v.match(/^(gt|eq|in)\.(.*)$/);
      if (m) f.push({ col: k, op: m[1], val: m[1] === "in" ? m[2].replace(/^\(|\)$/g, "").split(",").map((s) => s.replace(/^"|"$/g, "")) : m[2] });
    }
    return f;
  }
  const match = (row, f) => f.every(({ col, op, val }) => (op === "gt" ? String(row[col]) > val : op === "eq" ? String(row[col]) === val : val.includes(row[col])));
  const pick = (row, select) => (select && select !== "*" ? Object.fromEntries(select.split(",").map((c) => [c, row[c]])) : row);

  function owns(id) { const r = db.get(id); return r && r.owner_id === cur; }

  function upsert(rows) {
    if (failNext) { const c = failNext; failNext = null; return { err: pgErr(500, c, "injected failure") }; }
    // validate all first: statement is atomic
    for (const r of rows) {
      if (r.owner_id !== cur) return { err: pgErr(403, "42501", 'new row violates row-level security policy for table "pages"') };
      if (r.parent_id && !owns(r.parent_id)) return { err: pgErr(403, "42501", 'new row violates row-level security policy for table "pages"') };
      if (r.parent_id === r.id) return { err: pgErr(400, "23514", "check constraint") };
    }
    const out = [];
    for (const r of rows) {
      const old = db.get(r.id);
      const now = pgNow();
      const row = { ...(old ?? { archived_at: null, created_at: now }), ...r, updated_at: now };
      if (row.is_archived && !(old?.is_archived)) row.archived_at = now;
      else if (!row.is_archived) row.archived_at = null;
      db.set(r.id, row);
      recordVersion(row, old);
      out.push(row);
      broadcast(old ? "UPDATE" : "INSERT", row, old);
    }
    return { out };
  }

  function deleteCascade(ids) {
    const gone = [];
    const stack = [...ids.filter((id) => db.has(id))];
    while (stack.length) {
      const id = stack.pop();
      if (!db.has(id)) continue;
      gone.push(db.get(id));
      db.delete(id);
      for (const r of db.values()) if (r.parent_id === id) stack.push(r.id);
    }
    gone.forEach((r) => broadcast("DELETE", null, { id: r.id }));
    return gone;
  }

  // ---- realtime ----
  function broadcast(type, record, old) {
    for (const s of sockets) {
      for (const ch of s.channels.values()) {
        const ids = ch.bindings.filter((b) => (b.event === "*" || b.event === type) && (!b.filter || (record && b.filter === `owner_id=eq.${record.owner_id}`))).map((b) => b.id);
        if (!ids.length) continue;
        s.ws.send(JSON.stringify([null, null, ch.topic, "postgres_changes", { ids, data: { schema: "notes", table: "pages", commit_timestamp: new Date().toISOString(), type, record: record ?? undefined, old_record: old ?? undefined, columns: [], errors: null } }]));
      }
    }
  }
  /** Simulate another device writing directly (bypasses this client). */
  state.remoteWrite = (id, patch) => {
    const old = db.get(id);
    const now = pgNow();
    const row = { ...old, ...patch, updated_at: now };
    db.set(id, row);
    recordVersion(row, old);
    broadcast("UPDATE", row, old);
    return row;
  };
  state.remoteDelete = (id) => deleteCascade([id]);

  async function routeWs(ws) {
    const s = { ws, channels: new Map() };
    sockets.add(s);
    let nextId = 1;
    ws.onMessage((raw) => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      const [joinRef, ref, topic, event, payload] = m;
      const reply = (response) => ws.send(JSON.stringify([joinRef, ref, topic, "phx_reply", { status: "ok", response }]));
      if (event === "phx_join") {
        const pc = (payload?.config?.postgres_changes ?? []).map((b) => ({ ...b, id: nextId++ }));
        s.channels.set(topic, { topic, bindings: pc });
        reply({ postgres_changes: pc });
        ws.send(JSON.stringify([joinRef, null, topic, "system", { channel: topic.replace(/^realtime:/, ""), extension: "postgres_changes", message: "Subscribed to PostgreSQL", status: "ok" }]));
      } else if (event === "phx_leave") { s.channels.delete(topic); reply({}); }
      else reply({});
    });
    ws.onClose(() => sockets.delete(s));
  }

  async function routeHttp(route) {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;
    const method = req.method();
    log.push(`${method} ${p}${url.search}`);
    if (method === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    cur = uidOf(req);
    const send = (r) => route.fulfill({ ...r, headers: { ...cors, ...(r.headers ?? {}) } });
    const body = () => { try { return JSON.parse(req.postData() ?? "null"); } catch { return null; } };

    // ---- auth ----
    if (p === "/auth/v1/token") {
      const b = body();
      if (url.searchParams.get("grant_type") === "refresh_token") {
        const uid = b?.refresh_token?.split("-").slice(1, 6).join("-") || UID;
        state.refreshes = (state.refreshes ?? 0) + 1;
        // A deleted sign-in takes its refresh tokens with it.
        if (state.deletedUsers.has(uid)) return send(json(400, { code: 400, error_code: "refresh_token_not_found", msg: "Invalid Refresh Token: Refresh Token Not Found" }));
        return send(json(200, session(uid)));
      }
      if (b?.email === EMAIL && b?.password === (state.passwordUpdated ?? PASSWORD) && !state.deletedUsers.has(UID)) return send(json(200, session()));
      if (b?.email === GUEST_EMAIL && b?.password === GUEST_PASSWORD && !state.deletedUsers.has(GUEST_UID)) return send(json(200, session(GUEST_UID)));
      return send(json(400, { code: 400, error_code: "invalid_credentials", msg: "Invalid login credentials" }));
    }
    // ---- Supabase Auth's OAuth server (an AI app asking to connect) ----
    const authz = p.match(/^\/auth\/v1\/oauth\/authorizations\/([^/]+)(\/consent)?$/);
    if (authz) {
      if (!cur) return send(json(401, { code: 401, error_code: "no_authorization", msg: "This endpoint requires a valid Bearer token" }));
      const ask = state.oauthRequests.get(authz[1]);
      if (!ask) return send(json(404, { code: 404, error_code: "oauth_authorization_not_found", msg: "Authorization not found" }));
      const grants = state.oauthGrants.get(cur) ?? [];
      if (!authz[2] && method === "GET") {
        if (grants.some((g) => g.client.id === ask.client.id)) return send(json(200, { redirect_url: `${ask.redirect_uri}?code=again-${authz[1]}&state=s` }));
        return send(json(200, { authorization_id: authz[1], redirect_uri: ask.redirect_uri, client: ask.client, user: { id: cur, email: accounts[cur] }, scope: "email" }));
      }
      if (authz[2] && method === "POST") {
        const action = body()?.action;
        state.oauthDecisions.push({ id: authz[1], action, uid: cur });
        state.oauthRequests.delete(authz[1]);
        if (action !== "approve") return send(json(200, { redirect_url: `${ask.redirect_uri}?error=access_denied&state=s` }));
        if (!grants.some((g) => g.client.id === ask.client.id)) grants.push({ client: ask.client, scopes: ["email"], granted_at: new Date().toISOString() });
        state.oauthGrants.set(cur, grants);
        return send(json(200, { redirect_url: `${ask.redirect_uri}?code=code-${authz[1]}&state=s` }));
      }
    }
    if (p === "/auth/v1/user/oauth/grants") {
      if (!cur) return send(json(401, { code: 401, error_code: "no_authorization", msg: "This endpoint requires a valid Bearer token" }));
      if (method === "GET") return send(json(200, state.oauthGrants.get(cur) ?? []));
      if (method === "DELETE") {
        const id = url.searchParams.get("client_id");
        state.oauthGrants.set(cur, (state.oauthGrants.get(cur) ?? []).filter((g) => g.client.id !== id));
        return send({ status: 204, body: "" });
      }
    }
    if (p === "/auth/v1/settings") return send(json(200, { external: { email: true, google: state.googleEnabled }, disable_signup: false }));
    if (p === "/auth/v1/authorize") {
      // Stand-in for the trip to Google: straight back to the app, signed in (or cancelled).
      const back = new URL(url.searchParams.get("redirect_to"));
      state.lastAuthorize = { provider: url.searchParams.get("provider"), prompt: url.searchParams.get("prompt"), redirect: back.href };
      const s = session(GOOGLE_UID);
      back.hash = state.googleCancel
        ? "error=access_denied&error_code=access_denied&error_description=The+user+cancelled"
        : `access_token=${s.access_token}&expires_at=${s.expires_at}&expires_in=3600&refresh_token=${s.refresh_token}&token_type=bearer&provider_token=x`;
      return route.fulfill({ status: 302, headers: { location: back.href } });
    }
    if (p === "/auth/v1/verify" && method === "POST") {
      const b = body(); state.verified = b;
      if (b?.token_hash === "good") return send(json(200, session()));
      return send(json(403, { code: 403, error_code: "otp_expired", msg: "Email link is invalid or has expired" }));
    }
    if (p === "/auth/v1/signup") {
      state.signups++;
      state.lastSignup = { body: body(), redirect: url.searchParams.get("redirect_to") };
      if (!state.signupsOpen) return send(json(422, { code: 422, error_code: "signup_disabled", msg: "Signups not allowed for this instance" }));
      // Email confirmation on: a user but no session yet.
      return send(json(200, { id: "11111111-2222-4333-8444-555555555555", aud: "authenticated", role: "", email: body()?.email, identities: [{}], created_at: new Date().toISOString() }));
    }
    if (p === "/auth/v1/resend") { state.resends = (state.resends ?? 0) + 1; return send(json(200, {})); }
    if (p === "/auth/v1/recover") { state.recovers++; return send(json(200, {})); }
    if (p === "/auth/v1/user" && method === "GET") return send(json(200, userFor(cur ?? UID)));
    if (p === "/auth/v1/user" && method === "PUT") {
      const b = body() ?? {};
      if (b.password) state.passwordUpdated = b.password;
      if (b.data) metadata[cur] = { ...(metadata[cur] ?? {}), ...b.data };
      return send(json(200, userFor(cur ?? UID)));
    }
    if (p === "/auth/v1/logout") {
      state.logouts.push(url.searchParams.get("scope"));
      if (cur && state.deletedUsers.has(cur)) return send(json(403, { code: 403, error_code: "user_not_found", msg: "User from sub claim in JWT does not exist" }));
      return send({ status: 204, body: "" });
    }

    // ---- rest ----
    if (p === "/rest/v1/pages") {
      if (req.headers()["accept-profile"] !== "notes" && req.headers()["content-profile"] !== "notes")
        return send(pgErr(406, "PGRST106", "Invalid schema"));
      const select = url.searchParams.get("select");
      if (method === "GET") {
        let rows = [...db.values()].filter((r) => r.owner_id === cur).filter((r) => match(r, parseFilters(url)));
        const order = url.searchParams.get("order");
        if (order) { const [col] = order.split("."); rows.sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0)); }
        const offset = +(url.searchParams.get("offset") ?? 0);
        const limit = Math.min(+(url.searchParams.get("limit") ?? 1000), 1000); // PostgREST max-rows
        return send(json(200, rows.slice(offset, offset + limit).map((r) => pick(r, select))));
      }
      if (method === "POST") {
        const b = body();
        const { out, err } = upsert(Array.isArray(b) ? b : [b]);
        if (err) return send(err);
        return send(json(201, out.map((r) => pick(r, select))));
      }
      if (method === "DELETE") {
        const f = parseFilters(url);
        const ids = [...db.values()].filter((r) => r.owner_id === cur && match(r, f)).map((r) => r.id);
        deleteCascade(ids);
        return send({ status: 204, body: "" });
      }
    }
    if (p.startsWith("/rest/v1/rpc/")) {
      const fn = rpcs[p.slice("/rest/v1/rpc/".length)];
      if (!fn) return send(pgErr(404, "PGRST202", "no such function"));
      try { return send(json(200, fn(body() ?? {}))); }
      catch (e) { return send(e?.code ? pgErr(e.status ?? 400, e.code, e.code === "23505" ? "duplicate key value violates unique constraint" : "not allowed") : pgErr(403, "42501", "not allowed")); }
    }
    if (p === "/rest/v1/page_members") {
      const f = parseFilters(url);
      const own = () => members.filter((m) => m.owner_id === cur);
      if (method === "GET") return send(json(200, own().filter((m) => match(m, f)).map((m) => pick(m, url.searchParams.get("select")))));
      if (method === "POST") { const b = body(); const rows = Array.isArray(b) ? b : [b];
        for (const r of rows) {
          if (!owns(r.page_id)) return send(pgErr(403, "42501", "new row violates row-level security policy"));
          if (members.some((m) => m.page_id === r.page_id && m.email === r.email)) return send(pgErr(409, "23505", "duplicate key value violates unique constraint"));
          members.push({ owner_id: cur, can_edit: false, can_share: false, created_at: new Date().toISOString(), ...r });
        }
        return send({ status: 201, body: "" }); }
      if (method === "PATCH") { const b = body(); own().filter((m) => match(m, f)).forEach((m) => Object.assign(m, b)); return send({ status: 204, body: "" }); }
      if (method === "DELETE") { for (const m of own().filter((m) => match(m, f))) members.splice(members.indexOf(m), 1); return send({ status: 204, body: "" }); }
    }
    if (p === "/rest/v1/page_versions" && method === "GET") {
      const f = parseFilters(url);
      const rows = versions.filter((v) => v.owner_id === cur && match(v, f)).map((v) => pick(v, url.searchParams.get("select")));
      if ((req.headers()["accept"] ?? "").includes("vnd.pgrst.object")) return rows.length ? send(json(200, rows[0])) : send(pgErr(406, "PGRST116", "no rows"));
      return send(json(200, rows));
    }
    if (p === "/rest/v1/shares") {
      const f = parseFilters(url);
      if (method === "GET") return send(json(200, [...shares.values()].filter((r) => match(r, f))));
      if (method === "POST") { const b = body(); const row = shares.get(b.page_id) ?? { page_id: b.page_id, token: "tok" + Math.random().toString(36).slice(2, 14), can_edit: false, views: 0, last_viewed_at: null }; shares.set(b.page_id, row);
        return send(json(201, url.searchParams.get("select") ? row : [row])); }
      if (method === "PATCH") { const b = body(); for (const r of shares.values()) if (match(r, f)) Object.assign(r, b); return send({ status: 204, body: "" }); }
      if (method === "DELETE") { for (const r of [...shares.values()]) if (match(r, f)) shares.delete(r.page_id); return send({ status: 204, body: "" }); }
    }
    if (p === "/functions/v1/send-invite") {
      if (method === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
      const b = body();
      const m = members.find((x) => x.page_id === b?.page_id && x.email === b?.email);
      if (!m || !canManage(b.page_id)) return send(json(404, { error: "not found" }));
      state.invitesSent.push({ page_id: b.page_id, email: b.email, can_edit: m.can_edit, can_share: Boolean(m.can_share), by: cur });
      return send(json(200, state.inviteResult));
    }
    if (p === "/functions/v1/delete-account") {
      if (!cur || state.deletedUsers.has(cur)) return send(json(401, { error: "unauthorized" }));
      const b = body();
      state.deleteCalls.push({ uid: cur, confirm: b?.confirm });
      if (String(b?.confirm ?? "").trim().toLowerCase() !== accounts[cur]) return send(json(400, { error: "confirm" }));
      if (state.deleteResult) return send(json(state.deleteResult.status, state.deleteResult.body));
      // Same as the real function: images, invitations to their address, then the sign-in with
      // everything on it (cascade), their edits on other people's pages left without a name.
      for (const key of [...state.objects.keys()]) if (key.startsWith(`notes-media/${cur}/`)) state.objects.delete(key);
      for (const m of [...members]) if (m.email === accounts[cur] || m.owner_id === cur) members.splice(members.indexOf(m), 1);
      deleteCascade([...db.values()].filter((r) => r.owner_id === cur).map((r) => r.id));
      for (const id of [...shares.keys()]) if (!db.has(id)) shares.delete(id);
      for (let i = versions.length - 1; i >= 0; i--) if (versions[i].owner_id === cur) versions.splice(i, 1);
      for (const v of versions) if (v.edited_by === cur) v.edited_by = null;
      for (const [id, l] of [...locks]) if (l.uid === cur) locks.delete(id);
      state.deletedUsers.add(cur);
      return send(json(200, { deleted: true }));
    }
    if (p === "/functions/v1/share-file") {
      const page = url.searchParams.get("page");
      const ok = page ? (() => { const save = cur; cur = null; const g = pageGrant(page); cur = save; return g?.via === "link"; })() : sharePages(url.searchParams.get("token")) != null;
      return route.fulfill({ status: ok ? 200 : 404, contentType: "image/png", headers: cors, body: ok ? PNG : "" });
    }
    if (p.startsWith("/storage/v1/object/") && !p.includes("/sign/")) {
      const key = p.replace(/^\/storage\/v1\/object\/(authenticated\/|public\/)?/, "");
      if (method === "POST" || method === "PUT") {
        const bytes = route.request().postDataBuffer() ?? Buffer.alloc(0);
        state.uploads.push({ key, size: bytes.length });
        if (bytes.length > 10 * 1024 * 1024) return send(json(413, { statusCode: "413", error: "Payload too large", message: "The object exceeded the maximum allowed size" }));
        if (key.startsWith("notes-media/") && mediaBytes() >= state.storageLimit) return send(json(403, { statusCode: "403", error: "Unauthorized", message: "new row violates row-level security policy" }));
        state.objects.set(key, { bytes, type: route.request().headers()["content-type"], at: Date.now() });
        return send(json(200, { Key: key, Id: key }));
      }
      if (method === "DELETE") {
        const bucket = key.split("/")[0];
        const names = (body()?.prefixes ?? []).filter((n) => n.startsWith(`${cur}/`) && state.objects.has(`${bucket}/${n}`));
        names.forEach((n) => state.objects.delete(`${bucket}/${n}`));
        return send(json(200, names.map((name) => ({ name, bucket_id: bucket }))));
      }
      if (method === "GET") {
        const o = state.objects.get(key);
        return route.fulfill({ status: o ? 200 : 404, headers: cors, contentType: o?.type ?? "application/json", body: o ? o.bytes : JSON.stringify({ error: "not found" }) });
      }
    }
    if (p.startsWith("/storage/v1/")) return send(json(200, { Key: "x", signedURL: "/object/sign/x" }));
    return send(json(404, { message: "mock: unhandled " + method + " " + p }));
  }

  state.objects = new Map();
  state.uploads = [];
  state.storageLimit = 100 * 1024 * 1024;
  state.extraUsage = 0; // pretend this many more bytes are stored
  state.unusedAfterMs = 24 * 3600 * 1000;
  state.deletedUsers = new Set();
  state.deleteCalls = [];
  state.deleteResult = null;
  state.logouts = [];
  state.versions = versions;
  state.members = members;
  state.oauthRequests = new Map(); // authorization_id -> { client, redirect_uri }
  state.oauthGrants = new Map(); // uid -> [{ client, scopes, granted_at }]
  state.oauthDecisions = [];
  state.agentActivity = new Map(); // uid -> [{ client_id, last_used_at }]
  state.invitesSent = [];
  state.inviteResult = { sent: true };
  state.insights = [];
  state.install = async (context) => {
    // Stand-in for Vercel's analytics script: same queue protocol (window.vaq / window.va), and it
    // records each page view as it would be sent, after the app's beforeSend.
    await context.route("**/_vercel/insights/**", (route) => {
      state.insights.push(new URL(route.request().url()).pathname);
      return route.fulfill({ status: 200, contentType: "application/javascript", body: INSIGHTS_STUB });
    });
    await context.route(`${SUPA}/**`, routeHttp);
    // Profile photos come from Google's image host: answered here, so no test depends on the network.
    await context.route("https://lh3.example.com/**", (route) => route.fulfill({ status: 200, contentType: "image/png", body: PNG }));
    await context.routeWebSocket(/realtime\/v1\/websocket/, routeWs);
    // Every device syncs everything (saved as "all"), unless a suite controls the device's choice
    // itself (state.freshDevices: nothing saved, so the app's own default applies).
    if (!state.freshDevices) {
      await context.addInitScript((uids) => {
        try {
          for (const u of uids) if (!localStorage.getItem(`margin:sync:${u}`)) localStorage.setItem(`margin:sync:${u}`, "all");
        } catch {
          /* documents without storage (about:blank, sandboxed frames) */
        }
      }, [UID, GUEST_UID, GOOGLE_UID]);
    }
  };
  return state;
}

const INSIGHTS_STUB = `(() => {
  let before = null;
  window.__va = window.__va || [];
  const send = () => {
    let e = { type: "pageview", url: location.href };
    if (before) e = before(e);
    if (e) window.__va.push(e.url);
  };
  const handle = (name, arg) => { if (name === "beforeSend") before = arg; };
  (window.vaq || []).forEach(([n, a]) => handle(n, a));
  window.va = (n, a) => handle(n, a);
  send();
  const push = history.pushState;
  history.pushState = function (...args) { const r = push.apply(this, args); send(); return r; };
  addEventListener("popstate", send);
})();`;

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  "access-control-expose-headers": "*",
};
