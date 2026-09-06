import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
const coreBuild = await build({entryPoints:['services/FolderWritingScope.ts'],bundle:true,format:'esm',platform:'node',write:false});
const {FolderWritingScope,folderContainsMarkdown}=await import(`data:text/javascript;base64,${Buffer.from(coreBuild.outputFiles[0].text).toString('base64')}`);
const makeScope=(path='Notes',recursive=true)=>new FolderWritingScope({id:path,path,recursive,locale:'auto',tracker:{history:{}}});

test('folder matching is bounded, recursive is optional, hidden files and non-Markdown are excluded',()=>{
    assert.equal(folderContainsMarkdown('Notes','Notes/a.md',false),true);
    assert.equal(folderContainsMarkdown('Notes','Notes/Sub/a.md',false),false);
    assert.equal(folderContainsMarkdown('Notes','Notes/Sub/a.md',true),true);
    for(const path of ['Notes2/a.md','Other/a.md','Notes/.private/a.md','Notes/a.xlsx']) assert.equal(folderContainsMarkdown('Notes',path,true),false,path);
});
test('existing content, YAML, disk refresh and imports never become authored words',()=>{
    const s=makeScope();s.setText('Notes/a.md','---\ntitle: Example\n---\nhello world',false);
    assert.equal(s.totalWords,2);s.tracker.startSession(s.totalWords,true);
    s.setText('Notes/a.md','hello world imported text',false);
    s.setText('Notes/import.md','more imported words',false);
    assert.equal(s.totalWords,7);assert.equal(s.tracker.getSessionWords(s.totalWords),0);
    assert.equal(s.tracker.getTodayWords(),0);
});
test('edits produce net words and revisions; save echo and file removal do not duplicate or reverse them',()=>{
    const s=makeScope();s.setText('Notes/a.md','one two',false);s.tracker.startSession(s.totalWords,true);
    s.setText('Notes/a.md','one two three',true);
    assert.equal(s.tracker.getTodayWords(),1);assert.equal(s.tracker.getTodayRevisions(),1);
    s.setText('Notes/a.md','one two three',false);
    s.setText('Notes/a.md','one two four',true);
    assert.equal(s.tracker.getTodayWords(),1);assert.equal(s.tracker.getTodayRevisions(),3);
    s.remove('Notes/a.md');assert.equal(s.totalWords,0);
    assert.equal(s.tracker.getSessionWords(s.totalWords),1);assert.equal(s.tracker.getTodayWords(),1);
});
test('Chinese counting and negative net changes keep speed nonnegative',()=>{
    const s=makeScope();s.setText('Notes/a.md','你好世界',false);assert.equal(s.totalWords,2);
    s.tracker.startSession(s.totalWords,true,Date.now()-120000);s.setText('Notes/a.md','你好',true);
    assert.equal(s.tracker.getSessionWords(s.totalWords),-1);assert.equal(s.tracker.getWordsPerMinute(s.totalWords),0);
});
test('inventory changes preserve sprint counts and interrupted sprint history',()=>{
    const s=makeScope();s.setText('Notes/a.md','one two',false);s.tracker.startSession(s.totalWords,true);
    s.tracker.startSprint(s.totalWords);s.setText('Notes/a.md','one two three',true);
    s.setText('Notes/import.md','existing words',false);
    assert.equal(s.tracker.getSprintWords(s.totalWords),1);
    const resumed=new FolderWritingScope(s.snapshot());
    assert.equal(resumed.tracker.isSprintRunning(),false);
    assert.equal(resumed.tracker.getSprintLog().at(-1).words,1);
    assert.equal(resumed.tracker.getTodayWords(),1);
    s.remove('Notes/a.md');s.remove('Notes/import.md');
    const emptied=new FolderWritingScope(s.snapshot());
    assert.equal(emptied.tracker.getSprintLog().at(-1).words,1,'moved-out files do not erase a sprint');
});

