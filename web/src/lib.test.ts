import { describe, expect, it } from "vitest";
import { backendIsStale, flatTasks, intersectCaps, shortStamp, taskHref } from "./lib";
import type { TaskSummary } from "./types";

function task(slug: string, segments: string[], children: TaskSummary[] = []): TaskSummary {
  return {
    slug, qualifiedSlug: segments.join("/"), segments,
    title: slug, status: "open", ownStatus: "open", type: "pr",
    parentSlug: null, isParent: children.length > 0, archived: false,
    created: null, closed: null, prs: [], tags: [],
    allowOrchestrator: false, hasReport: false, lock: null, children,
  };
}

describe("taskHref", () => {
  it("joins segments under /t/", () => {
    expect(taskHref(task("001-a", ["alpha", "001-a"]))).toBe("/t/alpha/001-a");
  });
  it("URL-encodes reserved characters per segment", () => {
    expect(taskHref(task("a b", ["p", "a b"]))).toBe("/t/p/a%20b");
  });
  it("includes the parent segment for child tasks", () => {
    expect(taskHref(task("c", ["p", "parent", "c"]))).toBe("/t/p/parent/c");
  });
});

describe("flatTasks", () => {
  it("flattens nested children depth-first", () => {
    const tree = [task("a", ["p", "a"], [task("b", ["p", "a", "b"])]), task("c", ["p", "c"])];
    expect(flatTasks(tree).map(t => t.slug)).toEqual(["a", "b", "c"]);
  });
});

describe("shortStamp", () => {
  it("trims an ISO stamp to minute precision", () => {
    expect(shortStamp("2026-07-06T21:12:38.123Z")).toBe("2026-07-06 21:12");
  });
});

describe("intersectCaps", () => {
  const caps = {
    open: ["promote", "close", "drop", "block"],
    ready: ["pull", "close", "drop", "block"],
    done: ["archive"],
  };
  it("returns a single status's caps in render order", () => {
    expect(intersectCaps(["open"], caps)).toEqual(["promote", "close", "drop", "block"]);
  });
  it("intersects across mixed statuses", () => {
    expect(intersectCaps(["open", "ready"], caps)).toEqual(["close", "drop", "block"]);
  });
  it("returns empty when nothing applies to all (and for unknown statuses)", () => {
    expect(intersectCaps(["open", "done"], caps)).toEqual([]);
    expect(intersectCaps(["weird"], caps)).toEqual([]);
    expect(intersectCaps([], caps)).toEqual([]);
  });
});

describe("backendIsStale", () => {
  it("flags a backend older than the bundle", () => {
    expect(backendIsStale({})).toBe(true);            // pre-versioning server
    expect(backendIsStale({ apiVersion: 1 })).toBe(true);
  });
  it("accepts current and newer backends, and stays quiet while loading", () => {
    expect(backendIsStale({ apiVersion: 2 })).toBe(false);
    expect(backendIsStale({ apiVersion: 99 })).toBe(false);
    expect(backendIsStale(null)).toBe(false);
  });
});
