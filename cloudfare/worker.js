/**
 * 10eLotto Worker — Cloudflare Workers
 * 
 * Endpoints:
 *   GET ?action=cron&secret=SECRET  → eseguito da GitHub Actions ogni 5 min
 *   GET ?action=status              → stato corrente (previsione + ultimi risultati)
 *   GET ?action=history&n=50        → storico estrazioni
 *   GET ?action=patterns            → pattern identificati
 *   POST ?action=giocata&secret=S   → registra giocata reale (body JSON)
 *
 * KV namespace: LOTTO_KV (bindato nel Worker dashboard)
 */

const CRON_SECRET  = 'lotto2026secret'; // cambia questo
const TARGET_URL   = 'https://lottologia.com/10elotto5minuti/tutte-le-estrazioni';
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Content-Type': 'application/json',
};

// ─── MESI ITALIANI ───────────────────────────────────────────
const MONTHS_IT = {gen:'01',feb:'02',mar:'03',apr:'04',mag:'05',giu:'06',
                   lug:'07',ago:'08',set:'09',ott:'10',nov:'11',dic:'12'};

function dateToKey(dateStr) {
  const parts = dateStr.trim().toLowerCase().split(/\s+/);
  if (parts.length < 3) return dateStr;
  return `${parts[2]}-${MONTHS_IT[parts[1].slice(0,3)]||'00'}-${parts[0].padStart(2,'0')}`;
}

// ─── PARSER HTML ─────────────────────────────────────────────
function parseNums(str) {
  const digits = str.replace(/[^0-9]/g, '');
  const nums = [];
  for (let i = 0; i + 1 < digits.length; i += 2) {
    const n = parseInt(digits.slice(i, i+2), 10);
    if (n >= 1 && n <= 90) nums.push(n);
  }
  return nums;
}

function parseHtml(html) {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, '\n')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#\d+;/g, '')
    .replace(/&[a-z]+;/g, '');

  const HEADER = /#(\d+)\s+(\d{1,2}\s+\w+\s+\d{4})\s+(\d{2}:\d{2})/g;
  const headers = [];
  let m;
  while ((m = HEADER.exec(text)) !== null)
    headers.push({ id: parseInt(m[1]), date: m[2].trim(), time: m[3], pos: m.index + m[0].length });

  const results = [];
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i];
    const end = i+1 < headers.length ? headers[i+1].pos : text.length;
    const body = text.slice(h.pos, end);
    const numPos   = body.search(/Numeri/i);
    const oroPos   = body.search(/\bOro\b/i);
    const extraPos = body.search(/Extra/i);
    if (numPos === -1 || extraPos === -1) continue;
    const baseEnd = (oroPos !== -1 && oroPos > numPos) ? oroPos : extraPos;
    const base  = parseNums(body.slice(numPos+6, baseEnd)).slice(0,20);
    const extra = parseNums(body.slice(extraPos+5)).slice(0,15);
    if (base.length >= 15) {
      const dateKey = dateToKey(h.date);
      const uid = `${dateKey}_${String(h.id).padStart(4,'0')}`;
      results.push({ id: h.id, date: h.date, dateKey, uid, time: h.time, base, extra });
    }
  }
  return results.sort((a,b) => b.uid.localeCompare(a.uid));
}

// ─── TABELLA PREMI ───────────────────────────────────────────
const PRIZES = {
  1:  {1:[3,4]},
  2:  {2:[14,16],1:[0,1]},
  3:  {3:[45,100],2:[2,4]},
  4:  {4:[90,225],3:[10,25],2:[1,2]},
  5:  {5:[140,300],4:[15,30],3:[4,10],2:[1,2]},
  6:  {6:[1000,2000],5:[100,200],4:[10,20],3:[2,7],2:[0,1]},
  7:  {7:[1600,5000],6:[400,750],5:[40,75],4:[4,15],3:[0,5],0:[1,0]},
  8:  {8:[10000,20000],7:[800,2000],6:[200,450],5:[20,45],4:[0,10],3:[0,3],0:[1,0]},
  9:  {9:[100000,250000],8:[4000,5000],7:[400,500],6:[40,75],5:[10,20],4:[0,10],0:[2,1]},
  10: {10:[1000000,2000000],9:[20000,40000],8:[1000,2000],7:[150,250],6:[15,35],5:[5,20],4:[0,6],0:[2,1]},
};

