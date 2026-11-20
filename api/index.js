const { URL }=require('url');
const { randomUUID }=require('node:crypto');
const http=require('node:http');
const https=require('node:https');
const tls=require('node:tls');
// Carga blindada: si secure-api falla al cargarse en el runtime de Vercel
// (bundling/tracing), la funcion NO crashea en cold start; el error real se
// expone en /status y como JSON en las rutas que lo necesitan.
let secureApi=null;
let secureApiLoadError=null;
try{
secureApi=require('./secure-api');
}catch(e){
secureApiLoadError=e;
}
let adminApi=null;
let adminApiLoadError=null;
try{
adminApi=require('../lib/admin');
}catch(e){
adminApiLoadError=e;
}
const { paginaDocs }=require('../lib/paginas');
// Precalentamiento de cold start (sesion anonima + Capa 2 viva) en segundo
// plano: no bloquea la primera peticion ni cambia su resultado.
try{
if(secureApi&&typeof secureApi.precalentar==='function')secureApi.precalentar().catch(()=>{});
}catch(e){}
// Cualquier "999p" pasaba el filtro y despues degradaba a 360p en silencio:
// solo se aceptan las calidades que la API realmente resuelve.
const CALIDADES_VALIDAS=['best','144p','240p','360p','480p','720p','1080p','1440p','2160p'];
const VALID_QUALITY=new RegExp('^(?:'+CALIDADES_VALIDAS.join('|')+')$');
const VALID_LIMIT=/^\d+$/;
const LIMIT_MIN=1;
const LIMIT_MAX=20;
const BROWSER_UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const DL_KINDS=['audio','video','tiktok','x','instagram','facebook'];
// Cache de la resolucion del player de YouTube para /dl: los enlaces de
// googlevideo duran ~6h; guardarlos 30 min evita re-resolver en cada pedido.
const dlMediaCache=new Map();
// Memoria del cliente que paso el probe por videoId|kind (TTL 6h): la proxima
// resolucion prueba ESE cliente primero en vez de arrancar del candidato 1.
const dlClienteCache=new Map();
const IP_BLOCKED_MESSAGE='El hosting (Vercel) está bloqueado por YouTube/TikTok para descargas. La descarga debe hacerse desde una IP residencial.';

function pedirHttps(targetUrl,headers,timeoutMs=10000){
return new Promise((resolve,reject)=>{
const pedido=https.request(targetUrl,{method:'GET',headers,agent:false},(respuesta)=>resolve(respuesta));
pedido.on('error',reject);
pedido.setTimeout(timeoutMs,()=>pedido.destroy(new Error('timeout de pedido')));
pedido.end();
});
}

// Transmite en streaming un archivo de media (googlevideo, tiktokcdn, twimg)
// desde la misma invocacion de la funcion, para que la IP coincida con la que
// genero la URL firmada. Pasa el header Range del cliente y copia los headers
// de respuesta relevantes (200 o 206).
async function streamMedia(req,res,sendJson,requestId,mediaUrl,options={}){
const fetchHeaders={
'User-Agent':BROWSER_UA,
'Accept':'*/*',
'Accept-Language':'es-ES,es;q=0.9,en;q=0.8',
};
if(options.referer)fetchHeaders.Referer=options.referer;
if(options.headers)Object.assign(fetchHeaders,options.headers);
const range=req.headers&&typeof req.headers.range==='string'&&req.headers.range.length<200?req.headers.range:'';
if(range)fetchHeaders.Range=range;
const ipBlocked=()=>sendJson(502,{ok:false,error:'IP_BLOQUEADA',message:options.mensajeBloqueo||IP_BLOCKED_MESSAGE});
const applyMediaHeaders=(status,contentType,extra={})=>{
res.statusCode=status;
res.setHeader('Content-Type',contentType||'application/octet-stream');
res.setHeader('Accept-Ranges',extra.acceptRanges||'bytes');
if(extra.contentLength)res.setHeader('Content-Length',extra.contentLength);
if(extra.contentRange)res.setHeader('Content-Range',extra.contentRange);
if(options.filename)res.setHeader('Content-Disposition','attachment; filename="'+String(options.filename).replace(/[^a-zA-Z0-9._-]/g,'_')+'"');
};
if(options.exigirVideo){
// Stream por node:https con agent:false: misma conexion fresca que el probe;
// por undici (pool reutilizado) el lookaside de Facebook contesta HTML.
let destinoStream=mediaUrl;
let respuesta=null;
try{
for(let salto=0;salto<4;salto+=1){
respuesta=await pedirHttps(destinoStream,fetchHeaders);
const st=respuesta.statusCode;
const loc=respuesta.headers.location;
if([301,302,303,307,308].includes(st)&&loc){
respuesta.resume();
destinoStream=new URL(loc,destinoStream).href;
continue;
}
break;
}
}catch(e){
return sendJson(502,{ok:false,message:'No se pudo conectar con el servidor de medios.',error:String(e&&e.message||e).slice(0,140)});
}
const tipoStream=String(respuesta.headers['content-type']||'');
if(!tipoStream.includes('video')&&!tipoStream.includes('octet-stream')){
respuesta.resume();
return sendJson(404,{ok:false,error:'SIN_MEDIA_DESCARGABLE',message:'El servidor de medios respondio HTML en vez de video (ventana temporal de la plataforma). Reintenta en unos segundos.'});
}
if(respuesta.statusCode===403){
respuesta.resume();
return ipBlocked();
}
if(respuesta.statusCode!==200&&respuesta.statusCode!==206){
const status=respuesta.statusCode;
respuesta.resume();
return sendJson(502,{ok:false,message:'El servidor de medios rechazo la descarga (HTTP '+status+').'});
}
applyMediaHeaders(respuesta.statusCode,tipoStream,{acceptRanges:respuesta.headers['accept-ranges'],contentLength:respuesta.headers['content-length'],contentRange:respuesta.headers['content-range']});
res.on('close',()=>{try{respuesta.destroy();}catch(e){}});
respuesta.on('data',(chunk)=>{
if(!res.write(chunk))respuesta.pause();
});
res.on('drain',()=>respuesta.resume());
respuesta.on('end',()=>res.end());
respuesta.on('error',()=>{try{res.destroy();}catch(e){}});
return;
}
let upstream;
try{
upstream=await fetch(mediaUrl,{headers:fetchHeaders,redirect:'follow'});
}catch(e){
return sendJson(502,{ok:false,message:'No se pudo conectar con el servidor de medios.',error:String(e&&e.message||e).slice(0,140)});
}
if(upstream.status===403){
try{await upstream.body?.cancel();}catch(e){}
return ipBlocked();
}
if(!upstream.ok&&upstream.status!==206){
try{await upstream.body?.cancel();}catch(e){}
return sendJson(502,{ok:false,message:'El servidor de medios rechazo la descarga (HTTP '+upstream.status+').'});
}
const tipoUpstream=upstream.headers.get('content-type');
const cr=upstream.headers.get('content-range')||'';
const tamanioTotal=Number(String(cr).split('/')[1])||Number(upstream.headers.get('content-length'))||0;
const aceptaRangos=(upstream.headers.get('accept-ranges')||'').includes('bytes');
applyMediaHeaders(upstream.status,tipoUpstream,{acceptRanges:upstream.headers.get('accept-ranges'),contentLength:upstream.headers.get('content-length'),contentRange:upstream.headers.get('content-range')});
if(!options.sinRangos&&!range&&aceptaRangos&&tamanioTotal>3*1024*1024&&upstream.status===200){
try{await upstream.body?.cancel();}catch(e){}
console.log('[dl] stream por rangos paralelos ('+Math.round(tamanioTotal/1048576)+'MB)');
try{
await streamRangosParalelos(req,res,mediaUrl,fetchHeaders,tamanioTotal,tipoUpstream);
return;
}catch(eRangos){
console.log('[dl] rangos paralelos fallo, fallback 1 stream:',(eRangos&&eRangos.message||eRangos).toString().slice(0,120));
try{
upstream=await fetch(mediaUrl,{headers:fetchHeaders,redirect:'follow'});
if(upstream.status===403){try{await upstream.body?.cancel();}catch(e2){}return ipBlocked();}
if(!upstream.ok&&upstream.status!==206){try{await upstream.body?.cancel();}catch(e2){}return sendJson(502,{ok:false,message:'El servidor de medios rechazo la descarga (HTTP '+upstream.status+').'});}
}catch(e2){
return sendJson(502,{ok:false,message:'No se pudo conectar con el servidor de medios.'});
}
}
}
try{
if(upstream.body&&typeof upstream.body.getReader==='function'){
const reader=upstream.body.getReader();
for(;;){
const chunk=await reader.read();
if(chunk.done)break;
if(!res.write(Buffer.from(chunk.value))){
await new Promise((resolve)=>res.once('drain',resolve));
}
}
res.end();
}else{
res.end(Buffer.from(await upstream.arrayBuffer()));
}
}catch(e){
try{res.destroy();}catch(e2){}
}
}

