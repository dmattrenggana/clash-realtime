import { randomBytes } from "node:crypto";
import { DeployedUnit, Player, Projectile, Tower, SPELL_CARDS, FLYING_UNITS, CAN_ATTACK_AIR } from "../rooms/schema/BattleState.js";
import { CARD_ATTACK_SPEED, CARD_RANGE, CARD_PROJECTILE_SPEED, CARD_ATTACK_DAMAGE, CARD_ATTACK_SPLASH } from "../rooms/schema/BattleState.js";
import { getTowerCoords } from "./pathfinding.js";
import { scaleStatByLevel } from "../services/clashCards.js";

/**
 * Scan closest enemy targets and apply Melee damage or spawn Ranged projectiles.
 * Cooldown-validated based on ATTACK_SPEED of each card.
 */
export function applyUnitDamage(
  players: MapSchemaPlayerLike,
  elapsedSec: number,
  spawnProjectile: (pid: string, p: Projectile) => void,
  onDamageDealt: (attackerTeam: number, damage: number) => void
): void {
  const playerList = Array.from(players.values());
  playerList.forEach((attacker) => {
    const enemy = playerList.find((p) => p.team !== attacker.team);
    if (!enemy) return;

    attacker.units.forEach((unit) => {
      if (SPELL_CARDS.has(unit.cardId)) return;
      if (unit.cardId === "healer") return; // Healer AI behavior is handled in behaviors.ts

      if (unit.action !== "attack") return;

      // Check cooldown
      const attackSpeed = CARD_ATTACK_SPEED[unit.cardId] || 1.0;
      const now = elapsedSec;
      if (now - unit.lastAttackTime < attackSpeed) return;

      // Find current closest target
      let closestTarget: { hp: number; x: number; z: number; uid: string; team: number } | null = null;
      let minDist = Infinity;

      const targetsBuildingsOnly = unit.cardId === "giant";

      if (!targetsBuildingsOnly) {
        enemy.units.forEach((eUnit, uid) => {
          // Skip spell cards (invulnerable & untargetable)
          if (SPELL_CARDS.has(eUnit.cardId)) return;

          // Melee ground units cannot attack flying units
          if (FLYING_UNITS.has(eUnit.cardId) && !CAN_ATTACK_AIR.has(unit.cardId)) return;

          const d = Math.sqrt(Math.pow(eUnit.x - unit.x, 2) + Math.pow(eUnit.z - unit.z, 2));
          if (d < minDist) {
            minDist = d;
            closestTarget = { hp: eUnit.hp, x: eUnit.x, z: eUnit.z, uid, team: eUnit.team };
          }
        });
      }

      enemy.towers.forEach((t: Tower, idx: number) => {
        if (t.hp <= 0) return;
        const { x: tx, z: tz } = getTowerCoords(t, enemy.team, idx);
        const d = Math.sqrt(Math.pow(tx - unit.x, 2) + Math.pow(tz - unit.z, 2));
        if (d < minDist) {
          minDist = d;
          closestTarget = { hp: t.hp, x: tx, z: tz, uid: t.uid, team: t.team };
        }
      });

      let range = CARD_RANGE[unit.cardId] ?? 2.2;
      
      // Tower attack range adjustment for melee units (anti-get-stuck fix!)
      const isMelee = (CARD_PROJECTILE_SPEED[unit.cardId] || 0) === 0;
      const isTargetingTower = closestTarget && (Math.abs((closestTarget as any).z) === 10 || Math.abs((closestTarget as any).z) === 13);
      if (isMelee && isTargetingTower) {
        const isKing = Math.abs((closestTarget as any).z) === 13;
        const towerRadius = isKing ? 1.8 : 1.4;
        range = towerRadius + 0.3;
      }

      if (closestTarget && minDist <= range + 0.5) {
        unit.lastAttackTime = now;
        unit.targetId = (closestTarget as any).uid;

        const projSpeed = CARD_PROJECTILE_SPEED[unit.cardId] || 0;
        // 2026-06-24: NFT-level damage scaling. unit.cardLevel is set at deploy
        // time from player.deckLevels. L1 = 1.0x (base), L9 = 1.80x.
        // Imports scaleStatByLevel from the ClashCards service.
        const baseDamage = CARD_ATTACK_DAMAGE[unit.cardId] || 0;
        const damage = scaleStatByLevel(baseDamage, unit.cardLevel || 1);
        const splash = CARD_ATTACK_SPLASH[unit.cardId] || 0;

        if (projSpeed > 0) {
          // RANGED: Spawn a projectile
          const pid = randomBytes(8).toString("hex");
          const projectile = new Projectile();
          projectile.id = pid;
          projectile.sourceCardId = unit.cardId;
          projectile.team = unit.team;
          projectile.x = unit.x;
          projectile.z = unit.z;
          projectile.targetX = (closestTarget as any).x;
          projectile.targetZ = (closestTarget as any).z;
          projectile.targetId = (closestTarget as any).uid;
          projectile.speed = projSpeed;
          projectile.damage = damage;
          projectile.splashRadius = splash;

          spawnProjectile(pid, projectile);
        } else {
          // MELEE: Apply damage
          let dealt = 0;
          if (splash > 0) {
            // Melee AoE (Barbarian)
            enemy.units.forEach((eUnit) => {
              const d = Math.sqrt(Math.pow(eUnit.x - unit.x, 2) + Math.pow(eUnit.z - unit.z, 2));
              if (d <= splash) {
                const actualDmg = Math.min(eUnit.hp, damage);
                eUnit.hp = Math.max(0, eUnit.hp - damage);
                dealt += actualDmg;
              }
            });
            enemy.towers.forEach((t, idx) => {
              const { x: tx, z: tz } = getTowerCoords(t, enemy.team, idx);
              const d = Math.sqrt(Math.pow(tx - unit.x, 2) + Math.pow(tz - unit.z, 2));
              if (d <= splash) {
                const actualDmg = Math.min(t.hp, damage);
                t.hp = Math.max(0, t.hp - damage);
                dealt += actualDmg;
              }
            });
          } else {
            // Single target
            const actualTower = enemy.towers.find(t => t.uid === (closestTarget as any).uid);
            const actualUnit = enemy.units.get((closestTarget as any).uid);
            if (actualUnit) {
              dealt = Math.min(actualUnit.hp, damage);
              actualUnit.hp = Math.max(0, actualUnit.hp - damage);
            } else if (actualTower) {
              dealt = Math.min(actualTower.hp, damage);
              actualTower.hp = Math.max(0, actualTower.hp - damage);
            }
          }
          if (dealt > 0) {
            onDamageDealt(unit.team, dealt);
          }
        }
      }
    });
  });
}

