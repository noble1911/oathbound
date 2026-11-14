// The showcase's control panel: tier selector, stats, battle transport, camera and VFX buttons.
import type { BattleView, QualityTier } from '../render/index.ts';

export interface PanelOpts {
  tiers: (QualityTier | 'auto')[];
  tier: QualityTier | 'auto';
  onTier: (t: QualityTier | 'auto') => void;
  modes: Record<string, () => void>;
  actions: Record<string, () => void>;
}

const CSS = `
#rt-panel { position: fixed; top: 12px; left: 12px; width: 268px; z-index: 10; font: 12px/1.45 ui-sans-serif, system-ui, "Segoe UI", sans-serif;
  color: #e9e1cf; background: linear-gradient(180deg, rgba(24,20,28,.86), rgba(14,12,18,.86)); border: 1px solid rgba(217,180,90,.35);
  border-radius: 8px; padding: 10px 12px; box-shadow: 0 8px 30px rgba(0,0,0,.45); backdrop-filter: blur(6px); user-select: none; }
#rt-panel h1 { font: 600 14px/1.2 Georgia, "Times New Roman", serif; letter-spacing: .08em; margin: 0 0 8px; color: #e8c66f; text-transform: uppercase; }
#rt-panel .row { display: flex; flex-wrap: wrap; gap: 4px; margin: 6px 0; align-items: center; }
#rt-panel button, #rt-panel select { background: rgba(255,255,255,.06); color: #efe6d2; border: 1px solid rgba(217,180,90,.28); border-radius: 4px;
  padding: 3px 7px; font: inherit; cursor: pointer; }
#rt-panel button:hover { background: rgba(217,180,90,.18); }
#rt-panel button.on { background: rgba(217,180,90,.32); border-color: #d9b45a; }
#rt-panel .lbl { color: #a89f8d; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; margin-top: 8px; }
#rt-panel .stats { font: 11px/1.5 ui-monospace, Consolas, monospace; color: #cfe3c0; white-space: pre; }
#rt-panel input[type=range] { width: 100%; accent-color: #d9b45a; }
#rt-panel .hide { position: absolute; top: 6px; right: 8px; padding: 0 6px; }
#rt-hint { position: fixed; bottom: 18px; left: 50%; transform: translateX(-50%); z-index: 10; font: 600 13px Georgia, serif; color: #f1e2b8;
  background: rgba(14,12,18,.7); border: 1px solid rgba(217,180,90,.4); padding: 6px 14px; border-radius: 6px; display: none; }
`;

