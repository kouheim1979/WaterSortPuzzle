'use strict';

// CI only: the game itself remains a single, dependency-free HTML file.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');

const htmlPath = process.argv.find(arg => arg.endsWith('.html')) || 'index.html';
const html = fs.readFileSync(htmlPath, 'utf8');
const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)];
assert.equal(scripts.length, 1, 'The game must have one inline script');
assert.ok(!/\bsrc\s*=/i.test(scripts[0][1]), 'External scripts are forbidden');
assert.ok(!/<(?:link|img|iframe|audio|video)\b[^>]*(?:src|href)\s*=/i.test(html), 'External assets are forbidden');
assert.ok(!/@import\b|url\(\s*['"]?https?:/i.test(html), 'External CSS assets are forbidden');
const source = scripts[0][2];
assert.ok(!/\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon)\s*\(/.test(source), 'The game must work without network requests');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'watersort-check-'));
try {
  const scriptPath = path.join(temp, 'app.js');
  fs.writeFileSync(scriptPath, source);
  execFileSync(process.execPath, ['--check', scriptPath], { stdio: 'inherit' });
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
console.log('PASS inline JavaScript: node --check');
if (process.argv.includes('--syntax-only')) process.exit(0);

const boot = "document.addEventListener('DOMContentLoaded',()=>new App().init(),{once:true});";
assert.equal(source.split(boot).length, 2, 'The boot marker must occur exactly once');
const exposed = source.replace(boot, 'this.testAPI={K,FIXED_SEEDS,Bottle,StageManager,GameState,HintManager,SolutionPlanner,StorageManager,SettingsManager,App};');
const context = vm.createContext({ console });
vm.runInContext(exposed, context, { timeout: 10000 });
const { K, FIXED_SEEDS, StageManager, GameState, HintManager, SolutionPlanner } = context.testAPI;
const plain = value => JSON.parse(JSON.stringify(value));
const same = (actual, expected, message) => assert.deepEqual(plain(actual), plain(expected), message);
const stages = [];

for (let level = 1; level <= 20; level++) {
  const stage = new StageManager().load(level);
  assert.equal(StageManager.validate(stage).ok, true, `Stage ${level}`);
  assert.equal(StageManager.validate(stage).solvedAt, stage.solution.length, 'The proof ends at the first clear');
  const cfg = StageManager.config(StageManager.difficulty(level));
  assert.equal(stage.bottles.length, cfg.colors + cfg.empty);
  assert.equal(stage.bottles.filter(b => !b.length).length, cfg.empty);
  assert.ok(StageManager.mixed(stage.bottles) >= cfg.minMixed);
  assert.equal(StageManager.solved(stage.bottles), false);
  // Replay the proof using the actual gameplay move implementation, not only
  // the generator's own validator. This catches mismatched pour semantics.
  const game = new GameState(stage);
  for (const move of stage.solution) {
    const before = game.bottles[move.to].length;
    assert.equal(game.move(move.from, move.to), true, `Stage ${level}: legal proof move`);
    assert.equal(game.bottles[move.to].length - before, move.count);
  }
  assert.equal(game.clear, true, `Stage ${level}: proof reaches completion`);
  stages.push(stage);
}
same(StageManager.buildRandom('easy', FIXED_SEEDS[0]).bottles, stages[0].bottles, 'Fixed seed is deterministic');
assert.equal(StageManager.validateAllFixedStages(), true);
console.log('PASS Stage 1–20: mixed boards, exact counts, legal gameplay solutions');

for (const diff of Object.keys(K.DIFF)) {
  for (const seed of [1, 2, 20260908, 0xffffffff]) {
    const stage = StageManager.buildRandom(diff, seed);
    assert.ok(stage && StageManager.validate(stage).ok, `Random ${diff}, seed ${seed}`);
    assert.equal(StageManager.validate(stage).solvedAt, stage.solution.length, 'Random proof has no post-clear moves');
  }
}
assert.equal(StageManager.validate({ ...stages[0], solution: undefined }).ok, false);
assert.equal(StageManager.validate({ ...stages[0], solution: [] }).ok, false);
const brokenPath = plain(stages[0]);
brokenPath.solution[0].count++;
assert.equal(StageManager.validate(brokenPath).ok, false);
console.log('PASS random generation and rejection of missing/broken solutions');

function solvedGame(level = 1) {
  const stage = stages[level - 1];
  const game = new GameState(stage);
  for (const m of stage.solution) assert.ok(game.move(m.from, m.to));
  return game;
}

const game = new GameState(stages[0]);
const initial = game.snapshot();
assert.ok(game.addExtra().ok);
assert.equal(game.coins, 80);
assert.equal(game.extraCount, 1);
assert.equal(game.bottles.length, 7);
assert.ok(game.useHint());
assert.equal(game.coins, 70);
assert.ok(game.undo());
assert.equal(game.coins, 80);
assert.ok(game.undo());
same(game.snapshot(), initial, 'Undo refunds both purchases and removes extra bottles');
assert.ok(!game.undo());
for (let i = 0; i < 3; i++) assert.ok(game.addExtra().ok);
assert.ok(!game.addExtra().ok);
assert.ok(game.useHint());
game.restart();
assert.equal(game.coins, 30, 'Restart does not refund purchases');
assert.equal(game.extraCount, 0);
assert.equal(game.history.length, 0);
same(game.bottles.map(b => b.toJSON()), stages[0].bottles);
const poor = new GameState(stages[0], { coins: 9 });
assert.ok(!poor.useHint());
assert.ok(!poor.addExtra().ok);
assert.equal(poor.history.length, 0);
console.log('PASS multi-Undo, Hint refunds, Extra refunds/limit, Restart and insufficient coins');

for (const level of [1, 20]) {
  const won = solvedGame(level);
  const reward = level === 20 ? 120 : 20;
  assert.equal(won.claimClear(), reward);
  assert.equal(won.claimClear(), null);
  assert.equal(won.coins, 100 + reward);
  const restored = GameState.fromSaved(plain(won.toJSON()));
  assert.equal(restored.claimClear(), null, 'Reload cannot claim twice');
  assert.ok(won.undo());
  assert.equal(won.coins, 100);
  assert.ok(!won.completedStages.has(level));
  assert.equal(won.campaignBonusClaimed, false);
  const last = stages[level - 1].solution.at(-1);
  assert.ok(won.move(last.from, last.to));
  assert.equal(won.claimClear(), reward);
  won.restart();
  for (const m of stages[level - 1].solution) assert.ok(won.move(m.from, m.to));
  assert.equal(won.claimClear(), 0, 'Restart and re-clear cannot claim twice');
  assert.equal(won.coins, 100 + reward);
}
console.log('PASS clear rewards, Stage 20 bonus, Undo/re-clear and reload without duplicate rewards');

const valid = plain(new GameState(stages[0]).toJSON());
same(GameState.fromSaved(valid).toJSON(), valid);
const withExtra = new GameState(stages[0]);
withExtra.addExtra();
same(GameState.fromSaved(plain(withExtra.toJSON())).toJSON(), withExtra.toJSON());
const legacy = { ...valid, version: 2, initial: valid.initialBottles };
delete legacy.initialBottles;
assert.equal(GameState.fromSaved(legacy).level, 1);
const legacyClear = { ...plain(solvedGame(20).toJSON()), version: 2, rewardGranted: true };
legacyClear.initial = legacyClear.initialBottles;
delete legacyClear.initialBottles;
const migrated = GameState.fromSaved(legacyClear);
assert.ok(migrated.completedStages.has(20));
assert.ok(migrated.campaignBonusClaimed);
assert.equal(migrated.claimClear(), null);

const badSaves = [
  null, {}, { ...valid, coins: -1 }, { ...valid, coins: 1.2 },
  { ...valid, level: Number.MAX_SAFE_INTEGER }, { ...valid, difficulty: 'expert' },
  { ...valid, bottles: [[], [], [], [], [], []] },
  { ...valid, initialBottles: [[], [], [], [], [], []] },
  { ...valid, extraCount: 1 }, { ...valid, extraCount: '0' },
  { ...valid, stageCleared: true }, { ...valid, completedStages: ['1'] },
  { ...valid, campaignBonusClaimed: 'true' }
];
const missingColor = plain(valid);
missingColor.bottles[0].pop();
badSaves.push(missingColor);
const wrongColor = plain(valid);
wrongColor.bottles[0][0] = 'ultraviolet';
badSaves.push(wrongColor);
for (const data of badSaves) assert.throws(() => GameState.fromSaved(data));
console.log('PASS save validation, v2 migration and corrupted boards/counts/flags');

const hints = new HintManager();
const hintGame = new GameState(stages[0]);
const hint = hints.find(hintGame);
assert.ok(hint && hintGame.canMove(hint.from, hint.to));
const repeat = hintGame.bottles.map(b => b.toJSON());
StageManager.moveArray(repeat, hint.from, hint.to);
hintGame.history.push({ bottles: repeat });
const alternative = hints.find(hintGame);
assert.ok(!alternative || alternative.from !== hint.from || alternative.to !== hint.to, 'Hint avoids a previously visited board');
assert.equal(hints.find(solvedGame()), null, 'No hints from finished bottles');
console.log('PASS useful legal hints and avoidance of repeated boards');

// A small DOM adapter runs the real App boot/events without browser dependencies.
// This checks application behavior; it does not claim to verify visual layout.
function runtime(saved, { blockedStorage = false, legacyKey = false } = {}) {
  const elements = new Map();
  class Element {
    constructor(tag = 'div') {
      this.tag = tag;
      this.dataset = {};
      this.children = [];
      this.className = '';
      this.textContent = '';
      this.listeners = new Map();
      this.style = { setProperty() {} };
      this.classList = {
        contains: c => this.className.split(/\s+/).includes(c),
        add: (...cs) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...cs])].join(' '); },
        remove: (...cs) => { this.className = this.className.split(/\s+/).filter(c => !cs.includes(c)).join(' '); },
        toggle: (c, on) => { if (on) this.classList.add(c); else this.classList.remove(c); }
      };
    }
    set innerHTML(value) { this.children = []; this.textContent = value; }
    append(...nodes) { this.children.push(...nodes); }
    appendChild(node) { this.append(node); return node; }
    setAttribute(k, v) { this[k] = v; }
    focus() { document.activeElement = this; }
    querySelector() { return null; }
    querySelectorAll() { return []; }
    addEventListener(k, fn) { const list = this.listeners.get(k) || []; list.push(fn); this.listeners.set(k, list); }
    remove() {}
    getBoundingClientRect() { return { left: 0, top: 0, width: 58, height: 170 }; }
  }
  for (const m of html.matchAll(/<([\w-]+)\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
    const el = new Element(m[1]);
    el.className = /\bclass="([^"]*)"/.exec(m[0])?.[1] || '';
    elements.set(m[2], el);
  }
  const timers = new Map();
  let timerId = 0;
  const events = new Map();
  const values = new Map();
  if (saved !== undefined) values.set(legacyKey ? 'watersort_game_v2' : K.SAVE_KEY, typeof saved === 'string' ? saved : JSON.stringify(saved));
  const document = {
    body: new Element('body'), documentElement: new Element('html'),
    getElementById: id => elements.get(id) || null,
    createElement: tag => new Element(tag),
    addEventListener: (name, fn) => { const list = events.get(name) || []; list.push(fn); events.set(name, list); },
    querySelectorAll: selector => selector.includes('.bottle') ? elements.get('grid').children.filter(b => b.classList.contains('hint-from') || b.classList.contains('hint-to')) : [],
    querySelector: selector => { const i = /data-i="(\d+)"/.exec(selector)?.[1]; return elements.get('grid').children.find(b => String(b.dataset.i) === i) || null; }
  };
  const localStorage = {
    getItem(k) { if (blockedStorage) throw Error('Storage unavailable'); return values.get(k) ?? null; },
    setItem(k, v) { if (blockedStorage) throw Error('Storage unavailable'); values.set(k, v); },
    removeItem(k) { values.delete(k); }
  };
  const sandbox = vm.createContext({
    document, localStorage, window: { addEventListener() {} }, navigator: {}, confirm: () => true,
    console: { info() {}, warn() {}, error: console.error },
    setTimeout: (fn, ms) => { timers.set(++timerId, { fn, ms }); return timerId; },
    clearTimeout: id => timers.delete(id)
    ,setInterval() { return 1; }, clearInterval() {}
  });
  // Deliberately omit structuredClone and Object.hasOwn to cover older Safari.
  vm.runInContext('Object.hasOwn=undefined;', sandbox);
  vm.runInContext(source.replace(boot, `${boot}\nthis.testAPI={App,GameState};`), sandbox, { timeout: 10000 });
  return {
    sandbox, document, elements, events, timers, values,
    boot() { const listeners = events.get('DOMContentLoaded'); assert.equal(listeners.length, 1); listeners[0](); },
    flushClear() { for (const [id, t] of [...timers]) if (t.ms === 420) { timers.delete(id); t.fn(); } },
    createApp() { const app = new sandbox.testAPI.App(); app.init(); return app; }
  };
}

