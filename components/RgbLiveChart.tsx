"use client";

import { useEffect, useRef } from "react";

export interface RgbPoint {
  t: number;
  r: number;
  g: number;
  b: number;
}

interface RgbLiveChartProps {
  data: RgbPoint[];
}

export default function RgbLiveChart({ data }: RgbLiveChartProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const width = canvas.width;
    const height = canvas.height;

    ctx.clearRect(0, 0, width, height);

    if (!data.length) return;

    const tMin = data[0].t;
    const tMax = data[data.length - 1].t || tMin + 1;
    const rangeT = tMax - tMin || 1;
    const maxVal = 255;

    const drawLine = (
      key: keyof Omit<RgbPoint, "t">,
      strokeStyle: string
    ) => {
      ctx.beginPath();
      ctx.strokeStyle = strokeStyle;
      ctx.lineWidth = 1;

      data.forEach((point, idx) => {
        const x = ((point.t - tMin) / rangeT) * width;
        const y = height - ((point[key] as number) / maxVal) * height;
        if (idx === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    };

    drawLine("r", "red");
    drawLine("g", "green");
    drawLine("b", "blue");
  }, [data]);

  return (
    <div className="chart-container">
      <h4>RGB 실시간 값</h4>
      <canvas ref={canvasRef} width={600} height={200} />
    </div>
  );
}
