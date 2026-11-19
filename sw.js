// 오프라인 지원: 모든 파일을 처음 열 때 캐시에 저장하고, 이후엔 캐시에서 바로 불러온다.
// 앱 파일을 수정해서 다시 올릴 때는 아래 VERSION 숫자를 올려야 폰에 새 버전이 반영된다.
const VERSION = 'running-card-v2';
const FILES = [
  './', './index.html', './app.js', './manifest.webmanifest',
  './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png', './icons/apple-touch-icon.png',
  './vendor/tesseract.min.js', './vendor/worker.min.js',
  './vendor/core/tesseract-core-lstm.wasm.js', './vendor/core/tesseract-core-simd-lstm.wasm.js',
  './vendor/lang/eng.traineddata.gz'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then(hit => hit || fetch(e.request))
  );
});
