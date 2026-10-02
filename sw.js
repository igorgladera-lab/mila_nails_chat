// =========================================================
// Service Worker do Mila Whats
// Recebe notificações push e mostra o banner no celular
// v1.8 — suporte a notificações de mídia e deep-link
// =========================================================

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

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

  // Ajusta ícone visual para mídia (usando emoji no título)
  if(data.tipo === "image"){
    // mantém title como veio do backend
  } else if(data.tipo === "audio" || data.tipo === "voice"){
    // idem
  }

  event.waitUntil(
    self.registration.showNotification(data.title || "Mila Whats", options)
  );
});

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

self.addEventListener("notificationclose", (event) => {
  // apenas informativo — o badge continua até abrir o app
  console.log("[sw] notificação fechada sem clique");
});