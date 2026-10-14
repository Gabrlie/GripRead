import assert from "node:assert/strict";
import test from "node:test";
import { buildNumber } from "./version.mjs";

test("build numbers count minutes and keep versionCodes in range", () => {
  assert.equal(buildNumber(new Date(Date.UTC(2026, 0, 1, 0, 1))), 1);
  assert.ok(
    buildNumber(new Date(Date.UTC(2026, 9, 14, 12))) >
      buildNumber(new Date(Date.UTC(2026, 9, 14, 11, 59))),
  );
  // An APK's versionCode is the build number times ten plus an ABI digit.
  assert.ok(buildNumber(new Date(Date.UTC(2126, 0, 1))) * 10 + 9 < 2_100_000_000);
});
