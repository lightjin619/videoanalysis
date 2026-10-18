"use client";

import { useEffect, useState } from "react";
import {
  ACCOUNT_DATA_CHANGE_EVENT, AUTH_CHANGE_EVENT, currentAccountId,
  readAccountItems, writeAccountItems,
} from "@/lib/accountStorage";

const EMPTY_ITEMS: never[] = [];

export function useAccountStorage<T>(key: string) {
  const [snapshot, setSnapshot] = useState<{
    accountId: string | null; key: string; items: T[]; isLoaded: boolean;
  }>({ accountId: null, key, items: [], isLoaded: false });

  useEffect(() => {
    const refresh = () => {
      const accountId = currentAccountId();
      setSnapshot({ accountId, key, items: readAccountItems<T>(accountId, key), isLoaded: true });
    };
    refresh();
    window.addEventListener(ACCOUNT_DATA_CHANGE_EVENT, refresh);
    window.addEventListener(AUTH_CHANGE_EVENT, refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener(ACCOUNT_DATA_CHANGE_EVENT, refresh);
      window.removeEventListener(AUTH_CHANGE_EVENT, refresh);
      window.removeEventListener("storage", refresh);
    };
  }, [key]);

  return {
    items: snapshot.key === key ? snapshot.items : EMPTY_ITEMS,
    isLoaded: snapshot.isLoaded && snapshot.key === key,
    readItems: () => readAccountItems<T>(snapshot.accountId, key),
    writeItems: (items: T[]) => writeAccountItems(snapshot.accountId, key, items),
  };
}
