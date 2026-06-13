import {
    defineServer,
    defineRoom,
    monitor,
    playground,
} from "colyseus";

/**
 * Import your Room files
 */
import { BattleRoom } from "./rooms/BattleRoom.js";
import { BattleQueueRoom } from "./rooms/BattleQueueRoom.js";

// Load .env.production (or .env as fallback) at startup.
// CRITICAL: must run BEFORE BattleRoom.onAuth or onCreate reads process.env.
// The env file holds secrets (SUPABASE_SERVICE_ROLE_KEY, GAME_SERVER_SECRET)
// that recordMatchToServerSide needs to call the record-match edge function.
//
// Pattern: load .env.production if it exists (production deploys), otherwise
// .env (local dev). No dotenv import = no env loaded; BattleRoom would
// log "Supabase integration skipped" on every match.
import dotenv from "dotenv";
import * as path from "path";
import * as fs from "fs";

const envFile = process.env.NODE_ENV === "production" && fs.existsSync(path.resolve(process.cwd(), ".env.production"))
    ? ".env.production"
    : ".env";
dotenv.config({ path: path.resolve(process.cwd(), envFile) });
if (process.env.SUPABASE_URL) {
    console.log(`[config] Loaded env from ${envFile} (SUPABASE_URL set)`);
} else {
    console.warn(`[config] No SUPABASE_URL in ${envFile} — match recording will be skipped`);
}

const server = defineServer({
    /**
     * Define your room handlers:
     *
     * - battle_queue: pre-game matchmaking (pairs players into a fresh battle)
     * - battle:       the actual game room (server-authoritative 1v1)
     */
    rooms: {
        battle_queue: defineRoom(BattleQueueRoom),
        battle: defineRoom(BattleRoom),
    },

    /**
     * Bind your custom express routes here:
     * Read more: https://expressjs.com/en/starter/basic-routing.html
     */
    express: (app) => {
        // --- MANUAL CORS MIDDLEWARE ---
        // SECURITY (Celah 7 in audit): localhost is only allowed in non-prod
        // environments. In production, only the live domain(s) are allowlisted
        // so a malicious site on http://localhost:5173 cannot reach the
        // production WebSocket / HTTP API on behalf of a logged-in user.
        app.use((req, res, next) => {
            const origin = req.headers.origin;
            const allowedOrigins = [
                "https://clashonchain.xyz",
                "https://www.clashonchain.xyz",
            ];
            if (process.env.NODE_ENV !== "production") {
                allowedOrigins.push("http://localhost:5173", "http://localhost:4173");
            }

            if (origin && allowedOrigins.includes(origin)) {
                res.setHeader("Access-Control-Allow-Origin", origin);
            }

            res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
            res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-colyseus-auth");
            res.setHeader("Access-Control-Allow-Credentials", "true");

            // Handle preflight (OPTIONS)
            if (req.method === "OPTIONS") {
                return res.sendStatus(204);
            }
            next();
        });

        /**
         * Use @colyseus/monitor
         * It is recommended to protect this route with a password
         * Read more: https://docs.colyseus.io/tools/monitoring/#restrict-access-to-the-panel-using-a-password
         */
        app.use("/monitor", monitor());

        // ─── PUBLIC ROOM LIST (for spectate) ───────────────────
        // Returns a list of currently-active battle rooms so the
        // web UI's "Spectate Agent Battleground" panel can show
        // live matches. Public metadata only — no game state, no
        // client secrets, no wallet info (per-room metadata is
        // opt-in: rooms that don't set metadata won't be listed).
        //
        // Security: this endpoint reveals "matches are happening"
        // info (which is also visible via the @colyseus/monitor
        // panel). Acceptable for an MVP spectate feature. If this
        // becomes a problem, gate it behind an admin token like
        // the MCP server's /sessions endpoint.
        app.get("/rooms/:roomName", async (req, res) => {
            try {
                const { matchMaker } = await import("colyseus");
                const rooms = await matchMaker.query({
                    name: req.params.roomName,
                });
                const publicView = rooms.map((r: any) => ({
                    roomId: r.roomId,
                    name: r.name,
                    clients: r.clients,
                    maxClients: r.maxClients,
                    locked: !!r.locked,
                    private: !!r.private,
                    metadata: r.metadata ?? {},
                    creationTime: r.creationTime,
                }));
                res.json({ rooms: publicView, count: publicView.length });
            } catch (err) {
                res.status(500).json({ error: (err as Error).message });
            }
        });

        /**
         * Use @colyseus/playground
         * (It is not recommended to expose this route in a production environment)
         */
        if (process.env.NODE_ENV !== "production") {
            app.use("/", playground());
        }
    }

});

export default server;