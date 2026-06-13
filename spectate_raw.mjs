import WebSocket from "ws";
import { Client } from "colyseus.js";

const roomId = process.argv[2];
const client = new Client("wss://ws.clashonchain.xyz");

// Use the SDK's matchmake to get a reservation
const reservation = await client.matchmake.joinById(roomId, { spectate: true });
console.log("Reservation OK, sessionId:", reservation.sessionId);

// Now consume the seat reservation
const room = await client.consumeSeatReservation(reservation);
console.log(`Joined ${room.id} as sessionId=${room.sessionId}`);

let ticks = 0;
let lastElapsed = -1;
room.onStateChange((state) => {
  ticks++;
  if (state.elapsedSec !== lastElapsed) {
    const units = Array.from(state.players?.values?.() || []).map(p => `${p.nickname}=${p.units?.length || 0}`).join(",");
    const towers = Array.from(state.towers?.values?.() || []).map(t => `${t.type[0]}${t.team}_${t.hp}`).join(",");
    console.log(`[T+${state.elapsedSec?.toFixed(0)}s tick#${ticks}] status=${state.status} units=[${units}] towers=[${towers}]`);
    lastElapsed = state.elapsedSec;
  }
});
setTimeout(() => { room.leave(); process.exit(0); }, 30000);
