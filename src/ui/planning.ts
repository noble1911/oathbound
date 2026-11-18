// Planning HUD: Keep bars / round / timer, the resource strip (gold, deploys n/limit, army, the
// enemy-intel label: last round's enemy positions are always drawn from round 2), the shop bar of unlocked units, drag-to-deploy with a formation ghost and rotation
// (right-drag or Q/E), moving squads, the selected-squad panel (level-up, stats, item slots,
// sell), the stash with drag-and-drop equipping and comparison tooltips, the loot and draft
// modals, and Ready. Keys: Space ready, Tab / Shift+Tab select the next / previous of your squads, 1-9 0 - shop, Q/E turn the squad while placing
// or dragging (Shift+Q/E for the selected squad; otherwise Q/E turn the camera), U level up, Del
// sell (press twice), Home reset the camera, Esc cancel. Spectators get a read-only version: both
// Keeps, both last-round armies, no shop, no deploy badge.
import type { Intent, Item, LordId, PlayerState, PlayerView, Seat, Slot, Squad, UnitType, Vec2 } from '../sim/types.ts';
import { factionOfLord } from '../sim/data/factions.ts';
import type { RoomView } from '../net/protocol.ts';
import { UNITS } from '../sim/data/units.ts';
import { LORDS, lordAuraRing } from '../sim/data/lords.ts';
import { deployPointsText, inDeployZone, levelUpCost, sellRefund, ARMY_CAP, MAX_SQUAD_LEVEL, LORD_XP_LEVELS, MAX_LORD_LEVEL, overlappingSquad, freeSpotNear, canMuster, squadHome, squadLocked, MUSTER_MOVES } from '../sim/match.ts';
import { SLOT_UNLOCK_LEVEL } from '../sim/data/items.ts';
import { sound } from '../audio.ts';
import { playLordLine } from '../audio/voice.ts';
import type { Backend } from './backend.ts';
import type { SceneAdapter, SquadVisual } from './scene-adapter.ts';
import { $, el, esc, hideTip, num, showTipAt, store, tip, toast } from './dom.ts';
import { icon } from './icons.ts';
import { deadSummary, equipRefusal, itemIcon, itemTooltip, itemTooltipPair, slotLockText } from './items.ts';
import { classIcon, crest, deployChip, squadTooltip, statBlock, countersBlock, sheetStats, skillChips, skillTooltip, tagIcons, unitTooltip } from './units.ts';
import { squadSheet } from '../sim/sheet.ts';
import { squadSize } from '../sim/battle.ts';
import { squadSkills } from '../sim/data/skills.ts';
import { defaultFacing, deployRefusal, effectiveStats, levelGainText, rarityRank, SHOP_KEYS, SLOT_LABEL, SLOTS, slotOpen, soldierStats, unitName, allItems } from './gamedata.ts';
import { niceError, TopBar } from './hud.ts';
import { DraftModal, LootModal, draftKey } from './loot.ts';
import { frontLine, groupPlace, itemsKey, marchFoes, marchOf, mirrorPlace, planMoves, settle, snapPos, syncBySpeed, type March, type MarchFoe, type Placed } from './timing.ts';
import type { TagBadge, TimingSpec } from './scene-adapter.ts';
import { dragRefusal, ghostMark, GHOST_MARK_TEXT, lockedText, lockState, mirrorable, pinnedIn, relocCount, relocSource, targetsRefusal, type RelocMe } from './relocation.ts';

type Drag =
  | { kind: 'place'; unit: UnitType; facing: number; fromShop: boolean; moved: boolean; pos: Vec2 | null; rot: Vec2 | null }
  | { kind: 'move'; id: number; facing: number; start: [number, number]; moved: boolean; pos: Vec2 | null; rot: Vec2 | null }
  /**
   * Several selected squads at once: `grab` is the ground under the press, `delta` how far the group has
   * moved, `steps` how far it has turned about its centroid (right-drag or Q/E). `base` is where each
   * squad stood when the drag began; `out` the settled spots shown while dragging.
   */
  | { kind: 'group'; ids: number[]; start: [number, number]; grab: Vec2; moved: boolean; delta: Vec2; steps: number; rot: { from: number; at: number } | null; base: Map<number, Placed>; out: Map<number, Placed> | null; pos: Vec2 | null; turnOnly: boolean; hit: number; pinned: Set<number>; turnPinned: Set<number> };

/** One undoable planning action: `undo` sends the intents that revert it (false: nothing left to revert). */
interface UndoEntry {
  label: string;
  at: number;
  undo: () => boolean;
  /** Same key, moments apart (a few Q/E presses): one undo step. */
  key?: string;
}
const UNDO_MAX = 24;
/** Group turn per Q/E press (binary angle: 16 = 22.5 degrees). */
const TURN_STEP = 16;

const GHOST_TIP = 'The red ghosts on the far half are where the enemy army stood in the last battle. You never see what they are doing now. Enemy squads stay where they stand unless they Muster. Hover or click one to read it.';
const GHOST_TIP_NONE = 'From round 2 you always see where the enemy army stood in the last battle.';

const ANG = (dx: number, dy: number) => Math.round(((Math.atan2(dy, dx) / (Math.PI * 2)) * 256 + 256)) & 255;

function bestRarity(sq: Squad): SquadVisual['rarity'] {
  let r: SquadVisual['rarity'] = null;
  for (const s of SLOTS) {
    const it = sq.items[s];
    if (it && (!r || rarityRank(it.rarity) > rarityRank(r))) r = it.rarity;
  }
  return r;
}

export function visual(sq: Squad, lord: LordId | null): SquadVisual {
  return { id: sq.id, type: sq.type, lord: sq.type === 'lord' ? lord : null, owner: sq.owner, pos: sq.pos, facing: sq.facing, level: sq.level, size: squadSize(sq), rarity: bestRarity(sq) };
}

export class PlanningScreen {
  readonly root: HTMLElement;
  private top: TopBar;
  private res: HTMLElement;
  private shop: HTMLElement;
  private panel: HTMLElement;
  private stash: HTMLElement;
  private tools: HTMLElement;
  private readyBox: HTMLElement;
  private notices: HTMLElement;
  private hint: HTMLElement;
  room: RoomView | null = null;
  private view: PlayerView | null = null;
  private me: PlayerState | null = null;
  private seat: Seat = 0;
  /** My selected squads (one, several, or none). */
  private sel = new Set<number>();
  /** The one selected squad of mine, when exactly one is selected (level up, sell, equip-on-click). */
  private get selected(): number | null {
    return this.sel.size === 1 ? this.sel.values().next().value! : null;
  }
  private ghostSel: number | null = null;
  private drag: Drag | null = null;
  /** Where my squads are shown until the server's snapshot catches up with the moves just sent. */
  private pend = new Map<number, Placed>();
  /** This planning phase's undoable actions (newest last). */
  private undos: UndoEntry[] = [];
  /** Box selection in progress (screen px). */
  private box: { x: number; y: number; add: boolean; el: HTMLElement | null } | null = null;
  /** The march preview: full routes for every squad (T), or tags only. */
  private routesOn = store.get('plan.routes') === '1';
  private marchCache = new Map<string, March>();
  private foes: MarchFoe[] = [];
  private foesKey = '';
  private front = 0;
  private timingKey = '';
  private loot: LootModal | null = null;
  private draft: DraftModal | null = null;
  private lootSeen = '';
  private draftSeen = '';
  private itemDrag: { item: Item; from: number | null; el: HTMLElement | null; x: number; y: number; started: boolean } | null = null;
  private off: (() => void)[] = [];
  private round = 0;
  private names: [string, string] = ['You', 'Rival'];
  /** Auto-opened modals (draft, loot) wait until this time: the VS reveal plays first. */
  private modalsAt = 0;
  /** A sell waiting for its second press: [squad id, expiry]. */
  private sellArmed: { id: number; until: number } | null = null;
  /** Opens last round's battle report (set by the app when there is one). */
  onReport: (() => void) | null = null;
  reportHint: string | null = null;
  /** Leave / stop watching (the app confirms). */
  onLeave: (() => void) | null = null;

  private scene: SceneAdapter;
  private backend: Backend;

  constructor(ui: HTMLElement, scene: SceneAdapter, backend: Backend) {
    this.scene = scene;
    this.backend = backend;
    this.root = el(`<div class="screen planning">
      <div class="res">
        <div class="r-gold" data-tip="Gold. Unspent gold carries over to the next round.">${icon('gold')}<b>0</b></div>
        <div class="r-army" data-tip="Squads in your army (cap ${ARMY_CAP}, Lord not counted)">${icon('squads')}<b>0/${ARMY_CAP}</b></div>
        <div class="r-ghost na" data-tip="${GHOST_TIP_NONE}">${icon('eye')}<span>No intel until round 2</span></div>
      </div>
      <div class="notices"></div>
      <aside class="sqpanel panel"></aside>
      <div class="ptools" role="toolbar" aria-label="Formation">
        <button class="btn pt pt-undo" disabled>${icon('undo')}<small>Undo</small></button>
        <button class="btn pt pt-mirror" data-tip="Mirror your formation left to right">${icon('mirror')}<small>Mirror</small></button>
        <button class="btn pt pt-sync">${icon('sync')}<small>Sync</small></button>
        <button class="btn pt pt-timing" aria-pressed="false" data-tip="March routes: every squad's path, with the seconds to the river and to where the enemy's front stood last round [T]. The seconds under each plate are always on.">${icon('route')}<small>Routes</small></button>
        <button class="btn pt pt-snap" aria-pressed="false">${icon('grid')}<small>Snap</small></button>
      </div>
      <aside class="stash"><button class="icon stash-tab" aria-expanded="false" data-tip="Stash: the items you hold [B]">${icon('bag')}<em class="badge"></em></button><div class="stash-fly panel"><header>${icon('bag')}<b>Stash</b><small></small><button class="icon close stash-x" data-tip="Close [B]">${icon('close')}</button></header><div class="stash-grid"></div><p class="stash-hint">Drag items onto a squad or its slots. Drag here to unequip.</p></div></aside>
      <div class="bottom">
        <div class="deploy-badge" data-tip="Deploy points left this round. A 100-gold squad costs 1, a 150 to 300-gold squad 2, a 400-gold one 3. Levelling up and equipping are unlimited."><small>Deploys left</small><b>4</b><span>of 4 this round</span></div>
        <div class="shop"></div>
        <div class="ready-box"></div>
      </div>
      <div class="phint"></div>
    </div>`);
    ui.appendChild(this.root);
    this.top = new TopBar(this.root);
    this.res = $(this.root, '.res');
    this.shop = $(this.root, '.shop');
    this.panel = $(this.root, '.sqpanel');
    this.stash = $(this.root, '.stash');
    // the stash lives in the left rail, clear of the deploy zone: a bag button that opens the flyout
    $(this.stash, '.stash-tab').addEventListener('click', () => (sound.click(), this.openStash(!this.stashOpen())));
    $(this.stash, '.stash-x').addEventListener('click', () => (sound.click(), this.openStash(false)));
    this.tools = $(this.root, '.ptools');
    $(this.tools, '.pt-undo').addEventListener('click', () => this.undo());
    $(this.tools, '.pt-mirror').addEventListener('click', () => this.mirror());
    $(this.tools, '.pt-sync').addEventListener('click', () => this.syncSpeed());
    $(this.tools, '.pt-timing').addEventListener('click', () => this.toggleRoutes());
    $(this.tools, '.pt-snap').addEventListener('click', () => this.toggleSnap());
    this.readyBox = $(this.root, '.ready-box');
    this.notices = $(this.root, '.notices');
    this.hint = $(this.root, '.phint');
    scene.setMode('planning');
    // the old "hide the enemy's last round" preference is gone: the ghosts always show
    store.set('ghosts', null);
    this.bind();
  }

  // ---------------------------------------------------------------- snapshot

