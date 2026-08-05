"use client";

import { useRef } from "react";
import { useGSAP } from "@gsap/react";

import { EASE, gsap, prefersReducedMotion } from "@/lib/animation";
import { cn } from "@/lib/utils";

/**
 * An animated diagram of a live session: five browsers joined in a full mesh,
 * with the things the app actually shares - a file, a message, audio, video -
 * travelling directly between them. It exists to make "peer to peer" legible
 * at a glance, before any copy is read.
 *
 * Everything is drawn with the design-token CSS variables so both themes work
 * without a single hardcoded color. The SVG itself is decorative
 * (aria-hidden); a visually-hidden caption alongside carries the meaning for
 * screen readers.
 */

/** Deliberately NOT a regular pentagon: real rooms are people, not geometry. */
const NODES = [
  // The first node is the host, marked with the same crown the room UI uses.
  { id: "host", x: 150, y: 96, host: true },
  { id: "n1", x: 392, y: 70, host: false },
  { id: "n2", x: 468, y: 216, host: false },
  { id: "n3", x: 258, y: 268, host: false },
  { id: "n4", x: 72, y: 212, host: false },
] as const;

type NodeId = (typeof NODES)[number]["id"];

const NODE_MAP = Object.fromEntries(NODES.map((n) => [n.id, n])) as Record<
  NodeId,
  (typeof NODES)[number]
>;

/** Every pair gets a faint edge, so the drawing reads as a full mesh. */
const EDGES = NODES.flatMap((a, i) =>
  NODES.slice(i + 1).map((b) => ({ id: `${a.id}-${b.id}`, a, b })),
);

/**
 * The travelling payloads. Durations, delays and rest gaps are all different
 * on purpose: four loops with shared numbers phase-lock into something that
 * reads as mechanical within seconds.
 */
const PACKETS: Array<{
  kind: "file" | "chat" | "audio" | "video";
  from: NodeId;
  to: NodeId;
  travel: number;
  delay: number;
  restBetween: number;
  /** Where along the edge the packet sits in the static (reduced-motion) render. */
  staticAt: number;
}> = [
  { kind: "file", from: "host", to: "n2", travel: 3.6, delay: 0.2, restBetween: 1.1, staticAt: 0.44 },
  { kind: "chat", from: "n1", to: "n4", travel: 3.0, delay: 1.4, restBetween: 1.5, staticAt: 0.58 },
  { kind: "audio", from: "n3", to: "n1", travel: 2.6, delay: 2.2, restBetween: 0.9, staticAt: 0.36 },
  { kind: "video", from: "n2", to: "n4", travel: 4.2, delay: 0.8, restBetween: 1.3, staticAt: 0.62 },
];

/** Heights of the little waveform bars inside the audio chip. */
const WAVE_BARS = [6, 12, 9, 14, 7];

/** Lucide's crown outline, inlined because it lives inside our own <svg>. */
function CrownGlyph({ x, y }: { x: number; y: number }) {
  return (
    <g
      transform={`translate(${x - 7} ${y - 37}) scale(0.6)`}
      stroke="var(--warning)"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      fill="none"
    >
      <path d="M11.562 3.266a.5.5 0 0 1 .876 0L15.39 8.87a1 1 0 0 0 1.516.294L21.183 5.5a.5.5 0 0 1 .798.519l-2.834 10.246a1 1 0 0 1-.956.735H5.81a1 1 0 0 1-.957-.735L2.02 6.02a.5.5 0 0 1 .798-.519l4.276 3.664a1 1 0 0 0 1.516-.294z" />
      <path d="M5 21h14" />
    </g>
  );
}

