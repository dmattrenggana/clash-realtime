/**
 * deathrattle.ts — the Clanker's death effect.
 *
 * 2026-11-09. When a Clanker drops to 0 HP it discharges an electric blast
 * and leaves behind two mini Clankers:
 *
 *   - electric blast: radius 2.5, deals HALF of the dying unit's attack
 *     damage to every ENEMY unit in range (not to towers and not to
 *     allies — the blast clears a path for the minions, it does not punish
 *     the owner or chip the enemy tower).
 *   - two mini Clankers: 61.25% of the visual size (35% x 1.75), a quarter
 *     of the parent's HP (200) and an attack of 10. Each mini repeats the
 *     loop: when it dies it deals an electric blast of HALF OF ITS OWN
 *     attack (so 5 damage) and does NOT spawn further minions.
 *
 * A mini Clanker is a transient combat unit, not an NFT card type. It is
 * identified by the `variant` field on DeployedUnit and is deliberately kept
 * out of CARD_TYPE_IDS, the deck tables and every NFT lookup.
 */

import {
  CLANKER_BLAST_DAMAGE_DIVISOR,
  CLANKER_BLAST_RADIUS,
  CLANKER_VARIANT_MINI,
  MINI_CLANKER_COUNT,
  baseAttackDamage,
  baseUnitHp,
  isMiniClanker,
  BattleState,
  DeployedUnit,
  Player,
} from "../rooms/schema/BattleState.js";
import { scaleStatByLevel } from "../services/clashCards.js";

/** Horizontal offset between the two mini Clankers, so they do not stack. */
const MINI_SPAWN_SPACING = 1.2;

/**
 * Run the death effects for a unit that just dropped to 0 HP.
 *
 * Called once per death: the caller only invokes it while `deathTriggered`
 * is false, and the handler sets the flag itself.
 *
 * @param state       the battle state (for elapsedSec / elapsedMs / players)
 * @param player      the owner of the dying unit
 * @param unit        the dying unit
 * @param unitUid     the uid of the dying unit (used to build unique mini ids)
 * @param onDamageDealt optional callback so the blast counts towards the
 *                       match damage total, exactly like a normal attack
 */
export function handleDeathEffects(
  state: BattleState,
  player: Player,
  unit: DeployedUnit,
  unitUid: string,
  onDamageDealt?: (attackerTeam: number, damage: number) => void
): void {
  if (unit.deathTriggered) return;
  unit.deathTriggered = true;

  // Only the Clanker family has a deathrattle.
  if (unit.cardId !== "clanker") return;

  const isMini = isMiniClanker(unit);

  // ── Electric blast ────────────────────────────────────────────────────────
  // Half of the dying unit's OWN attack damage: 13 for a full Clanker
  // (25 / 2) and 5 for a mini Clanker (10 / 2).
  const attack = scaleStatByLevel(
    baseAttackDamage(unit.cardId, unit.variant),
    unit.cardLevel || 1
  );
  const blastDamage = Math.max(
    1,
    Math.round(attack / CLANKER_BLAST_DAMAGE_DIVISOR)
  );

  let dealt = 0;
  const enemy = Array.from(state.players.values()).find(
    (p) => p.team !== player.team
  );
  if (enemy) {
    enemy.units.forEach((eUnit) => {
      if (eUnit.hp <= 0) return;
      const dx = eUnit.x - unit.x;
      const dz = eUnit.z - unit.z;
      if (Math.sqrt(dx * dx + dz * dz) > CLANKER_BLAST_RADIUS) return;
      const actual = Math.min(eUnit.hp, blastDamage);
      eUnit.hp = Math.max(0, eUnit.hp - blastDamage);
      dealt += actual;
    });
  }
  if (dealt > 0 && onDamageDealt) onDamageDealt(unit.team, dealt);

  // ── Mini Clankers ────────────────────────────────────────────────────────
  // Only a full Clanker splits. A mini Clanker just blows up.
  if (isMini) return;

  const miniHp = baseUnitHp("clanker", CLANKER_VARIANT_MINI);
  for (let i = 0; i < MINI_CLANKER_COUNT; i++) {
    const mini = new DeployedUnit();
    mini.cardId = "clanker";
    mini.variant = CLANKER_VARIANT_MINI;
    mini.team = player.team;
    // The mini is a combat echo of the card, not an NFT: it keeps the L1
    // base values so the NFT-level multiplier is not applied twice.
    mini.cardLevel = 1;
    mini.hp = miniHp;
    mini.maxHp = miniHp;

    const offset = (i - (MINI_CLANKER_COUNT - 1) / 2) * MINI_SPAWN_SPACING;
    mini.x = unit.x + offset;
    mini.z = unit.z;
    mini.spawnTime = state.elapsedSec;

    // The dead unit's uid makes this id unique even when two Clankers die
    // on the same tick.
    const miniUid = `mini-${unitUid}-${i}`;
    player.units.set(miniUid, mini);
  }
}
