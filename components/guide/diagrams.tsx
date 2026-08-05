/**
 * Small inline SVG diagrams for the guide. Server-rendered, theme-aware via
 * currentColor and the app's color tokens, and marked decorative-with-text:
 * each figure carries a caption that states the same fact in words.
 */

/**
 * Where traffic actually flows: the server introduces the two browsers
 * (dashed), then everything travels on the direct encrypted link (solid).
 */
export function DirectPathDiagram() {
  return (
    <figure data-slot="diagram-direct-path" className="bg-background/50 rounded-lg border p-4">
      <svg
        viewBox="0 0 320 132"
        role="img"
        aria-label="Diagram: the server only introduces the two browsers; notes, files, audio and video travel on a direct encrypted link between them"
        className="mx-auto block w-full max-w-sm"
      >
        {/* Signalling server */}
        <g className="text-muted-foreground">
          <rect
            x="132"
            y="10"
            width="56"
            height="30"
            rx="7"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          />
          <text
            x="160"
            y="29"
            textAnchor="middle"
            fill="currentColor"
            className="font-mono"
            fontSize="9"
          >
            server
          </text>
          {/* Introductions: dashed, one to each browser */}
          <path
            d="M 138 42 L 74 84"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeDasharray="4 4"
          />
          <path
            d="M 182 42 L 246 84"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeDasharray="4 4"
          />
          <text x="160" y="66" textAnchor="middle" fill="currentColor" fontSize="8.5">
            introductions only
          </text>
        </g>

        {/* The direct encrypted link */}
        <g className="text-primary">
          <path d="M 96 104 L 224 104" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
          {/* A small padlock at the midpoint */}
          <rect x="152" y="98" width="16" height="12" rx="2.5" fill="currentColor" />
          <path
            d="M 156 98 v-3 a4 4 0 0 1 8 0 v3"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          />
          <text x="160" y="124" textAnchor="middle" fill="currentColor" fontSize="8.5">
            notes · doc · files · audio · video
          </text>
        </g>

        {/* Browsers */}
        <g className="text-foreground">
          <rect
            x="40"
            y="88"
            width="56"
            height="30"
            rx="7"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          />
          <text x="68" y="107" textAnchor="middle" fill="currentColor" className="font-mono" fontSize="9">
            you
          </text>
          <rect
            x="224"
            y="88"
            width="56"
            height="30"
            rx="7"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          />
          <text x="252" y="107" textAnchor="middle" fill="currentColor" className="font-mono" fontSize="9">
            them
          </text>
        </g>
      </svg>
      <figcaption className="text-muted-foreground mt-2 text-center text-xs">
        The server introduces browsers and relays connection setup. Content never touches it.
      </figcaption>
    </figure>
  );
}

/** A 7-peer full mesh: every participant connects directly to every other. */
export function MeshDiagram() {
  const peers = 7;
  const cx = 80;
  const cy = 74;
  const radius = 54;
  const points = Array.from({ length: peers }, (_, i) => {
    const angle = (Math.PI * 2 * i) / peers - Math.PI / 2;
    return {
      x: Math.round((cx + radius * Math.cos(angle)) * 10) / 10,
      y: Math.round((cy + radius * Math.sin(angle)) * 10) / 10,
    };
  });
  const edges: Array<[number, number]> = [];
  for (let a = 0; a < peers; a += 1) {
    for (let b = a + 1; b < peers; b += 1) edges.push([a, b]);
  }

  return (
    <figure data-slot="diagram-mesh" className="bg-background/50 rounded-lg border p-4">
      <svg
        viewBox="0 0 160 148"
        role="img"
        aria-label="Diagram: seven participants in a full mesh, every one connected directly to every other - 21 direct links"
        className="mx-auto block w-full max-w-45"
      >
        <g className="text-primary/45">
          {edges.map(([a, b]) => (
            <path
              key={`${a}-${b}`}
              d={`M ${points[a].x} ${points[a].y} L ${points[b].x} ${points[b].y}`}
              stroke="currentColor"
              strokeWidth="1"
            />
          ))}
        </g>
        <g className="text-primary">
          {points.map((point, index) => (
            <circle
              key={index}
              cx={point.x}
              cy={point.y}
              r="6.5"
              fill="currentColor"
              className={index === 0 ? "" : "opacity-70"}
            />
          ))}
        </g>
      </svg>
      <figcaption className="text-muted-foreground mt-2 text-center text-xs">
        7 people, 21 direct links, no media server in the middle.
      </figcaption>
    </figure>
  );
}
