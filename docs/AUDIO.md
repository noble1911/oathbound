# Oathbound audio

All game audio is recorded samples with clean licences: CC0, CC-BY (credited below), public
domain, or the Sonniss GDC Game Audio Bundle licence. Nothing is synthesised at runtime except a
reverb impulse response, which is generated noise.

- **Sources:** download by hand into `art-work/audio-src/` (git-ignored), using the layout below.
- **Build:** `python -I tools/audio/build.py [id-prefix…]` trims the sources, slices multi-take
  recordings into single hits, layers them, makes loops seamless with an equal-power crossfade of
  the tail into the head, and loudness-normalises each clip to its category target. The
  normaliser never pushes a transient more than 2 dB into the soft limiter. The script writes
  48 kHz Opus-in-WebM files to `public/audio/`. It needs numpy, soundfile and ffmpeg (on `PATH`,
  or from the imageio-ffmpeg wheel). `tools/audio/inspect.py` prints durations, levels and onset
  segments.
- **Runtime:** `src/audio.ts` (the mixer and the battle soundscape) and `src/audio/bank.ts` (every
  clip with its bus, gain, variation, voice limit, cooldown and load group).
- **Test:** `tests/client.test.ts` checks that every file in the bank exists and that the SFX stay
  under 3.2 MB. `e2e/audio.mjs` plays a vs-AI match and two late-round dev battles in Chrome, and
  logs per-sound counts, pooling, drops and peak voices.

## Budget

| Set | Files | Size | Loaded |
| --- | --- | --- | --- |
| Interface and loot | 42 | 0.3 MB | After the first gesture (fetched at boot) |
| Ambience | 4 loops | 0.5 MB | Wind at boot. Forest and river in planning. The battle crowd with the battle set |
| Battle | 80 | 1.8 MB | In the background during planning |
| Stings | 7 | 0.3 MB | Round stings with the battle set. Victory and defeat during the battle |
| **SFX total** | **129** | **≈2.6 MB** | |
| Music | 4 tracks | 5.8 MB | Streamed with `<audio>` and `MediaElementSource`, about 80 kbps |

## Mixing

```
voices ─┬─ ui ───────────────────────────┐
        ├─ sfx ─┐                        ├─ master ─ glue compressor (3:1) ─ limiter (−3 dB, 20:1) ─ out
        │       └─ (send) ─ hall reverb ─┤
        ├─ amb ─ duck ───────────────────┤
<audio> music ─ crossfade ─ music ─ duck ┘
```

- **Buses and settings:** master, music, battle effects, ambience and interface each have a slider
  in Settings. They persist as `oathbound.volume`, `oathbound.musicvol`, `oathbound.sfx`,
  `oathbound.ambvol` and `oathbound.uivol`, and are applied on a squared (perceptual) curve.
- **Variation:** every battle sound has 2–8 variants and never plays the same one twice running.
  It also gets random pitch (±0.6–1.5 semitones) and random volume (±1–3 dB).
- **Voice limits:** each sound has a voice limit and a cooldown, and some share a pool (all melee
  clashes, all volleys). Battle effects have a global cap of 40 voices.
- **Clash beds:** each melee swing adds to a decaying, distance-weighted contacts-per-second
  estimate. The estimate crossfades two 14-second loops:
  - *skirmish*: sparse layered blade hits over a recorded distant battle;
  - *melee*: dense hits over a close crowd fight.

  On top of the beds only about 6 individual clashes per second play as accents, favouring the ones
  in view. The rest are pooled into the bed.
- **Volleys and arrow hits:** a volley is the arrows released in one event burst. It plays one
  layered bow-and-whoosh at their centroid, choosing the small or large variant by arrow count.
  Arrow impacts are pooled every 150 ms into one scatter of thuds.
- **Distance:** every battle sound is attenuated by its ground distance to the camera focus. The
  falloff scales with the zoom (see `attenuate()` in `bank.ts`). Distant sounds are low-passed and
  get more reverb, and the pan comes from the sound's screen position.
- **Ducking:** big moments duck the music (and the ambience by half): Lord abilities, keep hits and
  stage collapses, dragon roars, a Lord falling, the legendary reveal, the draft sting and the battle
  horn.
- **Music by phase:** the tracks crossfade over 1.5–2.5 s:
  - menu, lobby and Lord pick: *For the King*;
  - planning and results: *Woodland Fantasy*;
  - battle: *Battle Theme A* and *The Tread of War*, alternating by round;
  - match over: the victory or defeat sting, then back to the menu theme.