function getPrize(played, hB, hE) {
  const row = PRIZES[played];
  if (!row) return {base:0,extra:0};
  return { base: row[hB]?row[hB][0]:0, extra: row[hE]?row[hE][1]:0 };
}

// ─── ALGORITMO PREVISIONE ────────────────────────────────────
function computePrediction(draws, opts = {}) {
  const {
    lookBack  = 10,
    played    = 5,
    poolSize  = 15,
    useExtra  = true,
  } = opts;

  const sl = draws.slice(0, Math.min(lookBack, draws.length));
  if (sl.length < 3) return null;

  // Frequenze
  const freq = {};
  for (let i=1;i<=90;i++) freq[i]=0;
  sl.forEach(d => {
    d.base.forEach(n => freq[n] += useExtra ? 2 : 1);
    if (useExtra) d.extra.forEach(n => freq[n] += 1);
  });

  // Ritardo (penalità)
  const scores = {};
  for (let i=1;i<=90;i++) {
    let delay = 0;
    for (let j=0;j<sl.length;j++) {
      if (sl[j].base.includes(i) || (useExtra && sl[j].extra.includes(i))) break;
      delay++;
    }
    const penalty = Math.max(0, delay-3);
    scores[i] = freq[i] * Math.pow(0.85, penalty);
  }

  const pool = Object.entries(scores)
    .sort((a,b)=>b[1]-a[1]).slice(0,poolSize).map(([n])=>parseInt(n));

  // Ottimizzatore C(poolSize, played)
  let bestCombo=null, bestScore=0;
  function bt(s, cur) {
    if (cur.length===played) {
      let score=0;
      sl.forEach(d => {
        const hB=cur.filter(n=>d.base.includes(n)).length;
        const hE=cur.filter(n=>d.extra.includes(n)).length;
        const p=getPrize(played,hB,hE);
        score+=Math.max(p.base,p.extra);
      });
      if(score>bestScore){bestScore=score;bestCombo=[...cur];}
      return;
    }
    for(let i=s;i<=pool.length-(played-cur.length);i++){
      cur.push(pool[i]);bt(i+1,cur);cur.pop();
    }
  }
  bt(0,[]);

  return {
    combo:    bestCombo || pool.slice(0,played),
    score:    bestScore,
    pool:     pool.slice(0,poolSize),
    lookBack: sl.length,
    ts:       new Date().toISOString(),
  };
}

