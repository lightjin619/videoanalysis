"use client";

import { useAccountStorage } from "@/hooks/useAccountStorage";
import type { Project } from "@/types/project";

const STORAGE_KEY = "video-analysis-projects";

export function useProjects() {
  const { items: projects, isLoaded, readItems, writeItems } = useAccountStorage<Project>(STORAGE_KEY);

  const addProject = (name: string, description: string) => {
    const newProject: Project = {
      id:
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : String(Date.now()),
      name,
      description,
      createdAt: new Date().toISOString(),
    };
    writeItems([...readItems(), newProject]);
  };

  return { projects, addProject, isLoaded };
}
