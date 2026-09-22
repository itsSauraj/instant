/**
 * How a link in a note or the shared doc is labelled when it is rendered.
 *
 * A pasted URL is shown as a chip naming the site (its hostname, minus `www.`)
 * with a shortened path as the detail, the way chat apps show a mention rather
 * than the raw address. A markdown link with its own text keeps that text as
 * the label and shows the host as the detail, so a reader always sees where a
 * click will go. The full URL stays in the anchor's `href` and `title`.
 *
 * Everything here is derived from the URL itself. Fetching the page's real
 * title would hand every link anyone shares to a server, which is exactly what
 * this app promises never to do, so the hostname is the title.
 */

export type LinkLabel = {
  /** What the chip says. */
  label: string;
  /** Quieter second part: the path for a bare URL, the host for a named link. */
  detail: string | null;
  /** True when the visible text was the URL itself (an autolink). */
  bare: boolean;
};

/** Longer paths are cut so a chip never runs the width of a bubble. */
const MAX_PATH = 32;

/**
 * Returns null for anything that is not an absolute http(s) or mailto URL, in
 * which case the caller falls back to an ordinary anchor with the given text.
 */
export function describeLink(href: string | undefined, text: string): LinkLabel | null {
  if (!href) return null;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  const visible = text.trim();

  if (url.protocol === "mailto:") {
    const address = url.pathname;
    if (!address) return null;
    const bare = !visible || visible === address || visible === href;
    return bare
      ? { label: address, detail: null, bare: true }
      : { label: visible, detail: address, bare: false };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  const host = url.hostname.replace(/^www\./, "");
  if (isBare(visible, href)) {
    return { label: host, detail: shortenPath(url.pathname), bare: true };
  }
  // A label that already IS the host would only repeat itself as the detail.
  return { label: visible, detail: visible.toLowerCase() === host ? null : host, bare: false };
}

/** The text is "the URL" if it matches it modulo scheme, trailing slash and case. */
function isBare(text: string, href: string) {
  if (!text) return true;
  const strip = (value: string) =>
    value
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/\/+$/, "");
  return strip(text) === strip(href);
}

function shortenPath(pathname: string): string | null {
  let path = pathname.replace(/\/+$/, "");
  if (!path) return null;
  try {
    path = decodeURIComponent(path);
  } catch {
    // Malformed escapes: show the path as written.
  }
  return path.length > MAX_PATH ? `${path.slice(0, MAX_PATH - 1)}…` : path;
}
