import { animate, AnimatePresence, motion, useInView, useReducedMotion, useScroll, useSpring, useTransform, type MotionValue } from 'motion/react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { cx } from '../../components/ui';

/**
 * A slot-machine word swap on its own line. The outgoing and incoming words move
 * in lock-step inside a fixed-height mask, so they never overlap or reflow the
 * line around them. Static for reduced-motion users.
 */
export function WordRotator({ words, className, interval = 2600 }: { words: string[]; className?: string; interval?: number }) {
  const reduce = useReducedMotion();
  const [i, setI] = useState(0);
  useEffect(() => {
    if (reduce) return;
    const t = setInterval(() => setI((x) => (x + 1) % words.length), interval);
    return () => clearInterval(t);
  }, [reduce, words.length, interval]);
  const ease = [0.65, 0, 0.35, 1] as const;
  return (
    <span className="relative -my-[0.08em] block h-[1.28em] overflow-hidden" aria-hidden>
      <AnimatePresence initial={false}>
        <motion.span
          key={i}
          className={cx('absolute inset-x-0 top-0 block whitespace-nowrap leading-[1.28]', className)}
          initial={{ y: '105%' }}
          animate={{ y: '0%' }}
          exit={{ y: '-105%' }}
          transition={{ duration: 0.7, ease }}
        >
          {words[i]}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

/** Words that light up one by one as the paragraph scrolls through the viewport. */
export function ScrollWords({ text, className }: { text: string; className?: string }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start 0.9', 'end 0.45'] });
  const words = text.split(' ');
  return (
    <p ref={ref} className={cx('flex flex-wrap', className)}>
      <span className="sr-only">{text}</span>
      {words.map((w, i) => (
        <ScrollWord key={i} progress={scrollYProgress} range={[i / words.length, (i + 1) / words.length]}>
          {w}
        </ScrollWord>
      ))}
    </p>
  );
}

function ScrollWord({ children, progress, range }: { children: string; progress: MotionValue<number>; range: [number, number] }) {
  const opacity = useTransform(progress, range, [0.14, 1]);
  return (
    <motion.span style={{ opacity }} className="mr-[0.25em]" aria-hidden>
      {children}
    </motion.span>
  );
}

/** Counts up to a number once it scrolls into view. */
export function CountUp({ to, suffix = '', decimals = 0, className }: { to: number; suffix?: string; decimals?: number; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true, margin: '-60px' });
  const reduce = useReducedMotion();
  const [v, setV] = useState(0);
  useEffect(() => {
    if (!inView) return;
    if (reduce) return setV(to);
    const controls = animate(0, to, { duration: 1.6, ease: [0.16, 1, 0.3, 1], onUpdate: setV });
    return () => controls.stop();
  }, [inView, reduce, to]);
  return (
    <span ref={ref} className={cx('tabular', className)}>
      {v.toFixed(decimals)}
      {suffix}
    </span>
  );
}

/** A product shot that tilts up from the floor and settles flat as it scrolls in. */
export function TiltIn({ children, className }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion() || (typeof window !== 'undefined' && !window.matchMedia('(min-width: 1024px)').matches);
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start 1', 'start 0.5'] });
  const smooth = useSpring(scrollYProgress, { stiffness: 180, damping: 32, mass: 0.3 });
  const rotateX = useTransform(smooth, [0, 1], [24, 0]);
  const scale = useTransform(smooth, [0, 1], [0.9, 1]);
  const opacity = useTransform(smooth, [0, 0.5], [0.3, 1]);
  return (
    <div ref={ref} className={cx('[perspective:1400px]', className)}>
      <motion.div style={reduce ? undefined : { rotateX, scale, opacity, transformOrigin: '50% 100%' }}>{children}</motion.div>
    </div>
  );
}

/** A hairline progress bar pinned to the top of the viewport. */
export function ScrollProgress() {
  const { scrollYProgress } = useScroll();
  const scaleX = useSpring(scrollYProgress, { stiffness: 200, damping: 40 });
  return <motion.div style={{ scaleX }} className="fixed inset-x-0 top-0 z-[60] h-px origin-left bg-[linear-gradient(90deg,#818cf8,#22d3ee,#f0abfc)]" aria-hidden />;
}

/** Follows the pointer a little, then springs home. */
export function Magnetic({ children, strength = 0.25 }: { children: ReactNode; strength?: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const reduce = useReducedMotion();
  const x = useSpring(0, { stiffness: 300, damping: 20 });
  const y = useSpring(0, { stiffness: 300, damping: 20 });
  return (
    <motion.span
      ref={ref}
      style={{ x, y }}
      className="inline-flex"
      onPointerMove={(e) => {
        if (reduce || e.pointerType !== 'mouse') return;
        const r = ref.current!.getBoundingClientRect();
        x.set((e.clientX - r.left - r.width / 2) * strength);
        y.set((e.clientY - r.top - r.height / 2) * strength);
      }}
      onPointerLeave={() => {
        x.set(0);
        y.set(0);
      }}
    >
      {children}
    </motion.span>
  );
}

/** A card whose border and background light up under the cursor. */
export function SpotlightCard({ children, className }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div
      ref={ref}
      onMouseMove={(e) => {
        const r = ref.current!.getBoundingClientRect();
        ref.current!.style.setProperty('--x', `${e.clientX - r.left}px`);
        ref.current!.style.setProperty('--y', `${e.clientY - r.top}px`);
      }}
      className={cx(
        'group relative overflow-hidden rounded-2xl border border-white/10 bg-white/[.03] p-6 transition-colors hover:border-white/20',
        "before:pointer-events-none before:absolute before:inset-0 before:opacity-0 before:transition-opacity before:duration-300 before:content-[''] hover:before:opacity-100",
        'before:bg-[radial-gradient(420px_circle_at_var(--x)_var(--y),rgba(129,140,248,.16),transparent_45%)]',
        className,
      )}
    >
      <div className="relative">{children}</div>
    </div>
  );
}

/** Fade-and-rise once when scrolled into view. */
export function Reveal({ children, delay = 0, className }: { children: ReactNode; delay?: number; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, margin: '-80px' });
  return (
    <motion.div ref={ref} className={className} initial={{ opacity: 0, y: 32 }} animate={inView ? { opacity: 1, y: 0 } : {}} transition={{ duration: 0.9, delay, ease: [0.16, 1, 0.3, 1] }}>
      {children}
    </motion.div>
  );
}