- **Ambience by phase:** planning plays forest birds and wind, with the river louder as the camera
  nears a river, ford or bridge. Battle plays wind, a distant battle crowd and the river.

## Power

- Nothing is fetched until `setPhase` asks for a group. Boot fetches only the interface set and
  decodes it after the first gesture. Planning fetches and decodes the battle set in the
  background, three files at a time, and drops the compressed bytes once they are decoded.
- The `AudioContext` is suspended, and the music elements paused, while the tab is hidden or the
  game is muted.
- The mixer timers run only in their phase: the beds every 150 ms in battle, and the ambience every
  500 ms in planning and battle. They never touch the renderer. `e2e/audio.mjs` checks that idle
  planning still draws 0 frames.
- The server answers byte-range requests (`206`), which Safari needs to stream `<audio>`.

## Credits and licences

### Music

| File | Track | Author | Licence | Source |
| --- | --- | --- | --- | --- |
| `music/menu` | For the King | Alexandr Zhelanov | CC-BY 4.0 | https://opengameart.org/content/for-the-king |
| `music/planning` | Woodland Fantasy | Matthew Pablo (www.matthewpablo.com) | CC-BY 3.0 | https://opengameart.org/content/woodland-fantasy |
| `music/battle_a` | Battle Theme A | cynicmusic (cynicmusic.com, pixelsphere.org) | CC0 | https://opengameart.org/content/battle-theme-a |
| `music/battle_b` | The Tread of War (RPG Orchestral Essentials) | InspectorJ (www.jshaw.co.uk) | CC-BY 3.0 | https://opengameart.org/content/the-tread-of-war-rpg-orchestral-essentials-military-music |
| `sting/victory` | Lively Meadow Victory Fanfare | Matthew Pablo (www.matthewpablo.com) | CC-BY 3.0 | https://opengameart.org/content/lively-meadow-victory-fanfare-and-song |
| `sting/defeat` | Medieval defeat theme (first 11 s) | RandomMind | CC0 | https://opengameart.org/content/medieval-defeat-theme |
| `ui/draft` | Orchestral Stinger: Dramatic Entrance (first 4 s) | tcarisland | CC-BY 4.0 | https://opengameart.org/content/orchestral-stinger-dramatic-entrance |

### Sound effects: CC0 and public domain

| Used in | Source | Author | Licence | URL |
| --- | --- | --- | --- | --- |
| UI clicks, ticks, errors; impacts in clicks, fists, deaths, arrow hits, trebuchet, loot | Interface Sounds, UI Audio, Impact Sounds, RPG Audio | Kenney | CC0 | https://kenney.nl/assets/interface-sounds, https://kenney.nl/assets/ui-audio, https://kenney.nl/assets/impact-sounds, https://kenney.nl/assets/rpg-audio |
| Blade clashes (`battle/clash_1–6`, `clash_heavy_*`), the clash beds | Medieval Sound Effects: Weapon Impacts (real swords, axes, maces at 192 kHz) | Still North Media (Ben Jaszczak and Brian Nelson) | CC0 | https://opengameart.org/content/medieval-sound-effects-weapon-impacts |
| Volley whooshes, ballista, trebuchet swish | Swishes sound pack | artisticdude | CC0 | https://opengameart.org/content/swishes-sound-pack |
| Equip buckle | Fantasy Weapons and Apparel SFX library | Vehicle | CC0 | https://opengameart.org/content/fantasy-weapons-and-apparel-sfx-library |
| Deploy drum hits (sliced) | Horde War Drums loop | William Hector | CC0 | https://opengameart.org/content/horde-war-drums-loop |
| Keep hits (wall layer) | Battle at sea (`cannon_hit_wall_no_splash`) | Thimras | CC0 | https://opengameart.org/content/battle-at-sea |
| Ready horn | Hunting horn tone | Alon-De-Lon (Wikimedia Commons) | CC0 | https://commons.wikimedia.org/wiki/File:Hunting_horn_tone.ogg |
| Battle horn, rally, Lord reveal | Hornbläser (cow horns, Klausjagen in Küssnacht) | User:Basel (Wikimedia Commons) | Public domain | https://commons.wikimedia.org/wiki/File:Hornblaeser.ogg |

### Sound effects: Sonniss GDC Game Audio Bundles

