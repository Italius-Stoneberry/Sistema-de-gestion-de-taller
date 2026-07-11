// Service worker mínimo: habilita la instalación como app (PWA) sin cachear nada,
// así el frontend siempre viene fresco del servidor (que está en la red local).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
