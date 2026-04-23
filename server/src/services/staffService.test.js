// Regression test: meeting-type weights MUST override team-level meeting_pct.
//
// The hierarchy contract (see resolveStaffWeight in staffService.js):
//   - meeting-type weight present (even 0) -> wins
//   - meeting-type weight absent -> fall back to staff.meeting_pct
//
// Run with: node --test server/src/services/staffService.test.js
//
// This is a pure unit test -- no DB required. It stops someone from
// silently inverting the precedence in a future refactor of
// selectStaffForSlot().

const { test } = require('node:test');
const assert = require('node:assert/strict');

// Require the module lazily and pull only the pure helper so we don't
// need a live pg pool for the test run.
const { resolveStaffWeight } = require('./staffService');

test('meeting-type weight overrides team meeting_pct', () => {
  const staff = { id: 1, meeting_pct: 100 };
  const weights = { 1: 50 };
  assert.equal(resolveStaffWeight(staff, weights), 50);
});

test('meeting-type weight of 100 wins when team pct is 50', () => {
  // Vasco's scenario: team default low, meeting-type override high.
  const staff = { id: 7, meeting_pct: 50 };
  const weights = { 7: 100 };
  assert.equal(resolveStaffWeight(staff, weights), 100);
});

test('missing meeting-type weight falls back to team meeting_pct', () => {
  const staff = { id: 2, meeting_pct: 75 };
  const weights = { 1: 50 }; // no entry for staff 2
  assert.equal(resolveStaffWeight(staff, weights), 75);
});

test('meeting-type weight of 0 excludes staff (does NOT fall back to team pct)', () => {
  // Critical edge: 0 means "this staff is explicitly off this meeting type",
  // even if the team-level default is 100. Must not fall through to 100.
  const staff = { id: 3, meeting_pct: 100 };
  const weights = { 3: 0 };
  assert.equal(resolveStaffWeight(staff, weights), 0);
});

test('empty meeting-type weight map -> everyone uses team meeting_pct', () => {
  const staff = { id: 4, meeting_pct: 60 };
  assert.equal(resolveStaffWeight(staff, {}), 60);
});

test('undefined meeting-type weight map -> everyone uses team meeting_pct', () => {
  const staff = { id: 5, meeting_pct: 40 };
  assert.equal(resolveStaffWeight(staff, undefined), 40);
});

test('Vasco scenario: team all at 100, meeting has one at 100 and rest at 50', () => {
  // Team defaults: everyone 100.
  // Meeting overrides: A=100, B=50, C=50.
  // Expectation: A's effective weight 100, B and C effective weight 50 each.
  // Total weight ratio: A gets 100/200 = 50% of assignments, B and C 25% each.
  const staffA = { id: 'A', meeting_pct: 100 };
  const staffB = { id: 'B', meeting_pct: 100 };
  const staffC = { id: 'C', meeting_pct: 100 };
  const weights = { A: 100, B: 50, C: 50 };

  assert.equal(resolveStaffWeight(staffA, weights), 100);
  assert.equal(resolveStaffWeight(staffB, weights), 50);
  assert.equal(resolveStaffWeight(staffC, weights), 50);

  const total = resolveStaffWeight(staffA, weights)
    + resolveStaffWeight(staffB, weights)
    + resolveStaffWeight(staffC, weights);
  assert.equal(total, 200);
  assert.equal(resolveStaffWeight(staffA, weights) / total, 0.5);
});
