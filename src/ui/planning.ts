// Planning HUD: Keep bars / round / timer, the resource strip (gold, deploys n/limit, army, ghost
// toggle), the shop bar of unlocked units, drag-to-deploy with a formation ghost and rotation
// (right-drag or Q/E), moving squads, the selected-squad panel (level-up, stats, item slots,
// sell), the stash with drag-and-drop equipping and comparison tooltips, the loot and draft
// modals, and Ready. Keys: Space ready, Tab ghosts, 1-9 shop, Q/E rotate, U level up, Esc cancel.
import type { Intent, Item, LordId, PlayerState, PlayerView, Seat, Slot, Squad, UnitType, Vec2 } from '../sim/types.ts';
import type { RoomView } from '../net/protocol.ts';
import { UNITS } from '../sim/data/units.ts';
import { LORDS } from '../sim/data/lords.ts';
import { inDeployZone, levelUpCost, sellRefund, ARMY_CAP, MAX_SQUAD_LEVEL, LORD_XP_LEVELS, MAX_LORD_LEVEL } from '../sim/match.ts';
import { sound } from '../audio.ts';
import type { Backend } from './backend.ts';
import type { SceneAdapter, SquadVisual } from './scene-adapter.ts';
import { $, el, esc, hideTip, num, showTipAt, store, tip, toast } from './dom.ts';
import { icon } from './icons.ts';
import { itemIcon, itemTooltip, itemTooltipPair } from './items.ts';
import { crest, squadTooltip, statBlock, countersBlock, tagIcons, unitTooltip } from './units.ts';
import { defaultFacing, dps, rarityRank, SLOT_LABEL, SLOTS, slotOpen, soldierStats, unitName, allItems } from './gamedata.ts';
import { niceError, TopBar } from './hud.ts';
import { DraftModal, LootModal } from './loot.ts';