async function probeMedia(mediaUrl,headers){
const probeHeaders={...headers,Range:'bytes=0-0'};
try{
const r=await fetch(mediaUrl,{headers:probeHeaders,redirect:'follow'});
try{await r.body?.cancel();}catch(e){}
return r.status;
}catch(e){return 0;}
}
// Probe alternativo (flujo real sin Range ni Cookie): googlevideo a veces
// rechaza el probe de Range/cookie con 403 en URLs de VIDEO aunque el stream
// normal si sirve (el audio itag 140 pasa, las de video no; evidencia: /ytmp4
// resuelve el mismo video 200 y el enlace directo con ip= amarrada da 403).
// Hace GET completo, lee UN chunk y corta. Devuelve el status si sirve.
async function probeMediaFlujo(mediaUrl){
try{
const r=await fetch(mediaUrl,{headers:{'User-Agent':BROWSER_UA,Referer:'https://www.youtube.com/'},redirect:'follow'});
if(r.status!==200&&r.status!==206){try{await r.body?.cancel();}catch(e){}return 0;}
const tipo=String(r.headers.get('content-type')||'');
let bytes=0;
if(r.body&&typeof r.body.getReader==='function'){
const reader=r.body.getReader();
try{const p=await reader.read();bytes=p.done?0:p.value.length;}catch(e){}
try{await reader.cancel();}catch(e){}
}else{try{await r.body?.cancel();}catch(e){}}
return bytes>0&&!tipo.includes('text/html')?r.status:0;
}catch(e){return 0;}
}

// ============================================================================
// MUX REAL 480p+: YouTube solo entrega 720p/1080p como streams SEPARADOS
// (video-only + audio-only). Sin combinacion el archivo quedaria sin audio.
// El binario estatico (ffmpeg-static) corre dentro de la propia funcion
// serverless; cualquier fallo (binario ausente, sin permisos, sin presupuesto)
// devuele null y el pedido sigue por la escalera progresiva de calidad.
// ============================================================================
const nodeFs=require('node:fs');
const nodePath=require('node:path');
const nodeOs=require('node:os');
let binFfmpegCacheado=null;
let binFfmpegVerificado=false;
function binFfmpeg(){
if(binFfmpegVerificado)return binFfmpegCacheado;
binFfmpegVerificado=true;
const candidatos=[];
try{const p=require('ffmpeg-static');if(p)candidatos.push(p);}catch(e){}
if(process.env.FFMPEG_PATH)candidatos.push(process.env.FFMPEG_PATH);
candidatos.push('ffmpeg');
for(const bin of candidatos){
try{require('node:child_process').execFileSync(bin,['-version'],{stdio:['ignore','ignore','ignore'],timeout:5000});binFfmpegCacheado=bin;return bin;}
catch(e){}
}
return null;
}

// Descarga acotada a disco: aborta por timeout o si supera el limite de MB
// (protege /tmp y la memoria de la funcion). Devuelve el tamano escrito.
function bajarADisco(url,destino,limiteBytes,recorteMs){
return new Promise((resolvio,rechazo)=>{
const controlador=new AbortController();
const alarma=setTimeout(()=>controlador.abort(new Error('descarga timeout '+recorteMs+'ms')),recorteMs);
fetch(url,{headers:{'User-Agent':BROWSER_UA,Referer:'https://www.youtube.com/'},redirect:'follow',signal:controlador.signal}).then(async(r)=>{
if(r.status!==200&&r.status!==206){clearTimeout(alarma);return rechazo(new Error('HTTP '+r.status));}
if(!r.body){clearTimeout(alarma);return rechazo(new Error('respuesta sin cuerpo'));}
const archivo=nodeFs.createWriteStream(destino);
let bytes=0;
const lector=r.body.getReader();
const siguiente=async()=>{
try{
const p=await lector.read();
if(p.done){archivo.end(()=>{clearTimeout(alarma);resolvio(bytes);});return;}
bytes+=p.value.length;
if(bytes>limiteBytes){
try{await lector.cancel();}catch(e){}
archivo.destroy();
clearTimeout(alarma);
return rechazo(new Error('supera el limite de '+Math.round(limiteBytes/1048576)+'MB'));
}
if(!archivo.write(p.value)){archivo.once('drain',siguiente);}else{setImmediate(siguiente);}
}catch(e){archivo.destroy();clearTimeout(alarma);rechazo(e);}
};
siguiente();
}).catch((e)=>{clearTimeout(alarma);rechazo(e);});
});
}

function borrarCarpetaTemp(carpeta){
if(!carpeta)return;
try{nodeFs.rmSync(carpeta,{recursive:true,force:true});}catch(e){}
}

// Tamano total del stream via Range bytes=0-0 (googlevideo soporta 206).
// Devuelve 0 si no soporta rangos: la bajada caera a single-stream.
async function totalStream(mediaUrl){
try{
const r=await fetch(mediaUrl,{headers:{'User-Agent':BROWSER_UA,Referer:'https://www.youtube.com/',Range:'bytes=0-0'},redirect:'follow'});
try{await r.body?.cancel();}catch(e){}
if(r.status!==206)return 0;
const m=String(r.headers.get('content-range')||'').match(/\/(\d+)$/);
return m?Number(m[1]):0;
}catch(e){return 0;}
}

// Descarga a disco POR RANGOS EN PARALELO (misma tecnica de streamRangosParalelos):
// el single-stream desde un datacenter a googlevideo se estrangula y muere;
// con N rangos en paralelo el archivo completo llega a tiempo. Ventana de 4,
// reintentos por rango, concatenacion en orden y borrado de partes.
async function bajarADiscoRangos(mediaUrl,total,destino,limiteMs){
const t0=Date.now();
const N=Math.min(10,Math.max(3,Math.ceil(total/(10*1048576))));
const rango=Math.ceil(total/N);
const dir=nodePath.dirname(destino);
const base=nodePath.basename(destino);
const partes=new Array(N).fill(null);
const pedirRango=async(i)=>{
const ini=i*rango,fin=Math.min(total-1,(i+1)*rango-1);
const esperado=fin-ini+1;
for(let intento=1;intento<=2;intento+=1){
if(Date.now()-t0>limiteMs)throw new Error('descarga por rangos sin presupuesto');
try{
const r=await fetch(mediaUrl,{headers:{'User-Agent':BROWSER_UA,Referer:'https://www.youtube.com/',Range:'bytes='+ini+'-'+fin},redirect:'follow'});
if((r.status!==206&&r.status!==200)||!r.body){try{await r.body?.cancel();}catch(e){}throw new Error('HTTP '+r.status);}
const destinoParte=nodePath.join(dir,base+'.parte'+i);
const archivo=nodeFs.createWriteStream(destinoParte);
let escritos=0;
const lector=r.body.getReader();
await new Promise((ok,falloArchivo)=>{
const siguiente=async()=>{
try{
const p=await lector.read();
if(p.done){archivo.end(()=>ok());return;}
escritos+=p.value.length;
if(escritos>esperado+1024){archivo.destroy();falloArchivo(new Error('rango '+i+' excedido'));return;}
if(!archivo.write(Buffer.from(p.value))){archivo.once('drain',siguiente);}else{setImmediate(siguiente);}
}catch(e){archivo.destroy();falloArchivo(e);}
};
siguiente();
});
if(escritos!==esperado)throw new Error('rango '+i+' incompleto '+escritos+'/'+esperado);
partes[i]=destinoParte;
return;
}catch(e){
if(intento===2)throw e;
await new Promise((x)=>setTimeout(x,400));
}
}
};
await new Promise((ok,fallo)=>{
let proximo=0,completos=0,enVuelo=0;
const lanzar=()=>{
while(proximo<N&&enVuelo<4){
enVuelo+=1;
const i=proximo++;
pedirRango(i).then(()=>{enVuelo-=1;completos++;if(completos===N)ok();else lanzar();}).catch((e)=>fallo(e));
}
};
lanzar();
});
const salida=nodeFs.openSync(destino,'w');
try{for(let i=0;i<N;i+=1)nodeFs.writeSync(salida,nodeFs.readFileSync(partes[i]));}
finally{
nodeFs.closeSync(salida);
partes.forEach((p)=>{if(p)try{nodeFs.unlinkSync(p);}catch(e){}});
}
return total;
}