// ─── CLUSTER DETECTION ───────────────────────────────────────
function detectCluster(draws, {poolSize=15, thresh=5, calibN=100, testN=50}={}) {
  const calibSlice = draws.slice(testN, testN+calibN);
  const testSlice  = draws.slice(0, testN);
  if (calibSlice.length < 30) return null;

  const freq = {};
  for(let i=1;i<=90;i++) freq[i]=0;
  calibSlice.forEach(d=>{
    d.base.forEach(n=>freq[n]+=2);
    d.extra.forEach(n=>freq[n]+=1);
  });
  const pool = new Set(
    Object.entries(freq).sort((a,b)=>b[1]-a[1]).slice(0,poolSize).map(([n])=>parseInt(n))
  );

  const testChron = [...testSlice].reverse();
  const scored = testChron.map((d,idx)=>({
    draw:d, idx,
    hBase:  d.base.filter(n=>pool.has(n)),
    hExtra: d.extra.filter(n=>pool.has(n)),
    score:  d.base.filter(n=>pool.has(n)).length,
  }));

  const clusters = scored.filter(s=>s.score>=thresh);
  const gaps = [];
  for(let i=1;i<clusters.length;i++)
    gaps.push(clusters[i].idx - clusters[i-1].idx);
  const avgGap = gaps.length ? gaps.reduce((a,b)=>a+b,0)/gaps.length : null;
  const lastCluster = clusters.length ? clusters[clusters.length-1] : null;
  const estFromLast = lastCluster!=null ? (scored.length-1-lastCluster.idx) : null;
  const nextEst = (avgGap!=null&&estFromLast!=null) ? Math.round(avgGap-estFromLast) : null;

  // Numeri top nei cluster
  const clFreq = {};
  for(let i=1;i<=90;i++) clFreq[i]=0;
  clusters.forEach(c=>{
    c.hBase.forEach(n=>clFreq[n]+=2);
    c.hExtra.forEach(n=>clFreq[n]+=1);
  });
  const clTop = Object.entries(clFreq).filter(([,v])=>v>0)
    .sort((a,b)=>b[1]-a[1]).slice(0,10).map(([n])=>parseInt(n));

  return {
    clusterCount: clusters.length,
    avgGap:       avgGap ? Math.round(avgGap*10)/10 : null,
    estFromLast,
    nextEst,
    status: nextEst==null?'unknown': nextEst<=0?'active': nextEst<=3?'imminent':'waiting',
    clusterNums: clTop,
    lastCluster:  lastCluster ? {
      id: lastCluster.draw.id,
      time: lastCluster.draw.time,
      score: lastCluster.score,
      nums: lastCluster.hBase,
    } : null,
  };
}

// ─── PATTERN ANALYSIS ────────────────────────────────────────
function analyzePatterns(draws, predictions) {
  if (!predictions || predictions.length < 5) return { message: 'Dati insufficienti' };

  const validated = predictions.filter(p=>p.result);
  if (validated.length < 3) return { message: 'Servono almeno 3 previsioni validate' };

  // Win rate per lookBack
  const byWindow = {};
  validated.forEach(p => {
    const w = p.opts?.lookBack || 10;
    if (!byWindow[w]) byWindow[w]={count:0,win:0,totalWin:0};
    byWindow[w].count++;
    if(p.result.win>0){byWindow[w].win++;byWindow[w].totalWin+=p.result.win;}
  });

  // Sequenze perdita
  let maxLoss=0,curLoss=0;
  [...validated].reverse().forEach(p=>{
    if(!p.result.win){curLoss++;maxLoss=Math.max(maxLoss,curLoss);}
    else curLoss=0;
  });

  // Ore migliori
  const byHour = {};
  validated.forEach(p=>{
    if(!p.result) return;
    const h = p.draw?.time ? parseInt(p.draw.time.split(':')[0]) : -1;
    if(h>=0){
      if(!byHour[h]) byHour[h]={count:0,win:0};
      byHour[h].count++;
      if(p.result.win>0) byHour[h].win++;
    }
  });
  const bestHour = Object.entries(byHour)
    .sort((a,b)=>(b[1].win/b[1].count)-(a[1].win/a[1].count))[0];

  // Numeri che quando sono in combo vincono di più
  const numWins = {};
  validated.filter(p=>p.result?.win>0).forEach(p=>{
    p.combo?.forEach(n=>{
      numWins[n]=(numWins[n]||0)+p.result.win;
    });
  });
  const bestNums = Object.entries(numWins).sort((a,b)=>b[1]-a[1]).slice(0,8).map(([n])=>parseInt(n));

  return {
    totalPredictions: validated.length,
    winRate: Math.round(validated.filter(p=>p.result?.win>0).length/validated.length*100),
    totalWon: validated.reduce((s,p)=>s+(p.result?.win||0),0),
    maxLossStreak: maxLoss,
    bestWindow: Object.entries(byWindow).sort((a,b)=>(b[1].win/b[1].count)-(a[1].win/a[1].count))[0]?.[0],
    byWindow,
    bestHour: bestHour?.[0],
    byHour,
    bestNums,
    patterns: [
      maxLoss>5 ? `⚠️ Sequenza di ${maxLoss} perdite consecutive — considera di cambiare finestra` : null,
      bestHour ? `📅 Ora migliore: ${bestHour[0]}:xx (win rate ${Math.round(bestHour[1].win/bestHour[1].count*100)}%)` : null,
      bestNums.length>0 ? `🔢 Numeri più redditizi in combo: ${bestNums.join(', ')}` : null,
    ].filter(Boolean),
  };
}

