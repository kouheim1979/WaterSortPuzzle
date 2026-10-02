'use strict';

// Development/CI dependency only. Nothing is added to the shipped HTML.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const vm = require('node:vm');
const playwright = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const html = fs.readFileSync('index.html', 'utf8');
const source = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const boot = "document.addEventListener('DOMContentLoaded',()=>new App().init(),{once:true});";
const sandbox = vm.createContext({ console });
vm.runInContext(source.replace(boot, 'this.api={K,GameState,StageManager};'), sandbox);
const { K, GameState, StageManager } = sandbox.api;
const settings = { sound:false, vibration:false, motion:false, labels:false, helpSeen:true, theme:'Purple', speed:'Fast' };
const outputs = process.env.BROWSER_ARTIFACTS || '_browser-artifacts';
fs.mkdirSync(outputs, { recursive:true });
const stages = [1,6,11,16].map(level => new StageManager().load(level));
const viewports = [{width:320,height:568},{width:390,height:844},{width:430,height:932},{width:768,height:1024},{width:1280,height:800},{width:844,height:390}];
const server = http.createServer((req,res) => {
  if(req.url==='/favicon.ico'){res.writeHead(204);res.end();return}
  res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'});res.end(html);
});
const saved = page => page.evaluate(key => JSON.parse(localStorage.getItem(key)), K.SAVE_KEY);
async function until(page, predicate, arg){await page.waitForFunction(predicate, arg, { timeout:10000 })}
async function createPage(browser, url, state, viewport={width:390,height:844}, options={}){
  const context = await browser.newContext({ viewport, reducedMotion:'reduce', ...options });
  const page = await context.newPage();
  const errors = [], outside = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', req => {if(!req.url().startsWith(url))outside.push(req.url())});
  await page.addInitScript(({key,settingsKey,state,settings}) => {
    if(!sessionStorage.getItem('seeded')){
      localStorage.setItem(settingsKey, JSON.stringify(settings));
      if(state!==undefined)localStorage.setItem(key, typeof state==='string'?state:JSON.stringify(state));
      sessionStorage.setItem('seeded','1');
    }
  }, {key:K.SAVE_KEY, settingsKey:K.SETTINGS_KEY, state, settings});
  await page.goto(url);
  await page.locator('.bottle').first().waitFor();
  return {page,context,errors,outside};
}
async function verifySession(session){
  assert.deepEqual(session.errors, [], 'No browser runtime errors');
  assert.deepEqual(session.outside, [], 'No external requests');
  await session.context.close();
}
async function playRoute(page, route){
  let moves = (await saved(page)).moves;
  for(const move of route){
    await page.locator(`.bottle[data-i="${move.from}"]`).click();
    await page.locator(`.bottle[data-i="${move.to}"]`).click();
    moves++;
    await until(page, ({key,moves}) => JSON.parse(localStorage.getItem(key)).moves===moves, {key:K.SAVE_KEY,moves});
  }
  await page.locator('#clearModal').waitFor({state:'visible'});
}
async function runEngine(engine, url){
  const browser = await playwright[engine].launch();
  try{
    for(const viewport of viewports){
      for(const stage of stages){
        const session = await createPage(browser,url,new GameState(stage).toJSON(),viewport);
        const {page} = session;
        assert.equal(await page.locator('.bottle').count(),stage.bottles.length);
        const geometry = await page.evaluate(() => {
          const game=document.getElementById('game'),footer=document.getElementById('footer');
          return {overflow:game.scrollWidth-game.clientWidth,footerBottom:footer.getBoundingClientRect().bottom,height:innerHeight,
            touch:[...document.querySelectorAll('#footer button,#settingsBtn,#journeyBtn')].map(el=>({id:el.id,w:el.offsetWidth,h:el.offsetHeight})),
            unlabeled:[...document.querySelectorAll('.bottle')].filter(el=>!el.getAttribute('aria-label')).length};
        });
        assert.ok(geometry.overflow<=2, `${engine}: no horizontal board overflow at ${viewport.width}, stage ${stage.level}`);
        assert.ok(geometry.footerBottom<=geometry.height+2, 'Footer stays inside the screen');
        assert.ok(geometry.touch.every(x=>x.w>=44&&x.h>=44), `Main controls have 44px touch targets: ${engine} ${viewport.width}x${viewport.height} ${JSON.stringify(geometry.touch)}`);
        assert.equal(geometry.unlabeled,0);
        await page.locator('.bottle').last().click(); // Also verifies the scrollable expert board remains reachable.
        await page.screenshot({path:path.join(outputs,`${engine}-${viewport.width}x${viewport.height}-stage${stage.level}.png`)});
        await verifySession(session);
      }
    }
    console.log(`PASS ${engine}: 6 viewports × 4 difficulties, touch targets, labels, overflow, no external requests`);

    const session = await createPage(browser,url,undefined);
    const {page} = session;
    await page.locator('#settingsBtn').click();
    await page.locator('#labelsBtn').click();
    await page.locator('#closeSettingsBtn').click();
    assert.equal(await page.locator('.colorMark').first().isVisible(),true);
    await page.locator('#extraBtn').click();
    assert.equal((await saved(page)).coins,80);
    await page.locator('#hintBtn').click();
    await until(page, key=>JSON.parse(localStorage.getItem(key)).coins===70,K.SAVE_KEY);
    assert.equal(await page.locator('.hint-from').count(),1);
    await page.locator('#hintBtn').click();
    assert.equal((await saved(page)).coins,70,'Repeated hint is free');
    await page.reload();
    await page.locator('#undoBtn').click();
    assert.equal((await saved(page)).coins,80,'Undo after reload refunds hint');
    await page.locator('#undoBtn').click();
    assert.equal((await saved(page)).coins,100,'Undo after reload refunds bottle');
    assert.equal(await page.locator('.bottle').count(),6);

    await page.locator('#extraBtn').click();
    await page.locator('#restartBtn').click();
    assert.equal(await page.locator('#confirmNoBtn').evaluate(el=>el===document.activeElement),true,'Cancel is the safe keyboard default');
    await page.locator('#confirmNoBtn').click();
    assert.equal(await page.locator('.bottle').count(),7);
    await page.locator('#restartBtn').click();
    await page.locator('#confirmYesBtn').click();
    assert.equal((await saved(page)).coins,80,'Restart does not refund');
    assert.equal(await page.locator('.bottle').count(),6);
    await playRoute(page,stages[0].solution);
    assert.equal((await saved(page)).coins,100,'First clear rewards exactly 20');
    assert.equal(await page.locator('#resultStars').innerText(),'★★★');
    await page.screenshot({path:path.join(outputs,`${engine}-clear.png`)});
    await page.reload();
    assert.equal((await saved(page)).coins,100,'Clear reload does not repeat reward');
    await page.locator('#nextBtn').click();
    assert.equal(await page.locator('#stageTitle').innerText(),'Stage 2');
    await page.locator('#journeyBtn').click();
    await page.screenshot({path:path.join(outputs,`${engine}-journey.png`)});
    await page.locator('[data-level="1"]').click();
    await playRoute(page,stages[0].solution);
    assert.equal((await saved(page)).coins,100,'Replay does not farm coins');
    await page.locator('#clearJourneyBtn').click();
    await page.locator('#dailyBtn').click();
    const daily = await saved(page);
    assert.equal(daily.mode,'daily');
    assert.equal(await page.locator('#stageTitle').innerText(),'Daily Puzzle');
    await page.locator('#journeyBtn').click();
    assert.equal(await page.locator('[data-level="6"]').isDisabled(),true,'Daily does not unlock campaign');
    await page.locator('#closeJourneyBtn').click();
    await playRoute(page,daily.solution);
    assert.equal((await saved(page)).coins,120,'Daily clear rewards once');
    assert.deepEqual((await saved(page)).completedStages,[1],'Daily leaves campaign progress alone');
    await page.locator('#nextBtn').click();
    await page.locator('#dailyBtn').click();
    await playRoute(page,daily.solution);
    assert.equal((await saved(page)).coins,120,'Daily replay does not farm coins');
    await page.locator('#nextBtn').click();
    await page.locator('#practiceBtn').click();
    const practice = await saved(page);
    await playRoute(page,practice.solution);
    assert.equal((await saved(page)).coins,120,'Practice has no reward');
    await verifySession(session);
    console.log(`PASS ${engine}: settings, hint, persisted Undo, restart confirmation, campaign/replay/daily/practice rewards`);

    const corrupt = await createPage(browser,url,'{invalid json');
    assert.equal(await corrupt.page.locator('.bottle').count(),6);
    assert.equal((await saved(corrupt.page)).coins,100);
    await verifySession(corrupt);
    console.log(`PASS ${engine}: corrupt storage safely starts Stage 1`);
  }finally{await browser.close()}
}
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${server.address().port}/`;
  try{for(const engine of ['chromium','webkit'])await runEngine(engine,url)}
  finally{await new Promise(resolve=>server.close(resolve))}
})().catch(error=>{console.error(error);process.exitCode=1});
