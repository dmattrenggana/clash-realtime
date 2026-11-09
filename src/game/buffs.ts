/**
 * buffs.ts — the Warlord Jesse's stat-buff aura.
 *
 * 2026-11-09.
 *
 *   - While the Warlord Jesse lives he projects an aura: a 5-unit radius
 *     area that gives every unit inside it +10% to all of its stats.
 *   - When he dies the aura bursts: the same 5-unit radius, but +30% for
 *     4 seconds, centred on the spot where he fell.
 *
 * The buff applies to EVERY unit in the area (both teams) — that is the
 * literal reading of the request.
 *
 * How the buff is applied:
 *   - `statBuff` on DeployedUnit holds the multiplier that is currently
 *     active for that unit. It is recomputed every tick from the zones that
 *     cover the unit.
 *   - When the multiplier changes, the unit's max HP and current HP are
 *     scaled by the same ratio, so a unit keeps its HP percentage (a unit at
 *     50% HP stays at 50% HP) and the HP bar stays consistent.
 *   - The damage, the attack rate, the move speed and the heal rate all
 *     read `statBuff` at the moment they are used.
 */

import {
  BattleState,
  BuffZone,
  DeployedUnit,
  SPELL_CARDS,
} from "../rooms/schema/BattleState.js";

/** Radius of the Warlord Jesse's aura, in arena units. */
export const WARLORD_JESSE_BUFF_RADIUS = 5;

/** The aura while the Warlord Jesse lives: +10%. */
export const WARLORD_JESSE_AURA_MULTIPLIER = 1.1;

/** The death burst: +30%. */
export const WARLORD_JESSE_DEATH_MULTIPLIER = 1.3;

/** How long the death burst lasts, in seconds. */
export const WARLORD_JESSE_DEATH_DURATION_SEC = 4;

/**
 * How long the Warlord Jesse holds still on deploy so the sword-shout
 * reads as "activating the buff". In milliseconds.
 */
export const WARLORD_JESSE_DEPLOY_ANIM_MS = 2200;

export function isWarlordJesse(unit: { cardId: string }): boolean {
  return unit.cardId === "warlord_jesse";
}

/**
 * The strongest buff multiplier that covers a position.
 * Returns 1 when no zone covers it.
 */
export function buffMultiplierAt(state: BattleState, x: number, z: number): number {
  let best = 1;
  state.buffZones.forEach((zone) => {
    if (zone.multiplier <= best) return;
    const dx = zone.x - x;
    const dz = zone.z - z;
    if (dx * dx + dz * dz <= zone.radius * zone.radius) best = zone.multiplier;
  });
  return best;
}

/**
 * Called when a unit dies. A dying Warlord Jesse turns his aura into the
 * 4-second death burst at the position where he fell.
 *
 * The handler is idempotent: the caller only invokes it while
 * `deathTriggered` is false, and the flag is set by the generic death
 * handler before this runs.
 */
export function handleBuffDeathEffects(
  state: BattleState,
  unit: DeployedUnit,
  unitUid: string
): void {
  if (!isWarlordJesse(unit)) return;

  // Remove the aura that followed him while he was alive.
  state.buffZones.delete(`wj-aura-${unitUid}`);

  // Spawn the death burst at the spot where he fell.
  const zone = new BuffZone();
  zone.uid = `wj-death-${unitUid}`;
  zone.team = unit.team;
  zone.x = unit.x;
  zone.z = unit.z;
  zone.radius = WARLORD_JESSE_BUFF_RADIUS;
  zone.multiplier = WARLORD_JESSE_DEATH_MULTIPLIER;
  zone.phase = "death";
  zone.expiresAt = state.elapsedMs + WARLORD_JESSE_DEATH_DURATION_SEC * 1000;
  state.buffZones.set(zone.uid, zone);
}

/**
 * Refresh the buff zones and apply the resulting multipliers to the units.
 *
 * - the death bursts expire on their own;
 * - every living Warlord Jesse keeps one aura that follows him;
 * - auras whose owner is gone are removed.
 */
export function updateBuffZones(state: BattleState): void {
  const nowMs = state.elapsedMs;

  // 1. expire the finished death bursts.
  const expired: string[] = [];
  state.buffZones.forEach((zone, uid) => {
    if (zone.phase === "death" && zone.expiresAt >= 0 && nowMs >= zone.expiresAt) {
      expired.push(uid);
    }
  });
  expired.forEach((uid) => state.buffZones.delete(uid));

  // 2. find the living Warlord Jesses.
  const living = new Map<string, DeployedUnit>();
  state.players.forEach((player) => {
    player.units.forEach((unit, uid) => {
      if (unit.hp > 0 && isWarlordJesse(unit)) living.set(uid, unit);
    });
  });

  // 3. drop the auras whose owner is no longer alive.
  const stale: string[] = [];
  state.buffZones.forEach((zone, uid) => {
    if (zone.phase !== "active") return;
    if (!living.has(uid.replace(/^wj-aura-/, ""))) stale.push(uid);
  });
  stale.forEach((uid) => state.buffZones.delete(uid));

  // 4. create or move the aura of every living Warlord Jesse.
  living.forEach((unit, uid) => {
    const zoneUid = `wj-aura-${uid}`;
    let zone = state.buffZones.get(zoneUid);
    if (!zone) {
      zone = new BuffZone();
      zone.uid = zoneUid;
      zone.phase = "active";
      zone.expiresAt = -1;
      state.buffZones.set(zoneUid, zone);
    }
    zone.team = unit.team;
    zone.x = unit.x;
    zone.z = unit.z;
    zone.radius = WARLORD_JESSE_BUFF_RADIUS;
    zone.multiplier = WARLORD_JESSE_AURA_MULTIPLIER;
  });
}

/**
 * Apply the current buff multiplier to every unit.
 *
 * When a unit's multiplier changes its max HP and its current HP are scaled
 * by the same ratio, so the unit keeps its HP percentage and never ends up
 * with more HP than its (new) maximum.
 */
export function applyStatBuffs(state: BattleState): void {
  state.players.forEach((player) => {
    player.units.forEach((unit) => {
      if (SPELL_CARDS.has(unit.cardId)) return;
      const multiplier = buffMultiplierAt(state, unit.x, unit.z);
      const current = unit.statBuff || 1;
      if (Math.abs(multiplier - current) < 0.001) return;

      const ratio = multiplier / current;
      unit.maxHp = Math.max(1, Math.round(unit.maxHp * ratio));
      unit.hp = Math.min(unit.maxHp, Math.max(0, Math.round(unit.hp * ratio)));
      unit.statBuff = multiplier;
    });
  });
}
