// =========================================================
// Service Worker do Mila Whats
// v1.8.3 — cache de mídia com limpeza automática
//
// Responsabilidades:
//   1. Receber notificações push e mostrar o banner
//   2. Deep-link ao tocar na notificação
//   3. Cache de mídia (imagens e áudios) do Supabase Storage
//   4. Limpeza automática (40 MB / 24h / FIFO)
// =========================================================

const VERSAO_SW = "1.8.3";
const CACHE_MIDIA = "mila-media-" + VERSAO_SW;
const CACHE_PWA = "mila-pwa-" + VERSAO_SW;

const LIMITE_BYTES = 40 * 1024 * 1024; // 40 MB
const EXPIRACAO_MS = 24 * 60 * 60 * 1000; // 24h
const MAX_ITENS = 500; // trava de segurança

/* =========================================================
   INSTALL / ACTIVATE
   ========================================================= */
self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Remove caches de versões antigas
      const keys = await caches.keys();
      await Promise.all(
        keys.map(k => {
          if(k !== CACHE_MIDIA && k !== CACHE_PWA){
            console.log("[sw] removendo cache antigo:", k);
            return caches.delete(k);
          }
        })
      );

      // Assume controle imediato
      await self.clients.claim();

      // Limpeza em background
      limparCacheMidia().catch(() => {});
    })()
  );
});

/* =========================================================
   FETCH — intercepta requisições
   ========================================================= */
self.addEventListener("fetch", (event) => {
  const req = event.request;

  // Só GET
  if(req.method !== "GET") return;

  let url;
  try{
    url = new URL(req.url);
  }catch(e){
    return;
  }

  // 1) Mídia do Supabase Storage → cache-first
  if(ehMidiaStorage(url)){
    event.respondWith(cacheFirstMidia(req));
    return;
  }

  // 2) Endpoint /media-url (backend do Render) → network-first
  if(ehEndpointMediaUrl(url)){
    event.respondWith(networkFirstMediaUrl(req));
    return;
  }

  // 3) Assets do PWA (HTML, CSS, JS) → stale-while-revalidate
  if(ehAssetPWA(url)){
    event.respondWith(staleWhileRevalidate(req));
    return;
  }
});

/* =========================================================
   DETECÇÃO DE TIPO DE REQUISIÇÃO
   ========================================================= */
function ehMidiaStorage(url){
  // Supabase Storage — URL assinada (signed) ou pública
  return (
    url.hostname.endsWith(".supabase.co") &&
    url.pathname.includes("/storage/")
  );
}

function ehEndpointMediaUrl(url){
  // Endpoint do backend que gera URL assinada
  return url.pathname.endsWith("/media-url");
}

function ehAssetPWA(url){
  // Mesma origem do PWA
  if(url.origin !== self.location.origin) return false;
  // Apenas GET de assets
  const ext = url.pathname.split(".").pop().toLowerCase();
  return ["html","css","js","png","jpg","jpeg","svg","ico","webp","json"].includes(ext);
}

/* =========================================================
   ESTRATÉGIA: cache-first para mídia do Storage
   ========================================================= */
async function cacheFirstMidia(request){
  const urlOriginal = new URL(request.url);

  // Normaliza URL removendo o token — chave estável para o cache
  const urlNormalizada = new URL(request.url);
  urlNormalizada.search = "";
  const chave = new Request(urlNormalizada.toString(), { method: "GET" });

  const cache = await caches.open(CACHE_MIDIA);
  const cached = await cache.match(chave);

  if(cached){
    // Renova timestamp de uso (para limpeza FIFO)
    atualizarTimestampUso(chave.url).catch(() => {});
    return cached;
  }

  // Não tem no cache — baixa da rede
  try{
    const resp = await fetch(request);
    if(resp.ok || resp.type === "opaque"){
      // Clona antes de guardar (a resposta original será consumida)
      cache.put(chave, resp.clone()).catch(() => {});
      // Salva timestamp para limpeza FIFO
      salvarTimestamp(chave.url).catch(() => {});
    }
    return resp;
  }catch(err){
    // Se falhou a rede e não tem cache, retorna erro 504
    return new Response("Mídia indisponível offline", {
      status: 504,
      headers: { "Content-Type": "text/plain; charset=utf-8" }
    });
  }
}

