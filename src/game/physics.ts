import { DeployedUnit } from "../rooms/schema/BattleState.js";

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
