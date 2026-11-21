const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

// Run the actual panel with controlled native ports and deferred RPC responses.
function harness(search = "?page=https://a.feishu.cn/docx/A", saved = []) {
  const elements = new Map(), ports = [], timers = new Map(), storage = new Map(saved), events = new Map();
  let timerId = 0;
  function node() {
    return {hidden: true, value: '', textContent: '', dataset: {}, style: {}, children: [],
      options: ['16', 'system'].map(value => ({value})),
      setAttribute() {}, addEventListener() {}, focus() {}, scrollIntoView() {},
      hidePopover() {}, showPopover() {}, contains() {return false;},
      append(...children) {this.children.push(...children);},
      replaceChildren(...children) {this.children = children;},
      get childElementCount() {return this.children.length;},
      querySelectorAll() {return ['low','medium','high'].map(effort => ({...node(), dataset:{effort}}));},
      parentElement: {scrollHeight: 0, scrollTop: 0},
    };
  }
  const el = id => {
    if (!elements.has(id)) {
      const element = node();
      if (id === 'color-theme') element.options = ['blue', 'classic'].map(value => ({value}));
      elements.set(id, element);
    }
    return elements.get(id);
  };
  const context = vm.createContext({URL, URLSearchParams, console, performance, queueMicrotask,
    document: {getElementById: el, createElement: node, createDocumentFragment: node,
      documentElement:{style:{setProperty(){}},dataset:{}},addEventListener(){}},
    window: {addEventListener(type,fn){if(!events.has(type))events.set(type,[]);events.get(type).push(fn);}, parent:{postMessage(){}}},
    location: {search,origin:'chrome-extension://test'},
    release:{hostName:'local.codex_sidepanel',installerUrl:'https://example.com/connector'},
    localStorage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},
    pageContext:url=>url?{url,key:url,title:'A'}:null,
    renderMarkdown:(entry,text)=>{entry.textContent=text;},confirm:()=>true,
    setTimeout:(fn,ms)=>{timers.set(++timerId,{fn,ms});return timerId;},clearTimeout:id=>timers.delete(id),
    setInterval:()=>++timerId, clearInterval(){},cancelAnimationFrame(){},requestAnimationFrame:()=>++timerId,
    chrome:{runtime:{connect({ name }){
      assert.equal(name,'codex-sidepanel');
      const p={sent:[],postMessage(packet){p.sent.push(packet);},
        onMessage:{addListener(fn){p.receive=fn;}},onDisconnect:{addListener(fn){p.drop=fn;}},disconnect(){p.closed=true;p.drop?.();}};
      ports.push(p);return p;
    }}},
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../extension/panel.js'),'utf8'),context);
  const run = source=>vm.runInContext(source,context);
  run('frameActive=true');
  const flush = async()=>{for(let i=0;i<12;i++) await Promise.resolve();};
  const reply = (p,method,result)=>{const packet=p.sent.findLast(x=>x.method===method);assert.ok(packet,method);p.receive({id:packet.id,result});};
  async function handshake(p,workspaces=false) {
    p.receive({bridgeInfo:{protocol:3,workspaces,groupEditing:true}});
    reply(p,'initialize',{}); await flush();
    reply(p,'account/read',{authenticated:true}); await flush();
  }
  return {run,el,ports,timers,storage,flush,reply,handshake,events};
}

test('blue is the default theme and a classic selection persists across panels', () => {
  const panel = harness();
  assert.equal(panel.run('document.documentElement.dataset.theme'), 'blue');

  const selector = panel.el('color-theme');
  selector.value = 'classic';
  selector.onchange();
  assert.equal(panel.run('document.documentElement.dataset.theme'), 'classic');
  const reopened = harness(undefined, panel.storage);
  assert.equal(reopened.run('document.documentElement.dataset.theme'), 'classic');

  for (const listener of reopened.events.get('storage')) {
    listener({key: 'panel-theme', newValue: 'blue'});
  }
  assert.equal(reopened.run('document.documentElement.dataset.theme'), 'blue');
});

test('reconnect during handshake ignores old account response and errors',async()=>{
  const h=harness();h.run('startConnection()');const old=h.ports[0];
  old.receive({bridgeInfo:{protocol:3}});h.reply(old,'initialize',{});await h.flush();
  h.run('reconnect()');const fresh=h.ports[1];
  h.reply(old,'account/read',{authenticated:true});await h.flush();
  assert.equal(h.run('connected'),false);assert.equal(h.el('connection-help').hidden,true);
  await h.handshake(fresh);assert.equal(h.run('connected'),true);assert.ok(old.closed);
});

test('disconnect releases loading flags and blocks uncertain resubmission',async()=>{
  const h=harness();h.run('startConnection()');await h.handshake(h.ports[0]);
  assert.equal(h.el('codex-status-area').dataset.state, 'ready');
  h.run('busy=true; historyLoading=true; workspaceBusy=true; activeRequest={sent:true,writeTarget:"https://a.feishu.cn/docx/A"};');
  h.ports[0].drop();await h.flush();
  assert.equal(h.el('codex-status-area').dataset.state, 'error');
  assert.equal(h.run('historyLoading || workspaceBusy || busy'),false);
  assert.equal(h.run('requestUncertain'),true);assert.equal(h.el('send').disabled,true);
  h.run('connected=true');h.el('new').onclick();
  assert.equal(h.run('requestUncertain'),false);assert.equal(h.el('send').disabled,false);
});

test('old workspace result cannot change selection after reconnect',async()=>{
  const h=harness();h.run('startConnection()');await h.handshake(h.ports[0],true);
  h.run('reconnect()');await h.handshake(h.ports[1],true);
  h.reply(h.ports[0],'workspace/list',{default:'/old',paths:['/old']});await h.flush();
  assert.notEqual(h.run('selectedWorkspace'),'/old');assert.equal(h.run('workspaceBusy'),true);
  h.reply(h.ports[1],'workspace/list',{default:'/new',paths:['/new']});await h.flush();
  assert.equal(h.run('selectedWorkspace'),'/new');assert.equal(h.run('workspaceBusy'),false);
});

test('old history cannot replace new connection or clear its loading state',async()=>{
  const h=harness();h.run('startConnection()');await h.handshake(h.ports[0]);
  h.run('void loadHistory("old")');h.run('reconnect()');await h.handshake(h.ports[1]);
  h.run('void loadHistory("new")');
  h.reply(h.ports[0],'thread/turns/list',{data:[],nextCursor:null});await h.flush();
  assert.equal(h.run('historyLoading'),true);assert.notEqual(h.run('threadId'),'old');
  h.reply(h.ports[1],'thread/turns/list',{data:[],nextCursor:null});await h.flush();
  assert.equal(h.run('threadId'),'new');assert.equal(h.run('historyLoading'),false);
});

test('RPC timeout clears pending callback and ignores late response',async()=>{
  const h=harness();h.run('startConnection()');await h.handshake(h.ports[0]);
  const result=h.run('rpc("turn/start",{}).catch(error=>error.code)');
  const timer=[...h.timers.values()].find(x=>x.ms===60000);assert.ok(timer);timer.fn();
  assert.equal(await result,'RPC_TIMEOUT');assert.equal(h.run('pending.size'),0);
  h.reply(h.ports[0],'turn/start',{turn:{id:'late'}});assert.equal(h.run('turnId'),undefined);
});

test('repeated restore cursor stops instead of looping forever',async()=>{
  const h=harness();h.run('startConnection()');await h.handshake(h.ports[0]);
  h.run('localStorage.setItem(pageThreadKey(),"missing");void restorePageThread()');
  for(let i=0;i<3;i++){h.reply(h.ports[0],'thread/list',{data:[],nextCursor:'same'});await h.flush();}
  assert.equal(h.run('historyLoading'),false);assert.equal(h.run('pending.size'),0);
  assert.ok(h.el('messages').children.some(x=>x.textContent.includes('历史分页未能继续')));
});

test('active request keeps its locked target across page and membership changes',()=>{
  const h=harness();
  h.run('groupMembers=[{key:"A",title:"Report",url:"https://a.feishu.cn/docx/A"},{key:"B",title:"Leads - 飞书云文档",url:"https://a.feishu.cn/base/B"}];boundPage=groupMembers[0];focusedPageKey="B";activeRequest={targetPage:groupMembers[1]};busy=true;');
  h.run('boundPage=groupMembers[0];renderComposerTarget()');
  assert.equal(h.el('composer-target-name').textContent,'Leads');
  assert.equal(h.el('welcome-title').textContent,'连接本机 Codex');
  h.el('connection-help').hidden = true;
  h.run('renderComposerTarget()');
  assert.equal(h.el('welcome-title').textContent,'Leads');
  assert.equal(h.el('composer-target').title,'本轮目标：Leads - 飞书云文档');
  h.run('groupMembers=[groupMembers[0]];renderComposerTarget()');
  assert.equal(h.el('composer-target-name').textContent,'Leads');
  h.run('finish("完成")');
  assert.equal(h.el('composer-target-name').textContent,'Report');
  assert.equal(h.el('welcome-title').textContent,'Report');
});

test('background stream renders full text on completion without animation frames',()=>{
  const h=harness();h.run('threadId="t";busy=true;frameActive=false;');
  h.run('onPacket({method:"item/agentMessage/delta",params:{threadId:"t",delta:"first "}});onPacket({method:"item/agentMessage/delta",params:{threadId:"t",delta:"second"}})');
  assert.equal(h.run('answer.frame'),null);
  h.run('onPacket({method:"turn/completed",params:{threadId:"t",turn:{id:"x",status:"completed"}}})');
  assert.equal(h.el('messages').children.at(-1).textContent,'first second');
  assert.equal(h.run('busy'),false);
});

test('the pet writes through tools and streaming, and celebrates only a successful turn', () => {
  const h = harness();
  const pose = () => h.el('composer-pet').dataset.pose;
  h.run('threadId = "t"; busy = true; frameActive = false; setPetPose("working");');
  assert.equal(pose(), 'working');

  const tool = (event, id) => h.run(`onPacket({method:"item/${event}",params:{
    threadId:"t",item:{id:"${id}",type:"mcpToolCall"}}})`);
  tool('started', 'one');
  assert.equal(pose(), 'working');
  tool('started', 'two');
  tool('completed', 'one');
  assert.equal(pose(), 'working');
  tool('completed', 'two');
  assert.equal(pose(), 'working');
  h.run('onPacket({method:"item/agentMessage/delta",params:{threadId:"t",delta:"done"}})');
  assert.equal(pose(), 'working');

  h.run('onPacket({method:"turn/completed",params:{threadId:"t",turn:{status:"completed"}}})');
  assert.equal(pose(), 'success');
  [...h.timers.values()].find(timer => timer.ms === 1200).fn();
  assert.equal(pose(), 'idle');
  h.run('busy = true; onPacket({method:"turn/completed",params:{threadId:"t",turn:{status:"failed"}}})');
  assert.equal(pose(), 'concerned');
  h.run('busy = true; onPacket({method:"turn/completed",params:{threadId:"t",turn:{status:"interrupted"}}})');
  assert.equal(pose(), 'idle');
});

test('pet poses reach the Rive input without a sprite transition timer', () => {
  const h = harness();
  h.run('petRivePose = { value: 0 }; setPetPose("working");');
  assert.equal(h.run('petRivePose.value'), 3);
  h.run('setPetPose("success");');
  assert.equal(h.run('petRivePose.value'), 5);
});

test('Feishu timing records first tool and reply without storing request content', () => {
  const h = harness();
  h.run(`threadId = "t"; busy = true;
    progressStart = performance.now();
    activeRequest = { draft: "private", route: feishuRoute("https://a.feishu.cn/base/B"), timing: {} };
    onPacket({ method: "item/started", params: { threadId: "t", item: { id: "tool", type: "dynamicToolCall" } } });
    onPacket({ method: "item/completed", params: { threadId: "t", item: { id: "tool", type: "dynamicToolCall" } } });
    onPacket({ method: "item/completed", params: { threadId: "t", item: { type: "agentMessage", text: "done" } } });
    onPacket({ method: "turn/completed", params: { threadId: "t", turn: { status: "completed" } } });`);
  const [sample] = JSON.parse(h.run('localStorage.getItem("feishu-timing:base")'));
  assert.deepEqual(Object.keys(sample).sort(), ['reply', 'toolEnd', 'toolStart', 'total']);
  assert.ok(sample.toolStart <= sample.toolEnd && sample.toolEnd <= sample.reply && sample.reply <= sample.total);
});

test('explicit document statistics bypass the model and leave editing requests on the regular path', async () => {
  const h = harness();
  h.run(`connected = true; groupEditing = true;
    feishuBridge = { documentStats: true };
    feishuCheck = { target: boundPage.url };
    readCurrentPage = async () => boundPage;
    globalThis.calls = [];
    rpc = async (method, params) => {
      calls.push({ method, params });
      return { han: 800, images: 3 };
    };`);
  h.el('question').value = '估算当前文档的阅读时间';
  const submission = h.el('composer').onsubmit({ preventDefault() {} });
  assert.equal(h.el('composer-pet').dataset.pose, 'working');
  await submission;
  assert.equal(h.run('calls.map(({ method }) => method).join(",")'), 'feishu/documentStats');
  assert.match(h.el('messages').children.at(-1).textContent, /2 分钟/);
  assert.equal(h.run('busy'), false);
  assert.equal(h.run('documentStatsIntent("统计当前文档字数并把标题改掉")'), null);
});

test('recycling state protects drafts, references, uncertain results and pending RPC',()=>{
  const h=harness();assert.equal(h.run('window.codexSessionState().protected'),false);
  h.el('question').value='unsent draft';assert.equal(h.run('window.codexSessionState().protected'),true);
  h.el('question').value='';h.run('reference="https://a.feishu.cn/docx/A"');
  assert.equal(h.run('window.codexSessionState().protected'),true);
  h.run('reference=null;requestUncertain=true');assert.equal(h.run('window.codexSessionState().protected'),true);
  h.run('requestUncertain=false;pending.set(1,{})');assert.equal(h.run('window.codexSessionState().protected'),true);
  h.run('pending.clear()');assert.equal(h.run('window.codexSessionState().protected'),false);
});


test('hidden panels do not start a native process until activated',()=>{
  const h=harness();assert.equal(h.ports.length,0);
  h.storage.set('connection-consent','1');
  const message=active=>({origin:'chrome-extension://test',source:h.run('window.parent'),
    data:{type:'codex-page-context',active,context:h.run('boundPage'),members:[]}});
  for(const fn of h.events.get('message'))fn(message(false));
  assert.equal(h.ports.length,0);
  for(const fn of h.events.get('message'))fn(message(true));
  assert.equal(h.ports.length,1);
});

test('background idle connection sleeps while preserving draft and reference',async()=>{
  const h=harness();h.run('startConnection()');await h.handshake(h.ports[0]);
  h.el('question').value='unsent draft';h.run('reference="https://a.feishu.cn/docx/B";frameActive=false;maybeSuspendConnection()');
  assert.ok(h.ports[0].closed);assert.equal(h.run('connectionSleeping'),true);
  assert.equal(h.el('question').value,'unsent draft');assert.equal(h.run('reference'),'https://a.feishu.cn/docx/B');
  assert.equal(h.el('messages').children.length,0);
});

test('running and uncertain background tasks never sleep',async()=>{
  const h=harness();h.run('startConnection()');await h.handshake(h.ports[0]);
  h.run('frameActive=false;busy=true;maybeSuspendConnection()');assert.ok(!h.ports[0].closed);
  h.run('busy=false;requestUncertain=true;maybeSuspendConnection()');assert.ok(!h.ports[0].closed);
  h.run('requestUncertain=false;maybeSuspendConnection()');assert.ok(h.ports[0].closed);
});

test('finishing a background task releases its native process',async()=>{
  const h=harness();h.run('startConnection()');await h.handshake(h.ports[0]);
  h.run('frameActive=false;busy=true;threadId="t";activeRequest={sent:true};');
  h.run('onPacket({method:"turn/completed",params:{threadId:"t",turn:{id:"x",status:"completed"}}})');
  assert.equal(h.run('busy'),false);assert.equal(h.run('connectionSleeping'),true);assert.ok(h.ports[0].closed);
});

test('repeated background and foreground switches leave only one live native port',async()=>{
  const h=harness();
  for(let i=0;i<20;i++){
    h.run('frameActive=true;reconnect(true)');await h.handshake(h.ports.at(-1));
    assert.equal(h.ports.filter(p=>!p.closed).length,1);
    h.run('frameActive=false;maybeSuspendConnection()');
    assert.equal(h.ports.filter(p=>!p.closed).length,0);
  }
});

test('wake validates saved history and restores pending draft and reference',async()=>{
  const h=harness();h.run('startConnection()');await h.handshake(h.ports[0]);
  h.run('threadId="saved";localStorage.setItem(pageThreadKey(),threadId);reference="https://a.feishu.cn/docx/B";frameActive=false;maybeSuspendConnection()');
  h.el('question').value='draft';h.run('frameActive=true;reconnect(true)');const p=h.ports[1];await h.handshake(p);
  h.reply(p,'thread/list',{data:[{id:'saved'}],nextCursor:null});await h.flush();
  h.reply(p,'thread/turns/list',{data:[],nextCursor:null});await h.flush();
  assert.equal(h.run('threadId'),'saved');assert.equal(h.run('threadReady'),false);
  assert.equal(h.el('question').value,'draft');assert.equal(h.run('reference'),'https://a.feishu.cn/docx/B');
  assert.equal(h.run('connected'),true);
});

test('hidden view unload requires restorable displayed history and no unsaved work',()=>{
  const h=harness();
  h.run('frameActive=false;threadId="history";$("messages").append({});');
  assert.equal(h.run('window.canUnloadCodexView()'),false);
  h.run('localStorage.setItem(pageThreadKey(),threadId)');
  assert.equal(h.run('window.canUnloadCodexView()'),true);
  for (const flag of ['busy','requestUncertain','workspaceBusy','historyLoading']) {
    h.run(flag+'=true');assert.equal(h.run('window.canUnloadCodexView()'),false);h.run(flag+'=false');
  }
  h.el('question').value='draft';assert.equal(h.run('window.canUnloadCodexView()'),false);
  h.el('question').value='';h.run('frameActive=true');assert.equal(h.run('window.canUnloadCodexView()'),false);
});

test('Feishu check runs automatically, deduplicates and exposes repair instructions', async () => {
  const h = harness();
  h.run('startConnection()');
  const port = h.ports[0];
  await h.handshake(port);
  port.receive({bridgeInfo: {protocol: 3, larkCli: true}});
  assert.match(h.el('feishu-diagnostic').value, /连接器不支持飞书读取检查/);

  h.run('feishuCheck = undefined');
  port.receive({bridgeInfo: {protocol: 3, larkCli: true, larkCheck: true, connectorVersion: '2.3.5'}});
  assert.match(h.el('tool-status').textContent, /正在检查飞书/);
  assert.equal(h.el('send').disabled, true);
  h.run('renderComposerTarget(); renderComposerTarget();');
  const requests = port.sent.filter(packet => packet.method === 'feishu/check');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].params.document, 'https://a.feishu.cn/docx/A');
  port.receive({id: requests[0].id, error: {message: '钥匙串拒绝访问（退出码 1）'}});
  await h.flush();
  assert.equal(h.el('tool-status').textContent, '飞书读取失败');
  assert.match(h.el('feishu-diagnostic').value, /钥匙串拒绝访问（退出码 1）/);
  assert.match(h.el('feishu-diagnostic').value, /lark-cli auth status --json --verify/);
  assert.match(h.el('feishu-diagnostic').value, /连接器版本：2.3.5/);
  assert.equal(h.el('send').disabled, false);

  h.run('boundPage = pageContext("https://a.feishu.cn/docx/B"); renderComposerTarget();');
  h.reply(port, 'feishu/check', {readable: true});
  await h.flush();
  assert.equal(h.el('tool-status').textContent, '已连接');
  assert.equal(h.el('feishu-status-area').dataset.state, 'ready');
  assert.equal(h.el('feishu-details-button').hidden, true);
  port.drop();
  assert.equal(h.el('feishu-status-area').dataset.state, 'error');
  assert.equal(h.el('tool-status').textContent, '飞书读取失败');
  assert.match(h.el('feishu-diagnostic').value, /连接中断/);
});

