import type { ReactNode, SVGProps } from 'react';

/**
 * REWIND's own icon set. Drawn on a 24px grid with a 1.7 stroke and round
 * joins, two-tone: the part that carries the meaning is solid, supporting
 * structure is drawn at reduced opacity. Recovery icons share one motif, a
 * counter-clockwise arc. Same props as an <svg>; size comes from className.
 */
export type IconProps = SVGProps<SVGSVGElement>;
export type Icon = (props: IconProps) => ReactNode;

function icon(name: string, body: ReactNode): Icon {
  const C = (props: IconProps) => (
    <svg
      viewBox="0 0 24 24"
      width={24}
      height={24}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable="false"
      data-icon={name}
      {...props}
    >
      {body}
    </svg>
  );
  C.displayName = name;
  return C;
}

/** Supporting strokes, drawn quieter than the primary shape. */
const Q = ({ children }: { children: ReactNode }) => <g opacity={0.42}>{children}</g>;
const Dot = ({ cx, cy, r = 1.1 }: { cx: number; cy: number; r?: number }) => <circle cx={cx} cy={cy} r={r} fill="currentColor" stroke="none" />;

const shield = 'M12 3.2 19 5.8v5.6c0 4.4-3 7.9-7 9.4-4-1.5-7-5-7-9.4V5.8z';
const doc = 'M14 3.5H7a1.5 1.5 0 0 0-1.5 1.5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8z';

// ── Brand ────────────────────────────────────────────────────────────────────
/** The REWIND mark: two chevrons pulling back, the trailing one quieter. */
export const RewindMark = icon('RewindMark', (
  <>
    <path d="M11.8 6.2 6 12l5.8 5.8" strokeWidth={2} />
    <Q>
      <path d="M18.4 6.2 12.6 12l5.8 5.8" strokeWidth={2} />
    </Q>
  </>
));
/** Start something now: play, with a rewind trail behind it. */
export const Launch = icon('Launch', (
  <>
    <path d="M10.5 6.2v11.6l8.6-5.8z" />
    <Q>
      <path d="M3.5 9h3.5M2.5 12h5M3.5 15h3.5" />
    </Q>
  </>
));
/** An agent: a pointer that acts, with the node it acts on. */
export const AgentMark = icon('AgentMark', (
  <>
    <path d="M5 4.2 10.6 18l2-5.4 5.4-2z" />
    <Q>
      <circle cx="18.3" cy="18.3" r="2.2" />
      <path d="M13.6 13.6l2.9 2.9" />
    </Q>
  </>
));

// ── Recovery ─────────────────────────────────────────────────────────────────
export const RotateCcw = icon('RotateCcw', (
  <>
    <path d="M4.6 12a7.4 7.4 0 1 0 2.2-5.3L4.6 9" />
    <path d="M4.6 4.8V9h4.2" />
    <Q>
      <Dot cx={12} cy={12} r={1.4} />
    </Q>
  </>
));
export const Shield = icon('Shield', (
  <>
    <path d={shield} />
    <Q>
      <path d="M12 7.5v9.5" />
    </Q>
  </>
));
export const ShieldCheck = icon('ShieldCheck', (
  <>
    <Q>
      <path d={shield} />
    </Q>
    <path d="m8.8 12.1 2.2 2.2 4.2-4.3" />
  </>
));
export const ShieldAlert = icon('ShieldAlert', (
  <>
    <Q>
      <path d={shield} />
    </Q>
    <path d="M12 8.3v4.4" />
    <Dot cx={12} cy={15.6} />
  </>
));
export const FileLock2 = icon('FileLock2', (
  <>
    <Q>
      <path d={doc} />
      <path d="M14 3.5V8h4.5" />
    </Q>
    <rect x="8.8" y="13" width="6.4" height="4.8" rx="1.1" />
    <path d="M10.3 13v-1.1a1.7 1.7 0 0 1 3.4 0V13" />
  </>
));
export const ClipboardCheck = icon('ClipboardCheck', (
  <>
    <Q>
      <path d="M8.5 5H7A1.5 1.5 0 0 0 5.5 6.5v13A1.5 1.5 0 0 0 7 21h10a1.5 1.5 0 0 0 1.5-1.5v-13A1.5 1.5 0 0 0 17 5h-1.5" />
    </Q>
    <rect x="8.5" y="3" width="7" height="4" rx="1.2" />
    <path d="m9 13.6 2.1 2.1 4-4.1" />
  </>
));

