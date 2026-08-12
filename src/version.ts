export const MINIMUM_OMP_VERSION = "17.2.15";
export const MAXIMUM_OMP_MAJOR_EXCLUSIVE = 18;

type NumericVersion = readonly [major: number, minor: number, patch: number];

function numericVersion(version: string): NumericVersion | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version.trim());
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compare(left: NumericVersion, right: NumericVersion): number {
  for (let index = 0; index < left.length; index++) {
    const delta = left[index]! - right[index]!;
    if (delta !== 0) return delta;
  }
  return 0;
}

export function supportsOmpVersion(version: string): boolean {
  const actual = numericVersion(version);
  const minimum = numericVersion(MINIMUM_OMP_VERSION)!;
  return actual !== undefined && actual[0] < MAXIMUM_OMP_MAJOR_EXCLUSIVE && compare(actual, minimum) >= 0;
}

export function assertSupportedOmpVersion(version: string): void {
  if (supportsOmpVersion(version)) return;
  throw new Error(
    `@yukooshima/omp-codex-provider requires OMP >=${MINIMUM_OMP_VERSION} <${MAXIMUM_OMP_MAJOR_EXCLUSIVE}; found ${version}`,
  );
}