These are royalty-free and allowed in commercial games, with no attribution required (credited here
anyway). They may not be redistributed as a sound library: the game ships only trimmed, mixed and
encoded clips. Bundles: https://sonniss.com/gameaudiogdc. The individual files were taken from the
archive.org mirrors `sonniss-gdc-<year>-game-audio-bundle-normalized`. The exact file URLs are in
`art-work/audio-src/sonniss/manifest.tsv`, which is written by the fetch.

| Bundle | Library | Used in |
| --- | --- | --- |
| 2015 | Coll Anderson: Battle Crowd | Skirmish bed, battle ambience, war cry, squad wiped (agony), round won (celebration), rally |
| 2015 | Coll Anderson: Sliding Whoosh By | UI whoosh, legendary riser, meteor incoming |
| 2015 | Soundopolis: Nature's Fury, Thunder | Skyfall |
| 2015 | Varazuvi: Hollywood Dragons | Dragon roars and huffs |
| 2017 | Double Trouble Audio: Medieval Armor and Impacts | Parry, plate and chainmail (equip, deploy, bulwark) |
| 2017 | Gamemaster Audio: Explosion Sound Pack | Fireball and stone impacts, meteor, big booms |
| 2017 | Hzandbits: Wind In Trees | Wind ambience |
| 2018 | Effectsworks: COINAGE | Coin pouch |
| 2018 | Fox Audio Post-Production: Dino, Roars and Growls | Dragon roar layer, wyvern screech |
| 2018 | Gamemaster Audio: Magic and Spell Sounds | Lightning, skyfall |
| 2018 | Gregor Quendel: Designed Fire | Fire breath, fire explosions, meteor |
| 2019 | Eiravaein Works: Nocked | Bow releases (volleys), crossbow snap (ballista) |
| 2019 | Federico Soler Fernández: Effective Trailer Booms | Legendary reveal, keep collapse, meteor, Lord reveal |
| 2019 | Rock The Speakerbox: Hero | Melee bed (crowd fight) |
| 2019 | Rock The Speakerbox: Sorcery | Gravebloom summon |
| 2019 | Sound Spark LLC: Magic Spells, Buffs and Attacks | Fireball cast, heal, bulwark |
| 2020 | 344 Audio: Medieval Battle | Battle charge, warrior grunts |
| 2020 | David Dumais Audio: Magic Sound FX Pack 1, Spells Magic 1 | Fire explosions, bulwark, ability cast |
| 2020 | SmartSoundFX: Medieval | Sword hit, arrow hit, body drop (deaths), fireball whoosh |
| 2023 | 344 Audio: Epic Impacts Vol. 1 | Keep hits, squad wiped, golem stomp |
| 2023 | BluezoneCorp: Building Collapse | Keep stage collapse, stone debris |
| 2023 | CB Sound Design: Dreamcatcher | Harp glissando (level up, rare loot), bell tree (legendary) |
| 2023 | CB Sound Design: Essential Sounds Vol. 01 Coins | Coins |
| 2023 | David Dumais Audio: Magic Sound FX Pack 2 | Lightning |
| 2023 | InspectorJ: RPG Orchestral Essentials (Music FX) | Round lost sting, legendary swell |
| 2023 | Justsoundeffects: Streams and Rivers | River ambience |
| 2024 | BluezoneCorp: Stone Impact | Siege stone impacts, keep hits, stomp |
| 2024 | Justsoundeffects: Forest Ambiences | Planning ambience (birds, wind in leaves) |
| 2026 | Epic Stock Media: Fantasy Game 2 | Modal open, magic and heal chimes |

## Source layout (`art-work/audio-src/`)

```
kenney/{rpg-audio,impact-sounds,interface-sounds,ui-audio}/Audio/*.ogg   (from kenney.nl zips)
oga/…                                                                   (the OGA files above, as downloaded; zips/7z extracted beside them)
commons/hunting_horn_tone.ogg, commons/hornblaeser.ogg
sonniss/<year>/<library>/<file>.flac                                    (+ manifest.tsv with each file's URL)
```

## Not sourced, or compromises

- **War horn:** there is no clean-licence recording of a real war horn on OpenGameArt or Kenney,
  and freesound.org needs an API key. The horn calls are a real Swiss cow-horn recording (public
  domain) and a CC0 hunting horn, with reverb added.
- **Cavalry hooves and footsteps:** these are not used. The bundled horse gallop is a single long
  take, and the march would add more mud than character.
- **Format:** Opus in WebM plays everywhere but older Safari versions (before 15). An AAC fallback
  would double the files, so the game ships none.
