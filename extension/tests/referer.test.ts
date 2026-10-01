import { describe, it, expect, vi } from "vitest";
import { buildRefererRule } from "../src/referer";

const IMG = "https://scans.example/reader/ch1/p001.jpg";
const PAGE = "https://scans.example/reader/ch1";

describe("buildRefererRule", () => {
  it("matches the exact image URL and sets Referer to the page URL", () => {
    const rule = buildRefererRule(17, IMG, PAGE);
    expect(rule.id).toBe(17);
    expect(rule.action.type).toBe("modifyHeaders");
    expect(rule.action.requestHeaders).toEqual([
      { header: "Referer", operation: "set", value: PAGE },
    ]);
    expect(rule.condition.urlFilter).toBe(IMG);
    expect(rule.condition.resourceTypes).toEqual(["xmlhttprequest", "other"]);
  });

  it("scopes to the extension initiator when provided", () => {
    const rule = buildRefererRule(1, IMG, PAGE, { initiatorDomain: "extid" });
    expect(rule.condition.initiatorDomains).toEqual(["extid"]);
    expect(buildRefererRule(2, IMG, PAGE).condition.initiatorDomains).toBeUndefined();
  });
});

describe("rule id allocator", () => {
  it("never hands the same id to two live fetches", async () => {
    vi.resetModules();
    const { allocRuleId, releaseRuleId } = await import("../src/referer");
    const a = allocRuleId();
    const b = allocRuleId();
    const c = allocRuleId();
    expect(new Set([a, b, c]).size).toBe(3);
    releaseRuleId(b);
    const d = allocRuleId();
    expect(d).not.toBe(a);
    expect(d).not.toBe(c); // still no collision with live rules
  });

  it("reuses freed ids only via wraparound scan", async () => {
    vi.resetModules();
    const { allocRuleId, releaseRuleId } = await import("../src/referer");
    const held: number[] = [];
    for (let i = 0; i < 9999; i++) held.push(allocRuleId());
    expect(new Set(held).size).toBe(9999);
    releaseRuleId(held[0]);
    expect(allocRuleId()).toBe(held[0]); // cursor wrapped to the freed id
    expect(() => allocRuleId()).toThrow(); // table full again
  });
});
