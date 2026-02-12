"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { useProjects } from "@/hooks/useProjects";

export default function ProjectsPage() {
  const { projects, addProject, isLoaded } = useProjects();
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const router = useRouter();

  const handleCreate = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    addProject(name.trim(), desc.trim());
    setName("");
    setDesc("");
  };

  return (
    <div className="projects-container">
      <h2>프로젝트 관리</h2>

      <form className="project-form" onSubmit={handleCreate}>
        <h3>새 프로젝트 생성</h3>
        <input
          placeholder="Project name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
        <textarea
          placeholder="간단한 설명"
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
        />
        <button className="primary-button" type="submit">
          Project Create
        </button>
      </form>

      {!isLoaded ? (
        <p className="empty-text">프로젝트를 불러오는 중입니다…</p>
      ) : (
        <div className="project-list">
          {projects.map((p) => (
            <div
              key={p.id}
              className="project-card"
              onClick={() => router.push(`/projects/${p.id}`)}
            >
              <h4>{p.name}</h4>
              <p>{p.description || "No description"}</p>
              <span className="project-date">
                {new Date(p.createdAt).toLocaleString()}
              </span>
            </div>
          ))}

          {projects.length === 0 && (
            <p className="empty-text">
              아직 프로젝트가 없습니다. 하나 만들어보세요.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
