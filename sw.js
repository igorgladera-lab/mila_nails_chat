// =========================================================
// Service Worker do Mila Whats
// v1.8.5 — heartbeat silencioso + cache de mídia
//
// Responsabilidades:
//   1. Receber notificações push e mostrar o banner
//   2. Responder a heartbeat silencioso (POST /push/ack)
//   3. Deep-link ao tocar na notificação
//   4. Cache de mídia (imagens e áudios) do Supabase Storage
//   5. Limpeza automática (40 MB / 24h / FIFO)
// =========================================================

const VERSAO_SW = "1.8.5";
const CACHE_MIDIA = "mila-media-" + VERSAO_SW;
const CACHE_PWA = "mila-pwa-" + VERSAO_SW;

const LIMITE_BYTES = 40 * 1024 * 1024; // 40 MB
const EXPIRACAO_MS = 24 * 60 * 60 * 1000; // 24h
const MAX_ITENS = 500;

/* =========================================================
   INSTALL / ACTIVATE
   ========================================================= */
self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.map(k => {
          if(k !== CACHE_MIDIA && k !== CACHE_PWA){
            console.log("[sw] removendo cache antigo:", k);
            return caches.delete(k);
          }
        })
      );

      await self.clients.claim();
      limparCacheMidia().catch(() => {});
    })()
  );
});

/* =========================================================
   FETCH — intercepta requisições
   ========================================================= */
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if(req.method !== "GET") return;

  let url;
  try{
    url = new URL(req.url);
  }catch(e){
    return;
  }

  if(ehMidiaStorage(url)){
    event.respondWith(cacheFirstMidia(req));
    return;
  }

  if(ehEndpointMediaUrl(url)){
    event.respondWith(networkFirstMediaUrl(req));
    return;
  }

  if(ehAssetPWA(url)){
    event.respondWith(staleWhileRevalidate(req));
    return;
  }
});

/* =========================================================
   DETECÇÃO DE TIPO
   ========================================================= */
function ehMidiaStorage(url){
  return (
    url.hostname.endsWith(".supabase.co") &&
    url.pathname.includes("/storage/")
  );
}

function ehEndpointMediaUrl(url){
  return url.pathname.endsWith("/media-url");
}

function ehAssetPWA(url){
  if(url.origin !== self.location.origin) return false;
  const ext = url.pathname.split(".").pop().toLowerCase();
  return ["html","css","js","png","jpg","jpeg","svg","ico","webp","json"].includes(ext);
}

/* =========================================================
   ESTRATÉGIAS
   ========================================================= */
async function cacheFirstMidia(request){
  const urlNormalizada = new URL(request.url);
  urlNormalizada.search = "";
  const chave = new Request(urlNormalizada.toString(), { method: "GET" });

  const cache = await caches.open(CACHE_MIDIA);
  const cached = await cache.match(chave);

  if(cached){
    atualizarTimestampUso(chave.url).catch(() => {});
    return cached;
  }

  try{
    const resp = await fetch(request);
    if(resp.ok || resp.type === "opaque"){
      cache.put(chave, resp.clone()).catch(() => {});
      salvarTimestamp(chave.url).catch(() => {});
    }
    return resp;
  }catch(err){
    return new Response("Mídia indisponível offline", {
      status: 504,
      headers: { "Content-Type": "text/plain; charset=utf-8" }
    });
  }
}

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
   TIMESTAMPS DE USO (FIFO)
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
   LIMPEZA DO CACHE
   ========================================================= */
async function limparCacheMidia(){
  try{
    const cache = await caches.open(CACHE_MIDIA);
    const keys = await cache.keys();

    const midias = [];
    const timestamps = new Map();

    for(const req of keys){
      const u = req.url;
      if(u.startsWith(self.location.origin + "/ts::") || u.includes("/ts::")){
        const originalUrl = u.split("ts::")[1];
        if(originalUrl){
          const ts = await obterTimestamp(originalUrl);
          timestamps.set(originalUrl, ts);
        }
      } else {
        midias.push(req);
      }
    }

    const agora = Date.now();
    let removidosExpirados = 0;
    let removidosFIFO = 0;
    let totalBytes = 0;

    const sobreviventes = [];
    for(const req of midias){
      const ts = timestamps.get(req.url) || 0;
      const idade = ts > 0 ? (agora - ts) : Infinity;

      if(idade > EXPIRACAO_MS){
        await cache.delete(req).catch(() => {});
        await cache.delete(new Request("ts::" + req.url)).catch(() => {});
        removidosExpirados++;
      } else {
        sobreviventes.push({ req, ts: ts || 0 });
      }
    }

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

    if(totalBytes > LIMITE_BYTES || sobreviventes.length > MAX_ITENS){
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
   PUSH — recebe notificações (v1.8.5 com heartbeat)
   ========================================================= */
self.addEventListener("push", (event) => {
  let data = {};

  try{
    if(event.data){
      data = event.data.json();
    }
  }catch(e){
    try{
      if(event.data){
        data = { body: event.data.text() };
      }
    }catch(e2){}
  }

  /* ===== HEARTBEAT (push silencioso) ===== */
  if(data.type === "heartbeat"){
    // Não mostra notificação. Apenas confirma pro backend.
    event.waitUntil(
      (async () => {
        try{
          const backendUrl = data.backendUrl || "";
          const apiKey = data.apiKey || "";
          const endpoint = self.registration.scope || "";

          if(!backendUrl){
            console.warn("[sw] heartbeat sem backendUrl");
            return;
          }

          const url = backendUrl.replace(/\/+$/, "") + "/push/ack";
          const resp = await fetch(url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-api-key": apiKey
            },
            body: JSON.stringify({
              endpoint: endpoint,
              ts: data.ts || Date.now()
            })
          });

          if(resp.ok){
            console.log("[sw] heartbeat ack enviado");
          } else {
            console.warn("[sw] falha ao enviar ack:", resp.status);
          }
        }catch(err){
          console.warn("[sw] erro no heartbeat ack:", err && err.message);
        }
      })()
    );
    return;
  }

  /* ===== PUSH NORMAL (notificação visível) ===== */
  const payload = {
    title: data.title || "Mila Whats",
    body: data.body || "Nova mensagem recebida",
    cliente: data.cliente || "",
    telefone: data.telefone || "",
    tipo: data.tipo || "text"
  };

  const options = {
    body: payload.body,
    icon: "icon-192.png",
    badge: "icon-192.png",
    tag: "mila-whats-msg-" + (payload.telefone || "geral"),
    renotify: true,
    data: {
      cliente: payload.cliente,
      telefone: payload.telefone,
      tipo: payload.tipo,
      url: "./"
    }
  };

  event.waitUntil(
    self.registration.showNotification(payload.title, options)
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
   NOTIFICATIONCLOSE
   ========================================================= */
self.addEventListener("notificationclose", (event) => {
  console.log("[sw] notificação fechada sem clique");
});

/* =========================================================
   MENSAGENS DO CLIENTE
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