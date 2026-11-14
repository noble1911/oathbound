// Planning HUD: Keep bars / round / timer, the resource strip (gold, deploys n/limit, army, the
// enemy-intel label: last round's enemy positions are always drawn from round 2), the shop bar of unlocked units, drag-to-deploy with a formation ghost and rotation
// (right-drag or Q/E), moving squads, the selected-squad panel (level-up, stats, item slots,
// sell), the stash with drag-and-drop equipping and comparison tooltips, the loot and draft
// modals, and Ready. Keys: Space ready, Tab / Shift+Tab select the next / previous of your squads, 1-9 0 - shop, Q/E turn the squad while placing
// or dragging (Shift+Q/E for the selected squad; otherwise Q/E turn the camera), U level up, Del
// sell (press twice), Home reset the camera, Esc cancel. Spectators get a read-only version: both
// Keeps, both last-round armies, no shop, no deploy badge.
import type { Intent, Item, LordId, PlayerState, PlayerView, Seat, Slot, Squad, UnitType, Vec2 } from '../sim/types.ts';
import type { RoomView } from '../net/protocol.ts';
import { UNITS } from '../sim/data/units.ts';
import { LORDS } from '../sim/data/lords.ts';
import { inDeployZone, levelUpCost, sellRefund, ARMY_CAP, MAX_SQUAD_LEVEL, LORD_XP_LEVELS, MAX_LORD_LEVEL, overlappingSquad, freeSpotNear } from '../sim/match.ts';
import { SLOT_UNLOCK_LEVEL } from '../sim/data/items.ts';
import { sound } from '../audio.ts';
import type { Backend } from './backend.ts';
import type { SceneAdapter, SquadVisual } from './scene-adapter.ts';
import { $, el, esc, hideTip, num, showTipAt, store, tip, toast } from './dom.ts';
import { icon } from './icons.ts';
import { deadSummary, equipRefusal, itemIcon, itemTooltip, itemTooltipPair, slotLockText } from './items.ts';
import { crest, squadTooltip, statBlock, countersBlock, sheetStats, skillChips, skillTooltip, tagIcons, unitTooltip } from './units.ts';
import { squadSheet } from '../sim/sheet.ts';
import { squadSkills } from '../sim/data/skills.ts';
import { defaultFacing, dps, rarityRank, SHOP_KEYS, SLOT_LABEL, SLOTS, slotOpen, soldierStats, unitName, allItems } from './gamedata.ts';
import { niceError, TopBar } from './hud.ts';
import { DraftModal, LootModal } from './loot.ts';

type Drag =
  | { kind: 'place'; unit: UnitType; facing: number; fromShop: boolean; moved: boolean; pos: Vec2 | null; rot: Vec2 | null }
  | { kind: 'move'; id: number; facing: number; start: [number, number]; moved: boolean; pos: Vec2 | null; rot: Vec2 | null };

const GHOST_TIP = 'The red ghosts on the far half are where the enemy army stood in the last battle. You never see what they are doing now. Hover or click one to read it.';
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
  return { id: sq.id, type: sq.type, lord: sq.type === 'lord' ? lord : null, owner: sq.owner, pos: sq.pos, facing: sq.facing, level: sq.level, rarity: bestRarity(sq) };
}

