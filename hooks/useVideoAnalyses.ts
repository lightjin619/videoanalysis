"use client";

import { useAccountStorage } from "@/hooks/useAccountStorage";
import { useMemo } from "react";
import type { SavedAnalysisResult } from "@/types/analysis";
import type { VideoAnalysisItem } from "@/types/videoAnalysis";

const STORAGE_KEY = "video-analysis-items";
const RESULTS_STORAGE_KEY = "video-analysis-results";

export function useVideoAnalyses(projectId: string) {
  const { items, isLoaded, readItems, writeItems } = useAccountStorage<VideoAnalysisItem>(STORAGE_KEY);
  const { readItems: readResults, writeItems: writeResults } = useAccountStorage<SavedAnalysisResult>(RESULTS_STORAGE_KEY);
  const analyses = useMemo(() => items.filter(item => item.projectId === projectId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), [items, projectId]);

  const addAnalysis = (name: string, description: string) => {
    const now = new Date().toISOString();
    const item: VideoAnalysisItem = {
      id:
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : String(Date.now()),
      projectId,
      name,
      description,
      createdAt: now,
      updatedAt: now,
    };
    writeItems([item, ...readItems()]);
    return item;
  };

  const deleteAnalysis = (analysisId: string) => {
    const nextItems = readItems().filter(
      (item) => !(item.projectId === projectId && item.id === analysisId)
    );
    writeItems(nextItems);
    writeResults(readResults().filter(result =>
      !(result.projectId === projectId && result.analysisId === analysisId)));
  };

  return { analyses, addAnalysis, deleteAnalysis, isLoaded };
}
