# MCP Agent Architecture (Conceptual — Not Implemented)

## Hybrid: Rules + LLM

```
┌─────────────────────────────────────────────────────┐
│  AI Agent (LLM, e.g. Claude)                        │
│  - Pikir setiap 5-10 DETIK (bukan tiap tick)        │
│  - Punya "strategic plan" jangka panjang            │
│  - Bisa: "Next 30 detik, build elixir, lalu push"   │
└─────────────────┬───────────────────────────────────┘
                  │ calls MCP tools
                  ↓
┌─────────────────────────────────────────────────────┐
│  MCP Server (Node.js)                               │
│  - Colyseus client (connect sebagai player)         │
│  - Local rule-based brain (reaksi cepat <100ms)     │
│  - Forward LLM decisions via deploy_card tool       │
└─────────────────┬───────────────────────────────────┘
                  │ WebSocket + 10Hz state sync
                  ↓
┌─────────────────────────────────────────────────────┐
│  clash-realtime (Colyseus)                          │
│  - Validate (elixir, zone)                          │
│  - Spawn units, run physics, run combat             │
└─────────────────────────────────────────────────────┘
```

## Keuntungan Pendekatan Hybrid

| Aspek | Pure LLM | Pure Rules | Hybrid |
|---|---|---|---|
| Kecepatan reaksi | ❌ Lambat (300ms+ per call) | ✅ <10ms | ✅ <10ms (rules) |
| Strategi panjang | ✅ Bagus | ❌ Gak ada planning | ✅ Bagus (LLM) |
| Biaya | ❌ Mahal (ratusan call/menit) | ✅ Gratis | ✅ Murah (call tiap 5-10s) |
| Anti-cheat concern | ⚠️ Bisa curang (super fast) | ✅ Fair | ✅ Fair (LLM cuma plan, eksekusi via rules) |
