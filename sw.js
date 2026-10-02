// =========================================================
// Service Worker do Mila Whats
// Recebe notificações push e mostra o banner no celular
// v1.7.2 — deep-link para a conversa ao tocar na notificação
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
    telefone: ""
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
      url: "./"
    }
  };

  event.waitUntil(
    self.registration.showNotification(data.title || "Mila Whats", options)
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const tel = (event.notification.data && event.notification.data.telefone) || "";
  const cliente = (event.notification.data && event.notification.data.cliente) || "";

  // URL com deep-link: ?tel=...&cliente=...
  const params = new URLSearchParams();
  if(tel) params.set("tel", tel);
  if(cliente) params.set("cliente", cliente);
  const urlAbrir = "./" + (params.toString() ? "?" + params.toString() : "");

  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then(clientsArr => {
        // Se já tem uma aba do Mila Whats aberta, foca e manda mensagem
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
        // Senão, abre uma nova com o deep-link
        if(self.clients.openWindow){
          return self.clients.openWindow(urlAbrir);
        }
      })
  );
});