// ── Status ───────────────────────────────────────────────────────────────────
export const Check = icon('Check', <path d="m5 12.5 4.3 4.3L19 7.2" />);
export const CheckCircle2 = icon('CheckCircle2', (
  <>
    <Q>
      <circle cx="12" cy="12" r="8.6" />
    </Q>
    <path d="m8.4 12.2 2.5 2.5 4.8-4.9" />
  </>
));
export const CircleAlert = icon('CircleAlert', (
  <>
    <Q>
      <circle cx="12" cy="12" r="8.6" />
    </Q>
    <path d="M12 7.8v4.8" />
    <Dot cx={12} cy={15.9} />
  </>
));
const triangle = 'M10.3 4.9a2 2 0 0 1 3.4 0l7.1 12.4a2 2 0 0 1-1.7 3H4.9a2 2 0 0 1-1.7-3z';
export const TriangleAlert = icon('TriangleAlert', (
  <>
    <Q>
      <path d={triangle} />
    </Q>
    <path d="M12 9.6v4.3" />
    <Dot cx={12} cy={16.9} />
  </>
));
export const AlertTriangle = TriangleAlert;
export const CircleSlash = icon('CircleSlash', (
  <>
    <Q>
      <circle cx="12" cy="12" r="8.6" />
    </Q>
    <path d="M6 18 18 6" />
  </>
));
/** A rewind arc that never closes, spun with animate-spin. */
export const Loader2 = icon('Loader2', (
  <>
    <Q>
      <circle cx="12" cy="12" r="8.4" opacity={0.5} />
    </Q>
    <path d="M12 3.6a8.4 8.4 0 0 1 8.4 8.4" />
  </>
));
export const Activity = icon('Activity', (
  <>
    <Q>
      <path d="M3 12h3.6" />
      <path d="M17.4 12H21" />
    </Q>
    <path d="m6.6 12 2.6-6.5 5.2 13 3-6.5" />
  </>
));

// ── Arrows and controls ──────────────────────────────────────────────────────
export const ArrowRight = icon('ArrowRight', (
  <>
    <Q>
      <path d="M4.5 12h13" />
    </Q>
    <path d="m12.8 6.3 5.7 5.7-5.7 5.7" />
  </>
));
export const ArrowLeft = icon('ArrowLeft', (
  <>
    <Q>
      <path d="M19.5 12h-13" />
    </Q>
    <path d="M11.2 6.3 5.5 12l5.7 5.7" />
  </>
));
export const ChevronDown = icon('ChevronDown', <path d="m6.5 9.5 5.5 5.5 5.5-5.5" />);
export const ChevronsUpDown = icon('ChevronsUpDown', <path d="m8 9.5 4-4 4 4M8 14.5l4 4 4-4" />);
export const CornerDownLeft = icon('CornerDownLeft', (
  <>
    <Q>
      <path d="M19 5v6a3 3 0 0 1-3 3H5.5" />
    </Q>
    <path d="m9.5 9.5-4.5 4.5 4.5 4.5" />
  </>
));
export const X = icon('X', <path d="m6.5 6.5 11 11m0-11-11 11" />);
export const Plus = icon('Plus', <path d="M12 5v14M5 12h14" />);
export const Menu = icon('Menu', (
  <>
    <path d="M4 7h16M4 12h16" />
    <Q>
      <path d="M4 17h10" />
    </Q>
  </>
));
export const Play = icon('Play', <path d="M7.8 5.4v13.2L18.6 12z" />);
export const Pause = icon('Pause', <path d="M8.5 5.5v13M15.5 5.5v13" />);
export const PlayCircle = icon('PlayCircle', (
  <>
    <Q>
      <circle cx="12" cy="12" r="8.6" />
    </Q>
    <path d="M10.2 8.7v6.6l5.3-3.3z" />
  </>
));
export const Search = icon('Search', (
  <>
    <circle cx="10.5" cy="10.5" r="6" />
    <Q>
      <path d="m15 15 4.8 4.8" strokeWidth={2.2} />
    </Q>
  </>
));
export const Download = icon('Download', (
  <>
    <path d="M12 4v10.5M7.6 10.2 12 14.6l4.4-4.4" />
    <Q>
      <path d="M5 19.5h14" />
    </Q>
  </>
));
export const Copy = icon('Copy', (
  <>
    <rect x="8.5" y="8.5" width="11.5" height="11.5" rx="2" />
    <Q>
      <path d="M15.5 8.5V5.5A1.5 1.5 0 0 0 14 4H5.5A1.5 1.5 0 0 0 4 5.5V14a1.5 1.5 0 0 0 1.5 1.5h3" />
    </Q>
  </>
));
export const Send = icon('Send', (
  <>
    <path d="M20.5 3.5 14 20.5l-3.6-6.9-6.9-3.6z" />
    <Q>
      <path d="m20.5 3.5-10.1 10.1" />
    </Q>
  </>
));
export const LogOut = icon('LogOut', (
  <>
    <Q>
      <path d="M10 4.5H6.5A1.5 1.5 0 0 0 5 6v12a1.5 1.5 0 0 0 1.5 1.5H10" />
    </Q>
    <path d="m14.5 8 4 4-4 4M18.5 12H9.5" />
  </>
));
export const Link2 = icon('Link2', (
  <>
    <path d="M9.5 17H7.5a5 5 0 0 1 0-10h2M14.5 7h2a5 5 0 0 1 0 10h-2" />
    <Q>
      <path d="M8.5 12h7" />
    </Q>
  </>
));

