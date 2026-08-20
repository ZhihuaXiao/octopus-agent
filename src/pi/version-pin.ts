/** The pi package we embed. See docs/adr/0001-embed-pi-sdk-in-process.md. */
export const PI_PACKAGE = "@earendil-works/pi-coding-agent";

const EXACT_SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-.]+)?(?:\+[0-9A-Za-z-.]+)?$/;

/**
 * Whether a package.json version spec names exactly one release.
 *
 * Pi ships breaking changes in minor releases and never publishes a major, so a
 * range specifier here would let one arrive silently on the next install.
 */
export function isExactVersionSpec(spec: string): boolean {
  return EXACT_SEMVER.test(spec);
}