// ─── CRON HANDLER ────────────────────────────────────────────
async function handleCron(kv) {
  const log = [];

  // 1. Carica estrazioni storiche dal KV
  let draws = [];
  try {
    const raw = await kv.get('draws', {type:'json'});
    draws = raw || [];
    log.push(`KV: ${draws.length} estrazioni caricate`);
  } catch(e) { log.push('KV draws vuoto: ' + e.message); }

  // 2. Carica previsioni storiche
  let predictions = [];
  try {
    predictions = (await kv.get('predictions', {type:'json'})) || [];
  } catch(e) {}

  // 3. Calcola previsione PRIMA di scaricare la nuova estrazione
  const lastKnownId  = draws.length ? draws[0].id : 0;
  const lastKnownKey = draws.length ? draws[0].dateKey : null;

  const prediction = computePrediction(draws, {lookBack:10, played:5, poolSize:15});
  const cluster    = detectCluster(draws);
  log.push(`Previsione calcolata: [${prediction?.combo?.join(',')}]`);
  log.push(`Cluster: ${cluster?.status} (nextEst: ${cluster?.nextEst})`);

  // 4. Scarica nuova estrazione dal sito
  let newDraws = [];
  try {
    const resp = await fetch(TARGET_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html',
        'Referer': 'https://www.google.com/',
      }
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const html = await resp.text();
    newDraws = parseHtml(html);
    log.push(`Sito: ${newDraws.length} estrazioni parsate`);
  } catch(e) {
    log.push('Errore fetch sito: ' + e.message);
  }

  // 5. Merge draws (dedup per uid)
  if (newDraws.length > 0) {
    const existingUids = new Set(draws.map(d=>d.uid));
    const added = newDraws.filter(d=>!existingUids.has(d.uid));
    draws = [...added, ...draws].sort((a,b)=>b.uid.localeCompare(a.uid));
    // Mantieni max 2000 estrazioni in KV
    if (draws.length > 2000) draws = draws.slice(0, 2000);
    await kv.put('draws', JSON.stringify(draws));
    log.push(`Aggiunte ${added.length} nuove estrazioni. Totale: ${draws.length}`);
  }

  // 6. Valida previsione precedente contro le nuove estrazioni
  const lastPred = predictions[0];
  if (lastPred && !lastPred.result && lastPred.targetExtId) {
    const draw = draws.find(d =>
      d.id === lastPred.targetExtId &&
      d.dateKey === lastPred.targetDateKey
    );
    if (draw) {
      const hBase  = lastPred.combo.filter(n=>draw.base.includes(n));
      const hExtra = lastPred.combo.filter(n=>draw.extra.includes(n));
      const p = getPrize(lastPred.combo.length, hBase.length, hExtra.length);
      lastPred.result = {
        draw: { id:draw.id, time:draw.time, base:draw.base, extra:draw.extra },
        hBase, hExtra,
        prizeBase:  p.base,
        prizeExtra: p.extra,
        win:        Math.max(p.base, p.extra),
      };
      log.push(`Previsione validata: win=${lastPred.result.win}€ hBase=[${hBase}] hExtra=[${hExtra}]`);
    }
  }

  // 7. Salva nuova previsione
  if (prediction && draws.length > 0) {
    const latest = draws[0];
    const newPred = {
      id:            Date.now(),
      ts:            new Date().toISOString(),
      combo:         prediction.combo,
      pool:          prediction.pool,
      cluster:       cluster,
      targetExtId:   latest.id + 1,
      targetDateKey: latest.dateKey,
      result:        null,
      opts:          {lookBack:10, played:5, poolSize:15},
    };
    predictions = [newPred, ...predictions].slice(0, 500);
    await kv.put('predictions', JSON.stringify(predictions));
    log.push(`Nuova previsione salvata per est. #${newPred.targetExtId}`);
  }

  // 8. Pattern analysis
  const patterns = analyzePatterns(draws, predictions);
  await kv.put('patterns', JSON.stringify({...patterns, ts: new Date().toISOString()}));

  // 9. Status corrente
  const status = {
    ts:          new Date().toISOString(),
    drawCount:   draws.length,
    lastDraw:    draws[0] || null,
    prediction:  predictions[0] || null,
    cluster,
    patterns,
    log,
  };
  await kv.put('status', JSON.stringify(status));
  log.push('Status salvato');

  return { ok: true, log };
}

