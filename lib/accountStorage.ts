export const ACCOUNT_STORAGE_KEY = "video-analysis-local-account";
export const SESSION_STORAGE_KEY = "video-analysis-auth-session";
export const AUTH_CHANGE_EVENT = "video-analysis-auth-change";
export const ACCOUNT_DATA_CHANGE_EVENT = "video-analysis-account-data-change";

export interface StoredAccount {
  id: string;
  username: string;
  salt: string;
  passwordHash: string;
}

export function accountStorageKey(accountId: string, key: string) {
  return `video-analysis-account:${encodeURIComponent(accountId)}:${key}`;
}

/** Only the account present before the upgrade owns the old shared data. */
export function readLocalAccount(): StoredAccount | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(ACCOUNT_STORAGE_KEY);
  if (!raw) return null;
  let account: StoredAccount;
  try {
    account = JSON.parse(raw);
    if (!account || typeof account.username !== "string" || !account.username
      || typeof account.salt !== "string" || !account.salt
      || typeof account.passwordHash !== "string" || !account.passwordHash) return null;
  } catch {
    return null;
  }
  if (typeof account.id === "string" && account.id) return account;

  account = { ...account, id: `legacy-${account.salt}` };
  const legacyKeys = ["video-analysis-projects", "video-analysis-items", "video-analysis-results"];
  for (let index = 0; index < window.localStorage.length; index++) {
    const key = window.localStorage.key(index);
    if (key?.startsWith("between-subject-assignments:")) legacyKeys.push(key);
  }
  // Copy first, then commit the account and remove the old keys. A failed write
  // leaves the original data available for another migration attempt.
  for (const key of legacyKeys) {
    const value = window.localStorage.getItem(key);
    const scopedKey = accountStorageKey(account.id, key);
    if (value !== null && window.localStorage.getItem(scopedKey) === null) {
      window.localStorage.setItem(scopedKey, value);
    }
  }
  window.localStorage.setItem(ACCOUNT_STORAGE_KEY, JSON.stringify(account));
  if (window.sessionStorage.getItem(SESSION_STORAGE_KEY) === account.username) {
    window.sessionStorage.setItem(SESSION_STORAGE_KEY, account.id);
  }
  for (const key of legacyKeys) window.localStorage.removeItem(key);
  return account;
}

export function currentAccountId(): string | null {
  const account = readLocalAccount();
  return account && window.sessionStorage.getItem(SESSION_STORAGE_KEY) === account.id
    ? account.id : null;
}

export function readAccountItems<T>(accountId: string | null, key: string): T[] {
  if (!accountId || currentAccountId() !== accountId) return [];
  const raw = window.localStorage.getItem(accountStorageKey(accountId, key));
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed as T[] : [];
  } catch {
    return [];
  }
}

export function writeAccountItems<T>(accountId: string | null, key: string, items: T[]) {
  // An analysis finishing after logout must never write into the next account.
  if (!accountId || currentAccountId() !== accountId) {
    throw new Error("Your account has changed. Sign in again before saving.");
  }
  window.localStorage.setItem(accountStorageKey(accountId, key), JSON.stringify(items));
  window.dispatchEvent(new Event(ACCOUNT_DATA_CHANGE_EVENT));
}
