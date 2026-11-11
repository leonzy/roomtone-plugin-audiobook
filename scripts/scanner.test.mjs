import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
const code=await build({stdin:{contents:"export * from './src/services/scanner'; export * from './src/services/bookManager'; export * from './src/utils/helpers';",resolveDir:process.cwd()},bundle:true,format:'esm',platform:'node',write:false});
const {scanLibrary,BookManager,naturalCompare,naturalSort}=await import('data:text/javascript;base64,'+Buffer.from(code.outputFiles[0].contents).toString('base64'));
function fixture(stats=true){
 const storage=new Map(); const calls={read:0,stat:0};
 const files=Array.from({length:130},(_,i)=>({name:`Chapter ${i+1}.mp3`,isDir:false,size:16000*(i+1),modTime:1000+i}));
 const directories={
 '/app/audiobook':[{name:'Book',isDir:true},{name:'loose.mp3',isDir:false,size:32000,modTime:900}],
 '/app/audiobook/Book':files,
 };
 globalThis.songloft={log:{info(){},warn(){}},storage:{async get(k){return storage.get(k)},async set(k,v){storage.set(k,v)}},fs:{
  async readdir(path){calls.read++; if(!directories[path])throw Error('missing');return directories[path].map(e=>stats?{...e}:{name:e.name,isDir:e.isDir})},
  async stat(path){calls.stat++;const i=path.lastIndexOf('/');const e=directories[path.slice(0,i)]?.find(e=>e.name===path.slice(i+1));if(!e)throw Error('missing');return {...e}},
  async readFile(){throw Error('not found')},
 }};
 return {storage,calls,directories};
}
test('batch listing eliminates per-chapter bridge calls without changing the index',async()=>{
 const fast=fixture(true); const a=await scanLibrary(); assert.equal(fast.calls.stat,0); assert.equal(a.books.length,2); assert.equal(a.chaptersByBookId[a.books[0].id].length,130);
 const old=fixture(false);const b=await scanLibrary();assert.equal(old.calls.stat,131);
 delete a.scannedAt; delete b.scannedAt;assert.deepEqual(a,b);
});
test('fresh persisted index, including an empty library, avoids startup traversal',async()=>{
 for(const books of [[],[{id:'cached',title:'Cached'}]]){
  const f=fixture();f.storage.set('audiobook_library_v1',{books,chaptersByBookId:{},scannedAt:Date.now()});const bm=new BookManager('test');await bm.init();assert.equal(f.calls.read,0);assert.equal(bm.isScanning(),false);
 }
});
test('stale index refresh is single-flight and persists its successful scan time',async()=>{
 const f=fixture();f.storage.set('audiobook_library_v1',{books:[],chaptersByBookId:{},scannedAt:Date.now()-3600001});
 const bm=new BookManager('test');await bm.init();assert.equal(bm.isScanning(),true);await bm.rescan();
 for(let i=0;i<100&&bm.isScanning();i++)await new Promise(r=>setTimeout(r,10));
 assert.equal(bm.isScanning(),false);assert.equal(f.calls.stat,0);assert.ok(f.storage.get('audiobook_library_v1').scannedAt>Date.now()-5000);assert.equal(f.calls.read,3);
});
test('unavailable mount does not replace a persisted index with an empty one',async()=>{
 const f=fixture();delete f.directories['/app/audiobook'];const saved={books:[{id:'cached'}],chaptersByBookId:{},scannedAt:1};f.storage.set('audiobook_library_v1',saved);
 const bm=new BookManager('test');await bm.init();for(let i=0;i<30&&bm.isScanning();i++)await new Promise(r=>setTimeout(r,10));assert.equal(f.storage.get('audiobook_library_v1'),saved);
});

test('cached natural sort preserves numeric, case and Unicode ordering',()=>{
 const paths=Array.from({length:10000},(_,i)=>`/books/第${i%37}部/第${10000-i}章 - 演播.MP3`);
 paths.push('Track 02','track 2','track 10','a1b','a1B','a01b');
 const expected=[...paths].sort(naturalCompare);naturalSort(paths);assert.deepEqual(paths,expected);
});
