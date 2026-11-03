import assert from "node:assert/strict";
import { BattleRoom } from "../src/rooms/BattleRoom.js";
import { Player } from "../src/rooms/schema/BattleState.js";

/**
 * Single-tick-loop regression.
 *
 * Symptom (reported 2026-11-04): in a real player-vs-player match the
 * troops moved noticeably FASTER than in an AI-bot match.
 *
 * Root cause: onJoin() is async. The player is inserted into
 * state.players synchronously, but the on-chain deck validation is awaited.
 * When two players join the same room, BOTH onJoin() calls resume after
 * their await and both observe state.players.size === 2, so both fell
 * through to the "start the match" branch. Each started its own
 * clock.setInterval(() => this.tick(), 50ms) and the second assignment to
 * this.tickInterval overwrote the first handle — leaving TWO tick loops
 * running. The simulation therefore advanced twice per real 50ms while
 * state.elapsedMs (a wall-clock timestamp) advanced once: units moved at
 * double speed, elixir regenerated double, projectiles flew double.
 *
 * The bot path was unaffected because activateBotFallback() already guarded
 * its interval with `if (this.tickInterval === null)`; the PvP branch had no
 * such guard. Production log evidence: every PvP match logged "Game started!"
 * twice, every bot match logged it once.
 *
 * These tests drive the REAL BattleRoom class — a local reimplementation of
 * the start logic would keep passing with the guard removed, which is
 * exactly how the first version of the air-guard test proved nothing.
 */

/** Counts how many tick loops the room currently has scheduled. */
function countTickLoops(room: BattleRoom): number {
  // this.clock is the Colyseus ClockTimer; `delayed` holds every scheduled
  // timeout/interval. Delayed.type is the numeric enum from
  // @colyseus/timer: Interval = 0, Timeout = 1, Async = 2. The empty-room
  // watchdog is a Timeout, so only Interval entries are tick loops.
  const delayed = (room as any).clock?.delayed as Array<any> | undefined;
  if (!delayed) return 0;
  return delayed.filter((d) => d && d.type === 0).length;
}

/** Drives the room's start-clock path the way onJoin() does. */
function startMatch(room: BattleRoom): void {
  (room as any).startMatchClock();
}

describe("match clock starts exactly once", () => {
  it("a second start attempt does not create a second tick loop", () => {
    const room = new BattleRoom();
    // onCreate() wires this.state and arms the empty-room watchdog. The
    // production server calls it with { seed }; the seed is irrelevant here.
    (room as any).onCreate({ seed: "test-seed" });

    startMatch(room);
    assert.equal(countTickLoops(room), 1, "the first start must schedule exactly one tick loop");

    // This is the exact sequence the real bug produced: the second onJoin()
    // resumed after its await and started the match a second time.
    startMatch(room);
    assert.equal(
      countTickLoops(room),
      1,
      "a duplicate start must NOT schedule a second tick loop (this is the double-speed bug)",
    );

    startMatch(room);
    assert.equal(countTickLoops(room), 1, "a third start must still leave exactly one tick loop");

    // The match must not be restarted from scratch either — the clock and
    // the game start time stay at the first start.
    assert.equal((room as any).state.status, "playing");
    assert.ok((room as any).gameStartTime > 0, "gameStartTime must be set by the first start");

    (room as any).onDispose();
  });

  it("the tick loop advances the simulation at exactly one step per interval", () => {
    const room = new BattleRoom();
    (room as any).onCreate({ seed: "test-seed" });

    let tickCalls = 0;
    // Replace the room's tick with a counter so we can measure how many
    // times the simulation actually runs.
    (room as any).tick = () => {
      tickCalls++;
    };

    startMatch(room);
    startMatch(room); // the duplicate that used to double the speed

    // Drive the clock by hand: @colyseus/timer's ClockTimer.tick() advances
    // every scheduled delayed. We fake the passage of time by ticking the
    // clock's underlying time source.
    const clock = (room as any).clock;
    const fakeNow = { value: Date.now() };
    clock.now = () => fakeNow.value;

    // 1 second of wall time in 50ms steps = 20 ticks for ONE loop.
    for (let i = 0; i < 20; i++) {
      fakeNow.value += 50;
      clock.tick();
    }

    assert.equal(
      tickCalls,
      20,
      `one second must produce exactly 20 ticks (got ${tickCalls}) — a duplicate tick loop would produce 40`,
    );

    (room as any).onDispose();
  });

  it("the bot fallback path also leaves exactly one tick loop", () => {
    const room = new BattleRoom();
    (room as any).onCreate({ seed: "test-seed" });

    // The bot fallback expects one real player plus the synthetic bot.
    const player = new Player();
    player.walletAddress = "0xtest";
    player.nickname = "Tester";
    player.team = 0;
    player.connected = true;
    (room as any).state.players.set("test-session", player);

    // activateBotFallback() adds a synthetic bot player and starts the match.
    // Calling it twice mirrors the same double-invocation hazard.
    (room as any).activateBotFallback();
    (room as any).activateBotFallback();

    assert.equal(
      countTickLoops(room),
      1,
      "the bot fallback must schedule exactly one tick loop, even when activated twice",
    );

    (room as any).onDispose();
  });
});