export function mountPanel(root: HTMLElement, view: BattleView, o: PanelOpts): void {
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);
  const p = document.createElement('div');
  p.id = 'rt-panel';
  p.innerHTML = `<h1>Oathbound · Render</h1><button class="hide" title="hide">–</button>
  <div class="row"><span class="lbl" style="margin:0">Quality</span><select class="tier">${o.tiers.map((t) => `<option ${t === o.tier ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
  <div class="row"><label><input type="checkbox" class="saver" /> Battery saver</label><select class="cap"><option value="0">vsync</option><option value="60">60 fps</option><option value="30">30 fps</option></select></div>
  <div class="stats">…</div>
  <div class="lbl">Scene</div><div class="row modes"></div>
  <div class="lbl">Battle</div>
  <div class="row"><button class="play">❚❚</button><button data-speed="0.5">½×</button><button data-speed="1" class="on">1×</button><button data-speed="2">2×</button><button data-speed="4">4×</button></div>
  <input type="range" class="scrub" min="0" max="1000" value="0" />
  <div class="row"><button class="cam-dir on">Director</button><button class="cam-free">Free cam</button></div>
  <div class="lbl">VFX samples (at camera target)</div><div class="row fx"></div>`;
  root.appendChild(p);
  const hint = document.createElement('div');
  hint.id = 'rt-hint';
  hint.textContent = 'Free camera — press C to return to the director';
  root.appendChild(hint);

  const $ = <T extends HTMLElement>(s: string) => p.querySelector(s) as T;
  $<HTMLSelectElement>('.tier').onchange = (e) => o.onTier((e.target as HTMLSelectElement).value as QualityTier | 'auto');
  for (const [name, fn] of Object.entries(o.modes)) {
    const b = document.createElement('button');
    b.textContent = name;
    b.onclick = fn;
    $('.modes').appendChild(b);
  }
  for (const [name, fn] of Object.entries(o.actions)) {
    const b = document.createElement('button');
    b.textContent = name;
    b.onclick = fn;
    $('.fx').appendChild(b);
  }
  $('.hide').onclick = () => {
    const hidden = p.dataset.min === '1';
    p.dataset.min = hidden ? '0' : '1';
    for (const el of p.children) if (!(el as HTMLElement).classList.contains('hide') && el.tagName !== 'H1') (el as HTMLElement).style.display = hidden ? '' : 'none';
  };
  $('.play').onclick = () => {
    const pb = view.battle;
    if (!pb) return;
    pb.playing = !pb.playing;
    view.engine.wake();
  };
  p.querySelectorAll<HTMLButtonElement>('[data-speed]').forEach((b) => {
    b.onclick = () => {
      if (view.battle) view.battle.speed = Number(b.dataset.speed);
      p.querySelectorAll('[data-speed]').forEach((x) => x.classList.toggle('on', x === b));
    };
  });
  const scrub = $<HTMLInputElement>('.scrub');
  scrub.oninput = () => {
    const pb = view.battle;
    if (pb) pb.seek((Number(scrub.value) / 1000) * pb.durationMs);
    view.engine.wake();
  };
  const saver = $<HTMLInputElement>('.saver');
  saver.checked = view.engine.batterySaver;
  saver.onchange = () => view.setBatterySaver(saver.checked);
  const cap = $<HTMLSelectElement>('.cap');
  cap.value = String(view.engine.fpsCap);
  cap.onchange = () => view.setFpsCap(Number(cap.value) as 0 | 30 | 60);
  let lastFrames = view.engine.frames;
  let lastT = performance.now();
  $('.cam-dir').onclick = () => view.setCameraMode('director');
  $('.cam-free').onclick = () => view.setCameraMode('free');
  view.camera.onUserControl = () => (hint.style.display = 'block');
  view.camera.onReturnToDirector = () => (hint.style.display = 'none');

  setInterval(() => {
    const s = view.stats;
    const pb = view.battle;
    const now = performance.now();
    const drawn = ((view.engine.frames - lastFrames) * 1000) / (now - lastT);
    lastFrames = view.engine.frames;
    lastT = now;
    $('.stats').textContent =
      `${drawn.toFixed(0).padStart(3)} frames/s drawn  gpu ${s.gpuMs >= 0 ? s.gpuMs.toFixed(2) + ' ms' : 'n/a'}\n` +
      `draws ${s.drawCalls}  tris ${(s.triangles / 1e6).toFixed(2)}M\n` +
      `soldiers ${s.soldiers}  heroes ${s.heroes}\n` +
      `tier ${s.tier}${s.auto ? ' (auto)' : ''}  ${s.width}×${s.height}\n` +
      `cam ${view.camera.mode}${pb ? `  t ${(pb.timeMs / 1000).toFixed(1)}s` : ''}\n` +
      `${s.gpu.replace(/^ANGLE \(|\)$/g, '').slice(0, 40)}`;
    if (pb && document.activeElement !== scrub) scrub.value = String(Math.round((pb.timeMs / pb.durationMs) * 1000));
    $('.play').textContent = pb?.playing ? '❚❚' : '▶';
    $('.cam-dir').classList.toggle('on', view.camera.mode === 'director');
    $('.cam-free').classList.toggle('on', view.camera.mode === 'free');
    if (view.camera.mode !== 'free') hint.style.display = 'none';
  }, 400);
}
