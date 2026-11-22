// Roda dentro da janela escondida do YouTube (player do bot de música).
// Não expõe nada pra página: só lê o estado do <video> e obedece play/pause/volume que o app manda.
const { ipcRenderer } = require('electron');

let lastEnded = false;
let lastErr = '';

function video() {
  return document.querySelector('#movie_player video') || document.querySelector('video');
}

function report() {
  const v = video();
  const player = document.querySelector('#movie_player');
  const ad = !!(player && (player.classList.contains('ad-showing') || player.classList.contains('ad-interrupting')));
  const errEl = document.querySelector('.ytp-error, .ytp-error-content-wrap-reason');
  const err = errEl && errEl.offsetParent !== null ? (errEl.textContent || 'erro').trim().slice(0, 120) : '';
  // pula anúncio quando aparece o botão
  if (ad) {
    const skip = document.querySelector('.ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern');
    if (skip) skip.click();
  }
  const ended = !!(v && v.ended && !ad);
  const s = {
    t: v ? v.currentTime : 0,
    d: v && isFinite(v.duration) ? v.duration : 0,
    paused: v ? v.paused : true,
    ad,
    ended: ended && !lastEnded,
    error: err && err !== lastErr ? err : '',
    url: location.href,
  };
  lastEnded = ended;
  if (err) lastErr = err;
  ipcRenderer.send('botwin:state', s);
}
setInterval(report, 500);

ipcRenderer.on('botwin:ctl', (_e, c) => {
  const v = video();
  if (!v) return;
  if (c.type === 'pause') v.pause();
  if (c.type === 'resume') v.play().catch(() => {});
  if (c.type === 'seek') v.currentTime = Math.max(0, c.t || 0);
  if (c.type === 'reset') {
    lastEnded = false;
    lastErr = '';
  }
});
