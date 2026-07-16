import { test } from "node:test";
import assert from "node:assert/strict";

import { planAttestation, planDelivery } from "./step-policy.js";

test("Step is unavailable when the trace is current", () => {
  assert.equal(planDelivery("step", false, "head"), "unavailable");
});

test("Step records pending work and can create the first node", () => {
  assert.equal(planDelivery("step", true, "head"), "append-local-step");
  assert.equal(planDelivery("step", false, ""), "append-local-step");
});

test("Send appends and distributes pending changes", () => {
  assert.equal(planDelivery("send", true, "head"), "append-and-send");
});

test("Send creates the first Step when the trace has no head", () => {
  assert.equal(planDelivery("send", false, ""), "append-and-send");
});

test("Send reuses the latest Step when nothing changed", () => {
  assert.equal(planDelivery("send", false, "head"), "send-latest");
});

test("Attest composes Step and Send for pending or first revisions", () => {
  assert.equal(planAttestation(true, "head", true), "append-send-attest");
  assert.equal(planAttestation(false, "", false), "append-send-attest");
});

test("Attest sends an existing local-only Step before endorsement", () => {
  assert.equal(planAttestation(false, "head", false), "send-attest");
});

test("Attest has no prerequisite for an already-Sent Step", () => {
  assert.equal(planAttestation(false, "head", true), "attest-only");
});
