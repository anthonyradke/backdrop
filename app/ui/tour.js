// First-run tour: a few short cards, each pointing at one part of the window. It opens once on a fresh
// install (empty library), every step can skip it, and Settings can play it again. Runs on top of
// app.js's render; it only reads the page to find what to point at.

const TOUR_KEY = "backdrop.tourDone";
const TOUR = [
  { title: "Welcome to Backdrop", body: "Live wallpapers for your desktop. Want a quick look around? It takes about 20 seconds." },
  { at: '#page [data-act="pick"][data-folder="0"]', title: "Add wallpapers",
    body: "Drop videos, images, GIFs or HTML pages anywhere in this window, or click Add files. Then pick one and press Set as wallpaper." },
  { at: '.nav-tab[data-tab="workshop"]', title: "Find more in the Workshop",
    body: "Browse Wallpaper Engine's Steam Workshop. Downloads go through Steam and show up in your library." },
  { at: "#live", title: "Pause any time",
    body: "This pauses or resumes every wallpaper. They also pause by themselves, for example when a fullscreen app covers them." },
  { at: '.nav-tab[data-tab="settings"]', title: "Make it yours",
    body: "Rotation, playback and power saving are in Settings, and so is this tour. Closing the window keeps wallpapers running; quit from the {tray} icon." },
];
let tourStep = -1;

// Called once the first state has rendered. Someone who already has a library skips it for good.
function maybeTour() {
  if (localStorage.getItem(TOUR_KEY)) return;
  if (S.state.items.length) localStorage.setItem(TOUR_KEY, "1");
  else startTour();
}

function startTour() {
  if (S.tab !== "library") { S.tab = "library"; render(); }
  $("#tour").classList.add("on");
  tourGo(0);
}

function endTour() {
  tourStep = -1;
  localStorage.setItem(TOUR_KEY, "1");
  $("#tour").classList.remove("on");
}

function tourGo(i) {
  if (i < 0) return;
  if (i >= TOUR.length) return endTour();
  tourStep = i;
  const s = TOUR[i], first = i === 0, last = i === TOUR.length - 1;
  const card = $("#tour .tour-card");
  card.innerHTML = `<h2>${esc(tr(s.title))}</h2><p>${esc(tr(s.body, { tray: trayName() }))}</p>
    <div class="tour-foot">
      <div class="tour-dots">${TOUR.map((_, k) => `<i class="${k === i ? "on" : ""}"></i>`).join("")}</div>
      ${last ? "" : `<button class="link press" data-tour="skip">${tr("Skip")}</button>`}
      ${first || last ? "" : `<button class="btn sm press" data-tour="back">${tr("Back")}</button>`}
      <button class="btn sm pri press" data-tour="next">${tr(first ? "Show me" : last ? "Done" : "Continue")}</button>
    </div>`;
  placeTour();
  if (!matchMedia("(prefers-reduced-motion: reduce)").matches)
    card.animate([{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }], { duration: 220, easing: "cubic-bezier(.23, 1, .32, 1)" });
  card.querySelector('[data-tour="next"]').focus({ preventScroll: true, focusVisible: false });
}

// The spot is a hole in the dim (one huge box-shadow) around the target; the card sits below it, or
// above when there's no room. Steps without a target shrink the hole to nothing and centre the card.
function placeTour() {
  const s = TOUR[tourStep];
  const spot = $("#tour .tour-spot"), card = $("#tour .tour-card");
  const el = s.at && document.querySelector(s.at);
  const r = el?.getBoundingClientRect();
  const cw = card.offsetWidth, ch = card.offsetHeight, edge = 12;
  let left, top;
  if (r?.width) {
    const pad = 6;
    const radius = parseFloat(getComputedStyle(el).borderTopLeftRadius) || 4;
    Object.assign(spot.style, {
      left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px`,
      borderRadius: `${Math.min(radius + pad, (r.height + pad * 2) / 2)}px`,
    });
    spot.classList.remove("none");
    top = r.bottom + pad + 14;
    if (top + ch > innerHeight - edge) top = r.top - pad - 14 - ch;
    left = r.left + r.width / 2 - cw / 2;
  } else {
    Object.assign(spot.style, { left: `${innerWidth / 2}px`, top: `${innerHeight / 2}px`, width: "0px", height: "0px" });
    spot.classList.add("none");
    left = (innerWidth - cw) / 2;
    top = (innerHeight - ch) / 2;
  }
  card.style.left = `${Math.round(Math.min(Math.max(edge, left), innerWidth - cw - edge))}px`;
  card.style.top = `${Math.round(Math.min(Math.max(edge, top), innerHeight - ch - edge))}px`;
}

document.addEventListener("click", (ev) => {
  const b = ev.target.closest("[data-tour]");
  if (!b) return;
  const a = b.dataset.tour;
  if (a === "skip") endTour();
  else tourGo(tourStep + (a === "back" ? -1 : 1));
});

// While the tour is open it owns the keyboard: Esc skips, arrows step through.
document.addEventListener("keydown", (ev) => {
  if (tourStep < 0) return;
  if (ev.key === "Escape") endTour();
  else if (ev.key === "ArrowRight") tourGo(tourStep + 1);
  else if (ev.key === "ArrowLeft") tourGo(tourStep - 1);
  else if (ev.key === "Enter" || ev.key === " " || ev.key === "Tab") return;
  ev.stopImmediatePropagation();
  ev.preventDefault();
}, true);

addEventListener("resize", () => { if (tourStep >= 0) placeTour(); });
