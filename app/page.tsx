"use client";

import { useRouter } from "next/navigation";

export default function HomePage() {
  const router = useRouter();

  return (
    <div className="home-container">
      <h1>비디오 분석 플랫폼</h1>
      <p>
        얼굴 기반 RGB 신호를 이용해 다양한 바이오 시그널을 분석할 수 있는
        비디오 분석 홈페이지입니다.
      </p>
      <button
        className="primary-button"
        onClick={() => router.push("/projects")}
      >
        Video Analysis
      </button>
    </div>
  );
}
