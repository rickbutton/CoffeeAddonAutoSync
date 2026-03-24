# BliZzi Interrupt Tracker - Party CD Tracking Analysis

Analysis of how BliZzi Interrupt Tracker (v3.1.4) tracks party cooldowns.

## Architecture

The addon uses a two-tier system:
1. **Interrupt CD tracking** (Core.lua) - tracks kick cooldowns for the M+ group
2. **Party utility CDs** (SyncCD.lua) - tracks defensives, offensives, and CC

## Interrupt CD Tracking

### Addon Users (players with the addon installed)

Communication via `C_ChatInfo.SendAddonMessage` with prefix `"BliZziIT"`.

Protocol messages (semicolon-delimited, header `B1`):
- `B1;HELLO;class;spellID;cd` — announced on group join
- `B1;KICK;spellID;cd` — sent when interrupt is cast
- `B1;FAILKICK` / `B1;SUCCESSKICK` — failed/successful kick indication
- `B1;ROT;p1,p2,...;idx` — kick rotation sync
- `B1;RIDX;idx` — rotation index update

**Own casts**: Detected via `UNIT_SPELLCAST_SUCCEEDED` on `"player"` and `"pet"`. Pet spells use a taint-stripping Slider trick (`BIT.Taint:Resolve`) since WoW 12.0 taints pet spell IDs.

**Party CDs**: Started **only** from received `KICK` addon messages, never from local UNIT_SPELLCAST events. This prevents false countdown bars.

### Non-Addon Users

Shown as desaturated "No Addon" placeholder bars. Their casts are tracked via `UNIT_SPELLCAST_SENT` (untainted spell name) for mob-interrupt correlation only — matching `UNIT_SPELLCAST_INTERRUPTED` on target/focus/nameplates back to the kicker. No visible CD timer is started.

## Party Utility CDs (SyncCD System)

Tracks defensives, offensives, and CC spells per spec. Only tracks players who also have the addon.

### Detection Methods

| Source | Method | Details |
|--------|--------|---------|
| Own casts | `UNIT_SPELLCAST_SUCCEEDED` on `"player"` | Matches against `BIT.SYNC_SPELLS[specID]`, reads real CD from `C_Spell.GetSpellCooldown`, handles charge-based spells, broadcasts `B1;SYNCCD;spellID;duration` |
| Party addon users | `B1;SYNCCD;spellID;duration` message | Received via `CHAT_MSG_ADDON`, calls `BIT.SyncCD:OnSpellUsed()` |
| Buff-based | `UNIT_AURA` event | Watches specific buff auras (Metamorphosis, Alter Time) on party units. If buff appears with no tracked CD, infers the spell was used (handles procs like Last Resort) |

### Handshake

`B1;HELLOSYNC;class` establishes which party members have the addon for SyncCD, even healers with no interrupt.

## Spec & Talent Awareness

- **Inspect system**: Queues `NotifyInspect()` for party members to get specID and talent tree
- **Talent mods**: `talentMods` in spell DB apply CD reductions. Own player via `C_Traits` API, party via inspect scan
- **`replacedBy`**: Handles talent-replaced spells (e.g., Incarnation replacing Celestial Alignment)
- **Re-inspect**: Every 30 seconds to catch spec changes

## Data Architecture

Single source of truth: `BIT.SPEC_REGISTRY` in Data.lua — one record per WoW spec ID with interrupt spell info. All lookup tables compiled at load time.

SyncCD spells defined per spec in `BIT.SYNC_SPELLS` (SyncCD.lua), categorized as DMG/DEF/CC.

CD state stored in `BIT.syncCdState[playerName][spellID] = expirationTime`. A 0.1s ticker updates all display icons.

## Key Limitations

- Party utility CDs only tracked for addon users (requires addon-to-addon messaging)
- CC spells listed as trackable via CLEU but primarily use the SYNCCD message path
- Author notes tracking may not be 100% accurate due to combat log complexity, talents, pets, and edge cases
