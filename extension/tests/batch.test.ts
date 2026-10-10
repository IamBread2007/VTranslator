import { describe, it, expect } from "vitest";
import { Batch, newBatchId } from "../src/batch";

const CFG = { consentThreshold: 10, maxPages: 60 };

describe("newBatchId", () => {
  it("returns a distinct id per call", () => {
    const ids = new Set(Array.from({ length: 50 }, () => newBatchId()));
    expect(ids.size).toBe(50);
  });
});

describe("Batch", () => {
  it("admits the first 10 pages without asking", () => {
    const b = new Batch(CFG);
    for (let i = 0; i < 10; i++) expect(b.admit(`p${i}`)).toEqual({ proceed: true, reason: "ok" });
    expect(b.accepted).toBe(10);
  });

  it("requires consent before the 11th unique page", () => {
    // The gate fires at dispatch time, so a lazy reader that reveals more pages
    // mid-batch cannot slip past a decision the user already made.
    const b = new Batch(CFG);
    for (let i = 0; i < 10; i++) b.admit(`p${i}`);
    expect(b.admit("p10")).toEqual({ proceed: false, reason: "consent-required" });
    expect(b.accepted).toBe(10); // not counted, because it was not dispatched
  });

  it("counts a repeated URL once, so a remount cannot re-trip consent", () => {
    const b = new Batch(CFG);
    for (let i = 0; i < 10; i++) b.admit(`p${i}`);
    expect(b.admit("p3")).toEqual({ proceed: true, reason: "ok" });
    expect(b.accepted).toBe(10);
  });

  it("requires consent repeatedly until it is granted", () => {
    const b = new Batch(CFG);
    for (let i = 0; i < 10; i++) b.admit(`p${i}`);
    expect(b.admit("p10").reason).toBe("consent-required");
    expect(b.admit("p11").reason).toBe("consent-required");
  });

  it("proceeds for new pages once consent is granted", () => {
    const b = new Batch(CFG);
    for (let i = 0; i < 10; i++) b.admit(`p${i}`);
    expect(b.admit("p10").reason).toBe("consent-required");
    b.grantConsent(10);
    expect(b.admit("p10")).toEqual({ proceed: true, reason: "ok" });
    expect(b.accepted).toBe(11);
  });

  it("asks again when the consented headroom runs out", () => {
    // Consent covers the pages the dialog actually showed. A lazy reader that
    // reveals more must re-ask rather than spend the user's money unwilled.
    const b = new Batch(CFG);
    for (let i = 0; i < 10; i++) b.admit(`p${i}`);
    b.grantConsent(5);
    for (let i = 10; i < 15; i++) expect(b.admit(`p${i}`).proceed).toBe(true);
    expect(b.admit("p15")).toEqual({ proceed: false, reason: "consent-required" });
  });

  it("caps granted consent so it cannot authorise past the cap", () => {
    const b = new Batch({ consentThreshold: 10, maxPages: 12 });
    for (let i = 0; i < 10; i++) b.admit(`p${i}`);
    b.grantConsent(100);
    expect(b.admit("p10").proceed).toBe(true);
    expect(b.admit("p11").proceed).toBe(true);
    expect(b.admit("p12")).toEqual({ proceed: false, reason: "cap-reached" });
  });

  it("stops at the cap and never auto-dispatches beyond it", () => {
    // Review Focus #5: a 65-page chapter must stop at 60.
    const b = new Batch(CFG);
    b.grantConsent(1000);
    for (let i = 0; i < 65; i++) b.admit(`p${i}`);
    expect(b.accepted).toBe(60);
    expect(b.admit("p65")).toEqual({ proceed: false, reason: "cap-reached" });
  });

  it("reports the cap before the consent gate once the cap is lower", () => {
    // A user who sets a cap below the threshold must never be asked to confirm
    // work that is already forbidden.
    const b = new Batch({ consentThreshold: 60, maxPages: 10 });
    for (let i = 0; i < 10; i++) expect(b.admit(`p${i}`).proceed).toBe(true);
    expect(b.admit("p10")).toEqual({ proceed: false, reason: "cap-reached" });
  });

  it("gives a new batch a fresh identity so a restart cannot inherit the old cap", () => {
    const a = new Batch(CFG);
    a.grantConsent(1000);
    for (let i = 0; i < 60; i++) a.admit(`p${i}`);
    expect(a.admit("extra").reason).toBe("cap-reached");

    const b = new Batch(CFG);
    expect(b.admit("extra")).toEqual({ proceed: true, reason: "ok" });
    expect(b.id).not.toBe(a.id);
  });

  it("reports a new batch id after reset so late responses can be rejected", () => {
    const b = new Batch(CFG);
    const first = b.id;
    b.admit("p0");
    b.reset();
    expect(b.id).not.toBe(first);
    expect(b.accepted).toBe(0);
  });

  it("drops granted consent on reset so a restart must ask again", () => {
    const b = new Batch(CFG);
    for (let i = 0; i < 10; i++) b.admit(`p${i}`);
    b.grantConsent(1000);
    b.reset();
    for (let i = 0; i < 10; i++) b.admit(`p${i}`);
    expect(b.admit("p10").reason).toBe("consent-required");
  });
});