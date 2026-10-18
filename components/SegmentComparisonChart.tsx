"use client";

export interface ComparisonBar {
  label: string;
  segmentA: number | null;
  segmentB: number | null;
}

export default function SegmentComparisonChart({
  rows,
}: {
  rows: ComparisonBar[];
}) {
  const values = rows.flatMap((row) =>
    [row.segmentA, row.segmentB].filter(
      (value): value is number => value !== null
    )
  );
  const maximum = Math.max(1, ...values.map((value) => Math.abs(value)));

  return (
    <div className="comparison-bars">
      {rows.map((row) => (
        <div className="comparison-row" key={row.label}>
          <strong>{row.label}</strong>
          <div className="comparison-bar-track">
            <span
              className="comparison-bar segment-a"
              style={{
                width: `${((row.segmentA ?? 0) / maximum) * 100}%`,
              }}
            >
              {row.segmentA?.toFixed(2) ?? "N/A"}
            </span>
            <span
              className="comparison-bar segment-b"
              style={{
                width: `${((row.segmentB ?? 0) / maximum) * 100}%`,
              }}
            >
              {row.segmentB?.toFixed(2) ?? "N/A"}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}
