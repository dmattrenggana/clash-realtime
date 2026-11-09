import assert from "node:assert/strict";
import { BattleRoom } from "../src/rooms/BattleRoom.js";
import {
  Player,
  DeployedUnit,
  CARD_HP,
} from "../src/rooms/schema/BattleState.js";
import {
  applyStatBuffs,
  buffMultiplierAt,
  handleBuffDeathEffects,
  updateBuffZones,
  WARLORD_JESSE_AURA_MULTIPLIER,
  WARLORD_JESSE_BUFF_RADIUS,
  WARLORD_JESSE_DEATH_DURATION_SEC,
  WARLORD_JESSE_DEATH_MULTIPLIER,
} from "../src/game/buffs.js";

/**
 * The Warlord Jesse's stat buff (2026-11-09).
 *
 * While he lives he projects a 5-unit radius aura that gives every unit
 * inside it +10% to all of its stats. When he dies the aura bursts into a
 * +30% buff for 4 seconds at the spot where he fell.
 */

function makeRoom() {
  const room = new BattleRoom();
  (room as any).onCreate({ seed: "test-seed" });
  const state = (room as any).state;
  state.status = "playing";

  const p0 = new Player();
  p0.walletAddress = "0xowner";
  p0.team = 0;
  state.players.set("p0", p0);

  const p1 = new Player();
  p1.walletAddress = "0xenemy";
  p1.team = 1;
  state.players.set("p1", p1);

  return { room, state, owner: p0, enemy: p1 };
}

function makeUnit(cardId: string, x: number, z: number, hp = 100): DeployedUnit {
  const u = new DeployedUnit();
  u.cardId = cardId;
  u.x = x;
  u.z = z;
  u.hp = hp;
  u.maxHp = hp;
  u.team = 0;
  u.action = "idle";
  return u;
}

describe("Warlord Jesse stat buff", () => {
  it("projects an aura of radius 5 that buffs every unit inside it by 10%", () => {
    const { state, owner } = makeRoom();

    const jesse = makeUnit("warlord_jesse", 0, 0, 220);
    owner.units.set("jesse", jesse);

    const inside = makeUnit("knight", 3, 0, 100);
    owner.units.set("knight", inside);
    const outside = makeUnit("knight", 6, 0, 100);
    owner.units.set("far", outside);

    updateBuffZones(state);
    applyStatBuffs(state);

    // The aura exists and covers a 5-unit radius.
    const zone = state.buffZones.get("wj-aura-jesse");
    assert.ok(zone, "the aura zone should exist");
    assert.equal(zone.radius, WARLORD_JESSE_BUFF_RADIUS);
    assert.equal(zone.phase, "active");
    assert.equal(zone.multiplier, WARLORD_JESSE_AURA_MULTIPLIER);

    // The unit inside is buffed, the one outside is not.
    assert.equal(inside.statBuff, 1.1);
    assert.equal(outside.statBuff, 1);
    assert.equal(inside.maxHp, 110, "the max HP is scaled by the buff");
    assert.equal(inside.hp, 110);
    assert.equal(outside.maxHp, 100);
  });

  it("buffs enemy units as well (the aura is not team-locked)", () => {
    const { state, owner, enemy } = makeRoom();
    const jesse = makeUnit("warlord_jesse", 0, 0, 220);
    owner.units.set("jesse", jesse);

    const foe = makeUnit("knight", 2, 0, 100);
    foe.team = 1;
    enemy.units.set("foe", foe);

    updateBuffZones(state);
    applyStatBuffs(state);

    assert.equal(foe.statBuff, 1.1);
    assert.equal(foe.maxHp, 110);
  });

  it("turns into a +30% burst for 4 seconds when the Warlord Jesse dies", () => {
    const { state, owner } = makeRoom();
    const jesse = makeUnit("warlord_jesse", 0, 0, 220);
    owner.units.set("jesse", jesse);

    updateBuffZones(state);
    assert.ok(state.buffZones.get("wj-aura-jesse"));

    // He dies at t = 1000ms.
    state.elapsedMs = 1000;
    jesse.hp = 0;
    handleBuffDeathEffects(state, jesse, "jesse");

    const burst = state.buffZones.get("wj-death-jesse");
    assert.ok(burst, "the death burst should exist");
    assert.equal(burst.phase, "death");
    assert.equal(burst.multiplier, WARLORD_JESSE_DEATH_MULTIPLIER);
    assert.equal(burst.radius, WARLORD_JESSE_BUFF_RADIUS);
    assert.equal(burst.expiresAt, 1000 + WARLORD_JESSE_DEATH_DURATION_SEC * 1000);

    // The alive aura is gone.
    updateBuffZones(state);
    assert.equal(state.buffZones.get("wj-aura-jesse"), undefined);
    assert.ok(state.buffZones.get("wj-death-jesse"), "the burst survives the aura cleanup");

    // The units around him now get the 30% buff.
    const inside = makeUnit("knight", 2, 0, 100);
    owner.units.set("knight", inside);
    applyStatBuffs(state);
    assert.equal(inside.statBuff, 1.3);
    assert.equal(inside.maxHp, 130);
  });

  it("removes the burst once the 4 seconds are up", () => {
    const { state, owner } = makeRoom();
    const jesse = makeUnit("warlord_jesse", 0, 0, 220);
    owner.units.set("jesse", jesse);

    state.elapsedMs = 1000;
    jesse.hp = 0;
    handleBuffDeathEffects(state, jesse, "jesse");

    state.elapsedMs = 1000 + WARLORD_JESSE_DEATH_DURATION_SEC * 1000 - 10;
    updateBuffZones(state);
    assert.ok(state.buffZones.get("wj-death-jesse"), "still alive just before the end");

    state.elapsedMs = 1000 + WARLORD_JESSE_DEATH_DURATION_SEC * 1000;
    updateBuffZones(state);
    assert.equal(state.buffZones.get("wj-death-jesse"), undefined, "the burst expired");
  });

  it("scales the HP proportionally when the buff changes", () => {
    const { state, owner } = makeRoom();
    const unit = makeUnit("knight", 0, 0, CARD_HP.knight);
    unit.hp = 100; // half HP
    owner.units.set("knight", unit);

    // A +30% burst covers it.
    const zone = state.buffZones.get("wj-death-jesse");
    assert.equal(zone, undefined);
    const jesse = makeUnit("warlord_jesse", 0, 0, 220);
    owner.units.set("jesse", jesse);
    state.elapsedMs = 500;
    jesse.hp = 0;
    handleBuffDeathEffects(state, jesse, "jesse");

    applyStatBuffs(state);
    assert.equal(unit.statBuff, 1.3);
    assert.equal(unit.maxHp, Math.round(CARD_HP.knight * 1.3));
    assert.equal(unit.hp, Math.round(100 * 1.3), "the current HP keeps its ratio");
    assert.ok(unit.hp <= unit.maxHp);
  });

  it("buffMultiplierAt returns 1 outside every zone", () => {
    const { state, owner } = makeRoom();
    const jesse = makeUnit("warlord_jesse", 0, 0, 220);
    owner.units.set("jesse", jesse);
    updateBuffZones(state);

    assert.equal(buffMultiplierAt(state, 0, 0), 1.1);
    assert.equal(buffMultiplierAt(state, WARLORD_JESSE_BUFF_RADIUS, 0), 1.1, "the edge counts");
    assert.equal(buffMultiplierAt(state, WARLORD_JESSE_BUFF_RADIUS + 0.5, 0), 1);
  });
});
