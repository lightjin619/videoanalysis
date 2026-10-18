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
      <h2>Project Management</h2>

      <form className="project-form" onSubmit={handleCreate}>
        <h3>Create a New Project</h3>
        <input
          placeholder="Project name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
        <textarea
          placeholder="Brief description"
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
        />
        <button className="primary-button" type="submit">
          Project Create
        </button>
      </form>

      {!isLoaded ? (
        <p className="empty-text">Loading projects...</p>
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
              <span className="project-card-link">Open video analyses →</span>
              <span className="project-date">
                {new Date(p.createdAt).toLocaleString()}
              </span>
            </div>
          ))}

          {projects.length === 0 && (
            <p className="empty-text">
              No projects yet. Create your first one.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
