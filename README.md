# THE HOLLOW TIDE — Multiplayer Prototype

A browser-first 2D top-down pirate horror/social-deduction game prototype.

## What's included
- Room creation and room-code joining
- 2–8 player lobby, character selection, host start
- Server-authoritative hidden roles (Crew / The Hollow)
- Real-time top-down movement on a compact pirate ship
- Repair tasks, sabotage, body reports, meetings, voting, and victory conditions
- Vintage maritime palette: weathered oak, parchment, brass, oxblood, tar black, sea-glass
- Desktop keyboard and mobile touch controls
- Reconnection attempt by reusing a session ID stored in the browser

## Requirements
- Node.js 18+
- Internet connection on first install for npm dependencies and the Socket.IO browser client CDN

## Run locally
```bash
npm install
npm start
```
Then open http://localhost:3000 in multiple browser tabs/devices.
For other devices on the same Wi-Fi, open `http://YOUR_COMPUTER_LAN_IP:3000` (allow the port through your firewall).

## Project layout

- `server.js` handles Express, Socket.IO connections, input validation, and room broadcasts.
- `src/game-state.js` owns game-state creation, snapshots, role assignment, meetings, victory rules, and shared game constants.
- `public/index.html` contains the self-contained browser UI and canvas renderer.

The server is intentionally authoritative: browser requests are treated as input only, while distance checks, cooldowns, roles, voting, and win conditions are validated on the server.

## Prototype limitations
This is a playable MVP foundation, not a production-ready commercial release. Rooms are in memory and reset when the server restarts. It has no account system, persistent statistics, matchmaking, moderation, or production deployment configuration. Network movement is intentionally simple and should be stress-tested before public release. For internet play, deploy the Node server to a host that supports long-lived WebSocket connections and HTTPS.

## Controls
- Desktop: WASD or arrow keys to move
- E: interact with a nearby task
- Space: report a nearby body / ring the emergency bell
- Q: sabotage (Hollow only)
- Click a vote button during meetings
- Mobile: on-screen directional pad and action buttons

## Game rules in this prototype
- 2 players: one Crew and one Hollow; duel ends by escape or elimination.
- 3–5 players: one Hollow.
- 6–8 players: two Hollow.
- Crew wins by completing the ship's repair objective or eliminating all Hollow.
- Hollow wins when living Hollow equal or outnumber living Crew, or critical sabotage expires.
- Meetings pause movement and sabotage. Highest votes eject; tie/skip ejects nobody.
