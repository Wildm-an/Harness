// The loader of the working line: a gyroscope of 3 rings that turn on 3 axes. Each ring is a comet arc:
// a bright head and a tail that fades. The color is the CSS color of the canvas (the accent color).
// With "reduce motion" on, it draws one still frame.

import { useEffect, useRef } from "react";

type Point = [number, number, number];

function rotX([x, y, z]: Point, a: number): Point {
  const c = Math.cos(a), s = Math.sin(a);
  return [x, y * c - z * s, y * s + z * c];
}

function rotY([x, y, z]: Point, a: number): Point {
  const c = Math.cos(a), s = Math.sin(a);
  return [x * c + z * s, y, -x * s + z * c];
}

function rotZ([x, y, z]: Point, a: number): Point {
  const c = Math.cos(a), s = Math.sin(a);
  return [x * c - y * s, x * s + y * c, z];
}

/** The angles of each ring at time t (seconds): x, y, z, and the start of its comet head. */
function rings(t: number): [number, number, number, number][] {
  return [
    [t * 1.3, 0, 0, 0],
    [0, t * 1.7, 0.9, 2],
    [t * 0.9, t * 0.6, -0.9, 4],
  ];
}

const SEGMENTS = 48;
const TAIL = 0.6; // The part of the ring that the tail covers.

/** Draw one frame on a square canvas of `size` CSS pixels. */
export function drawGyro(ctx: CanvasRenderingContext2D, size: number, t: number, color: string) {
  const project = ([x, y, z]: Point): [number, number] => {
    const f = 1 / (1 - z * 0.35); // A near point is a little larger.
    return [size / 2 + x * size * 0.38 * f, size / 2 + y * size * 0.38 * f];
  };
  ctx.clearRect(0, 0, size, size);
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1.2, size / 24);
  ctx.lineCap = "round";
  rings(t).forEach(([ax, ay, az, start], k) => {
    const radius = 1 - k * 0.16;
    const head = (t * 1.8 + start) % 1;
    let prev: [number, number] | null = null;
    for (let i = 0; i <= SEGMENTS; i++) {
      const u = i / SEGMENTS;
      const a = u * Math.PI * 2;
      const p = rotZ(rotY(rotX([Math.cos(a) * radius, Math.sin(a) * radius, 0], ax), ay), az);
      const q = project(p);
      if (prev) {
        const behind = (head - u + 1) % 1;
        if (behind < TAIL) {
          ctx.globalAlpha = Math.pow(1 - behind / TAIL, 1.5);
          ctx.beginPath();
          ctx.moveTo(prev[0], prev[1]);
          ctx.lineTo(q[0], q[1]);
          ctx.stroke();
        }
      }
      prev = q;
    }
  });
  ctx.globalAlpha = 1;
}

export function GyroLoader({ size = 16, className }: { size?: number; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    let color = getComputedStyle(canvas).color;
    let frame = 0;
    let raf = 0;
    const draw = (ms: number) => {
      // Read the color again from time to time: the theme can change while the turn runs.
      if (++frame % 30 === 0) color = getComputedStyle(canvas).color;
      drawGyro(ctx, size, still ? 1 : ms / 1000, color);
      if (!still) raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [size]);

  return <canvas ref={ref} className={className} style={{ width: size, height: size }} aria-hidden />;
}
