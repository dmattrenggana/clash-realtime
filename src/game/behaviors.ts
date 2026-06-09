import { DeployedUnit, Player, SPELL_CARDS, SPELL_TRIGGER, SPELL_DETONATE_AFTER_MS, SPELL_TRIGGER_RADIUS, SPELL_SPLASH_RADIUS, SPELL_DAMAGE } from "../rooms/schema/BattleState.js";
import { CARD_RANGE, CARD_ATTACK_SPEED, CARD_ATTACK_DAMAGE, CARD_ATTACK_SPLASH } from "../rooms/schema/BattleState.js";
import { getTowerCoords } from "./pathfinding.js";

/**
 * Custom AI Behavior for the Healer troop.
 * Healers seek friendly troops (allies) with the lowest HP ratio,
 * approach them, and cast a continuous golden AoE heal at their target's feet.
 */
export function processHealerAI(
  unit: DeployedUnit,
  unitUid: string,
  attacker: Player,
  elapsedSec: number
): boolean {
  if (unit.cardId !== "healer") return false;

  // Healers look for allies with lowest HP%
  let healTarget: DeployedUnit | null = null;
  let healTargetUID = "";
  let minHpRatio = 1.1;

  attacker.units.forEach((ally, uid) => {
    if (ally.hp <= 0 || ally.hp >= ally.maxHp) return;
    if (SPELL_CARDS.has(ally.cardId)) return;
    const ratio = ally.hp / ally.maxHp;
    if (ratio < minHpRatio) {
      minHpRatio = ratio;
      healTarget = ally;
      healTargetUID = uid;
    }
  });

  if (healTarget) {
    const d = Math.sqrt(Math.pow((healTarget as DeployedUnit).x - unit.x, 2) + Math.pow((healTarget as DeployedUnit).z - unit.z, 2));
    const range = CARD_RANGE[unit.cardId] ?? 3.5;
    if (d <= range) {
      unit.action = "attack";
      unit.targetId = healTargetUID; // Track the ally's UID so client draws beam
      
      const now = elapsedSec;
      const attackSpeed = CARD_ATTACK_SPEED[unit.cardId] || 1.0;
      if (now - unit.lastAttackTime >= attackSpeed) {
        unit.lastAttackTime = now;
        const healAmount = CARD_ATTACK_DAMAGE[unit.cardId] || 20;
        const splash = CARD_ATTACK_SPLASH[unit.cardId] || 1.8;
        
        // AoE Heal around target
        attacker.units.forEach((ally) => {
          const dist = Math.sqrt(Math.pow(ally.x - healTarget!.x, 2) + Math.pow(ally.z - healTarget!.z, 2));
          if (dist <= splash) {
            ally.hp = Math.min(ally.maxHp, ally.hp + healAmount);
          }
        });
      }
      return true; // Behavior handled
    }
  }

  return false; // Did not handle or target not found/out of range
}

/**
 * Handle spell detonation logic (Timer-based Meteor or Proximity-based Barrel Bomb).
 * Spells never move, never auto-target, and never auto-attack.
 */
export function processSpells(
  players: MapSchemaPlayerLike,
  elapsedSec: number
): void {
  const playerList = Array.from(players.values());
  if (playerList.length === 0) return;

  playerList.forEach((player) => {
    const enemy = playerList.find((p) => p.team !== player.team);
    const toDetonate: string[] = [];

    player.units.forEach((unit, id) => {
      if (!SPELL_CARDS.has(unit.cardId)) return;
      if (unit.hp <= 0) return; // already detonated

      const trigger = SPELL_TRIGGER[unit.cardId];
      if (trigger === "timer") {
        const ageSec = elapsedSec - unit.spawnTime;
        const ageMs = ageSec * 1000;
        if (ageMs >= (SPELL_DETONATE_AFTER_MS[unit.cardId] ?? 800)) {
          toDetonate.push(id);
        }
      } else if (trigger === "proximity") {
        if (!enemy) return;
        const triggerR = SPELL_TRIGGER_RADIUS[unit.cardId] ?? 2.0;
        let close = false;
        enemy.units.forEach((eUnit) => {
          if (close) return;
          const d = Math.sqrt(
            Math.pow(eUnit.x - unit.x, 2) + Math.pow(eUnit.z - unit.z, 2)
          );
          if (d <= triggerR) close = true;
        });
        if (close) toDetonate.push(id);
      }
    });

    // Detonate and mark spell units for deletion in the next tick
    toDetonate.forEach((id) => {
      const unit = player.units.get(id);
      if (!unit) return;
      detonateSpell(player, enemy, unit);
      unit.hp = 0; // Marks HP=0 to trigger client death/explosion animation
    });
  });
}

/**
 * Internal helper to apply AoE spell damage on detonation.
 */
export function detonateSpell(
  _owner: Player,
  enemy: Player | undefined,
  spell: DeployedUnit
): void {
  if (!enemy) return;
  const radius = SPELL_SPLASH_RADIUS[spell.cardId] ?? 3.0;
  const damage = SPELL_DAMAGE[spell.cardId] ?? 0;
  if (damage <= 0) return;

  // Damage enemy units in radius
  const toKillUnits: string[] = [];
  enemy.units.forEach((eUnit, id) => {
    const d = Math.sqrt(
      Math.pow(eUnit.x - spell.x, 2) + Math.pow(eUnit.z - spell.z, 2)
    );
    if (d <= radius) {
      eUnit.hp = Math.max(0, eUnit.hp - damage);
      if (eUnit.hp <= 0) toKillUnits.push(id);
    }
  });
  toKillUnits.forEach((id) => enemy.units.delete(id));

  // Damage enemy towers in radius
  enemy.towers.forEach((t) => {
    if (t.hp <= 0) return;
    const { x: tx, z: tz } = getTowerCoords(t, enemy.team, spell.x);
    const d = Math.sqrt(
      Math.pow(tx - spell.x, 2) + Math.pow(tz - spell.z, 2)
    );
    if (d <= radius) {
      t.hp = Math.max(0, t.hp - damage);
    }
  });
}

interface MapSchemaPlayerLike {
  values(): IterableIterator<Player>;
}
