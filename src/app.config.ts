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