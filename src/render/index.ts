// Oathbound v2 renderer — public API. Import from 'src/render/index.ts' only.
//
// CREATE
//   const view = new BattleView(container, {
//     quality: 'auto',            // 'low'|'medium'|'high'|'ultra'|'auto' (auto = stored choice → GPU guess → frame probe)
//     idleFps: 0,                 // 0 = render on demand (sleep when idle); 30 = keep water/wind alive at 30 fps
//     seat: 0,                    // whose end the camera sits at (seat 1 = rotated 180°)
//     terrain: playerView.terrain,// sim Terrain (features in cm); defaultTerrain() if omitted
//     keeps,                      // optional KeepInfo[] (replay.keeps); default at (4000,0) / (4000,12000)
//     artManifest: 'models/v2/manifest.json', // optional; procedural stand-ins until the GLBs land
//   });
//   view.setTerrain(terrain, keeps?)            // when the match terrain is known / changes
//   view.setSeat(seat)
//   view.engine.setInsets({ left, right, top, bottom })   // HUD panels: the view centres in the rest
//
// PLANNING
//   view.setPlanning({ visible: true, seat, grid: true })  // deploy-zone glow (+ fine grid while placing); RTS camera
//   Ghost owners' squads draw as intel: solid team-coloured figures with a bright rim plus a ground footprint
//   (formation outline + facing chevron); no dither. view.setHomeFarEdge(yCm | null) extends the home view to a
//   far field y (e.g. the ghosts' rearmost squad) while keeping the home pitch; null = enemy zone front edge.
//   view.showArmy(squads, { ghostOwners: [enemySeat], highlight: { [squadId]: 'selected' } })
//       squads: ArmySquad[] (sim Squad is compatible: id, owner, type, lord, pos [cm], facing 0..255, level)
//   view.highlightSquads({ [id]: 'hover' | 'selected' | 'invalid' })
//   view.pickGround(clientX, clientY) → [xcm, ycm] | null      view.pickSquad(clientX, clientY) → squadId | null
//   view.fieldToScreen(xcm, ycm, h) / view.squadScreen(squadId) → { x, y } CSS px (labels, HP bars)
//   view.camera.claimPointer = (e) => boolean   // return true to keep a left-press for the UI (dragging squads)
//   view.showRangeRing(squadId | [xcm, ycm], radiusCm, { color? }) → { setCenter, setRadius, dispose }; view.clearRangeRings()
//   SQUAD PLATES (in-world, one instanced draw; planning + battle): a crest with the unit portrait ringed in
//   the team colour (gold for Lords), the squad's total HP bar and level pips, constant screen size, hidden
//   when the camera is close. highlightSquads / showArmy's `highlight` drive their hover / selected look;
//   or set it directly: view.setSquadPlate(squadId, { selected?, hovered? })   ({} clears)
//   view.setSquadPlates(false) hides them all. Soldiers also scale up to 1.3× at far zoom.
//   Planning: trees standing in a visible deploy zone shrink to saplings (no dither / transparency), so units
//   and the grid read; the forest floor still marks the forest.
//   Battle: soldiers hidden behind canopies / walls / hills show a team-coloured silhouette.
//   Player cameras (rts / free / orbit) are never lifted by obstacles: height and pitch are pure orbit maths with a
//   smoothed floor over ground, solid geometry and big / flying units. A Keep or arrow tower between the lens and the
//   focus fades to a 30 % ghost (per object, no dither); leaves and particles right at the lens fade out. Only the
//   director raises its pitch to clear crowns, by at most camera.maxLift (0.3 rad).
//
// BATTLE
//   import { decodeReplay, sampleReplay, makeTransforms } from '../sim/index.ts';
//   const src = replaySource(decodeReplay(replay), sampleReplay, makeTransforms);
//   const pb = view.playBattle(src, { onEvent(e, ms) {}, onEnd() {}, damageNumbers: 'important', director: true });
//   pb.playing = false / true;  pb.speed = 2;  pb.seek(ms);  pb.timeMs;  pb.durationMs
//   view.stopBattle()
//   Events drive units (attack/cast one-shots, hit flashes, deaths), the director and VFX automatically.
//   Item skills (replay v3): replaySource passes `decoded.skills` through as `source.skills`; each cast plays its
//   signature effect in sync with its tick and fires the hook  onSkill(e: SkillEvent, ms)  (e.squad = casting row of
//   Replay.squads, e.skill = SkillId) for banners / the kill feed. A custom or flipped BattleSource must carry
//   `skills` itself (pos in the same field cm as its events, i.e. flipped with them).
//
// VFX (direct triggers, world-space THREE.Vector3; also used by the event mapping)
//   view.vfx.projectile(kind, from, to, flightSec, arc) · impact(kind, pos, splashM) · hitSpark(pos, {crit, magic})
//   heal · lightning(from, to) · burn · frost · meteor(pos, r) · rally(pos, r, dur, follow?) · bulwark(...)
//   skyfall(from, to) · breath(origin, dir, len, halfAngle, dur) · stomp · marchDust · keepHit · keepCollapse
//   death(pos, size) · keepFire(points, dur) · levelUp · lootBeam(pos, rarity) → { setPosition, dispose }
//   damageNumber(pos, value, style, key?)  (key = squad id: hits within 0.75 s merge into one total; crits pop alone)
//   Skills: castFlare · firePatch · frostNova · mendingLight · shieldWall(follow, width, dur) · warCry · cleaveArc ·
//   arrowRain · chargeImpact · knockback · trample · diveStrike; projectile kinds fire_arrow · pin_shot · fire_pot · skill_fireball
//   settle() ends ambient emitters (called when a battle ends) · clear()
//   view.field.keep(seat).setStage(0..4) · view.engine.addShake(m) · view.engine.addFlash(k)
//
// CAMERA
//   view.camera.mode: 'rts' (planning) | 'director' (battle auto) | 'free' (user grabbed it during battle) | 'orbit'
//   view.setCameraMode(m) is the only way the mode changes (the rig binds no C / Home key: the UI does, and calls
//   setCameraMode('director' | 'free') or view.resetCamera()). view.resetCamera(): planning = fitted home view
//   (a ~45 degree shot of the deploy zone, river and enemy front line between the HUD insets, any aspect; the own
//   Keep is cropped / ghosted; undoes rotation / zoom), battle = director.
//   view.camera.home(seat, overview?) re-fits when the viewport / insets change until the player moves the camera.
//   view.camera.onUserControl / onReturnToDirector callbacks (show a "Press C for director" hint)
//   Controls: WASD/arrows/edge pan, wheel zoom towards the cursor (tilt curve), Q/E or right-drag rotate, drag pan,
//   touch pan/pinch/twist. The free battle camera starts from the planning yaw.
//
// POWER (hard requirement: no hot laptops)
//   Renders on demand: planning idle = 0 frames (nothing drawn until the camera / UI / an animation
//   changes something; anything that changes the scene goes through a setter that wakes the loop).
//   Never draws while the tab is hidden; also pauses while the window is blurred (opt out: pauseOnBlur: false).
//   view.setBatterySaver(true)  → low tier (no post/AO/DOF/bloom), DPR 1, 30 fps cap   (stored 'oathbound.render.batterySaver')
//   view.setFpsCap(0 | 30 | 60) → battle frame cap (0 = display refresh)            (stored 'oathbound.render.fpsCap')
//   Orbit backdrops (title / loot) cap at 30 fps; optional ambient idle animation ≤ 10 fps (idleFps).
//   Shadow maps redraw only when the camera or a caster moved. Auto tier: strong discrete GPU → high,
//   unknown → medium, integrated / mobile → low (ultra is opt-in); the frame probe only lowers it.
//
// QUALITY / STATS
//   view.setQuality('high' | 'auto')   (stored as localStorage 'oathbound.render.quality')
//   view.stats → { fps, frameMs, gpuMs (timer query, -1 if n/a), drawCalls, triangles, tier, auto, batterySaver, fpsCap, gpu, width, height, soldiers, heroes }
//   view.dispose()
//
// ART (public/models/v2/manifest.json, docs/ART.md) — pass artManifest: 'models/v2/manifest.json'
//   Loaded lazily per unit type present in the roster (procedural stand-ins until it arrives); the keep loads
//   at startup. Crowd: LOD1 GLB + f16 VAT (normals oct-packed in pos.w, `_vid` texel index, per-clip fps,
//   attack/attack2 alternate per soldier, death2 = mirrored death). Heroes / large / siege: skinned GLB + clips map.
//   view.artLoads → [{ model, ms, bytes }]. Event sources >= 1_000_000 are keeps (BASE + seat*4 + n).
//   Packed GLBs (meshopt + quantization + webp) decode via MeshoptDecoder; tint = manifest tintMask only.
//   Heroes / large / mounted fliers: skinned GLBs on the shared skeleton (mixer, 11 clips). Siege: node-animated
//   GLBs (idle/fire/reload/hit/death); fire → reload chains, and the projectile spawns at the clip's fireTime.
//   Props (manifest `props`): rocks, ruins, bridge (fitted to each crossing), arrow towers (team banner) -
//   InstancedMesh per prop per LOD, placed deterministically from the terrain; prop shadows only
//   on high/ultra (outskirts always use the baked ground shadow). Loaded at startup with the keep; units load
//   lazily per type present (planning: the squads shown; battle: the replay's roster).
//   Environment (docs/ART.md section 7): scanned PBR ground layers + a vegetation atlas in public/textures/env/
//   (flat placeholders until they arrive); trees / bushes / reeds are procedural branch geometry + leaf cards.
//
// COORDINATES: field cm (sim) → world metres: X = x/100 − 40, Z = 60 − y/100 (seat 0's keep at +Z). See core/coords.ts.

export { BattleView, type ArmySquad, type ArmyOptions, type BattleViewOptions } from './battle-view.ts';
export { BattlePlayback, type PlaybackHooks } from './battle-playback.ts';
export type { RangeRingHandle } from './range-ring.ts';
export { replaySource, sampleKeyframes, makeTransforms, type BattleSource } from './battle-source.ts';
export { defaultTerrain } from './terrain/index.ts';
export { TIERS, TIER_ORDER, type QualityTier, type QualitySettings } from './core/quality.ts';
export { fieldToWorld, worldToField, facingToYaw } from './core/coords.ts';
export { TEAM_COLORS } from './crowd/archetypes.ts';
export type { CameraMode, Shot } from './camera/rig.ts';
