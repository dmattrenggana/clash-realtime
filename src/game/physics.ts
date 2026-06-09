import { DeployedUnit, Player, Tower } from "../rooms/schema/BattleState.js";
import { getTowerCoords } from "./pathfinding.js";

/**
 * Calculates and applies push forces between overlapping units (separation forces) 
 * to prevent them from stacking perfectly on top of each other.
 * Ground and air units only push things on their same elevation (isUnitAir === other.isAir).
 */
export function applySeparationForces(
  unit: DeployedUnit,
  isUnitAir: boolean,
  allAliveTroops: { unit: DeployedUnit; isAir: boolean }[]
): void {
  let pushX = 0;
  let pushZ = 0;
  const pushRadius = 1.2; // The radius within which units push each other

  allAliveTroops.forEach((other) => {
    if (other.unit === unit) return; // Don't push yourself
    if (isUnitAir !== other.isAir) return; // Air and Ground ignore each other

    const dx = unit.x - other.unit.x;
    const dz = unit.z - other.unit.z;
    const distSq = dx * dx + dz * dz;

    if (distSq < pushRadius * pushRadius && distSq > 0.0001) {
      const dist = Math.sqrt(distSq);
      // Stronger push the closer they are
      const pushFactor = (pushRadius - dist) / dist; 
      pushX += dx * pushFactor;
      pushZ += dz * pushFactor;
    } else if (distSq <= 0.0001) {
      // Exactly on top of each other: give a random nudge
      pushX += (Math.random() - 0.5) * 0.1;
      pushZ += (Math.random() - 0.5) * 0.1;
    }
  });

  // Apply separation force (mutate in-place)
  // Weight the push so it doesn't completely override targeting, but smoothly separates
  unit.x += pushX * 0.3;
  unit.z += pushZ * 0.3;
}

/**
 * Prevents ground units from stepping into the river (Z in [-2.0, 2.0]),
 * unless they are on one of the two bridges (X at -6 or 6 with 1.5 width tolerance).
 * Flying units are entirely exempt and can hover over the river.
 */
export function applyRiverConstraint(unit: DeployedUnit, isAir: boolean): void {
  if (isAir) return; // Air units can fly anywhere!

  const riverMinZ = -2.0;
  const riverMaxZ = 2.0;
  const bridgeWidth = 1.5; // X-tolerance around bridge center
  const leftBridgeX = -6.0;
  const rightBridgeX = 6.0;

  // If unit is inside the river Z-bounds
  if (unit.z > riverMinZ && unit.z < riverMaxZ) {
    const onLeftBridge = Math.abs(unit.x - leftBridgeX) <= bridgeWidth;
    const onRightBridge = Math.abs(unit.x - rightBridgeX) <= bridgeWidth;

    if (!onLeftBridge && !onRightBridge) {
      // Not on any bridge! Push/clamp them out of the river to the nearest bank
      if (unit.z > 0) {
        unit.z = riverMaxZ; // Snap to player-side river bank
      } else {
        unit.z = riverMinZ; // Snap to enemy-side river bank
      }
    }
  }
}

/**
 * Treats active (alive) Towers as solid cylindrical physical boundaries.
 * If a ground unit penetrates a Tower's collision radius (King: 1.8, Princess: 1.4),
 * they are pushed outward elastically (sliding collision).
 */
export function applyTowerCollisions(
  unit: DeployedUnit,
  isAir: boolean,
  players: MapSchemaPlayerLike
): void {
  if (isAir) return; // Air units can fly over towers!

  const playerList = Array.from(players.values());

  playerList.forEach((player) => {
    player.towers.forEach((tower, idx) => {
      if (tower.hp <= 0) return; // Ruined towers are no longer solid obstacles!

      const { x: tx, z: tz } = getTowerCoords(tower, player.team, idx);
      const isKing = tower.type === "king";
      const radius = isKing ? 1.8 : 1.4; // Slightly reduced radius for smooth sliding collisions

      const dx = unit.x - tx;
      const dz = unit.z - tz;
      const dist = Math.sqrt(dx * dx + dz * dz);

      if (dist < radius && dist > 0.0001) {
        // Penetration detected! Push unit out to the tower's boundary
        const pushFactor = (radius - dist) / dist;
        unit.x += dx * pushFactor;
        unit.z += dz * pushFactor;
      }
    });
  });
}

interface MapSchemaPlayerLike {
  values(): IterableIterator<Player>;
}
