"use client";

import { useCallback, useEffect, useState } from "react";

import {
  ACCOUNT_STORAGE_KEY, SESSION_STORAGE_KEY, AUTH_CHANGE_EVENT,
  readLocalAccount, type StoredAccount,
} from "@/lib/accountStorage";

export type AuthStatus = "loading" | "authenticated" | "unauthenticated";

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function hashPassword(password: string, salt: string) {
  const data = new TextEncoder().encode(`${salt}:${password}`);
  const digest = await window.crypto.subtle.digest("SHA-256", data);
  return bytesToHex(new Uint8Array(digest));
}

function notifyAuthChange() {
  window.dispatchEvent(new Event(AUTH_CHANGE_EVENT));
}

export function useLocalAuth() {
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [accountExists, setAccountExists] = useState(false);
  const [username, setUsername] = useState<string | null>(null);
  const [accountId, setAccountId] = useState<string | null>(null);

  const refresh = useCallback(() => {
    const account = readLocalAccount();
    const sessionId = window.sessionStorage.getItem(SESSION_STORAGE_KEY);
    const isAuthenticated =
      Boolean(account) && sessionId === account?.id;

    setAccountExists(Boolean(account));
    setUsername(isAuthenticated ? account!.username : null);
    setAccountId(isAuthenticated ? account!.id : null);
    setStatus(isAuthenticated ? "authenticated" : "unauthenticated");
  }, []);

  useEffect(() => {
    refresh();
    window.addEventListener(AUTH_CHANGE_EVENT, refresh);
    window.addEventListener("storage", refresh);

    return () => {
      window.removeEventListener(AUTH_CHANGE_EVENT, refresh);
      window.removeEventListener("storage", refresh);
    };
  }, [refresh]);

  const createAccount = async (newUsername: string, password: string) => {
    const normalizedUsername = newUsername.trim();
    if (!normalizedUsername || !password) {
      throw new Error("Enter both a username and password.");
    }
    if (readLocalAccount()) {
      throw new Error("Reset the saved account before creating a new one.");
    }

    const saltBytes = new Uint8Array(16);
    window.crypto.getRandomValues(saltBytes);
    const salt = bytesToHex(saltBytes);
    const passwordHash = await hashPassword(password, salt);

    const account: StoredAccount = {
      id: window.crypto.randomUUID(),
      username: normalizedUsername,
      salt,
      passwordHash,
    };

    if (readLocalAccount()) {
      throw new Error("An account was created in another tab. Sign in to continue.");
    }
    window.localStorage.setItem(ACCOUNT_STORAGE_KEY, JSON.stringify(account));
    window.sessionStorage.setItem(SESSION_STORAGE_KEY, account.id);
    notifyAuthChange();
  };

  const login = async (loginUsername: string, password: string) => {
    const account = readLocalAccount();
    if (!account) {
      throw new Error("Create a local account first.");
    }

    const passwordHash = await hashPassword(password, account.salt);
    if (
      account.username !== loginUsername.trim() ||
      account.passwordHash !== passwordHash
    ) {
      throw new Error("The username or password is incorrect.");
    }

    if (readLocalAccount()?.id !== account.id) {
      throw new Error("The saved account changed. Please sign in again.");
    }
    window.sessionStorage.setItem(SESSION_STORAGE_KEY, account.id);
    notifyAuthChange();
  };

  const logout = () => {
    window.sessionStorage.removeItem(SESSION_STORAGE_KEY);
    notifyAuthChange();
  };

  const resetAccount = () => {
    readLocalAccount();
    window.localStorage.removeItem(ACCOUNT_STORAGE_KEY);
    window.sessionStorage.removeItem(SESSION_STORAGE_KEY);
    notifyAuthChange();
  };

  return {
    status,
    accountExists,
    username,
    accountId,
    createAccount,
    login,
    logout,
    resetAccount,
  };
}
