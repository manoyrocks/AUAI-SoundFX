import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

/**
 * Minimal localStorage stand-in. The storage module only uses
 * getItem/setItem/removeItem and Object.keys(), so a plain object-backed
 * shim exercises the real code path without a DOM.
 */
class MemoryStorage {
  constructor() {
    this.map = new Map();
  }
  getItem(k) {
    return this.map.has(k) ? this.map.get(k) : null;
  }
  setItem(k, v) {
    this.map.set(k, String(v));
  }
  removeItem(k) {
    this.map.delete(k);
  }
  get length() {
    return this.map.size;
  }
  key(i) {
    return [...this.map.keys()][i] ?? null;
  }
}

// Object.keys(localStorage) must enumerate the stored keys, which a Map-backed
// class does not do on its own. A Proxy gives real key enumeration.
function makeStorage() {
  const backing = new MemoryStorage();
  return new Proxy(backing, {
    ownKeys: () => [...backing.map.keys()],
    getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
    get: (t, p) => (typeof t[p] === "function" ? t[p].bind(t) : t[p]),
  });
}

globalThis.localStorage = makeStorage();

const { STORES, inventory, clearStore, clearAll, formatBytes } = await import("../lib/storage.js");

beforeEach(() => {
  globalThis.localStorage = makeStorage();
});

test("every declared store has a namespaced key and user-facing copy", () => {
  // The privacy claim depends on the registry being complete and on
  // clearAll's prefix sweep finding everything.
  for (const s of STORES) {
    assert.ok(s.key.startsWith("soundfx."), `${s.id} key is not namespaced: ${s.key}`);
    assert.ok(s.label.length > 0, `${s.id} has no label`);
    assert.ok(s.description.length > 20, `${s.id} description is too thin to be useful`);
  }
  const ids = STORES.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate store id");
  const keys = STORES.map((s) => s.key);
  assert.equal(new Set(keys).size, keys.length, "duplicate storage key");
});

test("inventory reports absent stores rather than inventing them", () => {
  const inv = inventory();
  assert.equal(inv.length, STORES.length);
  for (const i of inv) {
    assert.equal(i.present, false);
    assert.equal(i.bytes, 0);
    assert.equal(i.count, null);
  }
});

test("inventory counts entries per store", () => {
  localStorage.setItem("soundfx.sessions.v1", JSON.stringify([{ a: 1 }, { a: 2 }, { a: 3 }]));
  localStorage.setItem("soundfx.rhythm.v1", JSON.stringify({ totalObservations: 240 }));
  localStorage.setItem("soundfx.techniques.v1", JSON.stringify({ x: true, y: false }));

  const byId = Object.fromEntries(inventory().map((i) => [i.descriptor.id, i]));
  assert.equal(byId.sessions.count, 3);
  assert.equal(byId.rhythm.count, 240);
  assert.equal(byId.techniques.count, 1, "should count only enabled acknowledgements");
  assert.ok(byId.sessions.bytes > 0);
});

test("inventory survives corrupt JSON without throwing", () => {
  // A corrupt store must still be listed and deletable — that is precisely
  // when a user most needs the delete button.
  localStorage.setItem("soundfx.sessions.v1", "{not json");
  const row = inventory().find((i) => i.descriptor.id === "sessions");
  assert.equal(row.present, true);
  assert.equal(row.count, null, "unparseable content should report no count, not crash");
  assert.ok(row.bytes > 0);
});

test("clearStore removes exactly one store", () => {
  localStorage.setItem("soundfx.sessions.v1", "[]");
  localStorage.setItem("soundfx.rhythm.v1", "{}");
  clearStore("sessions");
  assert.equal(localStorage.getItem("soundfx.sessions.v1"), null);
  assert.notEqual(localStorage.getItem("soundfx.rhythm.v1"), null, "cleared an unrelated store");
});

test("clearStore ignores an unknown id", () => {
  localStorage.setItem("soundfx.sessions.v1", "[]");
  clearStore("nope");
  assert.notEqual(localStorage.getItem("soundfx.sessions.v1"), null);
});

test("clearAll removes every namespaced key, including unregistered ones", () => {
  // Sweeping the real keyspace rather than the registry is what makes
  // "delete everything" honest across versions: a key written by an older
  // build whose descriptor no longer exists must still be removed.
  localStorage.setItem("soundfx.sessions.v1", "[]");
  localStorage.setItem("soundfx.rhythm.v1", "{}");
  localStorage.setItem("soundfx.legacy.v0", "leftover from an older version");
  localStorage.setItem("unrelated-app.data", "keep me");

  const removed = clearAll();
  assert.equal(removed, 3);
  for (const k of ["soundfx.sessions.v1", "soundfx.rhythm.v1", "soundfx.legacy.v0"]) {
    assert.equal(localStorage.getItem(k), null, `${k} survived clearAll`);
  }
  assert.equal(localStorage.getItem("unrelated-app.data"), "keep me", "clearAll touched another app's data");
});

test("clearAll on empty storage is a no-op", () => {
  assert.equal(clearAll(), 0);
});

test("formatBytes is readable at every scale", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(2048), "2.0 KB");
  assert.equal(formatBytes(5 * 1024 * 1024), "5.0 MB");
});

test("storage helpers degrade quietly when localStorage throws", () => {
  // Safari in private mode, and any browser with site data blocked.
  globalThis.localStorage = new Proxy(
    {},
    {
      get: () => () => {
        throw new Error("SecurityError");
      },
      ownKeys: () => {
        throw new Error("SecurityError");
      },
    },
  );
  assert.doesNotThrow(() => inventory());
  assert.doesNotThrow(() => clearStore("sessions"));
  assert.doesNotThrow(() => clearAll());
  assert.equal(
    inventory().every((i) => i.present === false),
    true,
  );
});
