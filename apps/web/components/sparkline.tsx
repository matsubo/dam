// Server-rendered SVG sparkline. No client JS, no chart library — just a
// computed <path> + a soft area-fill underneath. Used in DamCard for the
// home-page featured dams.
//
// Y-axis auto-scales between the series min/max with a tiny pad so the line
// has room to breathe; this matches the "interesting variation" framing of
// the dam-detail chart (which also doesn't anchor at 0).
export function Sparkline({
  values,
  width = 140,
  height = 56,
  stroke = '#1e6dff',
  fill = '#1e6dff',
}: {
  values: number[];
  width?: number;
  height?: number;
  stroke?: string;
  fill?: string;
}) {
  if (values.length < 2) return null;

  const padTop = 4;
  const padBot = 4;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;

  const xStep = (width - 1) / (values.length - 1);
  const y = (v: number) => padTop + (height - padTop - padBot) * (1 - (v - min) / span);

  let line = '';
  let area = '';
  for (let i = 0; i < values.length; i++) {
    const px = (i * xStep).toFixed(2);
    // biome-ignore lint/style/noNonNullAssertion: i is in-range
    const py = y(values[i]!).toFixed(2);
    if (i === 0) {
      line = `M${px},${py}`;
      area = `M${px},${height} L${px},${py}`;
    } else {
      line += ` L${px},${py}`;
      area += ` L${px},${py}`;
    }
  }
  area += ` L${(width - 1).toFixed(2)},${height} Z`;

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <defs>
        <linearGradient id="sparkfill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={fill} stopOpacity="0.18" />
          <stop offset="100%" stopColor={fill} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill="url(#sparkfill)" />
      <path d={line} fill="none" stroke={stroke} strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}