// Combina video-only (altura pedida) + audio itag 140 con -c copy (sin
// recodificar: rapido y sin backlash de calidad). Presupuesto arbitrario
// para dejar lugar a la escalera si algo falla. Nunca deja procesos ni
// temporales colgados (SIGKILL + rmSync).
async function muxVideoCalidad(videoId,alturaPedido,presupuestoMs){
const bin=binFfmpeg();
if(!bin)return {ok:false,razon:'ffmpeg no disponible'};
const t0=Date.now();
const carpeta=nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(),'mux-'));
const fVideo=nodePath.join(carpeta,'video.m4s');
const fAudio=nodePath.join(carpeta,'audio.m4s');
const fSalida=nodePath.join(carpeta,'salida.mp4');
try{
// El stream de video debe ser video-only PURO a la altura exacta pedida:
// si el camino automatico resuelve un progresivo menor (o su URL no resolvio),
// se reintenta con clientes puntuales; muxar un itag 18 entregaria 360p
// disfrazado de 720p. Si nada entrega el stream correcto, se degrada.
let videoSolo=null;
for(const clienteMux of [undefined,'WEB','ANDROID_VR','IOS']){
if(presupuestoMs-(Date.now()-t0)<6000)break;
try{
const m=await secureApi.fetchYoutubeMedia(videoId,'video',String(alturaPedido),null,{aceptarSoloVideo:true,presupuestoMs:Math.min(14000,presupuestoMs-(Date.now()-t0)),sinProxy:true,...(clienteMux?{client:clienteMux}:{})});
if(m&&m.url&&m.soloVideo&&String(m.quality)===alturaPedido+'p'){videoSolo=m;break;}
}catch(e){}
}
if(!videoSolo){borrarCarpetaTemp(carpeta);return {ok:false,razon:'sin stream de video '+alturaPedido+'p disponible'};}
const audioPuro=await secureApi.fetchYoutubeMedia(videoId,'audio','best',null,{presupuestoMs:Math.min(10000,Math.max(3000,presupuestoMs-(Date.now()-t0))),sinProxy:true});
if(!audioPuro||!audioPuro.url){borrarCarpetaTemp(carpeta);return {ok:false,razon:'sin stream de audio disponible'};}
const restante=()=>presupuestoMs-(Date.now()-t0);
if(restante()<8000){borrarCarpetaTemp(carpeta);return {ok:false,razon:'sin presupuesto para descargar los streams'};}
// Ambos streams bajan por rangos en paralelo (googlevideo estrangula los
// single-streams desde datacenter, tambien los de audio). Sin tamano total
// (respuesta sin 206) cae a single-stream con el mismo presupuesto.
const totalVideo=await totalStream(videoSolo.url);
if(totalVideo>0){
await bajarADiscoRangos(videoSolo.url,totalVideo,fVideo,Math.floor(Math.min(27000,restante()-4000)));
}else{
await bajarADisco(videoSolo.url,fVideo,420*1048576,Math.floor(Math.min(27000,restante()-4000)));
}
const totalAudio=await totalStream(audioPuro.url);
if(totalAudio>0){
await bajarADiscoRangos(audioPuro.url,totalAudio,fAudio,Math.floor(Math.min(15000,restante()-4000)));
}else{
await bajarADisco(audioPuro.url,fAudio,90*1048576,Math.floor(Math.min(15000,restante()-4000)));
}
if(restante()<7000){borrarCarpetaTemp(carpeta);return {ok:false,razon:'sin presupuesto para combinar'};}
const hijo=require('node:child_process').spawn(bin,['-y','-i',fVideo,'-i',fAudio,'-map','0:v:0','-map','1:a:0','-c','copy','-movflags','+faststart',fSalida],{stdio:['ignore','ignore','ignore']});
let termino=false;
const codigo=await new Promise((resolvio)=>{
const alarma=setTimeout(()=>{try{hijo.kill('SIGKILL');}catch(e){}},Math.floor(Math.min(30000,restante())));
hijo.on('error',()=>{clearTimeout(alarma);if(!termino){termino=true;resolvio(-1);}});
hijo.on('exit',(c)=>{clearTimeout(alarma);if(!termino){termino=true;resolvio(Number(c===null?-1:c));}});
});
const peso=nodeFs.existsSync(fSalida)?nodeFs.statSync(fSalida).size:0;
if(codigo!==0||peso<10240){borrarCarpetaTemp(carpeta);return {ok:false,razon:'ffmpeg '+codigo+' (peso '+peso+'B)'};}
console.log('[dl][mux] '+alturaPedido+'p combinado: '+Math.round(peso/1048576)+'MB en '+Math.round((Date.now()-t0)/1000)+'s');
return {ok:true,archivo:fSalida,carpeta,peso,calidad:alturaPedido+'p'};
}catch(e){
borrarCarpetaTemp(carpeta);
return {ok:false,razon:String(e&&e.message||e).slice(0,100)};
}
}

// Entrega un archivo local ya combinado, con soporte de Range (una sola
// gama: los jugadores de WhatsApp piden bytes=0-). Limpieza SIEMPRE en close.
function streamArchivoMux(req,res,sendJson,requestId,mux){
const {archivo,carpeta}=mux;
let peso=0;
try{peso=nodeFs.statSync(archivo).size;}catch(e){borrarCarpetaTemp(carpeta);return sendJson(502,{ok:false,error:'MUX_TEMPORAL_PERDIDO',message:'El archivo combinado desaparecio antes de enviarse.'});}
let limpiado=false;
const limpiar=()=>{if(!limpiado){limpiado=true;borrarCarpetaTemp(carpeta);}};
res.on('close',limpiar);
try{res.removeHeader('Content-Encoding');}catch(e){}
res.removeHeader('Transfer-Encoding');
const rango=typeof req.headers.range==='string'&&req.headers.range.length<100?req.headers.range.match(/bytes=(\d*)-(\d*)/):null;
if(rango&&(rango[1]||rango[2])){
const inicio=rango[1]?Number(rango[1]):Math.max(0,peso-Number(rango[2]||0));
const fin=rango[2]?Math.min(Number(rango[2]),peso-1):peso-1;
if(inicio<=fin){
res.writeHead(206,{'Content-Type':'video/mp4','Content-Length':fin-inicio+1,'Accept-Ranges':'bytes','Content-Range':'bytes '+inicio+'-'+fin+'/'+peso,'Content-Disposition':'inline'});
const flujo=nodeFs.createReadStream(archivo,{start:inicio,end:fin});
flujo.on('error',()=>{limpiar();try{res.end();}catch(e){}});
flujo.pipe(res);
return;
}
}
res.writeHead(200,{'Content-Type':'video/mp4','Content-Length':peso,'Accept-Ranges':'bytes','Content-Disposition':'inline'});
const flujo=nodeFs.createReadStream(archivo);
flujo.on('error',()=>{limpiar();try{res.end();}catch(e){}});
flujo.pipe(res);
}

// Probe directo (sin proxy) que ademas valida el content-type: los CDN de Meta
// a veces responden HTML (muro de login / lookaside) con status 200; transmitir
// eso al cliente seria entregar basura. OJO: el lookaside de Facebook responde
// HTML con Range bytes=0-0 pero video/mp4 con bytes=0-99, por eso 0-99.
// Usa node:https con agent:false (conexion nueva por pedido, sin el pool de
// undici): reutilizar la conexion del probe anterior hace que el lookaside
// conteste con su HTML de redirect. Devuelve {ok,status,tipo}.
async function probeMediaTipo(mediaUrl,headers){
const destino=new URL(mediaUrl);
if(destino.protocol!=='https:')return {ok:false,status:0,tipo:''};
try{
let respuesta=await pedirHttps(destino.href,{...headers,Range:'bytes=0-99'});
for(let salto=0;salto<4&&[301,302,303,307,308].includes(respuesta.statusCode)&&respuesta.headers.location;salto+=1){
respuesta.resume();
respuesta=await pedirHttps(new URL(respuesta.headers.location,destino).href,{...headers,Range:'bytes=0-99'});
}
const tipo=String(respuesta.headers['content-type']||'');
const ok=(respuesta.statusCode===200||respuesta.statusCode===206)&&(tipo.includes('video')||tipo.includes('octet-stream'));
respuesta.resume();
return {ok,status:respuesta.statusCode,tipo};
}catch(e){return {ok:false,status:0,tipo:''};}
}

