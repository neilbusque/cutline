import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {mkdtemp,readdir,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {StockLibrary,matchesOrientation,normalizeStockSearch,stockUrl} from '../src/main/stock';

const photo={id:12,width:1080,height:1920,url:'https://www.pexels.com/photo/coffee-12/',photographer:'Alex',alt:'Morning coffee',src:{original:'https://images.pexels.com/photos/12/original.jpeg',medium:'https://images.pexels.com/photos/12/medium.jpeg',large:'https://images.pexels.com/photos/12/large.jpeg'}};
const video={id:12,width:1080,height:1920,duration:7,url:'https://www.pexels.com/video/coffee-12/',user:{name:'Jo'},image:'https://images.pexels.com/videos/12/thumbnail.jpg',video_files:[{width:2160,height:3840,file_type:'video/mp4',quality:'hd',link:'https://videos.pexels.com/video-files/12/4k.mp4'},{width:1080,height:1920,file_type:'video/mp4',quality:'hd',link:'https://videos.pexels.com/video-files/12/hd.mp4'},{width:360,height:640,file_type:'video/mp4',quality:'sd',link:'https://videos.pexels.com/video-files/12/preview.mp4'}]};
const commons={query:{pages:{'42':{pageid:42,index:1,title:'File:Coffee.jpg',imageinfo:[{url:'https://upload.wikimedia.org/wikipedia/commons/coffee.jpg',thumburl:'https://upload.wikimedia.org/wikipedia/commons/thumb/coffee.jpg',descriptionurl:'https://commons.wikimedia.org/wiki/File:Coffee.jpg',width:1080,height:1920,size:5,mime:'image/jpeg',extmetadata:{ImageDescription:{value:'<p>Grinding coffee beans with a hand grinder.</p>'},Artist:{value:'<a>Alex &amp; Jo</a>'},LicenseShortName:{value:'CC BY-SA 4.0'},LicenseUrl:{value:'https://creativecommons.org/licenses/by-sa/4.0/'}}}]}}},continue:{gsroffset:18}};
const json=(data:unknown,headers:Record<string,string>={})=>new Response(JSON.stringify(data),{status:200,headers:{'content-type':'application/json',...headers}});
let folder:string;
let request:ReturnType<typeof vi.fn>;
const makeJobs=()=>({cancellers:new Map(),update:vi.fn(),run:async(_kind:string,_message:string,fn:any)=>fn({id:'job-1',state:'running'})});
const makeMedia=(kind='image')=>({import:vi.fn(async(file:string)=>({id:'asset-1',name:'test',path:file,kind,duration:4,hasAudio:false}))});

beforeEach(async()=>{folder=await mkdtemp(path.join(os.tmpdir(),'cutline-stock-test-'));request=vi.fn();vi.stubGlobal('fetch',request);});
afterEach(async()=>{vi.unstubAllGlobals();await rm(folder,{recursive:true,force:true});});

describe('stock search providers',()=>{
  it('finds Commons photos without credentials and preserves creator/license metadata',async()=>{
    request.mockResolvedValueOnce(json(commons));
    const result=await new StockLibrary(folder,makeMedia() as any,makeJobs() as any).search('coffee',0,{kind:'image',orientation:'portrait'});
    expect(new URL(String(request.mock.calls[0][0])).searchParams.get('gsrsearch')).toBe('coffee filetype:bitmap');
    expect(result).toMatchObject({next:18,provider:'commons',kind:'image'});
    expect(result.items[0]).toMatchObject({kind:'image',creator:'Alex & Jo',license:'CC BY-SA 4.0',key:'commons:image:42'});
  });

  it('retains plain visual descriptions and does not fabricate relevance from a numeric provider URL',async()=>{
    request.mockResolvedValueOnce(json(commons));
    const service=new StockLibrary(folder,makeMedia() as any,makeJobs() as any,async()=>'test-key-is-not-a-real-key');
    const described=await service.search('coffee',0,{provider:'commons',kind:'image'});
    expect(described.items[0].description).toBe('Grinding coffee beans with a hand grinder.');
    request.mockResolvedValueOnce(json({videos:[{...video,url:'https://www.pexels.com/video/12/'}]}));
    const unnamed=await service.search('grinding coffee',0,{provider:'pexels',kind:'video'});
    expect(unnamed.items[0].title).not.toContain('coffee');
    expect(unnamed.items[0].description).toBe('');
  });

  it('uses raw Pexels authorization, filter/pagination parameters, and current endpoints',async()=>{
    request.mockResolvedValueOnce(json({photos:[photo],next_page:'https://api.pexels.com/v1/search?page=2'},{'x-ratelimit-limit':'20000','x-ratelimit-remaining':'19999','x-ratelimit-reset':'2000000000'}));
    const service=new StockLibrary(folder,makeMedia() as any,makeJobs() as any,async()=>'test-key-is-not-a-real-key');
    const result=await service.search('coffee',0,{provider:'pexels',kind:'image',orientation:'portrait'});
    const url=new URL(String(request.mock.calls[0][0]));
    expect(url.pathname).toBe('/v1/search');expect(url.searchParams.get('page')).toBe('1');expect(url.searchParams.get('orientation')).toBe('portrait');
    expect(request.mock.calls[0][1].headers.Authorization).toBe('test-key-is-not-a-real-key');
    expect(result).toMatchObject({next:1,quota:{remaining:19999,limit:20000,resetAt:2000000000000}});
    request.mockResolvedValueOnce(json({videos:[video]}));
    const clips=await service.search('coffee',1,{provider:'pexels',kind:'video'});
    const videoUrl=new URL(String(request.mock.calls[1][0]));
    expect(videoUrl.pathname).toBe('/v1/videos/search');expect(videoUrl.searchParams.get('page')).toBe('2');
    expect(clips.items[0]).toMatchObject({url:'https://videos.pexels.com/video-files/12/hd.mp4',preview:'https://videos.pexels.com/video-files/12/preview.mp4',width:1080,height:1920});
    expect(clips.items[0].key).not.toBe(result.items[0].key);
  });

  it('reuses cached results while insulating main-owned selection URLs from renderer mutation',async()=>{
    request.mockResolvedValueOnce(json({photos:[photo]}));
    const service=new StockLibrary(folder,makeMedia() as any,makeJobs() as any,async()=>'test-key-is-not-a-real-key');
    const result=await service.search('coffee',0,{provider:'pexels',kind:'image'});
    result.items[0].url='https://example.com/unsafe.jpg';
    const cached=await service.search('coffee',0,{provider:'pexels',kind:'image'});
    expect(request).toHaveBeenCalledTimes(1);expect(cached.cached).toBe(true);expect(cached.items[0].url).toBe(photo.src.original);
  });

  it('does not send a request without a key or after a quota failure',async()=>{
    const noKey=new StockLibrary(folder,makeMedia() as any,makeJobs() as any);
    await expect(noKey.search('coffee',0,{provider:'pexels'})).rejects.toThrow('Connect your Pexels');
    expect(request).not.toHaveBeenCalled();
    request.mockResolvedValueOnce(new Response('',{status:429,headers:{'retry-after':'120'}}));
    const service=new StockLibrary(folder,makeMedia() as any,makeJobs() as any,async()=>'test-key-is-not-a-real-key');
    await expect(service.search('coffee',0,{provider:'pexels'})).rejects.toThrow('request limit');
    await expect(service.search('ocean',0,{provider:'pexels'})).rejects.toThrow('request limit');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('drops unexpected URLs, unsupported images, and incorrect orientations',async()=>{
    request.mockResolvedValueOnce(json({photos:[{...photo,src:{...photo.src,original:'https://127.0.0.1/secret.jpg'}},{...photo,id:13,width:1920,height:1080},photo]}));
    const result=await new StockLibrary(folder,makeMedia() as any,makeJobs() as any,async()=>'test-key-is-not-a-real-key').search('coffee',0,{provider:'pexels',kind:'image',orientation:'portrait'});
    expect(result.items).toHaveLength(1);expect(result.items[0].id).toBe(12);
    expect(()=>normalizeStockSearch('coffee',-1,{})).toThrow();expect(()=>normalizeStockSearch('coffee',0,{kind:'audio' as any})).toThrow();
    expect(matchesOrientation(1000,1000,'square')).toBe(true);expect(matchesOrientation(1080,1920,'landscape')).toBe(false);
  });
});

describe('stock downloads',()=>{
  it('requires a searched selection, saves media credits, and never passes API authorization to media hosts',async()=>{
    const media=makeMedia(),jobs=makeJobs(),service=new StockLibrary(folder,media as any,jobs as any,async()=>'test-key-is-not-a-real-key');
    await expect(service.download(12,'pexels','image')).rejects.toThrow('Search for this media again');
    request.mockResolvedValueOnce(json({photos:[photo]})).mockResolvedValueOnce(new Response('image-content',{headers:{'content-type':'image/jpeg'}}));
    await service.search('coffee',0,{provider:'pexels',kind:'image'});
    const asset=await service.download(12,'pexels','image');
    expect(asset.origin).toMatchObject({provider:'Pexels',creator:'Alex',page:photo.url,license:'Pexels License'});
    expect(await readFile(asset.path+'.credits.txt','utf8')).toContain('Creator: Alex');
    expect(request.mock.calls[1][1].headers.Authorization).toBeUndefined();
    expect(jobs.cancellers.size).toBe(0);
  });

  it('rejects redirect escapes without visiting the destination',async()=>{
    request.mockResolvedValueOnce(json({photos:[photo]})).mockResolvedValueOnce(new Response('',{status:302,headers:{location:'http://127.0.0.1/internal'}}));
    const service=new StockLibrary(folder,makeMedia() as any,makeJobs() as any,async()=>'test-key-is-not-a-real-key');
    await service.search('coffee',0,{provider:'pexels',kind:'image'});
    await expect(service.download(12,'pexels','image')).rejects.toThrow('Unexpected stock');
    expect(request).toHaveBeenCalledTimes(2);expect(await readdir(folder)).toEqual([]);
  });

  it('rejects oversized and non-media responses and cleans up temporary files',async()=>{
    request.mockResolvedValueOnce(json({photos:[photo]})).mockResolvedValueOnce(new Response('a',{headers:{'content-type':'image/jpeg','content-length':String(201*1024*1024)}})).mockResolvedValueOnce(new Response('<html>error</html>',{headers:{'content-type':'text/html'}}));
    const media=makeMedia(),service=new StockLibrary(folder,media as any,makeJobs() as any,async()=>'test-key-is-not-a-real-key');
    await service.search('coffee',0,{provider:'pexels',kind:'image'});
    await expect(service.download(12,'pexels','image')).rejects.toThrow('200 MB');
    await expect(service.download(12,'pexels','image')).rejects.toThrow('unsupported media');
    expect(media.import).not.toHaveBeenCalled();expect(await readdir(folder)).toEqual([]);
  });

  it('allows only HTTPS provider sources and distinguishes media from source pages',()=>{
    expect(stockUrl(photo.url,'page','pexels')).toBe(photo.url);
    for(const address of ['https://images.pexels.com.evil.test/x.jpg','https://name:secret@images.pexels.com/x.jpg','http://images.pexels.com/x.jpg','https://images.pexels.com:9999/x.jpg'])expect(()=>stockUrl(address,'media','pexels')).toThrow();
    expect(()=>stockUrl(photo.url,'media','pexels')).toThrow();
  });
});

describe('stock download timing',()=>{
  it('keeps a finished download when preparing it takes longer than the download limit',async()=>{
    vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
    try{
      // A 4K clip downloads quickly but its import takes over three minutes.
      let importing!:()=>void;
      const started=new Promise<void>(resolve=>(importing=resolve));
      const media={import:vi.fn((file:string)=>{importing();return new Promise(resolve=>setTimeout(()=>resolve({id:'asset-1',name:'test',path:file,kind:'image',duration:4,hasAudio:false}),200_000));})};
      const service=new StockLibrary(folder,media as any,makeJobs() as any,async()=>'test-key-is-not-a-real-key');
      request.mockResolvedValueOnce(json({photos:[photo]})).mockResolvedValueOnce(new Response('image-content',{headers:{'content-type':'image/jpeg'}}));
      await service.search('coffee',0,{provider:'pexels',kind:'image'});
      const pending=service.download(12,'pexels','image');
      const settled=pending.then(asset=>({asset}),error=>({error}));
      await started;
      await vi.advanceTimersByTimeAsync(200_000);
      const result:any=await settled;
      expect(result.error?.message).toBeUndefined();
      expect(result.asset.origin).toMatchObject({provider:'Pexels',creator:'Alex'});
      expect(await readFile(result.asset.path,'utf8')).toBe('image-content');
    }finally{vi.useRealTimers();}
  });

  it('reports a cancel only when the person cancelled',async()=>{
    const jobs=makeJobs();
    let job:any;
    jobs.run=async(_kind:string,_message:string,fn:any)=>fn(job={id:'job-1',state:'running'});
    const media={import:vi.fn(async()=>{job.state='cancelled';jobs.cancellers.get('job-1')?.();throw Error('Cancelled');})};
    const service=new StockLibrary(folder,media as any,jobs as any,async()=>'test-key-is-not-a-real-key');
    request.mockResolvedValueOnce(json({photos:[photo]})).mockResolvedValueOnce(new Response('image-content',{headers:{'content-type':'image/jpeg'}}));
    await service.search('coffee',0,{provider:'pexels',kind:'image'});
    await expect(service.download(12,'pexels','image')).rejects.toThrow('Download cancelled');
    expect(await readdir(folder)).toEqual([]);
  });
});
