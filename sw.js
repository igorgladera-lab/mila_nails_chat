// =========================================================
// Service Worker do Mila Whats
// Recebe notificações push e mostra o banner no celular
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
    tag: "mila-whats-msg",
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

  const urlAbrir = (event.notification.data && event.notification.data.url) || "./";

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(clientsArr => {
      for(const c of clientsArr){
        if(c.url.includes("mila_nails_chat") && "focus" in c){
          return c.focus();
        }
      }
      if(self.clients.openWindow){
        return self.clients.openWindow(urlAbrir);
      }
    })
  );
});