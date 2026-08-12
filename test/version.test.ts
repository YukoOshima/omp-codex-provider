import { describe, expect, test } from "bun:test";
import { assertSupportedOmpVersion, supportsOmpVersion } from "../src/version.ts";

describe("OMP version support", () => {
  test.each([
    ["17.2.14", false],
    ["17.2.15", true],
    ["17.9.0-beta.1", true],
    ["18.0.0", false],
    ["invalid", false],
  ])("classifies %s", (version, supported) => {
    expect(supportsOmpVersion(version)).toBe(supported);
  });

  test("fails fast with the supported range", () => {
    expect(() => assertSupportedOmpVersion("18.0.0")).toThrow("requires OMP >=17.2.15 <18");
  });
});