/** One payload glyph, drawn centered on (0,0) so positioning is a translate. */
function PacketGlyph({ kind }: { kind: (typeof PACKETS)[number]["kind"] }) {
  switch (kind) {
    case "file":
      return (
        <>
          <rect x={-13} y={-10} width={26} height={20} rx={4} fill="var(--card)" stroke="var(--border)" />
          <path d="M-8 -5 h9" stroke="var(--muted-foreground)" strokeWidth={1.5} strokeLinecap="round" />
          <path d="M-8 -1 h13" stroke="var(--muted-foreground)" strokeWidth={1.5} strokeLinecap="round" />
          {/* Progress track + fill. The fill's scaleX animates with the trip,
              so the card visibly "arrives complete". Statically it sits at 60%. */}
          <g transform="translate(-8 4)">
            <rect width={16} height={3} rx={1.5} fill="var(--muted)" />
            <rect
              data-packet-progress
              width={16}
              height={3}
              rx={1.5}
              fill="var(--success)"
              transform="scale(0.6 1)"
            />
          </g>
        </>
      );
    case "chat":
      return (
        <>
          <rect x={-12} y={-9} width={24} height={16} rx={6} fill="var(--card)" stroke="var(--border)" />
          <path d="M-8 6 L-8 12 L-2 6.6 Z" fill="var(--card)" stroke="var(--border)" strokeLinejoin="round" />
          <circle cx={-5} cy={-1} r={1.6} fill="var(--primary)" />
          <circle cx={0} cy={-1} r={1.6} fill="var(--primary)" />
          <circle cx={5} cy={-1} r={1.6} fill="var(--primary)" />
        </>
      );
    case "audio":
      return (
        <>
          <rect x={-14} y={-9} width={28} height={18} rx={5} fill="var(--card)" stroke="var(--border)" />
          {WAVE_BARS.map((h, i) => (
            <rect
              key={i}
              data-wave-bar
              x={-10 + i * 4.5}
              y={-h / 2}
              width={2.5}
              height={h}
              rx={1.25}
              fill="var(--primary)"
            />
          ))}
        </>
      );
    case "video":
      return (
        <>
          <rect x={-13} y={-9} width={26} height={18} rx={4} fill="var(--card)" stroke="var(--border)" />
          <rect x={-8} y={-4.5} width={10} height={9} rx={2} stroke="var(--primary)" strokeWidth={1.5} fill="none" />
          <path d="M4 -1.5 L8.5 -4 V4 L4 1.5 Z" stroke="var(--primary)" strokeWidth={1.5} fill="none" strokeLinejoin="round" />
        </>
      );
  }
}

