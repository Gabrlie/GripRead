import { vi } from "vitest";
import type { FeedService } from "../services/contracts";
import { memoryFeeds } from "../preview/feeds";

/** The in-memory feed service with every method spied on. */
export function feedServiceMocks(seed = true, overrides: Partial<FeedService> = {}): FeedService {
  const base = memoryFeeds(seed);
  const spied = Object.fromEntries(
    Object.entries(base).map(([name, method]) => [name, vi.fn(method as never)]),
  ) as unknown as FeedService;
  return { ...spied, ...overrides };
}