/* =========================================================
   ESTRATÉGIA: network-first para /media-url
   (o token muda sempre — não cacheia a resposta)
   ========================================================= */
async function networkFirstMediaUrl(request){
  try{
    return await fetch(request);
  }catch(err){
    return new Response(JSON.stringify({ ok: false, error: "offline" }), {
      status: 503,
      headers: { "Content-Type": "application/json" }
    });
  }
}

/* =========================================================
   ESTRATÉGIA: stale-while-revalidate para assets do PWA
   ========================================================= */
async function staleWhileRevalidate(request){
  const cache = await caches.open(CACHE_PWA);
  const cached = await cache.match(request);

  const fetchPromise = fetch(request)
    .then((resp) => {
      if(resp.ok){
        cache.put(request, resp.clone()).catch(() => {});
      }
      return resp;
    })
    .catch(() => cached);

  return cached || fetchPromise;
}

/* =========================================================
   TIMESTAMPS DE USO (para limpeza FIFO)
   Chave: "mila_ts::<url>" no Cache Storage também
   ========================================================= */
async function salvarTimestamp(url){
  try{
    const cache = await caches.open(CACHE_MIDIA);
    const req = new Request("ts::" + url);
    const resp = new Response(String(Date.now()), {
      headers: { "Content-Type": "text/plain" }
    });
    await cache.put(req, resp);
  }catch(e){}
}

async function atualizarTimestampUso(url){
  // Atualiza o timestamp para "agora" toda vez que a mídia é usada
  await salvarTimestamp(url);
}

async function obterTimestamp(url){
  try{
    const cache = await caches.open(CACHE_MIDIA);
    const req = new Request("ts::" + url);
    const resp = await cache.match(req);
    if(!resp) return 0;
    const txt = await resp.text();
    return parseInt(txt, 10) || 0;
  }catch(e){
    return 0;
  }
}

/* =========================================================
   LIMPEZA DO CACHE DE MÍDIA
   Regras:
     1. Remove entradas com mais de 24h sem uso
     2. Se ainda passar de 40 MB → remove as mais antigas (FIFO)
     3. Trava de segurança: máximo 500 itens
   ========================================================= */
async function limparCacheMidia(){
  try{
    const cache = await caches.open(CACHE_MIDIA);
    const keys = await cache.keys();

    // Separa mídias e timestamps
    const midias = [];
    const timestamps = new Map();

    for(const req of keys){
      const u = req.url;
      if(u.startsWith(self.location.origin + "/ts::") || u.includes("/ts::")){
        // É um timestamp
        const originalUrl = u.split("ts::")[1];
        if(originalUrl){
          const ts = await obterTimestamp(originalUrl);
          timestamps.set(originalUrl, ts);
        }
      } else {
        // É uma mídia de verdade
        midias.push(req);
      }
    }

    const agora = Date.now();
    let removidosExpirados = 0;
    let removidosFIFO = 0;
    let totalBytes = 0;

    // 1) Remover expirados (> 24h sem uso)
    const sobreviventes = [];
    for(const req of midias){
      const ts = timestamps.get(req.url) || 0;
      const idade = ts > 0 ? (agora - ts) : Infinity;

      if(idade > EXPIRACAO_MS){
        await cache.delete(req).catch(() => {});
        // Remove também o timestamp
        await cache.delete(new Request("ts::" + req.url)).catch(() => {});
        removidosExpirados++;
      } else {
        sobreviventes.push({ req, ts: ts || 0 });
      }
    }

    // 2) Calcular tamanho total dos sobreviventes
    for(const item of sobreviventes){
      try{
        const resp = await cache.match(item.req);
        if(resp){
          const blob = await resp.clone().blob();
          item.size = blob.size || 0;
        } else {
          item.size = 0;
        }
      }catch(e){
        item.size = 0;
      }
      totalBytes += item.size;
    }

    // 3) Se ainda passa do limite OU trava de segurança → remove FIFO
    if(totalBytes > LIMITE_BYTES || sobreviventes.length > MAX_ITENS){
      // Ordena por timestamp crescente (mais antigas primeiro)
      sobreviventes.sort((a, b) => a.ts - b.ts);

      for(const item of sobreviventes){
        if(totalBytes <= LIMITE_BYTES * 0.8 && sobreviventes.length <= MAX_ITENS){
          break;
        }
        await cache.delete(item.req).catch(() => {});
        await cache.delete(new Request("ts::" + item.req.url)).catch(() => {});
        totalBytes -= item.size;
        removidosFIFO++;
      }
    }

    console.log(
      "[sw] limpeza:",
      removidosExpirados, "expirados,",
      removidosFIFO, "FIFO,",
      "total:", Math.round(totalBytes / 1024), "KB",
      "em", sobreviventes.length, "itens"
    );
  }catch(err){
    console.warn("[sw] erro na limpeza:", err && err.message);
  }
}

