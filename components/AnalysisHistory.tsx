"use client";

import type { SavedAnalysisResult } from "@/types/analysis";
import AnalysisCoverage from "@/components/AnalysisCoverage";

export default function AnalysisHistory({
  results,
  onDelete,
}: {
  results: SavedAnalysisResult[];
  onDelete?: (resultId: string) => void;
}) {
  if (!results.length) return null;

  const handleDelete = (result: SavedAnalysisResult) => {
    if (!onDelete) return;
    const label = result.fileName || "this saved result";
    if (window.confirm(`Delete "${label}" from saved analysis results?`)) {
      onDelete(result.id);
    }
  };

  return (
    <section className="history-section">
      <div className="chart-heading">
        <div>
          <span className="section-kicker">LOCAL HISTORY</span>
          <h3>Saved Analysis Results</h3>
        </div>
        <span className="chart-meta">{results.length} results</span>
      </div>
      <div className="history-list">
        {results.map((result) => (
          <article className="history-card" key={result.id}>
            <div className="history-card-heading">
              <strong>{Math.round(result.heartRate)} BPM</strong>
              <div className="history-card-actions">
                <time>{new Date(result.createdAt).toLocaleString()}</time>
                {onDelete && (
                  <button
                    type="button"
                    className="history-delete-button"
                    onClick={() => handleDelete(result)}
                    aria-label="Delete saved analysis result"
                  >
                    Delete
                  </button>
                )}
              </div>
            </div>
            <p>{result.fileName || "Video analysis"}</p>
            {result.coverage && <AnalysisCoverage coverage={result.coverage} />}
            <div className="history-metrics">
              {result.hrv ? (
                <>
                  <span>SDNN {result.hrv.sdnn.toFixed(1)} ms</span>
                  <span>RMSSD {result.hrv.rmssd.toFixed(1)} ms</span>
                  <span>pNN50 {result.hrv.pnn50.toFixed(1)}%</span>
                </>
              ) : (
                <span>Insufficient HRV data</span>
              )}
              <span>Fs {result.sampleRate.toFixed(1)} Hz</span>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
