"use client";

import Link from "next/link";

export default function AppHeader() {
  return (
    <header className="app-header">
      <Link href="/" className="logo">
        Video Analysis Lab
      </Link>
      <nav>
        <Link href="/projects">Projects</Link>
      </nav>
    </header>
  );
}
