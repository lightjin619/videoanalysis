const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");

function storage() {
  const values = new Map();
  return {
    get length() { return values.size; },
    key: index => [...values.keys()][index] ?? null,
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
  };
}
const localStorage = storage(), sessionStorage = storage();
const exportsObject = {};
let notifications = 0;
vm.runInNewContext(ts.transpileModule(fs.readFileSync("lib/accountStorage.ts", "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, {
  exports: exportsObject, Event,
  window: { localStorage, sessionStorage, dispatchEvent: () => notifications++ },
});
const { readLocalAccount, currentAccountId, accountStorageKey, readAccountItems, writeAccountItems } = exportsObject;
const accountKey = "video-analysis-local-account", sessionKey = "video-analysis-auth-session";
const projectsKey = "video-analysis-projects";
const legacy = { username: "same-name", salt: "unique-salt", passwordHash: "hash" };
localStorage.setItem(accountKey, JSON.stringify(legacy));
sessionStorage.setItem(sessionKey, legacy.username);
localStorage.setItem(projectsKey, JSON.stringify([{ id: "old-project" }]));
const originalSetItem = localStorage.setItem;
localStorage.setItem = (key, value) => {
  if (key.startsWith("video-analysis-account:")) throw new Error("Quota exceeded");
  originalSetItem(key, value);
};
assert.throws(readLocalAccount, /Quota exceeded/);
assert.equal(JSON.parse(localStorage.getItem(accountKey)).id, undefined);
assert.equal(JSON.parse(localStorage.getItem(projectsKey))[0].id, "old-project", "failed migration must preserve original data");
localStorage.setItem = originalSetItem;
const old = readLocalAccount();
assert.equal(currentAccountId(), old.id);
assert.equal(sessionStorage.getItem(sessionKey), old.id);
assert.equal(readAccountItems(old.id, projectsKey)[0].id, "old-project");
assert.equal(localStorage.getItem(projectsKey), null);
assert.equal(readLocalAccount().id, old.id, "migration is idempotent");
sessionStorage.removeItem(sessionKey);
assert.equal(readAccountItems(old.id, projectsKey).length, 0);
assert.throws(() => writeAccountItems(old.id, projectsKey, []), /account has changed/);
const fresh = { ...legacy, id: "new-account-id", salt: "fresh-salt" };
localStorage.setItem(accountKey, JSON.stringify(fresh));
sessionStorage.setItem(sessionKey, fresh.id);
assert.equal(readAccountItems(fresh.id, projectsKey).length, 0);
assert.throws(() => writeAccountItems(old.id, projectsKey, [{ id: "late-analysis" }]), /account has changed/);
writeAccountItems(fresh.id, projectsKey, [{ id: "new-project" }]);
assert.equal(notifications, 1);
assert.equal(JSON.parse(localStorage.getItem(accountStorageKey(old.id, projectsKey)))[0].id, "old-project");
assert.equal(readAccountItems(fresh.id, projectsKey)[0].id, "new-project");
localStorage.setItem("video-analysis-results", JSON.stringify([{ id: "unowned-result" }]));
assert.equal(readAccountItems(fresh.id, "video-analysis-results").length, 0, "never assign orphan shared data to a new account");
localStorage.setItem(accountStorageKey(fresh.id, projectsKey), "{}");
assert.equal(readAccountItems(fresh.id, projectsKey).length, 0, "malformed collections do not become account data");
console.log("Account storage checks passed: safe legacy migration, session upgrade, logout, stale writes, same username isolation, orphan data, invalid data.");