/* =========================================================
   PUSH — recebe notificações
   ========================================================= */
self.addEventListener("push", (event) => {
  let data = {
    title: "Mila Whats",
    body: "Nova mensagem recebida",
    cliente: "",
    telefone: "",
    tipo: "text"
  };

  try{
    if(event.data){
      data = Object.assign(data, event.data.json());
    }
  }catch(e){
    try{
      if(event.data){
        data.body = event.data.text();
      }
    }catch(e2){}
  }

  const options = {
    body: data.body,
    icon: "icon-192.png",
    badge: "icon-192.png",
    tag: "mila-whats-msg-" + (data.telefone || "geral"),
    renotify: true,
    data: {
      cliente: data.cliente || "",
      telefone: data.telefone || "",
      tipo: data.tipo || "text",
      url: "./"
    }
  };

  event.waitUntil(
    self.registration.showNotification(data.title || "Mila Whats", options)
  );
});

/* =========================================================
   CLIQUE NA NOTIFICAÇÃO — deep-link
   ========================================================= */
self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const tel = (event.notification.data && event.notification.data.telefone) || "";
  const cliente = (event.notification.data && event.notification.data.cliente) || "";

  const params = new URLSearchParams();
  if(tel) params.set("tel", tel);
  if(cliente) params.set("cliente", cliente);
  const urlAbrir = "./" + (params.toString() ? "?" + params.toString() : "");

  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then(clientsArr => {
        for(const c of clientsArr){
          if(c.url.includes("mila_nails_chat")){
            c.postMessage({
              type: "abrirConversa",
              telefone: tel,
              cliente: cliente
            });
            if("focus" in c) return c.focus();
            return;
          }
        }
        if(self.clients.openWindow){
          return self.clients.openWindow(urlAbrir);
        }
      })
  );
});

/* =========================================================
   FECHAMENTO DE NOTIFICAÇÃO (informativo)
   ========================================================= */
self.addEventListener("notificationclose", (event) => {
  console.log("[sw] notificação fechada sem clique");
});

/* =========================================================
   MENSAGENS DO CLIENTE (do index.html)
   ========================================================= */
self.addEventListener("message", (event) => {
  const data = event.data || {};

  if(data.type === "forcarLimpezaMidia"){
    limparCacheMidia().then(() => {
      if(event.source && event.source.postMessage){
        event.source.postMessage({ type: "limpezaMidiaConcluida" });
      }
    });
    return;
  }

  if(data.type === "estatisticasCacheMidia"){
    (async () => {
      try{
        const cache = await caches.open(CACHE_MIDIA);
        const keys = await cache.keys();
        let totalBytes = 0;
        let itens = 0;
        for(const req of keys){
          if(req.url.includes("/ts::")) continue;
          try{
            const resp = await cache.match(req);
            if(resp){
              const blob = await resp.clone().blob();
              totalBytes += blob.size || 0;
              itens++;
            }
          }catch(e){}
        }
        if(event.source && event.source.postMessage){
          event.source.postMessage({
            type: "estatisticasCacheMidia",
            itens,
            bytes: totalBytes
          });
        }
      }catch(e){}
    })();
    return;
  }
});