const stub=`export class FileView{};export class MarkdownView extends FileView{};
export class TFile{constructor(path){this.path=path;this.name=path.split('/').pop();this.extension=this.name.split('.').pop();}}
export class TFolder{constructor(path,children=[]){this.path=path;this.name=path.split('/').pop();this.children=children;}}
export const normalizePath=p=>p.replaceAll('\\\\','/');export class Notice{};`;
const serviceBuild=await build({stdin:{resolveDir:process.cwd(),contents:`export * from './services/FolderWritingTracker';export {TFile,TFolder,MarkdownView} from 'obsidian';`,loader:'ts'},bundle:true,format:'esm',platform:'node',write:false,plugins:[{name:'host',setup(b){b.onResolve({filter:/^obsidian$/},()=>({path:'obsidian',namespace:'stub'}));b.onLoad({filter:/.*/,namespace:'stub'},()=>({contents:stub}));}}]});
const {FolderWritingTracker,TFile,TFolder,MarkdownView}=await import(`data:text/javascript;base64,${Buffer.from(serviceBuild.outputFiles[0].text).toString('base64')}`);
globalThis.window=globalThis;
function harness(stored={}) {
    const files=new Map(),disk=new Map(Object.entries(stored)),events=new Map(),cleanups=[],leaves=[];
    const on=(event,fn)=>{const handlers=events.get(event)||[];handlers.push(fn);events.set(event,handlers);return {event,fn}};
    const emit=(event,...args)=>{for(const fn of events.get(event)||[])fn(...args)};
    const writes=[];
    const app={vault:{configDir:'.obsidian',on,getAbstractFileByPath:path=>files.get(path),
        cachedRead:async file=>disk.get(file.path)||'',adapter:{exists:async path=>disk.has(path),read:async path=>disk.get(path),write:async(path,text)=>{writes.push(path);disk.set(path,text)},remove:async path=>disk.delete(path)}},
        workspace:{on,onLayoutReady(){},iterateAllLeaves:fn=>leaves.forEach(fn),getLeavesOfType:()=>[]}};
    const plugin={app,manifest:{id:'narrative-lab',dir:'.obsidian/plugins/narrative-lab'},settings:{},registerEvent(){},register:fn=>cleanups.push(fn)};
    const service=new FolderWritingTracker(plugin);service.initialize();
    const addFolder=(path,content='one two')=>{const file=new TFile(path+'/a.md'),folder=new TFolder(path,[file]);files.set(path,folder);files.set(file.path,file);disk.set(file.path,content);return {file,folder}};
    const edit=(file,text)=>{let view=leaves.find(l=>l.view.file===file)?.view;if(!view){view=new MarkdownView();view.file=file;leaves.push({view});}view.editor={getValue:()=>text};emit('file-open',file);emit('editor-change',view.editor,view);};
    const close=async()=>{for(const fn of cleanups)fn();await service.writes;};
    return {service,files,disk,writes,events,emit,addFolder,edit,close};
}
const ledger='.obsidian/plugins/narrative-lab/folder-writing-tracker.json';
test('no folder configured means no scan, no source writes and no new ledger',async()=>{
    const h=harness();await h.service.load();assert.deepEqual(h.writes,[]);assert.equal(h.service.current,null);await h.close();
});
test('folder selection works without a project and saves only in plugin data',async()=>{
    const h=harness();const {file}=h.addFolder('Notes');
    try{
        await h.service.select('Notes');assert.equal(h.service.ready,true);assert.equal(h.service.current.totalWords,2);
        h.edit(file,'one two three');await h.service.save();
        assert.equal(h.service.current.tracker.getTodayWords(),1);
        assert.ok(h.writes.every(path=>path.startsWith(ledger)));
        assert.equal(h.disk.get('Notes/a.md'),'one two','source was not written');
        const saved=JSON.parse(h.disk.get(ledger));assert.equal(saved.scopes[0].path,'Notes');assert.equal(saved.scopes[0].totalWords,3);
    }finally{await h.close()}
});
test('rapid folder switching is serialized and daily histories stay separate',async()=>{
    const h=harness();const a=h.addFolder('A'),b=h.addFolder('B');
    try{await h.service.select('A');h.edit(a.file,'one two three');
        await Promise.all([h.service.select('B'),h.service.select('A')]);
        assert.equal(h.service.current.config.path,'A');assert.equal(h.service.current.tracker.getTodayWords(),1);
        await h.service.select('B');assert.equal(h.service.current.tracker.getTodayWords(),0);
        h.edit(b.file,'one two three four');assert.equal(h.service.current.tracker.getTodayWords(),2);
    }finally{await h.close()}
});
test('folder rename retains stable identity, history and selection without false deletions',async()=>{
    const h=harness();const {file,folder}=h.addFolder('Notes');
    try{await h.service.select('Notes');h.edit(file,'one two three');const id=h.service.current.config.id;
        h.files.delete('Notes');h.files.delete(file.path);folder.path='Renamed';file.path='Renamed/a.md';h.files.set(folder.path,folder);h.files.set(file.path,file);
        h.emit('rename',folder,'Notes');await h.service.save();
        assert.equal(h.service.current.config.path,'Renamed');assert.equal(h.service.current.config.id,id);
        assert.equal(h.service.current.tracker.getTodayWords(),1);assert.equal(h.service.current.tracker.getSessionWords(h.service.current.totalWords),1);
    }finally{await h.close()}
});
test('corrupt persisted records block writes; valid backup is recoverable',async()=>{
    const bad=harness({[ledger]:'{bad'});bad.addFolder('Notes');
    try{await assert.rejects(bad.service.select('Notes'));assert.deepEqual(bad.writes,[]);}finally{await bad.close()}
    const good=harness({[ledger]:'{bad',[ledger+'.bak']:JSON.stringify({version:1,selected:'x',scopes:[{id:'x',path:'Notes',recursive:true,locale:'auto',tracker:{history:{'2026-09-01':10}}}]})});good.addFolder('Notes');
    try{await good.service.load();assert.equal(good.service.current.tracker.getFullHistory()['2026-09-01'],10);
        await good.service.save();assert.equal(JSON.parse(good.disk.get(ledger+'.bak')).scopes[0].tracker.history['2026-09-01'],10);
    }finally{await good.close()}
});
test('removed source folder pauses activity without erasing history',async()=>{
    const h=harness();const {file,folder}=h.addFolder('Notes');
    try{await h.service.select('Notes');h.edit(file,'one two three');h.files.delete('Notes');h.emit('delete',folder);
        assert.equal(h.service.ready,false);assert.equal(h.service.current.tracker.isProjectFilesOpen(),false);
        assert.equal(h.service.current.tracker.getTodayWords(),1);
    }finally{await h.close()}
});
test('folder tracker chrome states the active-only recording rule and has no empty dropdown option',async()=>{
    const source=await readFile('components/FolderTrackerControls.ts','utf8');
    const panel=await readFile('views/WritingTrackerPanel.ts','utf8');
    assert.doesNotMatch(source,/createEl\('option'[\s\S]*Choose folder/);
    assert.match(source,/No folder is recording new writing/);
    assert.match(source,/Only this folder records new writing/);
    assert.match(source,/Resume tracking/);
    assert.match(panel,/renderFolderTrackerControls\(body, this\.plugin\)/);
    assert.doesNotMatch(panel,/nl-folder-tracker-title/);
});
test('stopping and resuming retains history without counting the tracking gap',async()=>{
    const h=harness();const {file}=h.addFolder('Notes');
    try{await h.service.select('Notes');h.edit(file,'one two three');await h.service.stop();
        assert.equal(h.service.current,null);assert.equal(JSON.parse(h.disk.get(ledger)).selected,'');
        h.edit(file,'one two three four five');await h.service.select('Notes');
        assert.equal(h.service.current.tracker.getTodayWords(),1);
        assert.equal(h.service.current.tracker.getSessionWords(h.service.current.totalWords),0);
    }finally{await h.close()}
});
test('manuscript folding preserves editors and keeps search targets expandable',async()=>{
    const source=await readFile('views/ManuscriptView.ts','utf8');
    assert.match(source,/createEl\('details', \{cls:'sl-manuscript-scene-block'/);
    assert.match(source,/if \(container\.closest\('details:not\(\[open\]\)'\)\) return;/);
    assert.match(source,/if \(foldedBlock\) foldedBlock\.open = true;/);
    const fold=source.slice(source.indexOf('private installDocumentFold'),source.indexOf('private usesScenes'));
    assert.doesNotMatch(fold,/detach|delete\(/);
    assert.match(fold,/writinglab-manuscript-folds/);
});
