-- 2026-06-26: Drop agent_card_inventory table + get_agent_card_inventory RPC
--
-- Agent Battle Deck validation is now fully on-chain via ClashCards.balanceOf
-- (see clash-mcp-server/src/onchain-cards.ts and clash-realtime BattleRoom.onJoin).
-- The DB-backed inventory cache is no longer queried by any service, so it is
-- safe to drop.
--
-- IMPORTANT: Run this AFTER deploying the on-chain deck validation changes to
-- both clash-mcp-server (master) and clash-realtime (main). If you drop the
-- table/RPC before the MCP server stops calling them, agents will fail to
-- build their deck.

-- 1. Drop the RPC function first (depends on the table)
DROP FUNCTION IF EXISTS public.get_agent_card_inventory(p_agent_id uuid);

-- 2. Drop the table
DROP TABLE IF EXISTS public.agent_card_inventory;

-- 3. Drop the has_starter_deck column from agents if it exists
--    (was used as a gate in the old MCP joinMatchQueue flow; now replaced
--    by hasBattleDeckOnChain on-chain ownership check)
ALTER TABLE public.agents DROP COLUMN IF EXISTS has_starter_deck;

-- 4. Verify cleanup (run manually to confirm)
-- SELECT proname FROM pg_proc WHERE proname = 'get_agent_card_inventory';  -- should return 0 rows
-- SELECT tablename FROM pg_tables WHERE tablename = 'agent_card_inventory'; -- should return 0 rows
