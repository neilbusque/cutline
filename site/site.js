const mobileMenu = document.querySelector(".mobile-menu");

mobileMenu?.addEventListener("click", (event) => {
  if (event.target instanceof Element && event.target.closest("nav a")) {
    mobileMenu.open = false;
  }
});

mobileMenu?.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && mobileMenu.open) {
    mobileMenu.open = false;
    mobileMenu.querySelector("summary")?.focus();
  }
});

const film = document.querySelector("#intro-film");

document.querySelectorAll("[data-play-film]").forEach((link) => {
  link.addEventListener("click", () => {
    if (!(film instanceof HTMLVideoElement)) return;
    // Playback is requested only by this explicit user action. Native controls
    // and the anchor remain available when scripting or playback is blocked.
    film.play().catch(() => {});
    film.focus({ preventScroll: true });
  });
});