test('active Wiki tab is checked when the saved workspace focus is a Base', async () => {
  const h = harness('?group=team&page=https://a.feishu.cn/wiki/Current');
  const wiki = 'https://a.feishu.cn/wiki/Current';
  const base = 'https://a.feishu.cn/base/Saved';
  h.run('frameActive = false');
  h.storage.set('connection-consent', '1');
  h.storage.set('web-workspace-focus:team', base);

  function publishCurrentPage(url) {
    const event = h.run('({ origin: location.origin, source: window.parent })');
    event.data = {type: 'codex-page-context', active: true,
      context: {url, key: url, title: 'Current'},
      members: [{url: base, key: base, title: 'Saved Base'}, {url: wiki, key: wiki, title: 'Wiki'}]};
    for (const listener of h.events.get('message')) listener(event);
  }
  publishCurrentPage(wiki);
  assert.equal(h.run('focusPage().url'), base);
  assert.equal(h.el('tool-status').textContent, '等待飞书连接');
  const port = h.ports[0];
  port.receive({bridgeInfo: {protocol: 3, larkCheck: true, larkCli: true}});
  const check = port.sent.find(packet => packet.method === 'feishu/check');
  assert.equal(check.params.document, wiki);
  h.reply(port, 'feishu/check', {readable: true});
  await h.flush();
  assert.equal(h.el('tool-status').textContent, '已连接');

  publishCurrentPage(base);
  assert.equal(h.el('tool-status').textContent, '请打开飞书文档');
  assert.equal(h.el('feishu-status-area').dataset.state, '');
  assert.equal(h.el('feishu-status-area').hidden, false);
  assert.equal(port.sent.filter(packet => packet.method === 'feishu/check').length, 1);
});

test('attachment citations show a filename in assistant replies and preserve user text', () => {
  const h = harness();
  const citation = ':codex-file-citation{path="/Users/test/Library/Caches/Codex Browser Connector/Attachments/42532B67-54B8-48FD-BFFF-7F170E0BEE53/1-sample.csv" artifact_kind="workbook" purpose="source"}';
  const input = JSON.stringify('结果是 731。 ' + citation);
  assert.equal(h.run(`messageNode(${input}, "assistant").textContent`), '结果是 731。 （附件 sample.csv）');
  assert.equal(h.run(`messageNode(${input}, "user").textContent`), '结果是 731。 ' + citation);
  const folder = citation.replace("1-sample.csv", "11332b67-54b8-48fd-bfff-7f170e0bee53/Folder/nested/sample.csv");
  assert.equal(h.run(`messageNode(${JSON.stringify(folder)}, "assistant").textContent`), '（附件 Folder/nested/sample.csv）');
});
