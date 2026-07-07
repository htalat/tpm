import { describe, expect, it } from "vitest";
import { flatTasks, shortStamp, taskHref } from "./lib";
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
