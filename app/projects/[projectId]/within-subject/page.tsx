"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useProjects } from "@/hooks/useProjects";
import { useVideoAnalyses } from "@/hooks/useVideoAnalyses";
import { useAnalysisResults } from "@/hooks/useAnalysisResults";
import WithinTrendChart from "@/components/WithinTrendChart";
import SegmentComparisonChart from "@/components/SegmentComparisonChart";
import {
  buildTrendSeries,
  cohensD,
  METRIC_LABELS,
  segmentStatistics,
  prepareWithinSubjectResult,
  type WithinMetric,
} from "@/lib/withinSubject";
import type { SavedAnalysisResult } from "@/types/analysis";

const PALETTES = [
  ["#2563eb", "#dc2626", "#16a34a", "#9333ea"],
  ["#0891b2", "#ea580c", "#65a30d", "#db2777"],
  ["#4f46e5", "#be123c", "#15803d", "#7e22ce"],
];

export default function WithinSubjectPage() {
  const params = useParams<{ projectId: string }>();
  const { projects, isLoaded: projectsLoaded } = useProjects();
  const { analyses, isLoaded: analysesLoaded } =
    useVideoAnalyses(params.projectId);
  const { results } = useAnalysisResults(params.projectId);
  const [selectedAnalysisIds, setSelectedAnalysisIds] = useState<string[]>([]);
  const [metric, setMetric] = useState<WithinMetric>("heartRate");
  const [xMode, setXMode] = useState<"time" | "total">("time");
  const [windowSizes, setWindowSizes] = useState<number[]>([30, 60]);
  const [rangeStart, setRangeStart] = useState(0);
  const [rangeEnd, setRangeEnd] = useState(60);
  const [segmentA, setSegmentA] = useState({ start: 0, end: 30 });
  const [segmentB, setSegmentB] = useState({ start: 30, end: 60 });
  const [comparisonVersion, setComparisonVersion] = useState(0);
  const project = projects.find((item) => item.id === params.projectId);

  const latestResults = useMemo(() => {
    const latest = new Map<string, SavedAnalysisResult>();
    results.forEach((result) => {
      if (
        result.analysisId &&
        result.ppgSignal?.length &&
        !latest.has(result.analysisId)
      ) {
        const prepared = prepareWithinSubjectResult(result);
        if (prepared) latest.set(result.analysisId, prepared);
      }
    });
    return latest;
  }, [results]);

  const availableAnalyses = analyses.filter((item) =>
    latestResults.has(item.id)
  );

  useEffect(() => {
    if (!selectedAnalysisIds.length && availableAnalyses.length) {
      setSelectedAnalysisIds(availableAnalyses.map((item) => item.id));
    }
  }, [availableAnalyses, selectedAnalysisIds.length]);

  const selectedEntries = analyses.flatMap((analysis) => {
    const result = latestResults.get(analysis.id);
    return selectedAnalysisIds.includes(analysis.id) && result
      ? [{ analysis, result }]
      : [];
  });
  const maximumDuration = Math.max(
    1,
    ...selectedEntries.map(({ result }) => result.duration)
  );

  useEffect(() => {
    setRangeEnd(maximumDuration);
    setSegmentA({ start: 0, end: Math.min(30, maximumDuration) });
    setSegmentB({
      start: Math.min(30, maximumDuration / 2),
      end: maximumDuration,
    });
  }, [maximumDuration]);

  const trendSeries = selectedEntries.flatMap(
    ({ analysis, result }, index) =>
      buildTrendSeries(
        result,
        analysis.name,
        metric,
        rangeStart,
        Math.min(rangeEnd, result.duration),
        xMode === "time" ? windowSizes : [],
        xMode === "total",
        PALETTES[index % PALETTES.length]
      )
  );

  const comparisonRows = useMemo(
    () =>
      selectedEntries.map(({ analysis, result }) => {
        const a = segmentStatistics(
          result,
          metric,
          segmentA.start,
          segmentA.end
        );
        const b = segmentStatistics(
          result,
          metric,
          segmentB.start,
          segmentB.end
        );
        const difference =
          a.value !== null && b.value !== null ? b.value - a.value : null;
        const percent =
          difference !== null && a.value
            ? (difference / Math.abs(a.value)) * 100
            : null;
        return {
          analysis,
          a,
          b,
          difference,
          percent,
          effectSize: cohensD(a.samples, b.samples),
        };
      }),
    // comparisonVersion intentionally snapshots segment controls on button click.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [comparisonVersion, metric, selectedAnalysisIds, results]
  );

  if (!projectsLoaded || !analysesLoaded) {
    return <p className="page-status">Loading within-subject analysis data.</p>;
  }
  if (!project) {
    return <p className="page-status">Project not found.</p>;
  }

  return (
    <div className="within-page">
      <div className="page-heading">
        <div>
          <Link className="back-link" href={`/projects/${params.projectId}`}>
            ← {project.name}
          </Link>
          <span className="section-kicker">WITHIN-SUBJECT ANALYSIS</span>
          <h1>Condition and Time Analysis for One Participant</h1>
          <p>
            Refine the saved POS signal around each 15-second spectral HR frequency
            ±0.2 Hz to compute RR and HRV, then
            compare time windows and intervention segments using the existing
            analysis methods. Motion intervals remain saved with the signal.
          </p>
        </div>
      </div>

      <section className="within-panel">
        <div className="within-panel-heading">
          <div>
            <span className="section-kicker">DATA SELECTION</span>
            <h2>Select Video Analysis Cards</h2>
          </div>
          <span className="chart-meta">{availableAnalyses.length} available</span>
        </div>
        <div className="analysis-selector-grid">
          {analyses.map((analysis) => {
            const available = latestResults.has(analysis.id);
            const checked = selectedAnalysisIds.includes(analysis.id);
            return (
              <label
                className={`analysis-selector ${available ? "" : "disabled"}`}
                key={analysis.id}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={!available}
                  onChange={(event) =>
                    setSelectedAnalysisIds((current) =>
                      event.target.checked
                        ? [...current, analysis.id]
                        : current.filter((id) => id !== analysis.id)
                    )
                  }
                />
                <span>
                  <strong>{analysis.name}</strong>
                  <small>
                    {available
                      ? "Use saved 0.8–3 Hz POS signal"
                      : "Run video analysis to save a 0.8–3 Hz POS signal"}
                  </small>
                </span>
              </label>
            );
          })}
        </div>
      </section>

      <section className="within-panel">
        <div className="within-controls">
          <label>
            Parameter
            <select
              value={metric}
              onChange={(event) =>
                setMetric(event.target.value as WithinMetric)
              }
            >
              {Object.entries(METRIC_LABELS).map(([value, label]) => (
                <option value={value} key={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            X interval
            <select
              value={xMode}
              onChange={(event) =>
                setXMode(event.target.value as "time" | "total")
              }
            >
              <option value="time">Time windows</option>
              <option value="total">Total segment</option>
            </select>
          </label>
          <label>
            Start (sec)
            <input
              type="number"
              min={0}
              max={rangeEnd}
              value={rangeStart}
              onChange={(event) => setRangeStart(Number(event.target.value))}
            />
          </label>
          <label>
            End (sec)
            <input
              type="number"
              min={rangeStart}
              max={maximumDuration}
              value={rangeEnd.toFixed(1)}
              onChange={(event) => setRangeEnd(Number(event.target.value))}
            />
          </label>
        </div>

        {xMode === "time" && (
          <div className="window-options">
            {[30, 60].map((seconds) => (
              <label key={seconds}>
                <input
                  type="checkbox"
                  checked={windowSizes.includes(seconds)}
                  onChange={(event) =>
                    setWindowSizes((current) =>
                      event.target.checked
                        ? [...current, seconds].sort((a, b) => a - b)
                        : current.filter((value) => value !== seconds)
                    )
                  }
                />
                {seconds} sec window
              </label>
            ))}
          </div>
        )}

        <WithinTrendChart
          series={trendSeries}
          yLabel={METRIC_LABELS[metric]}
        />
        {!trendSeries.length && (
          <p className="within-empty-message">
            No time series matches the selected criteria. Select an analysis
            card with saved PPG data and adjust the range or window size.
          </p>
        )}
      </section>

      <section className="within-panel">
        <div className="within-panel-heading">
          <div>
            <span className="section-kicker">SEGMENT COMPARISON</span>
            <h2>Condition and Intervention Segment Comparison</h2>
          </div>
        </div>
        <div className="segment-controls">
          <fieldset>
            <legend>Segment A</legend>
            <input
              type="number"
              value={segmentA.start}
              min={0}
              onChange={(event) =>
                setSegmentA((current) => ({
                  ...current,
                  start: Number(event.target.value),
                }))
              }
            />
            <span>to</span>
            <input
              type="number"
              value={segmentA.end}
              max={maximumDuration}
              onChange={(event) =>
                setSegmentA((current) => ({
                  ...current,
                  end: Number(event.target.value),
                }))
              }
            />
          </fieldset>
          <fieldset>
            <legend>Segment B</legend>
            <input
              type="number"
              value={segmentB.start}
              min={0}
              onChange={(event) =>
                setSegmentB((current) => ({
                  ...current,
                  start: Number(event.target.value),
                }))
              }
            />
            <span>to</span>
            <input
              type="number"
              value={segmentB.end}
              max={maximumDuration}
              onChange={(event) =>
                setSegmentB((current) => ({
                  ...current,
                  end: Number(event.target.value),
                }))
              }
            />
          </fieldset>
          <button
            className="primary-button"
            type="button"
            onClick={() => setComparisonVersion((version) => version + 1)}
          >
            Run comparison
          </button>
        </div>

        <SegmentComparisonChart
          rows={comparisonRows.map((row) => ({
            label: row.analysis.name,
            segmentA: row.a.value,
            segmentB: row.b.value,
          }))}
        />

        <div className="comparison-table-wrap">
          <table className="comparison-table">
            <thead>
              <tr>
                <th>Analysis</th>
                <th>Segment A</th>
                <th>Segment B</th>
                <th>Difference</th>
                <th>Change</th>
                <th>Cohen&apos;s d</th>
              </tr>
            </thead>
            <tbody>
              {comparisonRows.map((row) => (
                <tr key={row.analysis.id}>
                  <td>{row.analysis.name}</td>
                  <td>{row.a.value?.toFixed(2) ?? "N/A"}</td>
                  <td>{row.b.value?.toFixed(2) ?? "N/A"}</td>
                  <td>{row.difference?.toFixed(2) ?? "N/A"}</td>
                  <td>
                    {row.percent !== null
                      ? `${row.percent >= 0 ? "+" : ""}${row.percent.toFixed(1)}%`
                      : "N/A"}
                  </td>
                  <td>{row.effectSize?.toFixed(2) ?? "N/A"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="chart-warning">
          These are descriptive statistics and effect sizes for repeated
          measurements from one participant. Do not interpret them as
          independent-sample group inference.
        </p>
      </section>
    </div>
  );
}
