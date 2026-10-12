import { vi } from "vitest";
import type { SourceService } from "../services/contracts";
import { createMemorySourceService } from "../preview/sources";

/** An in-memory source service whose methods are spies. */
export function sourceServiceMocks(initial: Record<string, unknown>[] = []): SourceService {
  const service = createMemorySourceService(initial);
  const spied = {} as Record<string, unknown>;
  for (const [name, method] of Object.entries(service))
    spied[name] = vi.fn(method as (...args: unknown[]) => unknown);
  return spied as unknown as SourceService;
}