export function MeshVisual({ className }: { className?: string }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  useGSAP(
    () => {
      // Reduced motion: the SSR markup already IS the full diagram (packets
      // mid-edge, progress partly filled), so the right behavior is to do
      // nothing at all - no loops, no observers.
      if (prefersReducedMotion()) return;

      const svg = svgRef.current;
      if (!svg) return;
      const q = gsap.utils.selector(svg);
      const anims: gsap.core.Animation[] = [];

      // Gentle breathing on every node's halo. Staggered starts keep the five
      // from inhaling in unison.
      anims.push(
        gsap.to(q("[data-node-halo]"), {
          scale: 1.22,
          opacity: 0.28,
          transformOrigin: "50% 50%",
          duration: 2.6,
          ease: EASE.inOut,
          repeat: -1,
          yoyo: true,
          stagger: 0.45,
        }),
      );

      // Slow dash-flow shimmer on the edges that carry traffic. -24 is a
      // multiple of the dash period (3+9), so each loop wraps seamlessly.
      anims.push(
        gsap.to(q("[data-mesh-flow]"), {
          strokeDashoffset: -24,
          duration: 2.8,
          ease: "none",
          repeat: -1,
        }),
      );

      // The waveform bars pulse continuously; the stagger turns five identical
      // yoyos into something that scans as speech.
      anims.push(
        gsap.to(q("[data-wave-bar]"), {
          scaleY: 0.4,
          transformOrigin: "50% 50%",
          duration: 0.4,
          ease: "sine.inOut",
          repeat: -1,
          yoyo: true,
          stagger: 0.13,
        }),
      );

      // One looping trip per payload: pop in at the sender, glide the edge,
      // fade out on arrival, and give the receiving node a small pulse.
      for (const packet of PACKETS) {
        const el = q(`[data-mesh-packet="${packet.kind}"]`)[0];
        if (!el) continue;
        const from = NODE_MAP[packet.from];
        const to = NODE_MAP[packet.to];
        const ring = q(`[data-mesh-node="${packet.to}"] [data-node-ring]`);
        const progress = packet.kind === "file" ? q("[data-packet-progress]") : null;

        // Jump to the departure point NOW, not at the timeline's delayed
        // start, so no packet lingers at its static mid-edge position.
        gsap.set(el, { x: from.x, y: from.y, opacity: 0, scale: 0.6, transformOrigin: "50% 50%" });

        const tl = gsap.timeline({
          delay: packet.delay,
          repeat: -1,
          repeatDelay: packet.restBetween,
        });
        tl.set(el, { x: from.x, y: from.y, opacity: 0, scale: 0.6 }, 0);
        if (progress) tl.set(progress, { scaleX: 0, transformOrigin: "0% 50%" }, 0);
        tl.to(el, { opacity: 1, scale: 1, duration: 0.35, ease: EASE.pop }, 0.05);
        tl.to(el, { x: to.x, y: to.y, duration: packet.travel, ease: "power1.inOut" }, 0.2);
        if (progress) tl.to(progress, { scaleX: 1, duration: packet.travel, ease: "none" }, 0.2);
        tl.to(el, { opacity: 0, scale: 0.65, duration: 0.28, ease: "power2.in" }, 0.2 + packet.travel - 0.24);
        tl.fromTo(
          ring,
          { scale: 1 },
          {
            scale: 1.14,
            transformOrigin: "50% 50%",
            duration: 0.22,
            ease: "sine.out",
            yoyo: true,
            repeat: 1,
          },
          0.2 + packet.travel - 0.26,
        );
        anims.push(tl);
      }

      // Infinite loops on a hidden tab or an offscreen diagram burn battery
      // for nobody, so both gates pause everything. `resume` (not `play`)
      // preserves direction for the yoyo tweens.
      let tabVisible = !document.hidden;
      let onScreen = true;
      const sync = () => {
        const run = tabVisible && onScreen;
        for (const anim of anims) {
          if (run) anim.resume();
          else anim.pause();
        }
      };
      const onVisibility = () => {
        tabVisible = !document.hidden;
        sync();
      };
      document.addEventListener("visibilitychange", onVisibility);
      const observer = new IntersectionObserver(
        (entries) => {
          onScreen = entries[0]?.isIntersecting ?? true;
          sync();
        },
        { threshold: 0.1 },
      );
      observer.observe(svg);

      // Timelines and tweens are reverted by useGSAP's context; the listener
      // and observer are ours to remove.
      return () => {
        document.removeEventListener("visibilitychange", onVisibility);
        observer.disconnect();
      };
    },
    { scope: rootRef },
  );

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      <svg
        ref={svgRef}
        data-mesh-visual
        aria-hidden="true"
        viewBox="0 0 560 340"
        fill="none"
        className="h-auto w-full"
      >
        {/* Every pair is faintly connected: the mesh is the point. */}
        {EDGES.map(({ id, a, b }) => (
          <line
            key={id}
            data-mesh-edge
            x1={a.x}
            y1={a.y}
            x2={b.x}
            y2={b.y}
            stroke="var(--border)"
            strokeWidth={1.25}
          />
        ))}

        {/* Dashed overlays on the edges that carry the demo traffic. */}
        {PACKETS.map((p) => {
          const from = NODE_MAP[p.from];
          const to = NODE_MAP[p.to];
          return (
            <line
              key={p.kind}
              data-mesh-flow
              x1={from.x}
              y1={from.y}
              x2={to.x}
              y2={to.y}
              stroke="color-mix(in oklab, var(--primary) 50%, transparent)"
              strokeWidth={1.5}
              strokeDasharray="3 9"
              strokeLinecap="round"
            />
          );
        })}

        {NODES.map((n) => (
          <g key={n.id} data-mesh-node={n.id}>
            <circle
              data-node-halo
              cx={n.x}
              cy={n.y}
              r={22}
              fill="var(--primary)"
              opacity={0.14}
            />
            <circle
              data-node-ring
              cx={n.x}
              cy={n.y}
              r={13}
              fill="var(--card)"
              stroke={n.host ? "var(--primary)" : "var(--border)"}
              strokeWidth={n.host ? 1.5 : 1.25}
            />
            <circle
              cx={n.x}
              cy={n.y}
              r={4.5}
              fill={n.host ? "var(--primary)" : "var(--muted-foreground)"}
            />
            {n.host ? (
              <>
                <CrownGlyph x={n.x} y={n.y} />
                <text
                  x={n.x}
                  y={n.y + 28}
                  textAnchor="middle"
                  fontSize={9}
                  fontFamily="inherit"
                  fill="var(--muted-foreground)"
                >
                  Host
                </text>
              </>
            ) : null}
          </g>
        ))}

        {/* Packets start life mid-edge and fully visible: that IS the
            reduced-motion (and pre-hydration) render. GSAP repositions them
            before the section fades in, so motion users never see this state. */}
        {PACKETS.map((p) => {
          const from = NODE_MAP[p.from];
          const to = NODE_MAP[p.to];
          const sx = from.x + (to.x - from.x) * p.staticAt;
          const sy = from.y + (to.y - from.y) * p.staticAt;
          return (
            <g key={p.kind} data-mesh-packet={p.kind} transform={`translate(${sx} ${sy})`}>
              <PacketGlyph kind={p.kind} />
            </g>
          );
        })}
      </svg>
      {/* The caption lives OUTSIDE the aria-hidden SVG so it is actually read. */}
      <p className="sr-only">
        Diagram of a live session: five people connected directly to each other in a full
        mesh, with a file, a chat message, audio and video travelling between their
        browsers. One participant wears a crown marking them as the host.
      </p>
    </div>
  );
}