async function checkApp() {
  for (const saved of [undefined, '{broken json', ...badSaves]) {
    const rt = runtime(saved);
    rt.boot();
    assert.equal(rt.elements.get('stageTitle').textContent, 'Stage 1');
    assert.equal(rt.elements.get('grid').children.length, 6, 'Boot renders six bottles even after save corruption');
    assert.equal(rt.elements.get('coinValue').textContent, 100);
  }
  runtime(undefined, { blockedStorage: true }).boot();
  const v2 = runtime(legacy, { legacyKey: true });
  v2.boot();
  assert.equal(JSON.parse(v2.values.get(K.SAVE_KEY)).version, K.SAVE_VERSION);

  const won = solvedGame();
  won.claimClear();
  const reloaded = runtime(won.toJSON());
  reloaded.boot();
  assert.equal(reloaded.elements.get('clearModal').classList.contains('hidden'), false, 'Reload restores Next Stage modal');
  reloaded.elements.get('nextBtn').listeners.get('click')[0]();
  assert.equal(reloaded.elements.get('stageTitle').textContent, 'Stage 2');
  assert.equal(reloaded.elements.get('coinValue').textContent, 120);
  assert.equal(reloaded.elements.get('clearModal').classList.contains('hidden'), true);
  assert.equal(reloaded.elements.get('grid').listeners.get('click').length, 1);

  const rt = runtime();
  const app = rt.createApp();
  rt.elements.get('closeHelpBtn').listeners.get('click')[0]();
  const solution = stages[0].solution;
  for (const move of solution) assert.ok(app.state.move(move.from, move.to));
  app.checkWin();
  assert.equal(rt.elements.get('coinValue').textContent, 120, 'Reward is rendered immediately');
  app.undo();
  rt.flushClear();
  assert.equal(rt.elements.get('clearModal').classList.contains('hidden'), true, 'Undo cancels stale clear timer');
  assert.equal(app.state.coins, 100);
  const last = solution.at(-1);
  app.state.move(last.from, last.to);
  app.checkWin();
  app.restart();
  rt.elements.get('confirmYesBtn').listeners.get('click')[0]();
  rt.flushClear();
  assert.equal(rt.elements.get('clearModal').classList.contains('hidden'), true, 'Restart cancels stale clear timer');
  assert.equal(app.state.coins, 120);

  const first = solution[0];
  app.anim.pour = async () => { throw Error('Animation interrupted'); };
  await app.tap(first.from);
  await app.tap(first.to);
  assert.equal(app.busy, false, 'Animation failure cannot leave the game locked');
  assert.equal(app.state.history.length, 1);
  const before = app.state;
  app.busy = true;
  app.random();
  app.reset();
  assert.equal(app.state, before, 'Stage cannot change during a pour');
  console.log('PASS App boot, corrupt/blocked storage, saved clear -> Next Stage, clear timer cancellation, event count and animation recovery');
}