// Streaming por rangos paralelos (misma tecnica que usaba la era del proxy):
// el streaming undo single-stream desde Vercel a googlevideo a veces cae a
// ~250KB/s y muere a mitad por el maxDuration de 60s de la funcion. Con N
// rangos en paralelo (ventana de 3 in-flight, escritura en orden, sin buffer
// completo en memoria) el archivo entero llega dentro del limite.
async function streamRangosParalelos(req,res,mediaUrl,fetchHeaders,total,tipo){
const N=Math.min(16,Math.max(4,Math.ceil(total/(8*1024*1024))));
const tamanio=Math.ceil(total/N);
const enVuelo=new Map();
let fallo=null;
const pedirStream=async(i)=>{
const cab={...fetchHeaders,Range:'bytes='+(i*tamanio)+'-'+(Math.min(total-1,(i+1)*tamanio-1))};
for(let intento=1;intento<=2;intento+=1){
try{
const r=await fetch(mediaUrl,{headers:cab,redirect:'follow'});
if((r.status===200||r.status===206)&&r.body)return r;
try{await r.body?.cancel();}catch(e){}
throw new Error('HTTP '+r.status);
}catch(e){
if(intento===2)throw e;
await new Promise((x)=>setTimeout(x,400));
}
}
};
const lanzar=(i)=>{enVuelo.set(i,pedirStream(i).catch((e)=>{fallo=fallo||e;throw e;}));};
res.on('close',()=>{for(const[,p]of enVuelo){p.then((r)=>{try{r.body?.cancel();}catch(e){}}).catch(()=>{});}});
const drain=()=>new Promise((ok)=>res.once('drain',ok));
try{
let primer=null;
for(let i=0;i<N;i+=1){
if(fallo)throw fallo;
if(!enVuelo.has(i)){lanzar(i);if(enVuelo.size>=3)break;}
}
for(let i=0;i<N;i+=1){
if(fallo)throw fallo;
if(!enVuelo.has(i))lanzar(i);
const r=await enVuelo.get(i);
enVuelo.delete(i);
if(i===0){
primer=r;
res.statusCode=200;
res.setHeader('Content-Type',tipo||'application/octet-stream');
res.setHeader('Content-Length',String(total));
res.setHeader('Accept-Ranges','bytes');
}else{
for(let j=i+1;j<N&&enVuelo.size<3;j+=1){if(!enVuelo.has(j))lanzar(j);}
}
const reader=r.body.getReader();
for(;;){
const c=await reader.read();
if(c.done)break;
if(!res.write(Buffer.from(c.value)))await drain();
}
}
res.end();
}catch(e){
for(const[,p]of enVuelo){p.then((r)=>{try{r.body?.cancel();}catch(e2){}}).catch(()=>{});}
try{res.destroy();}catch(e2){}
}
}
module.exports=async function handler(req,res){
const requestId=randomUUID();
const sendJson=(status,payload)=>{
res.statusCode=status;
res.setHeader('Content-Type','application/json; charset=utf-8');
res.setHeader('X-Request-Id',requestId);
res.setHeader('Access-Control-Allow-Origin','*');
return res.end(JSON.stringify({...payload,requestId},null,2));
};
try{
const parsedUrl=new URL(req.url||'/',`https://${req.headers.host||'api.invalid'}`);
let pathname=parsedUrl.pathname.replace(/^\/api(?=\/|$)/,'');
if(!pathname)pathname='/';
if(pathname==='/favicon.ico')return res.end();
const esRutaAdmin=pathname==='/admin'||pathname.startsWith('/admin/')||pathname==='/ping'||pathname==='/fondo'||pathname==='/fondo-archivo'||pathname==='/musica'||pathname==='/musica-archivo';
if(req.method!=='GET'&&req.method!=='HEAD'&&!esRutaAdmin){
res.setHeader('Allow','GET, HEAD');
return sendJson(405,{ok:false,message:'Metodo no permitido. Usa GET o HEAD.'});
}
if(esRutaAdmin){
if(!adminApi){
return sendJson(500,{ok:false,code:'MODULE_LOAD_ERROR',message:'Error interno cargando el modulo de administracion.',error:String(adminApiLoadError&&adminApiLoadError.message||adminApiLoadError).slice(0,300)});
}
try{
return await adminApi.manejar(req,res,pathname,parsedUrl,requestId,sendJson);
}catch(e){
console.error(e);
return sendJson(500,{ok:false,message:'Error interno del panel de administracion.',error:String(e&&e.message||e).slice(0,200)});
}
}
if(pathname==='/'||pathname===''||pathname==='/docs'){
res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
return res.end(paginaDocs());
}
// Diagnostico de carga de modulos: si secure-api no cargo, las rutas que lo
// usan devuelven el error real en JSON en lugar de un 500 opaco de Vercel.
if(secureApiLoadError&&pathname!=='/'&&pathname!==''&&pathname!=='/docs'&&pathname!=='/status'){
return sendJson(500,{ok:false,code:'MODULE_LOAD_ERROR',message:'Error interno cargando un modulo de la API.',error:String(secureApiLoadError&&secureApiLoadError.message||secureApiLoadError).slice(0,300)});
}
const rawQuery=parsedUrl.searchParams.get('query')||parsedUrl.searchParams.get('url')||parsedUrl.searchParams.get('prompt')||'';
const query=rawQuery.trim();
const qualityParam=parsedUrl.searchParams.get('quality')||'best';
const limitParam=parsedUrl.searchParams.get('limit')||'5';
const isSearchRoute=['/ytsearch','/ttsearch'].includes(pathname);
if(!query&&['/ytmp3','/ytmp4','/youtube','/ytsearch','/tiktok','/ttsearch','/xvideo','/instagram','/facebook','/dl'].includes(pathname)){
return sendJson(400,{ok:false,message:'Falta el parametro query o url'});
}
if(!isSearchRoute&&pathname!=='/'&&!VALID_QUALITY.test(qualityParam)){
return sendJson(400,{ok:false,message:`Calidad invalida: "${qualityParam}". Usa ${CALIDADES_VALIDAS.join(', ')}.`});
}
let limit=Number(limitParam);
if(!VALID_LIMIT.test(limitParam)||limit<LIMIT_MIN||limit>LIMIT_MAX){
return sendJson(400,{ok:false,message:`Limite invalido: "${limitParam}". Usa un numero entre ${LIMIT_MIN} y ${LIMIT_MAX}.`});
}
if(pathname==='/dl'){
// Proteccion por clave: si DL_KEY esta definida, exigir ?key= o header x-api-key.
const dlKey=process.env.DL_KEY||'';
if(dlKey){
const provided=parsedUrl.searchParams.get('key')||(Array.isArray(req.headers['x-api-key'])?req.headers['x-api-key'][0]:req.headers['x-api-key'])||'';
if(provided!==dlKey){
return sendJson(401,{ok:false,dl_key_requerida:true,message:'Clave invalida o ausente. Pasa ?key= o el header x-api-key (la misma clave que mandes al pedir /ytmp4 o /ytmp3).'});
}
}
const kind=(parsedUrl.searchParams.get('kind')||'video').toLowerCase();
if(!DL_KINDS.includes(kind)){
return sendJson(400,{ok:false,message:'Parametro kind invalido. Usa audio, video, tiktok, x, instagram o facebook.'});
}
if(kind==='tiktok'||kind==='x'){
const {extractTikTokVideo}=require('./documentos/tiktok');
const {fetchXVideo}=require('./documentos/xvideo');
let data;
try{
data=kind==='tiktok'?await extractTikTokVideo(query):await fetchXVideo(query);
}catch(e){
return sendJson(502,{ok:false,message:'No se pudo resolver el video solicitado.',error:String(e&&e.message||e).slice(0,140)});
}
const scrapeHeaders=kind==='tiktok'?(data?.descarga_headers||{}):{};
const referer=kind==='tiktok'?'https://www.tiktok.com/':'https://x.com/';
const extraerUrls=(d)=>kind==='tiktok'
?[d?.data?.links?.hd,d?.data?.links?.wm,d?.data?.links?.sd].filter(Boolean)
:(d?.best?[d.best]:[]);
let candidatos=extraerUrls(data);
if(!candidatos.length){
return sendJson(502,{ok:false,message:'No se encontro una URL de media descargable para ese enlace.'});
}
const dlDeadline=Date.now()+45000;
let reScrapeado=false;
for(let ronda=0;ronda<2;ronda+=1){
for(const mediaUrl of candidatos){
if(Date.now()>dlDeadline)break;
let probeStatus=await probeMedia(mediaUrl,{...scrapeHeaders,Referer:referer});
if(probeStatus===403&&kind==='x'){
probeStatus=await probeMedia(mediaUrl,scrapeHeaders);
}
if(probeStatus===200||probeStatus===206){
return streamMedia(req,res,sendJson,requestId,mediaUrl,{referer,headers:scrapeHeaders});
}
}
if(ronda===0&&kind==='tiktok'&&!reScrapeado&&Date.now()<dlDeadline){
try{
data=await extractTikTokVideo(query);
candidatos=extraerUrls(data);
reScrapeado=true;
}catch(e){break;}
}else break;
}
return sendJson(502,{ok:false,error:'IP_BLOQUEADA',message:'Ningun cliente pudo descargar desde este hosting.'});
}
// kind instagram|facebook: resuelve el media con el MISMO scraping de los
// endpoints /instagram y /facebook y streamea con el pipeline de rangos
// paralelos. Sin proxy: los CDN de Meta amarran la URL a la IP que la pidio
// (la de Vercel en el scraping de esta misma invocacion), asi que la descarga
// debe salir por la misma ruta directa.
if(kind==='instagram'||kind==='facebook'){
const {fetchInstagramVideo,headersDePeticion}=require('./documentos/instagram');
const {fetchFacebookVideo,headersDeDescarga}=require('./documentos/facebook');
const referer=kind==='instagram'?'https://www.instagram.com/':'https://www.facebook.com/';
const scrapeHeaders=kind==='instagram'?headersDePeticion():headersDeDescarga();
// Para descargar hay que usar el MISMO User-Agent (y cookie, si hay) del
// scraping: los CDN de Meta amarran la respuesta a como fue pedida y con otro
// UA devuelven HTML o 403.
const resolver=()=>kind==='instagram'?fetchInstagramVideo(query):fetchFacebookVideo(query);
let ultimoError=null;
const debugProbes=parsedUrl.searchParams.get('debug')==='1'?[]:null;
// Dos rondas: si los candidatos no pasan el probe (el lookaside de Facebook
// alterna entre servir el video y un HTML de redirect), re-scrapear una vez
// antes de fallar; la segunda vuelta suele exponer URLs de video.xx.fbcdn.net.
for(let ronda=0;ronda<2;ronda+=1){
if(ronda>0)await new Promise(r=>setTimeout(r,1500));
let data;
try{
data=await resolver();
}catch(e){
ultimoError=e;
break;
}
if(!data||data.tipo!=='video'||!data.descarga_directa){
return sendJson(404,{ok:false,error:'SIN_VIDEO',message:'El post no contiene un video descargable (es una imagen, es privado o la plataforma no expuso el archivo).'});
}
const candidatos=[data.descarga_directa,...(Array.isArray(data.candidatos)?data.candidatos:[])]
.filter((u,i,a)=>typeof u==='string'&&/^https?:\/\//.test(u)&&a.indexOf(u)===i);
for(const mediaUrl of candidatos){
// Mismos headers exactos que los probes internos del scraping (sin Referer
// extra): cualquier diferencia entre el probe y la descarga es una chance de
// que el CDN de Meta cambie la respuesta.
const probe=await probeMediaTipo(mediaUrl,scrapeHeaders);
if(debugProbes)debugProbes.push({ronda,url:mediaUrl.slice(0,70),status:probe.status,tipo:probe.tipo});
if(probe.ok){
return streamMedia(req,res,sendJson,requestId,mediaUrl,{sinProxy:true,headers:scrapeHeaders,exigirVideo:true,mensajeBloqueo:'El CDN de '+(kind==='instagram'?'Instagram':'Facebook')+' rechazo la descarga desde este hosting (HTTP 403).'});
}
}
}
if(ultimoError){
return sendJson(404,{ok:false,error:'SIN_MEDIA',message:String(ultimoError&&ultimoError.message||ultimoError).slice(0,200)});
}
return sendJson(404,debugProbes?{ok:false,error:'SIN_MEDIA_DESCARGABLE',message:'La plataforma expuso el video pero el archivo no responde como video descargable desde este hosting (puede requerir sesion iniciada).',probes:debugProbes}:{ok:false,error:'SIN_MEDIA_DESCARGABLE',message:'La plataforma expuso el video pero el archivo no responde como video descargable desde este hosting (puede requerir sesion iniciada).'});
}
// kind audio|video -> YouTube: sistema 100% scraping en 3 capas, sin proxy.
// CAPA 1: clientes Innertube directos desde la IP de salida de Vercel.
// CAPA 2: instancias publicas (cobalt/Invidious/Piped) en paralelo, para
//   rescatar la descarga cuando la IP de Vercel esta bloqueada por googlevideo.
// CAPA 3: clientes sin cookie (WEB_EMBEDDED/TV_SIMPLY) al final de la capa 1.
// Ambas capas arrancan en paralelo; gana la capa 1 si llega a tiempo. Si todo
// falla se responde rapido con reintentar:true (Vercel rota la IP de salida).
let videoId=query;
let listaDlBusqueda=null;
const match=query.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:.*&)?v=|v\/|embed\/|shorts\/))([a-zA-Z0-9_-]{11})/);
if(match){
videoId=match[1];
}else if(!/^([a-zA-Z0-9_-]{11})$/.test(query)){
// Busqueda robusta (capa 1 con sesion anonima -> HTML -> Invidious). Se
// guardan varios candidatos: si el primero no es descargable por ningun canal
// (bloqueo por video), el plan B prueba los siguientes resultados.
const lista=await secureApi.buscarVideoYoutube(query,4).catch(()=>[]);
if(Array.isArray(lista)&&lista.length){videoId=String(lista[0].videoId);listaDlBusqueda=lista;}
}
if(!/^[a-zA-Z0-9_-]{11}$/.test(videoId))return sendJson(404,{ok:false,reintentar:true,message:'No se encontraron resultados para la busqueda: '+query});
const cookieHeader=secureApi.normalizeYoutubeCookie(process.env.YOUTUBE_COOKIE||process.env.youtube_cookie||'');
// Solo se mandan cookies de la sesion manual si sigue vigente (si esta vencida
// se dejo de usar automaticamente: ver cookieManualVigente en secure-api).
const hayCookie=!!cookieHeader&&secureApi.cookieManualVigente()!==false;
const dlHeadersBase=hayCookie?{Cookie:cookieHeader}:{};
// Fail fast (FALLA 1): presupuesto interno de 10s para obtener el primer
// exito (capa 1 + capa 2 en paralelo). Si a los 10s nada paso el probe, se
// responde 502 IP_BLOQUEADA con reintentar:true en ese momento: el bot
// reintenta y Vercel rota la IP de salida.
const dlDeadline=Date.now()+48000;
const tInicioDl=Date.now();
const intentos=[];
// debug=1: loguea y expone el diagnostico por cliente de la capa 1 (conteo
// de formatos total/soloVideo/progresivos, playability, PO token).
const debugDl=parsedUrl.searchParams.get('debug')==='1';
const tipoMedia=kind==='audio'?'audio':'video';
const calidadPedido=qualityParam==='best'?'best':qualityParam;
const extDefault=kind==='audio'?'m4a':'mp4';
const cacheKey=videoId+'|'+kind+'|'+calidadPedido;
const cacheado=dlMediaCache.get(cacheKey);
if(cacheado&&cacheado.expiresAt>Date.now()){
const probeCacheado=cacheado.sinRangos?await probeMediaFlujo(cacheado.url):await probeMedia(cacheado.url,cacheado.headers||{});
if(probeCacheado===200||probeCacheado===206){
console.log('[dl] cache hit ('+(cacheado.fuente||'-')+') probe='+probeCacheado);
return streamMedia(req,res,sendJson,requestId,cacheado.url,{referer:'https://www.youtube.com/',headers:cacheado.headers||{},filename:videoId+'.'+(cacheado.ext||extDefault),sinRangos:cacheado.sinRangos});
}
dlMediaCache.delete(cacheKey);
}
let claveCliente=videoId+'|'+kind;
const recordado=dlClienteCache.get(claveCliente);
if(recordado&&recordado.expiresAt<Date.now())dlClienteCache.delete(claveCliente);
// CAPA 1: scraping directo. Intento A = camino completo de youtubei.js
// (clientes en paralelo + PO token bgutil + watch page + sesion anonima
// auto-generada), recortado a 8s. Intento B = clientes puntuales en paralelo
// (capa 1 + capa 3 sin cookie), probe en orden de prioridad.
// CAPA 2: instancias publicas en paralelo.
// TAREAS 3/4: si la calidad pedida falla, se degrada (480p -> 360p -> itag 18)
// y se re-resuelve una vez con sesion anonima recien renovada antes de
// responder IP_BLOQUEADA.
const correrCascada=async(calidad,renovarSesion)=>{
const t0Pasada=Date.now();
if(renovarSesion){
try{await secureApi.obtenerSesionAnonima(true);
console.log('[dl] pasada calidad='+calidad+' con sesion anonima renovada');}catch(e){}
}
const intentoCapa1=(async()=>{
const conTimeout=(promesa,ms)=>Promise.race([promesa,new Promise((_,rechazar)=>setTimeout(()=>rechazar(new Error('timeout '+ms+'ms')),ms))]);
try{
const media=await conTimeout(secureApi.fetchYoutubeMedia(videoId,tipoMedia,calidad,null,{sinProxy:true,debug:debugDl}),20000);
if(media&&media.url){
let probeStatus=await probeMedia(media.url,dlHeadersBase);
if(probeStatus!==200&&probeStatus!==206){
const porFlujo=await probeMediaFlujo(media.url);
if(porFlujo){
probeStatus=porFlujo;
console.log('[dl] probe Range/Cookie 403 pero flujo directo OK (video sin DASH): streameando sin rangos');
return {ok:true,url:media.url,headers:{},detalle:'auto flujo',ext:extDefault,sinRangos:true};
}
}
if(probeStatus!==200&&probeStatus!==206&&debugDl&&media.diagnostico){
console.log('[dl][capa1][debug] auto probe='+probeStatus+' diagnostico: '+JSON.stringify(media.diagnostico).slice(0,400));
}
intentos.push(Object.assign({capa:1,objetivo:'auto',resultado:'probe '+probeStatus,ms:Date.now()-t0Pasada},debugDl&&media.diagnostico?{detalles:media.diagnostico}:{}));
console.log('[dl][capa1] auto probe='+probeStatus+' ('+(Date.now()-t0Pasada)+'ms)');
if(probeStatus===200||probeStatus===206){
dlClienteCache.set(claveCliente,{cliente:null,cookie:true,expiresAt:Date.now()+6*60*60*1000});
return {ok:true,url:media.url,headers:dlHeadersBase,detalle:'auto',ext:extDefault};
}
}
}catch(e){
intentos.push(Object.assign({capa:1,objetivo:'auto',resultado:'fallo: '+String(e&&e.message||e).slice(0,110),ms:Date.now()-t0Pasada},debugDl&&e&&e.detalles?{detalles:e.detalles}:{}));
console.log('[dl][capa1] auto fallo: '+String(e&&e.message||e).slice(0,100)+' (debug='+(debugDl?'si':'no')+') ('+(Date.now()-t0Pasada)+'ms)');
}
let instanciaConCookie=null,instanciaSinCookie=null;
try{instanciaConCookie=await secureApi.getYoutubeInstance(true);}catch(e){console.log('[dl][capa1] instancia con cookie fallo: '+String(e&&e.message||e).slice(0,80));}
try{instanciaSinCookie=await secureApi.getYoutubeInstance(false);}catch(e){}
if(!instanciaConCookie&&!instanciaSinCookie)return {ok:false};
const construirCandidatos=()=>{
const base=[
{cliente:'WEB',cookie:true,capa:1},
{cliente:'WEB',cookie:false,capa:1},
{cliente:'WEB_EMBEDDED',cookie:true,capa:1},
{cliente:'TV_SIMPLY',cookie:true,capa:1},
{cliente:'ANDROID_VR',cookie:true,capa:1},
{cliente:'IOS',cookie:true,capa:1},
{cliente:'MWEB',cookie:true,capa:1},
{cliente:'ANDROID',cookie:true,capa:1},
{cliente:'WEB_EMBEDDED',cookie:false,capa:3},
{cliente:'TV_SIMPLY',cookie:false,capa:3},
];
if(recordado){
const idx=base.findIndex((c)=>c.cliente===recordado.cliente&&c.cookie===recordado.cookie);
if(idx>0){const elegido=base.splice(idx,1)[0];base.unshift(elegido);console.log('[dl] cliente recordado primero: '+recordado.cliente);}
}
return base.filter((c)=>(c.cookie!==false?instanciaConCookie:instanciaSinCookie));
};
const candidatos=construirCandidatos();
const resultados=await Promise.allSettled(candidatos.map((c)=>conTimeout(
secureApi.fetchYoutubeMedia(videoId,tipoMedia,calidad,null,{client:c.cliente,cookie:c.cookie,sinProxy:true,debug:debugDl,youtube:c.cookie!==false?instanciaConCookie:instanciaSinCookie}),
12000,
)));
for(let i=0;i<candidatos.length;i+=1){
if(Date.now()>dlDeadline)break;
const r=resultados[i];
if(r.status!=='fulfilled'||!r.value||!r.value.url)continue;
const c=candidatos[i];
const headers=c.cookie&&hayCookie?{Cookie:cookieHeader}:{};
let probeStatus=await probeMedia(r.value.url,headers);
if(probeStatus!==200&&probeStatus!==206){
const porFlujo=await probeMediaFlujo(r.value.url);
if(porFlujo){
probeStatus=porFlujo;
dlClienteCache.set(claveCliente,{cliente:c.cliente,cookie:c.cookie,expiresAt:Date.now()+6*60*60*1000});
if(dlClienteCache.size>200)dlClienteCache.delete(dlClienteCache.keys().next().value);
console.log('[dl] probe Range/Cookie 403 pero flujo directo OK ('+c.cliente+'): streameando sin rangos');
return {ok:true,url:r.value.url,headers:{},detalle:'capa'+c.capa+' '+c.cliente+' flujo',ext:extDefault,sinRangos:true};
}
}
intentos.push(Object.assign({capa:c.capa,objetivo:c.cliente+(c.cookie?'+cookie':'-sincookie'),resultado:'probe '+probeStatus,ms:Date.now()-t0Pasada},debugDl&&r.value.diagnostico?{detalles:r.value.diagnostico.slice(-4)}:{}));
console.log('[dl][capa'+c.capa+'] cliente='+c.cliente+(c.cookie?' +cookie':' sincookie')+' probe='+probeStatus+' ('+(Date.now()-t0Pasada)+'ms)');
if(probeStatus===200||probeStatus===206){
dlClienteCache.set(claveCliente,{cliente:c.cliente,cookie:c.cookie,expiresAt:Date.now()+6*60*60*1000});
if(dlClienteCache.size>200)dlClienteCache.delete(dlClienteCache.keys().next().value);
return {ok:true,url:r.value.url,headers,detalle:'capa'+c.capa+' '+c.cliente,ext:extDefault};
}
}
return {ok:false};
})();
const intentoCapa2=secureApi.resolverViaInstanciasPublicas(videoId,tipoMedia,18000).catch(()=>null);
// Prioridad capa 1: hasta 20s (Vercel permite 60s). Si no llega, se usa capa 2 si ya esta lista.
let r1=await Promise.race([intentoCapa1,new Promise((r)=>setTimeout(()=>r(null),20000))]);
if(!(r1&&r1.ok)){
const restante2=Math.max(0,21000-(Date.now()-t0Pasada));
const r2=await Promise.race([intentoCapa2,new Promise((r)=>setTimeout(()=>r(null),restante2))]);
if(r2&&r2.url){
dlMediaCache.set(videoId+'|'+kind+'|'+calidad,{url:r2.url,headers:{},fuente:'capa2:'+r2.fuente+':'+r2.instancia,ext:r2.ext,expiresAt:Date.now()+30*60*1000});
if(dlMediaCache.size>50)dlMediaCache.delete(dlMediaCache.keys().next().value);
console.log('[dl] salida por CAPA 2 ('+r2.fuente+':'+r2.instancia+' calidad='+r2.calidad+') a los '+(Date.now()-t0Pasada)+'ms');
return {ok:true,url:r2.url,headers:{},detalle:'capa2 '+r2.fuente+':'+r2.instancia,ext:r2.ext};
}
const restante1=Math.max(0,22000-(Date.now()-t0Pasada));
r1=await Promise.race([intentoCapa1,new Promise((r)=>setTimeout(()=>r(null),restante1))]);
}
if(r1&&r1.ok){
dlMediaCache.set(videoId+'|'+kind+'|'+calidad,{url:r1.url,headers:r1.headers,fuente:'capa1:'+r1.detalle,ext:r1.ext,sinRangos:!!r1.sinRangos,expiresAt:Date.now()+30*60*1000});
if(dlMediaCache.size>50)dlMediaCache.delete(dlMediaCache.keys().next().value);
console.log('[dl] salida por CAPA 1 ('+r1.detalle+' calidad='+calidad+') a los '+(Date.now()-t0Pasada)+'ms');
return {ok:true,url:r1.url,headers:r1.headers,detalle:r1.detalle,ext:r1.ext,sinRangos:!!r1.sinRangos};
}
return null;
};
// MUX REAL 480p+: los pedidos explicitos de 480p/720p+ se resuelven aki con
// video adaptativo + audio combinados por ffmpeg (la escalera de abajo solo
// entrega progresivos con audio). Cualquier fallo degrada a la escalera.
if(kind==='video'&&/^(?:480|720|1080|1440|2160)p$/.test(calidadPedido)&&binFfmpeg()){
const presupuestoMux=Math.min(42000,dlDeadline-Date.now()-9000);
if(presupuestoMux>12000){
console.log('[dl][mux] intento '+calidadPedido+' combinado para '+videoId+' (presupuesto '+Math.round(presupuestoMux/1000)+'s)');
const mux=await muxVideoCalidad(videoId,Number(calidadPedido.slice(0,-1)),presupuestoMux);
if(mux&&mux.ok){
intentos.push({capa:'mux',objetivo:calidadPedido,resultado:'ok '+Math.round(mux.peso/1048576)+'MB',ms:Date.now()-tInicioDl});
return streamArchivoMux(req,res,sendJson,requestId,mux);
}
intentos.push({capa:'mux',objetivo:calidadPedido,resultado:mux?mux.razon:'sin ffmpeg',ms:Date.now()-tInicioDl});
console.log('[dl][mux] '+calidadPedido+' fallo, sigue la escalera: '+(mux?mux.razon:''));
}
}
// Pasada 1 con la calidad pedida; si falla y el deadline lo permite, pasadas
// siguientes con calidades degradadas (y la 2da con sesion anonima renovada).
const escalera=secureApi.escaleraCalidades(kind,calidadPedido);
const correrEscaleraParaId=async()=>{
let salida=null;
let calidadUsada='';
for(let i=0;i<escalera.length;i+=1){
const cal=escalera[i];
if(i>0&&Date.now()>dlDeadline-9000)break;
salida=await correrCascada(cal,i===1);
if(salida){calidadUsada=cal;break;}
}
if(!salida&&Date.now()<dlDeadline-9000){
// Ultima oportunidad (TAREA 4): sesion anonima recien renovada + calidad minima.
salida=await correrCascada(kind==='audio'?calidadPedido:'18',true);
if(salida)calidadUsada=kind==='audio'?calidadPedido:'18';
}
return {salida,calidadUsada};
};
let rr=await correrEscaleraParaId();
// PLAN B por texto: si el primer resultado de la busqueda no es descargable
// por ningun canal, se prueban los siguientes candidatos de la misma busqueda
// (mismo pedido al usuario, otro video igual de valido).
if((!rr.salida)&&Array.isArray(listaDlBusqueda)&&listaDlBusqueda.length>1){
for(const cand of listaDlBusqueda.slice(1)){
const vidAlt=String(cand.videoId||'');
if(!vidAlt||vidAlt===videoId)continue;
if(Date.now()>dlDeadline-10000)break;
console.log('[dl] plan B: probando resultado alternativo '+vidAlt+' ('+String(cand.titulo||'').slice(0,40)+')');
videoId=vidAlt;
claveCliente=vidAlt+'|'+kind;
rr=await correrEscaleraParaId();
if(rr.salida)break;
}
}
const salida=rr.salida;
const calidadUsada=rr.calidadUsada;
if(salida){
console.log('[dl] entregado calidad='+calidadUsada+' fuente='+salida.detalle+' total='+(Date.now()-tInicioDl)+'ms');
return streamMedia(req,res,sendJson,requestId,salida.url,{referer:'https://www.youtube.com/',headers:salida.headers,filename:videoId+'.'+salida.ext,sinRangos:!!salida.sinRangos});
}
return sendJson(502,{ok:false,error:'IP_BLOQUEADA',reintentar:true,message:'Ningun cliente ni instancia publica pudo descargar desde este hosting. Vercel rota la IP de salida: reintentar suele funcionar.',intentos:[...intentos.slice(-6),...(secureApi.obtenerRegistroCapa2?secureApi.obtenerRegistroCapa2():[]).slice(-9)]});
}
if(pathname==='/ytmp3'||pathname==='/ytmp4'||pathname==='/youtube'||pathname==='/ytsearch'){
let videoId=query;
let searchMeta=null;
let listaBusqueda=null;
const match=query.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:.*&)?v=|v\/|embed\/|shorts\/))([a-zA-Z0-9_-]{11})/);
if(match){
videoId=match[1];
}else if(/(?:youtu\.be\/|youtube\.com\/(?:watch\?|v\/|embed\/|shorts\/))/.test(query)&&!/^[a-zA-Z0-9_-]{11}$/.test(query)){
// Parece URL de YouTube pero no contiene un videoId valido (watch?v=abc,
// enlace cortado...): buscar la URL literal como texto devolveria un video
// CUALQUIERA. Error limpio en su lugar.
return sendJson(400,{ok:false,code:'YOUTUBE_VIDEO_ID_INVALID',message:'El enlace es de YouTube pero no contiene un videoId valido: '+query.slice(0,80)});
}else if(!/^[a-zA-Z0-9_-]{11}$/.test(query)){
// BUSQUEDA ROBUSTA: sesion anonima -> HTML de /results -> Invidious.
// listaBusqueda vive en el scope de la ruta: el plan B la consulta tambien
// cuando query es un videoId/URL; declararla con const dentro de este bloque
// producia ReferenceError: listaBusqueda is not defined.
listaBusqueda=await secureApi.buscarVideoYoutube(query,pathname==='/ytsearch'?limit:3).catch(()=>[]);
if(!Array.isArray(listaBusqueda)||!listaBusqueda.length){
// La busqueda interna a veces vuelve vacia de forma TRANSITORIA (mismo
// sintoma que /ytsearch resuelve solo): se renueva la sesion anonima y se
// reconsulta una vez antes de declarar 404.
try{await secureApi.obtenerSesionAnonima(true);}catch(e){}
listaBusqueda=await secureApi.buscarVideoYoutube(query,pathname==='/ytsearch'?limit:3).catch(()=>[]);
}
if(!Array.isArray(listaBusqueda)||!listaBusqueda.length){
return sendJson(404,{ok:false,reintentar:true,message:'No se encontraron resultados para la busqueda: '+query});
}
const primer=listaBusqueda[0];
videoId=String(primer.videoId);
searchMeta={titulo:primer.titulo||'',canal:primer.canal||'',visitas:Number(primer.visitas)||0,duracion:Number(primer.duracion)||0};
}
if(pathname==='/ytsearch'){
const results=(await secureApi.buscarVideoYoutube(query,limit).catch(()=>[])).map((v)=>({
videoId:v.videoId,
title:v.titulo||'Desconocido',
canal:v.canal||'Desconocido',
visitas:v.visitas?String(v.visitas):'0',
duracion:v.duracion>0?(function(){const s=Number(v.duracion);const h=Math.floor(s/3600);const m=Math.floor((s%3600)/60);const r=s%60;return (h>0?h+':'+String(m).padStart(2,'0'):String(m))+':'+String(r).padStart(2,'0');})():'N/A',
publicado:'N/A',
url:`https://www.youtube.com/watch?v=${v.videoId}`,
thumbnail:`https://i.ytimg.com/vi/${v.videoId}/maxresdefault.jpg`
}));
return sendJson(200,{ok:true,source:'youtube',query,total_resultados:results.length,resultados:results});
}
const isAudio=pathname==='/ytmp3';
// Capa 1 = scraping directo desde la IP de salida. Si esta bloqueada (Sign in
// to confirm you're not a bot), Capa 2 = instancias publicas (cobalt tunnel:
// no queda amarrado a nuestra IP). Presupuesto global 32s para dejar lugar al
// plan B (resultados alternativos de la busqueda) en la misma peticion.
const t0Ytmp=Date.now();
const restanteYtmp=()=>32000-(Date.now()-t0Ytmp);
// Si en ESTA peticion la capa 1 ya devolvio LOGIN_REQUIRED, los siguientes
// candidatos van directo a capa 2 (la capa 1 no cambia de opinion por IP).
let loginDetectado=false;
let altCapa2=null;
const resolverYtmp=async(vid,saltarCapa1)=>{
const pedirCapa1Ytmp=async(presupuestoMs,opciones={})=>secureApi.fetchYoutubeMedia(vid,isAudio?'audio':'video',qualityParam==='best'?'best':qualityParam,null,{presupuestoMs,sesionRenovada:true,...opciones});
const capa2EnParalelo=secureApi.resolverViaInstanciasPublicas(vid,isAudio?'audio':'video',16000).catch(()=>null);
let media=null;
let errorCapa1=null;
if(!saltarCapa1){
try{
media=await pedirCapa1Ytmp(Math.min(18000,Math.max(12000,restanteYtmp()-13000)));
console.log('[ytmp]['+vid+'] capa1 ok ('+(Date.now()-t0Ytmp)+'ms)');
}catch(e){
errorCapa1=e;
if(e&&e.code==='YOUTUBE_LOGIN_REQUIRED'||/LOGIN_REQUIRED/.test(String(e&&e.message||''))){loginDetectado=true;}
console.log('[ytmp]['+vid+'] capa1 fallo: '+String(e&&e.message||e).slice(0,120)+' ('+(Date.now()-t0Ytmp)+'ms)');
}
if(!media||!media.url){
// Con LOGIN_REQUIRED el reintento con otra sesion anonima no cambia nada y se
// come el presupuesto que necesita la capa 2.
const loginRequerido=!!(errorCapa1&&(errorCapa1.code==='YOUTUBE_LOGIN_REQUIRED'||/LOGIN_REQUIRED/.test(String(errorCapa1.message||''))));
// Reintento unico con sesion anonima recien renovada (solo si queda presupuesto).
if(!loginRequerido&&restanteYtmp()>=6000){
try{await secureApi.obtenerSesionAnonima(true);console.log('[ytmp] reintento con sesion anonima renovada (restante '+restanteYtmp()+'ms)');}catch(e){}
try{media=await pedirCapa1Ytmp(Math.min(5500,Math.max(3000,restanteYtmp()-500)),{cookie:false});console.log('[ytmp] reintento OK ('+(Date.now()-t0Ytmp)+'ms)');}catch(e2){console.log('[ytmp] reintento fallo: '+String(e2&&e2.message||e2).slice(0,120));}
}
}
}
const cosecharCapa2=async()=>{
if(!capa2EnParalelo)return;
const esperaCapa2=Math.max(1200,restanteYtmp()-300);
altCapa2=await Promise.race([capa2EnParalelo,new Promise((r)=>setTimeout(()=>r(null),esperaCapa2))]);
if(altCapa2&&altCapa2.url){
console.log('[ytmp]['+vid+'] respaldo por CAPA 2 via '+altCapa2.fuente+':'+altCapa2.instancia);
media={url:altCapa2.url,quality:altCapa2.calidad||'',basic_info:{},proxy_dl:true,...(altCapa2.sin_audio?{sin_audio:true}:{})};
}
};
if(!media||!media.url){
// Se cosecha la capa 2 que ya venia corriendo (no se relanza).
await cosecharCapa2();
}
if((!media||!media.url)&&!saltarCapa1){
// Segunda ola de CAPA 2 con descubrimiento forzado: en cold start el pool
// viene frio y la primera ola puede agotarse sin tocar una instancia viva.
try{await secureApi.descubrirInstancias(true);}catch(e){}
console.log('[ytmp]['+vid+'] capa 2 segunda ola (descubrimiento forzado)');
altCapa2=await secureApi.resolverViaInstanciasPublicas(vid,isAudio?'audio':'video',10000).catch(()=>null);
if(altCapa2&&altCapa2.url){
console.log('[ytmp]['+vid+'] respaldo por CAPA 2 (2da ola) via '+altCapa2.fuente+':'+altCapa2.instancia);
media={url:altCapa2.url,quality:altCapa2.calidad||'',basic_info:{},proxy_dl:true,...(altCapa2.sin_audio?{sin_audio:true}:{})};
}
}
if(!media||!media.url){
// En el fallo total se mantiene el error de capa 1 pero con reintentar
// (FALLA 3): el bot reintenta y Vercel rota la IP de salida.
if(errorCapa1){
// SOLO los errores transitorios (5xx) se marcan reintentar:true: los 4xx
// permanentes (404 video inexistente, 400 URL invalida) mantienen su flag
// original porque reintentar no cambiaria el resultado.
if(!(errorCapa1.statusCode>=400&&errorCapa1.statusCode<500))errorCapa1.reintentar=true;
if(secureApi.obtenerRegistroCapa2)errorCapa1.registro_capa2=secureApi.obtenerRegistroCapa2();
if(errorCapa1.code==='REQUEST_TIMEOUT'||errorCapa1.statusCode===504){
const reemplazo=secureApi.apiError(502,'YouTube no respondio a tiempo. Reintentar suele funcionar (Vercel rota la IP de salida).',{code:'YOUTUBE_TIMEOUT'});
reemplazo.reintentar=true;
errorCapa1=reemplazo;
}
}
throw errorCapa1||secureApi.apiError(502,'No se pudo obtener el enlace de descarga desde este hosting: reintentar suele funcionar (Vercel rota la IP de salida).',{code:'IP_BLOQUEADA'});
}
return media;
};
let media=null;
let errorTotal=null;
altCapa2=null;
try{media=await resolverYtmp(videoId,false);}catch(e){errorTotal=e;}
// PLAN B: si el primer resultado de la busqueda no se pudo resolver (bloqueo
// por video, instancia saturada...), se prueban los resultados siguientes:
// cualquier match real de la busqueda sirve para el usuario.
if((!media||!media.url)&&Array.isArray(listaBusqueda)&&listaBusqueda.length>1){
for(const cand of listaBusqueda.slice(1).slice(0,3)){
const vidAlt=String(cand.videoId||'');
if(!vidAlt||vidAlt===videoId)continue;
if(restanteYtmp()<3500)break;
console.log('[ytmp] plan B: probando resultado alternativo '+vidAlt+' ('+String(cand.titulo||'').slice(0,40)+')');
try{media=await resolverYtmp(vidAlt,true);}catch(e2){errorTotal=e2;continue;}
if(media&&media.url){
videoId=vidAlt;
searchMeta={titulo:cand.titulo||'',canal:cand.canal||'',visitas:Number(cand.visitas)||0,duracion:Number(cand.duracion)||0};
break;
}
}
}
if(!media||!media.url){
throw errorTotal||secureApi.apiError(502,'No se pudo obtener el enlace de descarga desde este hosting: reintentar suele funcionar (Vercel rota la IP de salida).',{code:'IP_BLOQUEADA'});
}
const basic=media.basic_info||{};
const canal=(typeof basic.author==='string'&&basic.author)?basic.author:(searchMeta?.canal||'Desconocido');
const titulo=(typeof basic.title==='string'&&basic.title)?basic.title:(searchMeta?.titulo||'Desconocido');
const link=`https://www.youtube.com/watch?v=${videoId}`;
// El wrapper de descarga_directa apunta a /dl y /dl exige la clave. Si esta
// llamada no trae la clave correcta, ese enlace responde 401: se avisa en el
// JSON (requiere_key) en vez de devolver un link que muere sin explicacion.
const dlKeyServidor=process.env.DL_KEY||'';
const claveEnviada=parsedUrl.searchParams.get('key')||(Array.isArray(req.headers['x-api-key'])?req.headers['x-api-key'][0]:req.headers['x-api-key'])||'';
const faltaClaveDl=!!dlKeyServidor&&claveEnviada!==dlKeyServidor;
let tituloFinal=titulo,canalFinal=canal;
if(tituloFinal==='Desconocido'||canalFinal==='Desconocido'){
try{
const oe=await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(link)}&format=json`,{signal:AbortSignal.timeout(3000)}).then(r=>r.json());
if(typeof oe.title==='string'&&oe.title)tituloFinal=oe.title;
if(typeof oe.author_name==='string'&&oe.author_name)canalFinal=oe.author_name;
}catch(e){}
}
return sendJson(200,{
ok:true,
tipo:isAudio?'Audio MP3':'Video MP4',
titulo:tituloFinal,
canal:canalFinal,
link,
visitas:Number(basic.view_count)||altCapa2?.meta?.visitas||searchMeta?.visitas||0,
likes:Number(basic.like_count)||altCapa2?.meta?.likes||0,
duracion_segundos:Number(basic.duration)||altCapa2?.meta?.duracion||searchMeta?.duracion||0,
videoId:videoId,
url_original:link,
// Los URLs de googlevideo vienen amarrados a la IP que los resolvio
// (parametro ip=...; verificado en vivo: descargarlos desde otra IP da HTTP
// 403 text/plain, justo el fallo que reporta el bot con "enlace directo").
// Si el resolvedor fue googlevideo, se entrega la descarga pasando por /dl
// (el bot baja desde la misma API, que streamea y reintentara con otra IP si hace falta); si fue
// un tunnel de instancia publica (no amarrado), se deja el URL directo.
descarga_directa:(()=>{
try{
// Dos casos necesitan pasar por /dl (que streamea server-side con User-Agent
// de navegador y reintenta): googlevideo, que ata la URL a la IP que la
// resolvio, y las instancias publicas (proxy_dl), que devuelven 403 a
// cualquier UA que no sea de navegador (axios/python/undici incluidos).
if(typeof media.url==='string'&&(media.proxy_dl===true||/googlevideo\.com/.test(new URL(media.url).host))){
const hostCab=(req.headers&&typeof req.headers.host==='string')?req.headers.host.trim():'';
if(hostCab&&!hostCab.includes(' ')){
const proto=(req.headers['x-forwarded-proto']||'').toString().split(',')[0].trim()==='http'?'http':'https';
const claveReq=parsedUrl.searchParams.get('key')||(Array.isArray(req.headers['x-api-key'])?req.headers['x-api-key'][0]:req.headers['x-api-key'])||'';
return proto+'://'+hostCab+'/dl?query='+encodeURIComponent(videoId)+'&kind='+encodeURIComponent(isAudio?'audio':'video')+'&key='+encodeURIComponent(String(claveReq||''));
}
}
}catch(e){console.log("[ytmp] wrapper descarga_directa fallo: "+String(e&&e.message||e).slice(0,120));}
return media.url;
})(),
calidad:media.quality||'Audio/Best',
...(faltaClaveDl?{requiere_key:true,aviso:'descarga_directa pasa por /dl: agrega ?key= (o el header x-api-key) a esta misma llamada para que el enlace funcione.'}:{}),
// El respaldo por instancia publica solo expone DASH separado para algunos
// videos: se avisa para que el bot no entregue un video mudo sin saberlo.
...(media.sin_audio?{sin_audio:true,aviso_audio:'Este respaldo entrega el video sin pista de audio (la instancia publica solo expone DASH separado para este video).'}:{}),
miniatura:`https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`
});
}
if(pathname==='/tiktok'||pathname==='/ttsearch'){
try{
const {searchTikTok,obtenerDiagnosticoTikTok}=require('./documentos/ttsearch');
const {extractTikTokVideo}=require('./documentos/tiktok');
if(pathname==='/ttsearch'){let r;try{r=await searchTikTok(query,limit);}catch(e){r=[];}const rLista=Array.isArray(r)?r:[];const diag=obtenerDiagnosticoTikTok();
if(rLista.length===0&&diag&&diag.todo_fallo){
console.log('[ttsearch] http 502 BUSQUEDA_INESTABLE (todas las fuentes vacias) query="'+String(query).slice(0,60)+'"');
return sendJson(502,{ok:false,error:'BUSQUEDA_INESTABLE',reintentar:true,message:'Todas las fuentes de busqueda de TikTok fallaron en este intento. El bot debe reintentar: es intermitente, no falta de resultados.',diagnostico:diag});
}
return sendJson(200,{ok:true,results:rLista,...(parsedUrl.searchParams.get('debug')==='1'?{diagnostico:diag}:{})});}
return sendJson(200,{ok:true,...(await extractTikTokVideo(query))});
}catch(e){return sendJson(502,{ok:false,message:'Modulo TikTok no disponible',error:e.message});}
}
if(pathname==='/xvideo'||pathname==='/x'){
try{
const {fetchXVideo}=require('./documentos/xvideo');
return sendJson(200,{ok:true,...(await fetchXVideo(query))});
}catch(e){
// apiError trae su statusCode real (400 URL invalida, 404 no existe, 502
// upstream...): responder 502 a todo plano diagnostico engañoso al bot y
// activaba reintentos inutiles cuando nada podia cambiar.
const codigo=Number(e&&e.statusCode)>=400&&Number(e&&e.statusCode)<=599?Number(e.statusCode):502;
return sendJson(codigo,{ok:false,reintentar:(codigo===502||codigo===504)||undefined,message:codigo===502?'Modulo X no disponible':String(e&&e.message||'Modulo X no disponible').slice(0,200),error:e.message});
}
}
if(pathname==='/instagram'||pathname==='/facebook'){
try{
const {fetchInstagramVideo}=require('./documentos/instagram');
const {fetchFacebookVideo}=require('./documentos/facebook');
const data=pathname==='/instagram'?await fetchInstagramVideo(query):await fetchFacebookVideo(query);
return sendJson(200,data);
}catch(e){
return sendJson(404,{ok:false,error:{message:String(e&&e.message||e).slice(0,220)}});
}
}
if(pathname==='/status'){
return sendJson(200,{ok:true,servicio:'ZETA-CORE API',secureApi_cargada:!secureApiLoadError,secureApi_error:secureApiLoadError?String(secureApiLoadError&&secureApiLoadError.message||secureApiLoadError).slice(0,300):undefined,youtube_cookie_configurada:!!(process.env.YOUTUBE_COOKIE||process.env.youtube_cookie),youtube_cookie_vigente:!!(process.env.YOUTUBE_COOKIE||process.env.youtube_cookie)&&secureApi.cookieManualVigente()!==false,youtube_visitor_data_configurada:!!(process.env.YOUTUBE_VISITOR_DATA||process.env.youtube_visitor_data),precalentamiento:(secureApi.estadoPrecalentamiento&&typeof secureApi.estadoPrecalentamiento==='function')?secureApi.estadoPrecalentamiento():null,sesion_anonima:(secureApi.estadoSesionAnonima?typeof secureApi.estadoSesionAnonima==='function'?secureApi.estadoSesionAnonima():{activa:false}:{activa:false}),dl_key_configurada:!!(process.env.DL_KEY||process.env.dl_key),capas_activas:['scraping_directo','instancias_publicas'],instancias_descubiertas:(secureApi.estadoInstanciasDescubiertas&&typeof secureApi.estadoInstanciasDescubiertas==='function')?secureApi.estadoInstanciasDescubiertas():null,instancias_publicas:(secureApi.listadoInstanciasPublicas&&typeof secureApi.listadoInstanciasPublicas==='function')?secureApi.listadoInstanciasPublicas():null,configuracion_dueno:'no requerida: la API auto-gestiona su sesion anonima y su pool de instancias publicas',admin_password_configurada:!!(process.env.ADMIN_PASSWORD||process.env.admin_password),endpoints:['/ytmp4','/ytmp3','/ytsearch','/tiktok','/ttsearch','/xvideo','/instagram','/facebook','/dl','/status']});
}
return sendJson(404,{ok:false,message:'Ruta no encontrada: '+pathname});
}catch(error){
console.error(error);
return sendJson(error.statusCode||500,{ok:false,code:error.code||'CRITICAL_ERROR',message:error.message,solucion:error.solucion||"Revisa los logs en Vercel.",...(error.detalles?{detalles:error.detalles}:{}),reintentar:error.reintentar===false?false:!!error.reintentar});
}
};
