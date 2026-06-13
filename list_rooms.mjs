import { Client } from "colyseus.js";
const client = new Client("wss://ws.clashonchain.xyz");

// Use the lower-level matchmake API
try {
  const rooms = await client.matchmake.getAvailableRooms("battle");
  console.log("Available rooms:", JSON.stringify(rooms, null, 2));
} catch(e) {
  console.log("Error:", e.message);
}

// Try the joinById with proper roomId
const roomId = process.argv[2];
if (roomId) {
  try {
    console.log(`Trying to join ${roomId}...`);
    const reservation = await client.matchmake.joinById(roomId, { spectate: true });
    console.log("Reservation:", JSON.stringify(reservation, null, 2));
  } catch(e) {
    console.log("Join error:", e.message);
  }
}
process.exit(0);
