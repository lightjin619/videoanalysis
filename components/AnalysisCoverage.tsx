import type { AnalysisCoverage as Coverage } from "@/lib/analysisCoverage";

const timeRange = (start: number | null, end: number | null) =>
  start === null || end === null ? "None" : `${start.toFixed(2)}–${end.toFixed(2)}s`;

export default function AnalysisCoverage({ coverage }: { coverage: Coverage }) {
  const motionFrames = coverage.rows.reduce((sum, row) => sum + row.motion, 0);
  const motionSeconds = coverage.motionIntervals?.reduce((sum, interval) => sum + interval.end - interval.start, 0) ?? 0;
  return (
    <section className="collection-coverage">
      <h4>Collected Data Coverage</h4>
      <p>Requested {timeRange(coverage.start, coverage.end)} · Last processed frame {coverage.observedEnd === null ? "None" : `${coverage.observedEnd.toFixed(2)}s`}</p>
      <p>RGB {timeRange(coverage.rgbStart, coverage.rgbEnd)} · Pulse wave {timeRange(coverage.pulseStart, coverage.pulseEnd)}</p>
      <details>
        <summary>View collection counts and motion for each 15-second interval</summary>
        <div className="coverage-table-scroll">
          <table>
            <thead><tr><th>Video time</th><th>Processed frames</th><th>RGB samples</th><th>Pulse samples</th><th>No face</th><th>Tracking mismatch</th><th>Motion frames</th><th>RGB read failed</th></tr></thead>
            <tbody>{coverage.rows.map((row) => (
              <tr key={row.start}><td>{timeRange(row.start, row.end)}</td><td>{row.frames}</td><td>{row.rgb}</td><td>{row.pulse}</td><td>{row.noFace}</td><td>{row.unmatched}</td><td>{row.motion}</td><td>{row.readFailed}</td></tr>
            ))}</tbody>
          </table>
        </div>
      </details>
      {coverage.motionIntervals !== undefined && <p>Detected motion: {motionFrames} frames · {motionSeconds.toFixed(2)}s. Motion frames remain in RGB and pulse analysis. Orange shading on the graphs marks detected motion.</p>}
      <p>Counts describe frames processed by this browser. Intervals with no processed frames were not sampled; RGB collection alone does not establish pulse signal quality.</p>
    </section>
  );
}