// ─── MAIN HANDLER ────────────────────────────────────────────
export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url    = new URL(request.url);
    const action = url.searchParams.get('action') || 'status';
    const secret = url.searchParams.get('secret');
    const kv     = env.LOTTO_KV;

    // CRON — chiamato da GitHub Actions
    if (action === 'cron') {
      if (secret !== CRON_SECRET) {
        return new Response(JSON.stringify({error:'Unauthorized'}), {status:401, headers:CORS_HEADERS});
      }
      const result = await handleCron(kv);
      return new Response(JSON.stringify(result), { headers: CORS_HEADERS });
    }

    // STATUS — pagina HTML
    if (action === 'status') {
      const data = await kv.get('status', {type:'json'}) || {error:'Nessun dato ancora. Attendi il primo cron.'};
      return new Response(JSON.stringify(data), { headers: CORS_HEADERS });
    }

    // HISTORY
    if (action === 'history') {
      const n = parseInt(url.searchParams.get('n') || '50');
      const draws = (await kv.get('draws', {type:'json'})) || [];
      return new Response(JSON.stringify(draws.slice(0,n)), { headers: CORS_HEADERS });
    }

    // PREDICTIONS
    if (action === 'predictions') {
      const n = parseInt(url.searchParams.get('n') || '50');
      const preds = (await kv.get('predictions', {type:'json'})) || [];
      return new Response(JSON.stringify(preds.slice(0,n)), { headers: CORS_HEADERS });
    }

    // PATTERNS
    if (action === 'patterns') {
      const data = await kv.get('patterns', {type:'json'}) || {};
      return new Response(JSON.stringify(data), { headers: CORS_HEADERS });
    }

    // GIOCATA REALE
    if (action === 'giocata' && request.method === 'POST') {
      if (secret !== CRON_SECRET) {
        return new Response(JSON.stringify({error:'Unauthorized'}), {status:401, headers:CORS_HEADERS});
      }
      const body = await request.json();
      let giocate = (await kv.get('giocate', {type:'json'})) || [];
      giocate = [{ ...body, id: Date.now(), ts: new Date().toISOString() }, ...giocate].slice(0, 1000);
      await kv.put('giocate', JSON.stringify(giocate));
      return new Response(JSON.stringify({ok:true}), { headers: CORS_HEADERS });
    }

    // GIOCATE REALI — lettura
    if (action === 'giocate') {
      const data = (await kv.get('giocate', {type:'json'})) || [];
      return new Response(JSON.stringify(data), { headers: CORS_HEADERS });
    }

    return new Response(JSON.stringify({error:'Action non valida'}), {status:400, headers:CORS_HEADERS});
  },
};
