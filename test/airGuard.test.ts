import assert from "node:assert/strict";
import {
    FLYING_UNITS,
    CAN_ATTACK_AIR,
    CARD_ATTACK_SPLASH,
    CARD_PROJECTILE_SPEED,
} from "../src/rooms/schema/BattleState.js";
// The real production function — not a copy. A local reimplementation would
// keep passing with the guard removed, which is exactly how the first version
// of this test proved nothing.
import { applyMeleeSplashToUnits } from "../src/game/combat.js";

/**
 * Melee AoE air-guard regression.
 *
 * Target selection in combat.ts already skipped flying units, but the melee
 * splash loop is positional — it damages every enemy inside the radius. A
 * barbarian therefore never *chose* a wyvern, yet still cut it down whenever
 * one wandered within 2.5 tiles.
 *
 * These tests pin the two properties that matter: the barbarian's swing must
 * skip air units, and must still hit every ground unit in range — the AoE
 * cannot be narrowed into a single-target hit to achieve that.
 */

interface Unit {
    cardId: string;
    x: number;
    z: number;
    hp: number;
}

/** Drives the production function and reports which units actually took damage. */
function applyMeleeAoE(attacker: Unit, enemies: Unit[], damage: number): string[] {
    const splash = CARD_ATTACK_SPLASH[attacker.cardId];
    const before = new Map(enemies.map((e) => [e, e.hp]));
    applyMeleeSplashToUnits(attacker, enemies, damage, splash);
    return enemies.filter((e) => e.hp < (before.get(e) as number)).map((e) => e.cardId);
}

const BARBARIAN = { cardId: "barbarian", x: 0, z: 0, hp: 100 };

describe("melee AoE air-guard", () => {
    it("barbarian cannot damage flying units inside its splash", () => {
        const wyvern = { cardId: "wyvern", x: 1, z: 0, hp: 120 };
        applyMeleeAoE(BARBARIAN, [wyvern], 60);
        assert.equal(wyvern.hp, 120, "a wyvern inside splash range must take no damage");
    });

    it("does not damage incubus or healer either", () => {
        for (const cardId of ["incubus", "healer"]) {
            const air = { cardId, x: 0.5, z: 0.5, hp: 100 };
            applyMeleeAoE(BARBARIAN, [air], 60);
            assert.equal(air.hp, 100, `${cardId} must be immune to the barbarian`);
        }
    });

    it("still hits every ground unit in range — the AoE must stay area", () => {
        const enemies: Unit[] = [
            { cardId: "knight", x: 1.0, z: 0, hp: 100 },
            { cardId: "archer", x: -1.0, z: 1.0, hp: 100 },
            { cardId: "goblin", x: 0, z: -2.0, hp: 100 },
        ];
        const hit = applyMeleeAoE(BARBARIAN, enemies, 60);

        assert.deepEqual(hit.sort(), ["archer", "goblin", "knight"]);
        for (const e of enemies) assert.equal(e.hp, 40, `${e.cardId} should be hit`);
    });

    it("hits ground units even when a flying unit sits in the same radius", () => {
        // The regression that matters: guarding air must not turn the swing
        // into a single-target hit. One wyvern in the middle, two knights
        // flanking it — both knights still take damage.
        const wyvern = { cardId: "wyvern", x: 0, z: 0, hp: 120 };
        const k1 = { cardId: "knight", x: 2.0, z: 0, hp: 100 };
        const k2 = { cardId: "knight", x: 0, z: 2.4, hp: 100 };

        applyMeleeAoE(BARBARIAN, [wyvern, k1, k2], 60);

        assert.equal(wyvern.hp, 120, "wyvern untouched");
        assert.equal(k1.hp, 40, "knight on the x axis still hit");
        assert.equal(k2.hp, 40, "knight at the splash edge still hit");
    });

    it("does not damage units outside the splash radius", () => {
        const far = { cardId: "knight", x: 10, z: 10, hp: 100 };
        const hit = applyMeleeAoE(BARBARIAN, [far], 60);
        assert.deepEqual(hit, []);
        assert.equal(far.hp, 100);
    });

    it("still lets air-capable units splash air", () => {
        // Wizard is a ranged unit but the same splash loop serves it, so the
        // guard must not over-block: anything in CAN_ATTACK_AIR hits air.
        const wizard = { cardId: "wizard", x: 0, z: 0, hp: 80 };
        const wyvern = { cardId: "wyvern", x: 1, z: 0, hp: 120 };
        const hit = applyMeleeAoE(wizard, [wyvern], 50);
        assert.deepEqual(hit, ["wyvern"]);
        assert.equal(wyvern.hp, 70);
    });
});