type Drag =
  | { kind: 'place'; unit: UnitType; facing: number; fromShop: boolean; moved: boolean; pos: Vec2 | null; rot: Vec2 | null }
  | { kind: 'move'; id: number; facing: number; start: [number, number]; moved: boolean; pos: Vec2 | null; rot: Vec2 | null };

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
  private showGhosts = store.get('ghosts') !== '0';
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

  private scene: SceneAdapter;
  private backend: Backend;

  constructor(ui: HTMLElement, scene: SceneAdapter, backend: Backend) {
    this.scene = scene;
    this.backend = backend;
    this.root = el(`<div class="screen planning">
      <div class="res">
        <div class="r-gold" data-tip="Gold. Unspent gold carries over to the next round.">${icon('gold')}<b>0</b></div>
        <div class="r-deploy" data-tip="New squads you may still deploy this round. Upgrades and equipping are unlimited.">${icon('deploy')}<span><small>Deploys left</small><b>2/2</b></span></div>
        <div class="r-army" data-tip="Squads in your army (cap ${ARMY_CAP}, Lord not counted)">${icon('squads')}<b>0/${ARMY_CAP}</b></div>
        <button class="r-ghost" data-tip="Show where the enemy army stood last round [Tab]">${icon('eye')}<span>Enemy last round</span><kbd>Tab</kbd></button>
      </div>
      <div class="notices"></div>
      <aside class="sqpanel panel"></aside>
      <aside class="stash panel"><header>${icon('bag')}<b>Stash</b><small></small></header><div class="stash-grid"></div><p class="stash-hint">Drag items onto a squad or its slots. Drag here to unequip.</p></aside>
      <div class="bottom">
        <div class="deploy-badge"><small>Deploys left</small><b>2</b><span>of 2 this round</span></div>
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
    $(this.res, '.r-ghost').addEventListener('click', () => this.toggleGhosts());
    this.bind();
  }

  // ---------------------------------------------------------------- snapshot

  update(room: RoomView): void {
    this.room = room;
    const v = room.view!;
    this.view = v;
    this.me = v.you;
    this.seat = (v.seat ?? 0) as Seat;
    const newRound = v.round !== this.round;
    this.round = v.round;
    const mySeat = this.seat;
    this.names = [room.seats[mySeat]?.name ?? 'You', room.seats[1 - mySeat]?.name ?? 'Rival'];
    if (this.pending && this.me && this.me.squads.some((s) => s.id === this.pending!.id && s.pos[0] === this.pending!.pos[0] && s.pos[1] === this.pending!.pos[1])) this.pending = null;
    if (this.pending && newRound) this.pending = null;
    if (this.selected !== null && !this.me?.squads.some((s) => s.id === this.selected)) this.select(null);

    this.scene.setPerspective(v.seat);
    this.scene.setTerrain(v.terrain);
    this.scene.setKeeps(
      [mySeat === 0 ? (v.you?.keepHp ?? 0) : v.enemy.keepHp, mySeat === 0 ? v.enemy.keepHp : (v.you?.keepHp ?? 0)],
      [mySeat === 0 ? (v.you?.keepMax ?? 1) : v.enemy.keepMax, mySeat === 0 ? v.enemy.keepMax : (v.you?.keepMax ?? 1)],
    );
    this.scene.showDeployZone(this.me && !this.me.ready ? mySeat : null);
    this.drawArmy();

    const you = v.you;
    const total = Math.max(1, Math.round((room.phaseEndsAt - room.serverNow) / 1000));
    if (newRound) this.timerTotal = total;
    this.top.set(
      { name: this.names[0], lord: you?.lord ?? null, hp: you?.keepHp ?? 0, max: you?.keepMax ?? 1, ready: you?.ready },
      { name: this.names[1], lord: v.enemy.lord, hp: v.enemy.keepHp, max: v.enemy.keepMax, ready: v.enemy.ready, status: room.seats[1 - mySeat]?.botControlled ? 'AI playing' : room.seats[1 - mySeat] && !room.seats[1 - mySeat]!.connected ? 'Disconnected' : v.enemy.ready ? undefined : 'Planning…' },
      v.round, 'Planning', room.phaseEndsAt - room.serverNow + Date.now(), this.timerTotal ?? total,
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
      setTimeout(() => this.openDraft(), this.round === 1 ? 900 : 1600);
      return;
    }
    if (this.draft && (me.draftPicks === 0 || !me.draftOptions.length)) this.closeDraft();
    else if (this.draft && this.draft.key !== me.draftOptions.join(',') + ':' + me.draftPicks) this.openDraft();
    const lk = me.lootOffer ? me.lootOffer.map((i) => i.id).join(',') : '';
    if (lk && lk !== this.lootSeen && !this.draft) {
      this.lootSeen = lk;
      setTimeout(() => this.openLoot(), 1500);
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
  openDraft(): void {
    const me = this.me;
    if (!me || !me.draftPicks || !me.draftOptions.length) return;
    this.draft?.dispose();
    this.draft = new DraftModal(this.root, me, this.round, (u) => {
      this.intent({ t: 'draft', unit: u });
      toast(`${UNITS[u].name} unlocked`, 'good');
    }, () => this.closeDraft());
  }
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
    const ghosts = this.me && this.showGhosts && v.enemy.lastArmy ? v.enemy.lastArmy.map((s) => visual(s, v.enemy.lord)) : null;
    this.scene.setGhosts(ghosts);
    this.scene.setSelected(this.selected ?? this.ghostSel);
  }

  private toggleGhosts(): void {
    this.showGhosts = !this.showGhosts;
    store.set('ghosts', this.showGhosts ? '1' : '0');
    sound.click();
    if (!this.showGhosts && this.ghostSel !== null) this.ghostSel = null;
    this.drawArmy();
    this.renderRes();
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
    $(this.res, '.r-deploy b').textContent = `${left}/${me.deployLimit}`;
    $(this.res, '.r-deploy').classList.toggle('none', left === 0);
    const army = me.squads.filter((s) => s.type !== 'lord').length;
    $(this.res, '.r-army b').textContent = `${army}/${ARMY_CAP}`;
    const g = $(this.res, '.r-ghost');
    const has = !!this.view?.enemy.lastArmy;
    g.classList.toggle('on', this.showGhosts && has);
    g.classList.toggle('na', !has);
    $(g, 'span').textContent = has ? (this.showGhosts ? 'Enemy last round: shown' : 'Enemy last round: hidden') : 'No intel until round 2';
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
      this.shop.innerHTML = '<div class="spect-note">Spectating: the commanders are planning in secret.</div>';
      return;
    }
    const units = [...me.unlocked].sort((a, b) => UNITS[a].cost - UNITS[b].cost);
    const key = units.join(',') + '|' + me.gold + '|' + me.deploysUsed + '|' + me.ready + '|' + me.squads.length;
    if (this.shop.dataset.key === key) return;
    this.shop.dataset.key = key;
    this.shop.innerHTML = units
      .map((u, i) => {
        const d = UNITS[u];
        const why = this.blocked(u);
        return `<button class="ucard ${why ? 'off' : ''} ${me.gold < d.cost ? 'poor' : ''}" data-u="${u}">
          <kbd>${i < 9 ? i + 1 : ''}</kbd>
          ${crest(u, null, 'md')}
          <b>${esc(d.name)}</b>
          <div class="uc-meta"><span class="uc-cost">${icon('gold')}${d.cost}</span><span class="uc-size" data-tip="Soldiers per squad">×${d.squadSize}</span></div>
          <div class="uc-tags">${tagIcons(u)}<span class="uc-role">${esc(d.role)}</span></div>
        </button>`;
      })
      .join('');
    this.shop.querySelectorAll<HTMLElement>('.ucard').forEach((c) => {
      const u = c.dataset.u as UnitType;
      tip(c, () => {
        const why = this.blocked(u);
        return unitTooltip(u, why ? `<div class="it-hint bad">${esc(why)}</div>` : '<div class="it-hint">Drag onto your half, or click then click the field. Q/E or right-drag to rotate.</div>');
      });
      c.addEventListener('pointerenter', () => sound.hover());
      c.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        this.startPlace(u, true);
      });
    });
  }

  private renderReady(): void {
    const me = this.me;
    const v = this.view!;
    if (!me) {
      this.readyBox.innerHTML = '';
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
      h += `<button class="notice draft-n">${icon('squads')}<span><b>New recruits</b><small>Unlock ${me.draftPicks} unit type${me.draftPicks > 1 ? 's' : ''}</small></span></button>`;
    this.notices.innerHTML = h;
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

  private select(id: number | null, ghost = false): void {
    if (ghost) {
      this.ghostSel = id;
      this.selected = null;
    } else {
      this.selected = id;
      this.ghostSel = null;
    }
    this.scene.setSelected(id);
    const sq = ghost ? this.ghost(id) : this.squad(id);
    if (sq) {
      const s = soldierStats(sq.type, sq.level, sq.type === 'lord' ? (ghost ? this.view!.enemy.lord : this.me!.lord) : null);
      this.scene.setRange({ pos: sq.pos, range: s.range, minRange: s.minRange, enemy: ghost });
    } else this.scene.setRange(null);
    this.renderPanel();
  }

  private renderPanel(): void {
    const ghost = this.ghostSel !== null;
    const sq = ghost ? this.ghost(this.ghostSel) : this.squad(this.selected);
    this.root.classList.toggle('has-sel', !!sq);
    if (!sq) {
      this.panel.innerHTML = '';
      return;
    }
    const me = this.me;
    const lord = sq.type === 'lord' ? (ghost ? this.view!.enemy.lord : me!.lord) : null;
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
      lvl = `<div class="sp-pips" data-tip="Squad level (Lv3 opens Armor, Lv5 opens Relic)">${Array.from({ length: MAX_SQUAD_LEVEL }, (_, i) => `<i class="${i < sq.level ? 'on' : ''}"></i>`).join('')}<small>Lv ${sq.level}</small></div>`;
    }
    let actions = '';
    if (!ghost && me && !isLord) {
      const maxed = sq.level >= MAX_SQUAD_LEVEL;
      const cost = maxed ? 0 : levelUpCost(sq.type as UnitType, sq.level);
      const can = !maxed && me.gold >= cost && !me.ready;
      const refund = sellRefund(sq, this.round);
      actions = `<div class="sp-acts">
        <button class="btn primary lvl" ${can ? '' : 'disabled'} data-tip="${maxed ? 'Max level' : `+25% life, +20% damage${sq.level + 1 === 3 ? ', opens the Armor slot' : sq.level + 1 === 5 ? ', opens the Relic slot' : ''} [U]`}">
          ${icon('up')}<span>${maxed ? 'Max level' : `Level ${sq.level + 1}`}</span>${maxed ? '' : `<em>${icon('gold')}${cost}</em>`}</button>
        <button class="btn danger sell" ${me.ready ? 'disabled' : ''} data-tip="${refund ? 'Refunds 50% (only in the round it was deployed). Items go to your stash.' : 'No refund: deployed in an earlier round. Items go to your stash.'}">${icon('sell')}<span>Sell</span><em>${refund ? `+${refund}` : '0'}</em></button>
      </div>`;
    }
    const slots = SLOTS.map((slot) => {
      const it = sq.items[slot];
      const open = slotOpen(sq, slot);
      const lockLv = open ? 0 : slot === 'armor' ? 3 : 5;
      return `<div class="sp-slot ${open ? '' : 'locked'}" data-squad="${sq.id}" data-sslot="${slot}">${itemIcon(it, { slot, locked: lockLv, drag: !ghost && !!it, size: 'md' })}<small>${SLOT_LABEL[slot]}</small></div>`;
    }).join('');
    const def = isLord ? null : UNITS[sq.type as UnitType];
    const s = soldierStats(sq.type, sq.level, lord);
    this.panel.innerHTML = `
      <header class="sp-h">${crest(sq.type, lord, 'lg')}<div class="sp-t"><small>${ghost ? 'Enemy · last round' : sub}</small><b>${esc(name)}</b>${lvl}</div><button class="icon close" data-tip="Deselect [Esc]">${icon('close')}</button></header>
      ${actions}
      <div class="sp-sec"><small>Equipment</small><div class="sp-slots">${slots}</div></div>
      <div class="sp-sec"><small>Per soldier${!isLord ? ` · squad DPS ${(dps(s.dmg, s.attackTicks) * s.size).toFixed(0)}` : ''}</small>${statBlock(sq.type, sq.level, lord)}</div>
      ${isLord ? `<div class="sp-sec lt"><div class="lt-pass"><small>Passive</small>${esc(LORDS[lord!].passive)}</div><div class="lt-abil"><small>${esc(LORDS[lord!].abilityName)}</small>${esc(LORDS[lord!].abilityText)}</div></div>` : ''}
      ${def ? `<details class="sp-sec ctr-d" ${store.get('ctr') === '1' ? 'open' : ''}><summary>Counters</summary>${countersBlock(def.id)}</details>` : ''}
      ${!ghost ? '<p class="sp-hint">Drag on the field to move · Q/E rotate</p>' : ''}`;
    this.panel.querySelector('.close')!.addEventListener('click', () => this.select(null));
    this.panel.querySelector('.lvl')?.addEventListener('click', () => this.levelUp());
    this.panel.querySelector('.sell')?.addEventListener('click', () => this.sell());
    this.panel.querySelector('.ctr-d')?.addEventListener('toggle', (e) => store.set('ctr', (e.target as HTMLDetailsElement).open ? '1' : '0'));
    this.panel.querySelectorAll<HTMLElement>('.sp-slot').forEach((slotEl) => {
      const slot = slotEl.dataset.sslot as Slot;
      const it = sq.items[slot];
      if (it) tip(slotEl, () => itemTooltip(it, { hint: ghost ? undefined : 'Drag to another squad or to the stash' }));
    });
  }

  private levelUp(): void {
    const sq = this.squad(this.selected);
    if (!sq || sq.type === 'lord') return;
    sound.levelUp();
    this.intent({ t: 'levelUp', squad: sq.id });
  }

  private sell(): void {
    const sq = this.squad(this.selected);
    if (!sq || sq.type === 'lord') return;
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
        if (sel && slotOpen(sel, it.slot)) return itemTooltipPair(it, sel.items[it.slot], `Click to equip on ${unitName(sel.type, this.me!.lord)}`);
        return itemTooltip(it, { hint: 'Drag onto a squad to equip' });
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
    const fit = () => this.scene.setInsets({ top: this.root.querySelector('.topbar')?.getBoundingClientRect().height ?? 0, bottom: $(this.root, '.bottom').getBoundingClientRect().height * 0.6 });
    fit();
    on(window, 'resize', fit);
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

  private down(e: PointerEvent): void {
    if (!this.me) return;
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
      const sq = hit ? (hit.ghost ? this.ghost(hit.id) : this.squad(hit.id)) : null;
      showTipAt(e.clientX, e.clientY, sq ? squadTooltip(sq, sq.type === 'lord' ? (hit!.ghost ? this.view!.enemy.lord : this.me?.lord ?? null) : null, { ghost: hit!.ghost, hint: hit!.ghost ? undefined : 'Click to select · drag to move' }) : null);
      this.scene.canvas.style.cursor = sq ? (hit!.ghost ? 'help' : 'grab') : '';
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
    const valid = inDeployZone(this.seat, d.pos) && (d.kind === 'move' || !this.blocked(d.unit));
    this.scene.setPreview({ type, lord: type === 'lord' ? me.lord : null, seat: this.seat, pos: d.pos, facing: d.facing, valid });
    const s = soldierStats(type, lvl, me.lord);
    this.scene.setRange({ pos: d.pos, range: s.range, minRange: s.minRange });
    this.hint.innerHTML = `${valid ? '' : `<b class="bad">${esc(inDeployZone(this.seat, d.pos) ? (d.kind === 'place' ? this.blocked(d.unit) ?? '' : '') : 'Outside your deploy zone')}</b> · `}<kbd>Q</kbd><kbd>E</kbd> or right-drag to rotate · <kbd>Esc</kbd> cancel`;
    this.hint.classList.add('on');
  }

  private overCanvas = true;

  private up(e: PointerEvent): void {
    if (this.itemDrag) return this.dropItem(e);
    const d = this.drag;
    const pc = this.pendingClick;
    this.pendingClick = null;
    if (!d) {
      if (pc && e.button === 0 && Math.hypot(e.clientX - pc.x, e.clientY - pc.y) < 6 && e.target === this.scene.canvas) {
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
        if (!inDeployZone(this.seat, d.pos)) this.rejected('outside deploy zone');
        else {
          sound.drop();
          this.pending = { id: d.id, pos: d.pos, facing: d.facing };
          this.intent({ t: 'move', squad: d.id, pos: d.pos, facing: d.facing });
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
      this.hint.innerHTML = `Click your half of the field to deploy ${esc(UNITS[d.unit].name)} · <kbd>Q</kbd><kbd>E</kbd> rotate · <kbd>Esc</kbd> cancel`;
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
    sound.deploy();
    this.intent({ t: 'deploy', unit: u, pos, facing });
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
      this.toggleGhosts();
    } else if (e.key === 'Escape') {
      if (this.drag) this.endDrag();
      else this.select(null);
    } else if ((k === 'q' || k === 'e') && (this.drag || this.selected !== null)) {
      e.stopPropagation();
      const step = (k === 'q' ? 16 : -16) * (this.seat === 0 ? 1 : 1);
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
    } else if (/^[1-9]$/.test(e.key) && this.me) {
      const units = [...this.me.unlocked].sort((a, b) => UNITS[a].cost - UNITS[b].cost);
      const u = units[Number(e.key) - 1];
      if (u) {
        this.startPlace(u, false);
        this.drag && ((this.drag as { fromShop: boolean }).fromShop = false);
        this.hint.innerHTML = `Click your half of the field to deploy ${esc(UNITS[u].name)} · <kbd>Q</kbd><kbd>E</kbd> rotate · <kbd>Esc</kbd> cancel`;
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
      this.root.querySelectorAll<HTMLElement>(`.sp-slot[data-sslot="${d.item.slot}"]:not(.locked)`).forEach((s) => s.classList.add('drop-ok'));
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
      if (sq) {
        const open = slotOpen(sq, d.item.slot);
        showTipAt(e.clientX, e.clientY, open ? itemTooltipPair(d.item, sq.items[d.item.slot], `Drop to equip on ${unitName(sq.type, this.me!.lord)}`) : `<div class="tip-plain bad">${esc(unitName(sq.type, this.me!.lord))}: ${SLOT_LABEL[d.item.slot]} slot opens at level ${d.item.slot === 'armor' ? 3 : 5}</div>`);
      } else showTipAt(e.clientX, e.clientY, null);
    } else {
      this.scene.setHovered(null);
      const slotEl = (under as HTMLElement | null)?.closest?.<HTMLElement>('.sp-slot');
      if (slotEl && slotEl.dataset.sslot === d.item.slot && !slotEl.classList.contains('locked')) {
        const sq = this.squad(Number(slotEl.dataset.squad));
        showTipAt(e.clientX, e.clientY, sq ? itemTooltipPair(d.item, sq.items[d.item.slot], 'Drop to equip') : null);
      } else showTipAt(e.clientX, e.clientY, null);
    }
  }

  private dropItem(e: PointerEvent): void {
    const d = this.itemDrag!;
    const me = this.me;
    if (!d.started) {
      // a click: quick-equip a stash item on the selected squad
      const sel = this.squad(this.selected);
      if (d.from === null && sel && me) {
        if (slotOpen(sel, d.item.slot)) {
          sound.equip();
          this.intent({ t: 'equip', item: d.item.id, squad: sel.id });
        } else this.rejected(`${d.item.slot} slot opens at level ${d.item.slot === 'armor' ? 3 : 5}`);
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
      if (sq && !slotOpen(sq, d.item.slot)) this.rejected(`${d.item.slot} slot opens at level ${d.item.slot === 'armor' ? 3 : 5}`);
      else if (sq) {
        sound.equip();
        this.intent({ t: d.from === null ? 'equip' : 'moveItem', item: d.item.id, squad: target });
        if (this.selected === null) this.select(target);
      }
    }
    this.cancelItem();
  }

  private cancelItem(): void {
    const d = this.itemDrag;
    if (!d) return;
    d.el?.remove();
    this.itemDrag = null;
    this.root.classList.remove('item-dragging');
    this.root.querySelectorAll('.drop-ok').forEach((n) => n.classList.remove('drop-ok'));
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
