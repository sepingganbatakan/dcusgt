/**
 * sw.js - Service Worker untuk Offline-First Shell Daily Checkup
 */

const CACHE_NAME = "sgt-dcu-cache-v1";

const STATIC_ASSETS = [
  "./",
  "./index.html",
  "./style.css",
  "./config.js",
  "./app.js",
  "./offline-storage.js"
];

// External CDN dependencies to cache
const CDN_ASSETS = [
  "https://cdn.tailwindcss.com",
  "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2",
  "https://unpkg.com/lucide@latest",
  "https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Manrope:wght@500;600;700;800&display=swap"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      // Cache local assets
      await cache.addAll(STATIC_ASSETS);
      // Attempt caching CDN assets (graceful if network fails during install)
      for (const url of CDN_ASSETS) {
        try {
          await cache.add(url);
        } catch (e) {
          console.warn("Could not precache CDN asset:", url, e);
        }
      }
    })
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);

  // Jangan tangani selain GET (RPC / Supabase API mutasi di-handle oleh Offline Queue)
  if (request.method !== "GET") {
    return;
  }

  // Jangan cache panggilan Supabase REST/RPC/Auth di Service Worker (sudah diatur oleh offline-storage)
  if (url.hostname.includes("supabase.co")) {
    return;
  }

  // Network-First with Cache Fallback for navigation & app shell
  event.respondWith(
    fetch(request)
      .then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200) {
          const responseClone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(request, responseClone);
          });
        }
        return networkResponse;
      })
      .catch(async () => {
        const cachedResponse = await caches.match(request);
        if (cachedResponse) {
          return cachedResponse;
        }
        // Fallback untuk navigation request ke index.html
        if (request.mode === "navigate") {
          return caches.match("./index.html");
        }
        return new Response("Koneksi offline dan aset belum tercache.", {
          status: 503,
          statusText: "Service Unavailable",
          headers: { "Content-Type": "text/plain" }
        });
      })
  );
});