  update(room: RoomView): void {
    this.room = room;
    const v = room.view!;
    this.view = v;
    this.me = v.you;
    // a spectator has no `you`: the top bar shows seat 0 on the left and seat 1 on the right
    const spect = !v.you || v.seat === null;
    this.seat = (v.seat ?? 0) as Seat;
    const newRound = v.round !== this.round;
    this.round = v.round;
    const mySeat = this.seat;
    const foeSeat = (1 - mySeat) as Seat;
    this.names = [room.seats[mySeat]?.name ?? (spect ? 'South' : 'You'), room.seats[foeSeat]?.name ?? (spect ? 'North' : 'Rival')];
    this.root.classList.toggle('spectating', spect);
    if (newRound) {
      // undo, optimistic moves and the selection belong to one planning phase
      this.pend.clear();
      this.undos = [];
      if (this.sel.size > 1) this.sel.clear();
    }
    for (const [id, p] of this.pend) {
      const sq = this.me?.squads.find((s) => s.id === id);
      if (!sq || (sq.pos[0] === p.pos[0] && sq.pos[1] === p.pos[1] && sq.facing === p.facing)) this.pend.delete(id);
    }
    const gone = [...this.sel].filter((id) => !this.me?.squads.some((s) => s.id === id));
    if (gone.length) {
      for (const id of gone) this.sel.delete(id);
      this.select(this.sel.size === 1 ? this.selected : null, false, [...this.sel]);
    }

    this.scene.setPerspective(v.seat);
    this.scene.setTerrain(v.terrain);
    // both sides' public state: my own, or (spectating) each seat's public view
    const mine = v.you ?? v.enemies?.[mySeat] ?? v.enemy;
    const foe = v.enemies?.[foeSeat] ?? v.enemy;
    this.scene.setKeeps(mySeat === 0 ? [mine.keepHp, foe.keepHp] : [foe.keepHp, mine.keepHp], mySeat === 0 ? [mine.keepMax, foe.keepMax] : [foe.keepMax, mine.keepMax]);
    // each side's Keep is its faction's (the Lord implies it when no faction was picked explicitly)
    const fMine = mine.faction ?? (mine.lord ? factionOfLord(mine.lord) : null);
    const fFoe = foe.faction ?? (foe.lord ? factionOfLord(foe.lord) : null);
    this.scene.setFactions(mySeat === 0 ? [fMine, fFoe] : [fFoe, fMine]);
    this.scene.showDeployZone(this.me && !this.me.ready ? mySeat : null);
    this.drawArmy();

    const you = v.you;
    const timed = room.phaseEndsAt > 0;
    const total = Math.max(1, Math.round((room.phaseEndsAt - room.serverNow) / 1000));
    if (newRound) this.timerTotal = total;
    const status = (seat: Seat, ready: boolean): string | undefined => {
      const info = room.seats[seat];
      return info?.botControlled ? 'AI playing' : info && !info.connected ? 'Disconnected' : ready ? undefined : 'Planning…';
    };
    this.top.set(
      { name: this.names[0], lord: mine.lord, hp: mine.keepHp, max: mine.keepMax, ready: mine.ready, status: spect ? status(mySeat, mine.ready) : undefined },
      { name: this.names[1], lord: foe.lord, hp: foe.keepHp, max: foe.keepMax, ready: foe.ready, status: status(foeSeat, foe.ready) },
      v.round, 'Planning', timed ? room.phaseEndsAt - room.serverNow + Date.now() : 0, this.timerTotal ?? total,
    );
    this.root.classList.toggle('is-ready', !!you?.ready);
    this.renderRes();
    this.renderShop();
    this.renderReady();
    this.renderPanel();
    this.renderStash();
    this.renderNotices();
    if (newRound) setTimeout(() => this.intro(), v.round === 1 && room.phase === 'planning' && !this.introDone ? 3300 : 0), (this.introDone = true);
    this.autoModals();
    this.fit();
  }

  /** Auto-opened modals wait `ms` from now (the VS reveal covers the screen first). */
  holdModals(ms: number): void {
    this.modalsAt = performance.now() + ms;
  }

  private timerTotal: number | null = null;
  private introDone = false;

  private intro(): void {
    const v = this.view!;
    const b = el(`<div class="round-banner"><small>${v.round === 1 ? 'The war begins' : 'Prepare for battle'}</small><b>Round ${v.round}</b></div>`);
    this.root.appendChild(b);
    sound.whoosh();
    setTimeout(() => b.remove(), 2600);
  }

  private autoModals(): void {
    const me = this.me;
    if (!me || me.ready) return;
    const dk = me.draftOptions.join(',') + ':' + me.draftPicks + ':' + this.round;
    if (me.draftPicks > 0 && me.draftOptions.length && dk !== this.draftSeen && !this.loot) {
      this.draftSeen = dk;
      setTimeout(() => this.openDraft(true), Math.max(this.round === 1 ? 900 : 1600, this.modalsAt - performance.now() + 400));
      return;
    }
    if (this.draft && (me.draftPicks === 0 || !me.draftOptions.length)) this.closeDraft();
    else if (this.draft && this.draft.key !== draftKey(me, this.round)) this.openDraft();
    const lk = me.lootOffer ? me.lootOffer.map((i) => i.id).join(',') : '';
    if (lk && lk !== this.lootSeen && !this.draft) {
      this.lootSeen = lk;
      setTimeout(() => this.openLoot(), Math.max(1500, this.modalsAt - performance.now() + 400));
    }
    if (!lk && this.loot) this.closeLoot();
  }

  openLoot(): void {
    const me = this.me;
    if (!me?.lootOffer || this.loot) return;
    this.cancelDrag();
    this.loot = new LootModal(this.root, me.lootOffer, me, (i) => this.intent({ t: 'pickLoot', index: i }), () => this.closeLoot());
  }
  private closeLoot(): void {
    this.loot?.dispose();
    this.loot = null;
    this.renderNotices();
    if (this.me?.draftPicks && !this.draft) this.openDraft();
  }
  /** `fresh` = the draft just appeared: it announces itself (sting + "New recruits!" ribbon). */
  openDraft(fresh = false): void {
    const me = this.me;
    if (!me || !me.draftPicks || !me.draftOptions.length) return;
    const key = draftKey(me, this.round);
    // the same draft re-rendered (a snapshot update) is not news
    const news = fresh || (this.draft === null && this.draftAnnounced !== key);
    this.draftAnnounced = key;
    this.draft?.dispose();
    this.draft = new DraftModal(this.root, me, this.round, (u) => {
      this.intent({ t: 'draft', unit: u });
      toast(`${UNITS[u].name} unlocked`, 'good');
    }, () => this.closeDraft(), news, canMuster(me, this.round) ? () => this.takeMuster() : null);
  }

  /** Muster (DESIGN §2), instead of the round's unit unlock: relocations for this round's locked squads. */
  private takeMuster(): void {
    const me = this.me;
    if (!me || !canMuster(me, this.round)) return this.refuse(me?.muster ? 'Muster is already called this round' : 'Muster is not on offer now');
    sound.horn();
    this.intent({ t: 'muster' });
    toast(`Muster: relocate up to ${MUSTER_MOVES} of your locked squads this round`, 'good', 2600);
  }
  private draftAnnounced = '';
  private closeDraft(): void {
    this.draft?.dispose();
    this.draft = null;
    this.renderNotices();
    const lk = this.me?.lootOffer ? this.me.lootOffer.map((i) => i.id).join(',') : '';
    if (lk && !this.loot && this.lootSeen !== lk) {
      this.lootSeen = lk;
      setTimeout(() => this.openLoot(), 300);
    }
  }

  private intent(i: Intent): void {
    this.backend.intent(i);
  }

  /** The server refused an intent: the action just recorded for undo did not happen, and shown moves snap back. */
  rejected(e: string): void {
    const last = this.undos[this.undos.length - 1];
    if (last && performance.now() - last.at < 1500) this.undos.pop();
    this.pend.clear();
    this.refuse(e);
    this.syncRange();
  }

  /** Refused here, before anything was sent. */
  private refuse(e: string): void {
    sound.error();
    toast(niceError(e), 'bad');
    if (/deploy/.test(e)) this.shake('.deploy-badge');
    if (/gold/.test(e)) this.shake('.r-gold');
    this.drawArmy();
  }

  private shake(sel: string): void {
    this.root.querySelectorAll(sel).forEach((n) => {
      n.classList.remove('shake');
      void (n as HTMLElement).offsetWidth;
      n.classList.add('shake');
    });
  }

  // ---------------------------------------------------------------- scene

  /** My squads as drawn: a group being dragged where it would land, moves just sent where they will be. */
  private squadsShown(): Squad[] {
    const me = this.me;
    if (!me) return [];
    const live = this.drag?.kind === 'group' && this.drag.moved ? this.drag.out : null;
    return me.squads.map((s) => {
      const p = live?.get(s.id) ?? this.pend.get(s.id);
      return p ? { ...s, pos: p.pos, facing: p.facing } : s;
    });
  }

  /** Where one of my squads stands as far as the player can tell (pending moves included). */
  private shownSquad(id: number | null): Squad | null {
    return id === null ? null : (this.squadsShown().find((s) => s.id === id) ?? null);
  }

  /** Me for the relocation rule (src/ui/relocation.ts): my squads where they are shown, pending moves included. */
  private relocMe(): RelocMe | null {
    const me = this.me;
    return me ? { lastArmy: me.lastArmy, moveLimit: me.moveLimit, muster: me.muster, squads: this.squadsShown() } : null;
  }

  private drawArmy(): void {
    const v = this.view;
    if (!v) return;
    if (this.me) this.scene.setArmy(this.squadsShown().map((s) => visual(s, this.me!.lord)));
    else {
      // spectator: both last armies, solid
      const all = (v.enemies ?? [v.enemy]).flatMap((e) => (e.lastArmy ?? []).map((s) => visual(s, e.lord)));
      this.scene.setArmy(all);
    }
    const ghosts = this.me && v.enemy.lastArmy ? v.enemy.lastArmy.map((s) => visual(s, v.enemy.lord)) : null;
    this.scene.setGhosts(ghosts);
    this.syncSelection();
    this.renderTiming();
    this.renderTools();
    this.renderNotices();
  }

  private syncSelection(): void {
    if (this.ghostSel !== null || !this.scene.setSelection) this.scene.setSelected(this.selected ?? this.ghostSel);
    else this.scene.setSelection([...this.sel]);
  }

  /** Tab / Shift+Tab: select the next / previous of my squads (the Lord first, then left to right, front to back). */
  private cycleSquad(dir: 1 | -1): void {
    const me = this.me;
    if (!me || !me.squads.length) return;
    const fwd = this.seat === 0 ? 1 : -1;
    const order = [...me.squads].sort((a, b) => (a.type === 'lord' ? -1 : b.type === 'lord' ? 1 : (a.pos[0] - b.pos[0]) * fwd || (b.pos[1] - a.pos[1]) * fwd || a.id - b.id));
    const i = order.findIndex((q) => q.id === this.selected);
    const next = order[i < 0 ? (dir > 0 ? 0 : order.length - 1) : (i + dir + order.length) % order.length]!;
    sound.click();
    this.select(next.id);
  }

  // ---------------------------------------------------------------- panels

  private renderRes(): void {
    const me = this.me;
    if (!me) {
      this.res.classList.add('spect');
      return;
    }
    const left = Math.max(0, me.deployLimit - me.deploysUsed);
    $(this.res, '.r-gold b').textContent = num(me.gold);
    const army = me.squads.filter((s) => s.type !== 'lord').length;
    $(this.res, '.r-army b').textContent = `${army}/${ARMY_CAP}`;
    const g = $(this.res, '.r-ghost');
    const has = !!this.view?.enemy.lastArmy;
    g.classList.toggle('on', has);
    g.classList.toggle('na', !has);
    $(g, 'span').textContent = has ? 'Enemy positions: last round' : 'No intel until round 2';
    g.dataset.tip = has ? GHOST_TIP : GHOST_TIP_NONE;
    const badge = $(this.root, '.deploy-badge');
    // deploy points, as the sim counts them: "3 of 4 this round"
    $(badge, 'b').textContent = deployPointsText(left);
    $(badge, 'span').textContent = `of ${deployPointsText(me.deployLimit)} this round`;
    badge.classList.toggle('none', left === 0);
  }

  /**
   * The relocation notice at the head of the notices (DESIGN §2): how many squads are locked in place, or, while
   * relocations are available (Muster, relics "of the March"), "Moves left N/M". Empty while nothing of mine is locked.
   */
  private lockNotice(): string {
    const me = this.me;
    const rm = this.relocMe();
    if (!me || !rm) return '';
    const locked = me.squads.filter((q) => squadLocked(q, this.round)).length;
    const moves = (me.moveLimit ?? 0) > 0;
    if (!locked && !moves) return '';
    const c = relocCount(rm, this.round);
    const tipText = moves
      ? `${relocSource(me)}: relocate up to ${c.limit} of your squads from earlier rounds this round (${c.used} used). Moving one back to where it stood frees its move. This round's squads and the Lord move freely.`
      : `Squads deployed in earlier rounds stay where they stand: drag only this round's squads and the Lord. Turning a locked squad is free. Take Muster instead of a unit unlock to relocate up to ${MUSTER_MOVES}.`;
    return moves
      ? `<div class="notice lock-n moves${c.left ? '' : ' none'}" data-tip="${esc(tipText)}">${icon('move')}<span><b>Moves left <em>${c.left}/${c.limit}</em></b><small>${esc(relocSource(me))} · relocate locked squads</small></span></div>`
      : `<div class="notice lock-n" data-tip="${esc(tipText)}">${icon('lock')}<span><b>${locked} locked in place</b><small>Turn freely · Muster to relocate</small></span></div>`;
  }

  /** Why a unit can't be deployed right now, or null. */
  private blocked(u: UnitType): string | null {
    const me = this.me;
    if (!me) return 'Spectating';
    if (me.ready) return 'You are Ready (un-ready to change your army)';
    const dw = deployRefusal(u, me.deploysUsed, me.deployLimit);
    if (dw) return dw;
    if (me.squads.filter((s) => s.type !== 'lord').length >= ARMY_CAP) return `Army is full (${ARMY_CAP} squads)`;
    if (me.gold < UNITS[u].cost) return `Not enough gold (need ${UNITS[u].cost}, have ${me.gold})`;
    return null;
  }