const SESSION: { who: 'agent' | 'rewind'; text: string; tone?: string }[] = [
  { who: 'agent', text: 'tools/call execute_registered_action {"operation":"thermostat.set_mode","input":{"mode":"away"}}' },
  { who: 'rewind', text: '✓ succeeded · before v1 → after v2 · capability: compensatable', tone: 'text-emerald-300' },
  { who: 'agent', text: 'tools/call execute_registered_action {"operation":"tasks.update","input":{"add":["Check windows"]}}' },
  { who: 'rewind', text: '✓ succeeded · before v1 → after v2', tone: 'text-emerald-300' },
  { who: 'agent', text: 'tools/call execute_registered_action {"operation":"security.activate_routine"}' },
  { who: 'rewind', text: '✗ isError · SECURITY_HUB_REJECTED · effect: none · halting', tone: 'text-rose-300' },
  { who: 'rewind', text: '⟲ planner: undo #2 → #1 · compare-and-set · read back', tone: 'text-cyan-200' },
  { who: 'rewind', text: '✓ recovered · 2 verified · 0 unresolved', tone: 'text-cyan-200' },
];

/** A terminal that types out a real MCP exchange when it scrolls into view. */
export function Terminal() {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, margin: '-120px' });
  const reduce = useReducedMotion();
  const [line, setLine] = useState(0);
  const [chars, setChars] = useState(0);
  useEffect(() => {
    if (!inView) return;
    if (reduce) {
      setLine(SESSION.length);
      return;
    }
    if (line >= SESSION.length) return;
    const full = SESSION[line]!.text.length;
    const t = setTimeout(
      () => {
        if (chars < full) setChars((c) => Math.min(full, c + (SESSION[line]!.who === 'agent' ? 4 : 6)));
        else {
          setLine((l) => l + 1);
          setChars(0);
        }
      },
      chars < full ? 14 : 380,
    );
    return () => clearTimeout(t);
  }, [inView, line, chars, reduce]);

  return (
    <div ref={ref} className="overflow-hidden rounded-2xl border border-white/10 bg-[#07080b] shadow-2xl shadow-black/50">
      <div className="flex items-center gap-1.5 border-b border-white/10 px-4 py-2.5">
        <span className="size-2.5 rounded-full bg-rose-400/80" />
        <span className="size-2.5 rounded-full bg-amber-300/80" />
        <span className="size-2.5 rounded-full bg-emerald-400/80" />
        <span className="ml-3 font-mono text-[11px] text-white/40">POST /mcp · Streamable HTTP · MCP 2025-11-25</span>
      </div>
      <ol className="min-h-[300px] space-y-2 p-4 font-mono text-[12px] leading-relaxed">
        {SESSION.slice(0, Math.min(line + 1, SESSION.length)).map((l, i) => {
          const text = i < line ? l.text : l.text.slice(0, chars);
          return (
            <li key={i} className="flex gap-3">
              <span className={cx('w-[4.5rem] shrink-0 whitespace-nowrap text-right', l.who === 'agent' ? 'text-indigo-300/70' : 'text-white/30')}>{l.who === 'agent' ? 'agent ›' : 'rewind ‹'}</span>
              <span className={cx('break-all', l.tone ?? 'text-white/75')}>
                {text}
                {i === line && line < SESSION.length && <span className="ml-px inline-block h-3.5 w-1.5 translate-y-0.5 animate-pulse bg-white/70" aria-hidden />}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** Sticky scroll story: the visual on the left follows whichever text step is in view. */
export function useActiveStep(count: number) {
  const refs = useRef<(HTMLElement | null)[]>([]);
  const [active, setActive] = useState(0);
  useEffect(() => {
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (e.isIntersecting) setActive(Number((e.target as HTMLElement).dataset.step));
      },
      { rootMargin: '-45% 0px -45% 0px' },
    );
    refs.current.slice(0, count).forEach((el) => el && io.observe(el));
    return () => io.disconnect();
  }, [count]);
  return { active, bind: (i: number) => (el: HTMLElement | null) => void (refs.current[i] = el) };
}
