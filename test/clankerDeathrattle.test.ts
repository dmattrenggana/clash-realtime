import assert from "node:assert/strict";
import { BattleRoom } from "../src/rooms/BattleRoom.js";
import {
  Player,
  DeployedUnit,
  CARD_HP,
  CARD_ATTACK_DAMAGE,
  CARD_ATTACK_SPEED,
  CARD_ATTACK_SPLASH,
  CARD_MOVE_SPEED,
} from "../src/rooms/schema/BattleState.js";

/**
 * Clanker deathrattle (2026-11-09).
 *
 * When a Clanker dies it must:
 *   1. discharge an electric blast — radius 2.5, half of its own attack
 *      damage, hitting ENEMY units in range;
 *   2. leave behind two mini Clankers — 35% visual size, a quarter of the
 *      parent's base HP and damage;
 *   3. and a mini Clanker repeats the blast (half of ITS OWN attack) but does
 *      NOT spawn further minions.
 *
 * The tests drive the REAL production classes — a local reimplementation of
 * the death handling would keep passing with the feature removed.
 */

/** Builds a two-player battle state with one unit each side. */
function makeRoom() {
  const room = new BattleRoom();
  (room as any).onCreate({ seed: "test-seed" });
  const state = (room as any).state;
  // tickGame() bails out unless the match is running.
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
  return u;
}

describe("clanker deathrattle", () => {
  it("a dying clanker blasts nearby enemies and leaves two mini clankers", () => {
    const { room, state, owner, enemy } = makeRoom();

    const clanker = makeUnit("clanker", 0, 0, 0);
    owner.units.set("clanker-1", clanker);

    // An enemy troop inside the 2.5 blast radius, and one well outside it.
    const inRange = makeUnit("knight", 2, 0, 150);
    const outOfRange = makeUnit("knight", 9, 9, 150);
    enemy.units.set("in", inRange);
    enemy.units.set("out", outOfRange);

    // Drive one real simulation tick.
    (room as any).tick();

    // The Clanker's attack is 25 (the Giant's), so the blast deals half: 13.
    assert.equal(inRange.hp, 150 - 13, "an enemy inside 2.5 must take half the clanker's attack");
    assert.equal(outOfRange.hp, 150, "an enemy outside the blast radius must be untouched");

    // Two mini Clankers, a quarter of the base HP (800 / 4 = 200).
    const minis = Array.from(owner.units.values()).filter((u) => u.variant === "mini");
    assert.equal(minis.length, 2, "a dying clanker must leave exactly two mini clankers");
    for (const mini of minis) {
      assert.equal(mini.cardId, "clanker");
      // maxHp is the stat; hp may already have dropped because the tick also
      // ran combat and the enemy knight next door hit the fresh mini.
      assert.equal(mini.maxHp, 200, "a mini clanker has a quarter of the clanker's base HP");
      assert.ok(mini.hp <= mini.maxHp, "a mini clanker never heals above its max HP");
      assert.equal(mini.cardLevel, 1, "a mini clanker keeps L1 values so the level multiplier is not applied twice");
      assert.equal(mini.team, 0, "the minis belong to the clanker's owner");
    }

    (room as any).onDispose();
  });

  it("the blast never fires twice for the same death", () => {
    const { room, state, owner, enemy } = makeRoom();

    const clanker = makeUnit("clanker", 0, 0, 0);
    owner.units.set("clanker-1", clanker);
    const victim = makeUnit("knight", 1, 0, 150);
    enemy.units.set("victim", victim);

    (room as any).tick();
    const hpAfterFirst = victim.hp;
    const minisAfterFirst = owner.units.size;

    // Several more ticks: the dead unit lingers for a second so the client
    // can play the death animation. The effect must not repeat.
    for (let i = 0; i < 5; i++) (room as any).tick();

    assert.equal(victim.hp, hpAfterFirst, "the blast must not re-trigger on later ticks");
    assert.equal(owner.units.size, minisAfterFirst, "no extra mini clankers may appear");

    (room as any).onDispose();
  });

  it("a mini clanker blows up for half of its own attack and spawns nothing", () => {
    const { room, state, owner, enemy } = makeRoom();

    const mini = makeUnit("clanker", 0, 0, 0);
    mini.variant = "mini";
    owner.units.set("mini-1", mini);

    const victim = makeUnit("knight", 1, 0, 150);
    enemy.units.set("victim", victim);

    (room as any).tick();

    // The mini deals 10 damage, so its blast is 5.
    assert.equal(victim.hp, 150 - 5, "a mini clanker blasts for half of its own (10) attack");

    const minis = Array.from(owner.units.values()).filter((u) => u.variant === "mini");
    assert.equal(minis.length, 1, "a mini clanker must not spawn further mini clankers");

    (room as any).onDispose();
  });

  it("the blast does not hurt the owner's own units", () => {
    const { room, state, owner } = makeRoom();

    const clanker = makeUnit("clanker", 0, 0, 0);
    owner.units.set("clanker-1", clanker);
    const ally = makeUnit("knight", 1, 0, 150);
    owner.units.set("ally", ally);

    (room as any).tick();

    assert.equal(ally.hp, 150, "the electric blast must not damage the owner's own units");

    (room as any).onDispose();
  });

  it("the clanker keeps the giant's attack profile", () => {
    assert.equal(CARD_HP.clanker, CARD_HP.giant * 2, "the clanker has twice the giant's HP");
    assert.equal(CARD_ATTACK_DAMAGE.clanker, CARD_ATTACK_DAMAGE.giant, "same attack damage as the giant");
    assert.equal(CARD_ATTACK_SPEED.clanker, CARD_ATTACK_SPEED.giant, "same attack speed as the giant");
    assert.equal(CARD_ATTACK_SPLASH.clanker, CARD_ATTACK_SPLASH.giant, "same splash as the giant");
    assert.equal(CARD_MOVE_SPEED.clanker, 1.25, "the clanker walks at 1.25, slower than the giant's 1.5");
    assert.equal(CARD_MOVE_SPEED.warlord_jesse, CARD_MOVE_SPEED.knight, "warlord jesse walks at the knight's speed");
  });
});