export class PlanningScreen {
  readonly root: HTMLElement;
  private top: TopBar;
  private res: HTMLElement;
  private shop: HTMLElement;
  private panel: HTMLElement;
  private stash: HTMLElement;
  private readyBox: HTMLElement;
  private notices: HTMLElement;
  private hint: HTMLElement;
  room: RoomView | null = null;
  private view: PlayerView | null = null;
  private me: PlayerState | null = null;
  private seat: Seat = 0;
  private selected: number | null = null;
  private ghostSel: number | null = null;
  private drag: Drag | null = null;
  private pending: { id: number; pos: Vec2; facing: number } | null = null;
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
      <aside class="stash panel"><header>${icon('bag')}<b>Stash</b><small></small></header><div class="stash-grid"></div><p class="stash-hint">Drag items onto a squad or its slots. Drag here to unequip.</p></aside>
      <div class="bottom">
        <div class="deploy-badge" data-tip="New squads you may still deploy this round. Levelling up and equipping are unlimited."><small>Deploys left</small><b>2</b><span>of 2 this round</span></div>
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
    if (this.pending && this.me && this.me.squads.some((s) => s.id === this.pending!.id && s.pos[0] === this.pending!.pos[0] && s.pos[1] === this.pending!.pos[1])) this.pending = null;
    if (this.pending && newRound) this.pending = null;
    if (this.selected !== null && !this.me?.squads.some((s) => s.id === this.selected)) this.select(null);

    this.scene.setPerspective(v.seat);
    this.scene.setTerrain(v.terrain);
    // both sides' public state: my own, or (spectating) each seat's public view
    const mine = v.you ?? v.enemies?.[mySeat] ?? v.enemy;
    const foe = v.enemies?.[foeSeat] ?? v.enemy;
    this.scene.setKeeps(mySeat === 0 ? [mine.keepHp, foe.keepHp] : [foe.keepHp, mine.keepHp], mySeat === 0 ? [mine.keepMax, foe.keepMax] : [foe.keepMax, mine.keepMax]);
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
    else if (this.draft && this.draft.key !== me.draftOptions.join(',') + ':' + me.draftPicks) this.openDraft();
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
    const key = me.draftOptions.join(',') + ':' + me.draftPicks;
    // the same draft re-rendered (a snapshot update) is not news
    const news = fresh || (this.draft === null && this.draftAnnounced !== key);
    this.draftAnnounced = key;
    this.draft?.dispose();
    this.draft = new DraftModal(this.root, me, this.round, (u) => {
      this.intent({ t: 'draft', unit: u });
      toast(`${UNITS[u].name} unlocked`, 'good');
    }, () => this.closeDraft(), news);
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

  rejected(e: string): void {
    sound.error();
    toast(niceError(e), 'bad');
    this.pending = null;
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

  private squadsShown(): Squad[] {
    const me = this.me;
    if (!me) return [];
    return me.squads.map((s) => (this.pending && s.id === this.pending.id ? { ...s, pos: this.pending.pos, facing: this.pending.facing } : s));
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
    this.scene.setSelected(this.selected ?? this.ghostSel);
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
    $(badge, 'b').textContent = String(left);
    $(badge, 'span').textContent = `of ${me.deployLimit} this round`;
    badge.classList.toggle('none', left === 0);
  }

  /** Why a unit can't be deployed right now, or null. */
  private blocked(u: UnitType): string | null {
    const me = this.me;
    if (!me) return 'Spectating';
    if (me.ready) return 'You are Ready (un-ready to change your army)';
    if (me.deploysUsed >= me.deployLimit) return `No deploys left this round (${me.deployLimit}/${me.deployLimit} used)`;
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
          <b>${esc(d.name)}</b>
          <div class="uc-meta"><span class="uc-cost">${icon('gold')}${d.cost}</span><span class="uc-size">×${d.squadSize}</span></div>
          <div class="uc-tags">${tagIcons(u)}<span class="uc-role">${esc(d.role)}</span></div>
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
        return unitTooltip(u, why ? `<div class="it-hint bad">${esc(why)}</div>` : `<div class="it-hint">Drag onto your half, or ${k ? `press ${k}` : 'click'} then click the field. Q/E or right-drag turns it.</div>`);
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
      this.cancelDrag();
      this.intent({ t: 'ready' });
    }
  }

