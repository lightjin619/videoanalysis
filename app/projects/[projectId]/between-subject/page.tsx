"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { useAccountStorage } from "@/hooks/useAccountStorage";
import WithinTrendChart from "@/components/WithinTrendChart";
import SegmentComparisonChart from "@/components/SegmentComparisonChart";
import { useProjects } from "@/hooks/useProjects";
import { useVideoAnalyses } from "@/hooks/useVideoAnalyses";
import { useAnalysisResults } from "@/hooks/useAnalysisResults";
import type { SavedAnalysisResult } from "@/types/analysis";
import {
  BETWEEN_METRIC_LABELS,
  calculateBetweenMetric,
  cohensD,
  mean,
  standardDeviation,
  welchT,
  type BetweenMetric,
} from "@/lib/betweenSubject";
import type { TrendSeries } from "@/lib/withinSubject";

interface Assignment {
  analysisId: string;
  selected: boolean;
  participant: string;
  group: string;
  condition: string;
}

const COLORS = ["#2563eb", "#16a34a", "#9333ea", "#ea580c", "#0891b2"];
const WINDOW_OPTIONS = [30, 60, 120, 180, 300];

export default function BetweenSubjectPage() {
  const params = useParams<{ projectId: string }>();
  const { projects, isLoaded: projectsLoaded } = useProjects();
  const { analyses, isLoaded: analysesLoaded } =
    useVideoAnalyses(params.projectId);
  const { results } = useAnalysisResults(params.projectId);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [metric, setMetric] = useState<BetweenMetric>("rmssd");
  const [xMode, setXMode] = useState<"time" | "total">("time");
  const [windowSeconds, setWindowSeconds] = useState(30);
  const [rangeStart, setRangeStart] = useState(0);
  const [rangeEnd, setRangeEnd] = useState(60);
  const [segmentA, setSegmentA] = useState({ start: 0, end: 30 });
  const [segmentB, setSegmentB] = useState({ start: 30, end: 60 });
  const [comparisonVersion, setComparisonVersion] = useState(0);
  const project = projects.find((item) => item.id === params.projectId);
  const assignmentKey = `between-subject-assignments:${params.projectId}`;
  const { items: storedAssignments, writeItems: writeAssignments } = useAccountStorage<Assignment>(assignmentKey);

  const latestResults = useMemo(() => {
    const latest = new Map<string, SavedAnalysisResult>();
    results.forEach((result) => {
      if (
        result.analysisId &&
        result.ppgSignal?.length &&
        !latest.has(result.analysisId)
      ) {
        latest.set(result.analysisId, result);
      }
    });
    return latest;
  }, [results]);

  useEffect(() => {
    setAssignments(
      analyses.map((analysis, index) => {
        const existing = storedAssignments.find((item) => item.analysisId === analysis.id);
        return (
          existing ?? {
            analysisId: analysis.id,
            selected: latestResults.has(analysis.id),
            participant: analysis.name,
            group: index % 2 === 0 ? "Group A" : "Group B",
            condition: "Time 1",
          }
        );
      })
    );
  }, [analyses, storedAssignments, latestResults]);

  const updateAssignment = (
    analysisId: string,
    field: keyof Assignment,
    value: string | boolean
  ) => {
    const next = assignments.map(item =>
      item.analysisId === analysisId ? { ...item, [field]: value } : item);
    writeAssignments(next);
    setAssignments(next);
  };

  const selectedEntries = assignments.flatMap((assignment) => {
    const analysis = analyses.find((item) => item.id === assignment.analysisId);
    const result = latestResults.get(assignment.analysisId);
    return assignment.selected && analysis && result
      ? [{ assignment, analysis, result }]
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

  const groupNames = Array.from(
    new Set(selectedEntries.map(({ assignment }) => assignment.group.trim()))
  ).filter(Boolean);

  const trendSeries = useMemo(() => {
    const series: TrendSeries[] = [];
    groupNames.forEach((group, groupIndex) => {
      const conditions = Array.from(
        new Set(
          selectedEntries
            .filter(({ assignment }) => assignment.group.trim() === group)
            .map(({ assignment }) => assignment.condition.trim() || "Unlabeled")
        )
      );
      conditions.forEach((condition, conditionIndex) => {
        const entries = selectedEntries.filter(
          ({ assignment }) =>
            assignment.group.trim() === group &&
            (assignment.condition.trim() || "Unlabeled") === condition
        );
        const points = [];
        if (xMode === "total") {
          const values = entries
            .map(({ result }) =>
              calculateBetweenMetric(
                result,
                metric,
                rangeStart,
                Math.min(rangeEnd, result.duration)
              )
            )
            .filter((value): value is number => value !== null);
          const value = mean(values);
          if (value !== null) {
            points.push({ x: rangeStart, y: value }, { x: rangeEnd, y: value });
          }
        } else {
          for (
            let start = rangeStart;
            start + windowSeconds <= rangeEnd + 0.001;
            start += windowSeconds
          ) {
            const values = entries
              .map(({ result }) =>
                calculateBetweenMetric(
                  result,
                  metric,
                  start,
                  Math.min(start + windowSeconds, result.duration)
                )
              )
              .filter((value): value is number => value !== null);
            const value = mean(values);
            if (value !== null) {
              points.push({ x: start + windowSeconds / 2, y: value });
            }
          }
        }
        if (points.length) {
          series.push({
            label: `${group} · ${condition} (n=${entries.length})`,
            color: COLORS[(groupIndex + conditionIndex) % COLORS.length],
            points,
          });
        }
      });
    });
    return series;
  }, [
    groupNames,
    metric,
    rangeEnd,
    rangeStart,
    selectedEntries,
    windowSeconds,
    xMode,
  ]);

  const groupComparison = useMemo(
    () =>
      groupNames.map((group) => {
        const entries = selectedEntries.filter(
          ({ assignment }) => assignment.group.trim() === group
        );
        const valuesA = entries
          .map(({ result }) =>
            calculateBetweenMetric(result, metric, segmentA.start, segmentA.end)
          )
          .filter((value): value is number => value !== null);
        const valuesB = entries
          .map(({ result }) =>
            calculateBetweenMetric(result, metric, segmentB.start, segmentB.end)
          )
          .filter((value): value is number => value !== null);
        return {
          group,
          n: entries.length,
          valuesA,
          valuesB,
          meanA: mean(valuesA),
          meanB: mean(valuesB),
          sdA: standardDeviation(valuesA),
          sdB: standardDeviation(valuesB),
        };
      }),
    // comparisonVersion snapshots the segment controls on button click.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [comparisonVersion, groupNames, metric, selectedEntries]
  );

  const firstGroup = groupComparison[0];
  const secondGroup = groupComparison[1];
  const betweenStats =
    firstGroup && secondGroup
      ? {
          segmentADifference:
            firstGroup.meanA !== null && secondGroup.meanA !== null
              ? secondGroup.meanA - firstGroup.meanA
              : null,
          segmentBDifference:
            firstGroup.meanB !== null && secondGroup.meanB !== null
              ? secondGroup.meanB - firstGroup.meanB
              : null,
          segmentAD: cohensD(firstGroup.valuesA, secondGroup.valuesA),
          segmentBD: cohensD(firstGroup.valuesB, secondGroup.valuesB),
          segmentAT: welchT(firstGroup.valuesA, secondGroup.valuesA),
          segmentBT: welchT(firstGroup.valuesB, secondGroup.valuesB),
        }
      : null;

  if (!projectsLoaded || !analysesLoaded) {
    return <p className="page-status">Loading between-subject analysis data.</p>;
  }
  if (!project) return <p className="page-status">Project not found.</p>;

  return (
    <div className="within-page">
      <div className="page-heading">
        <div>
          <Link className="back-link" href={`/projects/${params.projectId}`}>
            ← {project.name}
          </Link>
          <span className="section-kicker">BETWEEN-SUBJECT ANALYSIS</span>
          <h1>Group and Time Analysis Across Participants</h1>
          <p>
            Compare participant groups, interventions, and time conditions
            using saved PPG and HRV data.
          </p>
        </div>
      </div>

      <section className="within-panel">
        <div className="within-panel-heading">
          <div>
            <span className="section-kicker">PARTICIPANT ASSIGNMENT</span>
            <h2>Assign Analysis Cards to Groups</h2>
          </div>
          <span className="chart-meta">{selectedEntries.length} selected</span>
        </div>
        <div className="between-assignment-wrap">
          <table className="comparison-table between-assignment-table">
            <thead>
              <tr>
                <th>Use</th>
                <th>Analysis card</th>
                <th>Participant</th>
                <th>Group / intervention</th>
                <th>Time / condition</th>
                <th>Data</th>
              </tr>
            </thead>
            <tbody>
              {assignments.map((assignment) => {
                const analysis = analyses.find(
                  (item) => item.id === assignment.analysisId
                );
                const available = latestResults.has(assignment.analysisId);
                if (!analysis) return null;
                return (
                  <tr key={assignment.analysisId}>
                    <td>
                      <input
                        type="checkbox"
                        checked={assignment.selected && available}
                        disabled={!available}
                        onChange={(event) =>
                          updateAssignment(
                            assignment.analysisId,
                            "selected",
                            event.target.checked
                          )
                        }
                      />
                    </td>
                    <td>{analysis.name}</td>
                    <td>
                      <input
                        value={assignment.participant}
                        onChange={(event) =>
                          updateAssignment(
                            assignment.analysisId,
                            "participant",
                            event.target.value
                          )
                        }
                      />
                    </td>
                    <td>
                      <input
                        value={assignment.group}
                        onChange={(event) =>
                          updateAssignment(
                            assignment.analysisId,
                            "group",
                            event.target.value
                          )
                        }
                      />
                    </td>
                    <td>
                      <input
                        value={assignment.condition}
                        onChange={(event) =>
                          updateAssignment(
                            assignment.analysisId,
                            "condition",
                            event.target.value
                          )
                        }
                      />
                    </td>
                    <td>{available ? "PPG available" : "Run analysis first"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="within-panel">
        <div className="within-panel-heading">
          <div>
            <span className="section-kicker">GROUP BY TIME</span>
            <h2>Group Time Series</h2>
          </div>
        </div>
        <div className="within-controls between-controls">
          <label>
            Parameter
            <select
              value={metric}
              onChange={(event) => setMetric(event.target.value as BetweenMetric)}
            >
              {Object.entries(BETWEEN_METRIC_LABELS).map(([value, label]) => (
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
            Range start (sec)
            <input
              type="number"
              min="0"
              max={maximumDuration}
              value={rangeStart}
              onChange={(event) => setRangeStart(Number(event.target.value))}
            />
          </label>
          <label>
            Range end (sec)
            <input
              type="number"
              min="0"
              max={maximumDuration}
              value={rangeEnd}
              onChange={(event) => setRangeEnd(Number(event.target.value))}
            />
          </label>
          {xMode === "time" && (
            <label>
              Window size
              <select
                value={windowSeconds}
                onChange={(event) => setWindowSeconds(Number(event.target.value))}
              >
                {WINDOW_OPTIONS.map((seconds) => (
                  <option value={seconds} key={seconds}>
                    {seconds} seconds
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        {metric === "lfHf" && (
          <p className="chart-warning">
            LF/HF is estimated from interpolated RR intervals. Use windows of
            at least 60 seconds when possible; short or sparse windows are
            reported as unavailable.
          </p>
        )}
        <WithinTrendChart
          series={trendSeries}
          yLabel={BETWEEN_METRIC_LABELS[metric]}
        />
        {!trendSeries.length && (
          <p className="within-empty-message">
            Assign at least one analyzed card to a group and choose a range
            with enough data.
          </p>
        )}
      </section>

      <section className="within-panel">
        <div className="within-panel-heading">
          <div>
            <span className="section-kicker">STATISTICAL COMPARISON</span>
            <h2>Compare Groups Across Segments</h2>
          </div>
        </div>
        <div className="segment-controls">
          <fieldset>
            <legend>Segment A</legend>
            <input
              type="number"
              value={segmentA.start}
              onChange={(event) =>
                setSegmentA({ ...segmentA, start: Number(event.target.value) })
              }
            />
            <span>to</span>
            <input
              type="number"
              value={segmentA.end}
              onChange={(event) =>
                setSegmentA({ ...segmentA, end: Number(event.target.value) })
              }
            />
          </fieldset>
          <fieldset>
            <legend>Segment B</legend>
            <input
              type="number"
              value={segmentB.start}
              onChange={(event) =>
                setSegmentB({ ...segmentB, start: Number(event.target.value) })
              }
            />
            <span>to</span>
            <input
              type="number"
              value={segmentB.end}
              onChange={(event) =>
                setSegmentB({ ...segmentB, end: Number(event.target.value) })
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
          rows={groupComparison.map((row) => ({
            label: `${row.group} (n=${row.n})`,
            segmentA: row.meanA,
            segmentB: row.meanB,
          }))}
        />

        <div className="comparison-table-wrap">
          <table className="comparison-table">
            <thead>
              <tr>
                <th>Group</th>
                <th>N</th>
                <th>Segment A mean ± SD</th>
                <th>Segment B mean ± SD</th>
                <th>Change</th>
              </tr>
            </thead>
            <tbody>
              {groupComparison.map((row) => (
                <tr key={row.group}>
                  <td>{row.group}</td>
                  <td>{row.n}</td>
                  <td>
                    {row.meanA?.toFixed(2) ?? "N/A"} ±{" "}
                    {row.sdA?.toFixed(2) ?? "N/A"}
                  </td>
                  <td>
                    {row.meanB?.toFixed(2) ?? "N/A"} ±{" "}
                    {row.sdB?.toFixed(2) ?? "N/A"}
                  </td>
                  <td>
                    {row.meanA !== null && row.meanB !== null
                      ? (row.meanB - row.meanA).toFixed(2)
                      : "N/A"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {betweenStats && firstGroup && secondGroup && (
          <div className="between-stat-grid">
            <div className="metric-card">
              <span>Comparison</span>
              <strong>
                {firstGroup.group} vs {secondGroup.group}
              </strong>
            </div>
            <div className="metric-card">
              <span>Segment A difference / Cohen&apos;s d / Welch t</span>
              <strong>
                {betweenStats.segmentADifference?.toFixed(2) ?? "N/A"} /{" "}
                {betweenStats.segmentAD?.toFixed(2) ?? "N/A"} /{" "}
                {betweenStats.segmentAT?.toFixed(2) ?? "N/A"}
              </strong>
            </div>
            <div className="metric-card">
              <span>Segment B difference / Cohen&apos;s d / Welch t</span>
              <strong>
                {betweenStats.segmentBDifference?.toFixed(2) ?? "N/A"} /{" "}
                {betweenStats.segmentBD?.toFixed(2) ?? "N/A"} /{" "}
                {betweenStats.segmentBT?.toFixed(2) ?? "N/A"}
              </strong>
            </div>
          </div>
        )}
        <p className="chart-warning">
          Welch t is shown as a test statistic only. Interpret group inference
          cautiously when groups are small or measurements are repeated.
        </p>
      </section>
    </div>
  );
}
