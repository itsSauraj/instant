import Link from "next/link";

import { SiteNav } from "@/components/site-nav";

/**
 * Shared shell for the privacy and terms pages: island nav, one readable
 * column, panel-framed sections, and a way back home at the bottom.
 */
export function LegalPage({
  title,
  intro,
  updated,
  children,
}: {
  title: string;
  intro: string;
  updated: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mx-auto min-h-dvh w-full max-w-3xl px-5 pt-28 pb-10 sm:px-8">
      <SiteNav />

      <main>
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">{title}</h1>
        <p className="text-muted-foreground mt-3 text-sm">Last updated: {updated}</p>
        <p className="text-muted-foreground mt-5 text-base text-pretty">{intro}</p>

        <div className="mt-8 space-y-4">{children}</div>
      </main>

      <footer className="text-muted-foreground mt-10 flex items-center justify-between border-t pt-5 text-sm">
        <Link href="/" className="hover:text-foreground font-medium transition-colors">
          Back home
        </Link>
        <span>Instant</span>
      </footer>
    </div>
  );
}

export function LegalSection({
  heading,
  children,
}: {
  heading: string;
  children: React.ReactNode;
}) {
  return (
    <section className="panel p-5 sm:p-6">
      <h2 className="text-base font-semibold">{heading}</h2>
      <div className="text-muted-foreground mt-2 space-y-2 text-sm leading-relaxed [&_li]:ml-4 [&_li]:list-disc [&_strong]:text-foreground">
        {children}
      </div>
    </section>
  );
}
