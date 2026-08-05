import { GUIDE_SECTIONS } from "@/components/guide/sections";

/**
 * The guide's table of contents. Plain anchor links - the browser handles the
 * jump, `scroll-mt` on each section keeps headings clear of the island nav,
 * and `scroll-smooth` on the page root makes the travel visible.
 *
 * Two shapes from one source of truth:
 *  - a sticky rail beside the content from `lg` up
 *  - a wrap of chips above the content below that
 */
export function GuideToc() {
  return (
    <>
      {/* Compact chips for narrow screens. */}
      <nav
        aria-label="On this page"
        data-slot="guide-toc-chips"
        className="panel p-4 lg:hidden"
      >
        <p className="text-muted-foreground text-xs font-medium tracking-widest uppercase">
          On this page
        </p>
        <ul className="mt-2.5 flex flex-wrap gap-1.5">
          {GUIDE_SECTIONS.map((section, index) => (
            <li key={section.id}>
              <a
                href={`#${section.id}`}
                className="bg-secondary/60 text-secondary-foreground hover:bg-accent hover:text-accent-foreground inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors"
              >
                <span aria-hidden className="text-primary font-mono text-[0.65rem]">
                  {index + 1}
                </span>
                {section.label}
              </a>
            </li>
          ))}
        </ul>
      </nav>

      {/* Sticky rail for wide screens. */}
      <nav
        aria-label="Table of contents"
        data-slot="guide-toc"
        className="sticky top-24 hidden max-h-[calc(100dvh-8rem)] self-start overflow-y-auto lg:block"
      >
        <p className="text-muted-foreground px-3 text-xs font-medium tracking-widest uppercase">
          On this page
        </p>
        <ul className="mt-2 space-y-0.5">
          {GUIDE_SECTIONS.map((section, index) => (
            <li key={section.id}>
              <a
                href={`#${section.id}`}
                className="text-muted-foreground hover:text-foreground hover:bg-accent flex items-baseline gap-2 rounded-lg px-3 py-1.5 text-sm transition-colors"
              >
                <span aria-hidden className="text-primary/70 w-4 shrink-0 font-mono text-[0.65rem]">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <span className="min-w-0">{section.label}</span>
              </a>
            </li>
          ))}
        </ul>
      </nav>
    </>
  );
}
