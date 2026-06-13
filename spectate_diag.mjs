import { Client } from "@colyseus/sdk";

const roomId = process.argv[2];
const client = new Client("wss://ws.clashonchain.xyz");
const room = await client.joinById(roomId, { spectate: true });

room.onStateChange((state) => {
  if (state.elapsedSec > 5 && state.elapsedSec < 6) {
    console.log("=== STATE STRUCTURE (at T+5s) ===");
    console.log("Top-level keys:", Object.keys(state));
    console.log("elapsedSec:", state.elapsedSec, "status:", state.status, "winnerTeam:", state.winnerTeam);
    
    console.log("\n--- players MapSchema ---");
    state.players.forEach((p, sid) => {
      console.log(`  ${sid}: nickname=${p.nickname}, team=${p.team}, elixir=${p.elixir}, connected=${p.connected}`);
      console.log(`    player keys: ${Object.keys(p)}`);
      console.log(`    towers: ${p.towers ? `ArraySchema len=${p.towers.length}` : 'undefined'}`);
      if (p.towers && p.towers.length > 0) {
        p.towers.forEach((t, i) => {
          console.log(`      tower[${i}]: type=${t.type}, team=${t.team}, hp=${t.hp}/${t.maxHp}`);
        });
      }
      console.log(`    units: ${p.units ? `MapSchema size=${p.units.size}` : 'undefined'}`);
      if (p.units && p.units.size > 0) {
        p.units.forEach((u, uid) => {
          console.log(`      unit[${uid.slice(0,20)}...]: cardId=${u.cardId}, team=${u.team}, hp=${u.hp}`);
        });
      }
    });
    
    console.log("\n--- projectiles MapSchema ---");
    console.log(`  size: ${state.projectiles?.size || 0}`);
    
    process.exit(0);
  }
});

setTimeout(() => { console.log("Timeout, exiting."); process.exit(0); }, 30000);