  private renderNotices(): void {
    const me = this.me;
    let h = '';
    if (me?.lootOffer && !this.loot)
      h += `<button class="notice loot-n r-${me.lootOffer.reduce((b, i) => (rarityRank(i.rarity) > rarityRank(b) ? i.rarity : b), 'common' as Item['rarity'])}">${icon('bag')}<span><b>Spoils of War</b><small>Choose 1 of ${me.lootOffer.length}</small></span></button>`;
    if (me && me.draftPicks > 0 && me.draftOptions.length && !this.draft)
      h += `<button class="notice draft-n">${icon('squads')}<span><b>New recruits!</b><small>Unlock ${me.draftPicks} unit type${me.draftPicks > 1 ? 's' : ''}</small></span></button>`;
    if (this.onReport && this.round > 1)
      h += `<button class="notice report-n" ${this.reportHint ? `data-tip="${esc(this.reportHint)}"` : ''}>${icon('chart')}<span><b>Battle report</b><small>Round ${this.round - 1}: what happened</small></span></button>`;
    if (this.notices.dataset.h === h) return;
    this.notices.dataset.h = h;
    this.notices.innerHTML = h;
    this.notices.querySelector('.report-n')?.addEventListener('click', () => (sound.click(), this.onReport?.()));
    this.notices.querySelector('.loot-n')?.addEventListener('click', () => (sound.click(), this.openLoot()));
    this.notices.querySelector('.draft-n')?.addEventListener('click', () => (sound.click(), this.openDraft()));
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

  private select(id: number | null, ghost = false): void {
    if (ghost) {
      this.ghostSel = id;
      this.selected = null;
    } else {
      this.selected = id;
      this.ghostSel = null;
    }
    this.scene.setSelected(id);
    const watched = !this.me ? this.shown(id) : null;
    const sq = watched ? watched.sq : ghost ? this.ghost(id) : this.squad(id);
    if (sq) {
      const s = soldierStats(sq.type, sq.level, sq.type === 'lord' ? (watched ? watched.lord : ghost ? this.view!.enemy.lord : this.me!.lord) : null);
      this.scene.setRange({ pos: sq.pos, range: s.range, minRange: s.minRange, enemy: watched ? sq.owner !== this.seat : ghost });
    } else this.scene.setRange(null);
    this.renderPanel();
  }

  private renderPanel(): void {
    const me = this.me;
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
        <button class="btn primary lvl" ${can ? '' : 'disabled'} data-tip="${maxed ? 'Max level' : `+25% life, +20% damage${opens} [U]${whyNot ? '. ' + whyNot : ''}`}">
          ${icon('up')}<span>${maxed ? 'Max level' : `Level ${sq.level + 1}`}</span>${maxed ? '' : `<em>${icon('gold')}${cost}</em>`}</button>
        <button class="btn danger sell ${armed ? 'armed' : ''}" ${me.ready ? 'disabled' : ''} data-tip="${refund ? 'Refunds 50% (only in the round it was deployed). Items go to your stash.' : 'No refund: this squad was deployed in an earlier round. Items go to your stash.'} Press twice to confirm. [Del]">${icon('sell')}<span>${armed ? 'Confirm sell' : 'Sell'}</span><em>${refund ? `+${refund}` : '0'}</em></button>
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
    const s = soldierStats(sq.type, sq.level, lord);
    // the sim's sheet: stats after level, items and the Lord's passive, next to the level-1 base
    const ownerLord = watched ? watched.lord : ghost ? this.view!.enemy.lord : me!.lord;
    const sheet = this.view ? squadSheet(this.view, sq.id) : null;
    const stat = (k: string): number => sheet?.stats.find((l) => l.key === k)?.value ?? 0;
    const brief = sheet
      ? `${icon('heart')}${stat('hp')} ${icon('sword')}${(stat('damage') / Math.max(0.1, stat('attackInterval'))).toFixed(1)} ${icon('bow')}${stat('range') >= 4 ? stat('range').toFixed(0) + ' m' : 'melee'}`
      : `${icon('heart')}${s.hp} ${icon('sword')}${dps(s.dmg, s.attackTicks).toFixed(1)} ${icon('bow')}${s.range >= 400 ? (s.range / 100).toFixed(0) + ' m' : 'melee'}`;
    const squadDps = sheet ? stat('dps') : Number((dps(s.dmg, s.attackTicks) * s.size).toFixed(0));
    // everything the squad can do: innate traits (or the Lord's passive and ability) and what its items grant
    const skills = sheet?.skills ?? squadSkills(sq, ownerLord);
    const worn = SLOTS.map((slot) => sq.items[slot]);
    // the full stat table is one click away; open by default only where the screen has the room
    const pref = store.get('spstats');
    const statsOpen = pref ? pref === '1' : innerHeight >= 900;
    const scroll = this.panel.scrollTop;
    this.panel.innerHTML = `
      <header class="sp-h">${crest(sq.type, lord, 'lg')}<div class="sp-t"><small>${watched ? `${esc(this.names[sq.owner === this.seat ? 0 : 1])} · last round` : ghost ? 'Enemy · last round' : sub}</small><b>${esc(name)}</b>${lvl}</div><button class="icon close" data-tip="Deselect [Esc]">${icon('close')}</button></header>
      ${actions}
      <div class="sp-row"><div class="sp-sec"><small>Equipment</small><div class="sp-slots">${slots}</div></div>${skills.length ? `<div class="sp-sec sk-d"><small>Abilities</small><div class="sp-skills">${skillChips(skills, worn)}</div></div>` : ''}${def?.traits?.includes('healer') ? '<p class="sp-note">Healers never attack: damage, critical and leech lines do nothing here. Life, haste and range still help.</p>' : ''}</div>
      <details class="sp-sec st-d" ${statsOpen ? 'open' : ''}><summary><span data-tip="Stats of one soldier, after level and items">Stats${!isLord ? ` · squad DPS ${squadDps}` : ''}</span><span class="sp-brief">${brief}</span></summary>${sheet ? sheetStats(sheet) : statBlock(sq.type, sq.level, lord)}</details>
      ${isLord ? `<div class="sp-sec lt"><div class="lt-pass"><small>Passive</small>${esc(LORDS[lord!].passive)}</div><div class="lt-abil"><small>${esc(LORDS[lord!].abilityName)}</small>${esc(LORDS[lord!].abilityText)}</div></div>` : ''}
      ${def ? `<div class="sp-sec ctr-d"><small>Counters</small>${countersBlock(def.id)}</div>` : ''}
      ${!ghost && me ? '<p class="sp-hint">Drag on the field to move · <kbd>Shift</kbd>+<kbd>Q</kbd>/<kbd>E</kbd> turn the squad</p>' : ''}`;
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
      toast(`Sell ${UNITS[sq.type as UnitType].name} for ${refund ? `+${refund} gold` : 'no refund'}? Press Del again or click Confirm sell.`, 'info', 3600);
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

  private renderStash(): void {
    const me = this.me;
    if (!me) {
      this.stash.classList.add('hidden');
      return;
    }
    const items = [...me.stash].sort((a, b) => rarityRank(b.rarity) - rarityRank(a.rarity));
    this.stash.classList.toggle('empty', !items.length);
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
      // right-drag aims the squad (and not the camera)
      e.stopPropagation();
      d.rot = d.pos;
      this.scene.setInputLocked(true);
      return;
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
      this.scene.setInputLocked(true);
      this.drag = { kind: 'move', id: sq.id, facing: sq.facing, start: [e.clientX, e.clientY], moved: false, pos: sq.pos, rot: null };
      return;
    }
    if (hit?.ghost) {
      this.pendingClick = { x: e.clientX, y: e.clientY, ghost: hit.id };
      return;
    }
    this.pendingClick = { x: e.clientX, y: e.clientY, ghost: null };
  }
  private pendingClick: { x: number; y: number; ghost: number | null } | null = null;

  /** Keep a left press from the camera: while placing, or when it lands on one of my squads. */
  private claims(e: PointerEvent): boolean {
    if (!this.me || this.me.ready && !this.drag) return false;
    if (this.drag) return true;
    const hit = this.scene.squadAt(e.clientX, e.clientY);
    return !!hit && !hit.ghost;
  }

  private move(e: PointerEvent): void {
    this.pointer(e);
    if (this.itemDrag) return this.moveItem(e);
    const d = this.drag;
    const g = this.scene.groundAt(e.clientX, e.clientY);
    if (!d) {
      // hover
      if (e.target !== this.scene.canvas) return;
      const hit = this.scene.squadAt(e.clientX, e.clientY);
      this.scene.setHovered(hit?.id ?? null);
      const watched = !this.me && hit ? this.shown(hit.id) : null;
      const sq = watched ? watched.sq : hit ? (hit.ghost ? this.ghost(hit.id) : this.squad(hit.id)) : null;
      const ro = !!watched || !!hit?.ghost;
      showTipAt(e.clientX, e.clientY, sq ? squadTooltip(sq, sq.type === 'lord' ? (watched ? watched.lord : hit!.ghost ? this.view!.enemy.lord : this.me?.lord ?? null) : null, { ghost: !!hit?.ghost, hint: ro ? undefined : this.me?.ready ? 'You are Ready: un-ready to move it' : 'Click to select · drag to move' }) : null);
      this.scene.canvas.style.cursor = sq ? (ro ? 'help' : 'grab') : '';
      return;
    }
    showTipAt(0, 0, null);
    if (d.rot && g) {
      // aiming: facing points from the anchor towards the pointer
      const dx = g[0] - d.rot[0];
      const dy = g[1] - d.rot[1];
      if (Math.hypot(dx, dy) > 150) d.facing = ANG(dx, dy);
    } else {
      if (d.kind === 'move' && !d.moved && Math.hypot(e.clientX - d.start[0], e.clientY - d.start[1]) < 6) return;
      if (d.kind === 'move' || this.overCanvas) d.moved = true;
      if (g) d.pos = g;
    }
    if (d.kind === 'move') this.scene.setHidden(d.id);
    this.preview();
  }

  private preview(): void {
    const d = this.drag;
    const me = this.me;
    if (!d || !me) return this.scene.setPreview(null);
    const overCanvas = this.overCanvas;
    if (!d.pos || !overCanvas) {
      this.scene.setPreview(null);
      this.scene.setRange(null);
      return;
    }
    const type = d.kind === 'place' ? d.unit : this.squad(d.id)!.type;
    const lvl = d.kind === 'place' ? 1 : this.squad(d.id)!.level;
    const at = this.spot(type, d.pos, d.kind === 'move' ? d.id : -1);
    const inZone = inDeployZone(this.seat, d.pos);
    const why = !inZone ? 'Outside your deploy zone' : !at ? 'No room here: each squad needs its own ground' : d.kind === 'place' ? this.blocked(d.unit) : null;
    const valid = !why;
    const pos = at ?? d.pos;
    this.scene.setPreview({ type, lord: type === 'lord' ? me.lord : null, seat: this.seat, pos, facing: d.facing, valid });
    const s = soldierStats(type, lvl, me.lord);
    this.scene.setRange({ pos, range: s.range, minRange: s.minRange });
    this.hint.innerHTML = `${valid ? '' : `<b class="bad">${esc(why ?? '')}</b> · `}<kbd>Q</kbd><kbd>E</kbd> or right-drag turn the squad · <kbd>Esc</kbd> cancel`;
    this.hint.classList.add('on');
  }

  /**
   * Where a squad dropped at `pos` actually lands: there, or the nearest free ground when it would
   * overlap another squad (squads may not share ground). Null when outside the zone or nothing is
   * free within a few metres.
   */
  private spot(type: Squad['type'], pos: Vec2, ignoreId: number): Vec2 | null {
    const me = this.me;
    if (!me || !inDeployZone(this.seat, pos)) return null;
    if (!overlappingSquad(me.squads, type, pos, ignoreId)) return pos;
    const near = freeSpotNear(me.squads, this.seat, type, pos, ignoreId);
    return near && Math.hypot(near[0] - pos[0], near[1] - pos[1]) <= 900 ? near : null;
  }

  private overCanvas = true;

  private up(e: PointerEvent): void {
    if (this.itemDrag) return this.dropItem(e);
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
        const at = this.spot(this.squad(d.id)?.type ?? 'lord', d.pos, d.id);
        if (!inDeployZone(this.seat, d.pos)) this.rejected('outside deploy zone');
        else if (!at) this.rejected('No room there: each squad needs its own ground');
        else {
          sound.drop();
          this.pending = { id: d.id, pos: at, facing: d.facing };
          this.intent({ t: 'move', squad: d.id, pos: at, facing: d.facing });
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
    if (!inDeployZone(this.seat, pos)) return this.rejected('outside deploy zone');
    const at = this.spot(u, pos, -1);
    if (!at) return this.rejected('No room there: each squad needs its own ground');
    sound.deploy();
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
    this.scene.setPreview(null);
    this.scene.setInputLocked(false);
    this.hint.classList.remove('on');
    this.shop.querySelectorAll('.ucard.arming').forEach((c) => c.classList.remove('arming'));
    const sq = this.squad(this.selected);
    if (sq) {
      const s = soldierStats(sq.type, sq.level, this.me?.lord);
      this.scene.setRange({ pos: this.pending?.id === sq.id ? this.pending.pos : sq.pos, range: s.range, minRange: s.minRange });
    } else this.scene.setRange(null);
    this.drawArmy();
  }

  private cancelDrag(): void {
    if (this.drag) this.endDrag();
    this.cancelItem();
  }

  private key(e: KeyboardEvent): void {
    if ((e.target as HTMLElement)?.closest?.('input, textarea')) return;
    if (document.querySelector('.rules-veil, .dialog-veil, .report-veil')) return;
    if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(e.key.toLowerCase()) || ((e.key === 'q' || e.key === 'e') && !this.drag)) this.cameraTouched = true;
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
    if (e.key === ' ') {
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
    } else if ((k === 'q' || k === 'e') && (this.drag || (e.shiftKey && this.selected !== null))) {
      // Q/E turn the squad only while it is being placed or dragged, or with Shift on the selected
      // squad. Otherwise the key is left for the camera, which turns the view.
      e.stopPropagation();
      const step = k === 'q' ? 16 : -16;
      if (this.drag) {
        this.drag.facing = (this.drag.facing + step + 256) & 255;
        this.preview();
      } else {
        const sq = this.squad(this.selected);
        if (sq && this.me && !this.me.ready) {
          const f = ((this.pending?.id === sq.id ? this.pending.facing : sq.facing) + step + 256) & 255;
          const pos = this.pending?.id === sq.id ? this.pending.pos : sq.pos;
          this.pending = { id: sq.id, pos, facing: f };
          this.drawArmy();
          this.intent({ t: 'move', squad: sq.id, pos, facing: f });
        }
      }
    } else if (SHOP_KEYS.includes(e.key) && this.me && !e.ctrlKey && !e.metaKey && !e.altKey) {
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
        if (no) this.rejected(no);
        else if (slotOpen(sel, d.item.slot)) {
          sound.equip();
          this.intent({ t: 'equip', item: d.item.id, squad: sel.id });
        } else this.rejected(slotLockText(d.item.slot));
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
        this.intent({ t: 'unequip', item: d.item.id });
      }
    }
    if (target !== null && target !== d.from) {
      const sq = this.squad(target);
      // refused here with the reason, rather than sent for the server to refuse
      const no = sq ? this.refusal(d.item, sq) : null;
      if (no) this.rejected(no);
      else if (sq && !slotOpen(sq, d.item.slot)) this.rejected(slotLockText(d.item.slot));
      else if (sq) {
        sound.equip();
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
    this.scene.setInsets({ top: 0, bottom: 0 });
    showTipAt(0, 0, null);
    this.root.remove();
  }
}