  private renderShop(): void {
    const me = this.me;
    if (!me) {
      const html = `<div class="spect-note">${icon('eye')}<span><b>Spectating</b>The commanders plan in secret. You see each army as it last fought.</span></div>`;
      if (this.shop.innerHTML !== html) this.shop.innerHTML = html;
      return;
    }
    const units = this.shopUnits();
    const key = units.join(',') + '|' + me.gold + '|' + me.deploysUsed + '|' + me.ready + '|' + me.squads.length;
    if (this.shop.dataset.key === key) return;
    this.shop.dataset.key = key;
    this.shop.innerHTML = units
      .map((u, i) => {
        const d = UNITS[u];
        const why = this.blocked(u);
        const k = SHOP_KEYS[i];
        return `<button class="ucard ${why ? 'off' : ''} ${me.gold < d.cost ? 'poor' : ''}" data-u="${u}">
          ${k ? `<kbd>${k}</kbd>` : ''}
          ${crest(u, null, 'md')}
          <b${d.name.length > 13 ? ' class="long"' : ''}>${esc(d.name)}</b>
          <div class="uc-meta"><span class="uc-cost">${icon('gold')}${d.cost}</span><span class="uc-size">×${soldierStats(u, 1).size}</span>${deployChip(u)}</div>
          <div class="uc-tags">${classIcon(u)}<span class="uc-role">${esc(d.role)}</span></div>
          <div class="uc-tagc">${tagIcons(u)}</div>
        </button>`;
      })
      .join('');
    this.shop.style.setProperty('--cols', String(Math.ceil(units.length / 2)));
    this.fitShop();
    this.shop.querySelectorAll<HTMLElement>('.ucard').forEach((c) => {
      const u = c.dataset.u as UnitType;
      tip(c, () => {
        const why = this.blocked(u);
        const k = SHOP_KEYS[units.indexOf(u)];
        return unitTooltip(u, why ? `<div class="it-hint bad">${esc(why)}</div>` : `<div class="it-hint">Drag onto your half, or ${k ? `press ${k}` : 'click'} then click the field. Q/E or right-drag turns it.</div>`, this.me?.lord ?? null);
      });
      c.addEventListener('pointerenter', () => sound.hover());
      c.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        this.startPlace(u, true);
      });
    });
  }

  /** The shop's unit types in card order (cheapest first): the order the hotkeys follow. */
  private shopUnits(): UnitType[] {
    return this.me ? [...this.me.unlocked].sort((a, b) => UNITS[a].cost - UNITS[b].cost) : [];
  }

  /**
   * The shop never overflows the bar or slides under the Deploys badge: full cards while they fit,
   * then compact cards (no role line), then two rows of small cards for a late-game roster.
   */
  private fitShop(): void {
    const n = this.shop.querySelectorAll('.ucard').length;
    if (!n) return;
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    const w = this.shop.clientWidth / rem;
    const mode = n * 7.45 <= w ? 'full' : n * 5.75 <= w ? 'compact' : 'rows2';
    if (this.shop.dataset.mode !== mode) this.shop.dataset.mode = mode;
  }

  private renderReady(): void {
    const me = this.me;
    const v = this.view!;
    if (!me) {
      const html = `<button class="btn stop-watch">${icon('eye')}<span>Stop watching</span></button>`;
      if (this.readyBox.innerHTML !== html) {
        this.readyBox.innerHTML = html;
        $(this.readyBox, '.stop-watch').addEventListener('click', () => this.onLeave?.());
      }
      return;
    }
    const foe = v.enemy.ready;
    this.readyBox.innerHTML = `<button class="ready-btn ${me.ready ? 'on' : ''}" data-tip="${me.ready ? 'Click to make more changes' : 'Lock in your plan [Space]'}">
        ${me.ready ? `${icon('ready')}<span>Ready</span><small>Click to un-ready</small>` : `<span>Ready</span><small>Space</small>`}
      </button>
      <div class="foe-ready ${foe ? 'on' : ''}">${foe ? `${icon('ready')}${esc(this.names[1])} is ready` : `<i class="dots"></i>${esc(this.names[1])} is planning`}</div>`;
    $(this.readyBox, '.ready-btn').addEventListener('click', () => this.toggleReady());
  }

  private toggleReady(): void {
    const me = this.me;
    if (!me) return;
    if (me.ready) {
      sound.click();
      this.intent({ t: 'unready' });
    } else {
      sound.ready();
      playLordLine(me.lord, 'ready');
      this.cancelDrag();
      this.intent({ t: 'ready' });
    }
  }

  private renderNotices(): void {
    const me = this.me;
    let h = '';
    if (me?.lootOffer && !this.loot)
      h += `<button class="notice loot-n r-${me.lootOffer.reduce((b, i) => (rarityRank(i.rarity) > rarityRank(b) ? i.rarity : b), 'common' as Item['rarity'])}">${icon('bag')}<span><b>Spoils of War</b><small>Choose 1 of ${me.lootOffer.length}</small></span></button>`;
    const muster = !!me && canMuster(me, this.round);
    h += this.lockNotice();
    if (me && me.draftPicks > 0 && me.draftOptions.length && !this.draft)
      h += `<button class="notice draft-n">${icon('squads')}<span><b>New recruits!</b><small>${muster ? 'Unlock a unit type, or Muster' : `Unlock ${me.draftPicks} unit type${me.draftPicks > 1 ? 's' : ''}`}</small></span></button>`;
    else if (me && muster && !me.draftOptions.length)
      h += `<button class="notice muster-n" data-tip="Relocate up to ${MUSTER_MOVES} of your squads from earlier rounds this round. Nothing is left to unlock, so it costs nothing.">${icon('move')}<span><b>Muster</b><small>Free: nothing left to unlock</small></span></button>`;
    if (this.onReport && this.round > 1)
      h += `<button class="notice report-n" ${this.reportHint ? `data-tip="${esc(this.reportHint)}"` : ''}>${icon('chart')}<span><b>Battle report</b><small>Round ${this.round - 1}: what happened</small></span></button>`;
    if (this.notices.dataset.h === h) return;
    this.notices.dataset.h = h;
    this.notices.innerHTML = h;
    this.notices.querySelector('.report-n')?.addEventListener('click', () => (sound.click(), this.onReport?.()));
    this.notices.querySelector('.loot-n')?.addEventListener('click', () => (sound.click(), this.openLoot()));
    this.notices.querySelector('.draft-n')?.addEventListener('click', () => (sound.click(), this.openDraft()));
    this.notices.querySelector('.muster-n')?.addEventListener('click', () => this.takeMuster());
  }

  private squad(id: number | null): Squad | null {
    if (id === null) return null;
    return this.me?.squads.find((s) => s.id === id) ?? null;
  }

  private ghost(id: number | null): Squad | null {
    if (id === null) return null;
    return this.view?.enemy.lastArmy?.find((s) => s.id === id) ?? null;
  }

  /** Spectators: a squad of either last-round army, with its side's Lord. */
  private shown(id: number | null): { sq: Squad; lord: LordId | null } | null {
    if (id === null) return null;
    for (const e of this.view?.enemies ?? []) {
      const sq = e.lastArmy?.find((s) => s.id === id);
      if (sq) return { sq, lord: e.lord };
    }
    return null;
  }

  /** Select one squad (`ghost`: one of the enemy's last-round army), several of mine (`many`), or none. */
  private select(id: number | null, ghost = false, many?: number[]): void {
    if (ghost) {
      this.ghostSel = id;
      this.sel.clear();
    } else {
      this.ghostSel = null;
      this.sel = new Set(many ?? (id === null ? [] : [id]));
    }
    this.syncSelection();
    this.syncRange();
    this.renderPanel();
    this.renderTools();
    this.renderTiming();
  }

  /** The range ring (and a Lord's aura ring) of the one selected squad, where it is shown. */
  private syncRange(): void {
    const watched = !this.me ? this.shown(this.ghostSel) : null;
    const ghost = this.ghostSel !== null;
    const sq = watched ? watched.sq : ghost ? this.ghost(this.ghostSel) : this.shownSquad(this.selected);
    if (!sq) return this.scene.setRange(null);
    const lord = sq.type === 'lord' ? (watched ? watched.lord : ghost ? this.view!.enemy.lord : this.me!.lord) : null;
    const s = soldierStats(sq.type, sq.level, lord);
    const aura = lord ? lordAuraRing(LORDS[lord].ability) : null;
    this.scene.setRange({ pos: sq.pos, range: s.range, minRange: s.minRange, enemy: watched ? sq.owner !== this.seat : ghost, aura });
  }

  /**
   * Several squads selected: a compact list (fastest to the river first) with what the group can do
   * together; a row selects that squad alone. No level-up or sell here: those are one squad at a time.
   */
  private renderGroupPanel(): void {
    const me = this.me!;
    const shown = this.squadsShown().filter((q) => this.sel.has(q.id));
    const rows = shown.map((q) => ({ q, m: this.march(q) })).sort((a, b) => (a.m.river?.sec ?? 1e9) - (b.m.river?.sec ?? 1e9) || a.q.id - b.q.id);
    const melee = rows.filter((r) => r.q.type !== 'lord' && !r.m.ranged);
    const times = melee.map((r) => r.m.river?.sec).filter((x): x is number => x !== undefined);
    const spread = times.length >= 2 ? Math.max(...times) - Math.min(...times) : null;
    const lord = me.lord;
    const html = `
      <header class="sp-h"><div class="sp-t"><small>Selection</small><b>${rows.length} squads</b><span class="sp-gsum">${melee.length} melee · ${rows.length - melee.length} ranged or Lord</span></div><button class="icon close" data-tip="Deselect [Esc]">${icon('close')}</button></header>
      <div class="sp-acts grp"><button class="btn primary g-sync" ${me.ready || melee.length < 2 ? 'disabled' : ''} data-tip="Stagger the selected melee squads in depth so they reach the river together: the slowest at the front edge, the fast ones held back.">${icon('sync')}<span>Sync by speed</span></button><button class="btn g-turn" ${me.ready ? 'disabled' : ''} data-tip="Turn the group a quarter about its centre [Shift+E]">${icon('rotate')}<span>Turn</span></button></div>
      ${spread !== null ? `<p class="sp-gnote ${spread <= 1 ? 'good' : ''}">${spread <= 1 ? `Melee reaches the river together, ${Math.max(...times).toFixed(1)} s in` : `Melee reaches the river <b>${spread.toFixed(1)} s</b> apart (${Math.min(...times).toFixed(1)} to ${Math.max(...times).toFixed(1)} s)`}</p>` : ''}
      <div class="sp-sec"><small>March · to the river</small><ul class="sp-glist">${rows
        .map(({ q, m }) => `<li data-id="${q.id}" data-tip="Select only this squad">${crest(q.type, q.type === 'lord' ? lord : null, 'sm')}<span class="gl-n">${esc(unitName(q.type, q.type === 'lord' ? lord : null))}</span><small class="gl-l">${q.type === 'lord' ? '' : `Lv ${q.level}`}</small><small class="gl-s">${m.speed.toFixed(1)} m/s</small><b class="gl-t">${m.river ? `${m.river.sec.toFixed(1)} s` : m.hold ? `hold ${m.hold.sec.toFixed(1)} s` : '–'}</b></li>`)
        .join('')}</ul></div>
      <p class="sp-hint">Drag one to move them all · right-drag or <kbd>Shift</kbd>+<kbd>Q</kbd>/<kbd>E</kbd> turn · <kbd>Shift</kbd>-click add or remove · <kbd>Ctrl</kbd>+<kbd>Z</kbd> undo</p>`;
    if (this.panel.dataset.grp === html) return;
    this.panel.dataset.grp = html;
    this.panel.innerHTML = html;
    this.panel.querySelector('.close')!.addEventListener('click', () => this.select(null));
    this.panel.querySelector('.g-sync')?.addEventListener('click', () => this.syncSpeed());
    this.panel.querySelector('.g-turn')?.addEventListener('click', () => this.turnSelection(-64));
    this.panel.querySelectorAll<HTMLElement>('.sp-glist li').forEach((li) =>
      li.addEventListener('click', () => {
        sound.click();
        this.select(Number(li.dataset.id));
      }),
    );
  }

  private renderPanel(): void {
    const me = this.me;
    if (me && this.sel.size > 1) {
      this.root.classList.add('has-sel');
      return this.renderGroupPanel();
    }
    delete this.panel.dataset.grp;
    // spectators select squads of either last-round army (read-only, like a ghost)
    const watched = !me ? this.shown(this.ghostSel) : null;
    const ghost = this.ghostSel !== null;
    const sq = watched ? watched.sq : ghost ? this.ghost(this.ghostSel) : this.squad(this.selected);
    this.root.classList.toggle('has-sel', !!sq);
    if (!sq) {
      this.panel.innerHTML = '';
      return;
    }
    const lord = sq.type === 'lord' ? (watched ? watched.lord : ghost ? this.view!.enemy.lord : me!.lord) : null;
    const isLord = sq.type === 'lord';
    const name = unitName(sq.type, lord);
    const sub = isLord ? `Lord · ${LORDS[lord!].abilityName}` : `${UNITS[sq.type as UnitType].role}`;
    let lvl = '';
    if (isLord) {
      const xp = me && !ghost ? me.lordXp : 0;
      const next = LORD_XP_LEVELS[sq.level] ?? 0;
      const prev = LORD_XP_LEVELS[sq.level - 1] ?? 0;
      const f = sq.level >= MAX_LORD_LEVEL ? 1 : (xp - prev) / Math.max(1, next - prev);
      lvl = `<div class="sp-xp" data-tip="Lord XP from kills. Levels raise life and damage.">Lv ${sq.level}<div class="xpbar"><i style="width:${Math.max(0, Math.min(1, f)) * 100}%"></i></div><small>${sq.level >= MAX_LORD_LEVEL ? 'Max' : `${xp}/${next} XP`}</small></div>`;
    } else {
      lvl = `<div class="sp-pips" data-tip="Squad level (level ${SLOT_UNLOCK_LEVEL.armor} opens Armor, level ${SLOT_UNLOCK_LEVEL.relic} opens Relic)">${Array.from({ length: MAX_SQUAD_LEVEL }, (_, i) => `<i class="${i < sq.level ? 'on' : ''}"></i>`).join('')}<small>Lv ${sq.level}</small></div>`;
    }
    let actions = '';
    if (!ghost && me && !isLord) {
      const maxed = sq.level >= MAX_SQUAD_LEVEL;
      const cost = maxed ? 0 : levelUpCost(sq.type as UnitType, sq.level);
      const can = !maxed && me.gold >= cost && !me.ready;
      const refund = sellRefund(sq, this.round);
      const armed = this.sellArmed?.id === sq.id && this.sellArmed.until > performance.now();
      const opens = sq.level + 1 === SLOT_UNLOCK_LEVEL.armor ? ', opens the Armor slot' : sq.level + 1 === SLOT_UNLOCK_LEVEL.relic ? ', opens the Relic slot' : '';
      const whyNot = maxed ? 'Max level' : me.ready ? 'You are Ready: un-ready to make changes' : me.gold < cost ? `Not enough gold (need ${cost}, have ${me.gold})` : '';
      actions = `<div class="sp-acts">
        <button class="btn primary lvl" ${can ? '' : 'disabled'} data-tip="${maxed ? 'Max level' : `${levelGainText(sq.type as UnitType, sq.level)}${opens} [U]${whyNot ? '. ' + whyNot : ''}`}">
          ${icon('up')}<span>${maxed ? 'Max level' : `Level ${sq.level + 1}`}</span>${maxed ? '' : `<em>${icon('gold')}${cost}</em>`}</button>
        <button class="btn danger sell ${armed ? 'armed' : ''}" ${me.ready ? 'disabled' : ''} data-tip="${refund ? 'Refunds 100%: a sale in the round it was deployed is an undo. Items go to your stash.' : 'No refund: this squad was deployed in an earlier round. Items go to your stash.'} Press twice to confirm. [Del]">${icon('sell')}<span>${armed ? 'Confirm' : 'Sell'}</span><em>${refund ? `+${refund}` : '0'}</em></button>
      </div>`;
    }
    const slots = SLOTS.map((slot) => {
      const it = sq.items[slot];
      const open = slotOpen(sq, slot);
      const lockLv = open ? 0 : SLOT_UNLOCK_LEVEL[slot];
      const wasted = it ? deadSummary(it, { type: sq.type, lord }) : null;
      return `<div class="sp-slot ${open ? '' : 'locked'} ${wasted ? 'wasted' : ''}" data-squad="${sq.id}" data-sslot="${slot}">${itemIcon(it, { slot, locked: lockLv, drag: !ghost && !!it, size: 'md' })}<small>${SLOT_LABEL[slot]}</small></div>`;
    }).join('');
    const def = isLord ? null : UNITS[sq.type as UnitType];
    // the sim's sheet: stats after level, items and the Lord's passive, next to the level-1 base
    const ownerLord = watched ? watched.lord : ghost ? this.view!.enemy.lord : me!.lord;
    const sheet = this.view ? squadSheet(this.view, sq.id) : null;
    // the same numbers as every tooltip and card (effectiveStats reads the sim: items, Lord passive, power, damage scale)
    const s = effectiveStats(sq, ownerLord);
    const brief = `${icon('heart')}${s.hp} ${icon('sword')}${s.dps.toFixed(1)} ${icon('bow')}${s.range >= 400 ? (s.range / 100).toFixed(0) + ' m' : 'melee'}`;
    const squadDps = s.squadDps;
    // everything the squad can do: innate traits (or the Lord's passive and ability) and what its items grant
    const skills = sheet?.skills ?? squadSkills(sq, ownerLord);
    const worn = SLOTS.map((slot) => sq.items[slot]);
    // the full stat table is one click away; open by default only where the screen has the room
    const pref = store.get('spstats');
    const statsOpen = pref ? pref === '1' : innerHeight >= 900;
    const scroll = this.panel.scrollTop;
    this.panel.innerHTML = `
      <header class="sp-h">${crest(sq.type, lord, 'lg')}<div class="sp-t"><small>${watched ? `${esc(this.names[sq.owner === this.seat ? 0 : 1])} · last round` : ghost ? 'Enemy · last round' : sub}</small><b>${esc(name)}</b>${lvl}</div><button class="icon close" data-tip="Deselect [Esc]">${icon('close')}</button></header>
      ${this.lockLine(sq, ghost, watched)}
      ${actions}
      <div class="sp-row"><div class="sp-sec"><small>Equipment</small><div class="sp-slots">${slots}</div></div>${skills.length ? `<div class="sp-sec sk-d"><small>Abilities</small><div class="sp-skills">${skillChips(skills, worn)}</div></div>` : ''}${def?.traits?.includes('healer') ? '<p class="sp-note">Healers never attack: damage, critical and leech lines do nothing here. Life, haste and range still help.</p>' : ''}</div>
      <details class="sp-sec st-d" ${statsOpen ? 'open' : ''}><summary><span data-tip="Stats of one soldier, after level and items">Stats${!isLord ? ` · squad DPS ${squadDps}` : ''}</span><span class="sp-brief">${brief}</span></summary>${sheet ? sheetStats(sheet) : statBlock(sq.type, sq.level, ownerLord)}</details>
      ${isLord ? `<div class="sp-sec lt"><div class="lt-pass"><small>Passive</small>${esc(LORDS[lord!].passive)}</div><div class="lt-abil"><small>${esc(LORDS[lord!].abilityName)}</small>${esc(LORDS[lord!].abilityText)}</div></div>` : ''}
      ${def ? `<div class="sp-sec ctr-d"><small>Counters</small>${countersBlock(def.id)}</div>` : ''}
      ${!ghost && me ? `${this.marchLine(sq)}<p class="sp-hint">${this.lockedNow(sq.id) ? 'Locked: turn only' : 'Drag on the field to move'} · <kbd>Shift</kbd>+<kbd>Q</kbd>/<kbd>E</kbd> turn · <kbd>Shift</kbd>-click another to group</p>` : ''}`;
    this.panel.querySelector('.close')!.addEventListener('click', () => this.select(null));
    this.panel.querySelector('.lvl')?.addEventListener('click', () => this.levelUp());
    this.panel.querySelector('.sell')?.addEventListener('click', () => this.sell());
    // (the event also fires for a table rendered open, so only a change counts: open, or closed again)
    let wasOpen = statsOpen;
    this.panel.querySelector('.st-d')?.addEventListener('toggle', (e) => {
      const open = (e.target as HTMLDetailsElement).open;
      if (open === wasOpen) return;
      wasOpen = open;
      store.set('spstats', open ? '1' : '0');
    });
    this.panel.querySelectorAll<HTMLElement>('.sk-chip').forEach((n) => {
      const k = skills[Number(n.dataset.sk)];
      if (k) tip(n, () => skillTooltip(k, k.item !== undefined ? worn.find((x) => x?.id === k.item) : null));
    });
    // a re-render (every snapshot) keeps the reader's place
    this.panel.scrollTop = scroll;
    this.panel.querySelectorAll<HTMLElement>('.sp-slot').forEach((slotEl) => {
      const slot = slotEl.dataset.sslot as Slot;
      const it = sq.items[slot];
      if (it) tip(slotEl, () => itemTooltip(it, { hint: ghost || !me ? undefined : 'Drag to another squad or to the stash', on: { type: sq.type, lord } }));
    });
  }

  /** Is my squad `id` locked so that a drag would be refused now (no relocation for it)? */
  private lockedNow(id: number): boolean {
    const rm = this.relocMe();
    return !!rm && dragRefusal(rm, id, this.round) !== null;
  }

  /**
   * The relocation line on the squad panel (DESIGN §2): locked in place, movable with a Muster relocation, relocated,
   * or free this round; on an enemy ghost, the intel marks (moved since the round before, new last round).
   */
  private lockLine(sq: Squad, ghost: boolean, watched: { sq: Squad; lord: LordId | null } | null): string {
    const v = this.view;
    if (!v) return '';
    if (ghost || watched) {
      const from = watched ? (v.enemies ?? []).find((e) => e.seat === sq.owner) : v.enemy;
      const m = ghostMark(sq, from?.lastMoved, v.round);
      return m ? `<p class="sp-lock foe ${m}" data-tip="${m === 'moved' ? 'This squad stood somewhere else in the battle before last: its side took Muster to relocate it.' : 'Deployed last round: from now on it stays where it stands unless its side Musters.'}">${icon(m === 'moved' ? 'move' : 'star')}<span>${GHOST_MARK_TEXT[m]}</span></p>` : '';
    }
    const rm = this.relocMe();
    if (!rm) return '';
    const shown = rm.squads.find((q) => q.id === sq.id) ?? sq;
    const st = lockState(rm, shown, this.round);
    if (st === 'free') return sq.type === 'lord' ? '' : `<p class="sp-lock free" data-tip="Squads deployed this round move freely until the battle. From next round on it is locked in place.">${icon('move')}<span>Free to move this round</span></p>`;
    if (st === 'relocated') return `<p class="sp-lock reloc" data-tip="Moved with a Muster relocation. Drag it back to where it stood (the line marked home) to free the move.">${icon('move')}<span>Relocated · move it back to free the move</span></p>`;
    const c = relocCount(rm, this.round);
    if (c.left > 0) return `<p class="sp-lock open" data-tip="${esc(`Locked in place since round ${sq.deployedRound}. Muster: you may relocate it (${c.left} of ${c.limit} moves left).`)}">${icon('lock')}<span>Locked · Muster: <b>${c.left}/${c.limit}</b> moves left</span></p>`;
    return `<p class="sp-lock locked" data-tip="${esc(c.limit > 0 ? `All ${c.limit} relocations used: move one back to free a move. Turning is free.` : lockedText(sq))}">${icon('lock')}<span>Locked in place since round ${sq.deployedRound}${c.limit > 0 ? ' · no moves left' : ' · turn only'}</span></p>`;
  }

  /** One line on the squad panel: its march speed and when it reaches the river and the enemy's front. */
  private marchLine(sq: Squad): string {
    if (!this.view) return '';
    const m = this.march(this.shownSquad(sq.id) ?? sq);
    const parts = [`${m.speed.toFixed(1)} m/s${m.flier ? ', flies' : ''}`];
    if (m.river) parts.push(`river <b>${m.river.sec.toFixed(1)} s</b>`);
    if (m.front) parts.push(`their front ${m.front.sec.toFixed(1)} s`);
    else if (m.hold) parts.push(`in range ${m.hold.sec.toFixed(1)} s`);
    return `<p class="sp-march" data-tip="The march if the enemy stood where it stood last round: open-ground speed, then seconds to the river and to the enemy's last front line (terrain, crossings and the squad's target included). Press T for every route.">${icon('route')}<span>${parts.join(' · ')}</span></p>`;
  }

  private levelUp(): void {
    const sq = this.squad(this.selected);
    if (!sq || sq.type === 'lord') return;
    sound.levelUp();
    this.intent({ t: 'levelUp', squad: sq.id });
  }

  /** Selling is permanent, so it takes two presses (button or Del) within a few seconds. */
  private sell(): void {
    const sq = this.squad(this.selected);
    const me = this.me;
    if (!sq || !me || sq.type === 'lord' || me.ready) return;
    const now = performance.now();
    if (this.sellArmed?.id !== sq.id || this.sellArmed.until < now) {
      this.sellArmed = { id: sq.id, until: now + 4000 };
      sound.click();
      const refund = sellRefund(sq, this.round);
      toast(`Sell ${UNITS[sq.type as UnitType].name} for ${refund ? `+${refund} gold` : 'no refund'}? Press Del again or click Confirm.`, 'info', 3600);
      this.renderPanel();
      setTimeout(() => {
        if (this.sellArmed && this.sellArmed.until <= performance.now()) {
          this.sellArmed = null;
          this.renderPanel();
        }
      }, 4050);
      return;
    }
    this.sellArmed = null;
    sound.coin();
    this.intent({ t: 'sell', squad: sq.id });
    this.select(null);
  }

  private stashOpen(): boolean {
    return this.stash.classList.contains('open');
  }

  /** Open or close the stash flyout. `auto`: opened for an item drag only, closed again when it ends. */
  private openStash(open: boolean, auto = false): void {
    this.stash.classList.toggle('open', open);
    this.stash.classList.toggle('auto', open && auto);
    $(this.stash, '.stash-tab').setAttribute('aria-expanded', String(open));
    if (!auto) store.set('plan.stash', open ? '1' : '0');
  }

  /** Item ids the stash held at the last render (null before the first): a new one opens the flyout. */
  private stashSeen: Set<number> | null = null;

  private renderStash(): void {
    const me = this.me;
    if (!me) {
      this.stash.classList.add('hidden');
      return;
    }
    const items = [...me.stash].sort((a, b) => rarityRank(b.rarity) - rarityRank(a.rarity));
    // fresh loot opens the stash so it can be equipped (and the tutorial can point at it); the player's
    // own choice, open or closed, is kept otherwise
    const seen = this.stashSeen;
    const gained = !!seen && items.some((i) => !seen.has(i.id));
    if (!seen) this.openStash(store.get('plan.stash') === '1' && items.length > 0);
    else if (gained) this.openStash(true);
    this.stashSeen = new Set(items.map((i) => i.id));
    this.stash.classList.toggle('empty', !items.length);
    const badge = $(this.stash, '.stash-tab .badge');
    badge.textContent = items.length ? String(items.length) : '';
    badge.classList.toggle('on', items.length > 0);
    $(this.stash, '.stash-tab').dataset.tip = items.length ? `Stash: ${items.length} item${items.length === 1 ? '' : 's'} to equip [B]` : 'Stash: empty. Loot you claim lands here [B]';
    $(this.stash, 'header small').textContent = items.length ? String(items.length) : 'empty';
    const grid = $(this.stash, '.stash-grid');
    grid.innerHTML = items.length ? items.map((it) => itemIcon(it, { drag: true, size: 'md' })).join('') : '<p class="muted">Loot you claim lands here.</p>';
    grid.querySelectorAll<HTMLElement>('[data-item]').forEach((n) => {
      const it = items.find((i) => i.id === Number(n.dataset.item))!;
      tip(n, () => {
        const sel = this.squad(this.selected);
        if (sel && slotOpen(sel, it.slot)) return itemTooltipPair(it, sel.items[it.slot], `Click to equip on ${unitName(sel.type, this.me!.lord)}`, { type: sel.type, lord: this.me!.lord });
        if (sel) return itemTooltip(it, { hint: `${unitName(sel.type, this.me!.lord)}: ${slotLockText(it.slot)}`, on: { type: sel.type, lord: this.me!.lord } });
        return itemTooltip(it, { hint: 'Drag onto a squad to equip, or select a squad and click' });
      });
    });
  }

  // ---------------------------------------------------------------- formation tools, undo

  /** Grid snap in cm (0 = off; 50 or 100), shared with the settings popover. */
  private snapStep(): number {
    const v = Number(store.get('plan.snap') ?? 0);
    return v === 50 || v === 100 ? v : 0;
  }

  private toggleSnap(): void {
    const on = this.snapStep();
    const last = Number(store.get('plan.snapLast') ?? 100) === 50 ? 50 : 100;
    store.set('plan.snap', String(on ? 0 : last));
    if (on) store.set('plan.snapLast', String(on));
    sound.click();
    toast(on ? 'Grid snap off' : `Grid snap ${last === 50 ? '0.5' : '1'} m`, 'info', 1300);
    this.renderTools();
    if (this.drag) this.preview();
  }

  private toggleRoutes(): void {
    this.routesOn = !this.routesOn;
    store.set('plan.routes', this.routesOn ? '1' : '0');
    sound.click();
    this.renderTools();
    this.renderTiming();
  }

  private pushUndo(label: string, undo: () => boolean, key?: string): void {
    this.undos.push({ label, at: performance.now(), undo, key });
    if (this.undos.length > UNDO_MAX) this.undos.shift();
    this.renderTools();
  }

  /**
   * Move squads to `targets`: the intents go out in an order the server accepts one by one (see
   * planMoves), the squads are drawn there at once, and (unless this is itself an undo) the old spots
   * are remembered.
   */
  private moveSquads(targets: Map<number, Placed>, label: string | null): boolean {
    const me = this.me;
    if (!me || me.ready) return false;
    const shown = this.squadsShown();
    const before = new Map<number, Placed>();
    for (const id of targets.keys()) {
      const sq = shown.find((q) => q.id === id);
      if (sq) before.set(id, { pos: sq.pos, facing: sq.facing });
    }
    // relocation (DESIGN §2): never show or send a state the server refuses (too many locked squads moved)
    const rm = this.relocMe()!;
    const no = targetsRefusal(rm, targets, this.round);
    if (no) {
      this.refuse(no);
      return false;
    }
    const intents = planMoves(shown, targets, this.seat, { me: rm, round: this.round });
    if (!intents.length) return false;
    if (label) {
      const key = label + ':' + [...before.keys()].sort((a, b) => a - b).join(',');
      const last = this.undos[this.undos.length - 1];
      // turning the same squads a few steps in a row is one action to undo
      if (last && last.key === key && /^turn/.test(label) && performance.now() - last.at < 2500) last.at = performance.now();
      else this.pushUndo(label, () => this.moveSquads(new Map([...before].filter(([id]) => this.squad(id))), null), key);
    }
    for (const [id, t] of targets) if (before.has(id)) this.pend.set(id, t);
    this.drawArmy();
    this.syncRange();
    for (const i of intents) this.intent(i);
    return true;
  }

  private undo(): void {
    const me = this.me;
    if (!me) return;
    if (me.ready) return this.refuse('You are Ready: un-ready to make changes');
    if (this.drag) this.endDrag();
    const e = this.undos.pop();
    if (!e) {
      sound.error();
      toast('Nothing to undo this round', 'info', 1500);
    } else if (!e.undo()) toast(`Nothing left to undo for: ${e.label}`, 'info', 1800);
    else {
      sound.click();
      toast(`Undone: ${e.label}`, 'info', 1300);
    }
    this.renderTools();
  }

  /** Remember a deploy: undoing it sells the new squad in the same round (a refund). */
  private undoDeploy(u: UnitType): void {
    const before = new Set(this.me?.squads.map((s) => s.id) ?? []);
    const round = this.round;
    this.pushUndo(`deploy ${UNITS[u].name}`, () => {
      const sq = this.me?.squads.find((s) => !before.has(s.id) && s.type === u && s.deployedRound === round);
      if (!sq) return false;
      this.pend.delete(sq.id);
      if (this.sel.has(sq.id)) {
        this.sel.delete(sq.id);
        this.select(this.sel.size === 1 ? this.selected : null, false, [...this.sel]);
      }
      sound.coin();
      this.intent({ t: 'sell', squad: sq.id });
      return true;
    });
  }

  /** Remember an item move: `from` / `to` are squads (null = the stash). */
  private undoItem(item: Item, from: number | null, to: number | null): void {
    const prev = to !== null ? (this.squad(to)?.items[item.slot]?.id ?? null) : null;
    this.pushUndo(to === null ? 'unequip' : 'equip', () => {
      const me = this.me;
      if (!me) return false;
      const out: Intent[] = [];
      if (to === null) {
        if (from === null || !this.squad(from)) return false;
        out.push({ t: 'equip', item: item.id, squad: from });
      } else {
        out.push(from === null || !this.squad(from) ? { t: 'unequip', item: item.id } : { t: 'moveItem', item: item.id, squad: from });
        if (prev !== null && this.squad(to)) out.push({ t: 'equip', item: prev, squad: to });
      }
      sound.equip();
      for (const i of out) this.intent(i);
      return true;
    });
  }

  /**
   * Mirror the army left-right inside the zone: what may move (the Lord, this round's squads and relocated ones).
   * Squads locked in place stay where they are, and the mirrored ones settle around them.
   */
  private mirror(): void {
    const me = this.me;
    if (!me || me.ready) return;
    if (this.drag) this.endDrag();
    const shown = this.squadsShown();
    if (!shown.length) return;
    const rm = this.relocMe()!;
    const free = mirrorable(rm, this.round);
    const stay = shown.length - free.length;
    if (stay && !free.some((q) => q.type !== 'lord')) return this.refuse(`Nothing to mirror: your squads from earlier rounds are locked in place. Take Muster instead of a unit unlock to relocate up to ${MUSTER_MOVES}.`);
    let out = mirrorPlace(free, this.seat);
    if (stay) {
      const ids = new Set(free.map((q) => q.id));
      const fwd = this.seat === 0 ? 1 : -1;
      const order = [...free].sort((p, q) => (q.pos[1] - p.pos[1]) * fwd || p.id - q.id);
      const settled = settle(order, out, shown.filter((q) => !ids.has(q.id)), this.seat);
      if (!settled) return this.refuse('No room to mirror around the locked squads');
      out = settled;
    }
    if (this.moveSquads(out, 'mirror formation')) {
      sound.drop();
      toast(stay ? `Mirrored ${free.length} squad${free.length === 1 ? '' : 's'}; ${stay} locked in place stay${stay === 1 ? 's' : ''}` : 'Formation mirrored', 'info', stay ? 2200 : 1200);
    }
  }

  /**
   * Sync by speed: the selected melee squads (all of them when fewer than two are selected) are staggered
   * in depth so they reach the river together, the slowest at the front edge.
   */
  private syncSpeed(): void {
    const me = this.me;
    const v = this.view;
    if (!me || !v || me.ready) return;
    if (this.drag) this.endDrag();
    const shown = this.squadsShown();
    const melee = (sq: Squad) => sq.type !== 'lord' && !this.march(sq).ranged;
    const picked = this.sel.size >= 2 ? shown.filter((q) => this.sel.has(q.id)) : shown;
    // relocation (DESIGN §2): squads locked in place keep their spot unless the Muster's moves cover all of them
    const all = picked.filter(melee);
    const rm = this.relocMe()!;
    const pin = pinnedIn(rm, all.map((q) => q.id), this.round);
    const group = all.filter((q) => !pin.has(q.id));
    if (group.length < 2) {
      const left = relocCount(rm, this.round).left;
      if (all.length >= 2 && pin.size) return this.refuse(`Sync needs two or more melee squads free to move: ${pin.size} ${pin.size === 1 ? 'is' : 'are'} locked in place${(me.moveLimit ?? 0) > 0 ? ` and ${left} relocation${left === 1 ? ' is' : 's are'} left` : ` (take Muster instead of a unit unlock to relocate up to ${MUSTER_MOVES})`}`);
      return this.refuse(this.sel.size >= 2 ? 'Sync needs two or more melee squads in the selection' : 'Sync needs two or more melee squads');
    }
    const ids = new Set(group.map((q) => q.id));
    const r = syncBySpeed(group, shown.filter((q) => !ids.has(q.id)), this.seat, me.lord, v.terrain, this.foes, this.snapStep());
    if (!r) return this.refuse('No room to stagger them');
    if (!this.moveSquads(r.spots, 'sync by speed')) {
      toast(`Already in step: they reach the river at ${r.sec.toFixed(1)} s`, 'info', 1800);
      return;
    }
    sound.drop();
    const late = r.early.map((x) => `${unitName(group.find((q) => q.id === x.id)!.type, me.lord)} (${x.sec.toFixed(1)} s early)`);
    const kept = pin.size ? ` ${pin.size} locked in place kept ${pin.size === 1 ? 'its spot' : 'their spots'}.` : '';
    if (late.length) toast(`Staggered for the river at ${r.sec.toFixed(1)} s. Too fast to hold back far enough: ${late.join(', ')}. Keep them on the back edge.${kept}`, 'info', 3600);
    else toast(`${group.length} melee squads now reach the river together, ${r.sec.toFixed(1)} s in.${kept}`, pin.size ? 'info' : 'good', pin.size ? 3000 : 2200);
    this.select(null, false, group.map((q) => q.id));
  }

  /** Turn the selected group (or squad) a step about its centroid, now. */
  private turnSelection(steps: number): void {
    const me = this.me;
    if (!me || me.ready || !this.sel.size) return;
    const shown = this.squadsShown();
    const group = shown.filter((q) => this.sel.has(q.id));
    if (group.length === 1) {
      const sq = group[0]!;
      this.moveSquads(new Map([[sq.id, { pos: sq.pos, facing: (sq.facing + steps + 256) & 255 }]]), 'turn');
      return;
    }
    // a turn never relocates: squads locked in place turn on the spot, the rest turn about their centre
    const out = groupPlace(group, shown.filter((q) => !this.sel.has(q.id)), this.seat, [0, 0], steps, this.snapStep(), this.turnPins(group.map((q) => q.id)));
    if (!out) return this.refuse('No room to turn the group here');
    this.moveSquads(out, 'turn group');
  }

  /** Squads of `ids` locked in place and still where they stood: a group turn turns them on the spot. */
  private turnPins(ids: number[]): Set<number> {
    const rm = this.relocMe();
    if (!rm) return new Set();
    return new Set(ids.filter((id) => {
      const q = rm.squads.find((x) => x.id === id);
      return !!q && lockState(rm, q, this.round) === 'locked';
    }));
  }

  /** The formation bar: undo, mirror, sync, timing routes, grid snap. */
  private renderTools(): void {
    const me = this.me;
    const bar = this.tools;
    if (!me) {
      bar.classList.add('hidden');
      return;
    }
    const snap = this.snapStep();
    const locked = me.squads.some((q) => squadLocked(q, this.round));
    const key = [this.undos.length, this.undos[this.undos.length - 1]?.label, me.ready, this.routesOn, snap, this.sel.size, locked].join('|');
    if (bar.dataset.key === key) return;
    bar.dataset.key = key;
    const last = this.undos[this.undos.length - 1];
    const b = (sel: string) => $<HTMLButtonElement>(bar, sel);
    b('.pt-undo').disabled = !last || me.ready;
    b('.pt-undo').dataset.tip = last ? `Undo: ${last.label} [Ctrl+Z]` : 'Undo the last move, turn, deploy or equip of this round [Ctrl+Z]';
    b('.pt-mirror').disabled = me.ready;
    b('.pt-mirror').dataset.tip = locked
      ? "Mirror left to right what may move: the Lord, this round's squads and relocated ones. Squads locked in place stay."
      : 'Mirror your whole formation left to right';
    b('.pt-sync').disabled = me.ready;
    b('.pt-sync').dataset.tip = `Sync by speed: stagger ${this.sel.size >= 2 ? 'the selected' : 'all your'} melee squads in depth so they reach the river together. The slowest stands at the front edge; the fast ones are held back.${locked ? ' Squads locked in place keep their spots unless your Muster moves cover them all.' : ''}`;
    b('.pt-timing').classList.toggle('on', this.routesOn);
    b('.pt-timing').setAttribute('aria-pressed', String(this.routesOn));
    b('.pt-snap').classList.toggle('on', !!snap);
    b('.pt-snap').setAttribute('aria-pressed', String(!!snap));
    $(bar, '.pt-snap small').textContent = snap ? `${snap / 100} m` : 'Snap';
    b('.pt-snap').dataset.tip = snap ? `Grid snap is on (${snap / 100} m): squads land on the grid, so a formation can be rebuilt exactly [G]` : 'Snap placement to a grid, so a formation can be rebuilt exactly [G]. Settings picks 0.5 m or 1 m.';
  }

  // ---------------------------------------------------------------- march preview

  /** The march of one of my squads (cached by type, level, items and spot). */
  private march(sq: Pick<Squad, 'type' | 'level' | 'items' | 'pos'>): March {
    const me = this.me!;
    const v = this.view!;
    const fk = `${v.round}:${v.terrain.seed}:${me.lord}:${(v.enemy.lastArmy ?? []).map((s) => `${s.type}${s.pos[0]},${s.pos[1]}`).join(';')}`;
    if (fk !== this.foesKey) {
      this.foesKey = fk;
      this.foes = marchFoes(v.enemy.lastArmy, v.enemy.lord);
      this.front = frontLine(this.seat, this.foes);
      this.marchCache.clear();
    }
    const key = `${sq.type}|${sq.level}|${itemsKey(sq.items)}|${sq.pos[0]},${sq.pos[1]}`;
    let m = this.marchCache.get(key);
    if (!m) {
      if (this.marchCache.size > 600) this.marchCache.clear();
      m = marchOf(sq, me.lord, this.seat, v.terrain, this.foes, this.front);
      this.marchCache.set(key, m);
    }
    return m;
  }

  /**
   * The march preview: a seconds-to-the-river tag under every plate of mine, and full routes (with the
   * river and enemy-front times) for everything when T is on, or for what is being dragged or placed.
   * Sent to the scene only when something it shows changed.
   */
  private renderTiming(): void {
    const me = this.me;
    if (!me || !this.view || !this.scene.setTiming) return;
    const d = this.drag;
    const shown = this.squadsShown();
    const moving = !!d && (d.kind === 'place' ? d.moved || !d.fromShop : d.moved);
    const hot = new Set<number>(d?.kind === 'group' && d.moved ? d.ids : d?.kind === 'move' && d.moved ? [d.id] : []);
    const spec: TimingSpec = { tags: [], routes: [] };
    const route = (m: March, isHot: boolean) => {
      const marks: TimingSpec['routes'][number]['marks'] = [];
      if (m.river) marks.push({ pos: m.river.pos, text: `${m.river.sec.toFixed(1)}s` });
      if (m.front) marks.push({ pos: m.front.pos, text: `${m.front.sec.toFixed(1)}s`, dim: true });
      else if (m.hold) marks.push({ pos: m.hold.pos, text: `in range ${m.hold.sec.toFixed(1)}s`, dim: true });
      spec.routes.push({ pts: m.pts, hot: isHot, marks });
    };
    // relocation (DESIGN §2): a mark at the left of each tag: locked in place, movable with a Muster move, relocated
    const rm = this.relocMe()!;
    const left = relocCount(rm, this.round).left;
    const badgeOf = (sq: Squad): TagBadge | undefined => {
      const st = lockState(rm, sq, this.round);
      return st === 'relocated' ? 'reloc' : st === 'locked' ? (left > 0 ? 'open' : 'lock') : undefined;
    };
    for (const sq of shown) {
      // the single squad being dragged is drawn as the preview, where it would land
      const pos = d?.kind === 'move' && d.id === sq.id && d.moved ? this.dragSpot : sq.pos;
      if (!pos) continue;
      const m = this.march({ ...sq, pos });
      const sec = m.river?.sec ?? m.hold?.sec ?? null;
      const badge = badgeOf(sq);
      if (sec !== null || badge) spec.tags.push({ id: sq.id, pos, text: sec === null ? '' : m.river ? `${sec.toFixed(1)}s` : `hold ${sec.toFixed(1)}s`, hot: hot.has(sq.id), ...(badge ? { badge } : {}) });
      if (this.routesOn || hot.has(sq.id)) route(m, hot.has(sq.id));
      // a relocated squad: a faint line back to where it stood, so it can be put back (which frees the move)
      const home = badge === 'reloc' ? squadHome(rm, sq.id) : null;
      if (home) spec.routes.push({ pts: [home, pos], marks: [{ pos: home, text: 'home', dim: true }] });
    }
    // enemy intel on the ghosts: moved since the round before, or new last round
    const v = this.view;
    for (const g of v.enemy.lastArmy ?? []) {
      const mark = ghostMark(g, v.enemy.lastMoved, v.round);
      if (mark) spec.tags.push({ id: g.id, pos: g.pos, text: mark === 'moved' ? 'Moved' : 'New', badge: mark });
    }
    if (d?.kind === 'place' && moving && this.dragSpot) route(this.march({ type: d.unit, level: 1, items: { weapon: null, armor: null, relic: null }, pos: this.dragSpot }), true);
    const key = JSON.stringify(spec);
    if (key === this.timingKey) return;
    this.timingKey = key;
    this.scene.setTiming(spec.tags.length || spec.routes.length ? spec : null);
  }
  /** Where the single squad being dragged or placed would land (null: nowhere legal). */
  private dragSpot: Vec2 | null = null;

  // ---------------------------------------------------------------- input

  private bind(): void {
    const c = this.scene.canvas;
    const on = <K extends keyof WindowEventMap>(t: EventTarget, k: K | string, f: (e: never) => void, o?: AddEventListenerOptions) => {
      t.addEventListener(k, f as EventListener, o);
      this.off.push(() => t.removeEventListener(k, f as EventListener, o));
    };
    // capture phase on window: the UI sees canvas presses and keys before the camera does
    on(window, 'pointerdown', (e: PointerEvent) => e.target === c && this.down(e), { capture: true });
    this.scene.setPointerClaim((e) => this.claims(e));
    this.fit();
    on(window, 'resize', () => this.fit());
    // the bottom bar changes height with the shop's layout (one row, two rows)
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => this.fit());
      ro.observe($(this.root, '.bottom'));
      this.off.push(() => ro.disconnect());
    }
    on(window, 'pointermove', (e: PointerEvent) => this.move(e));
    on(window, 'pointerup', (e: PointerEvent) => this.up(e));
    on(window, 'keydown', (e: KeyboardEvent) => this.key(e), { capture: true });
    on(window, 'oathbound:snap', () => this.renderTools());
    on(c, 'pointerleave', () => {
      if (!this.drag && !this.itemDrag) {
        this.scene.setHovered(null);
        showTipAt(0, 0, null);
      }
    });
    // items: drag from the stash or a slot
    on(this.root, 'pointerdown', (e: PointerEvent) => {
      const n = (e.target as HTMLElement).closest<HTMLElement>('[data-drag][data-item]');
      if (!n || e.button !== 0 || !this.me) return;
      const id = Number(n.dataset.item);
      const found = this.me.stash.find((i) => i.id === id) ?? allItems(this.me.squads).find((x) => x.item.id === id)?.item;
      if (!found) return;
      const from = this.me.squads.find((s) => SLOTS.some((sl) => s.items[sl]?.id === id))?.id ?? null;
      this.itemDrag = { item: found, from, el: null, x: e.clientX, y: e.clientY, started: false };
      e.preventDefault();
    });
  }

  private insets = '';
  /**
   * Tell the renderer how much of the screen the HUD covers: the whole top bar plus the resource
   * strip, and the whole bottom bar, so the home view frames the deploy zone in what is left.
   */
  private fit(): void {
    this.fitShop();
    const top = Math.max(this.root.querySelector('.topbar')?.getBoundingClientRect().bottom ?? 0, this.res.getBoundingClientRect().bottom || 0);
    const bottom = Math.max(0, innerHeight - $(this.root, '.bottom').getBoundingClientRect().top);
    const key = `${Math.round(top)}:${Math.round(bottom)}:${innerWidth}:${innerHeight}`;
    if (key === this.insets) return;
    const resized = this.insets !== '' && !this.insets.endsWith(`:${innerWidth}:${innerHeight}`);
    this.insets = key;
    this.scene.setInsets({ top: Math.round(top), bottom: Math.round(bottom) });
    // frame the deploy zone once the bars have their real size (they are empty when the screen
    // is built), and again after a window resize unless the player has moved the camera
    if (this.view && (!this.framed || (resized && !this.cameraTouched))) {
      this.framed = true;
      this.scene.resetCamera?.();
    }
  }
  private framed = false;
  /** The player has moved the camera this round: leave their framing alone on a resize. */
  private cameraTouched = false;

  private down(e: PointerEvent): void {
    if (e.target === this.scene.canvas) this.cameraTouched = true;
    if (!this.me) {
      // spectators: a click selects a squad of either army (read-only)
      if (e.button === 0) {
        const hit = this.scene.squadAt(e.clientX, e.clientY);
        this.pendingClick = { x: e.clientX, y: e.clientY, ghost: hit ? hit.id : null };
      }
      return;
    }
    const d = this.drag;
    if (e.button === 2 && d) {
      // right-drag aims the squad, or turns the group about its centre (and not the camera)
      e.stopPropagation();
      if (d.kind === 'group') this.startTurn(d, e);
      else d.rot = d.pos;
      this.scene.setInputLocked(true);
      return;
    }
    if (e.button === 2 && !d && e.target === this.scene.canvas && !this.me.ready) {
      // right-drag on a selected squad of mine turns the selection
      const hit = this.scene.squadAt(e.clientX, e.clientY);
      if (hit && !hit.ghost && this.sel.has(hit.id)) {
        e.stopPropagation();
        const g = this.groupDrag(hit.id, e, true);
        if (g) this.startTurn(g, e);
        return;
      }
    }
    if (e.button !== 0) return;
    if (d?.kind === 'place' && !d.fromShop) {
      // click-to-place: placed on release
      d.moved = true;
      this.scene.setInputLocked(true);
      return;
    }
    const hit = this.scene.squadAt(e.clientX, e.clientY);
    if (hit && !hit.ghost) {
      const sq = this.squad(hit.id);
      if (!sq) return;
      if (e.shiftKey) {
        // Shift-click adds a squad to the selection, or takes it out
        const next = new Set(this.sel);
        if (next.has(sq.id)) next.delete(sq.id);
        else next.add(sq.id);
        sound.click();
        this.select(null, false, [...next]);
        return;
      }
      this.scene.setInputLocked(true);
      if (this.sel.size > 1 && this.sel.has(sq.id)) {
        this.groupDrag(sq.id, e, false);
        return;
      }
      const shown = this.shownSquad(sq.id) ?? sq;
      this.drag = { kind: 'move', id: sq.id, facing: shown.facing, start: [e.clientX, e.clientY], moved: false, pos: shown.pos, rot: null };
      return;
    }
    if (hit?.ghost) {
      this.pendingClick = { x: e.clientX, y: e.clientY, ghost: hit.id };
      return;
    }
    if (e.target === this.scene.canvas && this.boxable(e)) {
      // empty ground in my zone: a box selection (a plain click still deselects)
      this.box = { x: e.clientX, y: e.clientY, add: e.shiftKey, el: null };
      return;
    }
    this.pendingClick = { x: e.clientX, y: e.clientY, ghost: null };
  }
  private pendingClick: { x: number; y: number; ghost: number | null } | null = null;

  /** A left press on empty ground inside my deploy zone starts a box selection (instead of a camera pan). */
  private boxable(e: PointerEvent): boolean {
    const g = this.scene.groundAt(e.clientX, e.clientY);
    return !!g && inDeployZone(this.seat, g);
  }

  /** Start dragging the selection (`turn`: a right-drag that only turns it). `hitId` is the squad pressed. */
  private groupDrag(hitId: number, e: PointerEvent, turn: boolean): Extract<Drag, { kind: 'group' }> | null {
    const shown = this.squadsShown();
    const ids = shown.filter((q) => this.sel.has(q.id)).map((q) => q.id);
    if (!ids.length) return null;
    const base = new Map<number, Placed>();
    for (const q of shown) if (this.sel.has(q.id)) base.set(q.id, { pos: q.pos, facing: q.facing });
    const grab = this.scene.groundAt(e.clientX, e.clientY) ?? base.get(hitId)!.pos;
    const rm = this.relocMe()!;
    const g: Extract<Drag, { kind: 'group' }> = { kind: 'group', ids, start: [e.clientX, e.clientY], grab, moved: false, delta: [0, 0], steps: 0, rot: null, base, out: null, pos: grab, turnOnly: turn, hit: hitId, pinned: pinnedIn(rm, ids, this.round), turnPinned: this.turnPins(ids) };
    this.drag = g;
    this.scene.setInputLocked(true);
    return g;
  }

  /** The group's centre as it is shown now (moved by the drag so far). */
  private groupCentre(d: Extract<Drag, { kind: 'group' }>): Vec2 {
    let x = 0;
    let y = 0;
    for (const p of d.base.values()) {
      x += p.pos[0];
      y += p.pos[1];
    }
    return [x / d.base.size + d.delta[0], y / d.base.size + d.delta[1]];
  }

  private startTurn(d: Extract<Drag, { kind: 'group' }>, e: PointerEvent): void {
    const g = this.scene.groundAt(e.clientX, e.clientY);
    const c = this.groupCentre(d);
    d.rot = { from: g ? ANG(g[0] - c[0], g[1] - c[1]) : 0, at: d.steps };
  }

  /** Re-place the dragged group for its current offset and turn, and show it there. */
  private placeGroup(d: Extract<Drag, { kind: 'group' }>): void {
    const shown = this.me!.squads;
    const bodies = d.ids.map((id) => ({ id, type: shown.find((q) => q.id === id)!.type, pos: d.base.get(id)!.pos, facing: d.base.get(id)!.facing }));
    const others = this.squadsShown().filter((q) => !d.base.has(q.id));
    // relocation (DESIGN §2): a drag leaves locked squads in place (unless the Muster's moves cover them all); a turn
    // that does not move the group turns them on the spot
    const turning = d.turnOnly || (d.delta[0] === 0 && d.delta[1] === 0);
    const pins = turning ? d.turnPinned : d.pinned;
    d.out = groupPlace(bodies, others, this.seat, d.delta, d.steps, this.snapStep(), pins);
    const stay = pins.size ? ` · <span class="lockn">${icon('lock')}${pins.size} locked ${turning ? 'turn on the spot' : 'stay in place'}</span>` : '';
    this.hint.innerHTML = `${d.out ? '' : '<b class="bad">No room for the group here</b> · '}<b>${d.ids.length} squad${d.ids.length > 1 ? 's' : ''}</b>${stay} · <kbd>Q</kbd><kbd>E</kbd> or right-drag turn the group · <kbd>Esc</kbd> cancel`;
    this.hint.classList.add('on');
    this.drawArmy();
  }

  /** Keep a left press from the camera: while placing, on one of my squads, or on empty ground in my zone (box select). */
  private claims(e: PointerEvent): boolean {
    if (!this.me) return false;
    if (this.drag) return true;
    const hit = this.scene.squadAt(e.clientX, e.clientY);
    if (hit) return !hit.ghost && (!this.me.ready || e.shiftKey);
    return this.boxable(e);
  }

  private move(e: PointerEvent): void {
    this.pointer(e);
    if (this.itemDrag) return this.moveItem(e);
    const d = this.drag;
    if (this.box) return this.moveBox(e);
    const g = this.scene.groundAt(e.clientX, e.clientY);
    if (!d) {
      // hover
      if (e.target !== this.scene.canvas) return;
      const hit = this.scene.squadAt(e.clientX, e.clientY);
      this.scene.setHovered(hit?.id ?? null);
      const watched = !this.me && hit ? this.shown(hit.id) : null;
      const sq = watched ? watched.sq : hit ? (hit.ghost ? this.ghost(hit.id) : this.squad(hit.id)) : null;
      const ro = !!watched || !!hit?.ghost;
      const rm = this.relocMe();
      const lockNo = !ro && hit && rm ? dragRefusal(rm, hit.id, this.round) : null;
      const hint = this.me?.ready ? 'You are Ready: un-ready to move it' : lockNo ?? (this.sel.size > 1 && hit && this.sel.has(hit.id) ? 'Drag to move the selection · right-drag to turn it' : 'Click to select · Shift-click to add · drag to move');
      const mark = hit?.ghost && sq && this.view ? ghostMark(sq, this.view.enemy.lastMoved, this.view.round) : null;
      showTipAt(e.clientX, e.clientY, sq ? squadTooltip(sq, watched ? watched.lord : hit!.ghost ? this.view!.enemy.lord : this.me?.lord ?? null, { ghost: !!hit?.ghost, hint: ro ? (mark ? GHOST_MARK_TEXT[mark] : undefined) : hint, lock: !!lockNo }) : null);
      this.scene.canvas.style.cursor = sq ? (ro ? 'help' : 'grab') : '';
      return;
    }
    showTipAt(0, 0, null);
    if (d.kind === 'group') {
      if (!d.moved && Math.hypot(e.clientX - d.start[0], e.clientY - d.start[1]) < 6) return;
      if (!d.moved && !d.turnOnly && !d.rot && d.pinned.size === d.ids.length) {
        // nothing in the selection may move: say why instead of dragging nothing
        const rm = this.relocMe()!;
        const why = dragRefusal(rm, d.hit, this.round) ?? d.ids.map((id) => dragRefusal(rm, id, this.round)).find((x) => x) ?? 'Locked in place';
        this.endDrag();
        return this.refuse(why);
      }
      d.moved = true;
      if (g) {
        if (d.rot) {
          const c = this.groupCentre(d);
          if (Math.hypot(g[0] - c[0], g[1] - c[1]) > 150) d.steps = (d.rot.at + ANG(g[0] - c[0], g[1] - c[1]) - d.rot.from + 512) & 255;
        } else if (!d.turnOnly) {
          d.delta = [g[0] - d.grab[0], g[1] - d.grab[1]];
          d.pos = g;
        }
      }
      return this.placeGroup(d);
    }
    if (d.rot && g) {
      // aiming: facing points from the anchor towards the pointer
      const dx = g[0] - d.rot[0];
      const dy = g[1] - d.rot[1];
      if (Math.hypot(dx, dy) > 150) d.facing = ANG(dx, dy);
    } else {
      if (d.kind === 'move' && !d.moved && Math.hypot(e.clientX - d.start[0], e.clientY - d.start[1]) < 6) return;
      if (d.kind === 'move' && !d.moved) {
        // relocation (DESIGN §2): a squad locked in place is not dragged; it says why (turning it stays free)
        const rm = this.relocMe();
        const why = rm ? dragRefusal(rm, d.id, this.round) : null;
        if (why) {
          const id = d.id;
          this.endDrag();
          this.select(id);
          return this.refuse(why);
        }
      }
      if (d.kind === 'move' || this.overCanvas) d.moved = true;
      if (g) d.pos = inDeployZone(this.seat, g) ? snapPos(g, this.snapStep(), this.seat) : g;
    }
    if (d.kind === 'move') this.scene.setHidden(d.id);
    this.preview();
  }

  /** The selection box follows the pointer (a DOM rectangle: nothing is drawn by the renderer). */
  private moveBox(e: PointerEvent): void {
    const b = this.box!;
    if (!b.el) {
      if (Math.hypot(e.clientX - b.x, e.clientY - b.y) < 6) return;
      b.el = el('<div class="selbox"></div>');
      this.root.appendChild(b.el);
      showTipAt(0, 0, null);
    }
    const x0 = Math.min(b.x, e.clientX);
    const y0 = Math.min(b.y, e.clientY);
    b.el.style.cssText = `left:${x0}px;top:${y0}px;width:${Math.abs(e.clientX - b.x)}px;height:${Math.abs(e.clientY - b.y)}px`;
  }

  private endBox(e: PointerEvent): void {
    const b = this.box!;
    this.box = null;
    if (!b.el) {
      // a plain click on empty ground
      if (!b.add) this.select(null);
      return;
    }
    b.el.remove();
    const x0 = Math.min(b.x, e.clientX), x1 = Math.max(b.x, e.clientX);
    const y0 = Math.min(b.y, e.clientY), y1 = Math.max(b.y, e.clientY);
    const inBox = this.squadsShown().filter((q) => {
      // the squad's feet or its plate inside the box
      for (const h of [0, 3]) {
        const p = this.scene.toScreen(q.pos, h);
        if (p && p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1) return true;
      }
      return false;
    });
    const next = new Set(b.add ? this.sel : []);
    for (const q of inBox) next.add(q.id);
    if (inBox.length) sound.click();
    this.select(null, false, [...next]);
  }

  private preview(): void {
    const d = this.drag;
    const me = this.me;
    if (!d || !me || d.kind === 'group') return;
    const overCanvas = this.overCanvas;
    if (!d.pos || !overCanvas) {
      this.dragSpot = null;
      this.scene.setPreview(null);
      this.scene.setRange(null);
      this.renderTiming();
      return;
    }
    const type = d.kind === 'place' ? d.unit : this.squad(d.id)!.type;
    const lvl = d.kind === 'place' ? 1 : this.squad(d.id)!.level;
    const at = this.spot(type, d.pos, d.kind === 'move' ? d.id : -1);
    const inZone = inDeployZone(this.seat, d.pos);
    const why = !inZone ? 'Outside your deploy zone' : !at ? 'No room here: each squad needs its own ground' : d.kind === 'place' ? this.blocked(d.unit) : null;
    const valid = !why;
    const pos = at ?? d.pos;
    this.dragSpot = at;
    this.scene.setPreview({ type, lord: type === 'lord' ? me.lord : null, seat: this.seat, pos, facing: d.facing, valid });
    const s = soldierStats(type, lvl, me.lord);
    this.scene.setRange({ pos, range: s.range, minRange: s.minRange, aura: type === 'lord' && me.lord ? lordAuraRing(LORDS[me.lord].ability) : null });
    this.hint.innerHTML = `${valid ? '' : `<b class="bad">${esc(why ?? '')}</b> · `}<kbd>Q</kbd><kbd>E</kbd> or right-drag turn the squad · <kbd>Esc</kbd> cancel`;
    this.hint.classList.add('on');
    this.renderTiming();
  }

  /**
   * Where a squad dropped at `pos` actually lands: there, or the nearest free ground when it would
   * overlap another squad (squads may not share ground). Null when outside the zone or nothing is
   * free within a few metres.
   */
  private spot(type: Squad['type'], pos: Vec2, ignoreId: number): Vec2 | null {
    const me = this.me;
    if (!me || !inDeployZone(this.seat, pos)) return null;
    const squads = this.squadsShown();
    if (!overlappingSquad(squads, type, pos, ignoreId)) return pos;
    const near = freeSpotNear(squads, this.seat, type, pos, ignoreId);
    return near && Math.hypot(near[0] - pos[0], near[1] - pos[1]) <= 900 ? near : null;
  }

  private overCanvas = true;

  private up(e: PointerEvent): void {
    if (this.itemDrag) return this.dropItem(e);
    if (this.box && e.button === 0) return this.endBox(e);
    const d = this.drag;
    const pc = this.pendingClick;
    this.pendingClick = null;
    if (!d) {
      if (pc && e.button === 0 && Math.hypot(e.clientX - pc.x, e.clientY - pc.y) < 6 && e.target === this.scene.canvas) {
        this.cameraTouched = false; // a plain click is not a camera move
        if (pc.ghost !== null) {
          sound.click();
          this.select(pc.ghost, true);
        } else this.select(null);
      }
      return;
    }
    if (d.kind === 'group') {
      if (e.button === 2) {
        d.rot = null;
        // a right-drag that only turned the selection ends with the button
        if (!d.turnOnly) return;
      } else if (e.button !== 0) return;
      if (!d.moved) {
        if (!d.turnOnly) {
          // a click on one squad of the selection selects just that squad
          sound.click();
          this.select(d.hit);
        }
      } else if (d.out) {
        // end the drag first: while it lasts the group is drawn (and counted) where it would land
        const out = d.out;
        this.endDrag();
        if (this.moveSquads(out, d.turnOnly || (d.delta[0] === 0 && d.delta[1] === 0) ? 'turn group' : `move ${d.ids.length} squads`)) sound.drop();
        return;
      } else this.refuse('No room for the group there');
      this.endDrag();
      return;
    }
    if (e.button === 2) {
      d.rot = null;
      if (d.kind === 'place' && !d.fromShop) this.scene.setInputLocked(false);
      return;
    }
    if (e.button !== 0) return;
    const onCanvas = e.target === this.scene.canvas;
    if (d.kind === 'move') {
      if (!d.moved) {
        sound.click();
        this.select(d.id);
      } else if (d.pos && onCanvas) {
        const sq = this.squad(d.id);
        const at = this.spot(sq?.type ?? 'lord', d.pos, d.id);
        if (!inDeployZone(this.seat, d.pos)) this.refuse('outside deploy zone');
        else if (!at) this.refuse('No room there: each squad needs its own ground');
        else {
          sound.drop();
          this.moveSquads(new Map([[d.id, { pos: at, facing: d.facing }]]), `move ${sq ? unitName(sq.type, this.me?.lord ?? null) : 'squad'}`);
          this.select(d.id);
        }
      }
      this.endDrag();
      return;
    }
    // placing
    if (d.fromShop && !d.moved && !onCanvas) {
      // a click on the card: keep the ghost on the pointer until the field is clicked
      d.fromShop = false;
      this.scene.setInputLocked(false);
      this.hint.innerHTML = `Click your half of the field to deploy ${esc(UNITS[d.unit].name)} · <kbd>Q</kbd><kbd>E</kbd> turn the squad · <kbd>Esc</kbd> cancel`;
      this.hint.classList.add('on');
      return;
    }
    if (onCanvas && d.pos) this.deploy(d.unit, d.pos, d.facing);
    this.endDrag();
  }

  private deploy(u: UnitType, pos: Vec2, facing: number): void {
    const why = this.blocked(u);
    if (why) {
      sound.error();
      toast(why, 'bad');
      if (/deploy/i.test(why)) this.shake('.deploy-badge');
      if (/gold/i.test(why)) this.shake('.r-gold');
      return;
    }
    if (!inDeployZone(this.seat, pos)) return this.refuse('outside deploy zone');
    const at = this.spot(u, pos, -1);
    if (!at) return this.refuse('No room there: each squad needs its own ground');
    sound.deploy();
    playLordLine(this.me?.lord, 'deploy', { delay: 0.15 });
    this.undoDeploy(u);
    this.intent({ t: 'deploy', unit: u, pos: at, facing });
  }

  private startPlace(u: UnitType, fromShop: boolean): void {
    const why = this.blocked(u);
    if (why) {
      sound.error();
      toast(why, 'bad');
      if (/deploy/i.test(why)) this.shake('.deploy-badge');
      if (/gold/i.test(why)) this.shake('.r-gold');
      return;
    }
    sound.pick();
    this.select(null);
    this.drag = { kind: 'place', unit: u, facing: defaultFacing(this.seat), fromShop, moved: false, pos: null, rot: null };
    this.scene.setInputLocked(fromShop);
    this.shop.querySelectorAll('.ucard').forEach((c) => c.classList.toggle('arming', (c as HTMLElement).dataset.u === u));
  }

  private endDrag(): void {
    if (this.drag?.kind === 'move') this.scene.setHidden(null);
    this.drag = null;
    this.dragSpot = null;
    this.scene.setPreview(null);
    this.scene.setInputLocked(false);
    this.hint.classList.remove('on');
    this.shop.querySelectorAll('.ucard.arming').forEach((c) => c.classList.remove('arming'));
    this.syncRange();
    this.drawArmy();
  }

  private cancelDrag(): void {
    if (this.drag) this.endDrag();
    if (this.box) {
      this.box.el?.remove();
      this.box = null;
    }
    this.cancelItem();
  }

  private key(e: KeyboardEvent): void {
    if ((e.target as HTMLElement)?.closest?.('input, textarea')) return;
    if (document.querySelector('.rules-veil, .dialog-veil, .report-veil')) return;
    if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(e.key.toLowerCase()) && !e.ctrlKey && !e.metaKey) this.cameraTouched = true;
    if ((e.key === 'q' || e.key === 'e') && !this.drag && !e.shiftKey) this.cameraTouched = true;
    if (!this.me) {
      // spectators: only the camera and deselect
      if (e.key === 'Escape') this.select(null, true);
      else if (e.key === 'Home') (e.stopPropagation(), this.scene.resetCamera?.());
      return;
    }
    if (this.loot || this.draft) {
      if (e.key === 'Escape') {
        this.closeLoot();
        this.closeDraft();
      }
      return;
    }
    const k = e.key.toLowerCase();
    const mod = e.ctrlKey || e.metaKey;
    if (mod && k === 'z' && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      this.undo();
    } else if (mod && k === 'a') {
      // select my whole army
      e.preventDefault();
      e.stopPropagation();
      if (!this.drag) this.select(null, false, this.me.squads.map((s) => s.id));
    } else if (mod || e.altKey) {
      return;
    } else if (e.key === ' ') {
      e.preventDefault();
      this.toggleReady();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      if (!this.drag) this.cycleSquad(e.shiftKey ? -1 : 1);
    } else if (e.key === 'Escape') {
      if (this.sellArmed) {
        this.sellArmed = null;
        this.renderPanel();
      } else if (this.drag) this.endDrag();
      else this.select(null);
    } else if (e.key === 'Home') {
      // the UI owns the camera keys: back to the home framing
      e.preventDefault();
      e.stopPropagation();
      this.cameraTouched = false;
      this.scene.resetCamera?.();
    } else if ((k === 'q' || k === 'e') && (this.drag || (e.shiftKey && this.sel.size > 0))) {
      // Q/E turn the squad (or the group, about its centre) only while it is being placed or dragged,
      // or with Shift on the selection. Otherwise the key is left for the camera, which turns the view.
      e.stopPropagation();
      const step = k === 'q' ? TURN_STEP : -TURN_STEP;
      const d = this.drag;
      if (d?.kind === 'group') {
        d.steps = (d.steps + step + 256) & 255;
        if (d.rot) d.rot.at = (d.rot.at + step + 256) & 255;
        d.moved = true;
        this.placeGroup(d);
      } else if (d) {
        d.facing = (d.facing + step + 256) & 255;
        this.preview();
      } else this.turnSelection(step);
    } else if (k === 't' && !e.shiftKey) {
      e.stopPropagation();
      this.toggleRoutes();
    } else if (k === 'g' && !e.shiftKey) {
      e.stopPropagation();
      this.toggleSnap();
    } else if (k === 'b' && !e.shiftKey) {
      e.stopPropagation();
      this.openStash(!this.stashOpen());
    } else if (SHOP_KEYS.includes(e.key) && this.me) {
      const u = this.shopUnits()[SHOP_KEYS.indexOf(e.key)];
      if (u) {
        e.stopPropagation(); // - and = also zoom the camera
        if (this.drag) this.endDrag();
        this.startPlace(u, false);
        this.drag && ((this.drag as { fromShop: boolean }).fromShop = false);
        this.hint.innerHTML = `Click your half of the field to deploy ${esc(UNITS[u].name)} · <kbd>Q</kbd><kbd>E</kbd> turn the squad · <kbd>Esc</kbd> cancel`;
        this.hint.classList.add('on');
        const g = this.lastPointer && this.scene.groundAt(this.lastPointer.x, this.lastPointer.y);
        if (g && this.drag) {
          this.drag.pos = g;
          this.preview();
        }
      }
    } else if (k === 'u' && this.selected !== null) this.levelUp();
    else if ((e.key === 'Delete' || e.key === 'Backspace') && this.selected !== null) this.sell();
  }
  private lastPointer: { x: number; y: number } | null = null;

  // ---------------------------------------------------------------- item drag & drop

  private moveItem(e: PointerEvent): void {
    const d = this.itemDrag!;
    if (!d.started) {
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < 5) return;
      d.started = true;
      hideTip();
      d.el = el(`<div class="drag-avatar">${itemIcon(d.item, { size: 'md' })}</div>`);
      this.root.appendChild(d.el);
      this.root.classList.add('item-dragging');
      // the open slot of that kind lights up, or greys out when the squad's class cannot use the item's skill
      this.root.querySelectorAll<HTMLElement>(`.sp-slot[data-sslot="${d.item.slot}"]:not(.locked)`).forEach((s) => {
        const sq = this.squad(Number(s.dataset.squad));
        s.classList.add(sq && this.refusal(d.item, sq) ? 'drop-no' : 'drop-ok');
      });
      this.stash.classList.toggle('drop-ok', d.from !== null);
      // dragging an item off a squad: the stash opens to take it back
      if (d.from !== null && !this.stashOpen()) this.openStash(true, true);
      sound.pick();
    }
    d.el!.style.transform = `translate(${e.clientX - 28}px, ${e.clientY - 28}px)`;
    // over a squad on the field: highlight + comparison
    const under = document.elementFromPoint(e.clientX, e.clientY);
    if (under === this.scene.canvas) {
      const hit = this.scene.squadAt(e.clientX, e.clientY);
      const sq = hit && !hit.ghost ? this.squad(hit.id) : null;
      this.scene.setHovered(sq?.id ?? null);
      const no = sq ? this.refusal(d.item, sq) : null;
      d.el!.classList.toggle('no', !!no);
      if (sq && no) showTipAt(e.clientX, e.clientY, `<div class="tip-plain bad">${esc(no)}</div>`);
      else if (sq) {
        const open = slotOpen(sq, d.item.slot);
        showTipAt(e.clientX, e.clientY, open ? itemTooltipPair(d.item, sq.items[d.item.slot], `Drop to equip on ${unitName(sq.type, this.me!.lord)}`, { type: sq.type, lord: this.me!.lord }) : `<div class="tip-plain bad">${esc(unitName(sq.type, this.me!.lord))}: ${esc(slotLockText(d.item.slot))}</div>`);
      } else showTipAt(e.clientX, e.clientY, null);
    } else {
      this.scene.setHovered(null);
      const slotEl = (under as HTMLElement | null)?.closest?.<HTMLElement>('.sp-slot');
      if (slotEl && slotEl.dataset.sslot === d.item.slot && !slotEl.classList.contains('locked')) {
        const sq = this.squad(Number(slotEl.dataset.squad));
        const no = sq ? this.refusal(d.item, sq) : null;
        d.el!.classList.toggle('no', !!no);
        showTipAt(e.clientX, e.clientY, no ? `<div class="tip-plain bad">${esc(no)}</div>` : sq ? itemTooltipPair(d.item, sq.items[d.item.slot], 'Drop to equip', { type: sq.type, lord: this.me!.lord }) : null);
      } else {
        d.el!.classList.remove('no');
        showTipAt(e.clientX, e.clientY, null);
      }
    }
  }

  private dropItem(e: PointerEvent): void {
    const d = this.itemDrag!;
    const me = this.me;
    if (!d.started) {
      // a click: quick-equip a stash item on the selected squad
      const sel = this.squad(this.selected);
      if (d.from === null && sel && me) {
        const no = this.refusal(d.item, sel);
        if (no) this.refuse(no);
        else if (slotOpen(sel, d.item.slot)) {
          sound.equip();
          this.undoItem(d.item, null, sel.id);
          this.intent({ t: 'equip', item: d.item.id, squad: sel.id });
        } else this.refuse(slotLockText(d.item.slot));
      }
      this.cancelItem();
      return;
    }
    const under = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
    let target: number | null = null;
    if (under === this.scene.canvas) {
      const hit = this.scene.squadAt(e.clientX, e.clientY);
      if (hit && !hit.ghost) target = hit.id;
    } else {
      const slotEl = under?.closest<HTMLElement>('.sp-slot');
      if (slotEl) target = Number(slotEl.dataset.squad);
      else if (under?.closest('.stash') && d.from !== null) {
        sound.equip();
        this.undoItem(d.item, d.from, null);
        this.intent({ t: 'unequip', item: d.item.id });
      }
    }
    if (target !== null && target !== d.from) {
      const sq = this.squad(target);
      // refused here with the reason, rather than sent for the server to refuse
      const no = sq ? this.refusal(d.item, sq) : null;
      if (no) this.refuse(no);
      else if (sq && !slotOpen(sq, d.item.slot)) this.refuse(slotLockText(d.item.slot));
      else if (sq) {
        sound.equip();
        this.undoItem(d.item, d.from, target);
        this.intent({ t: d.from === null ? 'equip' : 'moveItem', item: d.item.id, squad: target });
        if (this.selected === null) this.select(target);
      }
    }
    this.cancelItem();
  }

  /** Why this squad cannot wear the item (a skill item of another class), or null. */
  private refusal(item: Item, sq: Squad): string | null {
    return equipRefusal(item, { type: sq.type, lord: this.me?.lord ?? null });
  }

  private cancelItem(): void {
    const d = this.itemDrag;
    if (!d) return;
    d.el?.remove();
    this.itemDrag = null;
    this.root.classList.remove('item-dragging');
    this.root.querySelectorAll('.drop-ok, .drop-no').forEach((n) => n.classList.remove('drop-ok', 'drop-no'));
    this.stash.classList.remove('drop-ok');
    if (this.stash.classList.contains('auto')) this.openStash(false, true);
    this.scene.setHovered(null);
    showTipAt(0, 0, null);
  }

  /** Track whether the pointer is over the field (for the deploy ghost) — called from a global listener. */
  pointer(e: PointerEvent): void {
    this.lastPointer = { x: e.clientX, y: e.clientY };
    this.overCanvas = e.target === this.scene.canvas;
  }

  dispose(): void {
    this.off.forEach((f) => f());
    this.cancelDrag();
    this.loot?.dispose();
    this.draft?.dispose();
    this.top.dispose();
    this.scene.setPreview(null);
    this.scene.setRange(null);
    this.scene.setSelected(null);
    this.scene.setHovered(null);
    this.scene.showDeployZone(null);
    this.scene.setGhosts(null);
    this.scene.setPointerClaim(null);
    this.scene.setTiming?.(null);
    this.scene.setSelection?.([]);
    this.scene.setInsets({ top: 0, bottom: 0 });
    showTipAt(0, 0, null);
    this.root.remove();
  }
}
