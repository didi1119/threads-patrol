import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Wrangler configuration", () => {
  it("defines isolated bindings and one consolidated cron registration", async () => {
    const config = JSON.parse(await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8")) as {
      name: string;
      main: string;
      compatibility_date: string;
      compatibility_flags: string[];
      browser: { binding: string };
      durable_objects: { bindings: Array<{ name: string; class_name: string }> };
      migrations: Array<{ tag: string; new_sqlite_classes: string[] }>;
      triggers: { crons: string[] };
    };

    expect(config.name).toBe("threads-patrol-scout-spike");
    expect(config.main).toBe("src/cloudflare-worker.ts");
    expect(config.compatibility_date).toBe("2026-09-27");
    expect(config.compatibility_date <= "2026-09-27").toBe(true);
    expect(config.compatibility_flags).toContain("nodejs_compat");
    expect(config.browser.binding).toBe("BROWSER");
    expect(Reflect.has(config, "kv_namespaces")).toBe(false);
    expect(config.durable_objects.bindings).toEqual([{
      name: "SCOUT_COORDINATOR",
      class_name: "ScoutCoordinatorDurableObject",
    }]);
    expect(config.migrations).toEqual([{
      tag: "v1",
      new_sqlite_classes: ["ScoutCoordinatorDurableObject"],
    }]);
    expect(config.triggers.crons).toEqual([
      "0,30 0,4,9,14 * * *",
    ]);
  });
});