// ── Objects ──────────────────────────────────────────────────────────────────
export const LayoutDashboard = icon('LayoutDashboard', (
  <>
    <rect x="4" y="4" width="7" height="9" rx="1.6" />
    <rect x="13" y="11" width="7" height="9" rx="1.6" />
    <Q>
      <rect x="13" y="4" width="7" height="5" rx="1.6" />
      <rect x="4" y="15" width="7" height="5" rx="1.6" />
    </Q>
  </>
));
export const ListTree = icon('ListTree', (
  <>
    <rect x="3.5" y="3.5" width="6.5" height="4.2" rx="1.2" />
    <Q>
      <path d="M6.75 7.7v9.6a1 1 0 0 0 1 1H12M6.75 12.6H12" />
    </Q>
    <rect x="12" y="10.5" width="8.5" height="4.2" rx="1.2" />
    <rect x="12" y="16.2" width="8.5" height="4.2" rx="1.2" />
  </>
));
export const ListChecks = icon('ListChecks', (
  <>
    <path d="m4 7 1.6 1.6L8.4 5.8M4 14l1.6 1.6 2.8-2.8" />
    <Q>
      <path d="M11.5 7.2H20M11.5 14.2H20M11.5 19H17" />
    </Q>
  </>
));
export const Blocks = icon('Blocks', (
  <>
    <rect x="4" y="13" width="7" height="7" rx="1.6" />
    <rect x="13" y="13" width="7" height="7" rx="1.6" />
    <rect x="4" y="4" width="7" height="7" rx="1.6" />
    <Q>
      <rect x="13.2" y="3.2" width="6.6" height="6.6" rx="1.6" transform="rotate(12 16.5 6.5)" />
    </Q>
  </>
));
export const Plug = icon('Plug', (
  <>
    <Q>
      <path d="M9 3.5v4M15 3.5v4" />
    </Q>
    <path d="M6.5 7.5h11v3a5.5 5.5 0 0 1-11 0zM12 16v4.5" />
  </>
));
export const Webhook = icon('Webhook', (
  <>
    <circle cx="12" cy="5.8" r="2.3" />
    <circle cx="5.8" cy="17.2" r="2.3" />
    <circle cx="18.2" cy="17.2" r="2.3" />
    <Q>
      <path d="M10.9 7.9 7 15.1M13.1 7.9l3.9 7.2M8.1 17.2h7.8" />
    </Q>
  </>
));
export const Terminal = icon('Terminal', (
  <>
    <Q>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.2" />
    </Q>
    <path d="m7.5 9.5 3 2.5-3 2.5M12.5 15h4" />
  </>
));
export const FileText = icon('FileText', (
  <>
    <path d={doc} />
    <path d="M14 3.5V8h4.5" />
    <Q>
      <path d="M8.5 12.5h7M8.5 16h5" />
    </Q>
  </>
));
export const MessageSquare = icon('MessageSquare', (
  <>
    <path d="M5 5h14a1.5 1.5 0 0 1 1.5 1.5v8.6a1.5 1.5 0 0 1-1.5 1.5h-8.5l-4.5 3.6v-3.6H5a1.5 1.5 0 0 1-1.5-1.5V6.5A1.5 1.5 0 0 1 5 5z" />
    <Q>
      <path d="M8 9.5h8M8 12.5h5" />
    </Q>
  </>
));
export const LifeBuoy = icon('LifeBuoy', (
  <>
    <Q>
      <circle cx="12" cy="12" r="8.6" />
      <circle cx="12" cy="12" r="3.6" />
    </Q>
    <path d="m5.9 5.9 3.6 3.6m5 0 3.6-3.6m-3.6 8.6 3.6 3.6m-8.6-3.6-3.6 3.6" strokeWidth={2.2} />
  </>
));
export const Settings = icon('Settings', (
  <>
    <Q>
      <path d="M4 7.5h8.5M17.5 7.5H20M4 16.5h2.5M11.5 16.5H20" />
    </Q>
    <circle cx="15" cy="7.5" r="2.4" />
    <circle cx="9" cy="16.5" r="2.4" />
  </>
));
export const KeyRound = icon('KeyRound', (
  <>
    <circle cx="8.5" cy="15.5" r="3.8" />
    <path d="M11.2 12.8 19 5" />
    <Q>
      <path d="m16 8 2.2 2.2M13.8 10.2l1.6 1.6" />
    </Q>
  </>
));
export const Lock = icon('Lock', (
  <>
    <rect x="5" y="10.5" width="14" height="10" rx="2.2" />
    <Q>
      <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" />
    </Q>
    <path d="M12 14.5v2" />
  </>
));
export const Fingerprint = icon('Fingerprint', (
  <>
    <path d="M8.2 20c-1.6-2.1-2.6-4.6-2.6-7.6a6.4 6.4 0 0 1 12.8 0" />
    <path d="M9 12.5a3 3 0 0 1 6 0c0 2.6.7 4.8 1.9 6.6M12 12.6c0 3 .9 5.6 2.6 7.6" />
    <Q>
      <path d="M5 7.6a8.4 8.4 0 0 1 14 0M18.3 16.2c.1-1 .1-2 .1-3" />
    </Q>
  </>
));
export const GitBranch = icon('GitBranch', (
  <>
    <circle cx="6.5" cy="5.5" r="2" />
    <circle cx="6.5" cy="18.5" r="2" />
    <circle cx="17.5" cy="7.5" r="2" />
    <Q>
      <path d="M6.5 7.5v9M17.5 9.5a6 6 0 0 1-6 6h-3" />
    </Q>
  </>
));
export const Eye = icon('Eye', (
  <>
    <Q>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
    </Q>
    <circle cx="12" cy="12" r="3" />
  </>
));
export const EyeOff = icon('EyeOff', (
  <>
    <Q>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
    </Q>
    <path d="m4.5 4.5 15 15" />
  </>
));
export const Moon = icon('Moon', <path d="M19.5 14.6A8 8 0 0 1 9.4 4.5a8 8 0 1 0 10.1 10.1z" />);
export const Sun = icon('Sun', (
  <>
    <circle cx="12" cy="12" r="4" />
    <Q>
      <path d="M12 2.8v2M12 19.2v2M2.8 12h2M19.2 12h2M5.5 5.5l1.4 1.4M17.1 17.1l1.4 1.4M5.5 18.5l1.4-1.4M17.1 6.9l1.4-1.4" />
    </Q>
  </>
));
export const Laptop = icon('Laptop', (
  <>
    <rect x="5" y="5" width="14" height="10" rx="1.4" />
    <Q>
      <path d="M2.8 18.8h18.4" />
    </Q>
  </>
));
export const Mic = icon('Mic', (
  <>
    <rect x="9" y="3.5" width="6" height="10.5" rx="3" />
    <Q>
      <path d="M5.6 11.4a6.4 6.4 0 0 0 12.8 0M12 17.8v2.7" />
    </Q>
  </>
));

