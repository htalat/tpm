import { test, expect } from "@playwright/test";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { E2E_ROOT } from "./setup";

// Integration coverage the unit suites structurally can't give: the built
// bundle against a real tpm serve + tree. This is the layer that would have
// caught the bulk-checkbox skew bug (frontend fine, backend fine, contract
// between them broken).

test("index renders every section and no skew banner on a current backend", async ({ page }) => {
  await page.goto("/app");
  await expect(page.getByText("Your inbox")).toBeVisible();
  await expect(page.getByText("Agent queue")).toBeVisible();
  await expect(page.getByText("In flight")).toBeVisible();
  await expect(page.getByText("Activity")).toBeVisible();
  await expect(page.getByText("older than this UI")).toHaveCount(0);
});

test("legacy URLs redirect into the SPA", async ({ page }) => {
  await page.goto("/t/demo/005-edit-me");
  await expect(page).toHaveURL(/\/app\/t\/demo\/005-edit-me$/);
  await page.goto("/t/demo/5"); // numeric permalink
  await expect(page).toHaveURL(/\/app\/t\/demo\/005-edit-me$/);
  await page.goto("/");
  await expect(page).toHaveURL(/\/app$/);
});

test("bulk multi-select: two ready tasks pull back to open", async ({ page }) => {
  await page.goto("/app");
  await page.check('input[aria-label="select demo/001-bulk-a"]');
  await page.check('input[aria-label="select demo/002-bulk-b"]');
  await expect(page.getByText("2 selected")).toBeVisible();
  await page.click('button:has-text("Pull from queue")');
  await expect(page.getByText("Pull from queue: 2 tasks updated")).toBeVisible();
  // The flip lands in the UI (SSE or the post-mutation refetch).
  await expect(page.locator('input[aria-label="select demo/001-bulk-a"]')).toBeVisible();
  const detail = await page.request.get("/api/tasks/demo/001-bulk-a");
  expect((await detail.json()).status).toBe("open");
});

test("bulk block requires a shared reason", async ({ page }) => {
  await page.goto("/app");
  await page.check('input[aria-label="select demo/003-block-a"]');
  await page.check('input[aria-label="select demo/004-block-b"]');
  const blockBtn = page.locator('div.fixed.bottom-0 button', { hasText: "Block" });
  await expect(blockBtn).toBeDisabled();
  await page.fill('div.fixed.bottom-0 input', "waiting on e2e");
  await expect(blockBtn).toBeEnabled();
  await blockBtn.click();
  await expect(page.getByText("Block: 2 tasks updated")).toBeVisible();
  const detail = await page.request.get("/api/tasks/demo/003-block-a");
  expect((await detail.json()).status).toBe("blocked");
});

test("task page: inline section edit persists through the mtime CAS", async ({ page }) => {
  await page.goto("/app/t/demo/005-edit-me");
  const planCard = page.locator("section", { has: page.getByRole("heading", { name: "Plan" }) });
  await planCard.getByText("edit").click();
  await planCard.locator("textarea").fill("1. rewritten by e2e\n");
  await planCard.getByRole("button", { name: "Save" }).click();
  await expect(planCard.getByText("rewritten by e2e")).toBeVisible();
});

test("task page: Close fills the outcome and flips to done", async ({ page }) => {
  await page.goto("/app/t/demo/006-close-me");
  await page.getByPlaceholder("outcome (optional)").fill("shipped in e2e");
  await page.getByRole("button", { name: "Close", exact: true }).click();
  // type=pr default archives on complete; the same URL resolves the archived copy.
  await expect(page.locator(".badge", { hasText: "done" }).first()).toBeVisible();
});

test("new task via project page create-&-ready lands on the task", async ({ page }) => {
  await page.goto("/app/p/demo");
  await page.getByRole("button", { name: "+ New task" }).click();
  await page.getByPlaceholder("Title", { exact: true }).fill("Born In E2E");
  await page.getByRole("button", { name: "Create & ready" }).click();
  await expect(page).toHaveURL(/\/app\/t\/demo\/born-in-e2e$/);
  await expect(page.locator(".badge", { hasText: "ready" }).first()).toBeVisible();
});

test("search finds by title and shows body snippets", async ({ page }) => {
  await page.goto("/app/search?q=searchable");
  await expect(page.getByText("Searchable Widget")).toBeVisible();
  await page.goto("/app/search?q=fixture context for searchable");
  await expect(page.getByText(/fixture context for searchable/).first()).toBeVisible();
});

test("runs page renders the transcript and the live tail appends", async ({ page }) => {
  await page.goto("/app/t/demo/008-running/runs");
  await expect(page.getByText("Current run (live)")).toBeVisible();
  await expect(page.getByText("first transcript line")).toBeVisible();
  await expect(page.getByText("sess-e2e-1")).toBeVisible();
  // Append to the log on disk; the 2s tail should pick it up.
  appendFileSync(
    join(E2E_ROOT, "demo", "tasks", "008-running", "runs", "20260707T010000Z.log"),
    '{"type":"assistant","message":{"content":[{"type":"text","text":"tail caught this"}]}}\n',
  );
  await expect(page.getByText("tail caught this")).toBeVisible({ timeout: 10_000 });
});

test("theme toggle forces dark, persists, and reverts to system", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/app");
  const canvas = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(await canvas()).toBe("rgb(246, 248, 250)");
  await page.click('button[title="dark theme"]');
  expect(await canvas()).toBe("rgb(13, 17, 23)");
  await page.reload();
  expect(await canvas()).toBe("rgb(13, 17, 23)");
  await page.click('button[title="system theme"]');
  expect(await canvas()).toBe("rgb(246, 248, 250)");
});

test("status journal drives the activity feed", async ({ page }) => {
  await page.goto("/app");
  // Earlier specs mutated statuses; the feed should show journal entries.
  await expect(page.locator("text=Activity")).toBeVisible();
  await expect(page.getByText(/promoted to ready|pulled from queue|blocked/).first()).toBeVisible();
});