async function checkAtelier() {
  const resumed = new GameState(stages[0]);
  resumed.addExtra(); resumed.useHint(); resumed.move(stages[0].solution[0].from, stages[0].solution[0].to);
  const restored = GameState.fromSaved(plain(resumed.toJSON()));
  assert.equal(restored.history.length, 3);
  assert.ok(restored.undo()); assert.ok(restored.undo()); assert.ok(restored.undo());
  assert.equal(restored.coins, 100); assert.equal(restored.extraCount, 0); assert.equal(restored.moves, 0);
  same(restored.bottles.map(b => b.toJSON()), stages[0].bottles);
  const oldV3 = { ...valid, version: 3 }; delete oldV3.solution; delete oldV3.history;
  assert.equal(GameState.fromSaved(oldV3).version, undefined);
  assert.equal(GameState.fromSaved(oldV3).toJSON().version, 4);
  const completed = solvedGame(6); completed.claimClear();
  const replay = new GameState(stages[0], { coins: completed.coins, completedStages: [1,2,3,4,5,6], records: completed.records });
  assert.equal(GameState.fromSaved(plain(replay.toJSON())).level, 1, 'Replay accepts completion records from later stages');
  const daily = new StageManager().daily('2026-10-03');
  same(daily.bottles, new StageManager().daily('2026-10-03').bottles, 'Daily date is deterministic');
  assert.ok(StageManager.validate(daily).ok);
  const dayGame = new GameState(daily);
  for(const m of daily.solution) assert.ok(dayGame.move(m.from,m.to));
  assert.equal(dayGame.claimClear(), 20); assert.equal(dayGame.completedStages.size, 0);
  const dayReload = GameState.fromSaved(plain(dayGame.toJSON()));
  dayReload.restart(); for(const m of daily.solution) assert.ok(dayReload.move(m.from,m.to));
  assert.equal(dayReload.claimClear(), 0, 'Daily reward once per date');
  const practice = new GameState({ ...stages[0], mode:'practice' });
  for(const m of stages[0].solution) assert.ok(practice.move(m.from,m.to));
  assert.equal(practice.claimClear(), 0); assert.equal(practice.completedStages.size, 0);
  const won = solvedGame(); won.claimClear();
  assert.equal(won.records['c:1'].stars, 3); assert.equal(won.records['c:1'].moves, won.moves);
  const assisted = new GameState(stages[0]); assisted.useHint();
  for(const m of stages[0].solution) assert.ok(assisted.move(m.from,m.to));
  assisted.claimClear(); assert.equal(assisted.stars, 1);
  const badHistory = plain(valid); badHistory.history = [{ bottles: [[],[],[],[],[],[]], coins:100, extraCount:0 }];
  assert.throws(()=>GameState.fromSaved(badHistory));
  const invalidProof = plain(valid); invalidProof.solution[0].count++;
  assert.throws(()=>GameState.fromSaved(invalidProof));
  for(const stage of stages) {
    const result = await SolutionPlanner.solve(stage.bottles, {maxNodes:50000,maxMs:2000,yieldEvery:0});
    const path = result.path || SolutionPlanner.proof(new GameState(stage));
    assert.ok(path?.length, `Solver/proof Stage ${stage.level}`);
    const game = new GameState(stage);
    for(const m of path) assert.ok(game.move(m.from,m.to));
    assert.ok(game.clear, `Solver verified Stage ${stage.level}`);
  }
  const impossible=[['red','blue'],['blue','red']];
  const result=await SolutionPlanner.solve(impossible,{yieldEvery:0});
  assert.equal(result.status,'deadend');
  console.log('PASS persisted Undo, v3 migration, replay, daily/practice reward isolation, stars, save proof and bounded solver');
}

(async()=>{await checkApp();await checkAtelier();})().catch(error => { console.error(error); process.exitCode = 1; });