/**
 * Move and update active flying projectiles towards their targets.
 * On impact, apply single-target or area-of-effect (splash) damage.
 */
export function updateProjectiles(
  players: MapSchemaPlayerLike,
  projectiles: MapSchemaProjectileLike,
  tickRateMs: number,
  onDamageDealt: (attackerTeam: number, damage: number) => void
): void {
  const dt = tickRateMs / 1000;
  const toRemove: string[] = [];

  projectiles.forEach((p, pid) => {
    let currentTargetX = p.targetX;
    let currentTargetZ = p.targetZ;

    const playerList = Array.from(players.values());
    const targetUnit = playerList.flatMap(pl => Array.from(pl.units.entries())).find(([uid]) => uid === p.targetId)?.[1];
    
    if (targetUnit) {
      currentTargetX = targetUnit.x;
      currentTargetZ = targetUnit.z;
      p.targetX = currentTargetX;
      p.targetZ = currentTargetZ;
    }

    const dx = currentTargetX - p.x;
    const dz = currentTargetZ - p.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    const moveStep = p.speed * dt;

    if (dist <= moveStep) {
      // IMPACT
      const enemy = playerList.find(pl => pl.team !== p.team);
      if (enemy) {
        let dealt = 0;
        if (p.splashRadius > 0) {
          // AoE Splash
          enemy.units.forEach((eUnit) => {
            const d = Math.sqrt(Math.pow(eUnit.x - p.targetX, 2) + Math.pow(eUnit.z - p.targetZ, 2));
            if (d <= p.splashRadius) {
              const actualDmg = Math.min(eUnit.hp, p.damage);
              eUnit.hp = Math.max(0, eUnit.hp - p.damage);
              dealt += actualDmg;
            }
          });
          enemy.towers.forEach((t, idx) => {
            const { x: tx, z: tz } = getTowerCoords(t, enemy.team, idx);
            const d = Math.sqrt(Math.pow(tx - p.targetX, 2) + Math.pow(tz - p.targetZ, 2));
            if (d <= p.splashRadius) {
              const actualDmg = Math.min(t.hp, p.damage);
              t.hp = Math.max(0, t.hp - p.damage);
              dealt += actualDmg;
            }
          });
        } else {
          // Single target
          const actualUnit = enemy.units.get(p.targetId);
          const actualTower = enemy.towers.find(t => t.uid === p.targetId);
          if (actualUnit) {
            dealt = Math.min(actualUnit.hp, p.damage);
            actualUnit.hp = Math.max(0, actualUnit.hp - p.damage);
          } else if (actualTower) {
            dealt = Math.min(actualTower.hp, p.damage);
            actualTower.hp = Math.max(0, actualTower.hp - p.damage);
          }
        }
        if (dealt > 0) {
          onDamageDealt(p.team, dealt);
        }
      }
      toRemove.push(pid);
    } else {
      p.x += (dx / dist) * moveStep;
      p.z += (dz / dist) * moveStep;
    }
  });

  toRemove.forEach(pid => projectiles.delete(pid));
}