// ── People ───────────────────────────────────────────────────────────────────
const person = (
  <>
    <circle cx="9.5" cy="8.3" r="3.3" />
    <path d="M3.6 19.2c.8-3 3.1-4.7 5.9-4.7s5.1 1.7 5.9 4.7" />
  </>
);
export const Users = icon('Users', (
  <>
    {person}
    <Q>
      <circle cx="16.8" cy="9" r="2.6" />
      <path d="M17 14.6c2 0 3.6 1.2 4.3 3.6" />
    </Q>
  </>
));
export const UserPlus = icon('UserPlus', (
  <>
    {person}
    <Q>
      <path d="M18.5 8v5M16 10.5h5" />
    </Q>
  </>
));
export const UserCheck = icon('UserCheck', (
  <>
    {person}
    <path d="m16 10.6 1.8 1.8 3.4-3.5" />
  </>
));

// ── Home simulation ──────────────────────────────────────────────────────────
export const Home = icon('Home', (
  <>
    <path d="M4 10.4 12 4l8 6.4V19a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 19z" />
    <Q>
      <path d="M10 20.5v-5h4v5" />
    </Q>
  </>
));
export const Thermometer = icon('Thermometer', (
  <>
    <path d="M10 13.6V5.6a2 2 0 0 1 4 0v8a4 4 0 1 1-4 0z" />
    <Q>
      <path d="M12 9v7" />
    </Q>
    <Dot cx={12} cy={16.8} r={1.5} />
  </>
));
