// Trapezoidal "bucket" reservoir gauge. Water fills from the bottom to
// (capacity × rate). Colour follows the same blue→teal→green→yellow→orange
// ramp as the map markers so the visual encoding stays consistent.

function rateColor(rate: number): string {
  if (rate < 0.25) return '#1e6dff';
  if (rate < 0.5) return '#06a8c2';
  if (rate < 0.75) return '#16a34a';
  if (rate < 0.9) return '#eab308';
  return '#f97316';
}

export function ReservoirGauge({
  rate,
  size = 180,
}: {
  /** 0..1 storage rate. `null` renders an empty bucket with `—`. */
  rate: number | null;
  size?: number;
}) {
  const w = size;
  const h = Math.round(size * 1.05);

  // Trapezoid: outer (bucket walls) — wider at the top than the bottom.
  const padX = 14;
  const topY = 18;
  const botY = h - 12;
  const topInset = padX; // left/right inset at top
  const botInset = padX + 18; // wider inset at bottom → trapezoid
  const outer = `M${topInset},${topY} L${w - topInset},${topY} L${w - botInset},${botY} L${botInset},${botY} Z`;

  // Water polygon: same shape but starting at `waterTop` Y instead of topY.
  const r = rate == null ? 0 : Math.max(0, Math.min(1, rate));
  const waterTop = botY - (botY - topY) * r;
  // Interpolate the trapezoid sides at the water-top Y so the surface stays
  // flush with the bucket walls.
  const tFrac = (waterTop - topY) / (botY - topY); // 0 = top of bucket, 1 = bottom
  const leftAtTop = topInset + (botInset - topInset) * tFrac;
  const rightAtTop = w - topInset - (botInset - topInset) * tFrac;
  const water = `M${leftAtTop},${waterTop} L${rightAtTop},${waterTop} L${w - botInset},${botY} L${botInset},${botY} Z`;
  const color = rate == null ? '#9ca3af' : rateColor(r);

  const pctLabel = rate == null ? '—' : `${(r * 100).toFixed(1)}%`;

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      width={w}
      height={h}
      role="img"
      aria-label={`貯水率 ${pctLabel}`}
      className="select-none"
    >
      <title>{`貯水率 ${pctLabel}`}</title>
      <defs>
        <linearGradient id="rg-water" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.95" />
          <stop offset="100%" stopColor={color} stopOpacity="0.65" />
        </linearGradient>
      </defs>
      {/* Outer empty bucket fill */}
      <path d={outer} fill="#f3f5f8" />
      {/* Water (clipped to bucket interior so the surface meets the walls) */}
      <path d={water} fill="url(#rg-water)" />
      {/* Subtle waterline highlight */}
      {rate != null && (
        <line
          x1={leftAtTop}
          y1={waterTop}
          x2={rightAtTop}
          y2={waterTop}
          stroke="#ffffff"
          strokeOpacity="0.6"
          strokeWidth="1"
        />
      )}
      {/* Bucket outline */}
      <path d={outer} fill="none" stroke="#1a1c1e" strokeWidth="2.5" strokeLinejoin="round" />
      {/* Tick marks at 25/50/75% on the right wall */}
      {[0.25, 0.5, 0.75].map((t) => {
        const y = botY - (botY - topY) * t;
        const tf = (y - topY) / (botY - topY);
        const xR = w - topInset - (botInset - topInset) * tf;
        return (
          <g key={t}>
            <line x1={xR - 6} y1={y} x2={xR} y2={y} stroke="#1a1c1e" strokeWidth="1.5" opacity="0.55" />
            <text
              x={xR + 4}
              y={y + 3}
              fontSize={10}
              fill="#42474e"
              fontFamily="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
            >
              {Math.round(t * 100)}
            </text>
          </g>
        );
      })}
      {/* Big % label */}
      <text
        x={w / 2}
        y={h / 2 + 6}
        textAnchor="middle"
        fontSize={Math.round(w * 0.18)}
        fontWeight={800}
        fill="#0b1220"
        style={{ paintOrder: 'stroke', strokeLinejoin: 'round' }}
        stroke="#ffffff"
        strokeWidth={5}
      >
        {pctLabel}
      </text>
      <text
        x={w / 2}
        y={h / 2 + 6}
        textAnchor="middle"
        fontSize={Math.round(w * 0.18)}
        fontWeight={800}
        fill="#0b1220"
      >
        {pctLabel}
      </text>
    </svg>
  );
}
