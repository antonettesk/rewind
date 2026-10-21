/**
 * REWIND's signature backdrop: a bezel of version ticks and a counter-clockwise
 * rewind arrow, turning slowly backwards like a tape counter. Pure SVG; each
 * ring is its own element rotated with a CSS transform, so the GPU composites
 * it without repainting, and nothing here uses blur or blend modes.
 */
const C = 500; // viewBox centre

function ticks(r: number, count: number, long: number, short: number, every: number) {
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    const len = i % every === 0 ? long : short;
    const x1 = C + Math.cos(a) * r;
    const y1 = C + Math.sin(a) * r;
    const x2 = C + Math.cos(a) * (r - len);
    const y2 = C + Math.sin(a) * (r - len);
    out.push(`M${x1.toFixed(1)} ${y1.toFixed(1)}L${x2.toFixed(1)} ${y2.toFixed(1)}`);
  }
  return out.join('');
}

/** An open arc from `from` to `to` degrees (clockwise in SVG space), radius r. */
function arc(r: number, from: number, to: number) {
  const p = (deg: number) => {
    const a = (deg * Math.PI) / 180;
    return `${(C + Math.cos(a) * r).toFixed(1)} ${(C + Math.sin(a) * r).toFixed(1)}`;
  };
  const large = to - from > 180 ? 1 : 0;
  return `M${p(from)}A${r} ${r} 0 ${large} 1 ${p(to)}`;
}

const OUTER = ticks(494, 120, 22, 9, 10);
const MID = ticks(468, 60, 7, 4, 5);
// The rewind arrow: a long arc whose head points counter-clockwise.
const ARROW_R = 418;
const ARROW_ARC = arc(ARROW_R, 150, 420);
const head = (() => {
  const a = (150 * Math.PI) / 180;
  const x = C + Math.cos(a) * ARROW_R;
  const y = C + Math.sin(a) * ARROW_R;
  // Tangent pointing counter-clockwise at the arc's start.
  const tx = Math.sin(a);
  const ty = -Math.cos(a);
  const nx = Math.cos(a);
  const ny = Math.sin(a);
  const tip = [x + tx * 30, y + ty * 30];
  const l = [x + nx * 13, y + ny * 13];
  const r = [x - nx * 13, y - ny * 13];
  return `M${l[0]!.toFixed(1)} ${l[1]!.toFixed(1)}L${tip[0]!.toFixed(1)} ${tip[1]!.toFixed(1)}L${r[0]!.toFixed(1)} ${r[1]!.toFixed(1)}Z`;
})();
// Snapshot markers: the versions REWIND can return to.
// Offset so no marker sits directly above the headline.
const MARKS = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => {
  const a = ((i * 45 - 67.5) * Math.PI) / 180;
  return { x: C + Math.cos(a) * 452, y: C + Math.sin(a) * 452, label: `v${i + 1}`, active: i === 0 };
});

export function RewindDial({ className }: { className?: string }) {
  return (
    <div className={className} aria-hidden>
      <div className="relative aspect-square w-full">
        {/* Static glow: gradients, not blur filters, so phones pay nothing per frame. */}
        <div className="absolute inset-[4%] rounded-full bg-[radial-gradient(closest-side,rgba(99,102,241,.2),rgba(34,211,238,.07)_60%,transparent_80%)]" />
        <svg viewBox="0 0 1000 1000" className="dial-ccw-slow absolute inset-0 size-full">
          <path d={OUTER} stroke="url(#dial-fade)" strokeWidth="2" strokeLinecap="round" fill="none" />
          <defs>
            <linearGradient id="dial-fade" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#a5b4fc" stopOpacity=".55" />
              <stop offset=".55" stopColor="#67e8f9" stopOpacity=".18" />
              <stop offset="1" stopColor="#67e8f9" stopOpacity="0" />
            </linearGradient>
          </defs>
        </svg>
        <svg viewBox="0 0 1000 1000" className="dial-ccw-mid absolute inset-0 size-full">
          <path d={MID} stroke="rgba(165,180,252,.28)" strokeWidth="2" strokeLinecap="round" fill="none" />

        </svg>
        <svg viewBox="0 0 1000 1000" className="dial-ccw-fast absolute inset-0 size-full">
          <defs>
            <linearGradient id="dial-arrow" x1="0" y1="1" x2="1" y2="0">
              <stop offset="0" stopColor="#22d3ee" stopOpacity="0" />
              <stop offset=".7" stopColor="#67e8f9" stopOpacity=".55" />
              <stop offset="1" stopColor="#c7d2fe" stopOpacity=".95" />
            </linearGradient>
          </defs>
          <path d={ARROW_ARC} stroke="url(#dial-arrow)" strokeWidth="3" strokeLinecap="round" fill="none" />
          <path d={head} fill="#c7d2fe" stroke="#c7d2fe" strokeWidth="2" strokeLinejoin="round" />
        </svg>
        <svg viewBox="0 0 1000 1000" className="absolute inset-0 size-full">
          <circle cx={C} cy={C} r="452" stroke="rgba(255,255,255,.07)" strokeWidth="1" fill="none" strokeDasharray="2 10" />
          {MARKS.map((m) => (
            <g key={m.label}>
              <circle cx={m.x} cy={m.y} r={m.active ? 5 : 3} fill={m.active ? '#67e8f9' : 'rgba(255,255,255,.25)'} />
              {m.active && <circle cx={m.x} cy={m.y} r="12" stroke="#67e8f9" strokeOpacity=".4" fill="none" className="dial-ping" />}
              <text x={m.x} y={m.y - 13} textAnchor="middle" fontSize="15" fontFamily="JetBrains Mono Variable, ui-monospace, monospace" fill={m.active ? 'rgba(103,232,249,.8)' : 'rgba(255,255,255,.18)'}>
                {m.label}
              </text>
            </g>
          ))}
        </svg>
        <div className="absolute inset-[22%] rounded-full bg-[radial-gradient(closest-side,rgba(5,6,8,.85),rgba(5,6,8,.5)_60%,transparent)]" />
      </div>
    </div>
  );
}
