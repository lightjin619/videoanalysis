"use client";

import { useAccountStorage } from "@/hooks/useAccountStorage";
import { useMemo } from "react";
import type { SavedAnalysisResult } from "@/types/analysis";
import { POS_RR_PIPELINE } from "@/lib/posSignal";
import { prepareWithinSubjectResult } from "@/lib/withinSubject";

const STORAGE_KEY = "video-analysis-results";

export function useAnalysisResults(projectId: string, analysisId?: string) {
  const { items, readItems: readResults, writeItems } = useAccountStorage<SavedAnalysisResult>(STORAGE_KEY);
  const results = useMemo(() => items.filter(result => result.projectId === projectId
    && (analysisId ? result.analysisId === analysisId : true))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(result => result.rrPipeline === POS_RR_PIPELINE ? result
      : prepareWithinSubjectResult(result) ?? result), [items, projectId, analysisId]);

  const saveResult = (result: SavedAnalysisResult) => {
    const allResults = readResults();
    const nextResults = [result, ...allResults].slice(0, 30);
    try {
      writeItems(nextResults);
    } catch (error) {
      // Keep recent summaries if the browser storage quota cannot hold all PPG.
      const compactResults = nextResults.slice(0, 10).map((item, index) =>
        index < 5
          ? item
          : { ...item, rgbSignal: undefined, ppgSignal: undefined, peakTimes: undefined }
      );
      writeItems(compactResults);
      console.warn("Analysis history was compacted due to storage limits.", error);
    }
  };

  const deleteResult = (resultId: string) => {
    const nextResults = readResults().filter((result) => result.id !== resultId);
    writeItems(nextResults);
  };

  return { results, saveResult, deleteResult };
}
