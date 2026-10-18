"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useLocalAuth } from "@/hooks/useLocalAuth";

export default function AppHeader() {
  const pathname = usePathname();
  const router = useRouter();
  const { status, username, logout } = useLocalAuth();

  if (pathname === "/" || status !== "authenticated") {
    return null;
  }

  const handleLogout = () => {
    logout();
    router.replace("/");
  };

  return (
    <header className="app-header">
      <Link href="/projects" className="logo">
        Video Analysis Lab
      </Link>
      <nav className="header-nav">
        <Link href="/projects">Projects</Link>
        <span className="header-user">{username}</span>
        <button
          className="header-logout"
          type="button"
          onClick={handleLogout}
        >
          Log out
        </button>
      </nav>
    </header>
  );
}
