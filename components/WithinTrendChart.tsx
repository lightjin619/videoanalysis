"use client";

import { useEffect, useRef } from "react";
import type { TrendSeries } from "@/lib/withinSubject";

export default function WithinTrendChart({
  series,
  yLabel,
}: {
  series: TrendSeries[];
  yLabel: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const width = canvas.width;
    const height = canvas.height;
    const padding = { left: 72, right: 24, top: 28, bottom: 52 };
    const points = series.flatMap((item) => item.points);
    context.clearRect(0, 0, width, height);
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    if (!points.length) return;

    const xMin = Math.min(...points.map((point) => point.x));
    const xMax = Math.max(...points.map((point) => point.x));
    let yMin = Math.min(...points.map((point) => point.y));
    let yMax = Math.max(...points.map((point) => point.y));
    if (yMax === yMin) {
      yMin -= 1;
      yMax += 1;
    }
    const yMargin = (yMax - yMin) * 0.1;
    yMin -= yMargin;
    yMax += yMargin;

    const plotWidth = width - padding.left - padding.right;
    const plotHeight = height - padding.top - padding.bottom;
    const toX = (value: number) =>
      padding.left + ((value - xMin) / (xMax - xMin || 1)) * plotWidth;
    const toY = (value: number) =>
      padding.top + ((yMax - value) / (yMax - yMin)) * plotHeight;

    context.strokeStyle = "#dbe3ef";
    context.fillStyle = "#667085";
    context.font = "12px system-ui";
    for (let tick = 0; tick <= 5; tick += 1) {
      const yValue = yMin + ((yMax - yMin) * tick) / 5;
      const y = toY(yValue);
      context.beginPath();
      context.moveTo(padding.left, y);
      context.lineTo(width - padding.right, y);
      context.stroke();
      context.fillText(yValue.toFixed(1), 10, y + 4);
    }
    for (let tick = 0; tick <= 6; tick += 1) {
      const xValue = xMin + ((xMax - xMin) * tick) / 6;
      const x = toX(xValue);
      context.fillText(`${xValue.toFixed(0)}s`, x - 10, height - 22);
    }

    series.forEach((item) => {
      context.strokeStyle = item.color;
      context.fillStyle = item.color;
      context.lineWidth = 2;
      context.beginPath();
      item.points.forEach((point, index) => {
        const x = toX(point.x);
        const y = toY(point.y);
        if (index === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      });
      context.stroke();
      item.points.forEach((point) => {
        context.beginPath();
        context.arc(toX(point.x), toY(point.y), 3, 0, Math.PI * 2);
        context.fill();
      });
    });

    context.save();
    context.translate(18, height / 2);
    context.rotate(-Math.PI / 2);
    context.fillStyle = "#344054";
    context.font = "700 12px system-ui";
    context.fillText(yLabel, 0, 0);
    context.restore();
  }, [series, yLabel]);

  return (
    <div className="within-chart-wrap">
      <canvas ref={canvasRef} width={1100} height={440} />
      <div className="within-legend">
        {series.map((item) => (
          <span key={item.label}>
            <i style={{ background: item.color }} />
            {item.label}
          </span>
        ))}
      </div>
    </div>
  );
}