/**
 * Handle automated defenses of Princess and King towers.
 * Shoots "cannonballs" (projectiles) at the nearest unit in range.
 */
export function processTowerAttacks(
  players: MapSchemaPlayerLike,
  elapsedSec: number,
  spawnProjectile: (pid: string, p: Projectile) => void
): void {
  const playerList = Array.from(players.values());
  const now = elapsedSec;

  playerList.forEach((attacker) => {
    const enemy = playerList.find((p) => p.team !== attacker.team);
    if (!enemy) return;

    attacker.towers.forEach((tower, idx) => {
      if (tower.hp <= 0) return;

      // Stats based on Tower Type
      const isKing = tower.type === "king";
      const range = isKing ? 7.0 : 7.5;
      const damage = isKing ? 20 : 15;
      const cooldown = isKing ? 1.2 : 1.0;

      // Check Cooldown
      if (now - tower.lastAttackTime < cooldown) return;

      // Map index in towers array directly to absolute coordinates
      // Index 0: Left Princess Tower (X=-6), Index 1: King Tower (X=0), Index 2: Right Princess Tower (X=6)
      const tx = idx === 1 ? 0 : (idx === 0 ? -6 : 6);
      const tz = attacker.team === 0 ? (isKing ? 13 : 10) : (isKing ? -13 : -10);

      // Find closest enemy unit within range
      let closestUnit: DeployedUnit | null = null;
      let closestUnitUID = "";
      let minDist = Infinity;

      enemy.units.forEach((eUnit, uid) => {
        if (eUnit.hp <= 0) return;
        // Skip spell cards (invulnerable & untargetable)
        if (SPELL_CARDS.has(eUnit.cardId)) return;

        const d = Math.sqrt(Math.pow(eUnit.x - tx, 2) + Math.pow(eUnit.z - tz, 2));
        if (d < minDist && d <= range) {
          minDist = d;
          closestUnit = eUnit;
          closestUnitUID = uid;
        }
      });

      if (closestUnit) {
        // Trigger Attack
        tower.lastAttackTime = now;
        tower.targetId = closestUnitUID;

        // Spawn Cannonball Projectile
        const pid = randomBytes(8).toString("hex");
        const projectile = new Projectile();
        projectile.id = pid;
        projectile.sourceCardId = "cannonball"; // Renders as cannonball 3D mesh
        projectile.team = attacker.team;
        projectile.x = tx;
        projectile.z = tz;
        projectile.targetX = closestUnit.x;
        projectile.targetZ = closestUnit.z;
        projectile.targetId = closestUnitUID;
        projectile.speed = 7.0; // Steady projectile speed
        projectile.damage = damage;
        projectile.splashRadius = 0; // Towers do single-target damage

        spawnProjectile(pid, projectile);
      } else {
        tower.targetId = "";
      }
    });
  });
}

interface MapSchemaPlayerLike {
  values(): IterableIterator<Player>;
}

interface MapSchemaProjectileLike {
  forEach(callback: (p: Projectile, pid: string) => void): void;
  delete(pid: string): void;
}