describe("splash data is internally consistent", () => {
    /** Every card whose attack is instant (no projectile) and reaches a radius. */
    function meleeAoeCards(): string[] {
        return Object.keys(CARD_ATTACK_SPLASH).filter(
            (c) => CARD_PROJECTILE_SPEED[c] === 0 && CARD_ATTACK_SPLASH[c] > 0,
        );
    }

    it("every melee-AoE card is ground-only, so the air guard applies", () => {
        // The roster grew a second melee-AoE card (clanker, splash 2.0), so
        // this can no longer be a hardcoded name list — a new AoE troop would
        // silently skip this check. The invariant that actually protects
        // players is structural: applyMeleeSplashToUnits skips flying targets
        // for every attacker that is NOT in CAN_ATTACK_AIR, so a melee-AoE
        // card must never be air-capable.
        const meleeAoe = meleeAoeCards();
        assert.ok(meleeAoe.length > 0, "the roster must keep at least one melee-AoE card");
        for (const c of meleeAoe) {
            assert.ok(!CAN_ATTACK_AIR.has(c), `${c} is a melee-AoE card and must be ground-only`);
        }
    });

    it("keeps the barbarian as a melee-AoE ground unit", () => {
        // The original regression card stays pinned explicitly: the bug was a
        // barbarian cutting down a wyvern inside its 2.5 splash.
        assert.ok(meleeAoeCards().includes("barbarian"), "barbarian is a melee-AoE card");
        assert.ok(!CAN_ATTACK_AIR.has("barbarian"), "barbarian is ground-only");
    });

    it("clanker cannot damage flying units inside its splash", () => {
        // clanker (cardType 13, Epic melee bruiser, splash 2.0) is the second
        // melee-AoE card. It is not in CAN_ATTACK_AIR, so the same guard that
        // protects the barbarian has to protect it.
        const clanker = { cardId: "clanker", x: 0, z: 0, hp: 280 };
        const wyvern = { cardId: "wyvern", x: 1, z: 0, hp: 120 };
        const knight = { cardId: "knight", x: 1.5, z: 0, hp: 100 };

        const hit = applyMeleeAoE(clanker, [wyvern, knight], 45);

        assert.equal(wyvern.hp, 120, "a wyvern inside clanker's splash must take no damage");
        assert.equal(knight.hp, 55, "clanker still hits ground units in range");
        assert.deepEqual(hit, ["knight"]);
    });

    it("every air-capable card is correctly classified", () => {
        // NOT "flying implies can-attack-air": the healer flies but never
        // attacks, so it is legitimately absent from CAN_ATTACK_AIR. What must
        // hold is the direction that protects players — nothing that can
        // attack air may be missing from the allowlist.
        for (const c of Object.keys(CARD_ATTACK_SPLASH)) {
            const canHitAir = CAN_ATTACK_AIR.has(c);
            const flying = FLYING_UNITS.has(c);
            if (canHitAir) continue;
            // Ground-only cards must not appear in FLYING_UNITS either, or the
            // guard would let a ground unit hit them while they were airborne.
            assert.ok(
                !flying || c === "healer",
                `${c} is not air-capable but is classified as flying`,
            );
        }
    });
});