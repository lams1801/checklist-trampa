// ================================================================
//  SERVICE WORKER — Sistema Trampa
//  Recibe notificaciones push del Worker de Cloudflare
//  y las muestra al usuario aunque la app esté cerrada
// ================================================================

self.addEventListener('push', event => {
  let data = {};
  try { data = event.data.json(); } catch (e) { data = { title: '✦ Señal Trampa', body: event.data ? event.data.text() : '' }; }

  const title   = data.title || '✦ Sistema Trampa';
  const options = {
    body:    data.body  || 'Nueva señal detectada',
    icon:    data.icon  || '/bot-avatar.jpg',
    badge:   '/bot-avatar.jpg',
    tag:     data.id    || 'trampa-signal',
    data:    { symbol: data.symbol, id: data.id },
    vibrate: [200, 100, 200],
    requireInteraction: false,
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      // Si la app ya está abierta, la enfoca
      for (const client of list) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          return client.focus();
        }
      }
      // Si no, la abre
      if (clients.openWindow) return clients.openWindow('/');
    })
  );
});
