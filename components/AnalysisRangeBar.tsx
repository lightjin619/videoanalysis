"use client";

interface AnalysisRangeBarProps {
  duration: number;
  start: number;
  end: number;
  onChange: (range: { start: number; end: number }) => void;
}

export default function AnalysisRangeBar({
  duration,
  start,
  end,
  onChange,
}: AnalysisRangeBarProps) {
  if (!duration) return null;

  const handleStartChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newStart = Math.min(Number(e.target.value), end - 0.1);
    onChange({ start: newStart, end });
  };

  const handleEndChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newEnd = Math.max(Number(e.target.value), start + 0.1);
    onChange({ start, end: newEnd });
  };

  return (
    <div className="range-bar">
      <h4>Analysis Range</h4>
      <div className="range-inputs">
        <input
          type="range"
          min={0}
          max={duration}
          step="0.1"
          value={start}
          onChange={handleStartChange}
        />
        <input
          type="range"
          min={0}
          max={duration}
          step="0.1"
          value={end}
          onChange={handleEndChange}
        />
      </div>
      <div className="range-info">
        <span>Start: {start.toFixed(1)} s</span>
        <span>End: {end.toFixed(1)} s</span>
      </div>
    </div>
  );
}
