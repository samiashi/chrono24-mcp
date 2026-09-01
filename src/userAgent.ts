// Headless Chrome/Chromium advertise "HeadlessChrome/<v>" in the UA, which
// Cloudflare hard-blocks - headless launches must override it. The version is
// probed from the actual browser at runtime (Fetcher.headlessUserAgent) so UA
// and Client Hints majors stay in sync; this constant is only the last-resort
// fallback when the probe fails. Headed launches keep the browser's native UA.
export const FALLBACK_CHROME_MAJOR = 152;

const platformPart =
  process.platform === "win32"
    ? "Windows NT 10.0; Win64; x64"
    : process.platform === "linux"
      ? "X11; Linux x86_64"
      : "Macintosh; Intel Mac OS X 10_15_7";

export function chromeUserAgent(major: number): string {
  return `Mozilla/5.0 (${platformPart}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}
