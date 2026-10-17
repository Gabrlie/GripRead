// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { usePageLayer } from "./use-page-layer";

afterEach(cleanup);

function Page() {
  const ref = usePageLayer(() => undefined);
  return <div ref={ref} role="dialog" data-open="" />;
}

describe("full-screen pages", () => {
  it("keep the window behind still while any of them is open", () => {
    const root = document.documentElement;
    const first = render(<Page />);
    const second = render(<Page />);
    expect(root.classList.contains("page-layer-open")).toBe(true);
    second.unmount();
    expect(root.classList.contains("page-layer-open")).toBe(true);
    first.unmount();
    expect(root.classList.contains("page-layer-open")).toBe(false);
  });
});
